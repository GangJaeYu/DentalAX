/*
 * 이 파일이 하는 일: 병원 정보, AI 설정, 백업 설정 같은 "설정값"을 DB의 settings 표에 저장하고 꺼내 줍니다.
 * 값은 JSON 형태로 저장하므로 숫자·글자·목록·묶음을 모두 그대로 넣을 수 있습니다.
 */
const { get, run } = require('./db');

/** 처음 설치했을 때의 기본 설정값. AI 관련 기본값은 server/ai/defaults.js 에 따로 있습니다. */
const DEFAULTS = {
  clinic: {
    name: '',
    phone: '',
    address: '',
    hours: '평일 09:30 ~ 18:30 / 토요일 09:30 ~ 14:00 / 점심시간 13:00 ~ 14:00 / 일요일·공휴일 휴진',
    parking: '',
    directions: '',
    insuranceNote: '',
    extra: '',
    representative: '',
    email: '',
  },
  backup: {
    keep: 30, // 보관 개수
    hour: 12, // 이 시각 이후
    minute: 30, // 이 분 이후에 하루 한 번
  },
  security: {
    idleMinutes: 480, // 사용이 없으면 이 시간(분) 뒤 자동 로그아웃
    absoluteHours: 16, // 로그인 후 최대 유지 시간
  },
};

function getSetting(key) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  const def = DEFAULTS[key];
  if (!row) return def !== undefined ? structuredClone(def) : null;
  let val;
  try {
    val = JSON.parse(row.value);
  } catch {
    val = null;
  }
  // 기본값에 새 칸이 추가돼도 빠지지 않도록 합쳐서 돌려줌
  if (def && typeof def === 'object' && !Array.isArray(def) && val && typeof val === 'object') {
    return { ...structuredClone(def), ...val };
  }
  return val ?? (def !== undefined ? structuredClone(def) : null);
}

function setSetting(key, value) {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
    new Date().toISOString()
  );
}

/** 일부 칸만 바꾸기 */
function patchSetting(key, partial) {
  const cur = getSetting(key) || {};
  const next = { ...cur, ...partial };
  setSetting(key, next);
  return next;
}

module.exports = { getSetting, setSetting, patchSetting, DEFAULTS };
