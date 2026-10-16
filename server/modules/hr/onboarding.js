/*
 * 이 파일이 하는 일: [온보딩] 서버 기능입니다. (신규 직원 적응 체크리스트)
 *
 *   템플릿(직종별 항목 묶음: 첫날/첫 주/첫 달) → 새 직원에게 "온보딩 시작" → 항목을 하나씩 체크 → 진행률 확인
 *   - 템플릿 편집·온보딩 시작/삭제는 실장 이상. 항목 체크는 로그인한 누구나(담당 선배가 체크할 수 있게) — 누가 체크했는지 기록됩니다.
 *   - 모든 항목을 체크하면 자동으로 "완료", 하나라도 풀면 다시 "진행 중"이 됩니다.
 *   - AI(hr.onboarding): 직종과 병원 메모를 주면 온보딩 항목 10~15개 초안을 만들어 줍니다. 고른 항목만 템플릿에 넣습니다.
 *
 * API (/api/hr/onboarding/...)
 *   GET    /templates                 템플릿 + 항목           POST /templates, PATCH/DELETE /templates/:id (실장 이상)
 *   POST   /templates/:id/items       항목 여러 개 추가 (실장 이상)
 *   PATCH  /items/:id, DELETE /items/:id, POST /items/:id/move {dir:'up'|'down'} (실장 이상)
 *   GET    /runs?status=active|done|all   직원별 진행 목록
 *   POST   /runs                      온보딩 시작 (실장 이상)
 *   GET    /runs/:id                  진행 상세 (단계별 항목, 체크 여부)
 *   PATCH  /runs/:id, DELETE /runs/:id (실장 이상)
 *   PUT    /runs/:id/checks/:itemId   항목 체크/해제 {done, note}
 */
const { all, get, run, tx } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, badRequest, HttpError } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { requireRole } = require('../../core/auth');
const time = require('../../core/time');
const lib = require('./lib');

const PHASES = ['첫날', '첫 주', '첫 달'];
const OWNER_ROLES = ['원장', '실장', '담당 선배', '본인'];

/** 단계별 마감일: 첫날 = 시작일, 첫 주 = 시작일+6일, 첫 달 = 한 달 뒤 하루 전 */
function phaseDue(phase, startDate) {
  if (phase === '첫날') return startDate;
  if (phase === '첫 주') return time.addDays(startDate, 6);
  return time.addDays(time.addMonths(startDate, 1), -1);
}

const itemSchema = v.object({
  title: v.string({ min: 1, max: 100, label: '항목' }),
  phase: v.enum(PHASES, { label: '단계', optional: true, default: '첫날' }),
  ownerRole: v.enum(OWNER_ROLES, { label: '담당', optional: true }),
});

function itemView(i) {
  return { id: i.id, templateId: i.template_id, title: i.title, phase: i.phase, ownerRole: i.owner_role, sort: i.sort };
}

/** 단계 순서 → 단계 안 순서로 정렬된 항목 */
function templateItems(templateId) {
  return all(
    `SELECT * FROM onboarding_template_items WHERE template_id = ?
     ORDER BY CASE phase WHEN '첫날' THEN 0 WHEN '첫 주' THEN 1 ELSE 2 END, sort, id`,
    templateId
  ).map(itemView);
}

function templateView(t) {
  return {
    id: t.id,
    name: t.name,
    jobTitle: t.job_title,
    items: templateItems(t.id),
    runCount: get('SELECT COUNT(*) AS n FROM onboarding_runs WHERE template_id = ?', t.id).n,
  };
}

const RUN_SQL = `
  SELECT r.*, u.name AS user_name, u.color AS user_color, u.job_title AS user_job, u.hire_date AS user_hire, t.name AS template_name,
    (SELECT COUNT(*) FROM onboarding_template_items i WHERE i.template_id = r.template_id) AS total,
    (SELECT COUNT(*) FROM onboarding_checks c JOIN onboarding_template_items i ON i.id = c.item_id
       WHERE c.run_id = r.id AND i.template_id = r.template_id) AS done
  FROM onboarding_runs r JOIN users u ON u.id = r.user_id JOIN onboarding_templates t ON t.id = r.template_id`;

