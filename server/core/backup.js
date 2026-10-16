/*
 * 이 파일이 하는 일: DB 백업과 복원을 담당합니다.
 *
 *  - 백업 파일은 data/backups/ 폴더에 dentalax_날짜_시각_종류.db 이름으로 쌓입니다.
 *  - SQLite의 VACUUM INTO 명령으로 "사용 중에도 깨지지 않는" 완전한 사본을 만듭니다.
 *  - 하루 한 번 자동 백업: 정해 둔 시각(기본 12:30)이 지났는데 오늘 자동 백업이 없으면 실행합니다.
 *    (PC를 밤에 끄는 병원이 많아서 "새벽 3시" 같은 고정 시각 대신 이렇게 정했습니다.)
 *  - 보관 개수(기본 30개)를 넘으면 가장 오래된 것부터 지웁니다. 단, "복원 전" 백업은 지우지 않습니다.
 *  - 복원할 때는 먼저 지금 상태를 "복원 전" 백업으로 남겨 두어, 잘못 복원해도 되돌릴 수 있습니다.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const db = require('./db');
const cfg = require('./config');
const { getSetting } = require('./settings');
const time = require('./time');
const { HttpError } = require('./errors');

const NAME_RE = /^dentalax_(\d{8})_(\d{6})_(auto|manual|prerestore|upload)\.db$/;
const REASON_LABEL = { auto: '자동', manual: '수동', prerestore: '복원 전', upload: '올린 파일' };

let reopenHook = null; // 복원 후 DB를 다시 열 때 실행할 함수 (app.js 에서 등록)

function backupDir() {
  return path.join(cfg.config.dataDir, 'backups');
}

function stamp(d = new Date()) {
  const p = time.pad;
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 지금 DB의 사본을 만듭니다. reason: auto / manual / prerestore */
function createBackup(reason = 'manual') {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  let name = `dentalax_${stamp()}_${reason}.db`;
  // 같은 초에 두 번 만들면 이름이 겹치므로 1초 뒤 시각으로
  let n = 0;
  while (fs.existsSync(path.join(dir, name)) && n < 5) {
    n++;
    name = `dentalax_${stamp(new Date(Date.now() + n * 1000))}_${reason}.db`;
  }
  const file = path.join(dir, name);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const info = describeFile(name);
  prune(name);
  return info;
}

function describeFile(name) {
  const m = name.match(NAME_RE);
  const full = path.join(backupDir(), name);
  const st = fs.statSync(full);
  let createdAt = st.mtime.toISOString();
  if (m) {
    const [, d, t] = m;
    createdAt = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6)).toISOString();
  }
  const reason = m ? m[3] : 'manual';
  return { name, size: st.size, createdAt, reason, reasonLabel: REASON_LABEL[reason] || reason };
}

function listBackups() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => NAME_RE.test(n))
    .map(describeFile)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 보관 개수를 넘는 오래된 백업 정리 ("복원 전" 백업은 최근 5개 유지). protect: 방금 만든 파일은 절대 지우지 않음 */
function prune(protect) {
  const keep = Math.max(3, Number(getSetting('backup').keep) || 30);
  const list = listBackups();
  const normal = list.filter((b) => b.reason !== 'prerestore');
  const pre = list.filter((b) => b.reason === 'prerestore');
  for (const b of normal.slice(keep)) if (b.name !== protect) fs.rmSync(path.join(backupDir(), b.name), { force: true });
  for (const b of pre.slice(5)) if (b.name !== protect) fs.rmSync(path.join(backupDir(), b.name), { force: true });
}

/** 백업 파일 이름이 안전한지 확인하고 전체 경로를 돌려줌 (../ 같은 경로 조작 차단) */
function resolveBackup(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new HttpError(400, '백업 파일 이름이 올바르지 않습니다.');
  const full = path.join(backupDir(), name);
  if (!fs.existsSync(full)) throw new HttpError(404, '백업 파일을 찾을 수 없습니다.');
  return full;
}

/** 이 파일이 DentalAX DB가 맞는지 확인 */
function validateDbFile(file) {
  let test;
  try {
    test = new DatabaseSync(file, { readOnly: true });
    const ok = test.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','_migrations','settings')").all();
    if (ok.length < 3) throw new Error('missing tables');
    const integrity = test.prepare('PRAGMA quick_check').get();
    if (Object.values(integrity)[0] !== 'ok') throw new Error('integrity');
  } catch {
    throw new HttpError(400, 'DentalAX 백업 파일이 아니거나 파일이 손상되었습니다.');
  } finally {
    try {
      test && test.close();
    } catch {
      /* 무시 */
    }
  }
}

/** 백업 파일(경로)로 지금 DB를 바꿔 넣습니다 */
function restoreFromFile(srcFile) {
  validateDbFile(srcFile);
  const pre = createBackup('prerestore');
  const target = db.currentFile();
  const tmp = target + '.restoring';
  fs.copyFileSync(srcFile, tmp);
  db.close();
  try {
    fs.copyFileSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
    // 혹시 남아 있을 수 있는 임시 저널 파일 정리
    fs.rmSync(target + '-journal', { force: true });
    db.open(target);
    if (reopenHook) reopenHook();
  }
  return { preRestoreBackup: pre.name };
}

function restoreBackup(name) {
  return restoreFromFile(resolveBackup(name));
}

/** 화면에서 올린 백업 파일(내용)로 복원 */
function restoreFromUpload(buffer) {
  if (!buffer || buffer.length < 100) throw new HttpError(400, '올린 파일이 비어 있습니다.');
  // SQLite 파일은 항상 "SQLite format 3" 으로 시작함
  if (buffer.subarray(0, 15).toString('latin1') !== 'SQLite format 3') {
    throw new HttpError(400, 'DentalAX 백업 파일(.db)이 아닙니다.');
  }
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `dentalax_${stamp()}_upload.db`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  try {
    return { ...restoreFromFile(file), uploadedAs: name };
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
}

function setReopenHook(fn) {
  reopenHook = fn;
}

/** 오늘 자동 백업이 이미 있는지 */
function hasAutoBackupToday() {
  const today = time.today().replace(/-/g, '');
  return listBackups().some((b) => b.reason === 'auto' && b.name.includes(`_${today}_`));
}

/** 자동 백업이 필요하면 실행 (10분마다 호출됨) */
function autoBackupTick(now = new Date()) {
  // 첫 설정 전(빈 DB)에는 백업할 것이 없음
  if (db.get("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL").n === 0) return null;
  const s = getSetting('backup');
  const due = now.getHours() > s.hour || (now.getHours() === s.hour && now.getMinutes() >= s.minute);
  if (!due || hasAutoBackupToday()) return null;
  try {
    const b = createBackup('auto');
    console.log(`[백업] 자동 백업 완료: ${b.name}`);
    return b;
  } catch (e) {
    console.error('[백업] 자동 백업 실패:', e.message);
    return null;
  }
}

let timer = null;
function startScheduler() {
  stopScheduler();
  autoBackupTick();
  timer = setInterval(() => autoBackupTick(), 10 * 60 * 1000);
  timer.unref();
}
function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  createBackup,
  listBackups,
  resolveBackup,
  restoreBackup,
  restoreFromUpload,
  validateDbFile,
  setReopenHook,
  autoBackupTick,
  startScheduler,
  stopScheduler,
  backupDir,
};
