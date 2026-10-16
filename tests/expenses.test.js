/*
 * 이 파일이 하는 일: [F. 지출·월별 요약] 모듈 자동 테스트
 *  - 권한: 직원은 지출 API·AI 분류를 전혀 쓸 수 없음(403)
 *  - 데모 데이터(12개월, 한 달 15~25건), 지출 추가·수정·삭제, 입력 검증
 *  - 월별 요약 계산(합계, 전월 대비, 분류별 비중, 12개월 추이, 많이 쓴 곳)
 *  - CSV 내보내기, 카드 내역 가져오기(한국어 머리글·여러 날짜/금액 형식·탭 붙여넣기·머리글 없음, 분류 추천, 중복 표시)
 *  - 분류 관리(추가·중복 이름·사용 중 삭제 막기·보관), AI 분류 추천(데모), 대시보드 숫자 카드
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeUser } = require('./helpers');

let s;
let staff;
let manager;
let cats;
const catId = (name) => cats.find((c) => c.name === name).id;

before(async () => {
  s = await startServer({ demo: true });
  staff = (await makeUser(s.admin, { name: '지출직원', role: 'staff', username: 'estaff' })).client;
  manager = (await makeUser(s.admin, { name: '지출실장', role: 'manager', username: 'emanager', jobTitle: '실장' })).client;
  cats = (await manager.get('/api/expenses/categories')).data;
});
after(async () => s && s.close());

test('직원은 지출 기능을 쓸 수 없다 (403)', async () => {
  for (const url of ['/api/expenses/items', '/api/expenses/summary', '/api/expenses/categories', '/api/expenses/export.csv']) {
    assert.equal((await staff.get(url)).status, 403, url);
  }
  assert.equal((await staff.post('/api/expenses/items', { date: '2026-01-01', categoryId: 1, payee: 'x', amount: 1000 })).status, 403);
  assert.equal((await staff.post('/api/expenses/import/preview', { text: '날짜,가맹점,금액\n2026-01-01,a,1000' })).status, 403);
  const ai = await staff.post('/api/ai/run', { feature: 'expenses.categorize', input: { items: ['한빛덴탈'] } });
  assert.equal(ai.status, 403);
  const dash = (await staff.get('/api/dashboard')).data;
  assert.ok(!dash.stats.some((x) => x.key === 'expenses-month'), '직원 대시보드에는 지출 숫자 없음');
});

test('데모 데이터: 기본 분류 11개, 12개월 지출 (한 달 15~25건)', async () => {
  assert.equal(cats.length, 11);
  assert.ok(cats.every((c) => /^#[0-9a-f]{6}$/i.test(c.color)));
  const sum = (await manager.get('/api/expenses/summary')).data;
  assert.equal(sum.trend.length, 12);
  assert.ok(sum.trend.every((t) => t.total > 0), '12개월 모두 지출이 있음');
  for (const t of sum.trend.filter((x) => !x.partial)) assert.ok(t.count >= 15 && t.count <= 25, `${t.month}: ${t.count}건`);
  assert.equal(sum.trend[11].month, sum.month);
  assert.ok(sum.byCategory.length >= 5);
  assert.ok(sum.topPayees.length > 0);
  assert.match(sum.compareLabel, /지난달 같은 기간/);
});

test('지출 추가·수정·삭제와 입력 검증', async () => {
  const c = await manager.post('/api/expenses/items', {
    date: '2026-05-03', categoryId: catId('재료비'), payee: '테스트덴탈', description: '레진', amount: 125000, paymentMethod: '카드',
  });
  assert.equal(c.status, 201);
  assert.equal(c.data.categoryName, '재료비');
  const id = c.data.id;
  const u = await manager.patch(`/api/expenses/items/${id}`, { amount: 130000, memo: '단가 인상' });
  assert.equal(u.data.amount, 130000);
  assert.equal(u.data.payee, '테스트덴탈', '보내지 않은 칸은 그대로');
  const list = await manager.get('/api/expenses/items?month=2026-05&q=' + encodeURIComponent('테스트덴탈'));
  assert.equal(list.data.total, 1);
  assert.equal(list.data.sum, 130000);
  assert.equal((await manager.del(`/api/expenses/items/${id}`)).status, 200);
  assert.equal((await manager.get(`/api/expenses/items/${id}`)).status, 404);

  // 검증
  const bad = [
    { date: '2026-05-03', categoryId: catId('재료비'), payee: '', amount: 1000 },
    { date: '2026-05-03', categoryId: catId('재료비'), payee: 'x', amount: 0 },
    { date: '2026-05-03', categoryId: catId('재료비'), payee: 'x', amount: 12.5 },
    { date: '2026/05/03', categoryId: catId('재료비'), payee: 'x', amount: 1000 },
    { date: '2026-05-03', categoryId: 99999, payee: 'x', amount: 1000 },
    { date: '2026-05-03', categoryId: catId('재료비'), payee: 'x', amount: 1000, paymentMethod: '외상' },
  ];
  for (const b of bad) assert.equal((await manager.post('/api/expenses/items', b)).status, 400, JSON.stringify(b));
  const inj = await manager.get(`/api/expenses/items?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(inj.status, 200);
  assert.equal(inj.data.total, 0);
  assert.equal((await manager.get('/api/expenses/items?sort=id;DROP TABLE expenses')).status, 200, '정렬은 허용 목록만');
});

test('월별 요약 계산: 합계·전월 대비·분류 비중', async () => {
  // 데모 데이터가 없는 과거 달에서 계산 확인
  const add = (date, cat, payee, amount) => manager.post('/api/expenses/items', { date, categoryId: catId(cat), payee, amount });
  await add('2019-02-10', '재료비', 'A덴탈', 100000);
  await add('2019-03-05', '재료비', 'A덴탈', 90000);
  await add('2019-03-20', '기공료', 'B기공소', 60000);
  await add('2019-03-31', '복리후생', 'C식당', 50000);
  const r = (await manager.get('/api/expenses/summary?month=2019-03')).data;
  assert.equal(r.total, 200000);
  assert.equal(r.count, 3);
  assert.equal(r.prevTotal, 100000);
  assert.equal(r.compareBase, 100000, '지난 달은 한 달 전체와 비교');
  assert.equal(r.change, 100000);
  assert.equal(r.changePct, 100);
  const mat = r.byCategory.find((c) => c.name === '재료비');
  assert.equal(mat.total, 90000);
  assert.equal(mat.share, 45);
  assert.equal(mat.prevTotal, 100000);
  assert.equal(r.byCategory[0].name, '재료비', '많은 순 정렬');
  assert.equal(r.trend[11].total, 200000);
  assert.equal(r.trend[10].total, 100000);
  assert.equal(r.topPayees[0].payee, 'A덴탈');
  assert.equal(r.largest[0].amount, 90000);
  // 잘못된 월은 이번 달로
  const cur = (await manager.get('/api/expenses/summary?month=abc')).data;
  assert.equal(cur.isCurrent, true);
});

test('CSV 내보내기: 엑셀용 BOM과 한국어 머리글', async () => {
  const r = await manager.get('/api/expenses/export.csv?month=2019-03');
  assert.equal(r.status, 200);
  const text = typeof r.data === 'string' ? r.data : r.data.toString('utf8');
  // 글자로 읽으면 BOM이 사라지므로, 받은 바이트를 직접 확인 (EF BB BF)
  const raw = Buffer.from(await (await fetch(s.base + '/api/expenses/export.csv?month=2019-03', { headers: { cookie: manager.cookie } })).arrayBuffer());
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(text, /날짜,분류,지급처,내용,금액,결제수단,메모/);
  assert.match(text, /2019-03-05,재료비,A덴탈/);
  assert.equal(text.trim().split(/\r?\n/).length, 4, '머리글 + 3줄');
});

test('카드 내역 가져오기: 한국어 머리글·여러 형식·분류 추천·오류 줄', async () => {
  const csv = [
    '이용일자,가맹점명,이용금액,비고',
    '2019.04.01,한빛덴탈,"₩125,000",인상재',
    '2019/04/02 14:22,하늘기공소,"1,200,000원",',
    '20190403,모퉁이카페,32000,',
    '19.04.04,알수없는가게,"(5,000)",환불',
    '2019-04-05,,10000,',
    '날짜아님,한빛덴탈,1000,',
  ].join('\n');
  const p = await manager.post('/api/expenses/import/preview', { text: csv });
  assert.equal(p.status, 200);
  const rows = p.data.rows;
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((r) => r.date), ['2019-04-01', '2019-04-02', '2019-04-03', '2019-04-04', '2019-04-05', null]);
  assert.deepEqual(rows.slice(0, 4).map((r) => r.amount), [125000, 1200000, 32000, -5000]);
  assert.equal(rows[0].categoryId, catId('재료비'));
  assert.equal(rows[0].suggestedBy, 'rule');
  assert.equal(rows[0].description, '인상재');
  assert.equal(rows[1].categoryId, catId('기공료'));
  assert.equal(rows[2].categoryId, catId('복리후생'));
  assert.equal(rows[3].categoryId, catId('기타'), '규칙에 없으면 기타');
  assert.equal(rows[3].suggestedBy, null);
  assert.ok(rows[4].error && rows[4].error.includes('가맹점'));
  assert.ok(rows[5].error && rows[5].error.includes('날짜'));
  assert.equal(rows[4].include, false);
  assert.equal(p.data.counts.errors, 2);

  // 고른 줄 저장 → 다시 미리보기하면 중복 표시
  const commitRows = rows.filter((r) => r.include).map((r) => ({ date: r.date, categoryId: r.categoryId, payee: r.payee, description: r.description, amount: r.amount, paymentMethod: r.paymentMethod }));
  const c = await manager.post('/api/expenses/import/commit', { rows: commitRows });
  assert.equal(c.status, 200);
  assert.equal(c.data.inserted, 4);
  assert.equal(c.data.sum, 125000 + 1200000 + 32000 - 5000);
  const again = await manager.post('/api/expenses/import/preview', { text: csv });
  assert.equal(again.data.counts.duplicates, 4);
  assert.ok(again.data.rows.filter((r) => r.duplicate).every((r) => r.include === false));
  const list = await manager.get('/api/expenses/items?month=2019-04');
  assert.equal(list.data.total, 4);
  assert.ok(list.data.rows.every((r) => r.source === 'import'));

  // 저장 검증: 0원·없는 분류 → 400
  assert.equal((await manager.post('/api/expenses/import/commit', { rows: [{ ...commitRows[0], amount: 0 }] })).status, 400);
  assert.equal((await manager.post('/api/expenses/import/commit', { rows: [{ ...commitRows[0], categoryId: 99999 }] })).status, 400);
  assert.equal((await manager.post('/api/expenses/import/commit', { rows: [] })).status, 400);
});

test('카드 내역 가져오기: 엑셀 붙여넣기(탭)·머리글 없는 글·알아볼 수 없는 글', async () => {
  const tsv = '거래일\t적요\t출금액\n2019-06-01\t하늘빌딩 관리사무소 관리비\t650,000\n2019-06-02\t전기요금\t410,000';
  const p = await manager.post('/api/expenses/import/preview', { text: tsv });
  assert.equal(p.status, 200);
  assert.equal(p.data.format, 'tsv');
  assert.equal(p.data.rows.length, 2);
  assert.equal(p.data.rows[0].payee, '하늘빌딩 관리사무소 관리비');
  assert.equal(p.data.rows[0].amount, 650000);
  assert.equal(p.data.rows[0].categoryId, catId('관리비·공과금'));

  const headerless = '2019-06-03,다이소,5000\n2019-06-04,검색광고 충전,300000';
  const h = await manager.post('/api/expenses/import/preview', { text: headerless });
  assert.equal(h.status, 200);
  assert.equal(h.data.headerless, true);
  assert.equal(h.data.rows[0].payee, '다이소');
  assert.equal(h.data.rows[0].categoryId, catId('사무·소모품'));
  assert.equal(h.data.rows[1].categoryId, catId('마케팅·광고'));

  const junk = await manager.post('/api/expenses/import/preview', { text: '이름,나이\n홍길동,30' });
  assert.equal(junk.status, 400);
  assert.match(junk.data.error.message, /날짜와 금액/);
});

test('분류 관리: 추가·중복 이름 막기·사용 중 삭제 막기·보관', async () => {
  const c = await manager.post('/api/expenses/categories', { name: '교육비', color: '#22c55e', keywords: '세미나, 학회, 교육' });
  assert.equal(c.status, 201);
  assert.equal((await manager.post('/api/expenses/categories', { name: '교육비' })).status, 409);
  assert.equal((await manager.post('/api/expenses/categories', { name: '색오류', color: 'red' })).status, 400);
  // 새 키워드가 분류 추천에 바로 쓰임
  const p = await manager.post('/api/expenses/import/preview', { text: '날짜,가맹점,금액\n2019-07-01,치과학회 세미나 등록,200000' });
  assert.equal(p.data.rows[0].categoryId, c.data.id);
  // 쓰인 적 없으면 삭제 가능, 쓰였으면 409 → 보관
  const e = await manager.post('/api/expenses/items', { date: '2019-07-01', categoryId: c.data.id, payee: '학회', amount: 200000 });
  assert.equal(e.status, 201);
  const del = await manager.del(`/api/expenses/categories/${c.data.id}`);
  assert.equal(del.status, 409);
  assert.match(del.data.error.message, /보관/);
  const arch = await manager.patch(`/api/expenses/categories/${c.data.id}`, { active: false });
  assert.equal(arch.data.active, false);
  assert.equal(arch.data.count, 1);
  const unused = await manager.post('/api/expenses/categories', { name: '임시분류' });
  assert.equal((await manager.del(`/api/expenses/categories/${unused.data.id}`)).status, 200);
});

test('AI 분류 추천(데모 모드)이 분류 이름 목록을 돌려준다', async () => {
  const r = await manager.post('/api/ai/run', { feature: 'expenses.categorize', input: { items: ['한빛덴탈 인상재', '하늘기공소', '모퉁이카페', '처음보는가게'] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.demo, true);
  assert.ok(Array.isArray(r.data.data));
  const by = Object.fromEntries(r.data.data.map((x) => [x.index, x.category]));
  assert.equal(by[0], '재료비');
  assert.equal(by[1], '기공료');
  assert.equal(by[2], '복리후생');
  assert.equal(by[3], '기타');
  assert.equal((await manager.post('/api/ai/run', { feature: 'expenses.categorize', input: { items: [] } })).status, 400);
});

test('대시보드: 실장 이상에게 이번 달 지출 숫자 카드', async () => {
  const dash = (await manager.get('/api/dashboard')).data;
  const st = dash.stats.find((x) => x.key === 'expenses-month');
  assert.ok(st);
  assert.equal(st.href, '#/expenses');
  assert.ok(st.hint);
});
