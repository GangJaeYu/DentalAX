/*
 * 이 파일이 하는 일: 관리자 비밀번호를 잊었을 때, 서버 PC에서 직접 임시 비밀번호로 바꿉니다.
 *   (reset-password.bat 을 더블클릭하면 실행됨. 서버 PC 앞에 있는 사람만 쓸 수 있으므로 안전합니다)
 *
 *   1) 로그인 계정 목록을 보여 주고  2) 아이디를 입력받아  3) 임시 비밀번호를 만들어 화면에 보여 줍니다.
 *   다음 로그인 때 새 비밀번호로 바꾸게 되며, 그 계정의 잠금도 풀리고 기존 로그인은 끊깁니다.
 */
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const cfg = require('../server/core/config');
const db = require('../server/core/db');
const auth = require('../server/core/auth');
const { audit } = require('../server/core/audit');

function tempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[crypto.randomInt(chars.length)];
  return s[0].toUpperCase() + s.slice(1) + crypto.randomInt(100, 999) + '!';
}

async function main() {
  const file = path.join(cfg.config.dataDir, 'dentalax.db');
  db.open(file);
  const users = db.all("SELECT id, name, username, role, status FROM users WHERE username IS NOT NULL ORDER BY role = 'admin' DESC, id");
  if (!users.length) {
    console.log('로그인 계정이 없습니다. start.bat 으로 서버를 켜면 "처음 설정" 화면이 나옵니다.');
    return;
  }
  console.log('\n로그인 계정 목록');
  for (const u of users) console.log(`  - ${u.username}  (${u.name}, ${auth.ROLE_LABEL[u.role]}${u.status === 'inactive' ? ', 비활성' : ''})`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question('\n비밀번호를 초기화할 아이디를 입력하세요: ', r));
  rl.close();
  const u = db.get('SELECT * FROM users WHERE username = ?', answer.trim());
  if (!u) {
    console.log('그런 아이디가 없습니다.');
    return;
  }
  const pw = tempPassword();
  db.run(
    "UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL, status = 'active', updated_at = ? WHERE id = ?",
    auth.hashPassword(pw),
    new Date().toISOString(),
    u.id
  );
  auth.revokeUserSessions(u.id);
  audit({ user: null, auditName: '서버 PC(비밀번호 초기화 도구)', socket: { remoteAddress: '127.0.0.1' } }, 'reset_password', 'users', u.id, `서버 PC에서 비밀번호 초기화: ${u.username}`);
  console.log(`\n완료! 아이디 ${u.username} 의 임시 비밀번호: ${pw}`);
  console.log('로그인하면 새 비밀번호로 바꾸라는 화면이 나옵니다.\n');
}

main()
  .catch((e) => console.error('[오류]', e.message))
  .finally(() => db.close());
