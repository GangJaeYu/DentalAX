/*
 * 이 파일이 하는 일: [E3. 법정 일정] 방사선·소방·개인정보·감염관리 같은 정기 의무 일정을 관리하는 API 입니다.
 *
 *   - 일정마다 "주기(개월)"를 두고, [완료]를 누르면 완료 기록이 남고 다음 일정 = 완료일 + 주기 로 자동 계산합니다.
 *   - 주기를 확신할 수 없는 항목은 "주기 확인 필요"(needs_check)로 표시합니다. 법령·지자체 기준이 바뀔 수 있으므로
 *     모든 항목은 실장 이상이 고칠 수 있습니다. (법률 자문이 아님 — docs/DECISIONS.md D-12)
 *   - 주기가 없는 항목(수시·일회성)은 다음 일정을 직접 적습니다.
 *
 * API (/api/facility/compliance/...)
 *   GET    /tasks                   목록 (category, status=overdue|soon|check, q, archived=1) + 개수 요약
 *   GET    /tasks/:id               상세 + 완료 이력
 *   POST   /tasks                   추가 (실장 이상)
 *   PATCH  /tasks/:id               수정·보관 (실장 이상)
 *   DELETE /tasks/:id               삭제 (실장 이상)
 *   POST   /tasks/:id/complete      완료 처리 (누구나) → 기록 + 마지막 완료일 + 다음 일정
 *   DELETE /logs/:logId             완료 기록 취소 (실장 이상, 가장 최근 기록이면 이전 일정으로 되돌림)
 */
const { all, get, run, tx, where } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, badRequest } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { requireRole, hasRole } = require('../../core/auth');
const time = require('../../core/time');
const C = require('./common');

const taskSchema = v.object({
  name: v.string({ min: 1, max: 100, label: '일정 이름' }),
  category: v.enum(C.COMPLIANCE_CATEGORIES, { label: '분류' }),
  legalBasis: v.string({ max: 200, optional: true, label: '근거' }),
  cycleMonths: v.int({ min: 1, max: 120, optional: true, label: '주기(개월)' }),
  needsCheck: v.bool(),
  internal: v.bool(),
  lastDone: v.date({ optional: true, label: '마지막 완료일' }),
  nextDue: v.date({ optional: true, label: '다음 일정' }),
  ownerId: v.id({ optional: true, label: '담당자' }),
  notes: v.string({ max: 2000, optional: true, label: '메모' }),
});

const BASE_SQL = `
  SELECT t.*, u.name AS owner_name,
    (SELECT COUNT(*) FROM compliance_logs l WHERE l.task_id = t.id) AS log_count
  FROM compliance_tasks t LEFT JOIN users u ON u.id = t.owner_id`;

/** 주기를 사람이 읽는 말로: 36 → '3년마다', 6 → '6개월마다', 없음 → '수시·일회성' */
function cycleLabel(m) {
  if (!m) return '수시·일회성';
  if (m % 12 === 0) return `${m / 12}년마다`;
  if (m === 1) return '매월';
  return `${m}개월마다`;
}

/** 다음 일정 계산: 완료일 + 주기(개월). 주기가 없으면 계산하지 않음 */
function calcNextDue(doneDate, cycleMonths) {
  if (!doneDate || !cycleMonths) return null;
  return time.addMonths(doneDate, cycleMonths);
}

