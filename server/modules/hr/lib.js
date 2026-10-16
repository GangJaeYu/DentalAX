/*
 * 이 파일이 하는 일: [D. 인사·근무] 모듈 안에서 여러 기능(근무표·연차·교육·온보딩)이 함께 쓰는 계산 도우미입니다.
 *
 *   - 직원 목록(활성 직원)            : activeStaff()
 *   - 휴진 요일·공휴일 확인            : closedWeekdays(), holidayMap(), isClinicOpen()
 *   - 연차·휴가 일수 계산              : countLeaveDays()  (휴진 요일·공휴일 제외, 반차 = 0.5일)
 *   - 연차 부여 일수(근로기준법 일반 규칙): leavePeriod(), computedGrant()
 *
 * 연차 계산 기준 (docs/DECISIONS.md D-13)
 *   "입사일 기준"으로 계산합니다. 연차 기간은 입사일부터 1년 단위입니다.
 *     예) 입사일 2023-03-02 → 2026-03-02 ~ 2027-03-01 이 한 기간
 *   - 입사 1년 미만: 1개월 개근할 때마다 1일 (최대 11일). 이 앱은 "개근"으로 가정하고 지난 개월 수만큼 줍니다.
 *   - 입사 1년 이상: 15일 + 3년 이상 근속부터 2년마다 1일 추가 (최대 25일)
 *       근속 1~2년 15일, 3~4년 16일, 5~6년 17일 … 21년 이상 25일
 *   - 병원마다 회계연도 기준 등으로 다르게 운영할 수 있어, 실장 이상이 기간별 부여 일수를 직접 고칠 수 있습니다(leave_grants).
 *   - 5인 미만 사업장은 연차 규정이 적용되지 않는 등 예외가 있습니다. 화면에 "노무사 확인" 안내를 둡니다. (법률 자문 아님)
 */
const { all, get } = require('../../core/db');
const { getSetting } = require('../../core/settings');
const time = require('../../core/time');
const { v } = require('../../core/validate');

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

const LEAVE_TYPES = ['연차', '오전 반차', '오후 반차', '병가', '경조사', '공가', '기타'];
/** 반나절(0.5일)로 세는 종류 */
const HALF_TYPES = ['오전 반차', '오후 반차'];
/** 연차에서 빼는 종류 (병가·경조사·공가·기타는 연차에서 빼지 않음) */
const DEDUCT_TYPES = ['연차', '오전 반차', '오후 반차'];

const LEAVE_STATUS_LABEL = { pending: '승인 대기', approved: '승인', rejected: '반려', cancelled: '취소' };

/** 근무표·연차·교육에 나오는 직원 = 지금 재직 중(active)인 모든 사용자 (원장 → 실장 → 직원 순) */
function activeStaff() {
  return all(
    `SELECT id, name, role, job_title AS jobTitle, hire_date AS hireDate, color FROM users
     WHERE status = 'active'
     ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, id`
  );
}

function activeUser(id) {
  return get("SELECT id, name, role, job_title AS jobTitle, hire_date AS hireDate, color FROM users WHERE id = ? AND status = 'active'", id);
}

/** 병원 정기 휴진 요일 (0=일 ~ 6=토). 기본값은 일요일 */
function closedWeekdays() {
  const s = getSetting('hr');
  if (s && Array.isArray(s.closedWeekdays)) return s.closedWeekdays.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return [0];
}

/** 기간 안의 공휴일 { 'YYYY-MM-DD': '이름' } */
function holidayMap(from, to) {
  const out = {};
  for (const h of all('SELECT date, name FROM holidays WHERE date BETWEEN ? AND ? ORDER BY date', from, to)) out[h.date] = h.name;
  return out;
}

/** 진료하는 날인지 (휴진 요일도 아니고 공휴일도 아님) */
function isClinicOpen(date, closed, holidays) {
  return !closed.includes(time.weekday(date)) && !holidays[date];
}

/** from ~ to 날짜 목록 (양 끝 포함, 최대 400일) */
function dateRange(from, to) {
  const out = [];
  let d = from;
  while (d <= to && out.length < 400) {
    out.push(d);
    d = time.addDays(d, 1);
  }
  return out;
}

