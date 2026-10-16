/*
 * 이 파일이 하는 일: 로그인 전에도 쓸 수 있는 API — 첫 설정, 로그인, 로그아웃, 내 정보, 비밀번호 변경.
 *
 *   GET  /api/auth/status    지금 상태 (첫 설정이 필요한지, 로그인했는지)
 *   POST /api/auth/setup     첫 실행 때 관리자 계정 만들기 (사용자가 아무도 없을 때만 가능)
 *   POST /api/auth/login     로그인
 *   POST /api/auth/logout    로그아웃
 *   POST /api/auth/password  내 비밀번호 바꾸기
 */
const express = require('express');
const { get, run, tx } = require('../core/db');
const auth = require('../core/auth');
const { v } = require('../core/validate');
const { HttpError, badRequest } = require('../core/errors');
const { audit } = require('../core/audit');
const { getSetting, patchSetting } = require('../core/settings');
const security = require('../core/security');

const LOCK_AFTER = 5; // 연속 실패 5번이면
const LOCK_MINUTES = 15; // 15분 잠금

const usernameRule = v.string({
  min: 3,
  max: 30,
  label: '아이디',
  pattern: /^[a-zA-Z0-9._-]+$/,
  patternMessage: '영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 쓸 수 있습니다.',
});

function authRoutes() {
  const r = express.Router();

  r.get('/status', (req, res) => {
    const clinic = getSetting('clinic');
    res.json({
      setupRequired: auth.setupRequired(),
      user: req.user || null,
      csrfToken: req.session ? req.session.csrf_token : null,
      clinicName: clinic.name || '',
      sessionExpired: !!req.sessionExpired,
    });
  });

  const setupSchema = v.object({
    clinicName: v.string({ min: 1, max: 60, label: '병원 이름' }),
    name: v.string({ min: 1, max: 30, label: '이름' }),
    username: usernameRule,
    password: v.string({ min: 8, max: 128, label: '비밀번호', trim: false }),
    demo: v.bool({ default: true }),
  });

  r.post('/setup', security.rateLimit('setup', 20, 15 * 60000), (req, res) => {
    if (!auth.setupRequired()) throw new HttpError(409, '이미 관리자 계정이 있습니다. 로그인해 주세요.');
    const data = setupSchema.parse(req.body);
    const rule = auth.checkPasswordRule(data.password);
    if (rule) throw badRequest(rule, { field: 'password' });
    const now = new Date().toISOString();
    const userId = tx(() => {
      patchSetting('clinic', { name: data.clinicName });
      const info = run(
        `INSERT INTO users (name, username, password_hash, role, job_title, status, created_at, updated_at)
         VALUES (?, ?, ?, 'admin', '원장', 'active', ?, ?)`,
        data.name,
        data.username,
        auth.hashPassword(data.password),
        now,
        now
      );
      return info.lastInsertRowid;
    });
    req.auditName = data.name;
    audit({ ...req, user: { id: userId, name: data.name } }, 'setup', 'users', userId, `첫 설정: 관리자 계정 생성 (${data.username})`);
    if (data.demo) {
      // 데모 예시 데이터 넣기 (모듈마다 seed 함수 실행)
      require('../seed').seedDemo();
      audit({ ...req, user: { id: userId, name: data.name } }, 'seed', 'demo', null, '데모 예시 데이터 넣기');
    } else {
      // 실제 사용 시작: 법정 일정·체크리스트·문자 템플릿 같은 기본 서식만 넣기
      require('../seed').seedStarter();
    }
    const csrf = auth.startSession(req, res, userId);
    const user = auth.publicUser(get('SELECT * FROM users WHERE id = ?', userId));
    res.json({ ok: true, user, csrfToken: csrf });
  });

  const loginSchema = v.object({
    username: v.string({ min: 1, max: 60, label: '아이디' }),
    password: v.string({ min: 1, max: 128, label: '비밀번호', trim: false }),
  });

  r.post(
    '/login',
    security.rateLimit('login', 30, 15 * 60000, '로그인 시도가 너무 많습니다. 15분 뒤에 다시 시도해 주세요.'),
    (req, res) => {
      const data = loginSchema.parse(req.body);
      const user = get('SELECT * FROM users WHERE username = ?', data.username);
      const fail = () => new HttpError(401, '아이디 또는 비밀번호가 맞지 않습니다.');
      if (!user || !user.password_hash || user.status !== 'active') {
        // 없는 아이디여도 같은 시간이 걸리게 해시 계산을 한 번 함 (아이디 존재 여부 추측 방지)
        auth.verifyPassword(data.password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
        req.auditName = data.username;
        audit(req, 'login_fail', 'users', null, `로그인 실패: ${data.username}`);
        throw fail();
      }
      if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
        const mins = Math.ceil((Date.parse(user.locked_until) - Date.now()) / 60000);
        throw new HttpError(423, `비밀번호를 여러 번 틀려 잠시 잠겼습니다. ${mins}분 뒤에 다시 시도하거나 원장님께 초기화를 요청하세요.`);
      }
      if (!auth.verifyPassword(data.password, user.password_hash)) {
        const fails = user.failed_logins + 1;
        const lockUntil = fails >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
        run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', lockUntil ? 0 : fails, lockUntil, user.id);
        req.auditName = user.name;
        audit(req, 'login_fail', 'users', user.id, `로그인 실패 (${fails}회째)${lockUntil ? ' → 15분 잠금' : ''}`);
        if (lockUntil) throw new HttpError(423, `비밀번호를 ${LOCK_AFTER}번 틀려 ${LOCK_MINUTES}분 동안 잠겼습니다.`);
        throw fail();
      }
      run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', new Date().toISOString(), user.id);
      const csrf = auth.startSession(req, res, user.id);
      audit({ ...req, user }, 'login', 'users', user.id, '로그인');
      res.json({ ok: true, user: auth.publicUser(user), csrfToken: csrf });
    }
  );

  r.post('/logout', (req, res) => {
    if (req.user) audit(req, 'logout', 'users', req.user.id, '로그아웃');
    auth.endSession(req, res);
    res.json({ ok: true });
  });

  const pwSchema = v.object({
    current: v.string({ min: 1, max: 128, label: '현재 비밀번호', trim: false }),
    next: v.string({ min: 8, max: 128, label: '새 비밀번호', trim: false }),
  });

  r.post('/password', (req, res) => {
    if (!req.user) throw new HttpError(401, '로그인이 필요합니다.');
    const data = pwSchema.parse(req.body);
    const user = get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!auth.verifyPassword(data.current, user.password_hash)) throw badRequest('현재 비밀번호가 맞지 않습니다.', { field: 'current' });
    const rule = auth.checkPasswordRule(data.next);
    if (rule) throw badRequest(rule, { field: 'next' });
    if (data.current === data.next) throw badRequest('새 비밀번호가 지금 비밀번호와 같습니다.', { field: 'next' });
    run(
      'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
      auth.hashPassword(data.next),
      new Date().toISOString(),
      user.id
    );
    // 다른 기기에 로그인된 세션은 모두 끊음 (지금 기기는 유지)
    auth.revokeUserSessions(user.id, req.session.id);
    audit(req, 'password_change', 'users', user.id, '비밀번호 변경');
    res.json({ ok: true });
  });

  return r;
}

module.exports = authRoutes;
