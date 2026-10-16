/*
 * 이 파일이 하는 일: 소통 도우미에서 쓰는 "순수 계산" 도구 모음입니다. (DB·AI 없이 글자만 보고 판단)
 *
 *   checkReply(text)   리뷰 답글 초안에서 의료광고·개인정보 측면의 "주의 표현"을 찾아 알려 줍니다.
 *                      (규칙 기반이라 완벽하지 않습니다. 최종 판단은 사람이 합니다.)
 *   smsBytes(text)     문자 바이트 수 (EUC-KR 기준: 한글 2바이트, 영문·숫자·기호 1바이트)
 *   smsKind(bytes)     90바이트 이하 단문(SMS) / 2000바이트 이하 장문(LMS) / 초과
 *   fillVars(text, v)  {이름} {날짜} 같은 변수를 값으로 채우기
 *   listVars(text)     글 안의 {변수} 목록
 */

/**
 * 주의 표현 규칙
 *   level: danger(쓰면 안 됨) / warn(가능하면 피함)
 *   kind : 화면에 보일 분류
 */
const RULES = [
  // 1) 과장·최상급 표현 (의료법 제56조: 과장 광고 금지)
  { re: /최고(?:의|로|급)?/g, level: 'danger', kind: '과장 표현', reason: '"최고"는 객관적으로 증명할 수 없는 과장 표현입니다.', suggest: '"정성을 다하는" 처럼 태도를 말하는 표현' },
  { re: /최초/g, level: 'danger', kind: '과장 표현', reason: '"최초"는 근거를 대기 어려운 과장 표현입니다.', suggest: '삭제' },
  { re: /유일(?:한|하게)?/g, level: 'danger', kind: '과장 표현', reason: '"유일"은 다른 병원과 비교하는 과장 표현입니다.', suggest: '삭제' },
  { re: /100\s?%|백\s?퍼센트|백프로/g, level: 'danger', kind: '과장 표현', reason: '"100%"는 결과를 보장하는 표현으로 쓸 수 없습니다.', suggest: '삭제' },
  { re: /(?:국내|업계|지역|동네)\s?(?:최대|최다|최상|1위|1등|일등)|1등|넘버\s?원|No\.?\s?1/gi, level: 'danger', kind: '과장 표현', reason: '순위·최상급 표현은 과장 광고로 볼 수 있습니다.', suggest: '삭제' },
  { re: /완벽(?:한|하게|히)?/g, level: 'warn', kind: '과장 표현', reason: '"완벽"은 결과를 단정하는 느낌을 줍니다.', suggest: '"꼼꼼히"' },
  { re: /가장\s?(?:잘|좋은|뛰어난|실력)/g, level: 'warn', kind: '과장 표현', reason: '최상급 비교 표현입니다.', suggest: '삭제' },
  { re: /명의|베테랑\s?원장|실력\s?(?:최고|보장)/g, level: 'warn', kind: '과장 표현', reason: '실력을 과장하는 표현으로 보일 수 있습니다.', suggest: '삭제' },

  // 2) 치료 효과 보장·단정
  { re: /완치/g, level: 'danger', kind: '효과 보장', reason: '"완치"는 치료 효과를 보장하는 표현입니다.', suggest: '삭제' },
  { re: /무통(?:\s?치료)?|통증(?:이|은)?\s?(?:전혀\s?)?없(?:는|이|습니다|어요)|하나도\s?안\s?아프|안\s?아프게/g, level: 'danger', kind: '효과 보장', reason: '통증이 없다고 단정하면 효과 보장 표현이 됩니다.', suggest: '"불편하지 않도록 신경 쓰겠습니다"' },
  { re: /부작용(?:이|은)?\s?(?:전혀\s?)?없/g, level: 'danger', kind: '효과 보장', reason: '부작용이 없다고 단정할 수 없습니다.', suggest: '삭제' },
  { re: /보장(?:합니다|해\s?드|드립니다|된)?|책임지고|확실(?:하게|히)\s?(?:좋아|나아|낫|해결)/g, level: 'danger', kind: '효과 보장', reason: '결과를 약속하는 표현은 쓸 수 없습니다.', suggest: '"최선을 다하겠습니다"' },
  { re: /영구(?:적|히)?|평생\s?(?:유지|보장|사용)|반영구/g, level: 'warn', kind: '효과 보장', reason: '효과 지속을 단정하는 표현입니다.', suggest: '삭제' },
  { re: /(?:반드시|틀림없이|무조건)\s?(?:좋아|나아|낫|효과|만족)/g, level: 'danger', kind: '효과 보장', reason: '결과를 단정하는 표현입니다.', suggest: '삭제' },
  { re: /기적|특효|부작용\s?제로/g, level: 'danger', kind: '효과 보장', reason: '근거 없는 효과 표현입니다.', suggest: '삭제' },

  // 3) 다른 병원과 비교
  { re: /(?:다른|타|옆|근처|주변|여느|일반)\s?(?:병원|치과|의원)/g, level: 'danger', kind: '비교', reason: '다른 의료기관과 비교하는 표현은 금지입니다.', suggest: '비교 문장 삭제' },
  { re: /(?:어디|누구)보다|(?:보다|대비)\s?(?:저렴|싸|좋|낫|잘)/g, level: 'warn', kind: '비교', reason: '비교하는 표현으로 보일 수 있습니다.', suggest: '삭제' },

  // 4) 가격·할인으로 끌어들이기 (환자 유인)
  { re: /할인|이벤트|무료(?:\s?(?:진료|검진|상담|스케일링))?|공짜|최저가|저렴(?:한|하게)?|특가|파격/g, level: 'warn', kind: '환자 유인', reason: '할인·무료 표현은 환자 유인으로 문제가 될 수 있습니다.', suggest: '가격 이야기는 빼고 "궁금한 점은 전화로 문의"' },
  { re: /(?:리뷰|후기)\s?(?:이벤트|작성\s?시|남겨\s?주시면|써\s?주시면)|지인\s?소개|소개해\s?주시면|추천해\s?주시면/g, level: 'danger', kind: '환자 유인', reason: '후기·소개를 대가로 혜택을 주는 표현은 금지입니다.', suggest: '삭제' },

  // 5) 진료 내용·환자임을 확인하는 표현 (개인정보 보호)
  {
    re: /임플란트|교정|신경\s?치료|근관|발치|사랑니|충치|스케일링|미백|라미네이트|보철|크라운|레진|인레이|잇몸\s?(?:치료|수술)|틀니|브릿지|뼈\s?이식|마취|처방|엑스레이|X-?ray|수술/gi,
    level: 'danger',
    kind: '진료 정보 언급',
    reason: '리뷰 작성자가 받은 진료를 공개 답글에서 언급하면 개인정보(진료 정보) 노출이 됩니다.',
    suggest: '진료 이름을 빼고 "소중한 의견"처럼 일반적으로',
  },
  {
    re: /(?:치료|시술|진료|수술|검진|상담)(?:을|를)?\s?받으(?:신|셨)|(?:치료|시술|진료)\s?(?:결과|경과|과정)|내원(?:하신|하셨|해\s?주)|저희\s?(?:환자|고객)(?:님|분)?(?:이|으로|께서)?|환자(?:분|님)/g,
    level: 'danger',
    kind: '진료 정보 언급',
    reason: '작성자가 실제 환자였음을 확인해 주는 표현입니다. 공개 답글에서는 환자 여부를 밝히지 않습니다.',
    suggest: '"남겨 주신 의견" 처럼 환자 여부와 상관없는 표현',
  },
  { re: /차트|진료\s?기록|기록을\s?확인|확인해\s?보니|담당\s?(?:원장|선생|위생사)/g, level: 'danger', kind: '진료 정보 언급', reason: '진료 기록을 확인했다는 말은 작성자가 환자임을 드러냅니다.', suggest: '삭제' },
  { re: /방문(?:해\s?주셔서|해주셔서|하셨|하신)/g, level: 'warn', kind: '진료 정보 언급', reason: '방문 사실을 확인해 주는 표현입니다. "관심 가져 주셔서" 등으로 바꾸는 것이 안전합니다.', suggest: '"소중한 의견 남겨 주셔서"' },

  // 6) 개인정보처럼 보이는 것
  { re: /\[이름\]|\[전화번호\]|\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/g, level: 'danger', kind: '개인정보', reason: '이름·연락처 같은 개인정보는 공개 답글에 쓰지 않습니다.', suggest: '삭제' },
  { re: /[가-힣]{2,4}\s?(?:님|씨|고객님)(?=[,\s!.]|께|의|이|은|을|$)/g, level: 'warn', kind: '개인정보', reason: '작성자 이름(닉네임)을 부르는 것처럼 보입니다. 실명이면 빼 주세요.', suggest: '"작성자님" 또는 생략', soft: true },
];

