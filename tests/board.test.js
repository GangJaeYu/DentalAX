/*
 * 이 파일이 하는 일: [공지·인수인계] 모듈 자동 테스트 (다른 모듈 테스트의 본보기)
 *  - 데모 데이터, 작성·수정·삭제, 권한(직원은 공지 작성 불가), 읽음 처리, 입력 검증, AI 다듬기(데모 모드)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeUser } = require('./helpers');

let s;
let staff;
before(async () => {
  s = await startServer({ demo: true });
  staff = (await makeUser(s.admin, { name: '테스트직원', role: 'staff', username: 'staff1' })).client;
});
after(async () => s && s.close());

test('데모 데이터가 들어 있다', async () => {
  const r = await s.admin.get('/api/board/posts');
  assert.equal(r.status, 200);
  assert.ok(r.data.total >= 5);
  assert.ok(r.data.rows[0].pinned, '고정 글이 맨 위');
});

test('공지 작성 → 상세 → 수정 → 삭제', async () => {
  const c = await s.admin.post('/api/board/posts', { kind: 'notice', title: '테스트 공지', body: '본문', importance: 'important', pinned: true });
  assert.equal(c.status, 201);
  const id = c.data.id;
  const d = await s.admin.get(`/api/board/posts/${id}`);
  assert.equal(d.data.title, '테스트 공지');
  assert.equal(d.data.readByMe, true, '작성자는 자동 읽음');
  const u = await s.admin.patch(`/api/board/posts/${id}`, { title: '바뀐 제목' });
  assert.equal(u.data.title, '바뀐 제목');
  const del = await s.admin.del(`/api/board/posts/${id}`);
  assert.equal(del.status, 200);
  assert.equal((await s.admin.get(`/api/board/posts/${id}`)).status, 404);
});

test('직원은 공지를 쓸 수 없고 인수인계는 쓸 수 있다', async () => {
  const n = await staff.post('/api/board/posts', { kind: 'notice', title: '직원 공지' });
  assert.equal(n.status, 403);
  const h = await staff.post('/api/board/posts', { kind: 'handover', title: '인수인계', pinned: true });
  assert.equal(h.status, 201);
  assert.equal(h.data.pinned, false, '직원은 고정 불가');
  // 남의 글은 수정 불가
  const others = await s.admin.post('/api/board/posts', { kind: 'notice', title: '원장 공지' });
  assert.equal((await staff.patch(`/api/board/posts/${others.data.id}`, { title: 'x' })).status, 403);
});

test('읽음 처리와 안 읽은 사람 목록', async () => {
  const c = await s.admin.post('/api/board/posts', { kind: 'notice', title: '읽음 테스트' });
  let d = await s.admin.get(`/api/board/posts/${c.data.id}`);
  assert.ok(d.data.unread.some((u) => u.name === '테스트직원'));
  await staff.post(`/api/board/posts/${c.data.id}/read`);
  d = await s.admin.get(`/api/board/posts/${c.data.id}`);
  assert.ok(d.data.readers.some((u) => u.name === '테스트직원'));
  const unreadOnly = await staff.get('/api/board/posts?unread=1');
  assert.ok(!unreadOnly.data.rows.some((p) => p.id === c.data.id));
});

test('입력 검증: 제목 없으면 400', async () => {
  const r = await s.admin.post('/api/board/posts', { kind: 'notice', title: '' });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /제목/);
});

test('검색은 SQL 인젝션 문자열에도 안전하다', async () => {
  const r = await s.admin.get(`/api/board/posts?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.total, 0);
});

test('AI 다듬기(데모)가 제목과 본문을 돌려주고 개인정보를 가린다', async () => {
  const r = await staff.post('/api/ai/run', { feature: 'board.polish', input: { kind: 'handover', text: '김민수님 010-2222-3333 리콜 전화 부탁' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.demo, true);
  assert.ok(r.data.data.title);
  assert.ok(!r.data.text.includes('010-2222-3333'), '전화번호가 응답에 남지 않음');
  assert.ok(r.data.pii.findings.some((f) => f.type === 'phone'));
});

test('대시보드에 공지가 나온다', async () => {
  const r = await s.admin.get('/api/dashboard');
  assert.equal(r.status, 200);
  assert.ok(r.data.notices.length > 0);
});
