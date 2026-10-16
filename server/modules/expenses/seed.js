/*
 * 이 파일이 하는 일: [F. 지출] 데모(시연)용 12개월치 지출 예시를 넣습니다. (한 달 15~25건, 현실적인 금액)
 *
 *   - 매달 고정 지출(임대료·관리비·급여·4대보험 등) + 변동 지출(재료비·기공료·식대 등)
 *   - 이번 달은 오늘 날짜까지만 넣습니다.
 *   - 업체 이름은 모두 가상입니다. 급여는 개인별이 아니라 "직원 급여 합계" 한 줄로만 넣습니다.
 *   - 재고 모듈의 거래처가 있으면 재료비 일부를 그 거래처와 연결합니다.
 */
const { all, get, run } = require('../../core/db');
const time = require('../../core/time');

function makeRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function seed(ctx) {
  const { today, users } = ctx;
  const rand = makeRand(4242);
  const between = (a, b, unit = 1000) => Math.round((a + rand() * (b - a)) / unit) * unit;
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const cats = Object.fromEntries(all('SELECT id, name FROM expense_categories').map((c) => [c.name, c.id]));
  const fallback = cats['기타'] || Object.values(cats)[0];
  if (!fallback) return; // 분류가 하나도 없으면 넣지 않음
  const cat = (name) => cats[name] || fallback;

  // 거래처 표가 있으면 재료비·기공료 업체로 연결 (이름만 사용)
  let vendors = [];
  try {
    if (get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'vendors'")) vendors = all('SELECT id, name FROM vendors ORDER BY id LIMIT 20');
  } catch {
    vendors = [];
  }
  const materialVendors = vendors.filter((vd) => !/기공/.test(vd.name));

  const thisMonth = time.thisMonth();
  const todayDay = Number(today.slice(8, 10));
  const now = new Date().toISOString();
  const insert = (date, catName, payee, description, amount, method, vendorId = null, memo = null) => {
    if (date > today) return; // 이번 달은 오늘까지만
    run(
      `INSERT INTO expenses (date, category_id, vendor_id, payee, description, amount, payment_method, memo, source, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'demo', ?, ?, ?)`,
      date,
      cat(catName),
      vendorId,
      payee,
      description,
      amount,
      method,
      memo,
      users.manager || users.admin || null,
      now,
      now
    );
  };

  for (let back = 11; back >= 0; back--) {
    const ym = time.addMonthsYm(thisMonth, -back);
    const last = time.daysInMonth(ym);
    const day = (d) => `${ym}-${String(Math.min(d, last)).padStart(2, '0')}`;
    const rday = (from = 1, to = last) => day(from + Math.floor(rand() * (to - from + 1)));
    const m = Number(ym.slice(5, 7));
    // 여름(7~8월)·연말에는 진료가 많아 재료비·기공료가 조금 더 나오도록
    const busy = m === 7 || m === 8 || m === 12 ? 1.18 : m === 2 ? 0.88 : 1;

    // 고정 지출
    insert(day(25), '임대료', '하늘빌딩 임대인', `${m}월 임대료`, 4800000, '계좌이체');
    insert(day(10), '관리비·공과금', '하늘빌딩 관리사무소', `${m}월 관리비`, between(620000, 760000), '자동이체');
    insert(day(18), '관리비·공과금', '전기요금', `${m}월 전기요금`, between(m >= 6 && m <= 8 ? 520000 : 330000, m >= 6 && m <= 8 ? 690000 : 430000), '자동이체');
    insert(day(20), '관리비·공과금', '인터넷·전화 요금', '인터넷·대표전화 통신비', 88000, '자동이체');
    insert(day(10), '인건비', '직원 급여 (합계)', `${m}월 급여 이체 (직원 6명)`, between(17200000, 17600000, 10000), '계좌이체');
    insert(day(10), '세금·보험', '4대보험', `${m}월 4대보험 (사업자 부담분)`, between(1680000, 1760000), '자동이체');
    insert(day(10), '세금·보험', '원천세 납부', `${m}월 원천세`, between(520000, 610000), '계좌이체');
    insert(day(5), '마케팅·광고', '검색광고 충전', '검색광고 잔액 충전', pick([300000, 400000, 500000]), '카드');
    insert(day(15), '장비·유지보수', '덴탈 소프트웨어 이용료', '진료 예약·전자차트 프로그램 월 이용료', 165000, '카드');

    // 변동 지출: 재료비 3~5건
    const nMat = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < nMat; i++) {
      const vd = materialVendors.length ? pick(materialVendors) : null;
      const payee = vd ? vd.name : pick(['한빛덴탈', '미소메디칼', '푸른치과재료', '바른덴탈몰']);
      insert(rday(), '재료비', payee, pick(['인상재·레진 외', '글러브·마스크·석션팁', '임플란트 픽스처 외', '소독제·멸균 파우치', '본이식재·멤브레인']), Math.round(between(280000, 2400000) * busy / 1000) * 1000, pick(['카드', '카드', '계좌이체']), vd ? vd.id : null);
    }
    // 기공료 2~3건 (월말 정산)
    const nLab = 2 + Math.floor(rand() * 2);
    for (let i = 0; i < nLab; i++) {
      insert(rday(20, last), '기공료', pick(['하늘기공소', '미래치과기공', '정밀덴탈랩']), `${m}월 기공료 정산`, Math.round(between(900000, 3200000) * busy / 1000) * 1000, '계좌이체');
    }
    // 복리후생 2~4건
    const nMeal = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < nMeal; i++) {
      insert(rday(), '복리후생', pick(['하늘김밥', '골목식당', '모퉁이카페', '빵굽는집 베이커리', '한솥 도시락']), pick(['직원 점심 식대', '직원 간식', '커피·음료']), between(28000, 210000), '카드');
    }
    // 사무·소모품 1~2건
    const nOffice = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < nOffice; i++) {
      insert(rday(), '사무·소모품', pick(['온라인몰 사무용품', '다이소', '오피스문구']), pick(['복사지·토너', '청소용품', '문구류']), between(22000, 160000), '카드');
    }
    // 가끔: 장비 수리, 홍보물, 회식, 경조사
    if (rand() < 0.55) insert(rday(), '장비·유지보수', pick(['한빛덴탈 장비AS', '미소메디칼', '바른설비']), pick(['유니트체어 부품 교체', '멸균기 정기 점검', '컴프레서 필터 교체', '핸드피스 수리']), between(50000, 420000), '계좌이체');
    if (rand() < 0.35) insert(rday(), '마케팅·광고', '하늘인쇄', pick(['진료 안내 리플릿 인쇄', '대기실 안내 현수막']), between(90000, 280000), '카드');
    if (m === 12 || m === 6) insert(day(27), '복리후생', '하늘한정식', '직원 회식', between(420000, 680000), '카드');
    if (rand() < 0.2) insert(rday(), '기타', '경조사비', '거래처 경조사', 100000, '현금');
    if (rand() < 0.5) insert(day(last), '기타', '은행 수수료', '이체 수수료', between(3000, 12000, 100), '자동이체');
    if (m === 3) insert(day(14), '세금·보험', '의료배상책임보험', '연간 보험료', 1450000, '계좌이체');
  }
  // 이번 달이 막 시작되어(1~2일) 기록이 거의 없더라도 화면이 비어 보이지 않게 간단한 지출 하나
  if (todayDay <= 2) insert(today, '복리후생', '모퉁이카페', '커피·음료', 32000, '카드');
}

module.exports = { seed };
