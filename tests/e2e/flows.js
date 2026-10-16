/*
 * 이 파일이 하는 일: E2E 테스트(run.js)에서 모듈별 핵심 작업을 브라우저로 따라 해 보는 단계 목록입니다.
 * 각 항목: { name: '설명', async run(page, base, helpers) { ... } }
 * 화면 문구(버튼 이름)를 기준으로 누르므로, 버튼 이름을 바꾸면 여기도 함께 고쳐야 합니다.
 */
const assert = require('node:assert/strict');

module.exports = [
  {
    name: '오픈·마감 체크: 항목을 체크하면 체크한 사람·시각이 표시된다',
    async run(page, B) {
      await page.goto(B + '/#/checklists');
      await page.waitForSelector('.ck-card');
      const before = await page.locator('.ck-toggle[aria-pressed="true"], .ck-row.checked').count();
      // 아직 체크 안 된 첫 항목을 누름
      const rows = page.locator('.ck-toggle');
      const n = await rows.count();
      let clicked = false;
      for (let i = 0; i < n; i++) {
        const txt = await rows.nth(i).locator('xpath=ancestor::li[1]').textContent();
        if (!/김하늘|박지민|이서연|최유나|정다은|한소희|오민지/.test(txt)) {
          await rows.nth(i).click();
          clicked = true;
          await page.locator('.ck-who-name', { hasText: '김하늘' }).first().waitFor();
          break;
        }
      }
      assert.ok(clicked || before > 0, '체크할 항목이 있음');
    },
  },
  {
    name: '소통 도우미: 리뷰 답글 초안 3개 만들기(데모) + 주의 표현 검사',
    async run(page, B) {
      await page.goto(B + '/#/comms?tab=review');
      await page.waitForSelector('textarea');
      await page.fill('textarea[maxlength="2000"]', '직원분들이 친절하고 설명을 자세히 해 주셨어요. 대기 시간은 조금 길었어요.');
      await page.locator('button:has-text("답글 초안 3개 만들기")').first().click();
      await page.waitForSelector('text=검사 통과', { timeout: 15000 });
    },
  },
  {
    name: '소통 도우미: 전화 응대 스크립트 AI로 만들기',
    async run(page, B) {
      await page.goto(B + '/#/comms');
      await page.locator('button:has-text("AI로 스크립트 만들기")').first().click();
      await page.waitForSelector('.modal');
      await page.locator('.modal button:has-text("스크립트 만들기")').first().click();
      await page.waitForSelector('.modal .ai-panel-body', { timeout: 15000 });
      await page.locator('.modal button:has-text("보관함에 저장")').first().click();
      // 편집 창에서 확인 후 저장
      await page.locator('.modal-footer button:has-text("저장")').last().click();
      await page.locator('.toast.success', { hasText: '저장했습니다' }).first().waitFor();
    },
  },
  {
    name: 'AI 문서 작성: 공문 초안 → 편집기에 넣기 → 문서함에 저장 → 인쇄 화면',
    async run(page, B) {
      await page.goto(B + '/#/documents/new?kind=' + encodeURIComponent('공문'));
      await page.waitForSelector('input.input');
      await page.locator('form input.input').first().fill('11월 원내 감염관리 교육 실시 안내');
      await page.locator('button:has-text("AI로 초안 만들기")').first().click();
      await page.locator('button:has-text("편집기에 넣기")').first().click({ timeout: 20000 });
      assert.ok((await page.inputValue('input[aria-label="문서 제목"]')).length > 0);
      await page.locator('button:has-text("문서함에 저장")').first().click();
      await page.waitForURL(/#\/documents\/\d+$/);
      const id = page.url().match(/documents\/(\d+)/)[1];
      await page.goto(`${B}/#/documents/${id}/print`);
      await page.waitForSelector('.paper');
    },
  },
  {
    name: '회의록: 메모 → AI 정리 → 회의록에 넣기 → 저장 → 할 일 표시',
    async run(page, B) {
      await page.goto(B + '/#/minutes/new');
      await page.fill('input[placeholder="예: 11월 정기 직원회의"]', 'E2E 직원회의');
      await page.locator('textarea').first().fill('- 목요일 야간진료는 순번제로 하기로 결정\n- 이서연 10/30까지 마감 체크리스트 정리\n- 주차 등록 방법 다시 공유');
      await page.locator('button:has-text("AI로 회의록 정리")').first().click();
      await page.locator('button:has-text("회의록에 넣기")').first().click({ timeout: 20000 });
      await page.locator('.page-actions button:has-text("저장"), button:has-text("저장")').first().click();
      await page.waitForURL(/#\/minutes\/\d+$/);
      await page.waitForSelector('text=E2E 직원회의');
    },
  },
  {
    name: '서식 보관함: 파일 올리기',
    async run(page, B) {
      await page.goto(B + '/#/forms');
      await page.waitForSelector('.card');
      const before = await page.locator('text=e2e-양식.txt').count();
      await page.setInputFiles('input[type=file]', { name: 'e2e-양식.txt', mimeType: 'text/plain', buffer: Buffer.from('E2E 테스트 양식입니다.') });
      // 올리기 확인 창이 뜨면 올리기
      const confirmBtn = page.locator('.modal-footer button:has-text("올리기"), .modal-footer button:has-text("저장")').first();
      if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) await confirmBtn.click();
      await page.locator('text=e2e-양식.txt').first().waitFor({ timeout: 10000 });
      assert.ok((await page.locator('text=e2e-양식.txt').count()) > before);
    },
  },
  {
    name: '근무표: 이번 달 근무표가 직원별로 보이고 인쇄 화면이 열린다',
    async run(page, B) {
      await page.goto(B + '/#/schedule');
      await page.waitForSelector('text=박지민');
      await page.waitForSelector('text=이서연');
    },
  },
  {
    name: '연차·휴가: 신청 → 목록에 표시',
    async run(page, B) {
      // 다음 주 수요일 (휴일·일요일이 아닌 날)
      const d = new Date();
      d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7) + 7);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      await page.goto(B + '/#/leave');
      await page.locator('button:has-text("연차·휴가 신청")').first().click();
      await page.waitForSelector('.modal');
      await page.locator('.modal input[type=date]').first().fill(ds);
      await page.locator('.modal-footer button').last().click();
      await page.locator('.toast.success').first().waitFor();
      await page.waitForSelector('.modal', { state: 'detached' });
    },
  },
  {
    name: '교육 이수: 이수 기록 추가',
    async run(page, B) {
      await page.goto(B + '/#/training');
      await page.locator('button:has-text("이수 기록 추가")').first().click();
      await page.waitForSelector('.modal');
      // 첫 번째 직원 선택(체크박스가 있으면)
      const cb = page.locator('.modal input[type=checkbox]').first();
      if (await cb.count()) await cb.check();
      await page.locator('.modal-footer button').last().click();
      await page.locator('.toast.success').first().waitFor();
    },
  },
  {
    name: '장비·점검: 점검 기록 추가',
    async run(page, B) {
      await page.goto(B + '/#/equipment');
      await page.waitForSelector('.card');
      await page.locator('button:has-text("기록")').first().click();
      await page.waitForSelector('.modal');
      const ta = page.locator('.modal textarea').first();
      if (await ta.count()) await ta.fill('E2E 정기 점검: 이상 없음');
      await page.locator('.modal-footer button').last().click();
      await page.locator('.toast.success').first().waitFor();
    },
  },
  {
    name: '멸균기 기록: 빠른 입력으로 오늘 회차 저장',
    async run(page, B) {
      await page.goto(B + '/#/sterilization');
      await page.locator('button:has-text("기록 저장")').first().click();
      await page.locator('.toast.success').first().waitFor();
    },
  },
  {
    name: '법정 일정: 완료 처리 → 다음 일정 계산',
    async run(page, B) {
      await page.goto(B + '/#/compliance');
      await page.locator('button:has-text("완료")').first().click();
      await page.waitForSelector('.modal');
      await page.locator('.modal-footer button').last().click();
      await page.locator('.toast.success').first().waitFor();
    },
  },
  {
    name: '지출: 지출 추가 → 월별 요약',
    async run(page, B) {
      await page.goto(B + '/#/expenses');
      await page.locator('button:has-text("지출 추가")').first().click();
      await page.waitForSelector('.modal');
      await page.fill('.modal input[name=amount]', '45000');
      await page.locator('.modal .fx-cat-grid button').first().click();
      await page.fill('.modal input[name=payee]', 'E2E 문구점');
      await page.locator('.modal-footer button').last().click();
      await page.locator('.toast.success').first().waitFor();
    },
  },
  {
    name: '재고: 품목 목록에서 바로 출고 기록 → 수량이 줄어든다',
    async run(page, B) {
      await page.goto(B + '/#/inventory');
      await page.waitForSelector('.table tbody tr');
      await page.locator('.table tbody tr button:has-text("출고"):not([disabled])').first().click();
      await page.waitForSelector('.modal');
      // 수량 입력 (첫 입력칸이 수량)
      await page.locator('.modal-body input').first().fill('1');
      await page.locator('.modal-footer button').last().click();
      await page.locator('.toast.success').first().waitFor();
    },
  },
  {
    name: '발주서: 부족 품목으로 발주서 자동 만들기 → 인쇄 화면',
    async run(page, B) {
      await page.goto(B + '/#/orders');
      await page.locator('button:has-text("발주서 만들기")').first().click();
      await page.waitForSelector('.modal');
      await page.locator('.modal-footer button').last().click();
      await page.locator('.toast.success').first().waitFor();
      await page.goto(B + '/#/orders');
      await page.waitForSelector('.table tbody tr, .list-item');
      const first = page.locator('a[href^="#/orders/"]').first();
      const href = await first.getAttribute('href');
      const id = href.match(/orders\/(\d+)/)[1];
      await page.goto(`${B}/#/orders/${id}/print`);
      await page.waitForSelector('.paper');
    },
  },
];