function runView(r, viewer) {
  const today = time.today();
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    userColor: r.user_color,
    jobTitle: r.user_job,
    hireDate: r.user_hire,
    templateId: r.template_id,
    templateName: r.template_name,
    startDate: r.start_date,
    endDate: phaseDue('첫 달', r.start_date),
    dayN: time.diffDays(r.start_date, today) + 1,
    status: r.status,
    total: r.total,
    done: r.done,
    mine: viewer ? r.user_id === viewer.id : false,
    createdAt: r.created_at,
  };
}

/** 진행 상세: 단계별 묶음 + 각 항목 체크 여부 */
function runDetail(id, viewer) {
  const r = get(`${RUN_SQL} WHERE r.id = ?`, id);
  if (!r) return null;
  const today = time.today();
  const checks = {};
  for (const c of all('SELECT c.*, u.name AS done_by_name FROM onboarding_checks c LEFT JOIN users u ON u.id = c.done_by WHERE c.run_id = ?', id)) checks[c.item_id] = c;
  const items = templateItems(r.template_id);
  const phases = PHASES.map((phase) => {
    const list = items
      .filter((i) => i.phase === phase)
      .map((i) => {
        const c = checks[i.id];
        return { ...i, done: !!c, doneByName: c ? c.done_by_name : null, doneAt: c ? c.done_at : null, note: c ? c.note : null };
      });
    const due = phaseDue(phase, r.start_date);
    const left = list.filter((i) => !i.done).length;
    return { phase, due, items: list, left, overdue: left > 0 && due < today };
  }).filter((p) => p.items.length);
  return { ...runView(r, viewer), phases };
}

/** 체크 수에 맞춰 진행 상태 자동 맞춤 (모두 체크 → 완료, 아니면 진행 중). 중단(cancelled)은 그대로 */
function syncRunStatus(id) {
  const r = get(`${RUN_SQL} WHERE r.id = ?`, id);
  if (!r || r.status === 'cancelled') return;
  const next = r.total > 0 && r.done >= r.total ? 'done' : 'active';
  if (next !== r.status) run('UPDATE onboarding_runs SET status = ?, updated_at = ? WHERE id = ?', next, time.nowIso(), id);
}

