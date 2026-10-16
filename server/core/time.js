/*
 * 이 파일이 하는 일: 날짜 계산 도우미 모음입니다.
 * 날짜는 모두 원내 PC 시간(한국 시간) 기준 'YYYY-MM-DD' 글자로 다룹니다.
 * (시간대 때문에 하루가 밀리는 문제를 피하려고 Date 객체 대신 글자 계산을 주로 씁니다.)
 */

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Date 객체 → 'YYYY-MM-DD' (PC 현지 시간 기준) */
function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 오늘 날짜 'YYYY-MM-DD'. 테스트에서 날짜를 고정하고 싶으면 DENTALAX_TODAY 환경 변수 사용 */
function today() {
  if (process.env.DENTALAX_TODAY) return process.env.DENTALAX_TODAY;
  return toDateStr(new Date());
}

/** 지금 시각 (ISO 문자열, 기록용) */
function nowIso() {
  return new Date().toISOString();
}

/** 'YYYY-MM-DD' → Date (현지 시간 자정) */
function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseDate(s);
  return toDateStr(d) === s;
}

function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** 개월 더하기. 1월 31일 + 1개월 = 2월 말일 처럼 말일을 넘지 않게 맞춥니다. */
function addMonths(s, n) {
  const d = parseDate(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toDateStr(d);
}

/** b - a 의 날짜 차이(일). a가 오늘이고 b가 마감일이면 '남은 일수' */
function diffDays(a, b) {
  const ms = parseDate(b) - parseDate(a);
  return Math.round(ms / 86400000);
}

/** 'YYYY-MM' (이번 달) */
function thisMonth() {
  return today().slice(0, 7);
}

/** 해당 월의 일수 */
function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** 'YYYY-MM' 에 n개월 더하기 */
function addMonthsYm(ym, n) {
  return addMonths(`${ym}-01`, n).slice(0, 7);
}

/** 요일 (0=일 ~ 6=토) */
function weekday(s) {
  return parseDate(s).getDay();
}

module.exports = {
  pad,
  toDateStr,
  today,
  nowIso,
  parseDate,
  isValidDate,
  addDays,
  addMonths,
  diffDays,
  thisMonth,
  daysInMonth,
  addMonthsYm,
  weekday,
};
