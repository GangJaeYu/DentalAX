/*
 * 이 파일이 하는 일: 관리 기능 자동 테스트 (사용자·권한, 병원 정보, 활동 기록, 보안 설정, 시스템 정보)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client } = require('./helpers');

let s;
before(async () => {
  s = await startServer({ demo: true });
});
after(async () => s && s.close());

test('직원 추가: 로그인 없는 직원과 로그인 계정 직원', async () => {
  const a = await s.admin.post('/api/admin/users', { name: '명부직원', jobTitle: '간호조무사', role: 'staff', hireDate: '2025-03-02' });
  assert.equal(a.status, 201);
  assert.equal(a.data.hasLogin, false);
  const b = await s.admin.post('/api/admin/users', { name: '계정직원', role: 'staff', username: 'acc1', password: 'Temp1234!' });
  assert.equal(b.data.hasLogin, true);
  assert.equal(b.data.mustChangePassword, true);
  // 아이디만 있고 비밀번호 없음 → 거부
  assert.equal((await s.admin.post('/api/admin/users', { name: 'x', username: 'nopw' })).status, 400);
  // 같은 아이디 중복 → 409
  assert.equal((await s.admin.post('/api/admin/users', { name: 'y', username: 'ACC1', password: 'Temp1234!' })).status, 409);
});

test('직원 수정·비밀번호 초기화·비활성화 시 기존 로그인이 끊긴다', async () => {
  const u = await s.admin.post('/api/admin/users', { name: '퇴사예정', role: 'staff', username: 'leaver', password: 'Temp1234!' });
  const c = new Client(s.base);
  await c.login('leaver', 'Temp1234!');
  await c.post('/api/auth/password', { current: 'Temp1234!', next: 'Leave123!' });
  assert.equal((await c.get('/api/board/posts')).status, 200);
  const reset = await s.admin.post(`/api/admin/users/${u.data.id}/reset-password`, { password: 'Reset1234!' });
  assert.equal(reset.status, 200);
  assert.equal((await c.get('/api/board/posts')).status, 401, '초기화하면 기존 세션 끊김');
  await c.login('leaver', 'Reset1234!');
  await c.post('/api/auth/password', { current: 'Reset1234!', next: 'Leave456!' });
  const off = await s.admin.patch(`/api/admin/users/${u.data.id}`, { status: 'inactive' });
  assert.equal(off.data.status, 'inactive');
  assert.equal((await c.get('/api/board/posts')).status, 401);
  assert.equal((await c.login('leaver', 'Leave456!')).status, 401, '비활성 계정은 로그인 불가');
  const people = (await s.admin.get('/api/admin/people')).data;
  assert.ok(!people.some((p) => p.name === '퇴사예정'));
});

test('병원 정보 저장', async () => {
  const cur = (await s.admin.get('/api/admin/clinic')).data;
  const r = await s.admin.put('/api/admin/clinic', { ...cur, name: '새이름치과', phone: '02-111-2222' });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, '새이름치과');
  assert.equal((await s.admin.get('/api/auth/status')).data.clinicName, '새이름치과');
});

test('활동 기록: 주요 동작이 남고, 검색·CSV 내보내기가 된다', async () => {
  const r = await s.admin.get('/api/admin/audit');
  assert.equal(r.status, 200);
  const actions = new Set(r.data.rows.map((x) => x.action));
  for (const a of ['setup', 'create', 'reset_password', 'update']) assert.ok(actions.has(a), a);
  const q = await s.admin.get('/api/admin/audit?q=' + encodeURIComponent('병원 기본 정보'));
  assert.ok(q.data.rows.length >= 1);
  // fetch의 text()는 BOM을 지우므로 원래 바이트로 확인
  const raw = await fetch(s.base + '/api/admin/audit.csv', { headers: { cookie: s.admin.cookie } });
  assert.equal(raw.status, 200);
  const bytes = Buffer.from(await raw.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], '엑셀용 BOM');
  assert.ok(bytes.subarray(3).toString('utf8').startsWith('시각,'), '한국어 머리글');
});

test('보안 설정(자동 로그아웃 시간) 저장과 검증', async () => {
  assert.equal((await s.admin.put('/api/admin/security', { idleMinutes: 5, absoluteHours: 8 })).status, 400);
  const r = await s.admin.put('/api/admin/security', { idleMinutes: 240, absoluteHours: 12 });
  assert.equal(r.status, 200);
  assert.equal(r.data.idleMinutes, 240);
});

test('잘못된 주소 값(월, 공급자)은 500이 아니라 400으로 안내한다', async () => {
  assert.equal((await s.admin.get('/api/admin/usage?month=2026-13')).status, 400);
  assert.equal((await s.admin.del('/api/admin/ai/key/evil')).status, 400);
  assert.equal((await s.admin.post('/api/admin/ai/test', { provider: 'x' })).status, 400);
});

test('시스템 정보', async () => {
  const r = await s.admin.get('/api/admin/system');
  assert.equal(r.status, 200);
  assert.equal(r.data.hasDemoData, true);
  assert.ok(r.data.dbSize > 0);
  assert.ok(Array.isArray(r.data.addresses));
});

test('CSV 내보내기는 엑셀 수식 공격을 막는다', () => {
  const { toCsv, parseCsv } = require('../server/core/csv');
  const out = toCsv([{ key: 'a', label: '값' }], [{ a: '=HYPERLINK("http://evil")' }, { a: '-12' }, { a: '쉼표, "따옴표"' }]);
  assert.ok(out.includes(`"'=HYPERLINK(""http://evil"")"`));
  assert.ok(out.includes('\r\n-12\r\n'));
  const rows = parseCsv(out);
  assert.equal(rows[3][0], '쉼표, "따옴표"');
});
