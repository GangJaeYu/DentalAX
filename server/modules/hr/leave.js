/*
 * 이 파일이 하는 일: [연차·휴가] 서버 기능입니다. (신청·승인·반려·취소, 일수 자동 계산, 연차 부여/사용/잔여)
 *
 *   - 직원은 본인 휴가만 신청할 수 있고, 실장 이상은 다른 직원 대신 신청하거나 바로 승인할 수 있습니다.
 *   - 휴가 일수는 서버가 계산합니다: 정기 휴진 요일·공휴일은 빼고, 반차는 0.5일. (lib.js countLeaveDays)
 *   - 연차에서 빼는 종류는 "연차·오전 반차·오후 반차"뿐입니다. 병가·경조사·공가·기타는 연차에서 빼지 않습니다.
 *   - 연차 부여 일수는 입사일 기준 근로기준법 일반 규칙으로 자동 계산하고, 실장 이상이 기간별로 직접 고칠 수 있습니다.
 *   - 개인정보: 사유는 선택 입력(최대 60자). 다른 직원에게는 사유를 보여 주지 않습니다(본인과 실장 이상만).
 *
 * API (/api/hr/leave/...)
 *   GET  /balances                  연차 현황 (실장 이상: 전 직원 / 직원: 본인)
 *   PUT  /grants                    부여 일수 직접 수정 (실장 이상)    DELETE /grants/:userId/:year  자동 계산으로 되돌리기
 *   GET  /preview                   신청 전 미리 계산 (일수, 겹치는 사람, 잔여)
 *   GET  /requests                  신청 목록 (status, userId, year)
 *   POST /requests                  신청
 *   POST /requests/:id/decide       승인/반려 (실장 이상)
 *   POST /requests/:id/cancel       취소 (본인: 대기 중일 때 / 실장 이상: 대기·승인 모두)
 *   GET  /calendar?month=2026-10    이번 달 팀 휴가 (승인·대기)
 */
const { all, get, run } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, forbidden, badRequest, HttpError } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { requireRole, hasRole } = require('../../core/auth');
const time = require('../../core/time');
const lib = require('./lib');

const BASIS_NOTE =
  '입사일 기준 1년 단위로 계산합니다. 1년 미만은 1개월 개근마다 1일(최대 11일), 1년 이상은 15일에 3년 이상 근속부터 2년마다 1일씩 더합니다(최대 25일).';

/** 직원 한 명의 연차 현황 (기준일 = 오늘) */
function balanceFor(u, refDate = time.today()) {
  let period = lib.leavePeriod(u.hireDate, refDate);
  let basis = 'hire';
  if (!period) {
    // 입사일이 없으면 달력 기준(1월~12월)으로 사용량만 세고, 부여 일수는 직접 입력해야 합니다.
    const y = Number(refDate.slice(0, 4));
    period = { n: null, start: `${y}-01-01`, end: `${y}-12-31`, year: y };
    basis = 'calendar';
  }
  const computed = basis === 'hire' ? lib.computedGrant(u.hireDate, refDate) : null;
  const override = get('SELECT days, note, updated_at FROM leave_grants WHERE user_id = ? AND year = ?', u.id, period.year);
  const sum = (status) =>
    get(
      `SELECT COALESCE(SUM(days), 0) AS n FROM leave_requests
       WHERE user_id = ? AND status = ? AND type IN ('연차','오전 반차','오후 반차') AND start_date BETWEEN ? AND ?`,
      u.id,
      status,
      period.start,
      period.end
    ).n;
  const used = sum('approved');
  const pending = sum('pending');
  const granted = override ? override.days : computed;
  let service = null;
  if (u.hireDate && refDate >= u.hireDate) {
    const m = lib.fullMonths(u.hireDate, refDate, 1200);
    service = { years: Math.floor(m / 12), months: m % 12, label: m >= 12 ? `${Math.floor(m / 12)}년${m % 12 ? ` ${m % 12}개월` : ''}` : `${m}개월` };
  }
  return {
    userId: u.id,
    name: u.name,
    jobTitle: u.jobTitle,
    color: u.color,
    hireDate: u.hireDate,
    basis,
    service,
    period: { start: period.start, end: period.end, year: period.year, firstYear: period.n === 0 },
    computed,
    override: override ? { days: override.days, note: override.note, updatedAt: override.updated_at } : null,
    granted,
    used,
    pending,
    remaining: granted === null || granted === undefined ? null : Math.round((granted - used) * 10) / 10,
  };
}

