/*
 * 이 파일이 하는 일: 개발 중에 화면들을 빠르게 점검하는 도구입니다. (자동 테스트 아님, 사람이 결과를 봄)
 *   새 데이터로 서버를 띄우고 → 데모 데이터로 로그인 → 지정한 화면들을 열어 스크린샷을 찍고 → 브라우저 오류를 출력합니다.
 *
 * 사용법:
 *   node tests/e2e/pagecheck.js --port 3901 --out <스크린샷 폴더> --pages "inventory,orders,board/1" [--width 1440] [--dark]
 *   (화면 주소는 #/ 를 뺀 부분만 적습니다. 대시보드는 "home")
 */
const fs = require('node:fs');
const path = require('node:path');
const { startServerProcess, launchBrowser, watchErrors, setupAndLogin } = require('./lib');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

(async () => {
  const port = Number(arg('port', 3950));
  const out = path.resolve(arg('out', 'pagecheck-shots'));
  // Git Bash가 /로 시작하는 값을 경로로 바꾸는 경우까지 정리
  const pages = String(arg('pages', 'home'))
    .split(',')
    .map((s) => s.trim().replace(/^.*\/Git\//, '').replace(/^#?\/?/, '').replace(/^home$/, ''))
    .filter((s) => s !== undefined);
  const width = Number(arg('width', 1440));
  const dark = !!arg('dark', false);
  fs.mkdirSync(out, { recursive: true });

  const server = await startServerProcess({ port });
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = watchErrors(page);
  try {
    await setupAndLogin(page, server.base);
    if (dark) {
      await page.evaluate(() => localStorage.setItem('dx-theme', 'dark'));
      await page.reload();
      await page.waitForSelector('.sidebar');
    }
    for (const h of pages) {
      await page.goto(server.base + '/#/' + h);
      await page.waitForTimeout(900);
      const name = h.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'home';
      const file = path.join(out, `${name}${dark ? '_dark' : ''}_${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log('스크린샷:', file);
    }
  } finally {
    console.log('브라우저 오류:', errors.length ? '\n' + errors.join('\n') : '없음');
    await browser.close();
    await server.stop();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
