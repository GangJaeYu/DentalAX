/*
 * 이 파일이 하는 일: [오픈·마감 체크리스트] 모듈 자동 테스트
 *  - 데모 데이터(템플릿 3개, 지난 기록, 오늘 일부 진행), 템플릿·항목 만들기/고치기/순서/삭제
 *  - 권한(직원은 템플릿 편집 불가, 남이 체크한 항목 해제 불가), 날짜 규칙(미래 불가, 직원은 7일 이내)
 *  - 완료 도장 계산, 지난 기록은 템플릿을 고쳐도 그대로 남는지, 요일 적용, 완료율, 대시보드, AI 추천(데모)
 * 날짜를 2026-10-16(금요일)로 고정해서 요일에 따라 결과가 달라지지 않게 합니다.
 */
process.env.DENTALAX_TODAY = '2026-10-16';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeUser } = require('./helpers');

const TODAY = '2026-10-16'; // 금요일
let s;
let staff;
let staff2;
before(async () => {
  s = await startServer({ demo: true });
  staff = (await makeUser(s.admin, { name: '체크직원', role: 'staff', username: 'ckstaff' })).client;
  staff2 = (await makeUser(s.admin, { name: '다른직원', role: 'staff', username: 'ckstaff2' })).client;
});
after(async () => s && s.close());

