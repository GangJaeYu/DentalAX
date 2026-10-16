/*
 * 이 파일이 하는 일: 백업·복원·초기화 자동 테스트
 *  - 수동 백업 → 데이터 변경 → 복원하면 원래대로 돌아오는지
 *  - 복원 전 자동 백업, 잘못된 파일/이름 거부, 보관 개수 정리, 하루 한 번 자동 백업 판단
 *  - 초기화(업무 데이터 삭제, 계정·설정 유지)와 데모 데이터 다시 넣기
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, Client } = require('./helpers');

let s;
before(async () => {
  s = await startServer({ demo: true });
});
after(async () => s && s.close());

test('백업 → 변경 → 복원하면 백업 시점으로 돌아간다', async () => {
  const before1 = (await s.admin.get('/api/board/posts')).data.total;
  const b = await s.admin.post('/api/admin/backups');
  assert.equal(b.status, 201);
  assert.match(b.data.name, /^dentalax_\d{8}_\d{6}_manual\.db$/);
  assert.ok(fs.existsSync(path.join(s.dataDir, 'backups', b.data.name)));

  await s.admin.post('/api/board/posts', { kind: 'notice', title: '백업 후에 쓴 글' });
  assert.equal((await s.admin.get('/api/board/posts')).data.total, before1 + 1);

  const r = await s.admin.post(`/api/admin/backups/${b.data.name}/restore`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.preRestoreBackup, /prerestore/);
  // 복원 후에는 세션이 백업 시점 기준이므로 다시 로그인
  const c = new Client(s.base);
  await c.login('admin', 'Admin1234!');
  assert.equal((await c.get('/api/board/posts')).data.total, before1);
  const list = (await c.get('/api/admin/backups')).data.backups;
  assert.ok(list.some((x) => x.reason === 'prerestore'), '복원 전 상태도 백업으로 남음');
  s.admin = c;
});

test('백업 파일을 내려받을 수 있다', async () => {
  const list = (await s.admin.get('/api/admin/backups')).data.backups;
  const r = await s.admin.get(`/api/admin/backups/${list[0].name}/download`);
  assert.equal(r.status, 200);
  assert.equal(r.data.subarray(0, 15).toString('latin1'), 'SQLite format 3');
});

test('경로 조작 이름이나 엉뚱한 파일로는 복원할 수 없다', async () => {
  assert.equal((await s.admin.post('/api/admin/backups/..%2f..%2fdentalax.db/restore')).status, 400);
  assert.equal((await s.admin.post('/api/admin/backups/dentalax_20260101_000000_manual.db/restore')).status, 404);
  const bad = await s.admin.req('POST', '/api/admin/backups/upload', Buffer.from('this is not a database at all, just text'.repeat(5)));
  assert.equal(bad.status, 400);
  assert.match(bad.data.error.message, /백업 파일/);
});

test('다른 PC에서 가져온 백업 파일(업로드)로 복원할 수 있다', async () => {
  const list = (await s.admin.get('/api/admin/backups')).data.backups;
  const file = fs.readFileSync(path.join(s.dataDir, 'backups', list[list.length - 1].name));
  const r = await s.admin.req('POST', '/api/admin/backups/upload', file);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = new Client(s.base);
  assert.equal((await c.login('admin', 'Admin1234!')).status, 200);
  s.admin = c;
});

test('보관 개수를 넘으면 오래된 백업부터 지운다', async () => {
  await s.admin.put('/api/admin/backups/settings', { keep: 3, hour: 12, minute: 30 });
  const backup = require('../server/core/backup');
  const dir = backup.backupDir();
  // 날짜가 다른 오래된 백업 파일 5개를 흉내 냄
  for (let i = 1; i <= 5; i++) fs.copyFileSync(path.join(s.dataDir, 'dentalax.db'), path.join(dir, `dentalax_2025010${i}_120000_auto.db`));
  backup.createBackup('manual');
  const normal = backup.listBackups().filter((b) => b.reason !== 'prerestore');
  assert.equal(normal.length, 3);
  assert.ok(!normal.some((b) => b.name.startsWith('dentalax_2025010')), '가장 오래된 것부터 삭제');
});

test('자동 백업은 정해진 시각 이후 하루 한 번만 만든다', () => {
  const backup = require('../server/core/backup');
  const early = new Date();
  early.setHours(8, 0, 0, 0);
  assert.equal(backup.autoBackupTick(early), null, '12:30 전에는 만들지 않음');
  const late = new Date();
  late.setHours(15, 0, 0, 0);
  const first = backup.autoBackupTick(late);
  assert.ok(first && first.reason === 'auto');
  assert.equal(backup.autoBackupTick(late), null, '오늘 이미 만들었으면 다시 만들지 않음');
});

test('초기화하면 업무 데이터와 데모 직원이 지워지고 계정·설정은 남는다', async () => {
  assert.equal((await s.admin.post('/api/admin/reset', { confirm: '아니오' })).status, 400);
  const r = await s.admin.post('/api/admin/reset', { confirm: '초기화' });
  assert.equal(r.status, 200);
  assert.match(r.data.backup, /manual/);
  assert.equal((await s.admin.get('/api/board/posts')).data.total, 0);
  const users = (await s.admin.get('/api/admin/users')).data.users;
  assert.ok(users.every((u) => !u.isDemo));
  assert.ok(users.some((u) => u.username === 'admin'));
  const sys = (await s.admin.get('/api/admin/system')).data;
  assert.equal(sys.hasDemoData, false);
  // 초기화 뒤에도 실사용 기본 서식(법정 일정 항목·체크리스트 템플릿 등)은 다시 들어감
  const { get } = require('../server/core/db');
  assert.ok(get('SELECT COUNT(*) AS n FROM compliance_tasks').n >= 10);
  assert.equal(get('SELECT COUNT(*) AS n FROM compliance_tasks WHERE next_due IS NOT NULL').n, 0, '날짜는 비워 둠');
  assert.equal(get('SELECT COUNT(*) AS n FROM checklist_templates').n, 3);
  assert.equal(get('SELECT COUNT(*) AS n FROM checklist_runs').n, 0);
  assert.ok(get('SELECT COUNT(*) AS n FROM message_templates').n > 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM onboarding_templates').n, 2);
  // 다시 넣기 (기본 서식과 겹치지 않게 비우고 넣음)
  assert.equal((await s.admin.post('/api/admin/seed-demo')).status, 200);
  assert.ok((await s.admin.get('/api/board/posts')).data.total >= 5);
  assert.equal(get('SELECT COUNT(*) AS n FROM checklist_templates').n, 3, '템플릿 중복 없음');
  assert.equal(get('SELECT COUNT(*) AS n FROM onboarding_templates').n, 2);
});