// 이름처럼 보여도 괜찮은 말 (규칙 6의 오탐 줄이기)
const SAFE_NAME_WORDS = /^(?:작성자|고객|원장|실장|선생|위생사|직원|여러|모든|소중한|많은|회원|손님|이용자|보호자|어머|아버|부모|리뷰어|방문자)/;

/**
 * 리뷰 답글 초안 검사
 * @param {string} text
 * @returns {{ ok: boolean, warnings: {phrase,index,length,level,kind,reason,suggest}[], counts: {danger:number, warn:number} }}
 */
function checkReply(text) {
  const s = String(text || '');
  const found = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(s))) {
      if (!m[0]) {
        rule.re.lastIndex++;
        continue;
      }
      if (rule.soft && SAFE_NAME_WORDS.test(m[0])) continue;
      found.push({ phrase: m[0].trim(), index: m.index, length: m[0].length, level: rule.level, kind: rule.kind, reason: rule.reason, suggest: rule.suggest });
    }
  }
  // 겹치는 것은 더 위험한(먼저 찾은 규칙) 것 하나만 남김
  found.sort((a, b) => a.index - b.index || (a.level === 'danger' ? -1 : 1));
  const warnings = [];
  for (const f of found) {
    const last = warnings[warnings.length - 1];
    if (last && f.index < last.index + last.length) {
      if (f.level === 'danger' && last.level !== 'danger') warnings[warnings.length - 1] = f;
      continue;
    }
    warnings.push(f);
  }
  const counts = { danger: warnings.filter((w) => w.level === 'danger').length, warn: warnings.filter((w) => w.level === 'warn').length };
  return { ok: warnings.length === 0, warnings, counts };
}

