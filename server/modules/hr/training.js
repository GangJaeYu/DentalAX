/*
 * 이 파일이 하는 일: [교육 이수] 서버 기능입니다. (교육 항목, 이수 기록, 직원 × 교육 현황표)
 *
 *   현황표 상태 (기준일 = 오늘)
 *     done    완료      : 마지막 이수일 + 주기(개월)가 30일보다 더 남음 (주기가 없으면 이수만 하면 완료)
 *     soon    임박      : 다음 기한까지 30일 이내
 *     expired 만료      : 다음 기한이 지남
 *     missing 미이수    : 받아야 하는데 기록이 없음
 *     na      해당 없음 : 이 직종은 대상이 아님 (required_for)
 *   법정 교육의 대상·주기는 법령·업종·규모에 따라 다르므로 "주기 확인 필요"(needs_check) 표시를 두고, 모두 고칠 수 있습니다.
 *
 * API (/api/hr/...)
 *   GET    /trainings                교육 항목 목록         POST /trainings, PATCH/DELETE /trainings/:id (실장 이상)
 *   GET    /training/matrix          직원 × 교육 현황표
 *   GET    /training/records         이수 기록 (trainingId, userId)
 *   POST   /training/records         이수 기록 추가 — 여러 직원을 한 번에 (단체 교육) (실장 이상)
 *   DELETE /training/records/:id     이수 기록 삭제 (실장 이상)
 */
const { all, get, run, tx } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, badRequest } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { requireRole } = require('../../core/auth');
const time = require('../../core/time');
const lib = require('./lib');

const CATEGORIES = ['법정 의무', '직무', '기타'];
const SOON_DAYS = 30;

const trainingSchema = v.object({
  name: v.string({ min: 1, max: 60, label: '교육 이름' }),
  category: v.enum(CATEGORIES, { label: '분류', optional: true, default: '법정 의무' }),
  cycleMonths: v.int({ min: 1, max: 120, optional: true, label: '주기(개월)' }),
  needsCheck: v.bool(),
  requiredFor: v.string({ max: 100, optional: true, default: 'all', label: '대상' }),
  description: v.string({ max: 300, optional: true, label: '설명' }),
  legalNote: v.string({ max: 300, optional: true, label: '근거·참고' }),
  active: v.bool({ default: true }),
  sort: v.int({ min: 0, max: 999, optional: true }),
});

/** 대상 직종 목록 ('all' 이면 빈 배열 = 전 직원) */
function requiredList(t) {
  const s = (t.required_for || 'all').trim();
  if (!s || s === 'all') return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function isRequired(t, jobTitle) {
  const list = requiredList(t);
  return !list.length || list.includes(jobTitle);
}

function trainingView(t) {
  const list = requiredList(t);
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    cycleMonths: t.cycle_months,
    needsCheck: !!t.needs_check,
    requiredFor: list.length ? list.join(',') : 'all',
    requiredLabel: list.length ? list.join('·') : '전 직원',
    description: t.description,
    legalNote: t.legal_note,
    active: !!t.active,
    sort: t.sort,
    recordCount: t.record_count ?? undefined,
  };
}

/** 마지막 이수일로 상태 계산 */
function statusOf(t, lastDate, today) {
  if (!lastDate) return { status: 'missing', lastDate: null, nextDue: null, dday: null };
  if (!t.cycle_months) return { status: 'done', lastDate, nextDue: null, dday: null };
  const nextDue = time.addMonths(lastDate, t.cycle_months);
  const dday = time.diffDays(today, nextDue);
  return { status: dday < 0 ? 'expired' : dday <= SOON_DAYS ? 'soon' : 'done', lastDate, nextDue, dday };
}

/**
 * 직원 × 교육 현황표 계산 (대시보드에서도 씀)
 * @param {{ userId?: number }} opts userId를 주면 그 직원만
 */
