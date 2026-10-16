/*
 * 이 파일이 하는 일: [C. 행정·서류] 데모(시연)용 예시 데이터를 넣습니다.
 *
 *   - 문서함: 내부 규정 "감염관리 수칙", 업무 매뉴얼 2개, 안내문 1개, 공문 1개
 *     (규정·매뉴얼은 "AI 도우미가 참고(include_in_kb=1)"로 표시 — 원내 AI 도우미가 검색해 답할 수 있게 내용을 충분히 적음)
 *   - 회의록 2개 (할 일 중 일부는 기한이 지났거나 곧 다가오게 → 대시보드에 보임)
 *   - 서식 보관함: 작은 예시 파일 4개 (글자로 만든 txt/csv/md 파일)
 * 날짜는 모두 "오늘" 기준 상대값이라 언제 실행해도 자연스럽습니다. 환자 정보는 넣지 않습니다.
 */
const { get, run } = require('../../core/db');
const time = require('../../core/time');

/** 오늘 기준 며칠 전의 시각(ISO) */
function at(today, daysAgo, h = 10) {
  const d = time.parseDate(time.addDays(today, -daysAgo));
  d.setHours(h, 20);
  return d.toISOString();
}

/** 'YYYY-MM-DD' → '9월 24일(목)' */
function md(s) {
  const d = time.parseDate(s);
  return `${d.getMonth() + 1}월 ${d.getDate()}일(${'일월화수목금토'[d.getDay()]})`;
}

const INFECTION_RULES = `## 제1조 (목적)
이 수칙은 하늘치과의원에서 진료 중 생길 수 있는 감염을 막기 위해, 모든 직원이 같은 기준으로 손 위생·보호구 착용·소독·멸균·폐기물 처리를 하도록 정하는 것을 목적으로 한다.

## 제2조 (적용 범위)
이 수칙은 원장, 실장, 치과위생사, 간호조무사, 데스크 직원 등 원내에서 일하는 모든 사람에게 적용한다. 실습생과 외부 수리 기사도 진료실에 들어올 때는 이 수칙을 따른다.

## 제3조 (손 위생)
① 환자 진료 전·후, 장갑을 끼기 전과 벗은 후, 오염된 물건을 만진 후에는 반드시 손을 씻거나 손 소독제를 사용한다.
② 눈에 보이는 오염이 있으면 손 소독제 대신 흐르는 물과 비누로 30초 이상 씻는다.
③ 진료 중에는 반지·팔찌·시계를 착용하지 않고, 손톱은 짧게 유지한다.

## 제4조 (개인 보호구)
① 진료 시에는 마스크, 장갑, 보안경(또는 안면 보호구), 일회용 가운을 착용한다.
② 장갑은 환자마다 새것으로 바꾸고, 찢어지거나 구멍이 나면 즉시 교체한다.
③ 마스크는 젖거나 오염되면 바로 교체하고, 최소 반나절마다 바꾼다.
④ 보호구를 착용한 채 데스크·휴게실에 가지 않는다.

## 제5조 (진료실 표면 소독)
① 환자가 바뀔 때마다 유니트체어, 라이트 손잡이, 트레이, 석션 손잡이 등 손이 닿는 곳을 표면 소독제로 닦는다.
② 소독제는 제품에 적힌 접촉 시간(보통 1~3분)을 지킨 뒤 닦아 낸다. 정확한 시간은 제품 설명서를 확인한다.
③ 하루 진료가 끝나면 석션 라인을 세척액으로 흘려보내고, 바닥과 작업대를 소독한다.
④ 소독제 용기에는 개봉일과 사용 기한을 적는다.

## 제6조 (기구 세척·멸균)
① 사용한 기구는 업무 매뉴얼 "기구 세척·멸균 절차"에 따라 세척 → 건조 → 포장 → 멸균 → 보관 순서로 처리한다.
② 멸균기는 매일 첫 가동 전에 점검하고, 화학적 지시계(CI) 결과를 확인한다.
③ 생물학적 지시계(BI) 검사는 주 1회 실시하고 결과를 멸균기 기록에 남긴다.
④ 멸균 파우치에는 멸균 날짜와 멸균기 회차를 적고, 포장이 젖거나 찢어지면 다시 멸균한다.

## 제7조 (의료폐기물)
① 주삿바늘·메스 날 등 날카로운 것은 손상성 폐기물 전용 용기에 바로 버리고, 뚜껑을 닫는다.
② 피·침이 묻은 거즈·솜은 일반의료폐기물 전용 용기(봉투)에 버린다.
③ 전용 용기는 3/4 이상 차면 밀봉하고 보관 장소로 옮긴다. 보관 기간은 관련 법령 기준을 따른다. (확인 필요)

## 제8조 (날카로운 것에 찔렸을 때)
① 즉시 흐르는 물에 씻고 소독한 뒤 실장 또는 원장에게 바로 보고한다.
② 원장의 판단에 따라 검사와 처치를 받고, 사고 내용을 기록한다.

## 제9조 (교육과 점검)
① 모든 직원은 연 1회 이상 감염관리 교육을 받는다.
② 실장은 매월 첫째 주에 감염관리 자체 점검을 하고, 결과를 직원회의에서 공유한다.

## 부칙
이 수칙은 공지한 날부터 시행하며, 바뀐 내용은 문서함에 바로 반영한다.`;

