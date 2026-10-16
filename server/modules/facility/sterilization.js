/*
 * 이 파일이 하는 일: [E2. 멸균기 기록] 매일 멸균기(오토클레이브)를 돌릴 때마다 남기는 기록 API 입니다.
 *
 *   - 환자 정보는 절대 적지 않습니다. 적재물은 "기구 파우치 25개" 처럼 물건만 적습니다.
 *     (적재물·메모에 전화번호·"OOO 환자" 같은 내용이 보이면 저장하지 않고 안내)
 *   - 지시계 결과: CI(화학적 지시계), BI(생물학적 지시계, 배양 후 결과가 나오므로 "대기"로 두었다가 나중에 입력), 보위딕(진공 시험)
 *   - 하나라도 "불합격"이면 실패 기록이 되고, 조치(재멸균·장비 점검·사용 보류)를 기록할 때까지 대시보드에 경고가 뜹니다.
 *   - 압력 단위는 kPa(게이지 압력)로 통일합니다. (예: 134℃ 일반 프로그램 ≈ 210 kPa)
 *
 * API (/api/facility/sterilization/...)
 *   GET    /meta                 빠른 입력용 기본값 (멸균기 목록, 멸균기별 다음 회차·마지막 프로그램·값, 미해결 실패, BI 대기)
 *   GET    /logs                 목록 (date=하루 또는 month=YYYY-MM, sterilizerId)
 *   POST   /logs                 기록 추가 (누구나)
 *   PATCH  /logs/:id             수정 (작성자 또는 실장 이상)
 *   DELETE /logs/:id             삭제 (작성자 또는 실장 이상)
 *   POST   /logs/:id/bi          BI 결과 나중에 입력 (누구나, '대기' 상태인 것만)
 *   POST   /logs/:id/resolve     실패 기록에 조치 내용 입력 → 경고 해제 (누구나)
 */
const { all, get, run, where } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, forbidden, badRequest, HttpError } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { hasRole } = require('../../core/auth');
const time = require('../../core/time');
const C = require('./common');

// 프로그램별 흔한 기본값 (처음 쓰는 멸균기일 때만 사용, 이후에는 마지막 기록 값을 따라감)
const PROGRAM_DEFAULTS = {
  일반: { temperature: 134, pressure: 210, durationMin: 15 },
  파우치: { temperature: 134, pressure: 210, durationMin: 18 },
  고속: { temperature: 134, pressure: 210, durationMin: 7 },
  기타: { temperature: 121, pressure: 110, durationMin: 30 },
};

const RESULT_LABEL = { pass: '합격', fail: '불합격', pending: '대기', na: '해당 없음' };

const logSchema = v.object({
  date: v.date({ label: '날짜' }),
  sterilizerId: v.id({ label: '멸균기' }),
  cycleNo: v.int({ min: 1, max: 999, label: '회차' }),
  program: v.enum(C.PROGRAMS, { label: '프로그램' }),
  temperature: v.number({ min: 50, max: 200, optional: true, label: '온도(℃)' }),
  pressure: v.number({ min: 0, max: 500, optional: true, label: '압력(kPa)' }),
  durationMin: v.int({ min: 1, max: 600, optional: true, label: '멸균 시간(분)' }),
  ciResult: v.enum(C.CI_RESULTS, { optional: true, default: 'pass', label: 'CI(화학적 지시계)' }),
  biResult: v.enum(C.BI_RESULTS, { optional: true, default: 'na', label: 'BI(생물학적 지시계)' }),
  bowieDick: v.enum(C.BD_RESULTS, { optional: true, default: 'na', label: '보위딕 시험' }),
  loadDesc: v.string({ max: 200, optional: true, label: '적재물' }),
  operatorId: v.id({ optional: true, label: '담당자' }),
  note: v.string({ max: 1000, optional: true, label: '메모' }),
});

const BASE_SQL = `
  SELECT s.*, e.name AS sterilizer_name, u.name AS operator_name, c.name AS created_by_name, rv.name AS resolved_by_name
  FROM sterilization_logs s
  LEFT JOIN equipment e ON e.id = s.sterilizer_id
  LEFT JOIN users u ON u.id = s.operator_id
  LEFT JOIN users c ON c.id = s.created_by
  LEFT JOIN users rv ON rv.id = s.resolved_by`;

/** 실패 여부: 지시계 하나라도 불합격이면 실패 */
function isFailed(s) {
  return s.ci_result === 'fail' || s.bi_result === 'fail' || s.bowie_dick === 'fail';
}