function buildMatrix(opts = {}) {
  const today = time.today();
  const trainings = all('SELECT * FROM trainings WHERE active = 1 ORDER BY sort, id');
  let staff = lib.activeStaff();
  if (opts.userId) staff = staff.filter((s) => s.id === opts.userId);
  const last = {};
  for (const r of all('SELECT training_id, user_id, MAX(completed_date) AS last FROM training_records GROUP BY training_id, user_id')) last[`${r.user_id}|${r.training_id}`] = r.last;
  const cells = {};
  const totals = { done: 0, soon: 0, expired: 0, missing: 0 };
  for (const s of staff) {
    cells[s.id] = {};
    for (const t of trainings) {
      const required = isRequired(t, s.jobTitle);
      const lastDate = last[`${s.id}|${t.id}`] || null;
      const st = statusOf(t, lastDate, today);
      if (!required && !lastDate) st.status = 'na';
      st.required = required;
      cells[s.id][t.id] = st;
      if (required && totals[st.status] !== undefined) totals[st.status]++;
    }
  }
  return { today, soonDays: SOON_DAYS, trainings: trainings.map(trainingView), staff, cells, totals };
}

function register(r) {
  const managerUp = requireRole('manager');

  r.get('/trainings', (req, res) => {
    const rows = all(
      `SELECT t.*, (SELECT COUNT(*) FROM training_records r WHERE r.training_id = t.id) AS record_count
       FROM trainings t ${req.query.all === '1' ? '' : 'WHERE t.active = 1'} ORDER BY t.active DESC, t.sort, t.id`
    );
    res.json({ rows: rows.map(trainingView), categories: CATEGORIES });
  });

  r.post('/trainings', managerUp, (req, res) => {
    const d = trainingSchema.parse(req.body);
    const now = time.nowIso();
    const info = run(
      `INSERT INTO trainings (name, category, cycle_months, needs_check, required_for, description, legal_note, active, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.name,
      d.category,
      d.cycleMonths,
      d.needsCheck,
      d.requiredFor || 'all',
      d.description,
      d.legalNote,
      d.active,
      d.sort ?? get('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM trainings').n,
      now,
      now
    );
    audit(req, 'create', 'trainings', info.lastInsertRowid, `교육 항목 추가: ${d.name}`);
    res.status(201).json(trainingView(get('SELECT * FROM trainings WHERE id = ?', info.lastInsertRowid)));
  });

  r.patch('/trainings/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const t = get('SELECT * FROM trainings WHERE id = ?', id);
    if (!t) throw notFound('교육 항목');
    const d = trainingSchema.partial().parse(req.body);
    run(
      `UPDATE trainings SET name = ?, category = ?, cycle_months = ?, needs_check = ?, required_for = ?, description = ?, legal_note = ?, active = ?, sort = ?, updated_at = ? WHERE id = ?`,
      d.name ?? t.name,
      d.category ?? t.category,
      'cycleMonths' in d ? d.cycleMonths : t.cycle_months,
      'needsCheck' in d ? d.needsCheck : t.needs_check,
      'requiredFor' in d ? d.requiredFor || 'all' : t.required_for,
      'description' in d ? d.description : t.description,
      'legalNote' in d ? d.legalNote : t.legal_note,
      'active' in d ? d.active : t.active,
      d.sort ?? t.sort,
      time.nowIso(),
      id
    );
    audit(req, 'update', 'trainings', id, `교육 항목 수정: ${d.name ?? t.name}`);
    res.json(trainingView(get('SELECT * FROM trainings WHERE id = ?', id)));
  });

  // 이수 기록이 있는 교육은 지우면 기록이 함께 사라지므로 "사용 안 함"으로 바꿉니다.
  r.delete('/trainings/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const t = get('SELECT * FROM trainings WHERE id = ?', id);
    if (!t) throw notFound('교육 항목');
    const n = get('SELECT COUNT(*) AS n FROM training_records WHERE training_id = ?', id).n;
    if (n > 0) {
      run('UPDATE trainings SET active = 0, updated_at = ? WHERE id = ?', time.nowIso(), id);
      audit(req, 'update', 'trainings', id, `교육 항목 사용 안 함(이수 기록 ${n}건 보존): ${t.name}`);
      return res.json({ ok: true, archived: true, records: n });
    }
    run('DELETE FROM trainings WHERE id = ?', id);
    audit(req, 'delete', 'trainings', id, `교육 항목 삭제: ${t.name}`);
    res.json({ ok: true, archived: false });
  });

  r.get('/training/matrix', (req, res) => res.json(buildMatrix()));

  r.get('/training/records', (req, res) => {
    const trainingId = Number(req.query.trainingId) || null;
    const userId = Number(req.query.userId) || null;
    const rows = all(
      `SELECT r.*, t.name AS training_name, u.name AS user_name, c.name AS created_by_name
       FROM training_records r JOIN trainings t ON t.id = r.training_id JOIN users u ON u.id = r.user_id
       LEFT JOIN users c ON c.id = r.created_by
       WHERE (:trainingId IS NULL OR r.training_id = :trainingId) AND (:userId IS NULL OR r.user_id = :userId)
       ORDER BY r.completed_date DESC, r.id DESC LIMIT 500`,
      { trainingId, userId }
    );
    res.json({
      rows: rows.map((r) => ({
        id: r.id,
        trainingId: r.training_id,
        trainingName: r.training_name,
        userId: r.user_id,
        userName: r.user_name,
        completedDate: r.completed_date,
        hours: r.hours,
        provider: r.provider,
        memo: r.memo,
        createdByName: r.created_by_name,
        createdAt: r.created_at,
      })),
    });
  });

  r.post('/training/records', managerUp, (req, res) => {
    const d = v
      .object({
        trainingId: v.id({ label: '교육' }),
        userIds: v.array(v.id({ label: '직원' }), { min: 1, max: 100, label: '이수한 직원' }),
        completedDate: v.date({ label: '이수일' }),
        hours: v.number({ min: 0, max: 200, optional: true, label: '교육 시간' }),
        provider: v.string({ max: 60, optional: true, label: '교육 기관' }),
        memo: v.string({ max: 200, optional: true, label: '메모' }),
      })
      .parse(req.body);
    const t = get('SELECT * FROM trainings WHERE id = ?', d.trainingId);
    if (!t) throw badRequest('없는 교육 항목입니다.', { field: 'trainingId' });
    if (d.completedDate > time.today()) throw badRequest('이수일이 오늘 이후입니다. 교육을 받은 날짜를 넣어 주세요.', { field: 'completedDate' });
    const ids = [...new Set(d.userIds)];
    const names = [];
    tx(() => {
      for (const uid of ids) {
        const u = lib.activeUser(uid);
        if (!u) throw badRequest('재직 중인 직원이 아닌 사람이 들어 있습니다.', { field: 'userIds' });
        names.push(u.name);
        run(
          `INSERT INTO training_records (training_id, user_id, completed_date, hours, provider, memo, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          d.trainingId,
          uid,
          d.completedDate,
          d.hours,
          d.provider,
          d.memo,
          req.user.id,
          time.nowIso()
        );
      }
    });
    audit(req, 'create', 'training_records', d.trainingId, `교육 이수 기록: ${t.name} ${d.completedDate} — ${names.join(', ')}`);
    res.status(201).json({ ok: true, added: ids.length });
  });

  r.delete('/training/records/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const rec = get('SELECT r.*, t.name AS tn, u.name AS un FROM training_records r JOIN trainings t ON t.id = r.training_id JOIN users u ON u.id = r.user_id WHERE r.id = ?', id);
    if (!rec) throw notFound('이수 기록');
    run('DELETE FROM training_records WHERE id = ?', id);
    audit(req, 'delete', 'training_records', id, `교육 이수 기록 삭제: ${rec.tn} ${rec.completed_date} ${rec.un}`);
    res.json({ ok: true });
  });
}

module.exports = { register, buildMatrix, CATEGORIES };