const STERILIZE_MANUAL = `## 1. 목적
사용한 진료 기구를 누가 처리하더라도 같은 순서와 기준으로 세척·멸균하여, 감염을 막고 기구를 오래 쓰기 위한 매뉴얼입니다.

## 2. 담당
- 기구 처리: 그날 소독실 담당 치과위생사·간호조무사 (근무표의 "소독" 표시)
- 멸균기 점검·기록 확인: 실장
- 이상이 생기면: 바로 실장에게 보고하고, 멸균기 사용을 멈춥니다.

## 3. 준비물
- 두꺼운 고무장갑, 마스크, 보안경, 방수 앞치마
- 효소 세척제, 세척용 솔, 초음파 세척기
- 멸균 파우치, 화학적 지시계(CI) 테이프, 기록지(또는 DentalAX 멸균기 기록)

## 4. 단계별 절차
1. **회수**: 진료가 끝나면 기구를 트레이째 소독실로 옮깁니다. 날카로운 기구는 손으로 집지 말고 트레이에 담아 옮깁니다.
2. **애벌 세척**: 흐르는 물에서 눈에 보이는 피·침·재료를 솔로 닦아 냅니다. 물이 튀지 않게 물속에서 솔질합니다.
3. **초음파 세척**: 효소 세척제를 넣은 초음파 세척기에 기구를 겹치지 않게 넣고 정해진 시간(보통 5~10분) 동안 돌립니다. 정확한 시간은 세척제 설명서를 확인합니다.
4. **헹굼·건조**: 깨끗한 물로 충분히 헹군 뒤 마른 수건이나 건조기로 완전히 말립니다. 물기가 남으면 녹이 슬고 멸균이 잘 안 됩니다.
5. **점검**: 기구 끝이 무뎌지거나 녹·얼룩이 있는지 봅니다. 문제가 있는 기구는 따로 모아 실장에게 알립니다.
6. **포장**: 멸균 파우치에 넣고 밀봉합니다. 파우치에 멸균 날짜, 멸균기 회차, 담당자 이니셜을 적습니다.
7. **멸균**: 파우치를 겹치지 않게 세워서 멸균기에 넣고 정해진 프로그램(예: 134℃)으로 돌립니다.
8. **결과 확인**: 멸균이 끝나면 화학적 지시계 색 변화와 온도·압력 기록을 확인하고 DentalAX "멸균기 기록"에 남깁니다.
9. **보관**: 완전히 식고 마른 뒤 닫힌 보관함에 넣습니다. 먼저 멸균한 것을 앞쪽에 두어 먼저 씁니다.

## 5. 주 1회 생물학적 지시계(BI) 검사
- 매주 월요일 첫 회차에 BI를 함께 넣어 멸균합니다.
- 배양 결과(음성/양성)를 멸균기 기록에 적습니다.
- **양성이 나오면** 즉시 멸균기 사용을 멈추고, 그 이후 멸균한 기구는 다시 멸균하며, 실장에게 보고하고 업체 점검을 요청합니다.

## 6. 주의 사항
- 파우치가 젖었거나 찢어졌거나 바닥에 떨어진 경우 다시 포장해서 멸균합니다.
- 멸균기 문은 압력이 완전히 빠진 뒤에 엽니다.
- 일회용 기구는 다시 멸균해서 쓰지 않습니다.

## 7. 기록
- 멸균기 회차별 기록: DentalAX "멸균기 기록" 메뉴 (환자 정보는 적지 않습니다)
- 기구 파손·분실: 인수인계 보드에 남깁니다.`;

