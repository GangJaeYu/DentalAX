/*
 * 이 파일이 하는 일: AI API 키 같은 비밀값을 암호화해서 저장하고 꺼냅니다.
 *
 * 어떻게 지키나:
 *   - 비밀값은 AES-256-GCM 방식으로 암호화해 DB의 secrets 표에 저장합니다.
 *   - 암호를 푸는 열쇠는 DB가 아닌 별도 파일(data/secret.key)에 있습니다.
 *     그래서 DB 파일(또는 백업 파일)만 유출돼서는 키 내용을 알 수 없습니다.
 *   - 저장된 키는 화면(브라우저)으로 절대 다시 보내지 않고, 끝 4자리만 보여 줍니다.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { get, run, all } = require('./db');
const cfg = require('./config');

let masterKey = null;

function keyFile() {
  return path.join(cfg.config.dataDir, 'secret.key');
}

/** 열쇠 파일을 읽고, 없으면 무작위로 새로 만듭니다 */
function loadMasterKey() {
  if (masterKey) return masterKey;
  const file = keyFile();
  if (fs.existsSync(file)) {
    const buf = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (buf.length === 32) {
      masterKey = buf;
      return masterKey;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  masterKey = crypto.randomBytes(32);
  fs.writeFileSync(file, masterKey.toString('base64'), { mode: 0o600 });
  return masterKey;
}

/** 테스트에서 데이터 폴더를 바꿀 때 열쇠를 다시 읽게 함 */
function resetMasterKeyCache() {
  masterKey = null;
}

function setSecret(name, value) {
  const key = loadMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const hint = String(value).slice(-4);
  run(
    `INSERT INTO secrets (name, ciphertext, iv, tag, hint, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
       hint = excluded.hint, updated_at = excluded.updated_at`,
    name,
    enc.toString('base64'),
    iv.toString('base64'),
    tag.toString('base64'),
    hint,
    new Date().toISOString()
  );
}

/** 비밀값 꺼내기. 없거나(또는 다른 PC의 열쇠로 암호화돼서) 풀 수 없으면 null */
function getSecret(name) {
  const row = get('SELECT * FROM secrets WHERE name = ?', name);
  if (!row) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadMasterKey(), Buffer.from(row.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function deleteSecret(name) {
  run('DELETE FROM secrets WHERE name = ?', name);
}

/** 화면에 보여 줄 요약 (저장 여부, 끝 4자리, 풀 수 있는지) — 키 자체는 포함하지 않음 */
function secretStatus() {
  const out = {};
  for (const row of all('SELECT name, hint, updated_at FROM secrets')) {
    out[row.name] = { saved: true, hint: row.hint, updatedAt: row.updated_at, readable: getSecret(row.name) !== null };
  }
  return out;
}

module.exports = { setSecret, getSecret, deleteSecret, secretStatus, loadMasterKey, resetMasterKeyCache };
