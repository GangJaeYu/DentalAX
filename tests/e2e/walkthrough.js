/*
 * 이 파일이 하는 일: 서비스 전체 사용 흐름을 브라우저로 자동 실행하면서
 *   (1) 화면 캡처 + 설명이 들어간 GitHub용 안내서(docs/walkthrough/README.md)를 만들고   → npm run walkthrough
 *   (2) 핵심 흐름을 천천히 보여 주는 시연 영상(docs/walkthrough/dentalax-demo.webm)을 녹화합니다 → npm run walkthrough:video
 *
 * - 새 데이터 폴더로 서버를 따로 띄우므로 실제 data 폴더는 건드리지 않습니다.
 * - 병원·직원·업체는 모두 가상(하늘치과의원 데모 데이터)이며 환자 정보는 없습니다.
 * - 영상 모드에서는 빨간 동그라미(마우스 위치)와 아래쪽 자막을 화면에 덧씌워 흐름을 따라가기 쉽게 합니다.
 * - 영상 녹화에는 Playwright용 ffmpeg가 필요합니다: (프로젝트 안에 설치)
 *     PLAYWRIGHT_BROWSERS_PATH=0 node node_modules/playwright-core/cli.js install ffmpeg
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, startServerProcess, launchBrowser, watchErrors, MASK_PRIVATE } = require('./lib');

const VIDEO = process.argv.includes('--video');
// 영상 녹화용 ffmpeg는 프로젝트 안(node_modules/playwright-core/.local-browsers)에 설치한 것을 씀
if (VIDEO && !process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const OUT = path.join(ROOT, 'docs', 'walkthrough');
const IMG = path.join(OUT, 'images');
const VIEW = { width: 1280, height: 800 };
const ADMIN = { username: 'director', password: 'Haneul2026!', name: '김하늘' };

// ---------------- 공통 도우미 ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHelpers(page, B, doc) {
  let shotNo = 0;
  const h = {
    page,
    B,
    /** 화면 로딩(뼈대·스피너)이 끝날 때까지 기다림 */
    async settle(extra = 400) {
      await page.waitForFunction(() => !document.querySelector('.skeleton, .loading-block:not(.boot), .ai-thinking'), null, { timeout: 15000 }).catch(() => {});
      await sleep(VIDEO ? extra + 300 : extra);
    },
    /** 주소로 이동 (영상에서는 왼쪽 메뉴를 눌러 이동하는 모습을 보여 줌) */
    async go(hash, { viaNav = true } = {}) {
      const first = hash.split(/[/?]/)[0];
      const nav = page.locator(`.nav a[href="#/${first}"]`);
      if (VIDEO && viaNav && !hash.includes('?') && !hash.includes('/') && (await nav.count()) && (await nav.isVisible())) {
        await h.click(nav);
      } else {
        await page.goto(`${B}/#/${hash}`);
      }
      await page.waitForSelector('.page-title, .auth-card, .paper', { timeout: 15000 }).catch(() => {});
      await h.settle();
    },
    /** 누르기 (영상에서는 마우스가 천천히 움직여 누름) */
    async click(target, { pause = 350 } = {}) {
      const loc = typeof target === 'string' ? page.locator(target).first() : target.first ? target.first() : target;
      await loc.waitFor({ state: 'visible', timeout: 15000 });
      if (VIDEO) {
        await loc.scrollIntoViewIfNeeded();
        const box = await loc.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 22 });
          await sleep(pause);
        }
      }
      await loc.click();
      if (VIDEO) await sleep(300);
    },
    /** 글자 입력 (영상에서는 한 글자씩 타이핑) */
    async type(target, text, { delay = 28 } = {}) {
      const loc = typeof target === 'string' ? page.locator(target).first() : target;
      if (VIDEO) {
        await h.click(loc, { pause: 150 });
        await loc.fill('');
        await loc.pressSequentially(text, { delay });
      } else {
        await loc.fill(text);
      }
    },
    /** 영상 자막 */
    async caption(text, hold = 0) {
      if (!VIDEO) return;
      await page.evaluate((t) => {
        const c = document.getElementById('__dx_caption');
        if (!c) return;
        c.textContent = t || '';
        c.style.display = t ? 'block' : 'none';
      }, text);
      if (hold) await sleep(hold);
    },
    async wait(ms) {
      if (VIDEO) await sleep(ms);
    },
    /** 천천히 아래로 내려 보기 (영상) */
    async scroll(px = 500) {
      if (!VIDEO) return;
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, px / 10);
        await sleep(70);
      }
      await sleep(600);
    },
    /** 화면 캡처 + 안내서에 들어갈 설명 */
    async shot(name, caption, { fullPage = false, clip } = {}) {
      if (VIDEO) return;
      shotNo++;
      const file = `${String(shotNo).padStart(2, '0')}-${name}.jpg`;
      await page.screenshot({ path: path.join(IMG, file), type: 'jpeg', quality: 80, fullPage, clip });
      doc.push({ type: 'img', file, caption });
    },
    md(text) {
      if (!VIDEO) doc.push({ type: 'md', text });
    },
  };
  return h;
}