const PHONE_MANUAL = `## 1. 목적
전화 응대와 예약 변경을 누가 받더라도 친절하고 정확하게 처리하기 위한 기준입니다. 진료 내용 상담은 하지 않고, 필요하면 원장님 또는 실장님께 연결합니다.

## 2. 기본 인사
- 전화는 벨이 세 번 울리기 전에 받습니다.
- 첫 인사: "감사합니다, 하늘치과의원 ○○○입니다. 무엇을 도와드릴까요?"
- 끝 인사: "더 궁금하신 점 있으시면 언제든 연락 주세요. 감사합니다."
- 상대가 먼저 끊은 뒤에 수화기를 내려놓습니다.

## 3. 자주 받는 문의
1. **진료 시간**: 병원 정보에 등록된 진료 시간과 점심시간, 휴진일을 안내합니다. 공휴일·연휴 진료는 공지를 확인한 뒤 안내합니다.
2. **주차·오시는 길**: 건물 지하 주차장 이용 가능, 진료 시 데스크에서 주차 등록을 안내합니다.
3. **비용 문의**: 정확한 비용은 진료 후 상담에서 안내드린다고 말씀드립니다. 전화로 금액을 단정해서 말하지 않습니다.
4. **보험 문의**: 스케일링 연 1회 보험 적용 등 일반적인 내용만 안내하고, 개별 적용 여부는 내원 시 확인해 드린다고 안내합니다.

## 4. 예약 변경 처리 절차
1. 예약자 본인 확인을 합니다. (예약 프로그램에서 확인하고, 이 서비스에는 환자 정보를 적지 않습니다)
2. 기존 예약 일시를 확인하고, 원하시는 날짜·시간대를 여쭙니다.
3. 예약 프로그램에서 가능한 시간을 2~3개 제안합니다.
4. 변경이 확정되면 날짜·시간을 한 번 더 또박또박 확인해 드립니다.
5. 변경 안내 문자를 보냅니다. (소통 도우미의 "예약 변경 안내" 문구 사용)
6. 당일 취소·변경이 잦은 시간대는 실장님께 알려 다음 예약 조정에 참고합니다.

## 5. 당일 늦거나 못 오시는 경우
- 15분 이상 늦으시면 진료 시간이 줄거나 다음 환자 진료로 기다리실 수 있음을 정중히 안내합니다.
- 노쇼(연락 없이 안 오신 경우)는 다음 날 오전에 확인 전화를 드립니다.

## 6. 불만 전화
1. 말씀을 끊지 않고 끝까지 듣습니다.
2. "불편을 드려 죄송합니다"로 먼저 공감합니다.
3. 바로 답하기 어려운 내용은 "확인 후 오늘 안에 다시 연락드리겠습니다"라고 약속하고, 인수인계 보드에 남깁니다.
4. 진료 결과에 대한 불만은 원장님 또는 실장님께 바로 연결합니다.

## 7. 하지 않는 것
- 진단이나 치료 효과를 전화로 단정하지 않습니다.
- 다른 병원과 비교하는 말을 하지 않습니다.
- 환자 이름·연락처를 메모지나 이 서비스에 적어 두지 않습니다.`;

