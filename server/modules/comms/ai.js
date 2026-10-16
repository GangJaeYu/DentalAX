/*
 * 이 파일이 하는 일: 소통 도우미의 AI 기능 3가지입니다.
 *   comms.script  — 상황(진료시간·주차·예약 변경 등)을 고르면 병원 정보로 전화 응대 스크립트를 만듭니다.
 *   comms.review  — 온라인 리뷰 글·별점·말투를 넣으면 답글 초안 2~3개를 만듭니다. (의료광고·개인정보 주의)
 *                   리뷰 원문은 AI에 보낼 때만 쓰고 DB에는 저장하지 않습니다.
 *   comms.message — 목적만 적으면 {이름} {날짜} 같은 변수가 들어간 안내 문자를 만듭니다. (90바이트 단문 옵션)
 *
 * 키가 없을 때(데모 모드)는 입력과 병원 정보를 반영한 그럴듯한 예시를 돌려줍니다.
 */
const { v } = require('../../core/validate');
const { badRequest } = require('../../core/errors');
const { extractJson } = require('../../ai/service');
const { checkReply, smsBytes, fillVars } = require('./rules');
const time = require('../../core/time');

const SCRIPT_CATEGORIES = ['진료시간', '주차·오시는 길', '예약 변경·취소', '비용 일반 문의', '보험 일반 안내', '불만 응대', '기타'];
const MESSAGE_CATEGORIES = ['예약 안내', '휴진 안내', '진료 후 일반 안내', '보험·서류 안내', '기타'];
const TONES = ['정중', '따뜻', '간결'];
const VARIABLES = ['이름', '날짜', '시간', '병원명', '전화번호', '주소'];

/** 미리보기·바이트 계산에 쓰는 예시 값 (날짜는 내일 날짜로) — 화면도 /api/comms/meta 로 같은 값을 받아 씀 */
function sampleValues(clinic) {
  const tomorrow = time.addDays(time.today(), 1);
  const [, m, d] = tomorrow.split('-').map(Number);
  const wd = '일월화수목금토'[time.weekday(tomorrow)];
  return { 이름: '홍길동', 날짜: `${m}월 ${d}일(${wd})`, 시간: '오후 2시 30분', 병원명: clinic?.name || '하늘치과의원', 전화번호: clinic?.phone || '02-555-0123', 주소: clinic?.address || '' };
}

