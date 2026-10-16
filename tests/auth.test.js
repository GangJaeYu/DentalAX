/*
 * 이 파일이 하는 일: 로그인·권한·세션·CSRF 자동 테스트
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, makeUser } = require('./helpers');

let s;
before(async () => {
  s = await startServer();
});
after(async () => s && s.close());

test('처음에는 첫 설정이 필요하고, 로그인 없이는 업무 API를 쓸 수 없다', async () => {
  const c = new Client(s.base);
  const st = await c.get('/api/auth/status');
  assert.equal(st.data.setupRequired, true);
  assert.equal((await c.get('/api/board/posts')).status, 401);
  assert.equal((await c.get('/api/admin/users')).status, 401);
});

test('약한 비밀번호로는 첫 설정을 할 수 없다', async () => {
  const c = new Client(s.base);
  const r = await c.post('/api/auth/setup', { clinicName: 'A치과', name: '원장', username: 'boss', password: 'abcdefgh' });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /2가지/);
});

test('첫 설정 후에는 다시 설정할 수 없다 (데모 없이 설정하면 기본 서식만 들어감)', async () => {
  const c = new Client(s.base);
  await c.setupAdmin();
  const { get } = require('../server/core/db');
  assert.equal(get('SELECT COUNT(*) AS n FROM posts').n, 0, '데모 글 없음');
  assert.ok(get('SELECT COUNT(*) AS n FROM compliance_tasks').n >= 10, '법정 일정 기본 항목');
  assert.equal(get('SELECT COUNT(*) AS n FROM checklist_templates').n, 3, '체크리스트 기본 템플릿');
  const again = await new Client(s.base).post('/api/auth/setup', { clinicName: 'B', name: 'x', username: 'hacker', password: 'Hacker123!' });
  assert.equal(again.status, 409);
});

test('세션 쿠키는 HttpOnly·SameSite=Strict 이고, 비밀번호는 해시로만 저장된다', async () => {
  const c = new Client(s.base);
  const r = await c.req('POST', '/api/auth/login', { username: 'admin', password: 'Admin1234!' });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const { get } = require('../server/core/db');
  const u = get("SELECT password_hash FROM users WHERE username = 'admin'");
  assert.match(u.password_hash, /^scrypt\$/);
  assert.ok(!u.password_hash.includes('Admin1234!'));
  // 세션 토큰도 해시로 저장
  const token = cookie.match(/dx_session=([^;]+)/)[1];
  assert.equal(get('SELECT COUNT(*) AS n FROM sessions WHERE id = ?', token).n, 0);
});

test('틀린 비밀번호 5번이면 계정이 잠긴다', async () => {
  const admin = new Client(s.base);
  await admin.login('admin', 'Admin1234!');
  await admin.post('/api/admin/users', { name: '잠금테스트', role: 'staff', username: 'locktest', password: 'Temp1234!' });
  const c = new Client(s.base);
  for (let i = 0; i < 4; i++) assert.equal((await c.login('locktest', 'wrong-pass1')).status, 401);
  const fifth = await c.login('locktest', 'wrong-pass1');
  assert.equal(fifth.status, 423);
  // 잠긴 동안에는 맞는 비밀번호도 거부
  assert.equal((await c.login('locktest', 'Temp1234!')).status, 423);
  // 관리자가 잠금 해제하면 로그인 가능
  const users = (await admin.get('/api/admin/users')).data.users;
  const u = users.find((x) => x.username === 'locktest');
  assert.equal(u.locked, true);
  await admin.post(`/api/admin/users/${u.id}/unlock`);
  assert.equal((await c.login('locktest', 'Temp1234!')).status, 200);
});

test('임시 비밀번호로 로그인한 직원은 비밀번호를 바꾸기 전엔 업무 API를 쓸 수 없다', async () => {
  const admin = new Client(s.base);
  await admin.login('admin', 'Admin1234!');
  await admin.post('/api/admin/users', { name: '신입', role: 'staff', username: 'newbie', password: 'Temp1234!' });
  const c = new Client(s.base);
  const l = await c.login('newbie', 'Temp1234!');
  assert.equal(l.data.user.mustChangePassword, true);
  const blocked = await c.get('/api/board/posts');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.mustChangePassword, true);
  assert.equal((await c.post('/api/auth/password', { current: 'Temp1234!', next: 'Mine5678!' })).status, 200);
  assert.equal((await c.get('/api/board/posts')).status, 200);
});

test('CSRF: 토큰 없이 보낸 변경 요청은 거부된다', async () => {
  const c = new Client(s.base);
  await c.login('admin', 'Admin1234!');
  const saved = c.csrf;
  c.csrf = null;
  const r = await c.post('/api/board/posts', { kind: 'notice', title: 'csrf' });
  assert.equal(r.status, 403);
  c.csrf = 'wrong-token';
  assert.equal((await c.post('/api/board/posts', { kind: 'notice', title: 'csrf' })).status, 403);
  c.csrf = saved;
  assert.equal((await c.post('/api/board/posts', { kind: 'notice', title: 'csrf ok' })).status, 201);
});

test('CSRF: 다른 사이트(Origin)에서 온 요청과 폼 형식 요청은 거부된다', async () => {
  const c = new Client(s.base);
  await c.login('admin', 'Admin1234!');
  const r = await c.req('POST', '/api/board/posts', { kind: 'notice', title: 'x' }, { origin: 'http://evil.example.com' });
  assert.equal(r.status, 403);
  const res = await fetch(s.base + '/api/auth/logout', {
    method: 'POST',
    headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'a=1',
  });
  assert.equal(res.status, 415);
});

test('역할별 권한: 직원·실장은 관리자 API를 쓸 수 없다', async () => {
  const admin = new Client(s.base);
  await admin.login('admin', 'Admin1234!');
  const staff = (await makeUser(admin, { name: '직원A', role: 'staff', username: 'staffa' })).client;
  const manager = (await makeUser(admin, { name: '실장A', role: 'manager', username: 'managera' })).client;
  for (const c of [staff, manager]) {
    assert.equal((await c.get('/api/admin/users')).status, 403);
    assert.equal((await c.get('/api/admin/ai')).status, 403);
    assert.equal((await c.post('/api/admin/backups')).status, 403);
    assert.equal((await c.post('/api/admin/reset', { confirm: '초기화' })).status, 403);
  }
  assert.equal((await staff.get('/api/admin/usage')).status, 403);
  assert.equal((await manager.get('/api/admin/usage')).status, 200);
  // 모두가 쓸 수 있는 것
  assert.equal((await staff.get('/api/admin/people')).status, 200);
  assert.equal((await staff.get('/api/admin/clinic')).status, 200);
  assert.equal((await staff.put('/api/admin/clinic', { name: 'x' })).status, 403);
});

test('오래 사용하지 않은 세션은 만료된다', async () => {
  const c = new Client(s.base);
  await c.login('admin', 'Admin1234!');
  const { run } = require('../server/core/db');
  run('UPDATE sessions SET last_seen_at = ?', new Date(Date.now() - 9 * 3600 * 1000).toISOString());
  const r = await c.get('/api/board/posts');
  assert.equal(r.status, 401);
  assert.match(r.data.error.message, /자동으로 로그아웃/);
});

test('로그아웃하면 세션이 사라진다', async () => {
  const c = new Client(s.base);
  await c.login('admin', 'Admin1234!');
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  assert.equal((await c.get('/api/board/posts')).status, 401);
});

test('마지막 관리자는 비활성화하거나 강등할 수 없다', async () => {
  const admin = new Client(s.base);
  await admin.login('admin', 'Admin1234!');
  const me = (await admin.get('/api/auth/status')).data.user;
  const r = await admin.patch(`/api/admin/users/${me.id}`, { role: 'staff' });
  assert.equal(r.status, 400);
});
