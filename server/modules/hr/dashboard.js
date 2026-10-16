/*
 * 이 파일이 하는 일: [D. 인사·근무] 모듈이 첫 화면(대시보드)에 보태는 요약을 만듭니다.
 *
 *   today    : 오늘 근무자(근무표) / 휴무·휴가자(승인된 휴가 + 휴무 칸)
 *   todos    : (실장 이상) 승인 대기 연차·휴가 N건, 신규 직원 온보딩 진행 상황
 *              (모두) 내 온보딩에 남은 항목
 *   upcoming : 교육 이수 기한이 30일 이내이거나 이미 지난 것 (실장 이상: 전 직원 / 직원: 본인)
 * 쿼리 몇 개로 가볍게 계산합니다.
 */
const { all, get } = require('../../core/db');
const { hasRole } = require('../../core/auth');
const time = require('../../core/time');
const lib = require('./lib');
const { buildMatrix } = require('./training');
const { RUN_SQL, runView } = require('./onboarding');

/** 오늘 근무자·휴무자 */
function todayStaff(today) {
  const entries = all(
    `SELECT e.user_id, u.name, u.color, s.code, s.name AS shift_name, s.is_off, s.start_time, s.end_time, s.sort
     FROM schedule_entries e JOIN users u ON u.id = e.user_id JOIN shift_types s ON s.id = e.shift_type_id
     WHERE e.date = ? AND u.status = 'active'
     ORDER BY s.sort, CASE u.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, u.id`,
    today
  );
  const leaves = all(
    `SELECT l.user_id, u.name, l.type FROM leave_requests l JOIN users u ON u.id = l.user_id
     WHERE l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ? AND u.status = 'active' ORDER BY u.id`,
    today,
    today
  );
  const leaveBy = {};
  for (const l of leaves) leaveBy[l.user_id] = l;
  const working = [];
  const off = [];
  const seen = new Set();
  for (const e of entries) {
    seen.add(e.user_id);
    const l = leaveBy[e.user_id];
    if (l && !lib.HALF_TYPES.includes(l.type)) continue; // 하루 휴가는 아래 off 에서 처리
    if (e.is_off) {
      off.push({ name: e.name, reason: '휴무' });
      continue;
    }
    // 대시보드 배지가 짧게 보이도록 근무 이름만 (예: 종일, 야간, 종일 · 오후 반차)
    working.push({ name: e.name, shift: l ? `${e.code} · ${l.type}` : e.code, color: e.color });
  }
  for (const l of leaves) {
    if (lib.HALF_TYPES.includes(l.type) && seen.has(l.user_id)) continue;
    // 사유는 보여 주지 않고 휴가 종류만 (개인정보 최소화)
    off.push({ name: l.name, reason: l.type });
  }
  return { working, off };
}

function dashboard(user) {
  const today = time.today();
  const isManager = hasRole(user, 'manager');
  const todos = [];
  const upcoming = [];

  // 승인 대기 휴가
  if (isManager) {
    const pending = all(
      `SELECT u.name, l.type, l.start_date FROM leave_requests l JOIN users u ON u.id = l.user_id
       WHERE l.status = 'pending' ORDER BY l.start_date LIMIT 20`
    );
    if (pending.length) {
      const n = get("SELECT COUNT(*) AS n FROM leave_requests WHERE status = 'pending'").n;
      todos.push({
        id: 'hr-leave-pending',
        module: 'hr',
        title: `승인 대기 연차·휴가 ${n}건`,
        detail: pending
          .slice(0, 3)
          .map((p) => `${p.name} ${p.type} ${Number(p.start_date.slice(5, 7))}/${Number(p.start_date.slice(8))}`)
          .join(', ') + (n > 3 ? ` 외 ${n - 3}건` : ''),
        href: '#/leave?tab=pending',
        level: 'warn',
        icon: 'calendar-check',
      });
    }
  }

  // 온보딩: 내 것 + (실장 이상) 진행 중인 신규 직원
  const runs = all(`${RUN_SQL} WHERE r.status = 'active' ORDER BY r.start_date`).map((r) => runView(r, user));
  for (const r of runs) {
    const left = r.total - r.done;
    if (r.userId === user.id && left > 0) {
      todos.push({ id: `hr-onboarding-${r.id}`, module: 'hr', title: `내 온보딩: 남은 항목 ${left}개`, detail: `${r.templateName} · 입사 ${r.dayN}일째`, href: `#/onboarding/run/${r.id}`, level: 'info', icon: 'user-plus', progress: { done: r.done, total: r.total } });
    } else if (isManager && left > 0) {
      todos.push({ id: `hr-onboarding-${r.id}`, module: 'hr', title: `${r.userName} 님 온보딩 진행 중`, detail: `${r.templateName} · ${r.dayN}일째 · 남은 항목 ${left}개`, href: `#/onboarding/run/${r.id}`, level: 'info', icon: 'user-plus', progress: { done: r.done, total: r.total } });
    }
  }

  // 교육 이수 기한
  const m = buildMatrix(isManager ? {} : { userId: user.id });
  const tById = Object.fromEntries(m.trainings.map((t) => [t.id, t]));
  const items = [];
  for (const s of m.staff) {
    for (const [tid, c] of Object.entries(m.cells[s.id] || {})) {
      if (!c.required || !(c.status === 'soon' || c.status === 'expired')) continue;
      const t = tById[tid];
      items.push({
        id: `hr-training-${s.id}-${tid}`,
        module: 'hr',
        title: isManager ? `${s.name} · ${t.name}` : `${t.name} 다시 받기`,
        date: c.nextDue,
        dday: c.dday,
        detail: c.status === 'expired' ? '교육 이수 기한 지남' : '교육 이수 기한 임박',
        href: '#/training',
        icon: 'graduation-cap',
      });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date));
  upcoming.push(...items.slice(0, 8));

  return { today: todayStaff(today), todos, upcoming };
}

module.exports = { dashboard, todayStaff };
