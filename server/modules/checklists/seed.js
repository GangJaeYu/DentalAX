/*
 * 이 파일이 하는 일: 체크리스트 데모 데이터를 넣습니다.
 *   - 템플릿 3개: 오픈 체크(월~토), 마감 체크(월~토), 주간 점검(금)
 *   - 지난 30일 기록: 대부분 완료, 가끔 빠뜨린 날·덜 끝낸 날이 있어 "기록" 탭이 자연스럽게 보이도록
 *   - 오늘: 오픈 체크는 일부만 진행, 마감·주간 점검은 아직 시작 전 (대시보드에 할 일로 보임)
 */
const { run, get } = require('../../core/db');
const time = require('../../core/time');

const TEMPLATES = [
  {
    name: '오픈 체크',
    timing: 'open',
    weekdays: '1,2,3,4,5,6',
    description: '첫 진료 시작 전에 확인합니다. 출근 순서대로 나눠서 체크하세요.',
    hour: 8,
    minute: 48,
    items: [
      ['컴프레서·석션 전원 켜기', '작동음과 압력 게이지(초록 범위) 확인', 1],
      ['유니트체어 수관 플러싱 2분', '모든 체어의 핸드피스·3way 시린지 물 빼기', 1],
      ['멸균기 예열 / 전날 BI 결과 확인', '결과는 멸균기 기록 메뉴에 입력', 1],
      ['진료실 표면 소독', '체어·라이트 손잡이·트레이 테이블·스위치', 1],
      ['오늘 예약 현황 확인', '첫 예약 시간과 미리 준비할 기구 확인', 1],
      ['전화 자동응답 해제', '', 1],
      ['대기실 정리·환기', '안내문 정리, 창문 10분 열기', 1],
      ['손 소독제·종이컵·휴지 보충', '', 0],
      ['X-ray 장비 전원·센서 확인', '', 1],
      ['정수기·커피머신 물 보충', '', 0],
    ],
  },
  {
    name: '마감 체크',
    timing: 'close',
    weekdays: '1,2,3,4,5,6',
    description: '마지막 진료가 끝난 뒤 확인합니다. 마지막 퇴근자가 잠금까지 확인해 주세요.',
    hour: 18,
    minute: 36,
    items: [
      ['사용 기구 세척 후 멸균기 가동', '마지막 회차 시작 시각을 멸균기 기록에 입력', 1],
      ['석션 라인 세척액 흡입', '체어마다 물 1컵 + 세척액', 1],
      ['유니트체어 표면 소독·커버 교체', '', 1],
      ['의료폐기물 밀봉 후 보관 장소로 이동', '보관 용기 뚜껑 닫힘 확인', 1],
      ['컴프레서 물 빼기(드레인) 후 전원 끄기', '', 1],
      ['냉장 보관 재료 문 닫힘·온도 확인', '2~8℃', 1],
      ['내일 예약 확인·준비물 메모', '필요하면 인수인계 보드에 남기기', 1],
      ['전화 자동응답 설정', '', 1],
      ['카드 단말기 마감 정산', '', 1],
      ['창문·출입문 잠금, 조명·냉난방 끄기', '보안 경비 설정 포함', 1],
    ],
  },
  {
    name: '주간 점검',
    timing: 'weekly',
    weekdays: '5',
    description: '매주 금요일 진료 마감 후 진행합니다.',
    hour: 18,
    minute: 50,
    items: [
      ['유니트체어 수관 소독', '소독제 희석 비율 확인 후 30분 유지', 1],
      ['석션 트랩(필터) 청소', '장갑·보안경 착용', 1],
      ['응급키트·비상약 유효기간 확인', '에피네프린·산소통 압력 포함', 1],
      ['자동심장충격기(AED) 상태 표시 확인', '초록 표시등', 1],
      ['소독제·멸균 파우치 재고 확인', '부족하면 재고 메뉴에서 발주 요청', 1],
      ['멸균기 챔버·개스킷 청소', '', 1],
      ['냉장고 정리·유효기간 지난 재료 분리', '', 0],
      ['소화기 압력 게이지 확인', '바늘이 초록 범위인지', 0],
    ],
  },
];

// 매번 같은 결과가 나오는 간단한 난수 (실행할 때마다 데모 화면이 달라지지 않게)
function rng(seedNum) {
  let x = seedNum % 2147483647 || 1;
  return () => {
    x = (x * 48271) % 2147483647;
    return x / 2147483647;
  };
}

function isoAt(date, h, m) {
  const d = time.parseDate(date);
  d.setHours(h, m, Math.floor((m * 7) % 60));
  return d.toISOString();
}

