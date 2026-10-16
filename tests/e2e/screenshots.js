/*
 * 이 파일이 하는 일: README와 점검용 주요 화면 스크린샷을 docs/screenshots/ 에 찍습니다.  (npm run screenshots)
 *   새 데이터 + 데모 데이터로 서버를 따로 띄우므로 실제 data 폴더는 건드리지 않습니다.
 *   데스크톱(1440px), 태블릿(820px), 다크 모드를 함께 찍어 디자인 깨짐을 확인합니다.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, startServerProcess, launchBrowser, watchErrors, setupAndLogin, MASK_PRIVATE } = require('./lib');

const OUT = path.join(ROOT, 'docs', 'screenshots');

// [파일 이름, 화면 주소, 찍기 전에 기다릴 요소]
const PAGES = [
  ['dashboard', '', '.stat, .card'],
  ['board', 'board', '.list-item'],
  ['checklists', 'checklists', '.card'],
  ['comms', 'comms', '.card'],
  ['inventory', 'inventory', '.table, .card'],
  ['orders', 'orders', '.card'],
  ['vendors', 'vendors', '.card'],
  ['documents', 'documents', '.card'],
  ['minutes', 'minutes', '.card'],
  ['forms', 'forms', '.card'],
  ['schedule', 'schedule', '.card'],
  ['leave', 'leave', '.card'],
  ['training', 'training', '.card'],
  ['onboarding', 'onboarding', '.card'],
  ['equipment', 'equipment', '.card'],
  ['sterilization', 'sterilization', '.card'],
  ['compliance', 'compliance', '.card'],
  ['expenses', 'expenses', '.card'],
  ['assistant', 'assistant', '.card'],
  ['admin-ai', 'admin/ai', '.card'],
  ['admin-usage', 'admin/usage', '.card'],
  ['admin-backup', 'admin/backup', '.card'],
];

async function shoot(page, base, list, suffix) {
  for (const [name, hash, wait] of list) {
    await page.goto(`${base}/#/${hash}`);
    try {
      await page.waitForSelector(wait, { timeout: 8000 });
    } catch {
      /* 요소가 없어도 찍음 (빈 화면 점검) */
    }
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `${name}${suffix}.png`) });
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServerProcess({ port: Number(process.env.SHOT_PORT || 3970) });
  const browser = await launchBrowser();
  const errorLists = [];
  try {
    // 데스크톱 라이트
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await context.addInitScript(MASK_PRIVATE); // 이 PC의 폴더 경로·IP가 캡처에 찍히지 않게
    const page = await context.newPage();
    errorLists.push(watchErrors(page));
    // 첫 설정·로그인 화면
    await page.goto(server.base + '/');
    await page.waitForSelector('.auth-card');
    await page.screenshot({ path: path.join(OUT, 'setup.png') });
    await setupAndLogin(page, server.base);
    await shoot(page, server.base, PAGES, '');
    // 다크 모드
    await page.evaluate(() => localStorage.setItem('dx-theme', 'dark'));
    await page.reload();
    await page.waitForSelector('.sidebar');
    await shoot(page, server.base, PAGES.filter(([n]) => ['dashboard', 'inventory', 'schedule', 'assistant', 'expenses', 'board'].includes(n)), '-dark');
    await page.evaluate(() => localStorage.setItem('dx-theme', 'light'));
    // 태블릿 (같은 로그인 상태에서 화면 크기만 바꿈)
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.reload();
    await page.waitForSelector('.topbar');
    await shoot(page, server.base, PAGES.filter(([n]) => ['dashboard', 'inventory', 'schedule', 'sterilization', 'checklists'].includes(n)), '-tablet');
    console.log(`스크린샷 저장: ${OUT}`);
  } finally {
    await browser.close();
    await server.stop();
  }
  // watchErrors 가 돌려준 배열은 페이지에서 오류가 날 때마다 계속 채워지므로 마지막에 모아서 확인
  const errors = errorLists.flat();
  if (errors.length) {
    console.log('브라우저 오류:\n' + errors.join('\n'));
    process.exitCode = 1;
  } else console.log('브라우저 오류: 없음');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
