/*
 * 이 파일이 하는 일: [E. 시설·법정] 모듈 자동 테스트
 *  - 데모 데이터(장비·멸균 기록·법정 일정)
 *  - 장비: 등록·수정·보관·삭제, 권한, 점검 기록 → 마지막 점검일·다음 점검일 자동 계산, 수리 기록 → 상태 변경
 *  - 멸균: 빠른 입력 기본값(다음 회차), 중복 회차 막기, 환자 정보 막기, 실패 → 경고 → 조치 기록, BI 대기 → 나중 입력, 권한
 *  - 법정 일정: 완료 → 다음 일정 = 완료일 + 주기, 완료 취소 → 되돌리기, 주기 변경 → 다시 계산, 권한, 입력 검증
 *  - 대시보드 조각 (다가오는 일정, 멸균 실패 경고, 기한 지난 법정 일정)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeUser } = require('./helpers');

let s;
let staff;
let staff2;
let manager;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const addDays = (ds, n) => {
  const [y, m, d] = ds.split('-').map(Number);
  const x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

before(async () => {
  s = await startServer({ demo: true });
  staff = (await makeUser(s.admin, { name: '멸균직원', role: 'staff', username: 'fstaff1' })).client;
  staff2 = (await makeUser(s.admin, { name: '다른직원', role: 'staff', username: 'fstaff2' })).client;
  manager = (await makeUser(s.admin, { name: '시설실장', role: 'manager', username: 'fmanager', jobTitle: '실장' })).client;
});
after(async () => s && s.close());

test('데모 데이터: 장비, 멸균 기록, 법정 일정이 들어 있다', async () => {
  const eq = await s.admin.get('/api/facility/equipment');
  assert.equal(eq.status, 200);
  assert.ok(eq.data.rows.length >= 10, '장비 10대 이상');
  assert.equal(eq.data.rows.filter((e) => e.category === '멸균기').length, 2);
  assert.ok(eq.data.counts.overdue >= 1, '점검 지난 장비가 있음');
  // 급한 순서로 정렬
  const ddays = eq.data.rows.filter((e) => e.dday !== null).map((e) => e.dday);
  assert.deepEqual(ddays, [...ddays].sort((a, b) => a - b));

  const month = today().slice(0, 7);
  const st = await s.admin.get(`/api/facility/sterilization/logs?month=${month}`);
  assert.equal(st.status, 200);
  assert.ok(st.data.rows.length > 10);
  assert.ok(st.data.rows.every((r) => !('patientName' in r)), '환자 칸 없음');

  const meta = await s.admin.get('/api/facility/sterilization/meta');
  assert.equal(meta.data.sterilizers.length, 2);
  assert.equal(meta.data.unresolved.length, 0, '데모의 CI 불합격은 이미 조치됨');

  const ct = await s.admin.get('/api/facility/compliance/tasks');
  assert.equal(ct.data.rows.length, 17);
  assert.ok(ct.data.counts.overdue >= 1 && ct.data.counts.soon >= 1 && ct.data.counts.needsCheck >= 5);
  assert.equal(ct.data.rows[0].state, 'overdue', '기한 지난 일정이 맨 위');
  const xray = ct.data.rows.find((t) => t.name.includes('진단용 방사선'));
  assert.equal(xray.cycleMonths, 36);
  assert.equal(xray.cycleLabel, '3년마다');
});

test('장비: 실장은 등록·수정, 직원은 등록 불가(403)·점검 기록은 가능', async () => {
  const bad = await staff.post('/api/facility/equipment', { name: '직원 장비', category: '기타' });
  assert.equal(bad.status, 403);

  const c = await manager.post('/api/facility/equipment', {
    name: '테스트 컴프레서',
    category: '컴프레서',
    inspectionCycleDays: 90,
    lastInspected: '2026-01-10',
    asContact: '테스트설비 02-000-0000',
  });
  assert.equal(c.status, 201);
  assert.equal(c.data.nextDue, '2026-04-10', '다음 점검일 = 마지막 점검일 + 90일');
  const id = c.data.id;

  // 직원이 정기 점검 기록 → 마지막 점검일·다음 점검일 갱신
  const log = await staff.post(`/api/facility/equipment/${id}/logs`, { date: '2026-03-01', type: '정기 점검', description: '필터 청소', cost: 50000 });
  assert.equal(log.status, 201);
  assert.equal(log.data.equipment.lastInspected, '2026-03-01');
  assert.equal(log.data.equipment.nextDue, '2026-05-30');

  // 예전 날짜 점검 기록은 마지막 점검일을 되돌리지 않음
  await staff.post(`/api/facility/equipment/${id}/logs`, { date: '2025-12-01', type: '법정 검사', description: '예전 기록' });
  let d = await staff.get(`/api/facility/equipment/${id}`);
  assert.equal(d.data.lastInspected, '2026-03-01');
  assert.equal(d.data.logs.length, 2);
  assert.equal(d.data.totalCost, 50000);
  assert.equal(d.data.canEdit, false);

  // 수리 기록으로 상태 변경 (수리 기록은 점검일을 바꾸지 않음)
  const fix = await staff.post(`/api/facility/equipment/${id}/logs`, { date: '2026-03-05', type: '수리', description: '모터 수리 의뢰', setStatus: '수리 중' });
  assert.equal(fix.data.equipment.status, '수리 중');
  assert.equal(fix.data.equipment.lastInspected, '2026-03-01');

  // 직원은 남의 기록 삭제 불가, 자기 기록 삭제 가능. 점검 기록을 지우면 이전 점검일로 되돌아감
  d = await staff.get(`/api/facility/equipment/${id}`);
  const inspection = d.data.logs.find((l) => l.date === '2026-03-01');
  assert.equal((await staff2.del(`/api/facility/equipment/logs/${inspection.id}`)).status, 403);
  const del = await staff.del(`/api/facility/equipment/logs/${inspection.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.equipment.lastInspected, '2025-12-01');

  // 수정·보관·삭제 (실장)
  assert.equal((await staff.patch(`/api/facility/equipment/${id}`, { name: 'x' })).status, 403);
  const u = await manager.patch(`/api/facility/equipment/${id}`, { status: '정상', location: '기계실', active: false });
  assert.equal(u.data.status, '정상');
  assert.equal(u.data.active, false);
  const list = await s.admin.get('/api/facility/equipment');
  assert.ok(!list.data.rows.some((e) => e.id === id), '보관한 장비는 기본 목록에서 빠짐');
  const archived = await s.admin.get('/api/facility/equipment?archived=1');
  assert.ok(archived.data.rows.some((e) => e.id === id));
  assert.equal((await manager.del(`/api/facility/equipment/${id}`)).status, 200);
  assert.equal((await s.admin.get(`/api/facility/equipment/${id}`)).status, 404);
});

test('장비 입력 검증: 이름 없음·잘못된 분류·잘못된 날짜는 400', async () => {
  const a = await s.admin.post('/api/facility/equipment', { name: '', category: '기타' });
  assert.equal(a.status, 400);
  assert.match(a.data.error.message, /장비 이름/);
  assert.equal((await s.admin.post('/api/facility/equipment', { name: 'x', category: '냉장고' })).status, 400);
  assert.equal((await s.admin.post('/api/facility/equipment', { name: 'x', category: '기타', lastInspected: '2026-13-01' })).status, 400);
  const eq = (await s.admin.get('/api/facility/equipment')).data.rows[0];
  assert.equal((await staff.post(`/api/facility/equipment/${eq.id}/logs`, { date: today(), type: '청소', description: 'x' })).status, 400);
});

test('멸균기가 있는 장비는 지울 수 없고 보관하도록 안내한다', async () => {
  const meta = await s.admin.get('/api/facility/sterilization/meta');
  const r = await s.admin.del(`/api/facility/equipment/${meta.data.sterilizers[0].id}`);
  assert.equal(r.status, 409);
  assert.match(r.data.error.message, /보관/);
});

test('멸균 기록: 빠른 입력 기본값, 저장, 중복 회차 막기, 환자 정보 막기', async () => {
  const meta = (await staff.get('/api/facility/sterilization/meta')).data;
  const ster = meta.sterilizers[1];
  const def = meta.defaults[ster.id];
  assert.ok(def.nextCycle >= 1);
  assert.ok(def.byProgram['일반'].temperature > 100);
  const date = addDays(today(), -100); // 다른 데모 기록과 겹치지 않는 날
  const body = { date, sterilizerId: ster.id, cycleNo: 1, program: '일반', temperature: 134, pressure: 210, durationMin: 15, ciResult: 'pass', loadDesc: '기구 파우치 25개' };
  const c = await staff.post('/api/facility/sterilization/logs', body);
  assert.equal(c.status, 201);
  assert.equal(c.data.operatorName, '멸균직원', '담당자를 비우면 기록한 사람');
  assert.equal(c.data.failed, false);
  // 다음 회차 기본값이 하나 늘어남
  const meta2 = (await staff.get(`/api/facility/sterilization/meta?date=${date}`)).data;
  assert.equal(meta2.defaults[ster.id].nextCycle, 2);
  // 같은 회차 두 번 → 409
  const dup = await staff.post('/api/facility/sterilization/logs', body);
  assert.equal(dup.status, 409);
  // 환자 정보처럼 보이는 내용 → 400
  const pii = await staff.post('/api/facility/sterilization/logs', { ...body, cycleNo: 2, loadDesc: '김민수 환자 기구 010-1234-5678' });
  assert.equal(pii.status, 400);
  assert.match(pii.data.error.message, /환자 정보/);
  // 멸균기가 아닌 장비 → 400
  const chair = (await staff.get('/api/facility/equipment')).data.rows.find((e) => e.category === '유니트체어');
  assert.equal((await staff.post('/api/facility/sterilization/logs', { ...body, cycleNo: 3, sterilizerId: chair.id })).status, 400);
  // 잘못된 결과 값 → 400
  assert.equal((await staff.post('/api/facility/sterilization/logs', { ...body, cycleNo: 4, ciResult: 'ok' })).status, 400);
  // 날짜나 월 없이 목록 → 400
  assert.equal((await staff.get('/api/facility/sterilization/logs')).status, 400);
  const day = await staff.get(`/api/facility/sterilization/logs?date=${date}`);
  assert.equal(day.data.rows.length, 1);
});

test('멸균 기록 권한: 남의 기록은 수정·삭제 불가, 실장은 가능', async () => {
  const meta = (await staff.get('/api/facility/sterilization/meta')).data;
  const ster = meta.sterilizers[0];
  const date = addDays(today(), -101);
  const c = await staff.post('/api/facility/sterilization/logs', { date, sterilizerId: ster.id, cycleNo: 1, program: '파우치', loadDesc: '핸드피스 8개' });
  assert.equal(c.status, 201);
  assert.equal(c.data.canEdit, true);
  assert.equal((await staff2.patch(`/api/facility/sterilization/logs/${c.data.id}`, { note: 'x' })).status, 403);
  assert.equal((await staff2.del(`/api/facility/sterilization/logs/${c.data.id}`)).status, 403);
  const u = await manager.patch(`/api/facility/sterilization/logs/${c.data.id}`, { durationMin: 20, note: '실장 확인' });
  assert.equal(u.status, 200);
  assert.equal(u.data.durationMin, 20);
  assert.equal(u.data.program, '파우치', '보내지 않은 칸은 그대로');
  assert.equal((await staff.del(`/api/facility/sterilization/logs/${c.data.id}`)).status, 200);
});

test('멸균 실패 → 경고(대시보드) → 조치 기록 → 경고 해제, BI 대기 → 나중에 입력', async () => {
  const meta = (await staff.get('/api/facility/sterilization/meta')).data;
  const ster = meta.sterilizers[1];
  const date = today();
  const day = (await staff.get(`/api/facility/sterilization/meta?date=${date}`)).data.defaults[ster.id].nextCycle;
  const fail = await staff.post('/api/facility/sterilization/logs', {
    date, sterilizerId: ster.id, cycleNo: day, program: '고속', ciResult: 'fail', biResult: 'pending', loadDesc: '핸드피스 6개', note: 'CI 변색 불충분',
  });
  assert.equal(fail.status, 201);
  assert.equal(fail.data.failed, true);
  let m = (await staff.get('/api/facility/sterilization/meta')).data;
  assert.ok(m.unresolved.some((x) => x.id === fail.data.id));
  assert.ok(m.pendingBi.some((x) => x.id === fail.data.id));
  let dash = (await staff.get('/api/dashboard')).data;
  const alert = dash.alerts.find((a) => a.id === `ster-fail-${fail.data.id}`);
  assert.ok(alert, '대시보드 경고');
  assert.equal(alert.level, 'danger');
  assert.ok(dash.todos.some((t) => t.id === 'ster-bi'), 'BI 대기 할 일');

  // 다른 직원이 BI 결과 입력 (대기 상태라 누구나 가능)
  const bi = await staff2.post(`/api/facility/sterilization/logs/${fail.data.id}/bi`, { result: 'pass' });
  assert.equal(bi.status, 200);
  assert.equal(bi.data.biResult, 'pass');
  // 이미 결과가 있으면 작성자·실장이 아닌 사람은 다시 못 바꿈
  assert.equal((await staff2.post(`/api/facility/sterilization/logs/${fail.data.id}/bi`, { result: 'fail' })).status, 400);

  // 조치 기록
  assert.equal((await staff2.post(`/api/facility/sterilization/logs/${fail.data.id}/resolve`, { actionNote: '' })).status, 400);
  const res = await staff2.post(`/api/facility/sterilization/logs/${fail.data.id}/resolve`, { actionNote: '해당 묶음 사용 보류 후 재멸균, 합격 확인' });
  assert.equal(res.status, 200);
  assert.equal(res.data.resolved, true);
  assert.equal(res.data.resolvedByName, '다른직원');
  m = (await staff.get('/api/facility/sterilization/meta')).data;
  assert.ok(!m.unresolved.some((x) => x.id === fail.data.id));
  dash = (await staff.get('/api/dashboard')).data;
  const after_ = dash.alerts.find((a) => a.id === `ster-fail-${fail.data.id}`);
  assert.ok(after_, '오늘 실패는 조치 후에도 경고 단계로 남음');
  assert.equal(after_.level, 'warn');
  // 합격 기록에는 조치를 남길 수 없음
  const okLog = (await staff.get(`/api/facility/sterilization/logs?date=${date}`)).data.rows.find((x) => !x.failed);
  if (okLog) assert.equal((await staff.post(`/api/facility/sterilization/logs/${okLog.id}/resolve`, { actionNote: '조치' })).status, 400);
});

test('법정 일정: 완료 처리 → 다음 일정 = 완료일 + 주기, 완료 취소 → 이전 값으로', async () => {
  const c = await manager.post('/api/facility/compliance/tasks', {
    name: '테스트 점검',
    category: '시설',
    cycleMonths: 6,
    lastDone: '2025-08-31',
  });
  assert.equal(c.status, 201);
  assert.equal(c.data.nextDue, '2026-02-28', '8월 31일 + 6개월 = 2월 말일');
  const id = c.data.id;

  // 직원도 완료 처리는 가능
  const done = await staff.post(`/api/facility/compliance/tasks/${id}/complete`, { doneDate: '2026-03-10', note: '완료' });
  assert.equal(done.status, 200);
  assert.equal(done.data.lastDone, '2026-03-10');
  assert.equal(done.data.nextDue, '2026-09-10');
  let d = (await staff.get(`/api/facility/compliance/tasks/${id}`)).data;
  assert.equal(d.logs.length, 1);
  assert.equal(d.logs[0].userName, '멸균직원');
  // 미래 날짜는 완료 불가
  assert.equal((await staff.post(`/api/facility/compliance/tasks/${id}/complete`, { doneDate: addDays(today(), 3) })).status, 400);

  // 직원은 완료 취소·수정 불가
  assert.equal((await staff.del(`/api/facility/compliance/logs/${d.logs[0].id}`)).status, 403);
  assert.equal((await staff.patch(`/api/facility/compliance/tasks/${id}`, { cycleMonths: 12 })).status, 403);

  // 실장이 완료 취소 → 이전 값으로 되돌아감
  const undo = await manager.del(`/api/facility/compliance/logs/${d.logs[0].id}`);
  assert.equal(undo.status, 200);
  assert.equal(undo.data.lastDone, '2025-08-31');
  assert.equal(undo.data.nextDue, '2026-02-28');

  // 주기를 바꾸면 다음 일정 다시 계산
  const u = await manager.patch(`/api/facility/compliance/tasks/${id}`, { cycleMonths: 12, needsCheck: true });
  assert.equal(u.data.nextDue, '2026-08-31');
  assert.equal(u.data.needsCheck, true);
  assert.equal(u.data.cycleLabel, '1년마다');
  // 다음 일정을 직접 적으면 그 값
  const u2 = await manager.patch(`/api/facility/compliance/tasks/${id}`, { nextDue: '2026-12-01' });
  assert.equal(u2.data.nextDue, '2026-12-01');

  // 수시(주기 없음) 항목은 완료 시 직접 적은 다음 일정 사용
  const once = await manager.post('/api/facility/compliance/tasks', { name: '수시 점검', category: '기타', needsCheck: true });
  assert.equal(once.data.cycleLabel, '수시·일회성');
  assert.equal(once.data.nextDue, null);
  const od = await staff.post(`/api/facility/compliance/tasks/${once.data.id}/complete`, { doneDate: today(), nextDue: addDays(today(), 200) });
  assert.equal(od.data.nextDue, addDays(today(), 200));

  // 보관·삭제
  const arch = await manager.patch(`/api/facility/compliance/tasks/${id}`, { active: false });
  assert.equal(arch.data.active, false);
  assert.equal((await manager.del(`/api/facility/compliance/tasks/${id}`)).status, 200);
  assert.equal((await manager.get(`/api/facility/compliance/tasks/${id}`)).status, 404);
});

test('법정 일정 입력 검증과 필터', async () => {
  assert.equal((await manager.post('/api/facility/compliance/tasks', { name: '', category: '시설' })).status, 400);
  assert.equal((await manager.post('/api/facility/compliance/tasks', { name: 'x', category: '없는분류' })).status, 400);
  assert.equal((await manager.post('/api/facility/compliance/tasks', { name: 'x', category: '시설', cycleMonths: 0 })).status, 400);
  assert.equal((await staff.post('/api/facility/compliance/tasks', { name: 'x', category: '시설' })).status, 403);
  const rad = await staff.get('/api/facility/compliance/tasks?category=' + encodeURIComponent('방사선'));
  assert.ok(rad.data.rows.length >= 4 && rad.data.rows.every((t) => t.category === '방사선'));
  const over = await staff.get('/api/facility/compliance/tasks?status=overdue');
  assert.ok(over.data.rows.length >= 1 && over.data.rows.every((t) => t.state === 'overdue'));
  const chk = await staff.get('/api/facility/compliance/tasks?status=check');
  assert.ok(chk.data.rows.every((t) => t.needsCheck));
  const inj = await staff.get(`/api/facility/compliance/tasks?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(inj.status, 200);
  assert.equal(inj.data.rows.length, 0);
});

test('대시보드: 다가오는 장비·법정 일정, 기한 지난 법정 일정 할 일', async () => {
  const dash = (await staff.get('/api/dashboard')).data;
  const fac = dash.upcoming.filter((u) => u.module === 'facility');
  assert.ok(fac.some((u) => u.href.startsWith('#/equipment/') && u.icon === 'wrench'));
  assert.ok(fac.some((u) => u.href.startsWith('#/compliance/') && u.icon === 'shield-check'));
  assert.ok(fac.every((u) => u.dday <= 30 && typeof u.date === 'string'));
  const todo = dash.todos.find((t) => t.id === 'compliance-overdue');
  assert.ok(todo);
  assert.equal(todo.level, 'danger');
});