/** 문자 바이트 수 (EUC-KR 방식: 한글 등 2바이트, 영문·숫자·기호 1바이트, 줄바꿈 1바이트) */
function smsBytes(text) {
  let n = 0;
  for (const ch of String(text || '')) n += ch.codePointAt(0) > 127 ? 2 : 1;
  return n;
}

/** 바이트 수 → 문자 종류 */
function smsKind(bytes) {
  if (bytes <= 90) return { kind: 'SMS', label: '단문(SMS)', limit: 90, over: false };
  if (bytes <= 2000) return { kind: 'LMS', label: '장문(LMS)', limit: 2000, over: false };
  return { kind: 'OVER', label: '너무 김', limit: 2000, over: true };
}

/** {이름} 같은 변수를 값으로 채움. 값이 없는 변수는 그대로 둠 */
function fillVars(text, values = {}) {
  return String(text || '').replace(/\{([^{}\n]{1,20})\}/g, (all, k) => (values[k.trim()] !== undefined && values[k.trim()] !== '' ? String(values[k.trim()]) : all));
}

/** 글 안의 {변수} 이름 목록 (중복 없이) */
function listVars(text) {
  return [...new Set([...String(text || '').matchAll(/\{([^{}\n]{1,20})\}/g)].map((m) => m[1].trim()))];
}

module.exports = { checkReply, smsBytes, smsKind, fillVars, listVars, RULES };