function holidayNotice(clinic, start, end, reopen) {
  return `안녕하세요, ${clinic}입니다.

추석 연휴 기간 동안 아래와 같이 휴진하오니 진료 일정에 참고해 주시기 바랍니다.

## 휴진 기간
- **${md(start)} ~ ${md(end)}** (3일간)
- **${md(reopen)}**부터 정상 진료합니다.

## 참고해 주세요
- 연휴 직후에는 예약이 많아 대기 시간이 길어질 수 있습니다. 미리 예약해 주시면 기다리는 시간을 줄일 수 있습니다.
- 연휴 중 갑자기 치아가 아프시면 가까운 응급 진료 기관(응급실, 휴일 지킴이 약국 등)을 이용해 주세요.
- 예약 변경은 연휴 전날까지 전화로 말씀해 주세요.

즐겁고 건강한 한가위 보내시길 바랍니다.

${clinic} 임직원 드림`;
}

function officialLetter(clinic, phone, today) {
  return `**문서번호**: 하늘치과-${today.slice(0, 4)}-014
**시행일자**: ${time.parseDate(today).getFullYear()}년 ${time.parseDate(today).getMonth() + 1}월 ${time.parseDate(today).getDate()}일
**수신**: 한빛덴탈 영업팀장
**참조**: 거래 담당자
**제목**: 정기 납품 일정 변경 요청

---

**1.** 귀사의 무궁한 발전을 기원합니다.
**2.** 당원의 진료 일정 변경(매주 목요일 야간진료 시행)에 따라 정기 납품 일정을 아래와 같이 변경하여 주시기를 요청드립니다.

**〈 아 래 〉**

가. 변경 전: 매주 목요일 오전 10시
나. 변경 후: 매주 수요일 오후 2시 ~ 4시
다. 적용 시작: 다음 달 첫째 주부터
라. 긴급 주문: 기존과 같이 전화 주문 후 당일 또는 다음 날 배송

**3.** 일정 변경이 어려운 경우 회신하여 주시면 다시 협의하겠습니다.
**4.** 문의 사항은 ${clinic} 실장(${phone})에게 연락 주시기 바랍니다.

끝.

**${clinic} 원장**  (직인 생략)`;
}

