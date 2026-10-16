/*
 * 이 파일이 하는 일: 실제 브라우저(Edge)로 사람이 쓰는 흐름을 처음부터 끝까지 따라 해 보는 E2E 테스트입니다.  (npm run test:e2e)
 *
 *   새 서버(빈 DB) → 첫 설정 화면에서 관리자 만들기(데모 데이터 포함) → 대시보드
 *   → 모듈별 핵심 작업 (공지 쓰기+AI, 체크리스트, 입출고, 발주서, 문서 작성, 회의록, 서식 올리기, 근무표, 연차 신청·승인,
 *      교육 기록, 장비 점검, 멸균 기록, 법정 일정 완료, 지출, AI 도우미, 관리)
 *   → 직원 계정으로 로그인해 권한 제한 확인 → XSS 방어 확인 → 태블릿 화면
 * 각 단계에서 브라우저 오류(콘솔 오류, 화면 오류, 서버 500)가 없어야 통과입니다.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { startServerProcess, launchBrowser, watchErrors } = require('./lib');

const results = [];
let currentPage = null;
const FAIL_DIR = path.join(os.tmpdir(), 'dentalax-e2e-fail');
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`  ✔ ${name} (${Date.now() - t}ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✖ ${name}\n      ${String(e.message).split('\n')[0]}`);
    // 실패한 순간의 화면을 남겨 원인을 찾기 쉽게
    if (currentPage) {
      fs.mkdirSync(FAIL_DIR, { recursive: true });
      const file = path.join(FAIL_DIR, `${results.length}.png`);
      await currentPage.screenshot({ path: file }).catch(() => {});
      console.log(`      화면: ${file} / 주소: ${currentPage.url()}`);
    }
  }
}

/** 버튼 이름으로 누르기 */
async function clickButton(page, text, scope = '') {
  await page.locator(`${scope} button:has-text("${text}")`).first().click();
}

async function expectToast(page, re) {
  const t = page.locator('.toast').filter({ hasText: re }).first();
  await t.waitFor({ timeout: 8000 });
}