const REQ_SQL = `
  SELECT l.*, u.name AS user_name, u.color AS user_color, u.job_title AS user_job,
    rb.name AS requested_by_name, db.name AS decided_by_name
  FROM leave_requests l
  JOIN users u ON u.id = l.user_id
  LEFT JOIN users rb ON rb.id = l.requested_by
  LEFT JOIN users db ON db.id = l.decided_by`;

/** 화면으로 보낼 모양. 사유·결정 메모는 본인과 실장 이상만 봅니다. */
function requestView(l, viewer) {
  const isManager = hasRole(viewer, 'manager');
  const mine = l.user_id === viewer.id;
  const canSee = isManager || mine;
  return {
    id: l.id,
    userId: l.user_id,
    userName: l.user_name,
    userColor: l.user_color,
    jobTitle: l.user_job,
    type: l.type,
    half: lib.HALF_TYPES.includes(l.type),
    deducts: lib.DEDUCT_TYPES.includes(l.type),
    startDate: l.start_date,
    endDate: l.end_date,
    days: l.days,
    reason: canSee ? l.reason : null,
    status: l.status,
    statusLabel: lib.LEAVE_STATUS_LABEL[l.status],
    requestedByName: l.requested_by && l.requested_by !== l.user_id ? l.requested_by_name : null,
    decidedByName: l.decided_by_name || null,
    decidedAt: l.decided_at,
    decisionNote: canSee ? l.decision_note : null,
    createdAt: l.created_at,
    mine,
    canCancel: (l.status === 'pending' && (mine || l.requested_by === viewer.id || isManager)) || (l.status === 'approved' && isManager),
    canDecide: l.status === 'pending' && isManager,
  };
}

const requestSchema = v.object({
  userId: v.id({ optional: true, label: '직원' }),
  type: v.enum(lib.LEAVE_TYPES, { label: '종류' }),
  startDate: v.date({ label: '시작일' }),
  endDate: v.date({ optional: true, label: '끝나는 날' }),
  reason: v.string({ max: 60, optional: true, label: '사유' }),
  approve: v.bool(),
});

/** 신청 내용 확인 + 일수 계산. 잘못되면 400 */
function evaluate(d, viewer) {
  const userId = d.userId || viewer.id;
  if (userId !== viewer.id && !hasRole(viewer, 'manager')) throw forbidden();
  const user = lib.activeUser(userId);
  if (!user) throw badRequest('재직 중인 직원이 아닙니다.', { field: 'userId' });
  const half = lib.HALF_TYPES.includes(d.type);
  const endDate = half ? d.startDate : d.endDate || d.startDate;
  if (endDate < d.startDate) throw badRequest('끝나는 날이 시작일보다 빠릅니다.', { field: 'endDate' });
  if (time.diffDays(d.startDate, endDate) > 90) throw badRequest('한 번에 90일까지만 신청할 수 있습니다. 나눠서 신청해 주세요.', { field: 'endDate' });
  const c = lib.countLeaveDays(d.type, d.startDate, endDate);
  return { user, userId, endDate, half, ...c };
}

/** 같은 사람이 같은 날 이미 신청한 휴가가 있는지 (오전 반차 + 오후 반차 조합은 허용) */
function ownConflict(userId, type, start, end, excludeId) {
  const rows = all(
    `SELECT id, type, start_date, end_date FROM leave_requests
     WHERE user_id = ? AND status IN ('approved','pending') AND start_date <= ? AND end_date >= ? AND id != ?`,
    userId,
    end,
    start,
    excludeId || 0
  );
  return rows.find((r) => !(lib.HALF_TYPES.includes(type) && lib.HALF_TYPES.includes(r.type) && r.type !== type));
}