function toView(s, user) {
  const failed = isFailed(s);
  return {
    id: s.id,
    date: s.date,
    sterilizerId: s.sterilizer_id,
    sterilizerName: s.sterilizer_name || '(삭제된 장비)',
    cycleNo: s.cycle_no,
    program: s.program,
    temperature: s.temperature,
    pressure: s.pressure,
    durationMin: s.duration_min,
    ciResult: s.ci_result,
    biResult: s.bi_result,
    bowieDick: s.bowie_dick,
    loadDesc: s.load_desc,
    operatorId: s.operator_id,
    operatorName: s.operator_name || null,
    note: s.note,
    failed,
    resolved: !!s.resolved_at,
    resolvedAt: s.resolved_at,
    resolvedByName: s.resolved_by_name || null,
    actionNote: s.action_note,
    createdBy: s.created_by,
    createdByName: s.created_by_name || null,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    canEdit: !!user && (s.created_by === user.id || hasRole(user, 'manager')),
  };
}

function loadOne(id) {
  const s = get(`${BASE_SQL} WHERE s.id = ?`, id);
  if (!s) throw notFound('멸균 기록');
  return s;
}

/** 멸균기(분류가 '멸균기'인 장비)인지 확인 */
function checkSterilizer(id) {
  const e = get("SELECT id, name, category FROM equipment WHERE id = ?", id);
  if (!e || e.category !== '멸균기') throw badRequest('멸균기: 장비 목록에서 분류가 "멸균기"인 장비를 골라 주세요.', { field: 'sterilizerId' });
  return e;
}

function checkOperator(id) {
  if (id && !get('SELECT id FROM users WHERE id = ?', id)) throw badRequest('담당자: 직원을 찾을 수 없습니다.', { field: 'operatorId' });
}

/** 같은 날 같은 멸균기에 같은 회차가 이미 있는지 (태블릿에서 두 번 누르는 실수 방지) */
function checkDuplicate(d, exceptId = 0) {
  const dup = get(
    'SELECT id FROM sterilization_logs WHERE date = ? AND sterilizer_id = ? AND cycle_no = ? AND id != ?',
    d.date,
    d.sterilizerId,
    d.cycleNo,
    exceptId
  );
  if (dup) throw new HttpError(409, `이 멸균기의 ${d.cycleNo}회차 기록이 이미 있습니다. 회차 번호를 확인해 주세요.`, { field: 'cycleNo' });
}

/** 멸균기별 빠른 입력 기본값: 오늘 다음 회차, 마지막에 쓴 프로그램과 측정값 */
function defaultsFor(sterilizerId, date) {
  const maxToday = get('SELECT MAX(cycle_no) AS n FROM sterilization_logs WHERE sterilizer_id = ? AND date = ?', sterilizerId, date).n || 0;
  const last = get('SELECT * FROM sterilization_logs WHERE sterilizer_id = ? ORDER BY date DESC, cycle_no DESC, id DESC LIMIT 1', sterilizerId);
  const byProgram = {};
  for (const p of C.PROGRAMS) {
    const lp = get(
      'SELECT temperature, pressure, duration_min FROM sterilization_logs WHERE sterilizer_id = ? AND program = ? ORDER BY date DESC, id DESC LIMIT 1',
      sterilizerId,
      p
    );
    byProgram[p] = lp ? { temperature: lp.temperature, pressure: lp.pressure, durationMin: lp.duration_min } : PROGRAM_DEFAULTS[p];
  }
  return {
    nextCycle: maxToday + 1,
    program: last ? last.program : '일반',
    lastLoadDesc: last ? last.load_desc : '',
    byProgram,
    // 오늘 첫 회차이고 지난번에 보위딕 시험을 했다면, 오늘도 첫 회차엔 보위딕을 하도록 기본값 제안
    suggestBowieDick: maxToday === 0 && !!get("SELECT 1 FROM sterilization_logs WHERE sterilizer_id = ? AND bowie_dick != 'na' LIMIT 1", sterilizerId),
  };
}

