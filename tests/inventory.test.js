/*
 * 이 파일이 하는 일: [재고·구매] 모듈 자동 테스트
 *  - 데모 데이터, 품목 추가·수정·삭제(보관), 권한(직원은 입출고만), 입력 검증
 *  - 핵심 계산: 입고 로트·단가 기록, 출고 선입선출(유효기간 빠른 것부터), 재고 부족 시 출고 거절, 실사 조정, 기록 취소
 *  - 경고(부족·임박·만료), 자동 발주(거래처별 묶기), 발주 → 일부 입고 → 입고 완료, 거래처
 *  - CSV 내보내기·가져오기(미리보기 → 확정), AI(거래명세서 인식·발주 메시지) 데모 모드, 대시보드
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeUser } = require('./helpers');

let s;
let staff;
let manager;
before(async () => {
  s = await startServer({ demo: true });
  staff = (await makeUser(s.admin, { name: '재고직원', role: 'staff', username: 'invstaff' })).client;
  manager = (await makeUser(s.admin, { name: '재고실장', role: 'manager', username: 'invmgr', jobTitle: '실장' })).client;
});
after(async () => s && s.close());

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const addDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function newItem(body = {}) {
  const r = await s.admin.post('/api/inventory/items', { name: `테스트품목 ${Math.random().toString(36).slice(2, 7)}`, category: '소모품', unit: '개', minQty: 2, ...body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

test('데모 데이터: 거래처 5곳, 품목 25개 이상, 부족·임박·만료·발주서 3건', async () => {
  const items = await s.admin.get('/api/inventory/items');
  assert.equal(items.status, 200);
  assert.ok(items.data.rows.length >= 25);
  assert.ok(items.data.summary.low >= 3, '부족 품목이 몇 개 있음');
  assert.ok(items.data.summary.expiring >= 1, '유효기간 임박');
  assert.ok(items.data.summary.expired >= 1, '유효기간 만료');
  const vendors = await s.admin.get('/api/inventory/vendors');
  assert.equal(vendors.data.rows.length, 5);
  const orders = await s.admin.get('/api/inventory/orders');
  const statuses = orders.data.rows.map((p) => p.status).sort();
  assert.deepEqual(statuses, ['draft', 'ordered', 'received']);
  assert.ok(orders.data.rows.find((p) => p.status === 'ordered').overdue, '입고 예정일이 지난 발주');
  assert.match(orders.data.rows[0].poNo, /^PO-\d{8}-\d{2}$/);
  const moves = await s.admin.get('/api/inventory/moves');
  assert.ok(moves.data.total > 100, '60일 치 입출고 기록');
  const prices = await s.admin.get('/api/inventory/prices');
  assert.ok(prices.data.changed >= 3, '단가 변동 기록');
});

test('품목 추가 → 수정 → 삭제 (기록 없으면 삭제, 있으면 보관)', async () => {
  const it = await newItem({ name: '테스트 거즈', spec: '4x4', lastUnitPrice: 3000, initialQty: 5 });
  assert.equal(it.currentQty, 5, '시작 재고');
  const u = await s.admin.patch(`/api/inventory/items/${it.id}`, { minQty: 10, location: '창고 C' });
  assert.equal(u.status, 200);
  assert.equal(u.data.minQty, 10);
  assert.equal(u.data.low, true, '현재 5 ≤ 적정 10 → 부족');
  // 시작 재고 기록이 있으므로 삭제 대신 보관
  const del = await s.admin.del(`/api/inventory/items/${it.id}`);
  assert.equal(del.data.archived, true);
  const list = await s.admin.get('/api/inventory/items?archived=1');
  assert.ok(list.data.rows.some((x) => x.id === it.id));
  // 보관된 품목은 입고 불가
  assert.equal((await s.admin.post(`/api/inventory/items/${it.id}/in`, { qty: 1 })).status, 400);
  // 기록이 없는 품목은 완전히 삭제
  const empty = await newItem();
  const del2 = await s.admin.del(`/api/inventory/items/${empty.id}`);
  assert.equal(del2.data.archived, false);
  assert.equal((await s.admin.get(`/api/inventory/items/${empty.id}`)).status, 404);
  // 같은 이름·규격 중복은 409
  const a = await newItem({ name: '중복검사 품목', spec: 'A' });
  assert.equal((await s.admin.post('/api/inventory/items', { name: '중복검사 품목', spec: 'A' })).status, 409);
  assert.ok(a.id);
});

test('권한: 직원은 입고·출고만, 품목 편집·실사 조정·발주서·거래처 편집은 403', async () => {
  const it = await newItem({ initialQty: 10 });
  assert.equal((await staff.post('/api/inventory/items', { name: '직원이 만든 품목' })).status, 403);
  assert.equal((await staff.patch(`/api/inventory/items/${it.id}`, { minQty: 1 })).status, 403);
  assert.equal((await staff.del(`/api/inventory/items/${it.id}`)).status, 403);
  assert.equal((await staff.post(`/api/inventory/items/${it.id}/adjust`, { actualQty: 3 })).status, 403);
  assert.equal((await staff.get('/api/inventory/orders')).status, 403);
  assert.equal((await staff.post('/api/inventory/orders/auto', {})).status, 403);
  assert.equal((await staff.post('/api/inventory/vendors', { name: '직원 거래처' })).status, 403);
  assert.equal((await staff.post('/api/inventory/items/import/preview', { text: '품목명\n가' })).status, 403);
  // 직원도 할 수 있는 것
  assert.equal((await staff.get('/api/inventory/items')).status, 200);
  assert.equal((await staff.get('/api/inventory/vendors')).status, 200);
  assert.equal((await staff.post(`/api/inventory/items/${it.id}/in`, { qty: 2 })).status, 201);
  const out = await staff.post(`/api/inventory/items/${it.id}/out`, { qty: 3, note: '진료실' });
  assert.equal(out.status, 201);
  assert.equal(out.data.item.currentQty, 9);
  // 직원에게는 거래처의 최근 발주서(금액) 정보를 보내지 않음
  const v = await staff.get('/api/inventory/vendors');
  assert.equal(v.data.rows[0].recentPos, undefined);
  // 실장은 품목 편집 가능
  assert.equal((await manager.patch(`/api/inventory/items/${it.id}`, { location: '실장이 바꿈' })).status, 200);
});

test('입력 검증: 품목명·수량·날짜가 잘못되면 400과 한국어 안내', async () => {
  const r = await s.admin.post('/api/inventory/items', { name: '' });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /품목명/);
  const it = await newItem();
  const q0 = await s.admin.post(`/api/inventory/items/${it.id}/in`, { qty: 0 });
  assert.equal(q0.status, 400);
  assert.match(q0.data.error.message, /수량/);
  const bad = await s.admin.post(`/api/inventory/items/${it.id}/in`, { qty: 1, expiryDate: '2026-13-40' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error.message, /유효기간/);
  assert.equal((await s.admin.post('/api/inventory/items', { name: '분류 오류', category: '없는분류' })).status, 400);
  assert.equal((await s.admin.post('/api/inventory/vendors', { name: '메일오류', email: 'abc' })).status, 400);
  assert.equal((await s.admin.post('/api/inventory/vendors', { name: '주소오류', website: 'javascript:alert(1)' })).status, 400);
  // 검색은 SQL 인젝션 문자열에도 안전
  const inj = await s.admin.get(`/api/inventory/items?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(inj.status, 200);
  assert.equal(inj.data.rows.length, 0);
});

test('입고: 로트·유효기간 저장, 단가가 바뀔 때만 단가 기록', async () => {
  const it = await newItem({ trackExpiry: true });
  await s.admin.post(`/api/inventory/items/${it.id}/in`, { qty: 5, unitPrice: 1000, lotNo: 'L1', expiryDate: addDays(200) });
  await s.admin.post(`/api/inventory/items/${it.id}/in`, { qty: 5, unitPrice: 1000, lotNo: 'L2', expiryDate: addDays(300) });
  await s.admin.post(`/api/inventory/items/${it.id}/in`, { qty: 2, unitPrice: 1200, lotNo: 'L2', expiryDate: addDays(300) });
  const d = await s.admin.get(`/api/inventory/items/${it.id}`);
  assert.equal(d.data.currentQty, 12);
  assert.equal(d.data.lots.length, 2, '같은 로트·유효기간은 하나로 합침');
  assert.equal(d.data.lots.find((l) => l.lotNo === 'L2').qty, 7);
  assert.deepEqual(
    d.data.prices.map((p) => p.unitPrice),
    [1000, 1200],
    '같은 단가는 다시 기록하지 않음'
  );
  assert.equal(d.data.lastUnitPrice, 1200);
  const prices = await s.admin.get('/api/inventory/prices');
  const row = prices.data.rows.find((x) => x.itemId === it.id);
  assert.equal(row.changePct, 20, '1000 → 1200 은 +20%');
});

test('출고: 유효기간이 빠른 로트부터 차감(선입선출), 유효기간 없는 로트는 나중, 재고보다 많이 빼면 거절', async () => {
  const it = await newItem({ trackExpiry: true });
  await s.admin.post(`/api/inventory/items/${it.id}/in`, { qty: 3, lotNo: 'NOEXP' }); // 유효기간 없음
  await s.admin.post(`/api/inventory/items/${it.id}/in`, { qty: 4, lotNo: 'LATE', expiryDate: addDays(300) });
  await s.admin.post(`/api/inventory/items/${it.id}/in`, { qty: 2, lotNo: 'EARLY', expiryDate: addDays(40) });
  const out = await staff.post(`/api/inventory/items/${it.id}/out`, { qty: 5 });
  assert.equal(out.status, 201);
  let d = await s.admin.get(`/api/inventory/items/${it.id}`);
  const lot = (no) => d.data.lots.find((l) => l.lotNo === no);
  assert.equal(lot('EARLY'), undefined, '가장 빠른 로트(2)는 다 씀');
  assert.equal(lot('LATE').qty, 1, '다음 로트에서 3 차감');
  assert.equal(lot('NOEXP').qty, 3, '유효기간 없는 로트는 마지막');
  assert.equal(d.data.currentQty, 4);
  // 재고보다 많이 출고 → 400, 수량 그대로
  const tooMuch = await staff.post(`/api/inventory/items/${it.id}/out`, { qty: 10 });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.data.error.message, /재고가 부족합니다/);
  d = await s.admin.get(`/api/inventory/items/${it.id}`);
  assert.equal(d.data.currentQty, 4);
});

test('출고: 유효기간이 지난 로트는 자동으로 먼저 쓰지 않고, 폐기는 로트를 지정해서 처리', async () => {
  const it = await newItem({ trackExpiry: true });
  await s.admin.post(`/api/inventory/items/${it.id}/in`, { qty: 2, lotNo: 'OLD', expiryDate: addDays(-3) });
  await s.admin.post(`/api/inventory/items/${it.id}/in`, { qty: 2, lotNo: 'NEW', expiryDate: addDays(100) });
  let alerts = await s.admin.get('/api/inventory/alerts');
  const expired = alerts.data.expired.find((x) => x.itemId === it.id);
  assert.ok(expired, '만료 경고에 나옴');
  await staff.post(`/api/inventory/items/${it.id}/out`, { qty: 1 });
  let d = await s.admin.get(`/api/inventory/items/${it.id}`);
  assert.equal(d.data.lots.find((l) => l.lotNo === 'OLD').qty, 2, '만료 로트는 그대로');
  assert.equal(d.data.lots.find((l) => l.lotNo === 'NEW').qty, 1);
  // 만료 로트 폐기
  const disc = await staff.post(`/api/inventory/items/${it.id}/out`, { qty: 2, lotId: expired.lotId, note: '유효기간 만료 폐기' });
  assert.equal(disc.status, 201);
  alerts = await s.admin.get('/api/inventory/alerts');
  assert.ok(!alerts.data.expired.some((x) => x.itemId === it.id));
  d = await s.admin.get(`/api/inventory/items/${it.id}`);
  assert.equal(d.data.currentQty, 1);
});

test('실사 조정: 실제 수량으로 맞추고 로트도 함께 줄어듦, 기록에 차이가 남음', async () => {
  const it = await newItem({ trackExpiry: true });
  await s.admin.post(`/api/inventory/items/${it.id}/in`, { qty: 5, lotNo: 'A', expiryDate: addDays(50) });
  await s.admin.post(`/api/inventory/items/${it.id}/in`, { qty: 5, lotNo: 'B', expiryDate: addDays(90) });
  const adj = await s.admin.post(`/api/inventory/items/${it.id}/adjust`, { actualQty: 7, note: '월말 실사' });
  assert.equal(adj.status, 201);
  assert.equal(adj.data.delta, -3);
  const d = await s.admin.get(`/api/inventory/items/${it.id}`);
  assert.equal(d.data.currentQty, 7);
  const lotSum = d.data.lots.reduce((n, l) => n + l.qty, 0);
  assert.equal(lotSum, 7, '로트 합계도 실제 수량과 같음');
  assert.equal(d.data.moves[0].type, 'adjust');
  assert.equal(d.data.moves[0].qty, -3);
  // 늘어난 경우
  const up = await s.admin.post(`/api/inventory/items/${it.id}/adjust`, { actualQty: 9 });
  assert.equal(up.data.delta, 2);
  assert.equal(up.data.item.currentQty, 9);
});

test('기록 취소: 가장 최근 기록만, 본인은 당일만 취소 가능하고 재고가 되돌아감', async () => {
  const it = await newItem({ initialQty: 10 });
  const o1 = await staff.post(`/api/inventory/items/${it.id}/out`, { qty: 2 });
  const o2 = await staff.post(`/api/inventory/items/${it.id}/out`, { qty: 3 });
  // 앞의 기록은 취소 불가
  assert.equal((await staff.del(`/api/inventory/moves/${o1.data.move.id}`)).status, 400);
  // 다른 직원의 기록은 취소 불가
  const other = (await makeUser(s.admin, { name: '다른직원', role: 'staff', username: 'invstaff2' })).client;
  assert.equal((await other.del(`/api/inventory/moves/${o2.data.move.id}`)).status, 403);
  const u = await staff.del(`/api/inventory/moves/${o2.data.move.id}`);
  assert.equal(u.status, 200);
  assert.equal(u.data.item.currentQty, 8);
  const d = await s.admin.get(`/api/inventory/items/${it.id}`);
  assert.equal(d.data.undoMoveId, o1.data.move.id, '이제 앞 기록이 가장 최근');
});

test('경고: 적정 재고 이하이면 부족, 30일 이내 유효기간은 임박', async () => {
  const it = await newItem({ minQty: 5, initialQty: 6, trackExpiry: true });
  await s.admin.post(`/api/inventory/items/${it.id}/in`, { qty: 1, lotNo: 'SOON', expiryDate: addDays(10) });
  await staff.post(`/api/inventory/items/${it.id}/out`, { qty: 2 }); // 7 → 5 (적정 5 이하)
  const a = await s.admin.get('/api/inventory/alerts');
  assert.ok(a.data.low.some((x) => x.id === it.id), '부족 목록');
  const soon = a.data.expiring.find((x) => x.itemId === it.id);
  // 출고는 유효기간 빠른 로트(SOON)부터 쓰므로 SOON 로트가 이미 소진됨
  assert.equal(soon, undefined);
  await s.admin.post(`/api/inventory/items/${it.id}/in`, { qty: 1, lotNo: 'SOON2', expiryDate: addDays(12) });
  const a2 = await s.admin.get('/api/inventory/alerts');
  const s2 = a2.data.expiring.find((x) => x.itemId === it.id);
  assert.ok(s2);
  assert.equal(s2.days, 12);
  const low = await s.admin.get('/api/inventory/items?low=1');
  assert.ok(low.data.rows.every((x) => x.low));
});

test('자동 발주: 부족 품목을 거래처별로 묶고, 거래처 없는 품목은 따로, 진행 중 발주 품목은 제외', async () => {
  const v = await s.admin.post('/api/inventory/vendors', { name: '자동발주 테스트상사', category: '소모품', orderMethod: '전화' });
  assert.equal(v.status, 201);
  const a = await newItem({ name: '자동A', vendorId: v.data.id, minQty: 4, reorderQty: 12, initialQty: 1 });
  const b = await newItem({ name: '자동B', vendorId: v.data.id, minQty: 5, initialQty: 2 });
  const c = await newItem({ name: '자동C 거래처없음', minQty: 3, initialQty: 0 });
  const p = await manager.get('/api/inventory/orders/auto-preview');
  assert.equal(p.status, 200);
  const g = p.data.groups.find((x) => x.vendorId === v.data.id);
  assert.ok(g);
  assert.equal(g.items.find((x) => x.itemId === a.id).qty, 12, '발주 수량이 정해져 있으면 그대로');
  assert.equal(g.items.find((x) => x.itemId === b.id).qty, 8, '없으면 적정×2 − 현재 = 10 − 2');
  const none = p.data.groups.find((x) => x.vendorId === null);
  assert.ok(none.items.some((x) => x.itemId === c.id));
  assert.ok(none.note, '거래처 없는 묶음에는 안내');
  // 이 거래처 묶음만 발주서로 만들기 (수량 수정)
  const cr = await manager.post('/api/inventory/orders/auto', { groups: [{ vendorId: v.data.id, items: [{ itemId: a.id, qty: 10 }, { itemId: b.id, qty: 8 }] }] });
  assert.equal(cr.status, 201);
  assert.equal(cr.data.created.length, 1);
  assert.equal(cr.data.created[0].status, 'draft');
  const p2 = await manager.get('/api/inventory/orders/auto-preview');
  assert.ok(!p2.data.groups.some((x) => x.vendorId === v.data.id), '이미 발주서에 들어간 품목은 다시 나오지 않음');
  assert.ok(p2.data.skipped.some((x) => x.itemId === a.id));
});

test('발주서: 작성 → 품목 수정 → 발주 → 일부 입고 → 나머지 입고 → 입고 완료 (재고·단가 반영)', async () => {
  const v = await s.admin.post('/api/inventory/vendors', { name: '발주흐름 테스트상사' });
  const it1 = await newItem({ name: '발주품목1', vendorId: v.data.id, lastUnitPrice: 1000, trackExpiry: true });
  const it2 = await newItem({ name: '발주품목2', vendorId: v.data.id, lastUnitPrice: 500 });
  const c = await manager.post('/api/inventory/orders', { vendorId: v.data.id, items: [{ itemId: it1.id, qty: 4 }] });
  assert.equal(c.status, 201);
  assert.equal(c.data.lines[0].unitPrice, 1000, '단가를 비우면 최근 단가');
  const id = c.data.id;
  const e = await manager.patch(`/api/inventory/orders/${id}`, { expectedDate: addDays(3), items: [{ itemId: it1.id, qty: 4, unitPrice: 1100 }, { itemId: it2.id, qty: 10 }] });
  assert.equal(e.data.lines.length, 2);
  assert.equal(e.data.total, 4 * 1100 + 10 * 500);
  // 작성 중에는 입고 불가
  assert.equal((await manager.post(`/api/inventory/orders/${id}/receive`, { all: true })).status, 400);
  const o = await manager.post(`/api/inventory/orders/${id}/order`, {});
  assert.equal(o.data.status, 'ordered');
  assert.equal(o.data.orderDate, today());
  // 발주 후에는 품목 수정 불가
  assert.equal((await manager.patch(`/api/inventory/orders/${id}`, { items: [{ itemId: it1.id, qty: 1 }] })).status, 400);
  // 일부 입고
  const l1 = o.data.lines.find((l) => l.itemId === it1.id);
  const l2 = o.data.lines.find((l) => l.itemId === it2.id);
  const r1 = await manager.post(`/api/inventory/orders/${id}/receive`, { lines: [{ lineId: l1.id, qty: 4, lotNo: 'PO-L1', expiryDate: addDays(100) }, { lineId: l2.id, qty: 6 }] });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.status, 'ordered', '아직 덜 받음');
  assert.equal(r1.data.lines.find((l) => l.id === l2.id).remaining, 4);
  // 나머지 전부
  const r2 = await manager.post(`/api/inventory/orders/${id}/receive`, { all: true });
  assert.equal(r2.data.status, 'received');
  assert.equal(r2.data.receivedDate, today());
  assert.equal(r2.data.moves.length, 3, '입고 기록 3건이 발주서에 연결');
  const d1 = await s.admin.get(`/api/inventory/items/${it1.id}`);
  assert.equal(d1.data.currentQty, 4);
  assert.equal(d1.data.lastUnitPrice, 1100, '발주 단가로 최근 단가 갱신');
  assert.equal(d1.data.lots[0].lotNo, 'PO-L1');
  const d2 = await s.admin.get(`/api/inventory/items/${it2.id}`);
  assert.equal(d2.data.currentQty, 10);
  // 입고 완료된 발주서는 취소·삭제 불가
  assert.equal((await manager.post(`/api/inventory/orders/${id}/cancel`)).status, 400);
  assert.equal((await manager.del(`/api/inventory/orders/${id}`)).status, 409);
  // 발주서 입고 기록은 "기록 취소" 불가
  assert.equal((await s.admin.del(`/api/inventory/moves/${r2.data.moves[2].id}`)).status, 400);
});

test('발주서: 일부만 받고 마감, 취소, 삭제', async () => {
  const it = await newItem({ name: '마감품목' });
  const c = await manager.post('/api/inventory/orders', { items: [{ itemId: it.id, qty: 10, unitPrice: 100 }] });
  await manager.post(`/api/inventory/orders/${c.data.id}/order`, { expectedDate: addDays(2) });
  const line = c.data.lines[0];
  const r = await manager.post(`/api/inventory/orders/${c.data.id}/receive`, { lines: [{ lineId: line.id, qty: 7 }], close: true });
  assert.equal(r.data.status, 'received');
  assert.equal(r.data.lines[0].receivedQty, 7);
  // 빈 발주서는 발주 불가
  const empty = await manager.post('/api/inventory/orders', {});
  assert.equal((await manager.post(`/api/inventory/orders/${empty.data.id}/order`)).status, 400);
  const cancel = await manager.post(`/api/inventory/orders/${empty.data.id}/cancel`);
  assert.equal(cancel.data.status, 'cancelled');
  assert.equal((await manager.del(`/api/inventory/orders/${empty.data.id}`)).status, 200);
  assert.equal((await manager.get(`/api/inventory/orders/${empty.data.id}`)).status, 404);
});

test('거래처: 추가·수정·목록(품목 수), 사용 중이면 삭제 대신 보관', async () => {
  const c = await s.admin.post('/api/inventory/vendors', { name: '새한 기공소', category: '기공소', phone: '02-555-0000', orderMethod: '카카오톡', email: 'lab@example.com' });
  assert.equal(c.status, 201);
  assert.equal((await s.admin.post('/api/inventory/vendors', { name: '새한 기공소' })).status, 409);
  const u = await manager.patch(`/api/inventory/vendors/${c.data.id}`, { contactName: '담당 대리', paymentTerms: '월말' });
  assert.equal(u.data.contactName, '담당 대리');
  await newItem({ name: '기공소 품목', vendorId: c.data.id });
  const list = await s.admin.get('/api/inventory/vendors');
  assert.equal(list.data.rows.find((x) => x.id === c.data.id).itemCount, 1);
  const del = await s.admin.del(`/api/inventory/vendors/${c.data.id}`);
  assert.equal(del.data.archived, true);
  const det = await s.admin.get(`/api/inventory/vendors/${c.data.id}`);
  assert.equal(det.data.active, false);
  // 아무 데도 안 쓰는 거래처는 삭제
  const t = await s.admin.post('/api/inventory/vendors', { name: '지울 거래처' });
  assert.equal((await s.admin.del(`/api/inventory/vendors/${t.data.id}`)).data.archived, false);
});

test('CSV: 품목·입출고 내보내기(엑셀용 BOM), 가져오기 미리보기(한국어 머리글·오류 표시) → 확정', async () => {
  const ex = await s.admin.get('/api/inventory/items.csv');
  assert.equal(ex.status, 200);
  assert.match(ex.data.replace(/^﻿/, ''), /^품목명,분류/, '한국어 머리글');
  const mv = await staff.get('/api/inventory/moves.csv?type=out');
  assert.equal(mv.status, 200);
  assert.match(mv.data, /출고/);

  const csv = ['품목명,분류,규격,단위,적정재고,발주수량,보관위치,거래처,현재고,단가', '가져온 장갑 L,소모품,100매,박스,4,10,창고 A,미소메디칼,6,6900', '니트릴 장갑 M,소모품,100매,박스,12,,,,,', ',소모품,,,,,,,,', '숫자오류,소모품,,개,많이,,,,,', '분류오류,없는분류,,개,,,,,,', '모르는거래처 품목,재료,,개,1,,,없는상사,,'].join('\n');
  const p = await manager.post('/api/inventory/items/import/preview', { text: csv });
  assert.equal(p.status, 200);
  const byName = (n) => p.data.rows.find((r) => r.name === n);
  assert.equal(byName('가져온 장갑 L').action, 'new');
  assert.equal(byName('니트릴 장갑 M').action, 'update', '같은 이름·규격이면 수정');
  assert.equal(byName('').action, 'error');
  assert.match(byName('숫자오류').errors[0], /적정재고/);
  assert.equal(byName('분류오류').action, 'error');
  assert.equal(byName('모르는거래처 품목').action, 'new');
  assert.ok(byName('모르는거래처 품목').warnings.length, '없는 거래처는 경고만');
  assert.equal(p.data.summary.error, 3);
  // 미리보기는 DB를 바꾸지 않음
  assert.ok(!(await s.admin.get('/api/inventory/items?q=가져온')).data.rows.length);

  const c = await manager.post('/api/inventory/items/import', { text: csv });
  assert.equal(c.status, 200);
  assert.equal(c.data.created, 2);
  assert.equal(c.data.updated, 1);
  assert.equal(c.data.skipped, 3);
  const got = (await s.admin.get('/api/inventory/items?q=가져온')).data.rows[0];
  assert.equal(got.currentQty, 6, '현재고 칸 → 실사 조정 기록');
  assert.equal(got.vendorName, '미소메디칼');
  assert.equal(got.lastUnitPrice, 6900);
  const glove = (await s.admin.get('/api/inventory/items?q=니트릴 장갑 M')).data.rows[0];
  assert.equal(glove.minQty, 12);
  // 품목명 열이 없으면 400
  const noName = await manager.post('/api/inventory/items/import/preview', { text: '이름없음,수량\n가,1' });
  assert.equal(noName.status, 400);
  assert.match(noName.data.error.message, /품목명/);
});

test('거래명세서 붙여넣기 → AI(데모) 인식 → 여러 품목 한꺼번에 입고', async () => {
  const text = [
    '거래명세서',
    '공급자: 한빛덴탈 (사업자번호 123-45-67890)',
    '품명 규격 수량 단가 금액',
    '1 니트릴장갑 M (100매) 10 BOX 7,200 72,000',
    '2. 덴탈마스크 50매 5 4,500 22,500',
    '3 복합레진 A2 4g 2 41,000 82,000',
    '합계 176,500',
  ].join('\n');
  const r = await staff.post('/api/ai/run', { feature: 'inventory.parseInvoice', input: { text } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.demo, true);
  const lines = r.data.data.lines;
  assert.equal(lines.length, 3, JSON.stringify(lines));
  assert.equal(lines[0].qty, 10);
  assert.equal(lines[0].unitPrice, 7200);
  assert.match(lines[0].name, /니트릴장갑 M/);
  assert.equal(lines[0].spec, '100매');
  assert.equal(lines[1].qty, 5);
  assert.equal(lines[1].unitPrice, 4500);
  assert.equal(lines[2].qty, 2);
  assert.equal(lines[2].unitPrice, 41000);

  const items = (await staff.get('/api/inventory/items?q=덴탈 마스크')).data.rows;
  const mask = items[0];
  const before = mask.currentQty;
  // 직원은 기존 품목 연결만 가능, 새 품목 만들기는 실장 이상
  const denied = await staff.post('/api/inventory/moves/bulk-in', { lines: [{ newItem: { name: '새 품목' }, qty: 1 }] });
  assert.equal(denied.status, 403);
  const b = await staff.post('/api/inventory/moves/bulk-in', { lines: [{ itemId: mask.id, qty: 5, unitPrice: 4500 }] });
  assert.equal(b.status, 201);
  assert.equal(b.data.count, 1);
  const after = (await staff.get(`/api/inventory/items/${mask.id}`)).data;
  assert.equal(after.currentQty, before + 5);
  const mb = await manager.post('/api/inventory/moves/bulk-in', { lines: [{ newItem: { name: '명세서로 생긴 품목', unit: '개', category: '재료' }, qty: 3, unitPrice: 1000 }] });
  assert.equal(mb.data.created, 1);
});

test('AI 발주 메시지(데모): 발주서 품목으로 카톡·이메일 메시지, 직원은 사용 불가', async () => {
  const orders = await s.admin.get('/api/inventory/orders?status=draft');
  const po = orders.data.rows[0];
  const r = await manager.post('/api/ai/run', { feature: 'inventory.vendorMessage', input: { poId: po.id, style: 'kakao' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.demo, true);
  const detail = await s.admin.get(`/api/inventory/orders/${po.id}`);
  for (const l of detail.data.lines) assert.ok(r.data.text.includes(l.itemName), '품목 이름이 메시지에 들어감');
  const email = await manager.post('/api/ai/run', { feature: 'inventory.vendorMessage', input: { poId: po.id, style: 'email' } });
  assert.match(email.data.text, /^제목:/);
  assert.equal((await staff.post('/api/ai/run', { feature: 'inventory.vendorMessage', input: { poId: po.id } })).status, 403);
  assert.equal((await manager.post('/api/ai/run', { feature: 'inventory.vendorMessage', input: { poId: 99999 } })).status, 404);
});

test('대시보드: 재고 경고(부족·만료·임박 D-n), 숫자 카드, 실장에게는 발주 할 일', async () => {
  const r = await s.admin.get('/api/dashboard');
  assert.equal(r.status, 200);
  const alerts = r.data.alerts.filter((a) => a.module === 'inventory');
  assert.ok(alerts.some((a) => a.level === 'danger' && a.badge === '만료'));
  assert.ok(alerts.some((a) => a.level === 'warn' && /^D-\d+$/.test(a.badge || '')));
  assert.ok(alerts.some((a) => /재고 부족/.test(a.title)));
  const stat = r.data.stats.find((x) => x.key === 'inv-low');
  assert.ok(stat.value > 0);
  assert.ok(r.data.stats.find((x) => x.key === 'inv-expiring'));
  const todos = r.data.todos.filter((t) => t.module === 'inventory');
  assert.ok(todos.some((t) => /작성 중인 발주서/.test(t.title)));
  assert.ok(todos.some((t) => t.level === 'danger' && /입고/.test(t.title)), '예정일 지난 발주');
  const st = await staff.get('/api/dashboard');
  assert.ok(!st.data.todos.some((t) => t.module === 'inventory'), '직원에게는 발주 할 일 없음');
  assert.ok(st.data.alerts.some((a) => a.module === 'inventory'));
});

test('거래명세서 데모 해석: 표 모양(여러 칸 띄어쓰기·탭·|)과 한 줄 띄어쓰기 모두 읽음', () => {
  const { parseInvoiceText } = require('../server/modules/inventory/ai');
  const lines = parseInvoiceText(
    [
      'No  품명                 규격        수량   단가      금액',
      '1   복합레진 A2          4g 시린지   3      41,000    123,000',
      '2   리도카인 앰플        1.8mL 50앰플 2     34,500    69,000',
      '석션팁\t100개\t10\t5500\t55000',
      '멸균 거즈 | 2x2 200매 | 20 | 3,200 | 64,000',
      '코튼롤 #2 3봉 4,500',
      '공급가액 300,000  부가세 30,000',
    ].join('\n')
  );
  assert.deepEqual(lines, [
    { name: '복합레진 A2', spec: '4g 시린지', qty: 3, unitPrice: 41000 },
    { name: '리도카인 앰플', spec: '1.8mL 50앰플', qty: 2, unitPrice: 34500 },
    { name: '석션팁', spec: '100개', qty: 10, unitPrice: 5500 },
    { name: '멸균 거즈', spec: '2x2 200매', qty: 20, unitPrice: 3200 },
    { name: '코튼롤', spec: '#2', qty: 3, unitPrice: 4500 },
  ]);
});
