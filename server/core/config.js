/*
 * 이 파일이 하는 일: 서버 실행 설정(포트, 데이터 폴더, 외부 접속 허용 여부 등)을 읽어 옵니다.
 *
 * 설정을 정하는 순서 (뒤에 오는 것이 이깁니다)
 *   1) 아래 DEFAULTS (기본값)
 *   2) 프로젝트 폴더의 config.json 파일 (없으면 건너뜀)
 *   3) 환경 변수 (DENTALAX_PORT 등) — 주로 테스트에서 사용
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const DEFAULTS = {
  port: 3800,
  // 0.0.0.0 = 이 PC의 모든 네트워크 카드에서 접속을 받음 (원내 다른 PC/태블릿 접속용)
  host: '0.0.0.0',
  // false = 원내(사설) 네트워크 주소에서 온 접속만 허용
  allowExternal: false,
  dataDir: path.join(ROOT, 'data'),
  // 브라우저 자동 열기 (start.bat에서 사용)
  openBrowser: true,
};

function loadConfig() {
  const cfg = { ...DEFAULTS };
  const file = path.join(ROOT, 'config.json');
  if (fs.existsSync(file)) {
    try {
      const fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
      Object.assign(cfg, fromFile);
    } catch (e) {
      console.error('[설정] config.json 파일을 읽지 못했습니다. 기본값으로 실행합니다:', e.message);
    }
  }
  const env = process.env;
  if (env.DENTALAX_PORT) cfg.port = Number(env.DENTALAX_PORT);
  if (env.DENTALAX_HOST) cfg.host = env.DENTALAX_HOST;
  if (env.DENTALAX_DATA_DIR) cfg.dataDir = path.resolve(env.DENTALAX_DATA_DIR);
  if (env.DENTALAX_ALLOW_EXTERNAL) cfg.allowExternal = env.DENTALAX_ALLOW_EXTERNAL === 'true';
  if (env.DENTALAX_OPEN_BROWSER) cfg.openBrowser = env.DENTALAX_OPEN_BROWSER === 'true';
  // 데이터 폴더가 상대 경로로 적혀 있으면 프로젝트 폴더 기준으로 바꿈
  if (!path.isAbsolute(cfg.dataDir)) cfg.dataDir = path.join(ROOT, cfg.dataDir);
  return cfg;
}

let current = loadConfig();

module.exports = {
  ROOT,
  get config() {
    return current;
  },
  // 테스트에서 설정을 바꿔 다시 읽을 때 사용
  reloadConfig() {
    current = loadConfig();
    return current;
  },
};
