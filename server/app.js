/*
 * 이 파일이 하는 일: 웹 서버를 조립합니다. 요청이 들어오면 아래 순서대로 검사·처리됩니다.
 *
 *   원내 네트워크인가? → 주소 이름이 정상인가? → 보안 머리글 붙이기
 *   → (API라면) 내용 읽기 → 로그인 확인 → CSRF 확인 → 로그인·첫 설정 API / 모듈별 API
 *   → (화면 파일이라면) public 폴더에서 보내기
 *   → 오류가 나면 쉬운 한국어 안내로 바꾸기
 *
 * init()   : DB를 열고 표를 준비 (서버 시작 시 한 번)
 * createApp(): Express 앱을 만듦 (테스트에서도 사용)
 */
const path = require('node:path');
const express = require('express');
const cfg = require('./core/config');
const db = require('./core/db');
const coreSchema = require('./core/schema');
const security = require('./core/security');
const auth = require('./core/auth');
const { errorHandler, HttpError } = require('./core/errors');
const backup = require('./core/backup');
const aiService = require('./ai/service');
const modules = require('./modules');
const authRoutes = require('./routes/auth');

/** 모든 표 만들기/갱신 */
function migrateAll() {
  db.migrate([...coreSchema, ...modules.flatMap((m) => m.migrations || [])]);
}

/** DB를 열고 준비합니다. dbFile을 주지 않으면 data/dentalax.db */
function init(dbFile) {
  const file = dbFile || path.join(cfg.config.dataDir, 'dentalax.db');
  db.open(file);
  migrateAll();
  aiService.registerFeatures(modules.flatMap((m) => m.aiFeatures || []));
  // 복원 후 DB를 다시 열었을 때도 표 구조를 최신으로 맞춤 (옛날 버전 백업을 복원한 경우 대비)
  backup.setReopenHook(() => migrateAll());
  auth.purgeExpiredSessions();
  return file;
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', 'strong');

  app.use(security.lanOnly);
  app.use(security.hostCheck);
  app.use(security.securityHeaders);

  // API 요청 본문(JSON) 읽기. 파일 올리기(서식 보관함)는 base64로 JSON에 담아 오므로 넉넉하게 30MB
  app.use('/api', express.json({ limit: '30mb' }));
  app.use('/api', auth.loadSession);
  app.use('/api', security.csrfProtect);

  // 로그인·첫 설정 (로그인 전에도 쓸 수 있는 유일한 API)
  app.use('/api/auth', authRoutes());

  // 업무 모듈 API — 모두 로그인 필수
  for (const mod of modules) {
    if (!mod.register) continue;
    const router = express.Router();
    router.use(auth.requireAuth);
    mod.register(router);
    app.use(`/api/${mod.name}`, router);
  }

  app.use('/api', (req, res, next) => next(new HttpError(404, '없는 API 주소입니다.')));

  // 화면 파일 (HTML, CSS, JS, 글꼴)
  const pub = path.join(cfg.ROOT, 'public');
  app.use(
    express.static(pub, {
      index: 'index.html',
      dotfiles: 'deny',
      setHeaders(res, filePath) {
        // 글꼴은 거의 바뀌지 않으니 오래 보관, 나머지는 매번 바뀌었는지 확인 (업데이트가 바로 보이도록)
        if (filePath.endsWith('.woff2')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  app.use(errorHandler);
  return app;
}

module.exports = { init, createApp, migrateAll };
