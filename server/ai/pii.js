/*
 * 이 파일이 하는 일: AI로 보내기 전에 글 속의 개인정보를 찾아내 가리거나(마스킹) 막습니다. (개인정보 필터)
 *
 * 찾는 것 (위에서부터 순서대로 검사 — 먼저 찾은 것은 [표시]로 바뀌어 다음 검사에 다시 걸리지 않음)
 *   주민등록번호·외국인등록번호  → 항상 차단 (보내지 않음)
 *   카드번호(Luhn 검사)          → 항상 차단
 *   운전면허번호, 휴대전화·일반전화, 이메일, 계좌번호, 여권번호, 차트번호·환자번호, "OOO 환자/님" 이름 → 가리고 보냄
 *
 * 관리자가 "모두 차단" 모드로 바꾸면 하나라도 감지될 때 보내지 않습니다.
 * 병원 대표번호·대표 이메일(병원 정보에 등록한 값)과 1588 같은 대표번호는 개인정보가 아니므로 통과시킵니다.
 *
 * 한계: 규칙(패턴) 기반이라 모든 개인정보를 100% 잡지는 못합니다. 그래서 화면에도 "입력 금지" 안내를 함께 둡니다.
 */

const LABELS = {
  rrn: '주민등록번호',
  card: '카드번호',
  license: '운전면허번호',
  phone: '전화번호',
  email: '이메일',
  account: '계좌번호',
  passport: '여권번호',
  chart: '차트번호',
  name: '이름',
};

// 항상 차단하는 종류
const ALWAYS_BLOCK = new Set(['rrn', 'card']);

// 흔한 성씨 (이름 추정에 사용)
const SURNAMES =
  '김이박최정강조윤장임한오서신권황안송류유전홍고문양손배백허남심노하곽성차주우구민진나지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예경봉사부';
// "OOO님" 형태지만 사람 이름이 아닌 말들
const NOT_NAMES = new Set(
  (
    '고객 원장 실장 선생 환자 보호자 회원 방문자 대표 팀장 과장 부장 차장 위생사 조무사 직원 여러분 이용자 어머님 아버님 할머님 할아버님 ' +
    '부모 신규 초진 재진 구환 신환 내원 예약 대기 담당 치료 소아 노인 고령 임산부 당일 오늘 어린이 보험 외래 응급 수술 교정 임플란트 ' +
    '작성자 사장 이사 주임 대리 사원 기사 소장 국장 교수 박사 의사 간호사 손님 귀하 각위 형님 언니 오빠 누나 동생 친구 아드님 따님 사모 ' +
    '모든 전체 해당 일반 기존 다른 많은 여러 각각 김치 이번 지난 다음 매번 고생 수고 감사 부탁 문의 안내 원님 선배 후배 의원 병원 치과 ' +
    '어머 아버 할머 할아버 아드 사모 회장 최근 정기 일부 대부분 다수 소수 보통 주로 우리 저희 모두 이런 그런 저런 어떤 무슨 장기 단골 ' +
    '방문 전화 상담 진료 정상 주말 평일 하루 매일 오전 오후 지점 본점 거래처 업체 기공소 기사님 배송 택배 공급 주문 구매 도매 소매'
  ).split(/\s+/)
);

function digitsOnly(s) {
  return String(s).replace(/\D/g, '');
}