function register(r) {
  const managerUp = requireRole('manager');

  // ---------- 템플릿 ----------
  r.get('/onboarding/templates', (req, res) => {
    res.json({ rows: all('SELECT * FROM onboarding_templates ORDER BY id').map(templateView), phases: PHASES, ownerRoles: OWNER_ROLES });
  });

  const templateSchema = v.object({
    name: v.string({ min: 1, max: 40, label: '템플릿 이름' }),
    jobTitle: v.string({ max: 30, optional: true, label: '직종' }),
  });

  r.post('/onboarding/templates', managerUp, (req, res) => {
    const d = templateSchema.parse(req.body);
    const now = time.nowIso();
    const info = run('INSERT INTO onboarding_templates (name, job_title, created_at, updated_at) VALUES (?, ?, ?, ?)', d.name, d.jobTitle, now, now);
    audit(req, 'create', 'onboarding_templates', info.lastInsertRowid, `온보딩 템플릿 추가: ${d.name}`);
    res.status(201).json(templateView(get('SELECT * FROM onboarding_templates WHERE id = ?', info.lastInsertRowid)));
  });

  r.patch('/onboarding/templates/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const t = get('SELECT * FROM onboarding_templates WHERE id = ?', id);
    if (!t) throw notFound('템플릿');
    const d = templateSchema.partial().parse(req.body);
    run('UPDATE onboarding_templates SET name = ?, job_title = ?, updated_at = ? WHERE id = ?', d.name ?? t.name, 'jobTitle' in d ? d.jobTitle : t.job_title, time.nowIso(), id);
    audit(req, 'update', 'onboarding_templates', id, `온보딩 템플릿 수정: ${d.name ?? t.name}`);
    res.json(templateView(get('SELECT * FROM onboarding_templates WHERE id = ?', id)));
  });

  r.delete('/onboarding/templates/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const t = get('SELECT * FROM onboarding_templates WHERE id = ?', id);
    if (!t) throw notFound('템플릿');
    const n = get('SELECT COUNT(*) AS n FROM onboarding_runs WHERE template_id = ?', id).n;
    if (n > 0) throw new HttpError(409, `이 템플릿으로 시작한 온보딩이 ${n}건 있어 지울 수 없습니다. 해당 온보딩을 먼저 삭제해 주세요.`);
    run('DELETE FROM onboarding_templates WHERE id = ?', id);
    audit(req, 'delete', 'onboarding_templates', id, `온보딩 템플릿 삭제: ${t.name}`);
    res.json({ ok: true });
  });

  r.post('/onboarding/templates/:id/items', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const t = get('SELECT * FROM onboarding_templates WHERE id = ?', id);
    if (!t) throw notFound('템플릿');
    const d = v.object({ items: v.array(itemSchema, { min: 1, max: 50, label: '항목' }) }).parse(req.body);
    tx(() => {
      let sort = get('SELECT COALESCE(MAX(sort), 0) AS n FROM onboarding_template_items WHERE template_id = ?', id).n;
      for (const it of d.items) run('INSERT INTO onboarding_template_items (template_id, title, phase, owner_role, sort) VALUES (?, ?, ?, ?, ?)', id, it.title, it.phase, it.ownerRole, ++sort);
    });
    // 이 템플릿으로 진행 중인 온보딩은 새 항목이 생겨 다시 "진행 중"이 될 수 있음
    for (const rr of all('SELECT id FROM onboarding_runs WHERE template_id = ?', id)) syncRunStatus(rr.id);
    audit(req, 'create', 'onboarding_template_items', id, `온보딩 항목 ${d.items.length}개 추가: ${t.name}`);
    res.status(201).json(templateView(t));
  });

  r.patch('/onboarding/items/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const it = get('SELECT * FROM onboarding_template_items WHERE id = ?', id);
    if (!it) throw notFound('항목');
    const d = itemSchema.partial().parse(req.body);
    run('UPDATE onboarding_template_items SET title = ?, phase = ?, owner_role = ? WHERE id = ?', d.title ?? it.title, d.phase ?? it.phase, 'ownerRole' in d ? d.ownerRole : it.owner_role, id);
    audit(req, 'update', 'onboarding_template_items', id, `온보딩 항목 수정: ${d.title ?? it.title}`);
    res.json(itemView(get('SELECT * FROM onboarding_template_items WHERE id = ?', id)));
  });

  r.delete('/onboarding/items/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const it = get('SELECT * FROM onboarding_template_items WHERE id = ?', id);
    if (!it) throw notFound('항목');
    run('DELETE FROM onboarding_template_items WHERE id = ?', id);
    for (const rr of all('SELECT id FROM onboarding_runs WHERE template_id = ?', it.template_id)) syncRunStatus(rr.id);
    audit(req, 'delete', 'onboarding_template_items', id, `온보딩 항목 삭제: ${it.title}`);
    res.json({ ok: true });
  });

  // 같은 단계 안에서 위/아래 항목과 순서를 바꿉니다.
  r.post('/onboarding/items/:id/move', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const it = get('SELECT * FROM onboarding_template_items WHERE id = ?', id);
    if (!it) throw notFound('항목');
    const { dir } = v.object({ dir: v.enum(['up', 'down'], { label: '방향' }) }).parse(req.body);
    const list = all('SELECT id, sort FROM onboarding_template_items WHERE template_id = ? AND phase = ? ORDER BY sort, id', it.template_id, it.phase);
    const i = list.findIndex((x) => x.id === id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j >= 0 && j < list.length) {
      tx(() => {
        // 정렬값이 겹쳐 있을 수 있어 단계 안 순서를 0,1,2… 로 다시 매긴 뒤 바꿉니다.
        const ids = list.map((x) => x.id);
        [ids[i], ids[j]] = [ids[j], ids[i]];
        ids.forEach((x, k) => run('UPDATE onboarding_template_items SET sort = ? WHERE id = ?', k + 1, x));
      });
    }
    res.json({ ok: true });
  });

  // ---------- 직원별 진행 ----------
  r.get('/onboarding/runs', (req, res) => {
    const status = ['active', 'done', 'cancelled'].includes(req.query.status) ? req.query.status : req.query.status === 'all' ? null : 'active';
    const rows = all(`${RUN_SQL} WHERE (:status IS NULL OR r.status = :status) ORDER BY r.status = 'active' DESC, r.start_date DESC`, { status });
    const counts = {};
    for (const c of all('SELECT status, COUNT(*) AS n FROM onboarding_runs GROUP BY status')) counts[c.status] = c.n;
    res.json({ rows: rows.map((x) => runView(x, req.user)), counts });
  });

  r.post('/onboarding/runs', managerUp, (req, res) => {
    const d = v.object({ userId: v.id({ label: '직원' }), templateId: v.id({ label: '템플릿' }), startDate: v.date({ label: '시작일' }) }).parse(req.body);
    const u = lib.activeUser(d.userId);
    if (!u) throw badRequest('재직 중인 직원을 골라 주세요.', { field: 'userId' });
    const t = get('SELECT * FROM onboarding_templates WHERE id = ?', d.templateId);
    if (!t) throw badRequest('템플릿을 골라 주세요.', { field: 'templateId' });
    if (get("SELECT id FROM onboarding_runs WHERE user_id = ? AND status = 'active'", d.userId)) throw new HttpError(409, `${u.name} 님은 이미 진행 중인 온보딩이 있습니다.`);
    const now = time.nowIso();
    const info = run('INSERT INTO onboarding_runs (user_id, template_id, start_date, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', d.userId, d.templateId, d.startDate, 'active', req.user.id, now, now);
    audit(req, 'create', 'onboarding_runs', info.lastInsertRowid, `온보딩 시작: ${u.name} (${t.name})`);
    res.status(201).json(runDetail(info.lastInsertRowid, req.user));
  });

  r.get('/onboarding/runs/:id', (req, res) => {
    const d = runDetail(idParam(req.params.id), req.user);
    if (!d) throw notFound('온보딩');
    res.json(d);
  });

  r.patch('/onboarding/runs/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const cur = get(`${RUN_SQL} WHERE r.id = ?`, id);
    if (!cur) throw notFound('온보딩');
    const d = v.object({ status: v.enum(['active', 'done', 'cancelled'], { label: '상태' }), startDate: v.date({ label: '시작일' }) }).partial().parse(req.body);
    run('UPDATE onboarding_runs SET status = ?, start_date = ?, updated_at = ? WHERE id = ?', d.status ?? cur.status, d.startDate ?? cur.start_date, time.nowIso(), id);
    audit(req, 'update', 'onboarding_runs', id, `온보딩 수정: ${cur.user_name}${d.status ? ` (${{ active: '진행 중', done: '완료', cancelled: '중단' }[d.status]})` : ''}`);
    res.json(runDetail(id, req.user));
  });

  r.delete('/onboarding/runs/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const cur = get(`${RUN_SQL} WHERE r.id = ?`, id);
    if (!cur) throw notFound('온보딩');
    run('DELETE FROM onboarding_runs WHERE id = ?', id);
    audit(req, 'delete', 'onboarding_runs', id, `온보딩 삭제: ${cur.user_name} (${cur.template_name})`);
    res.json({ ok: true });
  });

  r.put('/onboarding/runs/:id/checks/:itemId', (req, res) => {
    const id = idParam(req.params.id);
    const itemId = idParam(req.params.itemId);
    const cur = get('SELECT * FROM onboarding_runs WHERE id = ?', id);
    if (!cur) throw notFound('온보딩');
    if (cur.status === 'cancelled') throw badRequest('중단된 온보딩입니다. 실장님께 다시 시작해 달라고 요청해 주세요.');
    const it = get('SELECT * FROM onboarding_template_items WHERE id = ? AND template_id = ?', itemId, cur.template_id);
    if (!it) throw notFound('항목');
    const d = v.object({ done: v.bool(), note: v.string({ max: 100, optional: true, label: '메모' }) }).parse(req.body);
    if (d.done) {
      run(
        `INSERT INTO onboarding_checks (run_id, item_id, done_by, done_at, note) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, item_id) DO UPDATE SET note = excluded.note`,
        id,
        itemId,
        req.user.id,
        time.nowIso(),
        d.note
      );
    } else {
      run('DELETE FROM onboarding_checks WHERE run_id = ? AND item_id = ?', id, itemId);
    }
    syncRunStatus(id);
    res.json(runDetail(id, req.user));
  });
}

