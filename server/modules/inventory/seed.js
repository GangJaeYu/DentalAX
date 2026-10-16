/*
 * 이 파일이 하는 일: 재고·구매 데모(시연) 데이터를 넣습니다. (가상의 "하늘치과의원" 기준, 업체·담당자 이름은 모두 가상)
 *
 *  - 거래처 5곳, 치과 품목 27개
 *  - 최근 60일 동안의 입고·출고 기록을 "날마다 조금씩 쓰고, 모자라면 다시 들이는" 방식으로 만들어 현실적인 숫자가 나오게 함
 *    (실제 입고·출고 함수(stock.js)를 그대로 써서 로트·단가 기록·재고 숫자가 서로 맞음)
 *  - 대시보드가 비어 보이지 않도록: 재고 부족 몇 개, 유효기간 임박(D-12 등)·만료 로트, 단가 변동, 발주서 3건(입고 완료·발주함·작성 중)
 *  - 날짜는 모두 ctx.today 기준 "며칠 전" 으로 만들어 언제 실행해도 자연스럽습니다.
 */
const { run, get } = require('../../core/db');
const time = require('../../core/time');
const stock = require('./stock');
const orders = require('./routes-orders');

const VENDORS = {
  hanbit: { name: '한빛덴탈', category: '재료상', contact: '강도윤 과장', phone: '02-555-0187', email: 'order@hanbit-dental.example', method: '카카오톡', web: 'www.hanbit-dental.example', pay: '월말 마감, 익월 10일 계좌이체', memo: '오후 3시 전 주문하면 다음 날 도착. 레진·약품 주력.' },
  miso: { name: '미소메디칼', category: '소모품', contact: '윤서준 대리', phone: '031-555-0142', email: 'cs@miso-medical.example', method: '웹사이트', web: 'www.miso-medical.example', pay: '카드 결제 (주문 시)', memo: '5만원 이상 무료배송. 장갑·마스크는 대량 주문 시 단가 협의 가능.' },
  bareun: { name: '바른기공소', category: '기공소', contact: '임하준 실장', phone: '02-555-0163', email: null, method: '카카오톡', web: null, pay: '월 2회 정산 (15일·말일)', memo: '기공물 픽업 매일 오후 5시. 급한 건은 카톡으로 미리 연락.' },
  clean: { name: '클린위생', category: '소모품', contact: '한지우 주임', phone: '02-555-0119', email: 'sales@clean-wi.example', method: '이메일', web: null, pay: '월말 세금계산서 발행 후 이체', memo: '멸균·소독 용품 전문. 이메일 주문 시 당일 출고.' },
  daehan: { name: '대한장비', category: '장비업체', contact: '오시우 기사', phone: '02-555-0175', email: null, method: '전화', web: null, pay: '수리·부품 현장 결제', memo: '유니트체어·컴프레서 AS 담당. 부품도 함께 주문 가능.' },
};