/** 모든 요일에 하는 테스트용 템플릿 만들기 */
async function makeTemplate(name, items) {
  const r = await s.admin.post('/api/checklists/templates', { name, timing: 'custom', weekdays: [0, 1, 2, 3, 4, 5, 6], items });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
const cardOf = (day, id) => day.templates.find((t) => t.id === id);

test('데모 데이터: 템플릿 3개와 오늘 진행 상황', async () => {
  const t = await s.admin.get('/api/checklists/templates');
  assert.equal(t.status, 200);
  const names = t.data.rows.map((x) => x.name);
  for (const n of ['오픈 체크', '마감 체크', '주간 점검']) assert.ok(names.includes(n), `${n} 있음`);
  const weekly = t.data.rows.find((x) => x.name === '주간 점검');
  assert.deepEqual(weekly.weekdays, [5]);
  assert.equal(weekly.weekdaysLabel, '금');
  assert.ok(t.data.rows.find((x) => x.name === '오픈 체크').items.length >= 10);

  const d = await s.admin.get('/api/checklists/day');
  assert.equal(d.status, 200);
  assert.equal(d.data.date, TODAY);
  assert.equal(d.data.templates.length, 3, '금요일이라 주간 점검까지 3개');
  const open = d.data.templates.find((x) => x.name === '오픈 체크');
  assert.equal(open.progress.done, 7);
  assert.equal(open.complete, false);
  assert.ok(open.items[0].checkedByName, '누가 체크했는지 보임');
  assert.ok(open.items.some((i) => i.note), '메모가 있는 항목');
});

test('데모 데이터: 지난 기록은 대부분 완료, 일부 미완료', async () => {
  const h = await s.admin.get('/api/checklists/history?days=14');
  assert.equal(h.status, 200);
  assert.equal(h.data.days.length, 14);
  const open = h.data.templates.find((x) => x.name === '오픈 체크');
  assert.ok(open.rate >= 70 && open.rate < 100, `오픈 완료율 ${open.rate}`);
  const close = h.data.templates.find((x) => x.name === '마감 체크');
  assert.ok(close.cells.some((c) => c.applicable && !c.hasRun && c.date < TODAY), '빠뜨린 날이 있음');
  // 일요일은 해당 없음
  const sunday = close.cells.find((c) => new Date(c.date + 'T00:00:00').getDay() === 0);
  assert.equal(sunday.applicable, false);
  assert.ok(h.data.notes.length > 0, '최근 메모');
});

test('템플릿·항목 만들기 → 고치기 → 순서 바꾸기 → 삭제', async () => {
  const t = await makeTemplate('테스트 점검', [{ text: '항목 A' }, { text: '항목 B', hint: '도움말', required: false }]);
  assert.equal(t.items.length, 2);
  assert.equal(t.items[1].required, false);

  const p = await s.admin.patch(`/api/checklists/templates/${t.id}`, { name: '바뀐 점검', weekdays: [5, 1, 1] });
  assert.equal(p.data.name, '바뀐 점검');
  assert.deepEqual(p.data.weekdays, [1, 5], '중복 제거·정렬');

  const add = await s.admin.post(`/api/checklists/templates/${t.id}/items`, { items: [{ text: '항목 C' }, { text: '항목 D' }] });
  assert.equal(add.status, 201);
  assert.deepEqual(add.data.items.map((i) => i.text), ['항목 A', '항목 B', '항목 C', '항목 D']);

  const ids = add.data.items.map((i) => i.id);
  const o = await s.admin.put(`/api/checklists/templates/${t.id}/order`, { itemIds: [ids[3], ids[0], ids[1], ids[2]] });
  assert.deepEqual(o.data.items.map((i) => i.text), ['항목 D', '항목 A', '항목 B', '항목 C']);
  // 일부만 보내면 거절
  assert.equal((await s.admin.put(`/api/checklists/templates/${t.id}/order`, { itemIds: [ids[0]] })).status, 400);

  const e = await s.admin.patch(`/api/checklists/items/${ids[0]}`, { text: '항목 A (수정)', required: false });
  assert.equal(e.data.items.find((i) => i.id === ids[0]).text, '항목 A (수정)');
  const del = await s.admin.del(`/api/checklists/items/${ids[1]}`);
  assert.equal(del.data.items.length, 3);

  assert.equal((await s.admin.del(`/api/checklists/templates/${t.id}`)).status, 200);
  const list = await s.admin.get('/api/checklists/templates');
  assert.ok(!list.data.rows.some((x) => x.id === t.id));
});

test('직원은 템플릿을 고칠 수 없지만 체크는 할 수 있다', async () => {
  const t = await makeTemplate('권한 테스트', [{ text: '하나' }]);
  assert.equal((await staff.post('/api/checklists/templates', { name: 'x', timing: 'open', weekdays: [1] })).status, 403);
  assert.equal((await staff.patch(`/api/checklists/templates/${t.id}`, { name: 'x' })).status, 403);
  assert.equal((await staff.post(`/api/checklists/templates/${t.id}/items`, { items: [{ text: 'x' }] })).status, 403);
  assert.equal((await staff.del(`/api/checklists/items/${t.items[0].id}`)).status, 403);
  assert.equal((await staff.del(`/api/checklists/templates/${t.id}`)).status, 403);
  const m = await staff.post('/api/checklists/mark', { templateId: t.id, date: TODAY, itemId: t.items[0].id, checked: true });
  assert.equal(m.status, 200);
  assert.equal(m.data.items[0].checkedByName, '체크직원');
});

test('필수 항목을 모두 체크하면 완료 도장, 해제하면 도장이 사라진다', async () => {
  const t = await makeTemplate('완료 테스트', [{ text: '필수1' }, { text: '필수2' }, { text: '선택', required: false }]);
  const [a, b] = t.items;
  let r = await staff.post('/api/checklists/mark', { templateId: t.id, date: TODAY, itemId: a.id, checked: true });
  assert.equal(r.data.complete, false);
  assert.deepEqual(r.data.progress, { done: 1, total: 3, reqDone: 1, reqTotal: 2 });
  r = await staff.post('/api/checklists/mark', { templateId: t.id, date: TODAY, itemId: b.id, checked: true });
  assert.equal(r.data.complete, true, '선택 항목은 안 해도 완료');
  assert.equal(r.data.completedByName, '체크직원');
  assert.ok(r.data.completedAt);

  // 남이 체크한 것은 다른 직원이 해제 불가
  const no = await staff2.post('/api/checklists/mark', { templateId: t.id, date: TODAY, itemId: b.id, checked: false });
  assert.equal(no.status, 403);
  assert.match(no.data.error.message, /체크직원/);
  // 실장 이상은 해제 가능 → 완료 도장 사라짐
  r = await s.admin.post('/api/checklists/mark', { templateId: t.id, date: TODAY, itemId: b.id, checked: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.complete, false);
  assert.equal(r.data.completedAt, null);
  // 본인은 해제 가능
  r = await staff.post('/api/checklists/mark', { templateId: t.id, date: TODAY, itemId: a.id, checked: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.progress.done, 0);
});

test('항목 메모를 붙이고 지울 수 있다', async () => {
  const t = await makeTemplate('메모 테스트', [{ text: '소독제 확인' }]);
  let r = await staff.post('/api/checklists/mark', { templateId: t.id, date: TODAY, itemId: t.items[0].id, note: '소독제 부족' });
  assert.equal(r.status, 200);
  assert.equal(r.data.items[0].note, '소독제 부족');
  assert.equal(r.data.items[0].noteByName, '체크직원');
  assert.equal(r.data.items[0].checked, false, '메모만 붙여도 체크는 그대로');
  r = await staff.post('/api/checklists/mark', { templateId: t.id, date: TODAY, itemId: t.items[0].id, note: '' });
  assert.equal(r.data.items[0].note, '');
  // 너무 긴 메모는 거절
  const long = await staff.post('/api/checklists/mark', { templateId: t.id, date: TODAY, itemId: t.items[0].id, note: 'ㄱ'.repeat(101) });
  assert.equal(long.status, 400);
});

test('날짜 규칙: 미래는 체크 불가, 직원은 최근 7일까지, 실장은 그 이전도 가능', async () => {
  const t = await makeTemplate('날짜 테스트', [{ text: '하나' }]);
  const item = t.items[0].id;
  const fut = await staff.post('/api/checklists/mark', { templateId: t.id, date: '2026-10-17', itemId: item, checked: true });
  assert.equal(fut.status, 400);
  const old = await staff.post('/api/checklists/mark', { templateId: t.id, date: '2026-10-01', itemId: item, checked: true });
  assert.equal(old.status, 403);
  const ok = await staff.post('/api/checklists/mark', { templateId: t.id, date: '2026-10-12', itemId: item, checked: true });
  assert.equal(ok.status, 200);
  const mgr = await s.admin.post('/api/checklists/mark', { templateId: t.id, date: '2026-10-01', itemId: item, checked: true });
  assert.equal(mgr.status, 200);
  // 미래 날짜 화면은 볼 수만 있음
  const day = await staff.get('/api/checklists/day?date=2026-10-20');
  assert.equal(day.data.isFuture, true);
  assert.equal(day.data.editable, false);
});

test('지난 기록은 템플릿을 고쳐도 그날 내용 그대로 남는다', async () => {
  const t = await makeTemplate('보존 테스트', [{ text: '원래 문구' }, { text: '지울 항목' }]);
  const yday = '2026-10-15';
  await staff.post('/api/checklists/mark', { templateId: t.id, date: yday, itemId: t.items[0].id, checked: true });
  await s.admin.patch(`/api/checklists/items/${t.items[0].id}`, { text: '새 문구' });
  await s.admin.del(`/api/checklists/items/${t.items[1].id}`);
  await s.admin.post(`/api/checklists/templates/${t.id}/items`, { items: [{ text: '새 항목' }] });

  const past = cardOf((await staff.get(`/api/checklists/day?date=${yday}`)).data, t.id);
  assert.deepEqual(past.items.map((i) => i.text), ['원래 문구', '지울 항목'], '어제 기록은 그대로');
  assert.equal(past.items[0].checked, true);

  const now = cardOf((await staff.get('/api/checklists/day')).data, t.id);
  assert.deepEqual(now.items.map((i) => i.text), ['새 문구', '새 항목'], '오늘은 바뀐 템플릿');
});

test('요일: 금요일 전용 템플릿은 목요일에 "해당 없음"', async () => {
  const thu = await s.admin.get('/api/checklists/day?date=2026-10-15');
  assert.ok(thu.data.notApplicable.some((x) => x.name === '주간 점검'));
  assert.ok(!thu.data.templates.some((x) => x.name === '주간 점검'));
  // 사용 중지한 템플릿은 화면에 안 나옴
  const t = await makeTemplate('중지 테스트', [{ text: '하나' }]);
  await s.admin.patch(`/api/checklists/templates/${t.id}`, { active: false });
  const d = await s.admin.get('/api/checklists/day');
  assert.ok(!d.data.templates.some((x) => x.id === t.id));
});

test('완료율 계산: 완료한 날 / 해야 했던 날', async () => {
  const t = await makeTemplate('완료율 테스트', [{ text: '하나' }]);
  // 오늘 만든 템플릿이라 시작일=오늘. 오늘 완료하면 1/1 = 100%
  let h = await s.admin.get('/api/checklists/history?days=7');
  let row = h.data.templates.find((x) => x.id === t.id);
  assert.equal(row.rate, null, '아직 끝난 날이 없으면 비어 있음');
  assert.equal(row.cells.filter((c) => c.applicable).length, 1, '시작일 이전은 계산에서 뺌');
  await staff.post('/api/checklists/mark', { templateId: t.id, date: TODAY, itemId: t.items[0].id, checked: true });
  h = await s.admin.get('/api/checklists/history?days=7');
  row = h.data.templates.find((x) => x.id === t.id);
  assert.equal(row.rate, 100);
  assert.equal(row.completedDays, 1);
});

test('입력 검증: 이름·요일이 없으면 400', async () => {
  const a = await s.admin.post('/api/checklists/templates', { name: '', timing: 'open', weekdays: [1] });
  assert.equal(a.status, 400);
  assert.match(a.data.error.message, /이름/);
  const b = await s.admin.post('/api/checklists/templates', { name: '요일 없음', timing: 'open', weekdays: [] });
  assert.equal(b.status, 400);
  assert.match(b.data.error.message, /요일/);
  const c = await s.admin.post('/api/checklists/templates', { name: '잘못된 요일', timing: 'open', weekdays: [9] });
  assert.equal(c.status, 400);
  const d = await s.admin.post('/api/checklists/mark', { templateId: 1, date: '2026-13-01', itemId: 1, checked: true });
  assert.equal(d.status, 400);
});

test('대시보드: 오늘 할 체크리스트와 진행률', async () => {
  const r = await staff.get('/api/dashboard');
  assert.equal(r.status, 200);
  const open = r.data.todos.find((x) => x.module === 'checklists' && x.title === '오픈 체크');
  assert.ok(open, '오픈 체크가 할 일에 있음');
  assert.equal(open.level, 'warn');
  assert.deepEqual(open.progress, { done: 7, total: 10 });
  assert.equal(open.href, '#/checklists');
  assert.ok(r.data.todos.some((x) => x.title === '주간 점검'), '금요일이라 주간 점검도');
});

test('AI 항목 추천(데모): 설명을 반영한 8~15개 항목', async () => {
  const r = await staff.post('/api/ai/run', { feature: 'checklists.suggest', input: { description: '소아 환자가 많은 치과의 마감 체크' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.demo, true);
  const items = r.data.data.items;
  assert.ok(items.length >= 8 && items.length <= 15, `항목 수 ${items.length}`);
  assert.ok(items.every((i) => i.text));
  assert.ok(items.some((i) => /소아|장난감/.test(i.text)), '소아 관련 항목');
  assert.ok(items.some((i) => /석션|폐기물|잠금/.test(i.text)), '마감 관련 항목');
  const w = await staff.post('/api/ai/run', { feature: 'checklists.suggest', input: { description: '주간 점검', timing: 'weekly' } });
  assert.ok(w.data.data.items.some((i) => /응급|수관/.test(i.text)));
  // 이미 있는 항목과 거의 같은 것은 빼고 추천 (그래도 8개 이상)
  const { similar } = require('../server/modules/checklists/ai');
  const existing = (await s.admin.get('/api/checklists/templates')).data.rows.find((x) => x.name === '마감 체크').items.map((i) => i.text);
  const ex = await staff.post('/api/ai/run', { feature: 'checklists.suggest', input: { description: '마감 체크', timing: 'close', existing } });
  const exItems = ex.data.data.items;
  assert.ok(exItems.length >= 8, `겹침 제외 후 ${exItems.length}개`);
  assert.ok(!exItems.some((i) => existing.some((e) => similar(e, i.text))), '이미 있는 항목과 겹치지 않음');
  assert.equal(similar('의료폐기물 밀봉 후 보관 장소로 이동', '의료폐기물 밀봉·보관 장소로 이동'), true);
  assert.equal(similar('석션 라인 세척액 흡입', '응급키트 확인'), false);
  const bad = await staff.post('/api/ai/run', { feature: 'checklists.suggest', input: { description: '' } });
  assert.equal(bad.status, 400);
});