function toView(t) {
  const dday = t.next_due ? time.diffDays(time.today(), t.next_due) : null;
  let state = 'ok';
  if (dday !== null && dday < 0) state = 'overdue';
  else if (dday !== null && dday <= 30) state = 'soon';
  else if (dday === null) state = 'none';
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    legalBasis: t.legal_basis,
    cycleMonths: t.cycle_months,
    cycleLabel: cycleLabel(t.cycle_months),
    needsCheck: !!t.needs_check,
    internal: !!t.internal,
    lastDone: t.last_done,
    nextDue: t.next_due,
    dday,
    state,
    ownerId: t.owner_id,
    ownerName: t.owner_name || null,
    notes: t.notes,
    active: !!t.active,
    logCount: t.log_count ?? 0,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

function loadOne(id) {
  const t = get(`${BASE_SQL} WHERE t.id = ?`, id);
  if (!t) throw notFound('법정 일정');
  return t;
}

function checkOwner(id) {
  if (id && !get('SELECT id FROM users WHERE id = ?', id)) throw badRequest('담당자: 직원을 찾을 수 없습니다.', { field: 'ownerId' });
}

/** 정렬: 기한 지난 것 → 가까운 순 → 날짜 없는 것(맨 뒤) */
function byDue(a, b) {
  if (a.nextDue && b.nextDue) return a.nextDue.localeCompare(b.nextDue) || a.name.localeCompare(b.name, 'ko');
  if (a.nextDue) return -1;
  if (b.nextDue) return 1;
  return a.name.localeCompare(b.name, 'ko');
}

function register(r) {
  const managerUp = requireRole('manager');

  r.get('/compliance/tasks', (req, res) => {
    const q = req.query;
    const category = C.COMPLIANCE_CATEGORIES.includes(q.category) ? q.category : null;
    const w = where([
      [q.archived === '1' ? 't.active = 0' : 't.active = 1'],
      [q.q && '(t.name LIKE :q OR t.legal_basis LIKE :q OR t.notes LIKE :q)'],
    ]);
    const all_ = all(`${BASE_SQL} ${w.sql}`, { q: q.q ? `%${q.q}%` : null }).map(toView);
    const counts = {
      total: all_.length,
      overdue: all_.filter((t) => t.state === 'overdue').length,
      soon: all_.filter((t) => t.state === 'soon').length,
      needsCheck: all_.filter((t) => t.needsCheck).length,
      noDate: all_.filter((t) => t.state === 'none').length,
      byCategory: Object.fromEntries(C.COMPLIANCE_CATEGORIES.map((c) => [c, all_.filter((t) => t.category === c).length])),
    };
    let rows = category ? all_.filter((t) => t.category === category) : all_;
    if (q.status === 'overdue') rows = rows.filter((t) => t.state === 'overdue');
    else if (q.status === 'soon') rows = rows.filter((t) => t.state === 'overdue' || t.state === 'soon');
    else if (q.status === 'check') rows = rows.filter((t) => t.needsCheck);
    rows.sort(byDue);
    res.json({ rows, counts, canEdit: hasRole(req.user, 'manager') });
  });

  r.get('/compliance/tasks/:id', (req, res) => {
    const id = idParam(req.params.id);
    const t = loadOne(id);
    const logs = all(
      `SELECT l.*, u.name AS user_name FROM compliance_logs l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.task_id = ? ORDER BY l.done_date DESC, l.id DESC`,
      id
    );
    const latestId = logs.length ? logs[0].id : null;
    res.json({
      ...toView(t),
      logs: logs.map((l) => ({
        id: l.id,
        doneDate: l.done_date,
        note: l.note,
        userName: l.user_name || null,
        createdAt: l.created_at,
        latest: l.id === latestId,
      })),
      canEdit: hasRole(req.user, 'manager'),
    });
  });

  r.post('/compliance/tasks', managerUp, (req, res) => {
    const d = taskSchema.parse(req.body);
    checkOwner(d.ownerId);
    // 다음 일정을 비워 두면 마지막 완료일 + 주기로 자동 계산
    const nextDue = d.nextDue || calcNextDue(d.lastDone, d.cycleMonths);
    const now = time.nowIso();
    const info = run(
      `INSERT INTO compliance_tasks (name, category, legal_basis, cycle_months, needs_check, internal, last_done, next_due, owner_id, notes, active, created_at, updated_at)
       VALUES (:name, :category, :legalBasis, :cycleMonths, :needsCheck, :internal, :lastDone, :nextDue, :ownerId, :notes, 1, :now, :now)`,
      { ...d, nextDue, now }
    );
    audit(req, 'create', 'compliance_tasks', info.lastInsertRowid, `법정 일정 추가: ${d.name}`);
    res.status(201).json(toView(loadOne(info.lastInsertRowid)));
  });

  r.patch('/compliance/tasks/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const t = loadOne(id);
    const d = taskSchema.partial().parse(req.body);
    if ('ownerId' in d) checkOwner(d.ownerId);
    const cycle = 'cycleMonths' in d ? d.cycleMonths : t.cycle_months;
    const lastDone = 'lastDone' in d ? d.lastDone : t.last_done;
    // 다음 일정: 직접 적었으면 그 값, 주기나 마지막 완료일을 바꿨으면 다시 계산, 아니면 그대로
    //   (다음 일정 칸을 비워서 보내면 = "자동 계산"으로 보고, 계산할 수 없으면 비움)
    const changed = ('cycleMonths' in d && d.cycleMonths !== t.cycle_months) || ('lastDone' in d && d.lastDone !== t.last_done);
    let nextDue = t.next_due;
    if ('nextDue' in d && d.nextDue) nextDue = d.nextDue;
    else if ('nextDue' in d) nextDue = calcNextDue(lastDone, cycle);
    else if (changed) nextDue = calcNextDue(lastDone, cycle) || t.next_due;
    const active = req.body.active === undefined ? t.active : v.bool()(req.body.active) ? 1 : 0;
    run(
      `UPDATE compliance_tasks SET name = ?, category = ?, legal_basis = ?, cycle_months = ?, needs_check = ?, internal = ?, last_done = ?, next_due = ?,
         owner_id = ?, notes = ?, active = ?, updated_at = ? WHERE id = ?`,
      d.name ?? t.name,
      d.category ?? t.category,
      'legalBasis' in d ? d.legalBasis : t.legal_basis,
      cycle,
      'needsCheck' in d ? d.needsCheck : t.needs_check,
      'internal' in d ? d.internal : t.internal,
      lastDone,
      nextDue,
      'ownerId' in d ? d.ownerId : t.owner_id,
      'notes' in d ? d.notes : t.notes,
      active,
      time.nowIso(),
      id
    );
    const note = active !== t.active ? (active ? ' (보관 해제)' : ' (보관)') : '';
    audit(req, 'update', 'compliance_tasks', id, `법정 일정 수정: ${d.name ?? t.name}${note}`);
    res.json(toView(loadOne(id)));
  });

  r.delete('/compliance/tasks/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const t = loadOne(id);
    run('DELETE FROM compliance_tasks WHERE id = ?', id);
    audit(req, 'delete', 'compliance_tasks', id, `법정 일정 삭제: ${t.name}`);
    res.json({ ok: true });
  });

  r.post('/compliance/tasks/:id/complete', (req, res) => {
    const id = idParam(req.params.id);
    const t = loadOne(id);
    const d = v
      .object({
        doneDate: v.date({ label: '완료일' }),
        note: v.string({ max: 500, optional: true, label: '메모' }),
        nextDue: v.date({ optional: true, label: '다음 일정' }),
      })
      .parse(req.body);
    if (d.doneDate > time.today()) throw badRequest('완료일: 오늘 이후 날짜로는 완료 처리할 수 없습니다.', { field: 'doneDate' });
    // 주기가 있으면 자동 계산, 없으면(수시) 사용자가 적은 다음 일정 또는 비움
    const nextDue = calcNextDue(d.doneDate, t.cycle_months) || d.nextDue || null;
    // 이전 완료일보다 과거 날짜로 늦게 기록하는 경우엔 마지막 완료일·다음 일정을 되돌리지 않음
    const isLatest = !t.last_done || d.doneDate >= t.last_done;
    tx(() => {
      run(
        `INSERT INTO compliance_logs (task_id, done_date, note, user_id, prev_last_done, prev_next_due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        d.doneDate,
        d.note,
        req.user.id,
        t.last_done,
        t.next_due,
        time.nowIso()
      );
      if (isLatest) run('UPDATE compliance_tasks SET last_done = ?, next_due = ?, updated_at = ? WHERE id = ?', d.doneDate, nextDue, time.nowIso(), id);
    });
    audit(req, 'update', 'compliance_tasks', id, `법정 일정 완료: ${t.name} (${d.doneDate})`);
    res.json(toView(loadOne(id)));
  });

  r.delete('/compliance/logs/:logId', managerUp, (req, res) => {
    const logId = idParam(req.params.logId);
    const l = get('SELECT * FROM compliance_logs WHERE id = ?', logId);
    if (!l) throw notFound('완료 기록');
    const t = loadOne(l.task_id);
    tx(() => {
      run('DELETE FROM compliance_logs WHERE id = ?', logId);
      // 지운 기록이 지금 "마지막 완료일"의 근거였다면, 완료 처리 전의 값으로 되돌림
      if (t.last_done === l.done_date) {
        const other = get('SELECT done_date FROM compliance_logs WHERE task_id = ? ORDER BY done_date DESC, id DESC LIMIT 1', t.id);
        if (other && other.done_date === l.done_date) return; // 같은 날 다른 기록이 남아 있으면 그대로
        run('UPDATE compliance_tasks SET last_done = ?, next_due = ?, updated_at = ? WHERE id = ?', l.prev_last_done, l.prev_next_due, time.nowIso(), t.id);
      }
    });
    audit(req, 'delete', 'compliance_logs', logId, `법정 일정 완료 취소: ${t.name} (${l.done_date})`);
    res.json(toView(loadOne(t.id)));
  });
}

/** 대시보드용: 30일 안이거나 지난 일정 */
function dueSoon() {
  return all(`${BASE_SQL} WHERE t.active = 1 AND t.next_due IS NOT NULL AND t.next_due <= ?`, time.addDays(time.today(), 30)).map(toView);
}

module.exports = { register, dueSoon, calcNextDue, cycleLabel };