// 영상용: 마우스 위치 표시 + 자막 상자 + 시작/끝 화면
const OVERLAY_SCRIPT = () => {
  const make = () => {
    if (document.getElementById('__dx_cursor')) return;
    const c = document.createElement('div');
    c.id = '__dx_cursor';
    Object.assign(c.style, {
      position: 'fixed', left: '-50px', top: '-50px', width: '26px', height: '26px', marginLeft: '-13px', marginTop: '-13px',
      borderRadius: '50%', background: 'rgba(239,68,68,.28)', border: '2px solid rgba(239,68,68,.9)', zIndex: '2147483647',
      pointerEvents: 'none', transition: 'transform .12s',
    });
    document.body.appendChild(c);
    document.addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    document.addEventListener('mousedown', () => { c.style.transform = 'scale(.6)'; }, true);
    document.addEventListener('mouseup', () => { c.style.transform = 'scale(1)'; }, true);
    const cap = document.createElement('div');
    cap.id = '__dx_caption';
    Object.assign(cap.style, {
      position: 'fixed', left: '50%', bottom: '26px', transform: 'translateX(-50%)', maxWidth: '86%', padding: '12px 24px',
      borderRadius: '14px', background: 'rgba(17,24,39,.9)', color: '#fff', font: '600 19px/1.5 "Pretendard Variable", "Malgun Gothic", sans-serif',
      zIndex: '2147483646', pointerEvents: 'none', textAlign: 'center', boxShadow: '0 10px 30px rgba(0,0,0,.35)', display: 'none', whiteSpace: 'pre-line',
    });
    document.body.appendChild(cap);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', make);
  else make();
};

async function titleCard(page, title, sub, ms) {
  await page.evaluate(([t, s]) => {
    let d = document.getElementById('__dx_card');
    if (!d) {
      d = document.createElement('div');
      d.id = '__dx_card';
      Object.assign(d.style, {
        position: 'fixed', inset: '0', zIndex: '2147483645', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(140deg,#1d4fbf,#3d7bff 55%,#6d4cff)', color: '#fff', textAlign: 'center', gap: '14px',
        font: '500 22px/1.5 "Pretendard Variable", "Malgun Gothic", sans-serif',
      });
      document.body.appendChild(d);
    }
    d.innerHTML = '';
    const h = document.createElement('div');
    h.textContent = t;
    Object.assign(h.style, { font: '800 52px/1.2 "Pretendard Variable", sans-serif', letterSpacing: '-0.02em' });
    const p = document.createElement('div');
    p.textContent = s;
    Object.assign(p.style, { opacity: '.92', whiteSpace: 'pre-line' });
    d.append(h, p);
    d.style.display = 'flex';
  }, [title, sub]);
  await sleep(ms);
  await page.evaluate(() => {
    const d = document.getElementById('__dx_card');
    if (d) d.style.display = 'none';
  });
}

// ---------------- 이야기(사용 흐름) ----------------
// 각 장: { title, intro, video: true면 영상에도 포함, run(h) }
const CHAPTERS = [
  {
    title: '1. 처음 설정',
    video: true,
    intro: '서버를 처음 켜면(start.bat) 브라우저에 **처음 설정** 화면이 나옵니다. 병원 이름과 원장님(관리자) 계정을 만듭니다. 코드에 들어 있는 기본 비밀번호는 없습니다.',
    async run(h) {
      const { page } = h;
      await page.goto(h.B + '/');
      await page.waitForSelector('.auth-card');
      await h.caption('처음 켜면 "처음 설정" 화면이 나옵니다. 병원 이름과 관리자 계정을 만듭니다.');
      await h.type('input[name=clinicName]', '하늘치과의원');
      await h.type('input[name=name]', ADMIN.name);
      await h.type('input[name=username]', ADMIN.username);
      await h.type('input[name=password]', ADMIN.password, { delay: 40 });
      await h.type('input[name=password2]', ADMIN.password, { delay: 40 });
      await h.shot('setup', '병원 이름·관리자 이름·아이디·비밀번호를 입력합니다. 비밀번호는 8자 이상, 영문·숫자·기호 중 2가지 이상. "데모 예시 데이터 넣기"를 켜면 가상의 치과 데이터로 둘러볼 수 있습니다(나중에 관리 화면에서 지움).');
      await h.caption('"데모 예시 데이터"를 켜 두면 가상의 치과 데이터로 바로 둘러볼 수 있어요.', 1600);
      await h.click('button[type=submit]');
      await page.waitForSelector('.sidebar');
      await h.settle(600);
    },
  },
  {
    title: '2. 대시보드 — 첫 화면',
    video: true,
    intro: '로그인하면 **대시보드**가 첫 화면입니다. 오늘 할 일, 재고 경고, 다가오는 점검·법정 일정, 공지, 오늘 근무자가 한 화면에 모입니다. 각 줄을 누르면 해당 화면으로 바로 이동합니다.',
    async run(h) {
      await h.go('', { viaNav: false });
      await h.caption('첫 화면은 대시보드. 오늘 할 일·재고 경고·점검 일정·공지·근무자가 한눈에 보입니다.', 2500);
      await h.shot('dashboard', '대시보드 위쪽: 숫자 카드(재고 부족, 유효기간 임박, 이번 달 지출, 이번 달 AI 비용)와 "오늘 할 일"(체크리스트 진행률, 안 읽은 중요 공지, 인수인계, 발주·법정 일정 등), 오른쪽 "재고 경고".');
      await h.scroll(600);
      await h.caption('아래쪽에는 공지·인수인계, 다가오는 점검·법정 일정, 오늘 근무자가 있습니다.', 2200);
      await h.page.evaluate(() => window.scrollTo(0, 600));
      await h.shot('dashboard-lower', '대시보드 아래쪽: 공지·인수인계, 다가오는 점검·일정(D-day 배지), 오늘 근무자·휴가자.', { keep: true });
      await h.page.evaluate(() => window.scrollTo(0, 0));
    },
  },
  {
    title: '3. 공지·인수인계',
    video: true,
    intro: '원내 공지와 근무자 간 인수인계를 한곳에서 관리합니다. 글을 열면 자동으로 **읽음**이 기록되어 누가 아직 안 읽었는지 바로 보입니다. 메모처럼 대충 적고 **AI로 다듬기**를 누르면 깔끔한 글이 됩니다.',
    async run(h) {
      const { page } = h;
      await h.go('board');
      await h.caption('공지·인수인계 보드. 고정 공지, 중요도, 읽음 수가 표시됩니다.', 1800);
      await h.shot('board-list', '목록: 고정 공지가 맨 위, 안 읽은 글은 파란 점. 탭으로 공지/인수인계/보관함을 나눠 봅니다.');
      await h.click(page.locator('button:has-text("새 글")'));
      await h.type('.modal textarea', '다음주 월요일 아침 8시 반 전체 회의 대기실. 홍길동 환자 010-1234-5678 리콜 연락 필요. 신규 소독제 사용법 공유 예정');
      await h.caption('메모처럼 적고 [AI로 다듬기]. 환자 이름·전화번호는 AI로 보내기 전에 자동으로 가려집니다.', 600);
      await h.click(page.locator('.modal button:has-text("AI로 다듬기")'));
      await page.waitForSelector('.modal .ai-panel-body');
      await h.settle(300);
      await page.locator('.modal .ai-panel').scrollIntoViewIfNeeded();
      await h.wait(2800);
      await h.shot('board-ai', 'AI 다듬기 결과. 위쪽 노란 안내처럼 "전화번호 1건, 이름 1건을 가리고 보냈습니다" — 개인정보는 서버가 먼저 찾아서 가린 뒤 AI로 보냅니다(주민번호·카드번호는 아예 차단). 키가 없을 때는 "데모 예시"로 동작합니다.');
      await h.click(page.locator('.modal button:has-text("이 내용으로 바꾸기")'));
      await h.click(page.locator('.modal-footer button:has-text("등록")'));
      await page.waitForURL(/#\/board\/\d+/);
      await h.settle();
      await h.caption('등록한 글. 오른쪽에 누가 읽었고 누가 아직 안 읽었는지 보입니다.', 2400);
      await h.shot('board-detail', '글 상세: 오른쪽 "읽음 확인"에 아직 안 읽은 직원과 읽은 시각이 표시됩니다.');
    },
  },
  {
    title: '4. 오픈·마감 체크리스트',
    video: true,
    intro: '오픈·마감·주간 점검을 태블릿에서 손가락으로 체크합니다. **누가 몇 시에 체크했는지** 남고, 항목별 짧은 메모도 남길 수 있습니다. 템플릿은 실장 이상이 편집하며, AI로 항목을 제안받을 수 있습니다.',
    async run(h) {
      const { page } = h;
      await h.go('checklists');
      const rows = page.locator('.ck-toggle');
      let clicked = 0;
      for (let i = 0; i < (await rows.count()) && clicked < 2; i++) {
        const txt = await rows.nth(i).locator('xpath=ancestor::li[1]').textContent();
        if (!/박지민|이서연|최유나|정다은|한소희|오민지|김하늘/.test(txt)) {
          await h.click(rows.nth(i));
          clicked++;
          await h.settle(200);
        }
      }
      await h.caption('항목을 누르면 체크한 사람과 시각이 기록됩니다.', 2200);
      await h.shot('checklists-today', '오늘의 체크리스트. 진행률, 체크한 사람·시각, 메모가 함께 보입니다. 날짜를 바꿔 지난 기록도 볼 수 있습니다.');
      await page.goto(h.B + '/#/checklists?tab=history');
      await h.settle();
      await h.shot('checklists-history', '"기록" 탭: 최근 30일 템플릿별 완료율과 남긴 메모.');
    },
  },
  {
    title: '5. 소통 도우미 — 전화 응대·리뷰 답글·안내 문자',
    video: true,
    intro: '병원 정보(진료시간·주차·보험 일반 안내)를 바탕으로 **전화 응대 스크립트**, **온라인 리뷰 답글**, **안내 문자 문구**를 AI가 초안으로 만들어 줍니다. 리뷰 답글은 의료광고 규정상 위험한 표현(최고·완치·보장 등)을 자동으로 검사합니다. 리뷰 원문은 저장하지 않습니다.',
    async run(h) {
      const { page } = h;
      await h.go('comms');
      await h.shot('comms-scripts', '전화 응대 스크립트 보관함. 상황별(진료시간, 주차, 예약 변경, 비용 일반, 불만 응대…)로 저장하고 바로 복사합니다. [AI로 스크립트 만들기]로 새로 만들 수 있습니다.');
      await page.goto(h.B + '/#/comms?tab=review');
      await h.settle();
      await h.caption('리뷰 답글: 리뷰를 붙여 넣으면 답글 초안 3개를 만들고, 의료광고 주의 표현을 검사합니다.');
      await h.type('textarea[maxlength="2000"]', '직원분들이 친절하고 설명을 자세히 해 주셔서 좋았어요. 다만 대기 시간이 조금 길었어요.', { delay: 18 });
      await h.click(page.locator('button:has-text("답글 초안 3개 만들기")'));
      await page.waitForSelector('text=검사 통과', { timeout: 15000 });
      await h.settle(300);
      await h.scroll(300);
      await h.wait(2500);
      await h.page.evaluate(() => window.scrollTo(0, 120));
      await h.shot('comms-review', '리뷰 답글 초안 3개. 각 초안마다 "주의 표현 검사" 결과가 붙고, 직접 고치면 바로 다시 검사합니다. 리뷰 원문과 답글은 서버에 저장하지 않습니다.', { keep: true });
      await page.goto(h.B + '/#/comms?tab=messages');
      await h.settle();
      await h.shot('comms-messages', '안내 문자·안내문 템플릿. {이름} {날짜} 같은 빈칸 변수, 미리보기, 단문(90바이트)/장문 바이트 계산을 지원합니다.');
    },
  },
  {
    title: '6. 재고 — 입고·출고·유효기간',
    video: true,
    intro: '재료·소모품의 현재 수량을 관리합니다. 목록에서 바로 **[입고]·[출고]** 를 눌러 기록하고, 출고는 **유효기간이 빠른 로트부터** 자동 차감됩니다. 적정 재고 미만·유효기간 임박/만료는 경고로 모입니다.',
    async run(h) {
      const { page } = h;
      await h.go('inventory');
      await h.caption('재고 현황. 품목마다 현재 수량, 적정 재고 대비 상태, 유효기간이 보입니다.', 2000);
      await h.shot('inventory', '재고 현황: 위쪽 요약 카드, 분류 필터, "부족만" 보기, 각 줄의 [입고]·[출고] 빠른 기록 버튼.');
      await h.click(page.locator('.table tbody tr button:has-text("출고"):not([disabled])'));
      await page.waitForSelector('.modal');
      await h.type('.modal-body input', '1');
      await h.caption('출고 수량만 넣으면 끝. 어느 로트(유효기간)에서 빠질지 미리 보여 줍니다.', 1800);
      await h.shot('inventory-out', '출고 창: 수량(± 버튼·빠른 선택), 메모 칩. 유효기간 관리 품목은 어느 로트에서 빠질지 미리 보여 줍니다.');
      await h.click(page.locator('.modal-footer button').last());
      await h.settle();
      await page.goto(h.B + '/#/inventory?tab=alerts');
      await h.settle();
      await h.caption('경고 탭: 재고 부족과 유효기간 임박·만료 품목을 모아 봅니다.', 2200);
      await h.shot('inventory-alerts', '"경고" 탭: 재고 부족 품목과 유효기간 임박·만료 로트. 만료품은 [폐기]로 따로 처리합니다(자동 출고되지 않음).');
      await page.goto(h.B + '/#/inventory?tab=prices');
      await h.settle();
      await h.shot('inventory-prices', '"단가 변동" 탭: 입고할 때 단가가 바뀌면 자동으로 기록되고 변동률이 표시됩니다.');
    },
  },
  {
    title: '7. 거래명세서로 한 번에 입고 (AI)',
    video: true,
    intro: '택배로 온 **거래명세서 내용을 붙여 넣으면** AI가 품목·수량·단가를 읽어 기존 품목과 짝을 맞추고, 확인 후 한 번에 입고합니다.',
    async run(h) {
      const { page } = h;
      await page.goto(h.B + '/#/inventory');
      await h.settle();
      await h.click(page.locator('button:has-text("거래명세서로 입고")'));
      await page.waitForSelector('.modal');
      await h.click(page.locator('.modal button:has-text("예시 넣어 보기")'));
      await h.caption('거래명세서 글을 붙여 넣고 [AI로 품목 인식]을 누릅니다.', 1500);
      await h.click(page.locator('.modal button:has-text("AI로 품목 인식")'));
      const badge = page.locator('.modal .badge', { hasText: /데모 예시|AI 인식 결과/ }).first();
      await badge.waitFor({ timeout: 15000 });
      await h.settle(400);
      await badge.scrollIntoViewIfNeeded();
      await h.caption('기존 품목과 자동으로 짝을 맞춥니다. 확인하고 한 번에 입고하면 끝.', 2800);
      await h.shot('inventory-invoice', 'AI 인식 결과: 명세서의 각 줄을 기존 품목과 짝지어 보여 줍니다. 짝이 틀리면 바꾸거나 새 품목으로 등록한 뒤 한 번에 입고합니다.');
      await page.keyboard.press('Escape');
      await h.settle(200);
    },
  },
  {
    title: '8. 발주서와 거래처',
    video: true,
    intro: '**부족 품목으로 발주서 만들기**를 누르면 거래처별로 묶은 발주서 초안이 자동으로 생깁니다. A4로 인쇄하거나 PDF로 저장하고, 거래처에 보낼 메시지(카톡·문자·이메일)도 AI가 써 줍니다. 입고 처리하면 재고에 바로 반영됩니다.',
    async run(h) {
      const { page } = h;
      await h.go('orders');
      await h.shot('orders', '발주서 목록: 작성 중 → 발주함 → 입고 완료 상태, 입고 예정일이 지나면 빨간 배지.');
      await h.click(page.locator('button:has-text("부족 품목으로 발주서 만들기")'));
      await page.waitForSelector('.modal');
      await h.settle(300);
      await h.caption('부족한 품목을 거래처별로 묶어 발주서 초안을 만듭니다.', 2400);
      await h.shot('orders-auto', '자동 발주 미리보기: 부족 품목을 거래처별로 묶고, 수량은 "발주 수량" 설정 또는 적정 재고 기준으로 채웁니다.');
      await h.click(page.locator('.modal-footer button').last());
      await page.locator('.toast.success').first().waitFor();
      await page.goto(h.B + '/#/orders');
      await h.settle();
      const href = await page.locator('tr', { hasText: '한빛덴탈' }).locator('a[href^="#/orders/"]').first().getAttribute('href');
      const id = href.match(/orders\/(\d+)/)[1];
      await page.goto(`${h.B}/#/orders/${id}`);
      await h.settle();
      await h.shot('orders-detail', '발주서 상세: 품목·수량·단가 편집, [발주] → [입고 처리](부분 입고 가능), AI 발주 메시지 만들기.');
      await page.goto(`${h.B}/#/orders/${id}/print`);
      await page.waitForSelector('.paper');
      await h.settle();
      await h.caption('A4 발주서 인쇄 화면. 브라우저 인쇄에서 "PDF로 저장"도 됩니다.', 2400);
      await h.shot('orders-print', 'A4 인쇄 화면: 병원 머리글이 들어간 발주서. 인쇄 창에서 "PDF로 저장"을 고르면 PDF가 됩니다.', { fullPage: true });
      await h.go('vendors', { viaNav: false });
      await h.shot('vendors', '거래처: 담당자·주문 방법·결제 조건, 거래 품목 수와 최근 발주. (병원의 업무 연락처만 저장)');
    },
  },
  {
    title: '9. AI 문서 작성 — 공문·안내문·규정·매뉴얼',
    video: true,
    intro: '문서 종류를 고르고 **목적과 핵심 메모**만 적으면 AI가 형식에 맞는 초안을 써 줍니다(공문은 수신·제목·본문·붙임·발신 명의 형식). 편집기에서 고치고 "다시 쓰기·더 짧게·더 정중하게·맞춤법" 다듬기를 한 뒤 문서함에 저장하고 A4로 인쇄합니다.',
    async run(h) {
      const { page } = h;
      await h.go('documents');
      await h.shot('documents', '문서함과 문서 종류 바로가기. "AI 참고" 표시가 있는 문서는 원내 AI 도우미가 답할 때 근거로 씁니다.');
      await page.goto(h.B + '/#/documents/new?kind=' + encodeURIComponent('공문'));
      await page.waitForSelector('form input.input');
      await h.settle();
      await h.type(page.locator('form input.input').first(), '11월 원내 감염관리 교육 실시 안내');
      await h.type(page.locator('form textarea').first(), '일시 11월 12일(목) 13:00~14:00\n장소 2층 세미나실\n대상 전 직원 필수\n내용 손위생·보호구·멸균 흐름', { delay: 15 });
      await h.caption('목적과 핵심 메모만 적고 [AI로 초안 만들기].', 900);
      await h.click(page.locator('button:has-text("AI로 초안 만들기")'));
      await page.locator('button:has-text("편집기에 넣기")').first().waitFor({ timeout: 20000 });
      await h.settle(300);
      await h.wait(2200);
      await h.shot('documents-ai', 'AI 초안: 공문 형식(문서번호·수신·참조·제목·본문·붙임·발신 명의)에 맞춰 작성됩니다.');
      await h.click(page.locator('button:has-text("편집기에 넣기")'));
      await h.click(page.locator('button:has-text("문서함에 저장")'));
      await page.waitForURL(/#\/documents\/\d+$/);
      await h.settle();
      const id = page.url().match(/documents\/(\d+)/)[1];
      await page.goto(`${h.B}/#/documents/${id}/print`);
      await page.waitForSelector('.paper');
      await h.settle();
      await h.caption('저장한 문서는 병원 머리글이 들어간 A4로 인쇄합니다.', 2400);
      await h.shot('documents-print', '인쇄 화면: 병원 이름·주소·전화가 머리글로 들어간 A4 공문.', { fullPage: true });
    },
  },
  {
    title: '10. 회의록 요약과 서식 보관함',
    video: false,
    intro: '회의 메모를 붙여 넣으면 AI가 **요약·결정 사항·할 일(담당자·기한)** 로 정리합니다. 할 일은 체크 표시로 관리하고, 실장 이상은 할 일을 공지로 올릴 수 있습니다. 자주 쓰는 양식 파일은 서식 보관함에 둡니다.',
    async run(h) {
      const { page } = h;
      await page.goto(h.B + '/#/minutes/new');
      await h.settle();
      await h.type('input[placeholder="예: 11월 정기 직원회의"]', '11월 정기 직원회의');
      for (const n of ['김하늘', '박지민', '이서연', '최유나']) await h.click(page.locator('button', { hasText: n }).first());
      await h.type(page.locator('textarea').first(), '- 목요일 야간진료는 순번제로 하기로 결정\n- 이서연 10/30까지 마감 체크리스트 정리\n- 최유나 다음 주 금요일까지 장갑 재고 확인\n- 주차 등록 방법 다시 공유');
      await h.click(page.locator('button:has-text("AI로 회의록 정리")'));
      await page.locator('button:has-text("회의록에 넣기")').first().waitFor({ timeout: 20000 });
      await h.settle();
      await h.shot('minutes-ai', 'AI 회의록 정리: 요약, 결정 사항, 할 일(담당자·기한 날짜 자동 인식).');
      await h.click(page.locator('button:has-text("회의록에 넣기")'));
      await h.click(page.locator('button:has-text("저장")').last());
      await page.waitForURL(/#\/minutes\/\d+$/);
      await h.settle();
      await h.shot('minutes-detail', '저장된 회의록: 할 일을 체크하며 관리하고, [할 일을 공지로 올리기]로 보드에 공유합니다.');
      await h.go('forms', { viaNav: false });
      await h.shot('forms', '서식 보관함: 파일을 끌어다 놓아 올리고, 분류·검색·내려받기. 텍스트·이미지는 미리보기.');
    },
  },
  {
    title: '11. 근무표·연차·교육·온보딩',
    video: true,
    intro: '월간 **근무표**는 칸을 눌러 근무 유형을 고르거나 숫자키로 빠르게 입력합니다. 승인된 연차·반차는 근무표에 자동 표시됩니다. **연차**는 입사일 기준 자동 계산(직접 수정 가능), 신청 → 실장 승인 흐름이고, 법정 **교육 이수** 현황과 신규 직원 **온보딩**도 관리합니다.',
    async run(h) {
      const { page } = h;
      await h.go('schedule');
      await h.caption('월간 근무표. 칸을 눌러 근무 유형을 고르고, 승인된 휴가는 자동으로 표시됩니다.', 2600);
      await h.shot('schedule', '근무표: 직원별 근무일수·시간 합계, 날짜별 근무 인원, 공휴일·주말 색 구분, 지난 패턴 복사, 인쇄.');
      await h.go('leave');
      await page.goto(h.B + '/#/leave?tab=pending');
      await h.settle();
      await h.caption('연차·휴가 승인 대기. 같은 날 쉬는 사람과 남은 연차를 보고 승인합니다.', 1800);
      await h.shot('leave-pending', '승인 대기: 같은 기간 휴가자 경고, 승인 후 남는 연차가 함께 보입니다.');
      await h.click(page.locator('button:has-text("승인")').last());
      await page.locator('.modal').waitFor({ timeout: 3000 }).then(() => h.click(page.locator('.modal-footer button').last())).catch(() => {});
      await h.settle();
      await page.goto(h.B + '/#/leave?tab=balances');
      await h.settle();
      await h.shot('leave-balances', '직원별 연차 현황: 부여(입사일 기준 자동 계산, 직접 수정 가능)·사용·잔여.');
      await h.go('training', { viaNav: false });
      await h.caption('법정 의무교육 이수 현황표: 완료·임박·만료·미이수를 색으로 구분합니다.', 2200);
      await h.shot('training', '교육 이수 현황표: 직원 × 교육. 다음 기한, 임박(30일 이내)·만료·미이수 표시. "주기 확인 필요" 표시는 주기를 꼭 확인할 항목입니다.');
      await h.go('onboarding', { viaNav: false });
      await h.shot('onboarding', '온보딩: 신규 직원별 진행률과 첫날/첫 주/첫 달 체크 항목. 템플릿은 직종별로 만들고 AI로 항목을 제안받을 수 있습니다.');
    },
  },
  {
    title: '12. 장비 점검·멸균기 기록·법정 일정',
    video: true,
    intro: '장비별 **점검·수리 이력**과 다음 점검일, 멸균기 **회차별 기록**(온도·압력·시간·지시계 결과 — 환자 정보 없음), 방사선·소방·감염관리 등 **법정 정기 일정**을 관리합니다. 법정 주기가 확실하지 않은 항목은 "주기 확인 필요"로 표시되고 직접 고칠 수 있습니다.',
    async run(h) {
      const { page } = h;
      await h.go('equipment', { viaNav: false });
      await h.shot('equipment', '장비 목록: 상태(정상·점검 필요·수리 중), 다음 점검 D-day, [기록]으로 점검·수리 이력 바로 추가.');
      await h.go('sterilization');
      await h.caption('멸균기 기록: 오늘 날짜·다음 회차·지난 값이 미리 채워져 있어 [기록 저장]만 누르면 됩니다.', 1500);
      await h.shot('sterilization', '멸균기 빠른 기록: 멸균기 선택, 회차, 프로그램, 온도·압력·시간, CI/BI/보위딕 결과, 적재물(물건과 개수만). 불합격이면 조치 안내가 뜹니다.');
      await h.click(page.locator('button:has-text("기록 저장")'));
      await page.locator('.toast.success').first().waitFor();
      await h.settle();
      await page.goto(h.B + '/#/sterilization?tab=month');
      await h.settle();
      await h.shot('sterilization-month', '월별 기록: 한 달 기록부를 표로 보고 A4로 인쇄(서명란 포함)합니다.');
      await h.go('compliance');
      await h.caption('법정 일정: [완료]를 누르면 다음 일정이 주기에 맞춰 자동 계산됩니다.', 2600);
      await h.shot('compliance', '법정 일정: 기한 지남·30일 이내·주기 확인 필요 요약, 항목별 근거 법령 메모와 담당자, [완료] 처리. "법률 자문이 아님" 안내가 항상 보입니다.');
    },
  },
  {
    title: '13. 지출·월별 요약',
    video: true,
    intro: '병원에서 쓴 돈(지출)만 기록합니다(환자 진료비 같은 매출은 다루지 않음). 분류별 지출, 12개월 추이, 전월 대비, 많이 쓴 곳을 한눈에 보고, 카드사 CSV를 가져와 키워드·AI로 분류를 추천받습니다. 실장 이상만 볼 수 있습니다.',
    async run(h) {
      const { page } = h;
      await h.go('expenses');
      await h.caption('지출 월별 요약: 분류별 비중과 12개월 추이, 전월 대비를 봅니다.', 2600);
      await h.shot('expenses', '월별 요약: 이번 달 지출, 전월 같은 기간 대비, 12개월 평균, 분류별 막대, 12개월 추이 그래프.');
      await page.goto(h.B + '/#/expenses?tab=list');
      await h.settle();
      await h.shot('expenses-list', '지출 내역: 월·분류·결제 수단 필터, 검색, CSV 내보내기·가져오기.');
    },
  },
  {
    title: '14. 원내 AI 도우미',
    video: true,
    intro: '원내 매뉴얼·규정 문서를 등록하면(붙여넣기 또는 txt·md·csv·docx 파일) 질문에 **그 문서를 근거로** 답하고, 근거가 된 문단을 [1] [2] 카드로 보여 줍니다. 문서함에서 "AI 도우미가 참고"로 표시한 문서도 자동으로 함께 검색됩니다. 질문 내용은 저장하지 않습니다.',
    async run(h) {
      const { page } = h;
      await h.go('assistant');
      await h.type('.asst-input', '기구 멸균 후 보관은 어떻게 하나요?');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.asst-source', { timeout: 15000 });
      await h.settle(300);
      await h.caption('답과 함께 근거 문서 카드가 붙습니다. 카드를 누르면 원문을 볼 수 있어요.', 2600);
      await h.shot('assistant', '질문 → 근거 문단을 찾아 답하고, 아래에 근거 문서 카드([1] [2])를 붙입니다. 키가 없는 데모 모드에서도 관련 문장을 찾아 보여 줍니다. 오른쪽은 참고 문서 목록.');
      await h.click(page.locator('.asst-source').first());
      await page.waitForSelector('.modal');
      await h.settle(300);
      await h.wait(1500);
      await h.shot('assistant-source', '근거 문서 보기: 어느 문서의 어느 위치에서 찾았는지 확인합니다.');
      await page.keyboard.press('Escape');
    },
  },
  {
    title: '15. 관리 — 사용자, AI 설정, 비용, 백업',
    video: true,
    intro: '원장·관리자 전용 화면입니다. **직원 계정**(임시 비밀번호 → 첫 로그인 때 본인이 변경), **AI 설정**(공급자·API 키·기능별 모델 등급·가격표·월 예산), **AI 사용량·비용**, **백업·복원**, **활동 기록**, 접속 주소와 초기화를 관리합니다.',
    async run(h) {
      const { page } = h;
      await page.goto(h.B + '/#/admin/users');
      await h.settle();
      await h.shot('admin-users', '사용자·권한: 원장·관리자 / 실장 / 직원 3단계 권한. 로그인 계정이 없는 직원도 근무표·연차용으로 등록할 수 있습니다.');
      await h.click(page.locator('button:has-text("직원 추가")'));
      await h.type('.modal input[name=name]', '신규직원');
      await h.type('.modal input[name=username]', 'newstaff');
      await h.type('.modal input[name=password]', 'Temp1234!');
      await h.click(page.locator('.modal-footer button:has-text("저장")'));
      await page.waitForSelector('.modal-title:has-text("임시 비밀번호")');
      await h.settle(200);
      await h.shot('admin-temp-password', '직원 계정을 만들면 임시 비밀번호가 한 번만 표시됩니다. 직원에게 직접 전달하면, 첫 로그인 때 본인 비밀번호로 바꾸게 됩니다.');
      await h.click(page.locator('button:has-text("확인했습니다")'));
      await page.goto(h.B + '/#/admin/ai');
      await h.settle();
      await h.caption('AI 설정: 공급자(Claude·OpenAI·Gemini·데모)와 API 키, 월 예산, 개인정보 필터 방식.', 2400);
      await h.shot('admin-ai', 'AI 설정: 공급자 선택, API 키(서버에만 암호화 저장, 끝 4자리만 표시), 월 예산과 초과 시 차단/경고, 환율, 개인정보 필터 방식.');
      await h.scroll(1100);
      await page.evaluate(() => window.scrollTo(0, 1150));
      await h.shot('admin-ai-models', '기능별 모델 등급(간단한 일은 저렴한 "빠른 모델", 긴 문서는 "상위 모델")과 가격표. 가격은 공식 가격 기준이며 직접 고칠 수 있습니다.', { keep: true });
      await page.goto(h.B + '/#/admin/usage');
      await h.settle();
      await h.caption('AI 사용량: 이번 달 예상 비용, 기능별·사용자별 호출. 글 내용은 저장하지 않습니다.', 2200);
      await h.shot('admin-usage', 'AI 사용량·비용: 예상 비용(원), 호출 수, 토큰, 개인정보 차단 횟수, 일별 그래프, 기능별·사용자별 표, 최근 호출 기록(내용 없이 기능·토큰·비용만).');
      await page.goto(h.B + '/#/admin/backup');
      await h.settle();
      await h.caption('백업·복원: 매일 자동 백업, [지금 백업], USB로 내려받기, 클릭 한 번 복원.', 900);
      await h.click(page.locator('button:has-text("지금 백업")'));
      await h.wait(1600);
      await h.settle();
      await h.shot('admin-backup', '백업·복원: 매일 자동 백업(시각·보관 개수 설정), 수동 백업, 내려받기(USB 보관), 복원(복원 전 상태 자동 백업), 다른 PC의 백업 파일로 복원.');
      await page.goto(h.B + '/#/admin/audit');
      await h.settle();
      await h.shot('admin-audit', '활동 기록: 누가 언제 무엇을 했는지(로그인, 추가·수정·삭제, 백업, 설정 변경) 자동 기록, 검색·기간 필터·CSV 내보내기.');
      await page.goto(h.B + '/#/admin/system');
      await h.settle();
      await h.shot('admin-system', '시스템·초기화: 직원 PC·태블릿 접속 주소, 자동 로그아웃 시간, 데모 데이터 초기화("초기화" 입력 확인).');
    },
  },
  {
    title: '16. 편의 기능 — 빠른 이동, 다크 모드, 태블릿·휴대폰',
    video: true,
    intro: '**Ctrl + K** 로 메뉴를 바로 찾아 이동하고, 오른쪽 위 달 버튼으로 **다크 모드**를 켭니다. 태블릿·휴대폰에서는 왼쪽 위 ☰ 버튼으로 메뉴를 엽니다.',
    async run(h) {
      const { page } = h;
      await h.go('', { viaNav: false });
      await page.keyboard.press('Control+k');
      await page.waitForSelector('.modal input');
      await h.type('.modal input', '멸균');
      await h.caption('Ctrl + K 를 누르고 "멸균"처럼 입력하면 바로 이동합니다.', 1500);
      await h.shot('palette', '빠른 이동(Ctrl + K): 메뉴 이름이나 관련 단어로 찾아 Enter.');
      await page.keyboard.press('Escape');
      await h.click(page.locator('button[aria-label="어두운 화면"]'));
      await h.settle(300);
      await h.caption('오른쪽 위 달 버튼으로 다크 모드. 기기마다 따로 기억합니다.', 2400);
      await h.shot('dark-mode', '다크 모드 대시보드.');
      if (!VIDEO) {
        await page.goto(h.B + '/#/inventory');
        await h.settle();
        await h.shot('dark-inventory', '다크 모드 재고 화면.');
      }
      await h.click(page.locator('button[aria-label="밝은 화면"]'));
      await h.settle(200);
      if (!VIDEO) {
        await page.setViewportSize({ width: 820, height: 1180 });
        await page.goto(h.B + '/#/checklists');
        await h.settle();
        await h.shot('tablet-checklists', '태블릿(세로) 화면: 체크리스트를 손가락으로 크게 누를 수 있습니다.');
        await page.click('button[aria-label="메뉴 열기"]');
        await h.settle(300);
        await h.shot('tablet-menu', '태블릿·휴대폰에서는 ☰ 버튼으로 메뉴를 엽니다.');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(h.B + '/#/');
        await h.settle();
        await h.shot('phone-dashboard', '휴대폰 화면(390px)의 대시보드.', { fullPage: false });
        await page.setViewportSize(VIEW);
      }
    },
  },
  {
    title: '17. 직원 계정으로 쓰기',
    video: false,
    intro: '직원은 관리자가 준 임시 비밀번호로 처음 로그인하면 **비밀번호를 바꾸는 화면**이 먼저 나옵니다. 직원 화면에는 관리·지출·발주 메뉴가 보이지 않고, 주소를 직접 입력해도 권한 안내만 나옵니다(서버에서도 막음).',
    async run(h, browser) {
      const ctx = await browser.newContext({ viewport: VIEW });
      const p = await ctx.newPage();
      await p.goto(h.B + '/');
      await p.waitForSelector('.auth-card');
      await p.fill('input[name=username]', 'newstaff');
      await p.fill('input[name=password]', 'Temp1234!');
      await p.click('button[type=submit]');
      await p.waitForSelector('text=비밀번호 바꾸기');
      await p.fill('input[name=current]', 'Temp1234!');
      await p.fill('input[name=next]', 'Staff5678!');
      await p.fill('input[name=next2]', 'Staff5678!');
      await h.shotOther(p, 'staff-first-login', '직원 첫 로그인: 임시 비밀번호를 본인만 아는 비밀번호로 바꿔야 시작할 수 있습니다.');
      await p.click('button[type=submit]');
      await p.waitForSelector('.sidebar');
      await p.waitForTimeout(900);
      await h.shotOther(p, 'staff-dashboard', '직원 화면: 왼쪽 메뉴에 관리·지출·발주서가 없습니다. 공지 읽기, 체크리스트, 입출고 기록, 연차 신청, 멸균 기록, AI 도구는 그대로 씁니다.');
      await ctx.close();
    },
  },
];

// ---------------- 안내서(마크다운) 만들기 ----------------
function buildMarkdown(sections, videoExists) {
  const lines = [];
  lines.push('# DentalAX 사용 흐름 안내서 (화면으로 보기)');
  lines.push('');
  lines.push('> 처음 설정부터 매일 쓰는 업무, 관리 기능까지 **실제 화면 캡처와 설명**으로 따라가는 안내서입니다.');
  lines.push('> 화면은 자동화 도구(Playwright)로 서비스를 실제로 실행하며 찍었습니다. 병원·직원·업체는 모두 **가상(데모 데이터)** 이며 환자 정보는 없습니다.');
  lines.push('> AI 결과는 API 키 없이 동작하는 **데모 모드** 예시입니다. 키를 넣으면 실제 AI가 같은 자리에 답합니다.');
  lines.push('');
  if (videoExists) {
    lines.push('## 시연 영상');
    lines.push('');
    lines.push('[![시연 영상 보기](images/01-setup.jpg)](dentalax-demo.webm)');
    lines.push('');
    lines.push('▶ **[시연 영상 보기 (dentalax-demo.webm)](dentalax-demo.webm)** — 처음 설정 → 공지·AI 다듬기 → 체크리스트 → 리뷰 답글 → 재고·명세서 입고 → 발주서 → AI 문서 → 근무표·연차 → 멸균·법정 일정 → 지출 → AI 도우미 → 관리.');
    lines.push('');
    lines.push('> GitHub README 안에서 바로 재생되게 하려면: GitHub 웹에서 README를 편집할 때 이 영상 파일을 편집 칸에 끌어다 놓으면 재생 가능한 주소가 자동으로 들어갑니다.');
    lines.push('');
  }
  lines.push('## 목차');
  lines.push('');
  for (const s of sections) lines.push(`- [${s.title}](#${s.title.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-')})`);
  lines.push('');
  for (const s of sections) {
    lines.push('---');
    lines.push('');
    lines.push(`## ${s.title}`);
    lines.push('');
    lines.push(s.intro);
    lines.push('');
    for (const d of s.items) {
      if (d.type === 'md') {
        lines.push(d.text, '');
      } else {
        lines.push(`![${d.caption.split(':')[0].slice(0, 40)}](images/${d.file})`);
        lines.push('');
        lines.push(`*${d.caption}*`);
        lines.push('');
      }
    }
  }
  lines.push('---');
  lines.push('');
  lines.push('이 안내서와 영상은 `npm run walkthrough` / `npm run walkthrough:video` 로 언제든 다시 만들 수 있습니다 (`tests/e2e/walkthrough.js`).');
  lines.push('설치·문제 해결은 [설치·사용 안내서(GUIDE)](../GUIDE.md)를, 처음 화면은 [README](../../README.md)를 보세요.');
  lines.push('');
  return lines.join('\n');
}

// ---------------- 실행 ----------------
(async () => {
  fs.mkdirSync(IMG, { recursive: true });
  if (!VIDEO) for (const f of fs.readdirSync(IMG)) fs.rmSync(path.join(IMG, f));
  const server = await startServerProcess({ port: Number(process.env.WALK_PORT || (VIDEO ? 3991 : 3990)) });
  const browser = await launchBrowser();
  const videoDir = path.join(OUT, '_video_tmp');
  const ctxOpts = { viewport: VIEW, deviceScaleFactor: 1, bypassCSP: VIDEO };
  if (VIDEO) ctxOpts.recordVideo = { dir: videoDir, size: VIEW };
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript(MASK_PRIVATE);
  if (VIDEO) await ctx.addInitScript(OVERLAY_SCRIPT);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  const sections = [];
  let shotCounter = 0;
  const startedAt = Date.now();
  try {
    if (VIDEO) {
      await page.goto(server.base + '/');
      await page.waitForSelector('.auth-card');
      await titleCard(page, 'DentalAX', '치과 원내 업무 AI 도우미\n공지·체크리스트·재고·서류·근무·시설·지출 — 원내 PC 한 대로', 3500);
    }
    for (const ch of CHAPTERS) {
      if (VIDEO && !ch.video) continue;
      const items = [];
      const h = makeHelpers(page, server.base, items);
      // 장마다 번호가 이어지도록 공통 번호를 씀
      // 캡처: 창이 나타나는 애니메이션이 끝날 때까지 기다리고, 오른쪽 아래 알림은 잠시 숨김. 기본은 화면 맨 위에서 찍음
      const capture = async (p, name, caption, opts = {}) => {
        shotCounter++;
        const file = `${String(shotCounter).padStart(2, '0')}-${name}.jpg`;
        if (!opts.keep) await p.evaluate(() => window.scrollTo(0, 0));
        await sleep(450);
        await p.evaluate(() => document.querySelectorAll('.toasts').forEach((t) => (t.style.visibility = 'hidden')));
        await p.screenshot({ path: path.join(IMG, file), type: 'jpeg', quality: 80, fullPage: !!opts.fullPage });
        await p.evaluate(() => document.querySelectorAll('.toasts').forEach((t) => (t.style.visibility = '')));
        items.push({ type: 'img', file, caption });
      };
      h.shot = async (name, caption, opts = {}) => {
        if (VIDEO) return;
        await capture(page, name, caption, opts);
      };
      h.shotOther = (p, name, caption, opts) => capture(p, name, caption, opts);
      h.doc = items;
      console.log(`▶ ${ch.title}`);
      await h.caption('');
      await ch.run(h, browser);
      await h.caption('');
      sections.push({ title: ch.title, intro: ch.intro, items });
    }
    if (VIDEO) {
      await page.goto(server.base + '/#/');
      await page.waitForSelector('.dash-grid');
      await sleep(800);
      await titleCard(page, 'DentalAX', '환자 정보는 저장하지 않습니다 · AI 키 없이도 데모 모드로 동작\n설치·사용법은 README를 참고하세요', 3500);
    }
  } finally {
    await ctx.close(); // 영상은 창을 닫을 때 파일로 저장됨
    await browser.close();
    await server.stop();
  }

  const real = errors.filter((e) => !/status of 40[13]/.test(e));
  if (real.length) console.log('브라우저 오류:\n' + real.join('\n'));

  if (VIDEO) {
    const files = fs.readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
    const src = path.join(videoDir, files[0]);
    const dst = path.join(OUT, 'dentalax-demo.webm');
    fs.copyFileSync(src, dst);
    fs.rmSync(videoDir, { recursive: true, force: true });
    const mb = fs.statSync(dst).size / 1024 / 1024;
    console.log(`영상 저장: ${dst} (${mb.toFixed(1)} MB, 약 ${Math.round((Date.now() - startedAt) / 1000)}초)`);
  } else {
    const md = buildMarkdown(sections, fs.existsSync(path.join(OUT, 'dentalax-demo.webm')));
    fs.writeFileSync(path.join(OUT, 'README.md'), md);
    const total = fs.readdirSync(IMG).reduce((n, f) => n + fs.statSync(path.join(IMG, f)).size, 0);
    console.log(`안내서 저장: ${path.join(OUT, 'README.md')} · 캡처 ${shotCounter}장 (${(total / 1024 / 1024).toFixed(1)} MB)`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