// ---------- AI: 직종별 온보딩 항목 초안 ----------
const DEMO_BANK = {
  hygienist: [
    ['원내 둘러보기 — 진료실·멸균실·비상구·소화기 위치 확인', '첫날'],
    ['근무 시간·휴게·근무표 보는 법 안내', '첫날'],
    ['손위생·개인보호구(마스크·장갑·보안경) 착용 기준 확인', '첫날'],
    ['유니트체어 기본 조작과 수관 물 관리 방법 익히기', '첫날'],
    ['기구 세척 → 포장 → 멸균 → 보관 흐름 실습 (멸균기 기록 포함)', '첫 주'],
    ['진료 전 준비·진료 후 정리 체크리스트 익히기', '첫 주'],
    ['방사선 촬영 장비 사용법과 안전 수칙 확인', '첫 주'],
    ['재료·소모품 보관 위치와 출고 기록 방법 익히기', '첫 주'],
    ['스케일링·예방처치 진행 동선을 담당 선배와 함께 점검', '첫 달'],
    ['감염관리 자체 점검에 함께 참여하기', '첫 달'],
    ['법정 의무교육(개인정보보호·성희롱 예방 등) 이수', '첫 달'],
    ['1개월 적응 면담 (원장·실장)', '첫 달'],
  ],
  nurse: [
    ['원내 둘러보기 — 진료실·멸균실·비상구·소화기 위치 확인', '첫날'],
    ['근무 시간·휴게·근무표 보는 법 안내', '첫날'],
    ['손위생·개인보호구 착용 기준 확인', '첫날'],
    ['진료 보조 기본 동선과 기구 이름 익히기', '첫 주'],
    ['기구 세척·멸균 흐름 실습 (멸균기 기록 포함)', '첫 주'],
    ['소독제 개봉일 표기·보관 규칙 익히기', '첫 주'],
    ['재료·소모품 보관 위치와 출고 기록 방법', '첫 주'],
    ['오픈·마감 체크리스트 수행해 보기', '첫 주'],
    ['감염관리 자체 점검에 함께 참여하기', '첫 달'],
    ['법정 의무교육(개인정보보호·성희롱 예방 등) 이수', '첫 달'],
    ['1개월 적응 면담 (원장·실장)', '첫 달'],
  ],
  desk: [
    ['병원 기본 정보(진료시간·주차·오시는 길) 숙지', '첫날'],
    ['예약 프로그램 계정 받기와 기본 화면 익히기', '첫날'],
    ['개인정보 처리 원칙 — 화면 잠금, 서류 보관, 통화 시 주의점', '첫날'],
    ['전화 응대 기본 스크립트 연습 (소통 도우미 활용)', '첫 주'],
    ['접수·수납 흐름을 선배 옆에서 참관', '첫 주'],
    ['예약 변경·취소 응대 연습', '첫 주'],
    ['보험 일반 안내 범위 익히기 (진료비 상담은 실장에게 연결)', '첫 주'],
    ['오픈·마감 체크리스트 수행해 보기', '첫 주'],
    ['온라인 리뷰·문의 응대 원칙(의료광고 주의) 익히기', '첫 달'],
    ['불만 응대 절차와 보고 방법 확인', '첫 달'],
    ['법정 의무교육(개인정보보호·성희롱 예방 등) 이수', '첫 달'],
    ['1개월 적응 면담 (원장·실장)', '첫 달'],
  ],
  general: [
    ['원내 둘러보기 — 비상구·소화기 위치 확인', '첫날'],
    ['근무 시간·휴게·근무표 보는 법 안내', '첫날'],
    ['개인정보 처리 원칙과 보안 수칙 안내', '첫날'],
    ['담당 업무와 하루 흐름을 선배와 함께 확인', '첫 주'],
    ['자주 쓰는 물품 위치와 요청 방법 익히기', '첫 주'],
    ['오픈·마감 체크리스트 수행해 보기', '첫 주'],
    ['공지·인수인계 보드 사용법 익히기', '첫 주'],
    ['법정 의무교육(개인정보보호·성희롱 예방 등) 이수', '첫 달'],
    ['업무 매뉴얼 읽고 궁금한 점 정리하기', '첫 달'],
    ['1개월 적응 면담 (원장·실장)', '첫 달'],
  ],
};

