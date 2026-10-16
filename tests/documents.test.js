/*
 * 이 파일이 하는 일: [행정·서류] 모듈(문서함·회의록·서식 보관함) 자동 테스트
 *  - 데모 데이터, 문서 작성·수정·복제·삭제, AI 도우미 참고 권한, 입력 검증
 *  - 회의록 작성, 할 일 완료 체크, 권한
 *  - 파일 올리기(base64)·내려받기 머리글·위험한 파일 종류 처리·20MB 제한·미리보기·삭제 권한
 *  - AI 기능 3가지(데모 모드)와 대시보드 할 일
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeUser } = require('./helpers');

let s;
let staff;
let staff2;
let manager;
before(async () => {
  s = await startServer({ demo: true });
  staff = (await makeUser(s.admin, { name: '테스트직원', role: 'staff', username: 'docstaff1' })).client;
  staff2 = (await makeUser(s.admin, { name: '다른직원', role: 'staff', username: 'docstaff2' })).client;
  manager = (await makeUser(s.admin, { name: '테스트실장', role: 'manager', username: 'docmgr1', jobTitle: '실장' })).client;
});
after(async () => s && s.close());

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

// ---------------- 데모 데이터 ----------------
test('데모 데이터: 문서 5개(규정·매뉴얼은 AI 참고), 회의록 2개, 파일 4개', async () => {
  const d = await s.admin.get('/api/documents/docs');
  assert.equal(d.status, 200);
  assert.ok(d.data.total >= 5);
  const titles = d.data.rows.map((r) => r.title);
  for (const t of ['감염관리 수칙', '기구 세척·멸균 절차', '전화 응대·예약 변경 처리', '추석 연휴 휴진 안내']) assert.ok(titles.includes(t), t);
  assert.ok(d.data.rows.some((r) => r.kind === '공문'));
  const kb = await s.admin.get('/api/documents/docs?kb=1');
  assert.equal(kb.data.total, 3, '규정 1 + 매뉴얼 2');
  assert.ok(kb.data.rows.every((r) => r.includeInKb));
  const rule = await s.admin.get(`/api/documents/docs/${d.data.rows.find((r) => r.title === '감염관리 수칙').id}`);
  assert.ok(rule.data.content.length > 1000, '규정 본문이 충분히 길다');
  assert.match(rule.data.content, /제1조/);

  const m = await s.admin.get('/api/documents/minutes');
  assert.equal(m.data.total, 2);
  assert.ok(m.data.rows.some((r) => r.overdueCount > 0), '기한 지난 할 일이 있는 회의록');
  const f = await s.admin.get('/api/documents/files');
  assert.ok(f.data.rows.length >= 4);
  assert.ok(f.data.rows.some((r) => r.name === '연차 신청서 양식.txt'));
});

// ---------------- 문서함 ----------------
test('문서 작성 → 조회 → 수정 → 복제 → 삭제', async () => {
  const c = await staff.post('/api/documents/docs', { kind: '안내문', title: '주차 안내', content: '# 본문\n- 지하 주차장', tags: '주차, #안내, 주차', status: 'draft' });
  assert.equal(c.status, 201);
  assert.deepEqual(c.data.tags, ['주차', '안내'], '꼬리표 중복 제거');
  const id = c.data.id;
  const g = await staff.get(`/api/documents/docs/${id}`);
  assert.equal(g.data.content, '# 본문\n- 지하 주차장');
  assert.equal(g.data.canEdit, true);
  const u = await staff.patch(`/api/documents/docs/${id}`, { status: 'final', title: '주차 이용 안내' });
  assert.equal(u.data.status, 'final');
  assert.equal(u.data.title, '주차 이용 안내');
  const dup = await staff2.post(`/api/documents/docs/${id}/duplicate`);
  assert.equal(dup.status, 201);
  assert.equal(dup.data.title, '주차 이용 안내 (사본)');
  assert.equal(dup.data.status, 'draft');
  assert.equal(dup.data.content, g.data.content);
  // 검색·필터
  const search = await staff.get(`/api/documents/docs?q=${encodeURIComponent('지하 주차장')}&kind=${encodeURIComponent('안내문')}`);
  assert.ok(search.data.rows.some((r) => r.id === id));
  const fin = await staff.get('/api/documents/docs?status=final');
  assert.ok(fin.data.rows.every((r) => r.status === 'final'));
  assert.equal((await staff.del(`/api/documents/docs/${id}`)).status, 200);
  assert.equal((await staff.get(`/api/documents/docs/${id}`)).status, 404);
  await staff2.del(`/api/documents/docs/${dup.data.id}`);
});

test('권한: 직원은 남의 문서를 못 고치고, AI 도우미 참고 지정은 실장 이상만', async () => {
  const c = await staff.post('/api/documents/docs', { kind: '업무 매뉴얼', title: '직원 매뉴얼', content: '내용', includeInKb: true });
  assert.equal(c.data.includeInKb, false, '직원이 켜도 꺼진 채 저장');
  assert.equal((await staff.patch(`/api/documents/docs/${c.data.id}`, { includeInKb: true })).status, 403);
  assert.equal((await staff2.patch(`/api/documents/docs/${c.data.id}`, { title: '남의 글' })).status, 403);
  assert.equal((await staff2.del(`/api/documents/docs/${c.data.id}`)).status, 403);
  const m = await manager.patch(`/api/documents/docs/${c.data.id}`, { includeInKb: true });
  assert.equal(m.status, 200);
  assert.equal(m.data.includeInKb, true);
  // 직원이 다른 칸과 함께 보내면 참고 설정만 무시하고 나머지는 저장
  const both = await staff.patch(`/api/documents/docs/${c.data.id}`, { includeInKb: false, title: '직원 매뉴얼 v2' });
  assert.equal(both.data.title, '직원 매뉴얼 v2');
  assert.equal(both.data.includeInKb, true);
  await manager.del(`/api/documents/docs/${c.data.id}`);
});

test('입력 검증: 제목 없음·잘못된 종류는 400, 검색은 SQL 인젝션에 안전', async () => {
  const r = await staff.post('/api/documents/docs', { kind: '안내문', title: '' });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /제목/);
  const k = await staff.post('/api/documents/docs', { kind: '편지', title: '제목' });
  assert.equal(k.status, 400);
  assert.match(k.data.error.message, /문서 종류/);
  const inj = await staff.get(`/api/documents/docs?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(inj.status, 200);
  assert.equal(inj.data.total, 0);
  assert.equal((await staff.get('/api/documents/docs/abc')).status, 400);
});

// ---------------- 회의록 ----------------
test('회의록 작성 → 할 일 체크(누구나) → 수정 권한 → 안 끝난 것만 보기', async () => {
  const c = await staff.post('/api/documents/minutes', {
    title: '테스트 회의',
    meetingDate: '2026-10-10',
    attendees: ['테스트직원', '다른직원', '테스트직원'],
    content: '## 결정 사항\n- 결정 1',
    summary: '요약',
    actionItems: [
      { task: '문자 발송', owner: '다른직원', due: '2026-10-20' },
      { task: '재고 확인', owner: '테스트직원', due: '' },
    ],
  });
  assert.equal(c.status, 201);
  assert.deepEqual(c.data.attendees, ['테스트직원', '다른직원'], '참석자 중복 제거');
  assert.equal(c.data.totalCount, 2);
  assert.equal(c.data.doneCount, 0);
  const id = c.data.id;
  // 다른 직원도 자기 할 일을 체크할 수 있음
  const t = await staff2.patch(`/api/documents/minutes/${id}/actions/0`, { done: true });
  assert.equal(t.status, 200);
  assert.equal(t.data.actionItems[0].done, true);
  assert.equal(t.data.doneCount, 1);
  assert.equal((await staff2.patch(`/api/documents/minutes/${id}/actions/5`, { done: true })).status, 404);
  // 하지만 회의록 내용 수정은 작성자·실장 이상만
  assert.equal((await staff2.patch(`/api/documents/minutes/${id}`, { title: 'x' })).status, 403);
  const open = await staff.get('/api/documents/minutes?open=1');
  assert.ok(open.data.rows.some((r) => r.id === id));
  await staff.patch(`/api/documents/minutes/${id}/actions/1`, { done: true });
  const open2 = await staff.get('/api/documents/minutes?open=1');
  assert.ok(!open2.data.rows.some((r) => r.id === id), '할 일을 모두 끝내면 빠짐');
  const u = await manager.patch(`/api/documents/minutes/${id}`, { actionItems: [{ task: '새 할 일', owner: '', due: '2026-10-30' }] });
  assert.equal(u.status, 200);
  assert.equal(u.data.actionItems.length, 1);
  assert.equal(u.data.actionItems[0].done, false);
  assert.equal((await staff.del(`/api/documents/minutes/${id}`)).status, 200);
});

test('회의록 입력 검증: 날짜 형식, 빈 할 일', async () => {
  const r = await staff.post('/api/documents/minutes', { title: '회의', meetingDate: '2026/10/10' });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /회의 날짜/);
  const r2 = await staff.post('/api/documents/minutes', { title: '회의', meetingDate: '2026-10-10', actionItems: [{ task: '' }] });
  assert.equal(r2.status, 400);
  assert.match(r2.data.error.message, /할 일/);
});

// ---------------- 서식 보관함 ----------------
test('파일 올리기 → 목록 → 미리보기 → 내려받기(한글 이름 머리글) → 삭제', async () => {
  const text = '이름,수량\n장갑,3\n';
  const up = await staff.post('/api/documents/files', { name: 'C:\\fakepath\\물품 목록.csv', mime: 'text/csv', data: b64(text), category: '서식', description: '테스트' });
  assert.equal(up.status, 201);
  assert.equal(up.data.name, '물품 목록.csv', '경로 부분은 지움');
  assert.equal(up.data.size, Buffer.byteLength(text));
  assert.equal(up.data.previewable, 'text');
  const id = up.data.id;
  const list = await staff.get(`/api/documents/files?category=${encodeURIComponent('서식')}&q=${encodeURIComponent('물품 목록')}`);
  assert.ok(list.data.rows.some((r) => r.id === id));
  assert.ok(!('data' in list.data.rows[0]), '목록에는 파일 내용이 없음');
  const pv = await staff.get(`/api/documents/files/${id}/preview`);
  assert.equal(pv.data.text, text);
  const dl = await staff.get(`/api/documents/files/${id}/download`);
  assert.equal(dl.status, 200);
  const cd = dl.headers.get('content-disposition');
  assert.match(cd, /^attachment;/);
  assert.ok(cd.includes(`filename*=UTF-8''${encodeURIComponent('물품 목록.csv')}`));
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(String(dl.data), text);
  // 다른 직원은 못 지우고, 올린 사람은 지울 수 있음
  assert.equal((await staff2.del(`/api/documents/files/${id}`)).status, 403);
  assert.equal((await staff2.patch(`/api/documents/files/${id}`, { description: 'x' })).status, 403);
  const ren = await staff.patch(`/api/documents/files/${id}`, { name: '물품 목록 v2.exe', category: '기타' });
  assert.equal(ren.data.name, '물품 목록 v2.exe.csv', '확장자는 바뀌지 않음');
  assert.equal((await staff.del(`/api/documents/files/${id}`)).status, 200);
  assert.equal((await staff.get(`/api/documents/files/${id}/download`)).status, 404);
});

test('위험한 파일(html·svg)은 내려받을 때 octet-stream, 미리보기 안 됨', async () => {
  for (const [name, mime] of [['page.html', 'text/html'], ['logo.svg', 'image/svg+xml']]) {
    const up = await staff.post('/api/documents/files', { name, mime, data: b64('<script>alert(1)</script>') });
    assert.equal(up.status, 201);
    const dl = await staff.get(`/api/documents/files/${up.data.id}/download`);
    assert.equal(dl.headers.get('content-type'), 'application/octet-stream', name);
    assert.match(dl.headers.get('content-disposition'), /^attachment/);
    assert.equal((await staff.get(`/api/documents/files/${up.data.id}/preview`)).status, 400);
    await manager.del(`/api/documents/files/${up.data.id}`);
  }
  // 그림 파일은 미리보기로 그대로 보여 줌
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5b40000000049454e44ae426082', 'hex');
  const up = await staff.post('/api/documents/files', { name: 'dot.png', mime: 'image/png', data: png.toString('base64'), category: '기타' });
  assert.equal(up.data.previewable, 'image');
  const pv = await staff.get(`/api/documents/files/${up.data.id}/preview`);
  assert.equal(pv.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.compare(pv.data, png), 0);
  await staff.del(`/api/documents/files/${up.data.id}`);
});

test('파일 검증: 잘못된 base64·빈 파일 400, 20MB 초과는 413 한국어 안내', async () => {
  const bad = await staff.post('/api/documents/files', { name: 'a.txt', data: '###not-base64###' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error.message, /올바르지 않습니다/);
  const empty = await staff.post('/api/documents/files', { name: 'a.txt', data: '' });
  assert.equal(empty.status, 400);
  const noName = await staff.post('/api/documents/files', { name: '', data: b64('x') });
  assert.equal(noName.status, 201, '이름이 비면 "이름 없는 파일"로 저장');
  assert.equal(noName.data.name, '이름 없는 파일');
  await staff.del(`/api/documents/files/${noName.data.id}`);
  const big = Buffer.alloc(20 * 1024 * 1024 + 10, 65).toString('base64');
  const r = await staff.post('/api/documents/files', { name: 'big.txt', data: big });
  assert.equal(r.status, 413);
  assert.match(r.data.error.message, /20MB/);
  const cat = await staff.post('/api/documents/files', { name: 'a.txt', data: b64('x'), category: '없는분류' });
  assert.equal(cat.status, 400);
});

// ---------------- AI (데모 모드) ----------------
test('AI 문서 작성(데모): 종류별로 입력을 반영한 초안, 제목과 본문 분리', async () => {
  const kinds = ['공문', '안내문', '내부 규정', '업무 매뉴얼', '교육 자료', '채용 공고', '기타'];
  for (const kind of kinds) {
    const r = await staff.post('/api/ai/run', {
      feature: 'docs.write',
      input: { kind, purpose: '11월 목요일 야간진료 시작 안내', audience: '내원 환자', points: '- 매주 목요일 20시까지\n- 11월 첫째 주부터', tone: '정중', length: '보통' },
    });
    assert.equal(r.status, 200, kind);
    assert.equal(r.data.demo, true);
    assert.ok(r.data.data.title, `${kind} 제목`);
    assert.ok(r.data.data.content.includes('20시까지'), `${kind} 메모 반영`);
  }
  const g = await staff.post('/api/ai/run', { feature: 'docs.write', input: { kind: '공문', purpose: '납품 일정 변경 요청', audience: '한빛덴탈', points: '수요일 오후로 변경' } });
  assert.match(g.data.text, /수신\*\*: 한빛덴탈/);
  assert.match(g.data.text, /끝\./);
  const rule = await staff.post('/api/ai/run', { feature: 'docs.write', input: { kind: '내부 규정', purpose: '휴대폰 사용 규정', points: '진료 중 휴대폰 사용 금지' } });
  assert.match(rule.data.data.content, /제1조 \(목적\)/);
  assert.match(rule.data.data.content, /부칙/);
  const bad = await staff.post('/api/ai/run', { feature: 'docs.write', input: { kind: '공문', purpose: '' } });
  assert.equal(bad.status, 400);
});

test('AI 다듬기(데모): 맞춤법·정중하게·짧게·다시 쓰기', async () => {
  const run = (mode, text) => staff.post('/api/ai/run', { feature: 'docs.revise', input: { mode, text } });
  const p = await run('proofread', '몇일 뒤에 됬다고 연락 할께요.');
  assert.equal(p.status, 200);
  assert.match(p.data.data.content, /며칠/);
  assert.match(p.data.data.content, /됐/);
  assert.match(p.data.data.content, /할게요/);
  const pol = await run('politer', '장갑은 환자마다 교체할 것.\n소독제 개봉일을 적으세요.');
  assert.match(pol.data.data.content, /주시기 바랍니다/);
  const long = ['# 제목', '', ...Array.from({ length: 8 }, (_, i) => `- 항목 ${i + 1}`)].join('\n');
  const sh = await run('shorter', long);
  assert.ok(sh.data.data.content.split('\n').length < long.split('\n').length);
  const rw = await run('rewrite', '첫 문단입니다.\n\n둘째 문단입니다.');
  assert.ok(rw.data.data.content.length > 0);
});

test('AI 회의록 정리(데모): JSON 결과에서 요약·결정·할 일(담당자·기한)을 뽑는다', async () => {
  const r = await staff.post('/api/ai/run', {
    feature: 'docs.minutes',
    input: {
      title: '11월 준비 회의',
      date: '2026-10-16',
      attendees: '이서연, 최유나, 박지민',
      notes: '- 목요일 야간진료는 순번제로 하기로 결정\n- 이서연 10/20까지 야간 마감 체크리스트 작성\n- 최유나 다음 주 금요일까지 장갑 재고 확인\n- 주차 등록 방법 공유',
    },
  });
  assert.equal(r.status, 200);
  const d = r.data.data;
  assert.ok(d.summary.includes('11월 준비 회의'));
  assert.ok(d.decisions.some((x) => x.includes('순번제')));
  const a = d.actionItems.find((x) => x.owner === '이서연');
  assert.ok(a, '이서연 할 일');
  assert.equal(a.due, '2026-10-20');
  assert.ok(a.task.includes('체크리스트'));
  const b = d.actionItems.find((x) => x.owner === '최유나');
  assert.equal(b.due, '2026-10-23', '다음 주 금요일 (2026-10-16은 금요일)');
});

// ---------------- 대시보드 ----------------
test('대시보드: 내 이름이 담당인 회의 할 일과, 실장 이상에게는 직원 할 일 요약', async () => {
  const r = await s.admin.get('/api/dashboard');
  assert.equal(r.status, 200);
  const mine = r.data.todos.filter((t) => t.module === 'documents' && t.id.startsWith('minutes-') && t.id !== 'minutes-others');
  assert.ok(mine.some((t) => t.title.includes('감염관리 교육 자료 검토')), '원장 담당 할 일');
  const others = r.data.todos.find((t) => t.id === 'minutes-others');
  assert.ok(others, '직원 할 일 요약');
  assert.match(others.title, /기한 지남/);
  // 직원은 남의 할 일 요약을 보지 않음
  const st = await staff.get('/api/dashboard');
  assert.ok(!st.data.todos.some((t) => t.id === 'minutes-others'));
});