// [키, 이름, 분류, 단위, 규격, 거래처, 적정, 발주수량, 위치, 유효기간관리, 단가, 하루 사용량, 출고 간격(일), 추가 설정]
const ITEMS = [
  ['gloveM', '니트릴 장갑 M', '소모품', '박스', '100매', 'miso', 10, 20, '소모품 창고 A-1', 0, 6500, 0.6, 2],
  ['gloveS', '니트릴 장갑 S', '소모품', '박스', '100매', 'miso', 6, 10, '소모품 창고 A-1', 0, 6500, 0.35, 3, { endQty: 3 }],
  ['mask', '덴탈 마스크', '소모품', '박스', '50매', 'miso', 8, 20, '소모품 창고 A-2', 0, 4800, 0.5, 2],
  ['suction', '석션 팁', '소모품', '봉', '100개', 'miso', 5, 10, '진료실 공용 서랍', 0, 5500, 0.3, 3, { endQty: 2 }],
  ['gauze', '멸균 거즈', '소모품', '팩', '2x2인치 200매', 'miso', 10, 20, '소모품 창고 A-3', 0, 3200, 0.5, 2],
  ['cotton', '코튼롤', '소모품', '봉', '#2 500개', 'miso', 4, 8, '소모품 창고 A-3', 0, 4500, 0.15, 4],
  ['cup', '일회용 종이컵', '소모품', '줄', '50개', 'miso', 10, 30, '진료실 공용 서랍', 0, 1200, 0.9, 2],
  ['bib', '일회용 턱받이', '소모품', '박스', '500매', 'miso', 2, 4, '소모품 창고 A-2', 0, 18000, 0.05, 7],
  ['floss', '치실', '사무·위생', '개', '50m (환자 지급용)', 'miso', 10, 30, '데스크 수납장', 0, 1500, 0.5, 3],
  ['resinA2', '복합레진 A2', '재료', '개', '4g 시린지', 'hanbit', 3, 5, '재료장 B-1', 1, 38000, 0.12, 4, { endQty: 1, priceStep: [-30, 41000] }],
  ['resinA3', '복합레진 A3', '재료', '개', '4g 시린지', 'hanbit', 3, 5, '재료장 B-1', 1, 38000, 0.1, 5, { freezeAfter: -8 }],
  ['flow', '플로어블 레진 A2', '재료', '개', '2g 시린지', 'hanbit', 2, 4, '재료장 B-1', 1, 24000, 0.06, 7],
  ['temp', '임시충전재', '재료', '통', '30g', 'hanbit', 2, 3, '재료장 B-2', 1, 12000, 0.05, 7],
  ['lido', '리도카인 앰플', '약품', '박스', '2% 1.8mL 50앰플', 'hanbit', 2, 3, '약품장 (잠금)', 1, 32000, 0.06, 7, { freezeAfter: -8, priceStep: [-35, 34500] }],
  ['file', '근관 파일', '기구', '팩', '#15-40 25mm 6개입', 'hanbit', 4, 6, '재료장 B-3', 0, 9500, 0.1, 5],
  ['alg', '알지네이트 인상재', '재료', '봉', '453g', 'hanbit', 3, 5, '재료장 B-2', 1, 8500, 0.12, 4],
  ['fluor', '불소 바니쉬', '약품', '박스', '0.4mL 50개입', 'hanbit', 1, 2, '약품장 (잠금)', 1, 45000, 0.02, 10, { shelf: 56 }],
  ['paste', '프로파일락시스 페이스트', '재료', '통', '340g', 'hanbit', 1, 2, '재료장 B-2', 1, 16000, 0.03, 10],
  ['disinf', '표면 소독제', '사무·위생', '통', '물티슈형 160매', 'clean', 4, 6, '멸균실 선반', 1, 9800, 0.25, 3],
  ['pouch', '멸균 파우치', '소모품', '박스', '90x230mm 200매', 'clean', 3, 5, '멸균실 선반', 0, 15000, 0.12, 4, { endQty: 2, priceStep: [-40, 16500] }],
  ['bi', 'BI 인디케이터', '소모품', '박스', '25개입', 'clean', 1, 2, '멸균실 선반', 1, 52000, 0, 0, { scripted: true }],
  ['hand', '손 소독제', '사무·위생', '개', '500mL 펌프', 'clean', 3, 6, '데스크 수납장', 1, 6500, 0.08, 7],
  ['towel', '핸드타올', '사무·위생', '박스', '5000매', 'clean', 2, 4, '소모품 창고 A-4', 0, 23000, 0.06, 7],
  ['ethanol', '소독용 에탄올', '약품', '병', '1L', 'clean', 2, 4, '멸균실 선반', 1, 7000, 0.05, 7],
  ['oil', '핸드피스 오일', '기구', '개', '500mL 스프레이', 'daehan', 1, 2, '멸균실 선반', 0, 28000, 0.03, 10, { endQty: 0 }],
  ['filter', '석션 필터', '기구', '개', '유니트체어용', 'daehan', 2, 4, '장비 부품함', 0, 9000, 0.04, 10],
  ['paper', 'A4 복사용지', '사무·위생', '박스', '2500매', null, 1, 2, '데스크 수납장', 0, 26000, 0.04, 10, { endQty: 1 }],
];

const OUT_NOTES = ['진료실 사용', '진료실 보충', '오전 진료 준비', '오후 진료 준비', '체어 세팅', null, null, null];
const LOT_PREFIX = { resinA2: 'RA2', resinA3: 'RA3', flow: 'FL', temp: 'TF', lido: 'LD', alg: 'AG', fluor: 'FV', paste: 'PP', disinf: 'SD', hand: 'HS', ethanol: 'ET', bi: 'BI' };