function register(r) {
  const managerUp = requireRole('manager');

  r.get('/leave/balances', (req, res) => {
    const staff = hasRole(req.user, 'manager') ? lib.activeStaff() : lib.activeStaff().filter((s) => s.id === req.user.id);
    res.json({ today: time.today(), basisNote: BASIS_NOTE, rows: staff.map((u) => balanceFor(u)) });
  });

  r.put('/leave/grants', managerUp, (req, res) => {
    const d = v
      .object({
        userId: v.id({ label: '직원' }),
        year: v.int({ min: 2000, max: 2100, label: '기간' }),
        days: v.number({ min: 0, max: 60, label: '부여 일수' }),
        note: v.string({ max: 100, optional: true, label: '메모' }),
      })
      .parse(req.body);
    const u = lib.activeUser(d.userId);
    if (!u) throw notFound('직원');
    if (Math.round(d.days * 2) !== d.days * 2) throw badRequest('부여 일수는 0.5일 단위로 입력해 주세요.', { field: 'days' });
    run(
      `INSERT INTO leave_grants (user_id, year, days, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, year) DO UPDATE SET days = excluded.days, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      d.userId,
      d.year,
      d.days,
      d.note,
      req.user.id,
      time.nowIso()
    );
    audit(req, 'update', 'leave_grants', d.userId, `연차 부여 일수 직접 수정: ${u.name} ${d.year}년 기간 ${d.days}일`);
    res.json(balanceFor(u));
  });

  r.delete('/leave/grants/:userId/:year', managerUp, (req, res) => {
    const userId = idParam(req.params.userId);
    const year = idParam(req.params.year);
    const u = lib.activeUser(userId);
    if (!u) throw notFound('직원');
    run('DELETE FROM leave_grants WHERE user_id = ? AND year = ?', userId, year);
    audit(req, 'update', 'leave_grants', userId, `연차 부여 일수 자동 계산으로 되돌림: ${u.name}`);
    res.json(balanceFor(u));
  });

  // 신청 창에서 날짜를 고를 때마다 불러서 "며칠인지, 누가 같은 날 쉬는지"를 미리 보여 줍니다.
  r.get('/leave/preview', (req, res) => {
    const q = req.query;
    const d = requestSchema.parse({ userId: q.userId ? Number(q.userId) : undefined, type: q.type, startDate: q.startDate, endDate: q.endDate || undefined });
    const e = evaluate(d, req.user);
    const deductible = lib.DEDUCT_TYPES.includes(d.type);
    const bal = balanceFor(e.user);
    const overlaps = lib.overlappingLeaves(d.startDate, e.endDate, { excludeUserId: e.userId, excludeId: Number(q.excludeId) || null });
    const conflict = ownConflict(e.userId, d.type, d.startDate, e.endDate, Number(q.excludeId) || 0);
    res.json({
      days: e.days,
      endDate: e.endDate,
      deductible,
      skipped: e.skipped,
      overlaps,
      conflict: conflict ? { type: conflict.type, startDate: conflict.start_date, endDate: conflict.end_date } : null,
      balance: { granted: bal.granted, used: bal.used, pending: bal.pending, remaining: bal.remaining, after: deductible && bal.remaining !== null ? Math.round((bal.remaining - bal.pending - e.days) * 10) / 10 : null },
    });
  });

  r.get('/leave/requests', (req, res) => {
    const q = req.query;
    const isManager = hasRole(req.user, 'manager');
    const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(q.status) ? q.status : null;
    // 직원은 본인 것만 봅니다.
    const userId = isManager ? (q.userId ? Number(q.userId) || null : null) : req.user.id;
    const year = /^\d{4}$/.test(String(q.year || '')) ? String(q.year) : null;
    const rows = all(
      `${REQ_SQL}
       WHERE (:status IS NULL OR l.status = :status) AND (:userId IS NULL OR l.user_id = :userId)
         AND (:year IS NULL OR substr(l.start_date, 1, 4) = :year OR substr(l.end_date, 1, 4) = :year)
       ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.start_date DESC, l.id DESC LIMIT 500`,
      { status, userId, year }
    );
    const pendingCount = isManager
      ? get("SELECT COUNT(*) AS n FROM leave_requests WHERE status = 'pending'").n
      : get("SELECT COUNT(*) AS n FROM leave_requests WHERE status = 'pending' AND user_id = ?", req.user.id).n;
    const out = rows.map((l) => requestView(l, req.user));
    // 승인 대기 건에는 "같은 날 쉬는 사람"을 붙여 줍니다 (승인 판단에 도움)
    for (const o of out) {
      if (o.status === 'pending' && isManager) o.overlaps = lib.overlappingLeaves(o.startDate, o.endDate, { excludeUserId: o.userId, excludeId: o.id });
    }
    res.json({ rows: out, pendingCount, types: lib.LEAVE_TYPES });
  });

  r.post('/leave/requests', (req, res) => {
    const d = requestSchema.parse(req.body);
    const e = evaluate(d, req.user);
    if (e.days <= 0) throw badRequest('선택한 날짜가 모두 휴진일 또는 공휴일입니다. 날짜를 다시 확인해 주세요.', { field: 'startDate' });
    const conflict = ownConflict(e.userId, d.type, d.startDate, e.endDate);
    if (conflict) throw new HttpError(409, `이미 ${conflict.start_date}${conflict.end_date !== conflict.start_date ? ` ~ ${conflict.end_date}` : ''}에 신청한 휴가(${conflict.type})가 있습니다.`);
    const approve = d.approve && hasRole(req.user, 'manager');
    const now = time.nowIso();
    const info = run(
      `INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status, requested_by, decided_by, decided_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.userId,
      d.type,
      d.startDate,
      e.endDate,
      e.days,
      d.reason,
      approve ? 'approved' : 'pending',
      req.user.id,
      approve ? req.user.id : null,
      approve ? now : null,
      now,
      now
    );
    const id = info.lastInsertRowid;
    audit(req, 'create', 'leave_requests', id, `휴가 신청: ${e.user.name} ${d.type} ${d.startDate}${e.endDate !== d.startDate ? `~${e.endDate}` : ''} (${e.days}일)${approve ? ' · 바로 승인' : ''}`);
    const overlaps = lib.overlappingLeaves(d.startDate, e.endDate, { excludeUserId: e.userId, excludeId: id });
    res.status(201).json({ ...requestView(get(`${REQ_SQL} WHERE l.id = ?`, id), req.user), overlaps });
  });

  r.post('/leave/requests/:id/decide', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const l = get(`${REQ_SQL} WHERE l.id = ?`, id);
    if (!l) throw notFound('휴가 신청');
    const d = v
      .object({ decision: v.enum(['approved', 'rejected'], { label: '결정' }), note: v.string({ max: 100, optional: true, label: '메모' }) })
      .parse(req.body);
    if (l.status !== 'pending') throw badRequest(`이미 ${lib.LEAVE_STATUS_LABEL[l.status]}된 신청입니다.`);
    run('UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?', d.decision, req.user.id, time.nowIso(), d.note, time.nowIso(), id);
    audit(req, d.decision === 'approved' ? 'approve' : 'reject', 'leave_requests', id, `휴가 ${d.decision === 'approved' ? '승인' : '반려'}: ${l.user_name} ${l.type} ${l.start_date}`);
    res.json(requestView(get(`${REQ_SQL} WHERE l.id = ?`, id), req.user));
  });

  r.post('/leave/requests/:id/cancel', (req, res) => {
    const id = idParam(req.params.id);
    const l = get(`${REQ_SQL} WHERE l.id = ?`, id);
    if (!l) throw notFound('휴가 신청');
    const view = requestView(l, req.user);
    if (!view.canCancel) {
      if (l.status === 'approved' || l.status === 'pending') throw forbidden();
      throw badRequest(`이미 ${lib.LEAVE_STATUS_LABEL[l.status]}된 신청입니다.`);
    }
    run("UPDATE leave_requests SET status = 'cancelled', updated_at = ? WHERE id = ?", time.nowIso(), id);
    audit(req, 'cancel', 'leave_requests', id, `휴가 취소: ${l.user_name} ${l.type} ${l.start_date}`);
    res.json(requestView(get(`${REQ_SQL} WHERE l.id = ?`, id), req.user));
  });

  r.get('/leave/calendar', (req, res) => {
    const month = lib.monthParam(req.query.month);
    const first = `${month}-01`;
    const last = `${month}-${String(time.daysInMonth(month)).padStart(2, '0')}`;
    const rows = all(`${REQ_SQL} WHERE l.status IN ('approved','pending') AND l.start_date <= ? AND l.end_date >= ? ORDER BY l.start_date, u.name`, last, first);
    res.json({
      month,
      today: time.today(),
      holidays: lib.holidayMap(first, last),
      closedWeekdays: lib.closedWeekdays(),
      rows: rows.map((l) => requestView(l, req.user)),
    });
  });
}

module.exports = { register, balanceFor, BASIS_NOTE };
