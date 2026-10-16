/*
 * 이 파일이 하는 일: [D. 인사·근무] 모듈 자동 테스트
 *  - 데모 데이터, 연차 부여 계산(근로기준법 일반 규칙), 휴가 일수 계산(휴진 요일·공휴일 제외, 반차 0.5)
 *  - 연차 신청·승인·반려·취소와 권한, 부여 일수 직접 수정, 겹치는 휴가 안내, 사유 비공개
 *  - 근무표 입력·복사·근무 유형 보관, 공휴일, 교육 이수 현황표, 온보딩 진행, AI 데모, 대시보드
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeUser } = require('./helpers');
const lib = require('../server/modules/hr/lib');

let s;
let staff;
let staffId;
let manager;
let managerId;
before(async () => {
  s = await startServer({ demo: true });
  ({ client: staff, id: staffId } = await makeUser(s.admin, { name: '테스트직원', role: 'staff', username: 'hrstaff' }));
  ({ client: manager, id: managerId } = await makeUser(s.admin, { name: '테스트실장', role: 'manager', username: 'hrmanager', jobTitle: '실장' }));
});
after(async () => s && s.close());

// ---------- 순수 계산 ----------
test('연차 부여 계산: 1년 미만 매월 1일(최대 11일), 1년 이상 15일 + 2년마다 1일(최대 25일)', () => {
  assert.equal(lib.computedGrant('2026-01-10', '2026-10-16'), 9, '9개월 개근 → 9일');
  assert.equal(lib.computedGrant('2025-10-17', '2026-10-16'), 11, '1년 되기 하루 전 → 11일');
  assert.equal(lib.computedGrant('2025-10-16', '2026-10-16'), 15, '만 1년 → 15일');
  assert.equal(lib.computedGrant('2024-10-16', '2026-10-16'), 15, '만 2년 → 15일');
  assert.equal(lib.computedGrant('2023-10-16', '2026-10-16'), 16, '만 3년 → 16일');
  assert.equal(lib.computedGrant('2021-10-16', '2026-10-16'), 17, '만 5년 → 17일');
  assert.equal(lib.computedGrant('1996-01-01', '2026-10-16'), 25, '최대 25일');
  assert.equal(lib.computedGrant('2026-11-01', '2026-10-16'), 0, '입사 전');
  assert.equal(lib.computedGrant(null, '2026-10-16'), null);
  const p = lib.leavePeriod('2023-03-02', '2026-10-16');
  assert.deepEqual([p.start, p.end, p.year, p.n], ['2026-03-02', '2027-03-01', 2026, 3], '입사일 기준 1년 단위 기간');
});

// ---------- 데모 데이터 ----------
test('데모 데이터: 근무 유형, 공휴일, 근무표, 휴가, 교육, 온보딩', async () => {
  const types = await s.admin.get('/api/hr/shift-types');
  assert.ok(types.data.some((t) => t.code === '종일') && types.data.some((t) => t.isOff));
  const hol = await s.admin.get('/api/hr/holidays?year=2026');
  assert.ok(hol.data.rows.length >= 8);
  assert.ok(hol.data.rows.some((h) => h.date === '2026-10-09' && h.name === '한글날'));
  const sch = await s.admin.get('/api/hr/schedule');
  assert.equal(sch.status, 200);
  assert.ok(sch.data.staff.length >= 7, '원장 포함 전 직원');
  assert.ok(Object.keys(sch.data.entries).length >= 7);
  const req = await s.admin.get('/api/hr/leave/requests?status=pending');
  assert.ok(req.data.rows.length >= 2);
  const m = await s.admin.get('/api/hr/training/matrix');
  assert.ok(m.data.totals.soon >= 1 && m.data.totals.expired >= 1 && m.data.totals.missing >= 1);
  const runs = await s.admin.get('/api/hr/onboarding/runs');
  const r = runs.data.rows.find((x) => x.userName === '오민지');
  assert.ok(r && r.done > 0 && r.done < r.total, '오민지 온보딩 일부 완료');
});

// ---------- 휴가 일수 ----------
test('휴가 일수: 일요일(휴진)·공휴일은 빼고, 반차는 0.5일', async () => {
  // 2027-02-26(금) ~ 03-02(화): 28일 일요일, 3/1 삼일절 제외 → 3일
  const p = await staff.get('/api/hr/leave/preview?type=' + encodeURIComponent('연차') + '&startDate=2027-02-26&endDate=2027-03-02');
  assert.equal(p.status, 200);
  assert.equal(p.data.days, 3);
  assert.deepEqual(p.data.skipped, ['2027-02-28', '2027-03-01']);
  const half = await staff.post('/api/hr/leave/requests', { type: '오전 반차', startDate: '2027-02-26', endDate: '2027-02-28' });
  assert.equal(half.status, 201);
  assert.equal(half.data.days, 0.5);
  assert.equal(half.data.endDate, '2027-02-26', '반차는 하루짜리');
  const holidayOnly = await staff.post('/api/hr/leave/requests', { type: '연차', startDate: '2027-03-01', endDate: '2027-03-01' });
  assert.equal(holidayOnly.status, 400);
  const reverse = await staff.post('/api/hr/leave/requests', { type: '연차', startDate: '2027-03-05', endDate: '2027-03-04' });
  assert.equal(reverse.status, 400);
  // 같은 날 오후 반차는 함께 신청 가능, 같은 날 연차는 409
  assert.equal((await staff.post('/api/hr/leave/requests', { type: '오후 반차', startDate: '2027-02-26' })).status, 201);
  assert.equal((await staff.post('/api/hr/leave/requests', { type: '연차', startDate: '2027-02-26' })).status, 409);
});

test('휴진 요일 설정을 바꾸면 일수 계산에 반영된다 (실장 이상만 변경)', async () => {
  assert.equal((await staff.put('/api/hr/settings', { closedWeekdays: [0, 6] })).status, 403);
  assert.equal((await manager.put('/api/hr/settings', { closedWeekdays: [0, 6] })).status, 200);
  const p = await staff.get('/api/hr/leave/preview?type=' + encodeURIComponent('연차') + '&startDate=2027-04-02&endDate=2027-04-05');
  assert.equal(p.data.days, 2, '금·월만 (토·일 휴진)');
  assert.equal((await manager.put('/api/hr/settings', { closedWeekdays: [0] })).status, 200);
  assert.equal((await manager.put('/api/hr/settings', { closedWeekdays: [9] })).status, 400);
});

// ---------- 신청·승인 흐름 ----------
test('연차 신청 → 승인 → 잔여 차감, 병가는 차감 안 함', async () => {
  await s.admin.patch(`/api/admin/users/${staffId}`, { hireDate: '2023-10-01' });
  let bal = (await staff.get('/api/hr/leave/balances')).data.rows;
  assert.equal(bal.length, 1, '직원은 본인 것만');
  const before = bal[0];
  assert.equal(before.computed, 16);
  const c = await staff.post('/api/hr/leave/requests', { type: '연차', startDate: '2027-01-11', endDate: '2027-01-12', reason: '개인 사유' });
  assert.equal(c.status, 201);
  assert.equal(c.data.status, 'pending');
  assert.equal(c.data.days, 2);
  // 직원은 승인 불가
  assert.equal((await staff.post(`/api/hr/leave/requests/${c.data.id}/decide`, { decision: 'approved' })).status, 403);
  const ok = await manager.post(`/api/hr/leave/requests/${c.data.id}/decide`, { decision: 'approved', note: '확인' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, 'approved');
  assert.equal(ok.data.decidedByName, '테스트실장');
  // 이미 처리된 건은 다시 결정 불가
  assert.equal((await manager.post(`/api/hr/leave/requests/${c.data.id}/decide`, { decision: 'rejected' })).status, 400);
  // 기간(2026-10-01 ~ 2027-09-30) 안이므로 사용 2일
  bal = (await staff.get('/api/hr/leave/balances')).data.rows[0];
  assert.equal(bal.used, before.used + 2);
  // 병가는 연차에서 빼지 않음 (실장이 대신 신청 + 바로 승인)
  const sick = await manager.post('/api/hr/leave/requests', { userId: staffId, type: '병가', startDate: '2027-01-14', approve: true });
  assert.equal(sick.status, 201);
  assert.equal(sick.data.status, 'approved');
  assert.equal(sick.data.requestedByName, '테스트실장');
  assert.equal((await staff.get('/api/hr/leave/balances')).data.rows[0].used, bal.used);
  // 승인된 휴가는 근무표에 표시됨
  const sch = await staff.get('/api/hr/schedule?month=2027-01');
  assert.equal(sch.data.leaves[staffId]['2027-01-11'].type, '연차');
  assert.equal(sch.data.leaves[staffId]['2027-01-14'].type, '병가');
});

test('직원은 남의 휴가를 신청할 수 없고, 남의 사유는 볼 수 없다', async () => {
  assert.equal((await staff.post('/api/hr/leave/requests', { userId: managerId, type: '연차', startDate: '2027-05-03' })).status, 403);
  const m = await manager.post('/api/hr/leave/requests', { type: '연차', startDate: '2027-05-04', reason: '가족 행사' });
  assert.equal(m.status, 201);
  const cal = await staff.get('/api/hr/leave/calendar?month=2027-05');
  const row = cal.data.rows.find((r) => r.id === m.data.id);
  assert.ok(row, '팀 일정에는 보임');
  assert.equal(row.reason, null, '사유는 숨김');
  assert.equal((await staff.get('/api/hr/leave/requests')).data.rows.some((r) => r.userId === managerId), false, '목록은 본인 것만');
  // 남의 대기 건 취소 불가
  assert.equal((await staff.post(`/api/hr/leave/requests/${m.data.id}/cancel`)).status, 403);
});

test('겹치는 휴가 안내와 취소', async () => {
  const a = await manager.post('/api/hr/leave/requests', { type: '연차', startDate: '2027-06-07', endDate: '2027-06-08' });
  const p = await staff.get('/api/hr/leave/preview?type=' + encodeURIComponent('연차') + '&startDate=2027-06-08&endDate=2027-06-09');
  assert.ok(p.data.overlaps.some((o) => o.name === '테스트실장'), '같은 날 쉬는 사람 안내');
  const mine = await staff.post('/api/hr/leave/requests', { type: '연차', startDate: '2027-06-08' });
  assert.ok(mine.data.overlaps.some((o) => o.id === a.data.id));
  const cancel = await staff.post(`/api/hr/leave/requests/${mine.data.id}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.status, 'cancelled');
  assert.equal((await staff.post(`/api/hr/leave/requests/${mine.data.id}/cancel`)).status, 400, '이미 취소됨');
  // 반려
  const r = await manager.post(`/api/hr/leave/requests/${a.data.id}/decide`, { decision: 'rejected', note: '일정 조정' });
  assert.equal(r.data.status, 'rejected');
  assert.equal(r.data.decisionNote, '일정 조정');
});

test('연차 부여 일수 직접 수정과 되돌리기 (실장 이상)', async () => {
  const bal = (await manager.get('/api/hr/leave/balances')).data.rows.find((x) => x.userId === staffId);
  assert.equal((await staff.put('/api/hr/leave/grants', { userId: staffId, year: bal.period.year, days: 20 })).status, 403);
  const u = await manager.put('/api/hr/leave/grants', { userId: staffId, year: bal.period.year, days: 20, note: '회계연도 기준 조정' });
  assert.equal(u.status, 200);
  assert.equal(u.data.granted, 20);
  assert.equal(u.data.override.note, '회계연도 기준 조정');
  assert.equal((await manager.put('/api/hr/leave/grants', { userId: staffId, year: bal.period.year, days: 20.3 })).status, 400);
  const back = await manager.del(`/api/hr/leave/grants/${staffId}/${bal.period.year}`);
  assert.equal(back.data.granted, back.data.computed);
});

test('입력 검증: 종류·날짜가 잘못되면 400', async () => {
  assert.equal((await staff.post('/api/hr/leave/requests', { type: '휴가', startDate: '2027-01-04' })).status, 400);
  assert.equal((await staff.post('/api/hr/leave/requests', { type: '연차', startDate: '2027-13-01' })).status, 400);
  const long = await staff.post('/api/hr/leave/requests', { type: '연차', startDate: '2027-01-04', reason: 'x'.repeat(61) });
  assert.equal(long.status, 400);
  assert.match(long.data.error.message, /사유/);
});

// ---------- 근무표 ----------
test('근무표: 칸 입력·지우기, 직원은 편집 불가', async () => {
  const types = (await s.admin.get('/api/hr/shift-types')).data;
  const full = types.find((t) => t.code === '종일');
  assert.equal((await staff.put('/api/hr/schedule/entry', { userId: staffId, date: '2027-02-02', shiftTypeId: full.id })).status, 403);
  const put = await manager.put('/api/hr/schedule/entry', { userId: staffId, date: '2027-02-02', shiftTypeId: full.id });
  assert.equal(put.status, 200);
  let sch = await staff.get('/api/hr/schedule?month=2027-02');
  assert.equal(sch.data.entries[staffId]['2027-02-02'].shiftTypeId, full.id);
  await manager.put('/api/hr/schedule/entry', { userId: staffId, date: '2027-02-02', shiftTypeId: null });
  sch = await staff.get('/api/hr/schedule?month=2027-02');
  assert.ok(!sch.data.entries[staffId] || !sch.data.entries[staffId]['2027-02-02']);
  assert.equal((await manager.put('/api/hr/schedule/entry', { userId: staffId, date: '2027-02-02', shiftTypeId: 99999 })).status, 400);
  assert.equal((await staff.get('/api/hr/schedule?month=2027-1')).status, 400);
});

test('근무표 복사: 한 주 패턴 반복, 전월 같은 요일, 공휴일은 건너뜀', async () => {
  const types = (await s.admin.get('/api/hr/shift-types')).data;
  const am = types.find((t) => t.code === '오전');
  // 2027-07-05(월) ~ 07-11(일) 한 주에 오전 근무 입력
  const entries = ['2027-07-05', '2027-07-06', '2027-07-07', '2027-07-08', '2027-07-09', '2027-07-10'].map((date) => ({ userId: staffId, date, shiftTypeId: am.id }));
  assert.equal((await manager.post('/api/hr/schedule/bulk', { entries })).status, 200);
  const c = await manager.post('/api/hr/schedule/copy', { month: '2027-07', mode: 'week', weekStart: '2027-07-05', untilEnd: true });
  assert.equal(c.status, 200);
  assert.ok(c.data.changed >= 18);
  let sch = await staff.get('/api/hr/schedule?month=2027-07');
  assert.equal(sch.data.entries[staffId]['2027-07-26'].shiftTypeId, am.id, '월요일 패턴 반복');
  assert.ok(!sch.data.entries[staffId]['2027-07-11'], '원본이 빈 칸(일요일)은 비워 둠');
  // 전월 같은 요일 → 8월 (8/15 광복절은 건너뜀)
  const p = await manager.post('/api/hr/schedule/copy', { month: '2027-08', mode: 'prevMonth' });
  assert.equal(p.status, 200);
  sch = await staff.get('/api/hr/schedule?month=2027-08');
  assert.equal(sch.data.entries[staffId]['2027-08-02'].shiftTypeId, am.id, '8월 첫째 월요일 ← 7월 첫째 월요일');
  assert.ok(sch.data.days.find((d) => d.date === '2027-08-15').holiday === '광복절');
  // 공휴일(2027-03-01 삼일절, 월요일)은 복사에서 건너뜀
  const feb = ['2027-02-22', '2027-02-23', '2027-02-24'].map((date) => ({ userId: staffId, date, shiftTypeId: am.id }));
  await manager.post('/api/hr/schedule/bulk', { entries: feb });
  const w = await manager.post('/api/hr/schedule/copy', { month: '2027-03', mode: 'week', weekStart: '2027-02-22', untilEnd: true });
  assert.ok(w.data.skippedHoliday >= 1);
  sch = await staff.get('/api/hr/schedule?month=2027-03');
  assert.ok(!sch.data.entries[staffId]['2027-03-01'], '삼일절은 비워 둠');
  assert.equal(sch.data.entries[staffId]['2027-03-08'].shiftTypeId, am.id);
  assert.equal((await staff.post('/api/hr/schedule/copy', { month: '2027-08', mode: 'prevMonth' })).status, 403);
});

test('근무 유형: 추가·검증, 쓰인 유형은 지우면 숨김 처리', async () => {
  assert.equal((await manager.post('/api/hr/shift-types', { code: '단축', name: '단축 근무', color: 'red' })).status, 400);
  const c = await manager.post('/api/hr/shift-types', { code: '단축', name: '단축 근무', startTime: '10:00', endTime: '16:00', hours: 5, color: '#ef4444' });
  assert.equal(c.status, 201);
  await manager.put('/api/hr/schedule/entry', { userId: staffId, date: '2027-09-01', shiftTypeId: c.data.id });
  const d = await manager.del(`/api/hr/shift-types/${c.data.id}`);
  assert.equal(d.data.archived, true, '근무표에 쓰여서 숨김');
  assert.ok(!(await staff.get('/api/hr/shift-types')).data.some((t) => t.id === c.data.id));
  const sch = await staff.get('/api/hr/schedule?month=2027-09');
  assert.ok(sch.data.shiftTypes.some((t) => t.id === c.data.id && t.archived), '지난 근무표 표시용으로는 남음');
  assert.equal((await staff.post('/api/hr/shift-types', { code: 'x', name: 'x' })).status, 403);
});

test('공휴일: 추가·중복 방지·고정 공휴일 넣기·삭제', async () => {
  const add = await manager.post('/api/hr/holidays', { date: '2027-02-08', name: '설날 연휴' });
  assert.equal(add.status, 201);
  assert.equal((await manager.post('/api/hr/holidays', { date: '2027-02-08', name: '중복' })).status, 400);
  const p = await staff.get('/api/hr/leave/preview?type=' + encodeURIComponent('연차') + '&startDate=2027-02-08&endDate=2027-02-09');
  assert.equal(p.data.days, 1, '추가한 공휴일 제외');
  const fixed = await manager.post('/api/hr/holidays/fixed', { year: 2028 });
  assert.equal(fixed.data.added, 8);
  assert.equal((await manager.post('/api/hr/holidays/fixed', { year: 2028 })).data.added, 0, '이미 있으면 다시 넣지 않음');
  assert.equal((await manager.del(`/api/hr/holidays/${add.data.id}`)).status, 200);
  assert.equal((await staff.post('/api/hr/holidays', { date: '2027-02-09', name: 'x' })).status, 403);
});

// ---------- 교육 ----------
test('교육 이수: 여러 명 한 번에 기록 → 현황표 상태 계산', async () => {
  const t = await manager.post('/api/hr/trainings', { name: '테스트 교육', category: '직무', cycleMonths: 12, requiredFor: 'all' });
  assert.equal(t.status, 201);
  assert.equal((await staff.post('/api/hr/training/records', { trainingId: t.data.id, userIds: [staffId], completedDate: '2026-01-01' })).status, 403);
  let m = (await staff.get('/api/hr/training/matrix')).data;
  assert.equal(m.cells[staffId][t.data.id].status, 'missing');
  const today = m.today;
  const r = await manager.post('/api/hr/training/records', { trainingId: t.data.id, userIds: [staffId, managerId], completedDate: today, hours: 1, provider: '원내 교육' });
  assert.equal(r.status, 201);
  assert.equal(r.data.added, 2);
  m = (await staff.get('/api/hr/training/matrix')).data;
  assert.equal(m.cells[staffId][t.data.id].status, 'done');
  assert.equal(m.cells[managerId][t.data.id].dday > 300, true);
  // 오래된 기록만 있는 교육은 만료
  const old = await manager.post('/api/hr/trainings', { name: '만료 테스트', cycleMonths: 6, requiredFor: '실장' });
  await manager.post('/api/hr/training/records', { trainingId: old.data.id, userIds: [managerId], completedDate: '2025-01-01' });
  m = (await staff.get('/api/hr/training/matrix')).data;
  assert.equal(m.cells[managerId][old.data.id].status, 'expired');
  assert.equal(m.cells[staffId][old.data.id].status, 'na', '대상 직종이 아니면 해당 없음');
  // 미래 이수일은 400
  assert.equal((await manager.post('/api/hr/training/records', { trainingId: t.data.id, userIds: [staffId], completedDate: '2099-01-01' })).status, 400);
  // 기록 있는 교육은 삭제 대신 사용 안 함
  const del = await manager.del(`/api/hr/trainings/${t.data.id}`);
  assert.equal(del.data.archived, true);
  const recs = await staff.get(`/api/hr/training/records?trainingId=${t.data.id}`);
  assert.equal(recs.data.rows.length, 2);
  assert.equal((await manager.del(`/api/hr/training/records/${recs.data.rows[0].id}`)).status, 200);
});

// ---------- 온보딩 ----------
test('온보딩: 템플릿 → 시작 → 체크 → 자동 완료', async () => {
  const t = await manager.post('/api/hr/onboarding/templates', { name: '테스트 템플릿', jobTitle: '치과위생사' });
  assert.equal(t.status, 201);
  const items = await manager.post(`/api/hr/onboarding/templates/${t.data.id}/items`, {
    items: [
      { title: '원내 둘러보기', phase: '첫날', ownerRole: '실장' },
      { title: '멸균 흐름 실습', phase: '첫 주' },
    ],
  });
  assert.equal(items.data.items.length, 2);
  assert.equal((await staff.post('/api/hr/onboarding/runs', { userId: staffId, templateId: t.data.id, startDate: '2026-10-01' })).status, 403);
  const run = await manager.post('/api/hr/onboarding/runs', { userId: staffId, templateId: t.data.id, startDate: '2026-10-01' });
  assert.equal(run.status, 201);
  assert.equal((await manager.post('/api/hr/onboarding/runs', { userId: staffId, templateId: t.data.id, startDate: '2026-10-01' })).status, 409, '진행 중 중복');
  const [i1, i2] = items.data.items;
  let d = await staff.put(`/api/hr/onboarding/runs/${run.data.id}/checks/${i1.id}`, { done: true });
  assert.equal(d.data.done, 1);
  assert.equal(d.data.phases[0].items[0].doneByName, '테스트직원');
  d = await staff.put(`/api/hr/onboarding/runs/${run.data.id}/checks/${i2.id}`, { done: true });
  assert.equal(d.data.status, 'done', '모두 체크하면 완료');
  d = await staff.put(`/api/hr/onboarding/runs/${run.data.id}/checks/${i2.id}`, { done: false });
  assert.equal(d.data.status, 'active', '하나 풀면 다시 진행 중');
  // 내 온보딩이 대시보드 할 일에 보임
  const dash = await staff.get('/api/dashboard');
  assert.ok(dash.data.todos.some((x) => x.id === `hr-onboarding-${run.data.id}` && x.progress.total === 2));
  // 다른 템플릿 항목은 체크 불가
  assert.equal((await staff.put(`/api/hr/onboarding/runs/${run.data.id}/checks/999999`, { done: true })).status, 404);
  // 순서 바꾸기·수정·삭제
  await manager.post(`/api/hr/onboarding/items/${i2.id}/move`, { dir: 'up' });
  assert.equal((await manager.patch(`/api/hr/onboarding/items/${i1.id}`, { phase: '첫 달' })).data.phase, '첫 달');
  assert.equal((await manager.post(`/api/hr/onboarding/templates/${t.data.id}/items`, { items: [{ title: '', phase: '첫날' }] })).status, 400);
  // 사용 중인 템플릿은 삭제 불가
  assert.equal((await manager.del(`/api/hr/onboarding/templates/${t.data.id}`)).status, 409);
  assert.equal((await manager.del(`/api/hr/onboarding/runs/${run.data.id}`)).status, 200);
  assert.equal((await manager.del(`/api/hr/onboarding/templates/${t.data.id}`)).status, 200);
});

test('AI 온보딩 항목 초안(데모)이 직종과 메모를 반영한 항목 목록을 돌려준다', async () => {
  const r = await staff.post('/api/ai/run', { feature: 'hr.onboarding', input: { jobTitle: '데스크', notes: '전자차트 사용법\n주차 등록 방법' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.demo, true);
  const items = r.data.data.items;
  assert.ok(items.length >= 10 && items.length <= 15);
  assert.ok(items.every((i) => ['첫날', '첫 주', '첫 달'].includes(i.phase) && i.title));
  assert.ok(items.some((i) => i.title.includes('전자차트')), '메모 반영');
  const bad = await staff.post('/api/ai/run', { feature: 'hr.onboarding', input: { jobTitle: '' } });
  assert.equal(bad.status, 400);
});

// ---------- 대시보드 ----------
test('대시보드: 오늘 근무, 승인 대기 연차(실장 이상), 교육 기한', async () => {
  const d = await s.admin.get('/api/dashboard');
  assert.equal(d.status, 200);
  assert.ok(Array.isArray(d.data.today.working) && Array.isArray(d.data.today.off));
  const pending = d.data.todos.find((t) => t.id === 'hr-leave-pending');
  assert.ok(pending && pending.href === '#/leave?tab=pending' && pending.level === 'warn');
  assert.ok(d.data.upcoming.some((u) => u.module === 'hr' && u.dday < 0), '만료된 교육');
  assert.ok(d.data.upcoming.some((u) => u.module === 'hr' && u.dday >= 0 && u.dday <= 30), '임박한 교육');
  const sd = await staff.get('/api/dashboard');
  assert.ok(!sd.data.todos.some((t) => t.id === 'hr-leave-pending'), '직원에게는 승인 대기 없음');
});