function demoKind(job) {
  if (/위생/.test(job)) return 'hygienist';
  if (/간호|조무/.test(job)) return 'nurse';
  if (/데스크|코디|상담|접수|실장/.test(job)) return 'desk';
  return 'general';
}

/** AI 결과(JSON)를 안전한 모양으로 정리: [{ title, phase }] 최대 20개 */
function normalizeItems(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => (typeof x === 'string' ? { title: x } : x || {}))
    .map((x) => ({
      title: String(x.title || x.item || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      phase: PHASES.includes(x.phase) ? x.phase : /주/.test(String(x.phase || '')) ? '첫 주' : /달|월/.test(String(x.phase || '')) ? '첫 달' : '첫날',
    }))
    .filter((x) => x.title)
    .slice(0, 20);
}

const aiFeatures = [
  {
    key: 'hr.onboarding',
    label: '직종별 온보딩 항목 초안',
    group: '인사·근무',
    tier: 'fast',
    maxTokens: 1200,
    input: v.object({
      jobTitle: v.string({ min: 1, max: 30, label: '직종' }),
      notes: v.string({ max: 1500, optional: true, default: '', label: '병원 메모' }),
    }),
    build(input, ctx) {
      return {
        prompt: [
          `치과의원(${ctx.clinic?.name || '치과'})에 새로 들어온 "${input.jobTitle}" 직원의 온보딩(적응) 체크 항목을 10~15개 만들어 주세요.`,
          '규칙:',
          '- 단계(phase)는 "첫날", "첫 주", "첫 달" 중 하나.',
          '- 항목(title)은 40자 안팎의 짧은 행동 문장. 실제로 확인·체크할 수 있는 일로.',
          '- 환자 개인정보를 다루는 일은 "원칙 안내" 수준으로만 쓰고, 환자 정보를 예시로 넣지 마세요.',
          '- 법정 교육 주기처럼 확실하지 않은 내용은 "(확인 필요)"를 붙이세요.',
          '- 아래 병원 메모가 있으면 반영하세요.',
          '형식: 설명 한 줄 뒤에 JSON 코드블록 하나만. 예) ```json\n[{"title":"원내 둘러보기","phase":"첫날"}]\n```',
          '',
          '[병원 메모]',
          input.notes || '(없음)',
        ].join('\n'),
      };
    },
    demo(input) {
      const items = DEMO_BANK[demoKind(input.jobTitle)].map(([title, phase]) => ({ title, phase }));
      // 메모가 있으면 앞의 두 줄을 항목으로 반영 (데모에서도 입력이 결과에 보이도록)
      const notes = String(input.notes || '')
        .split(/\n|,|·/)
        .map((s) => s.replace(/^[-*\d.)\s]+/, '').trim())
        .filter((s) => s.length >= 2)
        .slice(0, 2);
      for (const n of notes) items.splice(items.length - 1, 0, { title: `원내 메모 반영: ${n.slice(0, 40)} — 담당 선배에게 안내받기`, phase: '첫 주' });
      return [
        `${input.jobTitle} 신규 직원 온보딩 항목 초안입니다. 필요한 항목만 골라 템플릿에 넣으세요.`,
        '',
        '```json',
        JSON.stringify(items.slice(0, 15), null, 2),
        '```',
        '',
        '(데모 모드 예시입니다. AI 키를 넣으면 실제 AI가 병원 메모에 맞춰 만듭니다.)',
      ].join('\n');
    },
    parse(text) {
      const { extractJson } = require('../../ai/service');
      let data = null;
      try {
        data = extractJson(text);
      } catch {
        data = null;
      }
      return { items: normalizeItems(Array.isArray(data) ? data : data && data.items) };
    },
  },
];

module.exports = { register, aiFeatures, runDetail, PHASES, OWNER_ROLES, RUN_SQL, runView };