function seed(ctx) {
  const { users, today } = ctx;
  const nameOf = (id) => (id ? (get('SELECT name FROM users WHERE id = ?', id) || {}).name : null);
  const openers = [users.hyg1, users.nurse, users.desk, users.hyg2].filter(Boolean);
  const closers = [users.hyg2, users.hyg3, users.nurse, users.manager].filter(Boolean);
  const weekly = [users.manager, users.hyg1].filter(Boolean);
  const pickers = { open: openers, close: closers, weekly };
  const rand = rng(20261016);
  // 지난 30일치 기록을 만들고, 템플릿 시작일도 30일 전으로 (기록 탭의 30일 칸이 꽉 차게)
  const DAYS_BACK = 30;
  const startDate = time.addDays(today, -DAYS_BACK);
  const created = isoAt(startDate, 9, 0);

  TEMPLATES.forEach((t, ti) => {
    const info = run(
      `INSERT INTO checklist_templates (name, timing, weekdays, description, sort_order, active, start_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      t.name,
      t.timing,
      t.weekdays,
      t.description,
      ti + 1,
      startDate,
      created,
      created
    );
    const tid = info.lastInsertRowid;
    const itemIds = t.items.map(([text, hint, req], i) =>
      run('INSERT INTO checklist_items (template_id, text, hint, required, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)', tid, text, hint, req, i + 1, created)
        .lastInsertRowid
    );
    const days = t.weekdays.split(',').map(Number);

    // nth: 오늘부터 거꾸로 센 '해야 했던 날' 순번 (요일과 상관없이 늘 비슷한 모양이 나오게)
    let nth = 0;
    for (let back = 0; back <= DAYS_BACK; back++) {
      const date = time.addDays(today, -back);
      if (!days.includes(time.weekday(date))) continue;
      if (back > 0) nth++;
      // 오늘: 오픈은 7개까지만, 마감·주간은 시작 전(기록 없음)
      let upto = t.items.length;
      if (back === 0) {
        if (t.timing !== 'open') continue;
        upto = 7;
      }
      // 빠뜨린 날(기록 없음) 1번, 덜 끝낸 날 1~2번
      if (t.timing === 'close' && (nth === 7 || nth === 19)) continue;
      if (t.timing === 'open' && nth === 16) continue;
      if (t.timing === 'open' && nth === 4) upto = 8; // 필수 하나 빠짐
      if (t.timing === 'close' && nth === 2) upto = 8;

      const runInfo = run('INSERT INTO checklist_runs (template_id, run_date, created_at) VALUES (?, ?, ?)', tid, date, isoAt(date, t.hour, t.minute - 3));
      const runId = runInfo.lastInsertRowid;
      const people = pickers[t.timing] || openers;
      const who = people[Math.floor(rand() * people.length)] || users.admin;
      const helper = people[Math.floor(rand() * people.length)] || who;
      let minute = t.minute + Math.floor(rand() * 10);
      let lastAt = null;
      let lastBy = null;
      t.items.forEach(([text, hint, req], i) => {
        let checkedAt = null;
        let by = null;
        if (i < upto) {
          minute += 1 + Math.floor(rand() * 3);
          checkedAt = isoAt(date, t.hour + Math.floor(minute / 60), minute % 60);
          by = i % 3 === 2 ? helper : who;
          lastAt = checkedAt;
          lastBy = by;
        }
        let note = '';
        if (t.timing === 'open' && nth === 5 && i === 7) note = '손 소독제 1통 남음 — 실장님께 전달';
        if (t.timing === 'close' && nth === 1 && i === 1) note = '3번 체어 석션 흡입력 약함, 필터 확인 필요';
        if (t.timing === 'weekly' && back > 0 && back <= 7 && i === 4) note = '멸균 파우치(중) 2박스 남음';
        if (t.timing === 'open' && back === 0 && i === 2) note = '전날 BI 음성(정상) 확인';
        run(
          `INSERT INTO checklist_checks (run_id, item_id, text, hint, required, sort_order, checked_at, checked_by, checked_by_name, note, note_by_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          runId,
          itemIds[i],
          text,
          hint,
          req,
          i + 1,
          checkedAt,
          by,
          nameOf(by),
          note,
          note ? nameOf(by || who) : null
        );
      });
      // 필수 항목을 모두 체크했으면 완료 도장
      const reqMissing = t.items.some(([, , req], i) => req && i >= upto);
      if (!reqMissing && lastAt) run('UPDATE checklist_runs SET completed_at = ?, completed_by = ?, completed_by_name = ? WHERE id = ?', lastAt, lastBy, nameOf(lastBy), runId);
    }
  });
}

/** 실제 사용 시작(데모 없이 첫 설정·초기화 후)에 넣는 기본 서식: 오픈·마감·주간 체크리스트 템플릿 (기록 없음) */
function starter(ctx) {
  const created = new Date().toISOString();
  TEMPLATES.forEach((t, ti) => {
    const tid = run(
      `INSERT INTO checklist_templates (name, timing, weekdays, description, sort_order, active, start_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      t.name,
      t.timing,
      t.weekdays,
      t.description,
      ti + 1,
      ctx.today,
      created,
      created
    ).lastInsertRowid;
    t.items.forEach(([text, hint, req], i) =>
      run('INSERT INTO checklist_items (template_id, text, hint, required, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)', tid, text, hint, req, i + 1, created)
    );
  });
}

module.exports = { seed, starter };