/** 매번 같은 결과가 나오는 간단한 난수 (데모 데이터가 실행할 때마다 달라지지 않게) */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seed(ctx) {
  const { users, today } = ctx;
  const rand = rng(20261016);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const staff = [users.hyg1, users.hyg2, users.hyg3, users.nurse, users.desk].filter(Boolean);
  const manager = users.manager || users.admin;
  const now = time.nowIso();

  /** 오늘 기준 day일(음수=과거) hour시 mm분의 시각 */
  const at = (day, hour, min = Math.floor(rand() * 50)) => {
    const d = time.parseDate(time.addDays(today, day));
    d.setHours(hour, min, Math.floor(rand() * 59));
    return { date: time.addDays(today, day), at: d.toISOString() };
  };

  // ---- 거래처 ----
  const vid = {};
  for (const [key, x] of Object.entries(VENDORS)) {
    vid[key] = run(
      `INSERT INTO vendors (name, category, contact_name, phone, email, order_method, website, payment_terms, memo, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      x.name,
      x.category,
      x.contact,
      x.phone,
      x.email,
      x.method,
      x.web,
      x.pay,
      x.memo,
      now,
      now
    ).lastInsertRowid;
  }

  // ---- 품목 ----
  const items = ITEMS.map(([key, name, category, unit, spec, vendor, min, reorder, location, track, price, rate, every, opt = {}]) => {
    const created = at(-61, 9).at;
    const id = run(
      `INSERT INTO inv_items (name, category, unit, spec, vendor_id, min_qty, reorder_qty, location, current_qty, track_expiry, last_unit_price, memo, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, 1, ?, ?)`,
      name,
      category,
      unit,
      spec,
      vendor ? vid[vendor] : null,
      min,
      reorder,
      location,
      track,
      key === 'lido' ? '마취제 — 개봉 후 앰플은 당일 사용' : key === 'bi' ? '멸균기 주 1회 BI 검사용' : null,
      created,
      created
    ).lastInsertRowid;
    return { key, id, name, min, reorder, track, price, rate, every, opt, offset: Math.floor(rand() * Math.max(1, every)), lotSeq: 0 };
  });
  const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
  const cur = (it) => get('SELECT current_qty FROM inv_items WHERE id = ?', it.id).current_qty;

  /** 그날 단가 (가격 변동일 이후면 새 단가) */
  const priceOn = (it, day) => (it.opt.priceStep && day >= it.opt.priceStep[0] ? it.opt.priceStep[1] : it.price);
  /** 로트 번호와 유효기간 (유효기간 관리 품목만) */
  const lotFor = (it, day) => {
    if (!it.track) return {};
    it.lotSeq++;
    const d = time.addDays(today, day);
    return { lotNo: `${LOT_PREFIX[it.key] || 'LT'}${d.slice(2, 4)}${d.slice(5, 7)}-${String(it.lotSeq).padStart(2, '0')}`, expiryDate: time.addDays(d, it.opt.shelf || 420 + Math.floor(rand() * 300)) };
  };
  const restock = (it, day, qty, note) => {
    const t = at(day, 10 + Math.floor(rand() * 6));
    stock.receive(it.id, { qty, unitPrice: priceOn(it, day), ...lotFor(it, day), note }, { userId: manager, ...t });
  };

  // ---- 시작 재고 (60일 전 입고) ----
  for (const it of items) {
    if (it.opt.scripted) continue;
    const start = Math.max(it.min + Math.max(it.reorder, 1), Math.ceil(it.rate * 24));
    restock(it, -60, start, '기초 재고 입고');
  }

  // ---- BI 인디케이터: 만료 로트가 1박스 남은 상황을 대본대로 ----
  const bi = byKey.bi;
  stock.receive(bi.id, { qty: 2, unitPrice: 52000, lotNo: 'BI2404-01', expiryDate: time.addDays(today, -5), note: '기초 재고 입고' }, { userId: manager, ...at(-58, 11) });
  stock.consume(bi.id, { qty: 1, note: '멸균기 주간 BI 검사' }, { userId: users.nurse || manager, ...at(-45, 9) });
  stock.receive(bi.id, { qty: 2, unitPrice: 52000, lotNo: 'BI2410-02', expiryDate: time.addDays(today, 330), note: '택배 입고' }, { userId: manager, ...at(-30, 14) });
  stock.consume(bi.id, { qty: 1, note: '멸균기 주간 BI 검사' }, { userId: users.nurse || manager, ...at(-2, 9) });

  // ---- 발주서 1: 미소메디칼 (입고 완료, 장갑·마스크 단가 변동 포함) ----
  const po1Lines = [
    { itemId: byKey.gloveM.id, qty: 20, unitPrice: 7200 },
    { itemId: byKey.mask.id, qty: 20, unitPrice: 4500 },
    { itemId: byKey.gauze.id, qty: 20, unitPrice: 3200 },
    { itemId: byKey.cup.id, qty: 30, unitPrice: 1200 },
  ];
  let po1 = null;

  // ---- 60일 동안 날마다: 쓰고(출고), 모자라면 들이기(입고) ----
  for (let day = -59; day <= -1; day++) {
    const date = time.addDays(today, day);
    if (time.weekday(date) === 0) continue; // 일요일 휴진
    if (day === -21) {
      po1 = orders.createPo({ vendorId: vid.miso, orderDate: date, expectedDate: time.addDays(today, -18), note: '월간 소모품 정기 주문', items: po1Lines, status: 'ordered' }, manager, at(-21, 10));
    }
    if (day === -18 && po1) orders.receivePo(po1, { all: true }, manager, at(-18, 15));

    for (const it of items) {
      if (it.opt.scripted || !it.every) continue;
      if (it.opt.freezeAfter !== undefined && day > it.opt.freezeAfter) continue;
      // 가격이 바뀐 날에는 새 단가로 한 번 들여옴 (단가 변동 기록이 생기도록)
      if (it.opt.priceStep && day === it.opt.priceStep[0]) restock(it, day, Math.max(it.reorder, 1), '단가 변경 안내 후 첫 입고');
      if ((day + 60 + it.offset) % it.every === 0) {
        const q = Math.max(1, Math.round(it.rate * it.every * (0.7 + rand() * 0.6)));
        const have = cur(it);
        const take = Math.min(q, Math.floor(have));
        if (take > 0) stock.consume(it.id, { qty: take, note: pick(OUT_NOTES) }, { userId: pick(staff) || manager, ...at(day, 9 + Math.floor(rand() * 9)) });
      }
      // 적정 재고 이하가 되면 다음 입고 (끝에 부족 상태로 남길 품목은 최근 2주간 입고하지 않음)
      const lowEnd = it.opt.endQty !== undefined;
      if (cur(it) <= it.min && !(lowEnd && day > -14)) restock(it, day, Math.max(it.reorder, 1), pick(['택배 입고', '방문 납품', '정기 입고']));
    }
    // 중간 실사 예시
    if (day === -14) stock.adjust(byKey.cotton.id, { actualQty: Math.max(0, cur(byKey.cotton) - 1), note: '월 중간 실사 — 1봉 젖어서 폐기' }, { userId: manager, ...at(day, 18, 10) });
    if (day === -30) stock.adjust(byKey.gauze.id, { actualQty: cur(byKey.gauze) + 2, note: '창고 정리 중 상자 발견' }, { userId: manager, ...at(day, 18, 20) });
  }

  // ---- 유효기간 임박 로트 (대본) ----
  stock.receive(byKey.lido.id, { qty: 1, unitPrice: 34500, lotNo: 'LD2404-07', expiryDate: time.addDays(today, 12), note: '거래처 요청으로 짧은 유효기간 제품 입고 (먼저 사용)' }, { userId: manager, ...at(-6, 11) });
  stock.receive(byKey.resinA3.id, { qty: 2, unitPrice: 36000, lotNo: 'RA32411-05', expiryDate: time.addDays(today, 25), note: '할인 행사분 (유효기간 짧음)' }, { userId: manager, ...at(-5, 15) });

  // ---- 마지막 상태 맞추기: 부족으로 남길 품목은 목표 수량까지 사용, 나머지는 부족하면 채움 ----
  for (const it of items) {
    if (it.opt.scripted) continue;
    const have = cur(it);
    if (it.opt.endQty !== undefined) {
      if (have > it.opt.endQty) stock.consume(it.id, { qty: stock.r3(have - it.opt.endQty), note: '진료실 보충' }, { userId: pick(staff) || manager, ...at(-1, 17) });
    } else if (have <= it.min) {
      restock(it, -1, Math.max(it.reorder, 1), '정기 입고');
    }
  }

  // ---- 오늘 아침 출고 몇 건 (지금 시각보다 앞선 시각으로) ----
  const morning = (minsAgo) => {
    const t = new Date(Math.max(Date.now() - minsAgo * 60000, time.parseDate(today).getTime() + 5 * 60000));
    return { date: today, at: t.toISOString() };
  };
  stock.consume(byKey.gloveM.id, { qty: 1, note: '오전 진료 준비' }, { userId: staff[0] || manager, ...morning(95) });
  stock.consume(byKey.cup.id, { qty: 1, note: '오전 진료 준비' }, { userId: staff[1] || manager, ...morning(60) });

  // ---- 발주서 2: 한빛덴탈 (발주함, 입고 예정일 하루 지남) ----
  orders.createPo(
    {
      vendorId: vid.hanbit,
      orderDate: time.addDays(today, -4),
      expectedDate: time.addDays(today, -1),
      note: '레진 A2 재고 부족 — 택배 발송했다고 연락 받음',
      items: [
        { itemId: byKey.resinA2.id, qty: 5, unitPrice: 41000 },
        { itemId: byKey.temp.id, qty: 3, unitPrice: 12000 },
        { itemId: byKey.alg.id, qty: 5, unitPrice: 8500 },
      ],
      status: 'ordered',
    },
    manager,
    at(-4, 11)
  );

  // ---- 발주서 3: 클린위생 (작성 중) ----
  orders.createPo(
    {
      vendorId: vid.clean,
      expectedDate: time.addDays(today, 4),
      note: '이번 주 안에 이메일로 발주 예정',
      items: [
        { itemId: byKey.pouch.id, qty: 5, unitPrice: 16500 },
        { itemId: byKey.disinf.id, qty: 6, unitPrice: 9800 },
      ],
    },
    manager,
    morning(30)
  );
}

module.exports = { seed };