/** AI에게 알려 줄 병원 정보 (비어 있는 칸은 "확인 필요"로) */
function clinicFacts(c) {
  const f = (label, val) => `- ${label}: ${val && String(val).trim() ? val : '(등록 안 됨 — 확인 필요)'}`;
  return [
    f('병원명', c.name),
    f('대표 전화', c.phone),
    f('주소', c.address),
    f('진료시간', c.hours),
    f('주차', c.parking),
    f('오시는 길', c.directions),
    f('보험 관련 일반 안내', c.insuranceNote),
    c.extra ? f('기타 안내', c.extra) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** "제목: ..." 으로 시작하는 결과를 { title, body } 로 나누기 */
function splitTitle(text) {
  const m = String(text || '').match(/^\s*제목\s*[:：]\s*(.+)\s*\n([\s\S]*)$/);
  if (!m) return { title: '', body: String(text || '').trim() };
  return { title: m[1].trim().replace(/^\*+|\*+$/g, '').slice(0, 80), body: m[2].trim() };
}

function guessScriptCategory(s) {
  const t = String(s || '');
  if (/불만|불친절|화가|항의|컴플레인|민원|대기.*길|오래 기다/.test(t)) return '불만 응대';
  if (/주차|오시는|위치|길|찾아/.test(t)) return '주차·오시는 길';
  if (/예약.*(변경|취소|미루|당기)|변경|취소/.test(t)) return '예약 변경·취소';
  if (/보험|실비|건강보험|급여/.test(t)) return '보험 일반 안내';
  if (/비용|가격|얼마|금액|견적/.test(t)) return '비용 일반 문의';
  if (/진료\s?시간|몇 시|영업|휴진|점심|토요일|일요일|공휴일/.test(t)) return '진료시간';
  return SCRIPT_CATEGORIES.includes(t) ? t : '기타';
}

// ---------------- 전화 응대 스크립트 데모 ----------------
function demoScript(input, clinic) {
  const cat = SCRIPT_CATEGORIES.includes(input.situation) ? input.situation : guessScriptCategory(input.situation);
  const name = clinic.name || '저희 치과';
  const phone = clinic.phone || '(대표번호 확인 필요)';
  const hours = clinic.hours || '(진료시간 확인 필요)';
  const greet = `"감사합니다, ${name} 데스크 {담당자}입니다. 무엇을 도와드릴까요?"`;
  const close = `"더 궁금하신 점 있으시면 언제든 ${phone}로 연락 주세요. 감사합니다."`;
  const notes = input.notes ? `\n\n> 참고 메모: ${input.notes}` : '';
  const S = {
    진료시간: {
      title: '진료시간 문의 응대',
      body: [`"저희 진료시간은 ${hours}입니다."`, '"점심시간에는 전화 연결이 어려울 수 있어, 그 전후로 연락 주시면 더 빨리 도와드릴 수 있습니다."', '"방문 전 예약을 해 주시면 대기 없이 진료받으실 수 있습니다."'],
      qa: [['토요일에도 진료하나요?', `진료시간표(${hours}) 기준으로 안내합니다. 공휴일은 별도 공지를 확인해 드립니다.`], ['지금 바로 가도 되나요?', '"오늘 예약 상황을 확인해 보겠습니다. 잠시만 기다려 주세요." → 예약표 확인 후 가능한 시간 안내']],
    },
    '주차·오시는 길': {
      title: '주차·오시는 길 안내',
      body: [`"저희는 ${clinic.address || '(주소 확인 필요)'}에 있습니다."`, `"${clinic.directions || '(오시는 길 확인 필요)'}"`, `"주차는 ${clinic.parking || '(주차 안내 확인 필요)'}"`],
      qa: [['주차비가 있나요?', `"${clinic.parking || '주차 지원 여부는 확인 후 안내드리겠습니다.'}" — 등록 방법은 데스크에서 안내`], ['대중교통으로 가려면요?', `"${clinic.directions || '가까운 역·정류장을 확인 후 안내드리겠습니다.'}"`]],
    },
    '예약 변경·취소': {
      title: '예약 변경·취소 응대',
      body: ['"예약 변경 도와드리겠습니다. 예약하신 분 성함과 기존 예약 날짜를 말씀해 주시겠어요?"', '(예약 프로그램에서 확인 — 이 화면에는 적지 않습니다)', '"원하시는 날짜나 요일, 시간대가 있으실까요? 가능한 시간을 확인해 드리겠습니다."', '"변경된 예약은 ○월 ○일 ○시입니다. 전날 안내 문자를 보내 드리겠습니다."'],
      qa: [['당일 취소해도 되나요?', '"네, 가능합니다. 다만 다른 분이 이용하실 수 있도록 가능하면 미리 연락 부탁드립니다."'], ['다음 예약을 아직 못 정했어요.', '"괜찮습니다. 일정 정해지시면 편하실 때 연락 주세요."']],
    },
    '비용 일반 문의': {
      title: '비용 일반 문의 응대',
      body: ['"비용을 궁금해하시는군요. 치료 비용은 입안 상태와 치료 방법에 따라 달라서, 전화로는 정확한 금액을 말씀드리기 어렵습니다."', '"내원하시면 진료 후 상담 때 치료 방법과 비용을 자세히 안내해 드립니다."', '"상담 예약을 먼저 잡아 드릴까요?"'],
      qa: [['대략이라도 알 수 없나요?', '"정확하지 않은 금액을 말씀드리면 오히려 혼란을 드릴 수 있어서, 진료 후 상담에서 정확히 안내드리고 있습니다."'], ['카드 할부 되나요?', '"결제 방법은 데스크에서 안내해 드립니다." (원내 결제 규정 확인 필요)']],
    },
    '보험 일반 안내': {
      title: '보험 일반 안내',
      body: [`"${clinic.insuranceNote || '보험 적용 여부는 치료 내용에 따라 달라 진료 후 안내드립니다.'}"`, '"개인별 보험 적용 여부와 본인부담금은 진료 후 상담 때 정확히 안내해 드립니다."', '"실손보험 청구용 서류가 필요하시면 접수할 때 미리 말씀해 주세요."'],
      qa: [['스케일링 보험 되나요?', `"${clinic.insuranceNote ? '일반적인 기준은 안내드린 대로이며, 적용 여부는 접수 시 확인해 드립니다.' : '건강보험 적용 기준이 있어 접수 시 확인해 드립니다. (확인 필요)'}"`], ['서류는 언제 받을 수 있나요?', '"진료 당일 수납 후 데스크에서 발급해 드립니다."']],
    },
    '불만 응대': {
      title: '불만·항의 전화 응대',
      body: ['"불편을 드려 정말 죄송합니다. 어떤 점이 불편하셨는지 자세히 말씀해 주시겠어요?"', '(끝까지 듣기 — 말을 끊지 않고, 중간에 "네, 그러셨군요" 맞장구)', '"말씀해 주셔서 감사합니다. 제가 내용을 정리해서 실장님(원장님)께 바로 전달하겠습니다."', '"확인 후 오늘 중으로 다시 연락드려도 괜찮으실까요?"'],
      qa: [['원장 바꿔 주세요.', '"지금 진료 중이셔서 바로 연결은 어렵습니다. 내용을 정확히 전달하고 확인 후 연락드리겠습니다."'], ['환불해 주세요.', '"제가 바로 결정드리기 어려운 부분이라 실장님께 확인 후 연락드리겠습니다." (약속하지 않기)']],
      tip: '- 사과는 "불편을 드린 점"에 대해 하고, 잘잘못을 전화로 단정하지 않습니다.\n- 진료 내용은 전화로 자세히 다루지 말고 내원 상담을 권합니다.',
    },
    기타: {
      title: `${String(input.situation).slice(0, 20)} 응대`,
      body: [`"말씀하신 내용 확인해 보겠습니다. 잠시만 기다려 주세요."`, '"정확한 안내를 위해 확인 후 다시 연락드려도 괜찮으실까요?"'],
      qa: [['언제 연락 주시나요?', '"오늘 진료 시간 안에 다시 연락드리겠습니다."']],
    },
  };
  const s = S[cat] || S.기타;
  return [
    `제목: ${s.title}`,
    '',
    '## 1. 인사',
    greet,
    '',
    '## 2. 안내',
    ...s.body.map((l) => `- ${l}`),
    '',
    '## 3. 마무리',
    close,
    '',
    '## 예상 질문과 답',
    ...s.qa.flatMap(([q, a]) => [`**Q. ${q}**`, `A. ${a}`, '']),
    s.tip ? `## 응대 요령\n${s.tip}` : '',
    notes,
    '',
    '(데모 모드 예시입니다. AI 키를 넣으면 실제 AI가 상황에 맞게 작성합니다.)',
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------- 리뷰 답글 데모 ----------------
function demoReplies(input, clinic) {
  const r = input.review;
  const name = clinic.name || '저희 치과';
  const phone = clinic.phone || '대표번호';
  const pos = input.rating >= 4;
  const neg = input.rating <= 2;
  // 리뷰에 나온 "서비스" 측면만 짚음 (진료 내용은 절대 언급하지 않음)
  const aspects = [];
  if (/친절|상냥|다정/.test(r)) aspects.push(pos ? '친절하게 느끼셨다니' : '응대');
  if (/설명|자세/.test(r)) aspects.push(pos ? '설명이 도움이 되셨다니' : '설명');
  if (/대기|기다|오래|늦/.test(r)) aspects.push(pos ? '대기 시간까지 살펴 주셔서' : '대기 시간');
  if (/깨끗|청결|위생/.test(r)) aspects.push(pos ? '청결한 공간으로 봐 주셔서' : '청결');
  if (/주차/.test(r)) aspects.push(pos ? '주차까지 편하셨다니' : '주차 안내');
  if (/전화|예약/.test(r)) aspects.push(pos ? '예약 안내가 편하셨다니' : '전화·예약 안내');
  const a0 = aspects[0];
  let replies;
  if (pos) {
    replies = [
      { label: '정중한 감사', text: `소중한 후기 남겨 주셔서 진심으로 감사드립니다.${a0 ? ` ${a0} 저희 모두 큰 힘이 됩니다.` : ' 따뜻한 말씀에 저희 모두 큰 힘을 얻습니다.'} 앞으로도 편안한 공간이 될 수 있도록 늘 정성을 다하겠습니다. 감사합니다.` },
      { label: '따뜻한 인사', text: `따뜻한 말씀 정말 감사합니다 :)${a0 ? ` ${a0} 저희도 기쁩니다.` : ''} 남겨 주신 글은 직원들과 함께 읽으며 다시 한번 마음을 다잡았습니다. 늘 건강하시고 좋은 일만 가득하시길 바랍니다.` },
      { label: '짧고 간결', text: `좋은 말씀 감사합니다. 앞으로도 한결같은 모습으로 노력하겠습니다. - ${name} 드림` },
    ];
  } else if (neg) {
    const issue = aspects.length ? aspects.slice(0, 2).join('과 ') : '말씀하신 부분';
    replies = [
      { label: '정중한 사과', text: `소중한 의견 남겨 주셔서 감사합니다. ${issue}에 불편을 느끼셨다니 진심으로 죄송합니다. 말씀해 주신 내용은 직원들과 함께 공유하고 개선하겠습니다. 자세한 말씀을 직접 듣고 싶으니 괜찮으시다면 ${phone}로 연락 주시면 성심껏 듣겠습니다.` },
      { label: '공감과 개선 약속', text: `먼저 불편한 마음이 드셨던 점 사과드립니다. 남겨 주신 글을 읽고 저희가 놓친 부분을 다시 돌아보게 되었습니다. ${issue}에 대해서는 바로 내부 점검을 하겠습니다. 더 나은 모습으로 보답할 수 있도록 노력하겠습니다.` },
      { label: '짧고 간결', text: `불편을 드려 죄송합니다. 말씀하신 부분은 꼭 개선하겠습니다. 편하실 때 ${phone}로 연락 주시면 직접 듣겠습니다.` },
    ];
  } else {
    replies = [
      { label: '정중한 감사', text: `귀한 시간 내어 의견 남겨 주셔서 감사합니다.${aspects.length ? ` 말씀해 주신 ${aspects.join(', ')} 부분은 더 신경 쓰겠습니다.` : ' 아쉬우셨던 부분은 더 신경 쓰겠습니다.'} 다음에는 더 만족스러운 경험이 되도록 노력하겠습니다.` },
      { label: '따뜻한 인사', text: `솔직한 의견 감사합니다. 좋았던 점은 지키고, 아쉬웠던 점은 꼭 고쳐 나가겠습니다. 늘 건강하시길 바랍니다.` },
      { label: '짧고 간결', text: `의견 감사합니다. 더 나아지도록 노력하겠습니다.` },
    ];
  }
  // 말투 선택에 맞춰 순서를 바꿔 고른 말투가 먼저 보이게
  const order = { 정중: [0, 1, 2], 따뜻: [1, 0, 2], 간결: [2, 0, 1] }[input.tone] || [0, 1, 2];
  return order.map((i) => replies[i]);
}

/** 답글 결과 해석: JSON이면 그대로, 아니면 "1안/---" 등으로 나눔. 각 답글에 주의 표현 검사 결과를 붙임 */
function parseReplies(text) {
  let replies = [];
  try {
    const j = extractJson(text);
    const arr = Array.isArray(j) ? j : j && (j.replies || j.drafts || j.items);
    if (Array.isArray(arr)) {
      replies = arr
        .map((x, i) => (typeof x === 'string' ? { label: `${i + 1}안`, text: x } : { label: String(x.label || x.title || x.tone || `${i + 1}안`), text: String(x.text || x.reply || x.body || '') }))
        .filter((x) => x.text.trim());
    }
  } catch {
    replies = [];
  }
  if (!replies.length) {
    replies = String(text || '')
      .split(/\n\s*(?:---+|#{1,3}\s*\d\s*안?.*|\*\*\s*\d\s*안.*\*\*|\d\s*안\s*[:：)].*)\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 5)
      .slice(0, 3)
      .map((t, i) => ({ label: `${i + 1}안`, text: t }));
  }
  return {
    replies: replies.slice(0, 3).map((r) => ({ label: r.label.slice(0, 30), text: r.text.trim(), check: checkReply(r.text) })),
  };
}

// ---------------- 안내 문자 데모 ----------------
function demoMessage(input, clinic) {
  const purpose = String(input.purpose || input.text || '');
  const kind = /휴진|휴무|쉽니다|쉬는/.test(purpose)
    ? 'off'
    : /예약|내원|방문 일정/.test(purpose)
      ? 'appt'
      : /스케일링|보험|서류|영수증|실비|실손/.test(purpose)
        ? 'ins'
        : /주차|오시는|위치/.test(purpose)
          ? 'park'
          : /주의|진료 후|치료 후|관리/.test(purpose)
            ? 'after'
            : 'etc';
  const sample = sampleValues(clinic);
  const fits = (s) => smsBytes(fillVars(s, sample)) <= 90;
  if (input.short) {
    const SHORT = {
      off: '[{병원명}] {날짜} 휴진입니다. 다음 진료일부터 정상 진료합니다.',
      appt: '[{병원명}] {이름}님 {날짜} {시간} 예약입니다. 변경: {전화번호}',
      ins: '[{병원명}] 보험·서류 관련 안내는 내원 시 데스크에서 도와드립니다.',
      park: '[{병원명}] 건물 주차장 이용 가능합니다. 데스크에서 주차 등록해 주세요.',
      after: '[{병원명}] 오늘 진료 후 불편하시면 {전화번호}로 연락 주세요.',
      etc: '[{병원명}] 안내드립니다. 자세한 내용은 {전화번호}로 문의 주세요.',
    };
    let body = SHORT[kind];
    // 기존 문구를 줄이는 경우: 핵심 문장 하나를 살려 90바이트 안에 맞춤
    if (input.text && kind === 'etc') {
      const core = String(input.text)
        .replace(/\[[^\]]*\]/g, '')
        .split(/(?<=[.!?。])\s+|\n+/)
        .map((s) => s.trim())
        .filter((s) => s && !/안녕하세요|감사합니다/.test(s))[0];
      if (core) {
        let c = core;
        while (c.length > 4 && !fits(`[{병원명}] ${c}`)) c = c.slice(0, -1);
        if (c.length > 4) body = `[{병원명}] ${c.replace(/[,\s]+$/, '')}${/[.!?]$/.test(c) ? '' : '.'}`;
      }
    }
    while (!fits(body) && body.length > 10) body = body.slice(0, -1);
    return `제목: ${{ off: '휴진 안내(단문)', appt: '예약 안내(단문)', ins: '보험·서류 안내(단문)', park: '주차 안내(단문)', after: '진료 후 안내(단문)', etc: '안내(단문)' }[kind]}\n\n${body}`;
  }
  const LONG = {
    off: ['휴진 안내', `[{병원명}] 휴진 안내\n\n안녕하세요, {병원명}입니다.\n{날짜}은(는) 병원 사정으로 휴진합니다.\n다음 진료일부터 정상 진료하며, 예약 변경이 필요하신 분은 {전화번호}로 연락 부탁드립니다.\n\n이용에 불편을 드려 죄송합니다.`],
    appt: ['예약 안내', `[{병원명}] 예약 안내\n\n{이름}님, 안녕하세요.\n{날짜} {시간}에 예약되어 있습니다.\n변경이나 취소가 필요하시면 {전화번호}로 미리 연락 부탁드립니다.\n\n주차: 건물 지하 주차장 이용 가능\n감사합니다.`],
    ins: ['보험·서류 일반 안내', `[{병원명}] 안내\n\n안녕하세요, {병원명}입니다.\n진료비 영수증·세부내역서 등 보험 청구용 서류는 진료 당일 데스크에서 발급해 드립니다.\n개인별 보험 적용 여부는 진료 후 상담 때 안내드립니다.\n\n문의: {전화번호}`],
    park: ['주차 안내', `[{병원명}] 주차 안내\n\n${clinic.parking || '건물 주차장을 이용하실 수 있습니다.'}\n오시는 길: ${clinic.directions || '{주소}'}\n\n문의: {전화번호}`],
    after: ['진료 후 일반 안내', `[{병원명}] 진료 후 안내\n\n{이름}님, 오늘 내원해 주셔서 감사합니다.\n진료 후 불편하신 점이 있거나 궁금하신 점은 언제든 {전화번호}로 연락 주세요.\n\n편안한 하루 보내세요.`],
    etc: ['안내 문자', `[{병원명}] 안내\n\n안녕하세요, {병원명}입니다.\n${purpose.slice(0, 120)}\n\n자세한 내용은 {전화번호}로 문의 부탁드립니다.\n감사합니다.`],
  };
  const [title, body] = LONG[kind];
  // 본문은 그대로 템플릿에 들어가므로 "데모 예시" 같은 꼬리말은 붙이지 않음 (화면에 데모 배지가 따로 보임)
  return `제목: ${title}\n\n${body}`;
}

const aiFeatures = [
  {
    key: 'comms.script',
    label: '전화 응대 스크립트',
    group: '데스크',
    tier: 'fast',
    maxTokens: 1400,
    input: v.object({
      situation: v.string({ min: 2, max: 100, label: '상황' }),
      notes: v.string({ max: 1000, optional: true, default: '', label: '추가 메모' }),
    }),
    build(input, ctx) {
      return {
        prompt: [
          '치과 데스크 직원이 전화 받을 때 그대로 읽을 수 있는 응대 스크립트를 써 주세요.',
          `상황: ${input.situation}`,
          input.notes ? `추가 메모: ${input.notes}` : '',
          '',
          '[병원 정보 — 이 정보만 사실로 쓰고, 없는 정보는 "확인 필요"로 표시]',
          clinicFacts(ctx.clinic),
          '',
          '형식:',
          '첫 줄: "제목: (20자 이내)"',
          '## 1. 인사 / ## 2. 안내 / ## 3. 마무리 / ## 예상 질문과 답 (Q/A 2~4개)',
          '- 실제 말할 문장은 큰따옴표로, 행동 지시는 괄호로.',
          '- 개별 진료비 금액은 말하지 않고 "진료 후 상담 때 정확히 안내"로 안내합니다.',
          '- 보험은 일반적인 기준만 말하고, 개인별 적용 여부는 진료 후 안내한다고 합니다.',
          '- 환자 이름·연락처·진료 내용을 적는 칸이나 질문은 만들지 않습니다.',
          '- 효과 보장·과장·다른 병원 비교 표현 금지.',
        ]
          .filter((l) => l !== '')
          .join('\n'),
      };
    },
    demo(input, ctx) {
      return demoScript(input, ctx.clinic || {});
    },
    parse(text) {
      const r = splitTitle(text);
      return { ...r, category: guessScriptCategory(r.title + ' ' + r.body.slice(0, 80)) };
    },
  },
  {
    key: 'comms.review',
    label: '온라인 리뷰 답글 초안',
    group: '데스크',
    tier: 'fast',
    maxTokens: 1200,
    input: v.object({
      review: v.string({ min: 2, max: 2000, label: '리뷰 내용' }),
      rating: v.int({ min: 1, max: 5, label: '별점' }),
      tone: v.enum(TONES, { optional: true, default: '정중', label: '말투' }),
    }),
    build(input, ctx) {
      return {
        system: [
          ctx.baseSystem,
          '',
          '리뷰 답글 추가 원칙 (반드시 지킴):',
          '- 공개된 글이므로 작성자가 우리 병원 환자였는지 확인하거나 암시하지 않습니다. ("내원해 주셔서", "치료받으신" 금지)',
          '- 리뷰에 진료 이름(임플란트, 교정, 신경치료, 스케일링 등)이 있어도 답글에는 절대 쓰지 않습니다.',
          '- 치료 결과·통증 없음·효과를 약속하지 않습니다. "최고/최초/유일/100%/완치/무통" 금지.',
          '- 다른 병원과 비교하지 않고, 할인·이벤트·후기 보상을 언급하지 않습니다.',
          '- 불만 리뷰는 변명하지 않고 공감·사과 후 대표번호로 직접 연락을 권합니다.',
        ].join('\n'),
        prompt: [
          `아래 온라인 리뷰에 달 답글 초안 3개를 "${input.tone}" 말투 위주로 써 주세요. (별점 ${input.rating}점 / 5점)`,
          `대표번호: ${ctx.clinic?.phone || '(대표번호)'}`,
          '각 답글은 2~4문장, 서로 느낌이 다르게.',
          '아래 형식의 JSON 코드 블록 하나만 답합니다.',
          '```json',
          '{"replies": [{"label": "정중한 감사", "text": "답글"}]}',
          '```',
          '',
          '[리뷰]',
          input.review,
        ].join('\n'),
      };
    },
    demo(input, ctx) {
      return '```json\n' + JSON.stringify({ replies: demoReplies(input, ctx.clinic || {}) }, null, 2) + '\n```';
    },
    parse: parseReplies,
  },
  {
    key: 'comms.message',
    label: '안내 문자 문구',
    group: '데스크',
    tier: 'fast',
    maxTokens: 800,
    input: v.object({
      purpose: v.string({ max: 500, optional: true, default: '', label: '목적' }),
      text: v.string({ max: 2000, optional: true, default: '', label: '기존 문구' }),
      short: v.bool(),
    }),
    build(input, ctx) {
      if (!input.purpose && !input.text) throw badRequest('목적: 어떤 안내 문자인지 적어 주세요.', { field: 'purpose' });
      return {
        prompt: [
          input.text ? '아래 기존 안내 문자를 다듬어 주세요.' : '치과에서 보낼 안내 문자(또는 안내문) 문구를 써 주세요.',
          input.purpose ? `목적: ${input.purpose}` : '',
          `병원명: ${ctx.clinic?.name || '(병원명)'}`,
          '',
          `- 바뀌는 값은 변수로 둡니다: ${VARIABLES.map((x) => `{${x}}`).join(' ')} (환자 실명·연락처를 직접 쓰지 않음)`,
          '- 맨 앞에 [{병원명}] 을 붙입니다.',
          input.short
            ? '- 반드시 90바이트(한글 약 40자) 이하의 단문 한두 문장으로. 인사말·이모지 생략.'
            : '- 2000바이트 이하. 인사 → 핵심 안내 → 문의처 순서로 짧은 줄 여러 개.',
          '- 개인의 진료 내용은 쓰지 않고 누구에게나 보낼 수 있는 일반 문구로.',
          '- 의료광고 규정 준수(효과 보장·할인 유인 금지).',
          '형식: 첫 줄 "제목: (15자 이내)", 빈 줄 다음에 문자 본문만.',
          input.text ? `\n[기존 문구]\n${input.text}` : '',
        ]
          .filter((l) => l !== '')
          .join('\n'),
      };
    },
    demo(input, ctx) {
      return demoMessage(input, ctx.clinic || {});
    },
    parse(text) {
      const r = splitTitle(text);
      return { ...r, bytes: smsBytes(r.body) };
    },
  },
];

module.exports = { aiFeatures, SCRIPT_CATEGORIES, MESSAGE_CATEGORIES, TONES, VARIABLES, sampleValues, parseReplies, demoMessage };