/** 카드번호 검증용 Luhn 계산 (카드번호 마지막 숫자 검사 규칙) */
function luhnOk(num) {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** 주민번호 앞 6자리가 날짜처럼 생겼는지 (YYMMDD) */
function plausibleBirth(six) {
  const mm = Number(six.slice(2, 4));
  const dd = Number(six.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

// 각 검사기: { type, re, accept(match, groups) → 바꿀 부분 정보 | false }
const DETECTORS = [
  {
    type: 'rrn',
    // 900101-1234567, 9001011234567, 900101-1****** (뒷자리 일부를 가린 것도 감지)
    re: /(?<!\d)(\d{6})\s?[-–]?\s?([1-8][\d*]{6})(?!\d)/g,
    accept: (m) => plausibleBirth(m[1]),
  },
  {
    type: 'card',
    // 숫자 13~19자리 (중간에 공백/하이픈 허용)
    re: /(?<!\d)(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{1,7})(?!\d)/g,
    accept: (m) => {
      const d = digitsOnly(m[1]);
      if (d.length < 13 || d.length > 19) return false;
      if (/^01[016789]/.test(d) && d.length <= 11) return false; // 휴대전화는 제외
      const grouped4 = /^\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}$/.test(m[1]);
      return luhnOk(d) || grouped4;
    },
  },
  {
    type: 'license',
    // 운전면허: 11-12-345678-90
    re: /(?<!\d)\d{2}-\d{2}-\d{6}-\d{2}(?!\d)/g,
    accept: () => true,
  },
  {
    type: 'phone',
    // 휴대전화 010-1234-5678 / 01012345678 / +82 10-1234-5678 / 일반전화 02-123-4567, 031)123-4567, 070-1234-5678
    re: /(?<![\d])((?:\+82[-\s]?|0)(?:1[016789]|2|[3-6][1-5]|70|50\d)[-\s.)]?\d{3,4}[-\s.]?\d{4})(?!\d)/g,
    accept: () => true,
  },
  {
    type: 'email',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    accept: () => true,
  },
  {
    type: 'account',
    // 계좌번호: 숫자 묶음 3~4개를 하이픈으로 이은 형태 (숫자 합계 10~16자리). 날짜(2026-10-16)는 자릿수가 부족해 제외됨
    re: /(?<![\d-])(\d{2,6}-\d{2,6}-\d{2,7}(?:-\d{1,3})?)(?![\d-])/g,
    accept: (m) => {
      const n = digitsOnly(m[1]).length;
      return n >= 10 && n <= 16;
    },
  },
  {
    type: 'account',
    // "계좌" 근처의 하이픈 없는 10~16자리 숫자
    re: /(계좌|입금|송금|통장)[^\d\n]{0,12}(\d{10,16})(?!\d)/g,
    group: 2,
    accept: () => true,
  },
  {
    type: 'passport',
    // 여권번호: M12345678 같은 형태 (영문 1~2자 + 숫자 7~8자리)
    re: /(?<![A-Za-z0-9])([MSRODG][A-Z]?\d{7,8})(?![A-Za-z0-9])/g,
    accept: () => true,
  },
  {
    type: 'chart',
    // 차트번호: 12345 / 환자번호 A-0012 / 챠트 No. 3321
    re: /((?:차트|챠트|환자|등록|진료)\s*(?:번호|No\.?|#|넘버))\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9-]{1,})/g,
    group: 2,
    accept: () => true,
  },
  {
    type: 'name',
    // "환자명: 홍길동", "성함: 김민수", "이름 : 이서연"
    // 단, "병원 이름:", "업체 이름:", "파일 이름:"처럼 사람이 아닌 것의 이름은 제외
    re: /((?:환자\s*(?:명|이름|성함)|(?<!(?:병원|치과|의원|업체|거래처|품목|상품|제품|파일|문서|회사|장비|모델|기관|학교|교육|과정|양식|서식)\s?)(?:성함|성명|이름)|보호자)\s*[:：]\s*)([가-힣]{2,4})/g,
    group: 2,
    accept: () => true,
  },
  {
    type: 'name',
    // "홍길동 환자에게", "김민수님", "이서연 씨" — 흔한 성씨로 시작하는 2~4글자 + 환자/님/씨 (뒤에 조사가 붙어도 감지)
    re: new RegExp(`(?<![가-힣])([${SURNAMES}][가-힣]{1,3})\\s?(?:환자분|환자님|환자|님|씨)`, 'g'),
    group: 1,
    accept: (m) => !NOT_NAMES.has(m[1]) && !NOT_NAMES.has(m[1].slice(0, 2)),
  },
];

/**
 * 글 하나를 검사합니다.
 * @param {string} text
 * @param {{allow?: string[], mode?: 'mask'|'block'}} opts allow: 통과시킬 값(병원 대표번호 등)
 * @returns {{ text: string, findings: {type:string,label:string,count:number}[], blocked: boolean, blockedTypes: string[] }}
 */
function scanText(text, opts = {}) {
  const allowDigits = new Set((opts.allow || []).map((a) => digitsOnly(a)).filter((d) => d.length >= 7));
  const allowRaw = new Set((opts.allow || []).map((a) => String(a).trim().toLowerCase()).filter(Boolean));
  let out = String(text ?? '');
  const counts = {};

  for (const det of DETECTORS) {
    det.re.lastIndex = 0;
    out = out.replace(det.re, (...args) => {
      const m = args.slice(0, -2); // [전체, 그룹1, 그룹2 ...]
      if (typeof args[args.length - 1] === 'object') m.pop(); // 이름 그룹 객체가 붙는 경우 제거
      if (!det.accept(m)) return m[0];
      const target = det.group ? m[det.group] : m[0];
      // 병원 대표번호/이메일 등 허용 목록
      if (allowRaw.has(String(target).trim().toLowerCase())) return m[0];
      if (det.type === 'phone' && allowDigits.has(digitsOnly(target))) return m[0];
      counts[det.type] = (counts[det.type] || 0) + 1;
      const tag = `[${LABELS[det.type]}]`;
      if (det.group) {
        const idx = m[0].lastIndexOf(target);
        return m[0].slice(0, idx) + tag + m[0].slice(idx + target.length);
      }
      return tag;
    });
  }

  const findings = Object.entries(counts).map(([type, count]) => ({ type, label: LABELS[type], count }));
  const blockedTypes = findings.filter((f) => ALWAYS_BLOCK.has(f.type) || opts.mode === 'block').map((f) => f.type);
  return { text: out, findings, blocked: blockedTypes.length > 0, blockedTypes };
}

/** 여러 글을 한꺼번에 검사하고 결과를 합칩니다 */
function scanMany(texts, opts) {
  const total = {};
  const results = texts.map((t) => {
    const r = scanText(t, opts);
    for (const f of r.findings) total[f.type] = (total[f.type] || 0) + f.count;
    return r.text;
  });
  const findings = Object.entries(total).map(([type, count]) => ({ type, label: LABELS[type], count }));
  const blockedTypes = findings.filter((f) => ALWAYS_BLOCK.has(f.type) || opts?.mode === 'block').map((f) => f.type);
  return { texts: results, findings, blocked: blockedTypes.length > 0, blockedTypes };
}

/** 사용자에게 보여 줄 한 문장 설명 */
function describe(findings, blocked) {
  if (!findings.length) return '';
  const parts = findings.map((f) => `${f.label} ${f.count}건`).join(', ');
  return blocked
    ? `개인정보로 보이는 내용(${parts})이 있어 AI로 보내지 않았습니다. 해당 내용을 지우고 다시 시도해 주세요.`
    : `개인정보로 보이는 내용(${parts})을 [표시]로 가리고 보냈습니다.`;
}

module.exports = { scanText, scanMany, describe, LABELS, luhnOk };