(async () => {
  // 직원 PC·태블릿과 같은 조건(원내 IP + http)으로 시험. E2E_LOCAL=1 이면 127.0.0.1 사용
  const server = await startServerProcess({ port: Number(process.env.E2E_PORT || 3980), lan: process.env.E2E_LOCAL !== '1' });
  console.log(`E2E 서버 주소: ${server.base}`);
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  currentPage = page;
  page.setDefaultTimeout(10000);
  const B = server.base;
  const modules = require('./flows');

  try {
    await step('첫 설정 화면에서 관리자 계정 만들기(데모 데이터 포함)', async () => {
      await page.goto(B + '/');
      await page.waitForSelector('.auth-card');
      await page.fill('input[name=clinicName]', '하늘치과의원');
      await page.fill('input[name=name]', '김하늘');
      await page.fill('input[name=username]', 'drkim');
      await page.fill('input[name=password]', 'Sky12345!');
      await page.fill('input[name=password2]', 'Sky12345!');
      await page.click('button[type=submit]');
      await page.waitForSelector('.sidebar');
      await page.waitForSelector('.page-title');
      assert.match(await page.textContent('.page-title'), /김하늘님/);
    });

    await step('대시보드: 오늘 할 일·재고 경고·일정·공지·근무가 보인다', async () => {
      await page.goto(B + '/#/');
      await page.waitForSelector('.dash-grid');
      const text = await page.textContent('.dash-grid');
      for (const t of ['오늘 할 일', '재고 경고', '다가오는 점검', '공지', '오늘 근무']) assert.ok(text.includes(t), t);
      assert.ok((await page.locator('.dash-grid .list-item').count()) >= 5, '대시보드 항목이 비어 있지 않음');
    });

    await step('공지 쓰기: 메모 → AI 다듬기(개인정보 가림) → 적용 → 등록', async () => {
      await page.goto(B + '/#/board');
      await clickButton(page, '새 글');
      await page.fill('.modal textarea', '다음주 월요일 오전 8시 반 전체 회의. 홍길동 환자 010-1234-5678 리콜 확인');
      await clickButton(page, 'AI로 다듬기', '.modal');
      await page.waitForSelector('.modal .ai-panel-body');
      assert.match(await page.textContent('.modal .ai-panel-body'), /가리고 보냈습니다/);
      assert.ok(!(await page.textContent('.modal .ai-panel-body')).includes('010-1234-5678'));
      await clickButton(page, '이 내용으로 바꾸기', '.modal');
      assert.ok((await page.inputValue('.modal input[name=title]')).length > 0);
      await page.click('.modal-footer button:has-text("등록")');
      await page.waitForURL(/#\/board\/\d+/);
      await page.waitForSelector('.prose');
    });

    await step('XSS 방어: 글에 넣은 스크립트가 실행되지 않고 글자로만 보인다', async () => {
      const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
      await page.goto(B + '/#/board');
      await clickButton(page, '새 글');
      await page.fill('.modal input[name=title]', 'XSS 테스트 ' + payload);
      await page.fill('.modal textarea', '본문 ' + payload + '\n**굵게** [링크](javascript:alert(1))');
      await page.click('.modal-footer button:has-text("등록")');
      await page.waitForURL(/#\/board\/\d+/);
      await page.waitForSelector('.prose');
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      assert.ok((await page.textContent('.prose')).includes('<img src=x'));
      assert.equal(await page.locator('.prose img').count(), 0);
      assert.equal(await page.locator('.prose a[href^="javascript"]').count(), 0);
    });

    for (const flow of modules) {
      await step(flow.name, () => flow.run(page, B, { clickButton, expectToast }));
    }

    await step('원내 AI 도우미: 질문 → 근거 문서 카드 → 원문 보기', async () => {
      await page.goto(B + '/#/assistant');
      await page.waitForSelector('.asst-input');
      await page.fill('.asst-input', '연차는 며칠 전에 신청해야 하나요?');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.asst-source', { timeout: 15000 });
      await page.click('.asst-source');
      await page.waitForSelector('.modal .prose');
      await page.keyboard.press('Escape');
    });

    await step('관리: 직원 계정 만들기 → 임시 비밀번호 확인', async () => {
      await page.goto(B + '/#/admin/users');
      await clickButton(page, '직원 추가');
      await page.fill('.modal input[name=name]', '테스트직원');
      await page.fill('.modal input[name=username]', 'e2estaff');
      await page.fill('.modal input[name=password]', 'Temp1234!');
      await page.click('.modal-footer button:has-text("저장")');
      await page.waitForSelector('.modal-title:has-text("임시 비밀번호")');
      await clickButton(page, '확인했습니다');
    });

    await step('관리: 지금 백업 → 목록에 생김', async () => {
      await page.goto(B + '/#/admin/backup');
      await clickButton(page, '지금 백업');
      await expectToast(page, /백업했습니다/);
      assert.ok((await page.locator('.table tbody tr').count()) >= 1);
    });

    await step('관리: AI 설정 저장, 사용량·활동 기록 화면', async () => {
      await page.goto(B + '/#/admin/ai');
      await page.waitForSelector('text=API 키');
      await clickButton(page, 'AI 설정 저장');
      await expectToast(page, /저장했습니다/);
      await page.goto(B + '/#/admin/usage');
      await page.waitForSelector('.stat');
      await page.goto(B + '/#/admin/audit');
      await page.waitForSelector('.table');
      assert.ok((await page.locator('.table tbody tr').count()) > 5);
    });

    await step('Ctrl+K 빠른 이동', async () => {
      await page.goto(B + '/#/');
      await page.waitForSelector('.dash-grid');
      await page.keyboard.press('Control+k');
      await page.fill('.modal input', '멸균');
      await page.keyboard.press('Enter');
      await page.waitForURL(/#\/sterilization/);
    });

    await step('직원 계정: 첫 로그인 비밀번호 변경 → 관리 메뉴 안 보임 → 관리자 화면 직접 접근 차단', async () => {
      const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      const p2 = await ctx2.newPage();
      const err2 = watchErrors(p2);
      await p2.goto(B + '/');
      await p2.fill('input[name=username]', 'e2estaff');
      await p2.fill('input[name=password]', 'Temp1234!');
      await p2.click('button[type=submit]');
      await p2.waitForSelector('text=비밀번호 바꾸기');
      await p2.fill('input[name=current]', 'Temp1234!');
      await p2.fill('input[name=next]', 'Staff5678!');
      await p2.fill('input[name=next2]', 'Staff5678!');
      await p2.click('button[type=submit]');
      await p2.waitForSelector('.sidebar');
      const nav = await p2.textContent('.nav');
      assert.ok(!nav.includes('관리'), '관리 메뉴 숨김');
      assert.ok(!nav.includes('지출'), '지출 메뉴 숨김');
      await p2.goto(B + '/#/admin/users');
      await p2.waitForSelector('text=권한이 없습니다');
      await p2.goto(B + '/#/expenses');
      await p2.waitForSelector('text=권한이 없습니다');
      assert.deepEqual(err2.filter((e) => !/403/.test(e)), []);
      await ctx2.close();
    });

    await step('태블릿 화면(820px): 메뉴 버튼으로 메뉴 열기', async () => {
      await page.setViewportSize({ width: 820, height: 1180 });
      await page.goto(B + '/#/inventory');
      await page.click('button[aria-label="메뉴 열기"]');
      await page.waitForSelector('.app.mobile-open');
      await page.click('.nav a[href="#/schedule"]');
      await page.waitForURL(/#\/schedule/);
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await step('로그아웃', async () => {
      await page.goto(B + '/#/');
      await page.click('.topbar .menu-wrap > button');
      await page.click('text=로그아웃');
      await page.waitForSelector('.auth-card');
    });

    await step('브라우저 오류 없음 (콘솔 오류·화면 오류·서버 500)', async () => {
      // 권한 확인용으로 일부러 낸 403 은 제외
      const real = errors.filter((e) => !/status of 403|status of 401/.test(e));
      if (real.length) throw new Error('브라우저 오류: ' + real.join(' | '));
    });
  } finally {
    await browser.close();
    await server.stop();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nE2E 결과: ${results.length - failed.length}/${results.length} 통과`);
  const report = path.join(os.tmpdir(), 'dentalax-e2e-result.json');
  fs.writeFileSync(report, JSON.stringify(results, null, 2));
  if (failed.length) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
