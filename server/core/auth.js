/*
 * 이 파일이 하는 일: 로그인과 권한을 담당합니다.
 *
 *  - 비밀번호는 원래 글자를 저장하지 않고 "scrypt 해시"(되돌릴 수 없는 변환 값)만 저장합니다.
 *  - 로그인하면 무작위 "세션 토큰"을 쿠키로 주고, DB에는 토큰의 해시만 저장합니다.
 *    (DB가 유출돼도 토큰을 알 수 없어 다른 사람이 로그인 상태를 훔칠 수 없음)
 *  - 일정 시간 사용이 없으면 자동 로그아웃됩니다(기본 8시간, 최대 16시간).
 *  - 역할: admin(원장·관리자) > manager(실장) > staff(직원). 위 역할은 아래 역할의 권한을 모두 가집니다.
 */
const crypto = require('node:crypto');
const { get, run, all } = require('./db');
const { getSetting } = require('./settings');
const { HttpError } = require('./errors');

const ROLE_LEVEL = { staff: 1, manager: 2, admin: 3 };
const ROLE_LABEL = { admin: '원장·관리자', manager: '실장', staff: '직원' };
const COOKIE = 'dx_session';

// ---------- 비밀번호 ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  // 글자를 하나씩 비교하면 걸린 시간으로 추측이 가능해서, 항상 같은 시간이 걸리는 비교를 씀
  return crypto.timingSafeEqual(expected, actual);
}

/** 비밀번호 규칙: 8자 이상, 영문·숫자·기호 중 2종류 이상 */
function checkPasswordRule(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (pw.length > 128) return '비밀번호가 너무 깁니다.';
  const kinds = [/[a-zA-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length;
  if (kinds < 2) return '영문, 숫자, 기호 중 2가지 이상을 섞어 주세요.';
  return null;
}

// ---------- 세션 ----------
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(val);
    } catch {
      out[k] = val;
    }
  }
  return out;
}

function sessionLimits() {
  const s = getSetting('security');
  return { idleMs: (s.idleMinutes || 480) * 60000, absoluteMs: (s.absoluteHours || 16) * 3600000 };
}

/** 로그인 성공 시: 새 세션을 만들고 쿠키를 붙입니다 */
function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const now = new Date().toISOString();
  run(
    `INSERT INTO sessions (id, user_id, csrf_token, created_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    sha256(token),
    userId,
    csrf,
    now,
    now,
    (req.socket?.remoteAddress || '').replace(/^::ffff:/, ''),
    String(req.headers['user-agent'] || '').slice(0, 200)
  );
  const { absoluteMs } = sessionLimits();
  // HttpOnly: 자바스크립트가 쿠키를 읽지 못함(XSS 대비) / SameSite=Strict: 다른 사이트에서 온 요청엔 쿠키가 안 붙음(CSRF 대비)
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(absoluteMs / 1000)}`);
  return csrf;
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function endSession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token));
  clearCookie(res);
}

/** 오래된 세션 정리 (서버 시작 시와 주기적으로 실행) */
function purgeExpiredSessions() {
  const { idleMs, absoluteMs } = sessionLimits();
  const now = Date.now();
  run(
    'DELETE FROM sessions WHERE last_seen_at < ? OR created_at < ?',
    new Date(now - idleMs).toISOString(),
    new Date(now - absoluteMs).toISOString()
  );
}

/** 사용자 정보 중 화면으로 보내도 되는 것만 고름 (비밀번호 해시 등 제외) */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    roleLabel: ROLE_LABEL[u.role],
    jobTitle: u.job_title,
    mustChangePassword: !!u.must_change_password,
  };
}

/**
 * 모든 /api 요청 앞에서 실행: 쿠키의 세션을 확인해 req.user 를 채웁니다.
 * (로그인 안 했으면 req.user 는 비어 있음 — 막는 일은 requireAuth 가 함)
 */
function loadSession(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return next();
  const id = sha256(token);
  const s = get('SELECT * FROM sessions WHERE id = ?', id);
  if (!s) {
    clearCookie(res);
    return next();
  }
  const { idleMs, absoluteMs } = sessionLimits();
  const now = Date.now();
  if (now - Date.parse(s.last_seen_at) > idleMs || now - Date.parse(s.created_at) > absoluteMs) {
    run('DELETE FROM sessions WHERE id = ?', id);
    clearCookie(res);
    req.sessionExpired = true;
    return next();
  }
  const user = get("SELECT * FROM users WHERE id = ? AND status = 'active'", s.user_id);
  if (!user || !user.password_hash) {
    run('DELETE FROM sessions WHERE id = ?', id);
    clearCookie(res);
    return next();
  }
  // 마지막 사용 시각 갱신 (1분에 한 번만 — DB 쓰기를 줄이려고)
  if (now - Date.parse(s.last_seen_at) > 60000) {
    run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', new Date(now).toISOString(), id);
  }
  req.session = s;
  req.user = { ...publicUser(user), level: ROLE_LEVEL[user.role] || 0 };
  next();
}

/** 로그인한 사람만 통과 */
function requireAuth(req, res, next) {
  if (!req.user) {
    const msg = req.sessionExpired ? '오래 사용하지 않아 자동으로 로그아웃되었습니다. 다시 로그인해 주세요.' : '로그인이 필요합니다.';
    return next(new HttpError(401, msg));
  }
  // 임시 비밀번호로 들어온 사람은 비밀번호 변경 외에는 못 하게 함
  if (req.user.mustChangePassword && !req.allowWithTempPassword) {
    return next(new HttpError(403, '먼저 비밀번호를 바꿔 주세요.', { mustChangePassword: true }));
  }
  next();
}

/** 정해진 역할 이상만 통과. 예) requireRole('manager') → 실장·원장만 */
function requireRole(role) {
  const need = ROLE_LEVEL[role];
  return (req, res, next) => {
    if (!req.user) return next(new HttpError(401, '로그인이 필요합니다.'));
    if ((ROLE_LEVEL[req.user.role] || 0) < need) {
      return next(new HttpError(403, '이 작업을 할 권한이 없습니다. 원장님이나 실장님께 요청해 주세요.'));
    }
    next();
  };
}

/** 코드 안에서 권한 확인용: hasRole(req.user, 'manager') */
function hasRole(user, role) {
  return !!user && (ROLE_LEVEL[user.role] || 0) >= ROLE_LEVEL[role];
}

/** 로그인 가능한 사용자가 한 명도 없으면 첫 설정이 필요한 상태 */
function setupRequired() {
  const row = get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND password_hash IS NOT NULL");
  return row.n === 0;
}

function revokeUserSessions(userId, exceptSessionId) {
  if (exceptSessionId) run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, exceptSessionId);
  else run('DELETE FROM sessions WHERE user_id = ?', userId);
}

function listActiveUsers() {
  return all("SELECT id, name, role, job_title FROM users WHERE status = 'active' ORDER BY id");
}

module.exports = {
  ROLE_LEVEL,
  ROLE_LABEL,
  COOKIE,
  hashPassword,
  verifyPassword,
  checkPasswordRule,
  startSession,
  endSession,
  purgeExpiredSessions,
  loadSession,
  requireAuth,
  requireRole,
  hasRole,
  publicUser,
  setupRequired,
  revokeUserSessions,
  parseCookies,
  sha256,
  listActiveUsers,
};