function seed(ctx) {
  const { users, today } = ctx;
  const nameOf = (id) => (id ? (get('SELECT name FROM users WHERE id = ?', id) || {}).name || '' : '');
  const N = {
    admin: nameOf(users.admin),
    manager: nameOf(users.manager),
    hyg1: nameOf(users.hyg1),
    hyg2: nameOf(users.hyg2),
    hyg3: nameOf(users.hyg3),
    nurse: nameOf(users.nurse),
    desk: nameOf(users.desk),
  };
  const clinic = '하늘치과의원';
  const phone = '02-555-0123';

  // ----- 문서함 -----
  const holidayStart = time.addDays(today, -22);
  const docs = [
    { kind: '내부 규정', title: '감염관리 수칙', content: INFECTION_RULES, status: 'final', tags: '감염관리, 필수', kb: 1, by: users.admin, ago: 40 },
    { kind: '업무 매뉴얼', title: '기구 세척·멸균 절차', content: STERILIZE_MANUAL, status: 'final', tags: '멸균, 소독실', kb: 1, by: users.manager, ago: 33 },
    { kind: '업무 매뉴얼', title: '전화 응대·예약 변경 처리', content: PHONE_MANUAL, status: 'final', tags: '데스크, 전화', kb: 1, by: users.manager, ago: 18 },
    { kind: '안내문', title: '추석 연휴 휴진 안내', content: holidayNotice(clinic, holidayStart, time.addDays(holidayStart, 2), time.addDays(holidayStart, 3)), status: 'final', tags: '휴진, 연휴', kb: 0, by: users.manager, ago: 32 },
    { kind: '공문', title: '정기 납품 일정 변경 요청', content: officialLetter(clinic, phone, time.addDays(today, -3)), status: 'draft', tags: '거래처', kb: 0, by: users.admin, ago: 3 },
  ];
  for (const d of docs) {
    const created = at(today, d.ago);
    run(
      `INSERT INTO documents (type, doc_kind, title, content, status, tags, include_in_kb, created_by, updated_by, created_at, updated_at)
       VALUES ('doc', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.kind,
      d.title,
      d.content,
      d.status,
      d.tags,
      d.kb,
      d.by,
      d.by,
      created,
      created
    );
  }

  // ----- 회의록 -----
  const m1Date = time.addDays(today, -6);
  const m2Date = time.addDays(today, -2);
  const minutes = [
    {
      title: '10월 정기 직원회의',
      date: m1Date,
      attendees: [N.admin, N.manager, N.hyg1, N.hyg2, N.hyg3, N.nurse, N.desk],
      summary: '다음 달부터 시작하는 목요일 야간진료 준비와 연휴 이후 예약 관리, 소독실 정리 방법을 논의했습니다. 야간 근무는 순번제로 하기로 했고, 신규 직원 교육 일정을 이번 주 안에 정리하기로 했습니다.',
      content: `## 논의 내용
- 목요일 야간진료(20:00까지) 시작에 따른 근무 순번과 데스크 마감 방법
- 연휴 직후 예약 몰림 대응 — 오전 첫 타임 예약을 15분 단위로 조정
- 소독실 멸균 파우치 보관함 정리 상태 점검
- 신규 직원 입사에 따른 교육 일정

## 결정 사항
- 야간진료는 치과위생사 2명 + 데스크 1명이 순번제로 근무한다.
- 야간 마감 체크리스트를 따로 만든다.
- 멸균 파우치 보관함은 날짜순으로 정리하고 라벨을 붙인다.`,
      items: [
        { task: '연휴 진료 일정 안내 문자 발송', owner: N.desk, due: time.addDays(today, -4), done: true },
        { task: '멸균 파우치 보관함 정리·라벨 붙이기', owner: N.nurse, due: time.addDays(today, -1), done: false },
        { task: '야간 마감 체크리스트 초안 만들기', owner: N.hyg1, due: time.addDays(today, 2), done: false },
        { task: '신규 직원 교육 일정표 작성', owner: N.manager, due: time.addDays(today, 3), done: false },
        { task: '감염관리 교육 자료 검토', owner: N.admin, due: time.addDays(today, 4), done: false },
      ],
      by: users.manager,
      ago: 6,
    },
    {
      title: '감염관리 자체 점검 결과 회의',
      date: m2Date,
      attendees: [N.admin, N.manager, N.hyg2, N.nurse],
      summary: '이번 달 감염관리 자체 점검 결과 대부분 양호했으나 소독제 개봉일 표기 누락이 2건 있었습니다. 개봉일 라벨을 일괄 부착하고, BI 검사 기록 방법을 바꾸기로 했습니다.',
      content: `## 점검 결과
- 손 위생·보호구 착용: 양호
- 진료실 소독제 개봉일 표기 누락 2건 (2번, 4번 체어)
- 멸균기 BI 검사: 매주 정상 실시, 결과 모두 음성

## 결정 사항
- 모든 소독제 용기에 개봉일 라벨을 붙인다.
- BI 검사 결과는 DentalAX 멸균기 기록에 바로 입력한다. (종이 기록지는 이번 달까지만)
- 다음 자체 점검은 다음 달 첫째 주에 한다.`,
      items: [
        { task: '소독제 용기 개봉일 라벨 일괄 부착', owner: N.hyg2, due: time.addDays(today, 1), done: false },
        { task: '진료실 표면 소독 순서를 감염관리 수칙에 반영', owner: N.manager, due: time.addDays(today, 12), done: false },
        { task: 'BI 검사 종이 기록지 정리 후 보관', owner: N.nurse, due: time.addDays(today, 10), done: true },
      ],
      by: users.admin,
      ago: 2,
    },
  ];
  for (const m of minutes) {
    const created = at(today, m.ago, 17);
    run(
      `INSERT INTO documents (type, doc_kind, title, content, status, meeting_date, attendees, action_items, summary, created_by, updated_by, created_at, updated_at)
       VALUES ('minutes', NULL, ?, ?, 'final', ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.title,
      m.content,
      m.date,
      m.attendees.filter(Boolean).join(', '),
      JSON.stringify(m.items.map((x) => ({ ...x, owner: x.owner || '' }))),
      m.summary,
      m.by,
      m.by,
      created,
      created
    );
  }

  // ----- 서식 보관함 (작은 예시 파일) -----
  const files = [
    {
      name: '연차 신청서 양식.txt',
      mime: 'text/plain',
      category: '서식',
      description: '종이로 연차를 신청할 때 쓰는 기본 양식 (DentalAX 연차 메뉴로도 신청 가능)',
      text: `연 차 (휴 가) 신 청 서\n\n소속: ${clinic}\n성명:                    직종:\n\n신청 종류:  [ ] 연차   [ ] 반차(오전/오후)   [ ] 경조사   [ ] 기타\n기간:      년    월    일  ~      년    월    일  (   일간)\n사유:\n\n업무 인수인계 담당자:\n인수인계 내용:\n\n위와 같이 휴가를 신청합니다.\n\n신청일:      년    월    일\n신청자:              (서명)\n\n실장 확인:           원장 승인:\n`,
      by: users.manager,
      ago: 50,
    },
    {
      name: '물품 요청서.csv',
      mime: 'text/csv',
      category: '서식',
      description: '재료·소모품이 필요할 때 실장님께 제출하는 요청서 (엑셀에서 열림)',
      text: '﻿요청일,요청자,품목명,규격,수량,단위,사용 위치,급한 정도,비고\n,,니트릴 장갑,M,2,박스,진료실,보통,\n,,멸균 파우치,90x260,1,박스,소독실,급함,\n,,,,,,,,\n',
      by: users.manager,
      ago: 45,
    },
    {
      name: '신규 직원 체크리스트.md',
      mime: 'text/markdown',
      category: '교육 자료',
      description: '입사 첫 주에 함께 확인할 항목 (온보딩 메뉴와 같이 사용)',
      text: `# 신규 직원 첫 주 체크리스트\n\n## 첫날\n- [ ] 근로계약서 작성·서명\n- [ ] DentalAX 계정 만들기, 비밀번호 바꾸기\n- [ ] 원내 둘러보기 (진료실, 소독실, 기공물 보관함, 비상구)\n- [ ] 감염관리 수칙 읽기\n\n## 1~3일차\n- [ ] 기구 세척·멸균 절차 따라 하기 (선임과 함께)\n- [ ] 오픈·마감 체크리스트 익히기\n- [ ] 전화 응대·예약 변경 매뉴얼 읽기\n\n## 첫 주 마지막 날\n- [ ] 실장님과 면담 (어려운 점, 궁금한 점)\n- [ ] 법정 의무교육 일정 확인\n`,
      by: users.manager,
      ago: 20,
    },
    {
      name: '근로계약 시 확인 항목.txt',
      mime: 'text/plain',
      category: '계약서',
      description: '근로계약서를 쓰기 전에 빠뜨리지 않도록 확인할 항목 목록 (세부 조건은 노무사 확인 권장)',
      text: '근로계약 시 확인 항목\n\n1. 계약 기간 (정함이 없는 계약 / 기간제)\n2. 근무 장소와 업무 내용\n3. 근로 시간, 휴게 시간 (야간진료 포함 여부)\n4. 근무일과 주휴일\n5. 임금 (기본급, 수당, 지급일, 지급 방법)\n6. 연차 유급휴가\n7. 4대 보험 가입\n8. 수습 기간과 조건\n9. 계약서 사본 교부 (근로자에게 1부)\n\n※ 세부 조건과 법적 기준은 노무사 등 전문가 확인이 필요합니다.\n',
      by: users.admin,
      ago: 60,
    },
  ];
  for (const f of files) {
    const buf = Buffer.from(f.text, 'utf8');
    run(
      `INSERT INTO files (name, mime, size, data, category, description, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      f.name,
      f.mime,
      buf.length,
      new Uint8Array(buf),
      f.category,
      f.description,
      f.by,
      at(today, f.ago, 11)
    );
  }
}

module.exports = { seed };