function register(r) {
  r.get('/sterilization/meta', (req, res) => {
    const date = time.isValidDate(req.query.date) ? req.query.date : time.today();
    const sterilizers = all("SELECT id, name, model, location, status FROM equipment WHERE category = '멸균기' AND active = 1 ORDER BY name");
    const defaults = {};
    for (const s of sterilizers) defaults[s.id] = defaultsFor(s.id, date);
    const unresolved = all(`${BASE_SQL} WHERE (s.ci_result = 'fail' OR s.bi_result = 'fail' OR s.bowie_dick = 'fail') AND s.resolved_at IS NULL ORDER BY s.date DESC, s.cycle_no DESC`).map((s) =>
      toView(s, req.user)
    );
    const pendingBi = all(`${BASE_SQL} WHERE s.bi_result = 'pending' ORDER BY s.date, s.cycle_no`).map((s) => toView(s, req.user));
    const lastOperator = get('SELECT operator_id FROM sterilization_logs WHERE created_by = ? ORDER BY id DESC LIMIT 1', req.user.id);
    res.json({
      date,
      sterilizers,
      defaults,
      programDefaults: PROGRAM_DEFAULTS,
      unresolved,
      pendingBi,
      defaultOperatorId: lastOperator ? lastOperator.operator_id : req.user.id,
    });
  });

  r.get('/sterilization/logs', (req, res) => {
    const q = req.query;
    const date = time.isValidDate(q.date) ? q.date : null;
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(q.month || '') ? q.month : null;
    if (!date && !month) throw badRequest('날짜(date) 또는 월(month)을 정해 주세요.');
    const sterilizerId = Number(q.sterilizerId) || null;
    const w = where([
      [date && 's.date = :date'],
      [month && 's.date >= :from AND s.date <= :to'],
      [sterilizerId && 's.sterilizer_id = :sterilizerId'],
      [q.failed === '1' && "(s.ci_result = 'fail' OR s.bi_result = 'fail' OR s.bowie_dick = 'fail')"],
    ]);
    const params = { date, from: month ? `${month}-01` : null, to: month ? `${month}-31` : null, sterilizerId };
    const order = date ? 's.sterilizer_id, s.cycle_no DESC' : 's.date, e.name, s.cycle_no';
    const rows = all(`${BASE_SQL} ${w.sql} ORDER BY ${order}`, params).map((s) => toView(s, req.user));
    const summary = {
      count: rows.length,
      failed: rows.filter((x) => x.failed).length,
      unresolved: rows.filter((x) => x.failed && !x.resolved).length,
      biPending: rows.filter((x) => x.biResult === 'pending').length,
      biTests: rows.filter((x) => x.biResult !== 'na').length,
      days: new Set(rows.map((x) => x.date)).size,
    };
    res.json({ rows, summary });
  });

  r.post('/sterilization/logs', (req, res) => {
    const d = logSchema.parse(req.body);
    const ster = checkSterilizer(d.sterilizerId);
    checkOperator(d.operatorId);
    C.rejectPatientInfo(d.loadDesc, '적재물', 'loadDesc');
    C.rejectPatientInfo(d.note, '메모', 'note');
    checkDuplicate(d);
    const now = time.nowIso();
    const info = run(
      `INSERT INTO sterilization_logs (date, sterilizer_id, cycle_no, program, temperature, pressure, duration_min, ci_result, bi_result, bowie_dick,
         load_desc, operator_id, note, created_by, created_at, updated_at)
       VALUES (:date, :sterilizerId, :cycleNo, :program, :temperature, :pressure, :durationMin, :ciResult, :biResult, :bowieDick,
         :loadDesc, :operatorId, :note, :me, :now, :now)`,
      { ...d, operatorId: d.operatorId || req.user.id, me: req.user.id, now }
    );
    const s = loadOne(info.lastInsertRowid);
    audit(req, 'create', 'sterilization_logs', s.id, `멸균 기록: ${ster.name} ${d.date} ${d.cycleNo}회차${isFailed(s) ? ' (불합격)' : ''}`);
    res.status(201).json(toView(s, req.user));
  });

  r.patch('/sterilization/logs/:id', (req, res) => {
    const id = idParam(req.params.id);
    const s = loadOne(id);
    if (s.created_by !== req.user.id && !hasRole(req.user, 'manager')) throw forbidden();
    const p = logSchema.partial().parse(req.body);
    const merged = {
      date: p.date ?? s.date,
      sterilizerId: p.sterilizerId ?? s.sterilizer_id,
      cycleNo: p.cycleNo ?? s.cycle_no,
      program: p.program ?? s.program,
      temperature: 'temperature' in p ? p.temperature : s.temperature,
      pressure: 'pressure' in p ? p.pressure : s.pressure,
      durationMin: 'durationMin' in p ? p.durationMin : s.duration_min,
      ciResult: p.ciResult ?? s.ci_result,
      biResult: p.biResult ?? s.bi_result,
      bowieDick: p.bowieDick ?? s.bowie_dick,
      loadDesc: 'loadDesc' in p ? p.loadDesc : s.load_desc,
      operatorId: 'operatorId' in p ? p.operatorId : s.operator_id,
      note: 'note' in p ? p.note : s.note,
    };
    if ('sterilizerId' in p) checkSterilizer(merged.sterilizerId);
    if ('operatorId' in p) checkOperator(merged.operatorId);
    C.rejectPatientInfo(merged.loadDesc, '적재물', 'loadDesc');
    C.rejectPatientInfo(merged.note, '메모', 'note');
    checkDuplicate(merged, id);
    // 결과를 고쳐서 더 이상 실패가 아니면 조치 기록은 그대로 두되 경고 대상에서 빠짐 (isFailed 계산)
    run(
      `UPDATE sterilization_logs SET date = :date, sterilizer_id = :sterilizerId, cycle_no = :cycleNo, program = :program, temperature = :temperature,
         pressure = :pressure, duration_min = :durationMin, ci_result = :ciResult, bi_result = :biResult, bowie_dick = :bowieDick,
         load_desc = :loadDesc, operator_id = :operatorId, note = :note, updated_at = :now WHERE id = :id`,
      { ...merged, now: time.nowIso(), id }
    );
    audit(req, 'update', 'sterilization_logs', id, `멸균 기록 수정: ${merged.date} ${merged.cycleNo}회차`);
    res.json(toView(loadOne(id), req.user));
  });

  r.delete('/sterilization/logs/:id', (req, res) => {
    const id = idParam(req.params.id);
    const s = loadOne(id);
    if (s.created_by !== req.user.id && !hasRole(req.user, 'manager')) throw forbidden();
    run('DELETE FROM sterilization_logs WHERE id = ?', id);
    audit(req, 'delete', 'sterilization_logs', id, `멸균 기록 삭제: ${s.sterilizer_name || ''} ${s.date} ${s.cycle_no}회차`);
    res.json({ ok: true });
  });

  // BI(생물학적 지시계)는 배양(보통 24~48시간) 뒤 결과가 나오므로, 나중에 누구나 결과를 입력할 수 있게 함
  r.post('/sterilization/logs/:id/bi', (req, res) => {
    const id = idParam(req.params.id);
    const s = loadOne(id);
    const { result } = v.object({ result: v.enum(['pass', 'fail'], { label: 'BI 결과' }) }).parse(req.body);
    if (s.bi_result !== 'pending' && !(s.created_by === req.user.id || hasRole(req.user, 'manager'))) {
      throw badRequest('이미 BI 결과가 입력된 기록입니다. 고치려면 작성자나 실장님이 기록을 수정해 주세요.');
    }
    run('UPDATE sterilization_logs SET bi_result = ?, updated_at = ? WHERE id = ?', result, time.nowIso(), id);
    audit(req, 'update', 'sterilization_logs', id, `BI 결과 입력: ${s.date} ${s.cycle_no}회차 → ${RESULT_LABEL[result]}`);
    res.json(toView(loadOne(id), req.user));
  });

  // 실패 기록에 "어떻게 조치했는지" 남기기 → 대시보드 경고 해제
  r.post('/sterilization/logs/:id/resolve', (req, res) => {
    const id = idParam(req.params.id);
    const s = loadOne(id);
    if (!isFailed(s)) throw badRequest('불합격 결과가 없는 기록입니다.');
    const { actionNote } = v.object({ actionNote: v.string({ min: 2, max: 500, label: '조치 내용' }) }).parse(req.body);
    C.rejectPatientInfo(actionNote, '조치 내용', 'actionNote');
    run('UPDATE sterilization_logs SET resolved_at = ?, resolved_by = ?, action_note = ?, updated_at = ? WHERE id = ?', time.nowIso(), req.user.id, actionNote, time.nowIso(), id);
    audit(req, 'update', 'sterilization_logs', id, `멸균 실패 조치 기록: ${s.date} ${s.cycle_no}회차`);
    res.json(toView(loadOne(id), req.user));
  });
}

/** 대시보드용 요약 */
function dashboardInfo(today) {
  const failures = all(
    `${BASE_SQL} WHERE (s.ci_result = 'fail' OR s.bi_result = 'fail' OR s.bowie_dick = 'fail') AND (s.resolved_at IS NULL OR s.date = ?)
     ORDER BY s.date DESC LIMIT 5`,
    today
  );
  const todayCount = get('SELECT COUNT(*) AS n FROM sterilization_logs WHERE date = ?', today).n;
  const biPending = get("SELECT COUNT(*) AS n FROM sterilization_logs WHERE bi_result = 'pending'").n;
  const hasSterilizer = !!get("SELECT 1 FROM equipment WHERE category = '멸균기' AND active = 1 LIMIT 1");
  return { failures, todayCount, biPending, hasSterilizer };
}

module.exports = { register, dashboardInfo, isFailed, PROGRAM_DEFAULTS, RESULT_LABEL };
