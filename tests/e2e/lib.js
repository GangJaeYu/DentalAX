/*
 * 이 파일이 하는 일: 브라우저 자동 테스트(E2E)와 화면 점검에서 공통으로 쓰는 도구입니다.
 *
 *  - startServerProcess(): 임시 데이터 폴더로 실제 서버(server/index.js)를 따로 띄움
 *  - launchBrowser(): 이 PC에 설치된 Microsoft Edge(없으면 Chrome)를 화면 없이(headless) 실행
 *  - watchErrors(page): 브라우저 콘솔 오류·보안정책(CSP) 위반·화면 오류를 모아 둠
 *
 * 브라우저를 따로 내려받지 않고 Windows 기본 Edge를 씁니다 (playwright-core 사용).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

async function waitForHttp(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* 아직 안 켜짐 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('서버가 켜지지 않았습니다: ' + url);
}

/** 새 데이터 폴더로 서버를 띄움. { base, dataDir, stop() } */
async function startServerProcess({ port, dataDir, env = {}, lan = false } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'dentalax-e2e-'));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, DENTALAX_DATA_DIR: dir, DENTALAX_PORT: String(port), DENTALAX_OPEN_BROWSER: 'false', DENTALAX_HOST: lan ? '0.0.0.0' : '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  // lan=true 이면 직원 PC처럼 원내 IP 주소(http://192.168.x.x)로 접속 — 브라우저가 "덜 안전한 주소"로 취급하는 실제 환경과 같게 시험
  const lanIp = lan ? require('../../server/index').lanAddresses()[0] : null;
  const base = `http://${lanIp || '127.0.0.1'}:${port}`;
  await waitForHttp(base + '/api/auth/status');
  return {
    base,
    dataDir: dir,
    log: () => log,
    async stop({ keepData = false } = {}) {
      child.kill();
      await new Promise((r) => setTimeout(r, 300));
      if (!keepData && !dataDir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function launchBrowser() {
  const { chromium } = require('playwright-core');
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* 다음 브라우저 시도 */
    }
  }
  throw new Error('Microsoft Edge 또는 Chrome을 찾지 못했습니다.');
}

/** 페이지에서 나는 오류를 모음 (테스트 끝에 비어 있어야 정상) */
function watchErrors(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500) errors.push(`[http ${r.status()}] ${r.url()}`);
  });
  return errors;
}

/** API로 첫 설정(관리자 + 데모 데이터)을 하고, 브라우저를 로그인 상태로 만듦 */
async function setupAndLogin(page, base, { username = 'admin', password = 'Admin1234!', demo = true } = {}) {
  const status = await (await fetch(base + '/api/auth/status')).json();
  if (status.setupRequired) {
    const r = await fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clinicName: '하늘치과의원', name: '김하늘', username, password, demo }),
    });
    if (!r.ok) throw new Error('setup 실패: ' + (await r.text()));
  }
  await page.goto(base + '/');
  await page.waitForSelector('.auth-card');
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
  await page.waitForSelector('.sidebar');
}

/**
 * 캡처·영상에 이 PC의 정보(사용자 폴더 경로, 원내 IP)가 찍히지 않도록 화면 글자를 일반적인 값으로 바꿔 보여 줌
 * (브라우저 context.addInitScript(MASK_PRIVATE) 로 붙여 씀. 서버·데이터는 바꾸지 않고 화면 표시만 바꿈)
 */
const MASK_PRIVATE = () => {
  const fix = (n) => {
    const t = n.nodeValue;
    if (!t) return;
    const r = t
      .replace(/[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\Temp\\dentalax-[a-z0-9-]+/gi, 'C:\\DentalAX\\data')
      .replace(/192\.168\.\d+\.\d+/g, '192.168.0.10');
    if (r !== t) n.nodeValue = r;
  };
  const walk = (root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) fix(n);
  };
  const start = () => {
    walk(document.body);
    new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === 'characterData') fix(m.target);
        for (const a of m.addedNodes) {
          if (a.nodeType === 3) fix(a);
          else if (a.nodeType === 1) walk(a);
        }
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
};

module.exports = { MASK_PRIVATE, ROOT, startServerProcess, launchBrowser, watchErrors, setupAndLogin, waitForHttp };