/**
 * 휴가 일수 계산
 *  - 휴진 요일과 공휴일은 빼고 셉니다. (그날은 원래 쉬는 날이므로)
 *  - 반차는 하루짜리만 가능하고 0.5일입니다.
 * @returns {{ days:number, dates:string[], skipped:string[] }}
 */
function countLeaveDays(type, startDate, endDate) {
  const end = HALF_TYPES.includes(type) ? startDate : endDate || startDate;
  const closed = closedWeekdays();
  const hol = holidayMap(startDate, end);
  const dates = [];
  const skipped = [];
  for (const d of dateRange(startDate, end)) (isClinicOpen(d, closed, hol) ? dates : skipped).push(d);
  const days = HALF_TYPES.includes(type) ? (dates.length ? 0.5 : 0) : dates.length;
  return { days, dates, skipped, endDate: end };
}

/**
 * 연차 기간(입사일 기준 1년 단위) 구하기
 * @param {string} hireDate 입사일
 * @param {string} refDate 기준일(보통 오늘)
 * @returns {{ n:number, start:string, end:string, year:number } | null}
 *   n = 기준일까지 다 채운 근속 연수, year = 기간이 시작한 해(부여 일수 수정 기록의 열쇠로 씀)
 */
function leavePeriod(hireDate, refDate) {
  if (!hireDate || !time.isValidDate(hireDate)) return null;
  let n = 0;
  if (refDate > hireDate) {
    while (n < 80 && time.addMonths(hireDate, 12 * (n + 1)) <= refDate) n++;
  }
  const start = time.addMonths(hireDate, 12 * n);
  const end = time.addDays(time.addMonths(hireDate, 12 * (n + 1)), -1);
  return { n, start, end, year: Number(start.slice(0, 4)) };
}

/** 입사 후 다 채운 개월 수 (기준일까지, 최대 limit) */
function fullMonths(hireDate, refDate, limit = 11) {
  let m = 0;
  while (m < limit && time.addMonths(hireDate, m + 1) <= refDate) m++;
  return m;
}

/**
 * 근로기준법 일반 규칙에 따른 연차 일수 (자동 계산값)
 *  - 1년 미만: 지난 개월 수 × 1일 (최대 11일)
 *  - 1년 이상: 15일 + (근속연수-1)/2 (소수점 버림), 최대 25일
 */
function computedGrant(hireDate, refDate) {
  const p = leavePeriod(hireDate, refDate);
  if (!p) return null;
  if (p.n === 0) return refDate < hireDate ? 0 : fullMonths(hireDate, refDate, 11);
  return Math.min(25, 15 + Math.floor((p.n - 1) / 2));
}

/** 주소의 ?month=YYYY-MM 확인 (없으면 이번 달, 형식이 틀리면 400) */
function monthParam(val) {
  if (!val) return time.thisMonth();
  return v.object({ month: v.month({ label: '월' }) }).parse({ month: val }).month;
}

/** 기간 [from,to]와 겹치는 다른 사람의 휴가 (승인·대기) */
function overlappingLeaves(from, to, { excludeUserId, excludeId } = {}) {
  return all(
    `SELECT l.id, l.user_id AS userId, u.name, l.type, l.start_date AS startDate, l.end_date AS endDate, l.status
     FROM leave_requests l JOIN users u ON u.id = l.user_id
     WHERE l.status IN ('approved','pending') AND l.start_date <= ? AND l.end_date >= ?
       AND (? IS NULL OR l.user_id != ?) AND (? IS NULL OR l.id != ?)
     ORDER BY l.start_date, u.name`,
    to,
    from,
    excludeUserId ?? null,
    excludeUserId ?? null,
    excludeId ?? null,
    excludeId ?? null
  );
}

module.exports = {
  WEEK,
  LEAVE_TYPES,
  HALF_TYPES,
  DEDUCT_TYPES,
  LEAVE_STATUS_LABEL,
  activeStaff,
  activeUser,
  closedWeekdays,
  holidayMap,
  isClinicOpen,
  dateRange,
  countLeaveDays,
  leavePeriod,
  fullMonths,
  computedGrant,
  overlappingLeaves,
  monthParam,
};
