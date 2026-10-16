/*
 * 이 파일이 하는 일: [C. 행정·서류] 모듈의 AI 기능 3가지를 정의합니다.
 *
 *   docs.write   : 목적·대상·핵심 메모만 적으면 공문/안내문/내부 규정/업무 매뉴얼 등의 "전체 초안"을 써 줌 (상위 모델)
 *   docs.revise  : 이미 쓴 글 전체를 다시 쓰기 / 더 짧게 / 더 정중하게 / 맞춤법·문장 다듬기 (빠른 모델)
 *   docs.minutes : 회의 중 대충 적은 메모 → 요약, 결정 사항, 할 일(담당자·기한) 정리 (상위 모델, JSON 결과)
 *
 * 각 기능에는 API 키가 없을 때 쓰는 demo()가 있습니다. 입력한 내용을 반영해 그럴듯한 예시를 만들어
 * 키 없이도 "입력 → 초안 → 저장"까지 흐름 전체를 시연할 수 있게 합니다.
 */
const { v } = require('../../core/validate');
const time = require('../../core/time');
const { extractJson } = require('../../ai/service');

const DOC_KINDS = ['공문', '안내문', '내부 규정', '업무 매뉴얼', '교육 자료', '채용 공고', '기타'];
const TONES = ['정중', '친근', '공식'];
const LENGTHS = ['짧게', '보통', '자세히'];
const REVISE_MODES = { rewrite: '다시 쓰기', shorter: '더 짧게', politer: '더 정중하게', proofread: '맞춤법·문장 다듬기' };

// ---------- 공통 도우미 ----------

/** 메모 글을 한 줄씩 나눠 앞의 "-", "•", "1." 같은 기호를 뗀 목록으로 */
function bullets(text) {
  return String(text || '')
    .split(/\n+/)
    .map((s) => s.replace(/^\s*([-*•·]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

/** 'YYYY-MM-DD' → '2026년 10월 16일' */
function longDate(s) {
  const d = time.parseDate(s);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/** 목적 문장에서 문서 제목 만들기 (끝의 '~하려고', '~위해' 같은 말을 정리) */
function titleFrom(purpose, kind) {
  let t = String(purpose || '').split(/\n/)[0].trim();
  t = t.replace(/(을|를)?\s*(알리기|안내하기|알리려고|안내하려고|정리하기|만들기|요청하기)\s*(위해|위한|위하여)?\s*$/, '').replace(/\s*(위해|위하여|위한)\s*$/, '');
  t = t.replace(/[.。!?]+$/, '').trim();
  if (!t) t = kind;
  if (t.length > 40) t = t.slice(0, 40).trim();
  const suffix = { 공문: '', 안내문: ' 안내', '내부 규정': ' 규정', '업무 매뉴얼': ' 업무 매뉴얼', '교육 자료': ' 교육 자료', '채용 공고': ' 채용 공고', 기타: '' }[kind] || '';
  if (suffix && !t.endsWith(suffix.trim()) && !/(안내|규정|수칙|매뉴얼|절차|자료|공고|모집)$/.test(t)) t += suffix;
  return t;
}

/** 받침에 따라 알맞은 조사 붙이기: josa('안내', '과/와') → '안내와', josa('규정', '을/를') → '규정을' */
function josa(word, pair) {
  const w = String(word || '');
  const [withB, withoutB] = pair.split('/');
  const last = w.charCodeAt(w.length - 1);
  if (last >= 0xac00 && last <= 0xd7a3) {
    const jong = (last - 0xac00) % 28;
    if (pair === '으로/로') return w + (jong === 0 || jong === 8 ? '로' : '으로'); // ㄹ 받침은 '로'
    return w + (jong ? withB : withoutB);
  }
  return w + withoutB;
}

/** 목적 문장에서 끝의 마침표와 "안내/공지/요청" 같은 말을 떼어 문장 속에 넣기 좋게 */
function core(purpose) {
  const first = String(purpose || '').split(/\n/)[0].trim().replace(/[.。!]+$/, '');
  return first.replace(/\s*(안내|공지|요청|알림)$/, '') || first;
}

/** 메모 한 줄을 규정 문체("~한다.")로: "휴대폰 사용 금지" → "휴대폰 사용을 금지한다." */
function ruleSentence(p) {
  const s = String(p).trim().replace(/[.。]+$/, '');
  if (/(다|요)$/.test(s)) return s + '.';
  if (/\s*금지$/.test(s)) return josa(s.replace(/\s*금지$/, ''), '을/를') + ' 금지한다.';
  if (/(사용|작성|확인|보고|기록|착용|교체|정리|보관|점검|소독|세척|준수|공유|제출|실시|유지|관리|참석|교육)$/.test(s)) return s + '한다.';
  return josa(s, '을/를') + ' 원칙으로 한다.';
}

/** 어조별 맺음말 */
function closing(tone) {
  if (tone === '친근') return { ask: '부탁드려요', end: '감사합니다 :)', req: '해 주세요' };
  if (tone === '공식') return { ask: '바랍니다', end: '이상.', req: '하여 주시기 바랍니다' };
  return { ask: '부탁드립니다', end: '감사합니다.', req: '해 주시기 바랍니다' };
}

// ---------- docs.write 데모 (종류별 예시 초안) ----------

function demoWrite(input, ctx) {
  const clinic = (ctx && ctx.clinic) || {};
  const name = clinic.name || '하늘치과의원';
  const phone = clinic.phone || '(대표번호 확인 필요)';
  const today = (ctx && ctx.today) || time.today();
  const kind = input.kind;
  const title = input.title || titleFrom(input.purpose, kind);
  let pts = bullets(input.points);
  if (!pts.length) pts = [input.purpose];
  const c = closing(input.tone);
  const short = input.length === '짧게';
  const long = input.length === '자세히';
  if (short) pts = pts.slice(0, 3);
  const who = input.audience || '';
  const L = [`# ${title}`, ''];

  if (kind === '공문') {
    const letters = '가나다라마바사아자차카타파하';
    L.push(
      `**문서번호**: ${name.replace(/의원$/, '')}-${today.slice(0, 4)}-001 (확인 필요)`,
      `**시행일자**: ${longDate(today)}`,
      `**수신**: ${who || '수신처 확인 필요'}`,
      '**참조**: (필요 시 담당자 기재)',
      `**제목**: ${title}`,
      '',
      '---',
      '',
      '**1.** 귀 기관(귀사)의 무궁한 발전을 기원합니다.',
      `**2.** ${josa(core(input.purpose), '과/와')} 관련하여 아래와 같이 알려 드리오니 업무에 참고하여 주시기 ${c.ask === '부탁드려요' ? '바랍니다' : c.ask}.`,
      '',
      '**〈 아 래 〉**',
      ''
    );
    pts.forEach((p, i) => {
      L.push(`${letters[i] || '-'}. ${p}`);
      if (long) L.push(`   - 세부 일정·대상은 내부 확인 후 확정하여 다시 알려 드리겠습니다. (확인 필요)`);
    });
    L.push('', `**3.** 문의 사항은 ${name} 원무과(${phone})로 연락 주시기 바랍니다.`);
    if (!short) L.push('', '**붙임**: 관련 자료 1부. 끝.');
    else L.push('', '끝.');
    L.push('', '', `**${name} 원장**  (직인 생략)`);
    return L.join('\n');
  }

  if (kind === '안내문') {
    const greet = input.tone === '친근' ? `안녕하세요! ${name}입니다.` : `안녕하세요, ${name}입니다.`;
    L.push(greet, '', `${who ? who + '께 ' : ''}${core(input.purpose)}에 대해 안내드립니다.`, '', '## 안내 내용', '');
    pts.forEach((p) => L.push(`- ${p}`));
    if (!short) {
      L.push('', '## 참고해 주세요', '', '- 일정이나 내용이 바뀌면 다시 안내드리겠습니다.', `- 궁금하신 점은 대표전화(${phone})로 문의해 주세요.`);
    }
    if (long) L.push('- 방문 전 전화로 한 번 더 확인하시면 기다리는 시간을 줄일 수 있습니다.', '- 이용에 불편을 드려 죄송하며, 너른 양해 부탁드립니다.');
    L.push('', c.end, '', `${name} 드림`);
    return L.join('\n');
  }

  if (kind === '내부 규정') {
    let n = 1;
    L.push(
      `## 제${n++}조 (목적)`,
      `이 규정은 ${core(input.purpose).replace(/\s*(규정|수칙)$/, '')}에 관한 기준을 정하여, 모든 직원이 같은 방법으로 업무를 수행하도록 하는 것을 목적으로 한다.`,
      '',
      `## 제${n++}조 (적용 범위)`,
      `이 규정은 ${who || `${name}의 모든 직원(원장, 실장, 치과위생사, 간호조무사, 데스크 직원)`}에게 적용한다.`,
      ''
    );
    pts.forEach((p) => {
      const head = p.length > 18 ? p.slice(0, 18).replace(/\s+\S*$/, '') : p;
      L.push(`## 제${n++}조 (${head})`, `① ${ruleSentence(p)}`);
      if (!short) L.push('② 지키기 어려운 사정이 있으면 실장에게 미리 알리고 지시에 따른다.');
      if (long) L.push('③ 수행 결과는 해당 기록지(또는 DentalAX 기록)에 남긴다.');
      L.push('');
    });
    L.push(`## 제${n++}조 (책임과 확인)`, '① 실장은 이 규정이 잘 지켜지는지 매월 1회 이상 확인한다.', '② 규정을 바꿀 때는 직원회의에서 알리고, 바뀐 내용을 문서함에 반영한다.', '', '## 부칙', `이 규정은 ${longDate(today)}부터 시행한다.`);
    return L.join('\n');
  }

  if (kind === '업무 매뉴얼') {
    L.push(
      '## 1. 목적',
      `${josa(core(input.purpose).replace(/\s*(업무 매뉴얼|매뉴얼|절차)$/, ''), '을/를')} 누가 하더라도 같은 순서와 기준으로 처리하기 위한 매뉴얼입니다.`,
      '',
      '## 2. 대상·담당',
      `- 대상: ${who || '해당 업무를 맡는 모든 직원'}`,
      '- 책임자: 실장 (확인 필요)',
      ''
    );
    if (!short) L.push('## 3. 시작 전 확인', '- 필요한 물품·기록지가 준비되어 있는지 확인합니다.', '- 이전 근무자의 인수인계 내용을 확인합니다.', '');
    L.push(`## ${short ? 3 : 4}. 단계별 절차`, '');
    pts.forEach((p, i) => {
      L.push(`${i + 1}. **${p}**`);
      if (long) L.push(`   - 끝나면 다음 단계로 넘어가기 전에 빠진 것이 없는지 한 번 더 확인합니다.`);
    });
    L.push('', `## ${short ? 4 : 5}. 주의 사항`, '- 순서를 건너뛰지 않습니다.', '- 이상이 있으면 바로 실장에게 보고합니다.');
    if (!short) L.push('', '## 6. 기록·보고', '- 처리 결과는 DentalAX 해당 메뉴에 기록합니다.', '- 반복되는 문제는 직원회의 안건으로 올립니다.');
    return L.join('\n');
  }

  if (kind === '교육 자료') {
    L.push('## 교육 개요', `- 주제: ${title}`, `- 대상: ${who || '전 직원'}`, `- 목적: ${core(input.purpose)}`, '', '## 학습 목표', '- 교육이 끝나면 아래 내용을 스스로 설명하고 실천할 수 있습니다.', '', '## 핵심 내용', '');
    pts.forEach((p, i) => {
      L.push(`### ${i + 1}. ${p}`);
      if (!short) L.push(`- 왜 중요한가: 실수하면 업무 흐름과 안전에 영향을 줄 수 있습니다.`, '- 실천 방법: 현장에서 바로 따라 할 수 있도록 담당자가 시범을 보입니다.');
      L.push('');
    });
    if (!short) {
      L.push('## 확인 문제', '');
      pts.slice(0, 3).forEach((p, i) => L.push(`${i + 1}. "${p}"를 지켜야 하는 이유를 한 문장으로 말해 보세요.`));
    }
    if (long) L.push('', '## 참고', '- 법정 교육 기준과 세부 수치는 관련 기관 자료로 한 번 더 확인합니다. (확인 필요)');
    return L.join('\n');
  }

  if (kind === '채용 공고') {
    L.push(`${name}에서 함께 일할 ${who || '동료'}를 모십니다.`, '', '## 모집 분야', `- ${who || '치과위생사 (인원 확인 필요)'}`, '', '## 주요 업무 및 우대 사항', '');
    pts.forEach((p) => L.push(`- ${p}`));
    L.push('', '## 근무 조건', '- 근무 시간·급여·휴무: 면접 시 안내 (확인 필요)', '- 4대 보험 가입');
    if (!short) L.push('', '## 지원 방법', `- 이메일 또는 방문 접수 (문의 ${phone})`, '- 제출 서류: 이력서, 자격증 사본', '', '## 전형 절차', '1. 서류 검토', '2. 면접', '3. 최종 합격 안내');
    L.push('', '> 채용 공고에는 나이·성별·결혼 여부 등 차별로 보일 수 있는 조건을 넣지 않습니다.');
    return L.join('\n');
  }

  // 기타
  L.push(`${who ? who + '께\n\n' : ''}${core(input.purpose)}에 대해 정리했습니다.`, '', '## 주요 내용', '');
  pts.forEach((p) => L.push(`- ${p}`));
  if (!short) L.push('', '## 다음 할 일', '- 내용 확인 후 필요한 부분을 고쳐 주세요.', '- 확정되면 상태를 "완료"로 바꿔 주세요.');
  L.push('', c.end);
  return L.join('\n');
}

// ---------- docs.revise 데모 (글 전체에 간단한 규칙을 적용) ----------

const SPELL = [
  [/됬/g, '됐'],
  [/몇일/g, '며칠'],
  [/어떻해/g, '어떻게 해'],
  [/할께요/g, '할게요'],
  [/할께/g, '할게'],
  [/금새/g, '금세'],
  [/오랫만/g, '오랜만'],
  [/안되요/g, '안 돼요'],
  [/되요/g, '돼요'],
  [/웬지/g, '왠지'],
  [/역활/g, '역할'],
  [/일일히/g, '일일이'],
  [/깨끗히/g, '깨끗이'],
  [/있읍니다/g, '있습니다'],
  [/없읍니다/g, '없습니다'],
  [/희안/g, '희한'],
  [/어의없/g, '어이없'],
  [/설겆이/g, '설거지'],
  [/왠만/g, '웬만'],
  [/ +,/g, ','],
  [/ +\./g, '.'],
  [/!{2,}/g, '!'],
  [/\?{2,}/g, '?'],
  [/([^\s|]) {2,}(?=\S)/g, '$1 '],
  [/[ \t]+$/gm, ''],
];

function proofread(text) {
  let t = String(text);
  for (const [re, to] of SPELL) t = t.replace(re, to);
  return t.replace(/\n{3,}/g, '\n\n');
}

function politer(text) {
  return proofread(text)
    .split('\n')
    .map((line) =>
      /^\s*#{1,4}\s/.test(line) // 제목 줄은 그대로 둠
        ? line
        : line
        .replace(/(해라|하라|할 것)(\.|$)/g, '해 주시기 바랍니다$2')
        .replace(/하세요(\.|!|$)/g, '해 주시기 바랍니다.')
        .replace(/주세요(\.|!|$)/g, '주시기 바랍니다.')
        .replace(/한다(\.|$)/g, '합니다$1')
        .replace(/된다(\.|$)/g, '됩니다$1')
        .replace(/있다(\.|$)/g, '있습니다$1')
        .replace(/없다(\.|$)/g, '없습니다$1')
        .replace(/이다(\.|$)/g, '입니다$1')
        .replace(/하자(\.|$)/g, '하면 좋겠습니다$1')
        .replace(/금지(\.|$)/g, '삼가 주시기 바랍니다$1')
        .replace(/바람(\.|$)/g, '바랍니다$1')
        .replace(/\.\.$/, '.')
    )
    .join('\n');
}

function shorter(text) {
  const out = [];
  let listCount = 0;
  for (const line of String(text).split('\n')) {
    const isList = /^\s*([-*•]|\d+[.)])\s+/.test(line);
    const isHead = /^#{1,4}\s/.test(line) || /^\*\*[^*]+\*\*\s*[:：]/.test(line);
    if (isList) {
      listCount++;
      if (listCount > 4) continue; // 목록은 앞의 4개만
      out.push(line.length > 70 ? line.slice(0, 70).replace(/\s+\S*$/, '') + '…' : line);
      continue;
    }
    listCount = 0;
    if (!line.trim() || isHead) {
      out.push(line);
      continue;
    }
    // 긴 문단은 첫 문장만
    const first = line.match(/^.*?[.!?。](\s|$)/);
    out.push(first && line.length > 60 ? first[0].trim() : line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function rewrite(text) {
  let t = proofread(text).trim();
  // 제목이 없는 글이면 구조를 잡아 줌
  if (!/^#{1,4}\s/m.test(t)) {
    const paras = t.split(/\n{2,}/);
    const head = paras.shift();
    t = [head, '', '## 주요 내용', '', ...paras].join('\n');
  }
  return t
    .replace(/바랍니다\./g, '부탁드립니다.')
    .replace(/하시기 부탁드립니다/g, '해 주시기 바랍니다')
    .replace(/\n{3,}/g, '\n\n');
}

function demoRevise(input) {
  const fn = { rewrite, shorter, politer, proofread }[input.mode] || rewrite;
  return fn(input.text);
}

// ---------- docs.minutes 데모 (메모에서 결정 사항·할 일 뽑기) ----------

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

/** 메모 속 날짜 표현(10/20, 10월 20일, 내일, 이번 주 금요일, 다음 주)을 'YYYY-MM-DD'로 */
function findDue(line, today) {
  let m = line.match(/(\d{1,2})\s*[/.월]\s*(\d{1,2})\s*일?/);
  if (m) {
    const y = Number(today.slice(0, 4));
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      let s = `${y}-${time.pad(mm)}-${time.pad(dd)}`;
      if (time.isValidDate(s) && time.diffDays(today, s) < -60) s = `${y + 1}-${time.pad(mm)}-${time.pad(dd)}`;
      if (time.isValidDate(s)) return s;
    }
  }
  if (/오늘/.test(line)) return today;
  if (/내일/.test(line)) return time.addDays(today, 1);
  if (/모레/.test(line)) return time.addDays(today, 2);
  m = line.match(/(이번\s*주|다음\s*주|다음주|이번주)?\s*([월화수목금토일])요일/);
  if (m) {
    const target = WEEK.indexOf(m[2]);
    const wd = time.weekday(today);
    let diff = (target - wd + 7) % 7;
    if (m[1] && /다음/.test(m[1])) diff += 7;
    else if (diff === 0) diff = 7;
    return time.addDays(today, diff);
  }
  if (/다음\s*주/.test(line)) return time.addDays(today, 7);
  if (/이번\s*주/.test(line)) return time.addDays(today, Math.max(0, 5 - time.weekday(today)));
  if (/이번\s*달|월말/.test(line)) {
    const ym = today.slice(0, 7);
    return `${ym}-${time.pad(time.daysInMonth(ym))}`;
  }
  return '';
}

function demoMinutes(input, ctx) {
  const today = input.date || (ctx && ctx.today) || time.today();
  const names = String(input.attendees || '')
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const lines = bullets(input.notes);
  const decisions = [];
  const actionItems = [];
  const rest = [];
  for (const line of lines) {
    const owner = names.find((n) => line.includes(n)) || names.find((n) => n.length >= 2 && line.includes(n.slice(1))) || '';
    const isAction = /(까지|담당|하기로|해\s*주|준비|요청|확인하기|정리하기|작성|발송|연락|주문|예약|공유|올리기|맡기|맡음|진행 예정)/.test(line) && (owner || /까지|담당/.test(line));
    const isDecision = /(결정|확정|하기로|변경|정함|합의|승인|도입|시행)/.test(line);
    if (isAction) {
      let task = line
        .replace(new RegExp(`${owner ? owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '\\u0000'}\\s*(원장|실장|팀장|선생)?\\s*(님|씨)?\\s*(이|가|은|는|께서)?\\s*`), '')
        .replace(/\s*(\d{1,2}\s*[/.월]\s*\d{1,2}\s*일?|오늘|내일|모레|(이번|다음)\s*주\s*([월화수목금토일]요일)?|[월화수목금토일]요일|이번\s*달|월말)\s*까지\s*/g, ' ')
        .replace(/\s*담당\s*[:：]?\s*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (!task) task = line;
      actionItems.push({ task: task.slice(0, 200), owner, due: findDue(line, today) });
      if (isDecision) decisions.push(line);
    } else if (isDecision) {
      decisions.push(line);
    } else {
      rest.push(line);
    }
  }
  // 요약: 논의 주제 → 결정 → 할 일 순서로 2~3문장
  const shortOf = (s) => (s.length > 28 ? s.slice(0, 28).replace(/\s+\S*$/, '') + '…' : s).replace(/[.。]$/, '');
  const topics = (rest.length ? rest : lines).slice(0, 2).map(shortOf);
  const owners = [...new Set(actionItems.map((a) => a.owner).filter(Boolean))];
  const parts = [`${input.title ? `"${input.title}"에서는` : '이번 회의에서는'} ${topics.join(', ') || '여러 안건'} 등을 논의했습니다.`];
  if (decisions.length) parts.push(`결정 사항은 ${decisions.length}건("${shortOf(decisions[0])}"${decisions.length > 1 ? ' 등' : ''})입니다.`);
  if (actionItems.length) parts.push(`후속 할 일 ${actionItems.length}건${owners.length ? `(담당: ${owners.join(', ')})` : ''}을 정리했습니다.`);
  const summary = parts.join(' ');
  const data = { summary, decisions, actionItems };
  return '```json\n' + JSON.stringify(data, null, 2) + '\n```';
}

/** AI가 돌려준 회의록 결과를 항상 같은 모양으로 정리 (빠진 칸, 잘못된 날짜 정리) */
function normalizeMinutes(d, rawText) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) {
    return { summary: String(rawText || '').trim().slice(0, 3000), decisions: [], actionItems: [] };
  }
  const str = (x) => (x === null || x === undefined ? '' : String(x).trim());
  const items = Array.isArray(d.actionItems) ? d.actionItems : Array.isArray(d.action_items) ? d.action_items : [];
  return {
    summary: str(d.summary).slice(0, 3000),
    decisions: (Array.isArray(d.decisions) ? d.decisions : []).map((x) => str(typeof x === 'object' ? x.text || x.decision : x)).filter(Boolean).slice(0, 30),
    actionItems: items
      .map((x) => (typeof x === 'string' ? { task: x } : x || {}))
      .map((x) => ({ task: str(x.task || x.todo || x.title).slice(0, 300), owner: str(x.owner || x.assignee).slice(0, 30), due: time.isValidDate(str(x.due)) ? str(x.due) : '' }))
      .filter((x) => x.task)
      .slice(0, 50),
  };
}

// ---------- 기능 정의 ----------

const KIND_GUIDE = {
  공문: '한국 공공·의료기관 공문서 형식. 맨 위에 **문서번호**, **시행일자**, **수신**, **참조**, **제목** 줄을 두고, 본문 번호 문단은 마크다운 목록 대신 "**1.** 내용", "**2.** 내용"처럼 굵은 번호로 쓰고(목록 기호 금지), "가. 나. 다." 세부 항목, 마지막에 **붙임** (있을 때) 과 "끝." 표시, 맨 아래 발신 명의("OO치과의원 원장"). 문서번호처럼 모르는 값은 "(확인 필요)".',
  안내문: '환자·보호자 또는 방문객이 읽는 원내 안내문. 인사 → 핵심 안내(날짜·시간·변경 사항은 목록) → 참고 사항 → 문의처 → 맺음 인사와 병원 이름. 쉬운 말, 짧은 문장.',
  '내부 규정': '원내 직원용 규정. "## 제1조 (목적)", "## 제2조 (적용 범위)" 처럼 조항 형식, 각 조 안은 ①②③ 항. 책임자·확인 주기 조항과 "## 부칙"(시행일)을 포함. 문체는 "~한다".',
  '업무 매뉴얼': '직원이 그대로 따라 하는 업무 매뉴얼. 목적 → 대상·담당 → 시작 전 확인 → "단계별 절차"(번호 목록, 각 단계에 기준·주의점) → 주의 사항 → 기록·보고.',
  '교육 자료': '직원 교육용 자료. 교육 개요(주제·대상·목적) → 학습 목표 → 핵심 내용(소제목별, 왜 중요한지·실천 방법) → 확인 문제 2~3개.',
  '채용 공고': '치과 채용 공고. 모집 분야 → 주요 업무·우대 사항 → 근무 조건(모르는 급여·시간은 "확인 필요") → 지원 방법 → 전형 절차. 나이·성별·결혼 여부 등 차별 조건은 넣지 않음.',
  기타: '목적에 맞는 일반 업무 문서. 제목 → 개요 → 주요 내용(목록) → 다음 할 일.',
};
const LENGTH_GUIDE = { 짧게: 'A4 반 쪽 이내로 핵심만', 보통: 'A4 한 쪽 정도', 자세히: 'A4 한두 쪽, 항목마다 설명과 예시를 덧붙여' };
const TONE_GUIDE = { 정중: '정중하고 부드러운 존댓말', 친근: '친근하고 따뜻한 존댓말 (과한 이모티콘 금지)', 공식: '격식 있는 공문서 문체' };

const aiFeatures = [
  {
    key: 'docs.write',
    label: '문서 초안 작성 (공문·안내문·규정·매뉴얼)',
    group: '행정·서류',
    tier: 'smart',
    maxTokens: 3000,
    timeoutSec: 120,
    input: v.object({
      kind: v.enum(DOC_KINDS, { label: '문서 종류' }),
      purpose: v.string({ min: 2, max: 500, label: '목적' }),
      audience: v.string({ max: 200, optional: true, default: '', label: '받는 사람/대상' }),
      points: v.string({ max: 4000, optional: true, default: '', label: '핵심 내용' }),
      tone: v.enum(TONES, { optional: true, default: '정중', label: '어조' }),
      length: v.enum(LENGTHS, { optional: true, default: '보통', label: '분량' }),
      title: v.string({ max: 150, optional: true, default: '', label: '제목' }),
    }),
    build(input, ctx) {
      const c = ctx.clinic || {};
      return {
        system: [
          ctx.baseSystem,
          '',
          '추가 지시: 당신은 치과의원의 행정 문서를 쓰는 전문 비서입니다. 바로 인쇄해 쓸 수 있는 완성된 문서를 마크다운으로 씁니다.',
          '- 첫 줄은 반드시 "# 문서 제목" 한 줄. 그 아래에 본문. 앞뒤 설명이나 코드 블록(```)은 쓰지 않습니다.',
          '- 메모에 있는 날짜·시간·숫자·이름은 그대로 지키고, 메모에 없는 구체적인 사실(금액, 법 조항 번호 등)은 지어내지 말고 "(확인 필요)"로 둡니다.',
        ].join('\n'),
        prompt: [
          `[문서 종류] ${input.kind}`,
          `[형식 안내] ${KIND_GUIDE[input.kind]}`,
          `[어조] ${TONE_GUIDE[input.tone]}`,
          `[분량] ${LENGTH_GUIDE[input.length]}`,
          `[병원] ${c.name || '(병원 이름)'}${c.phone ? ` / 대표전화 ${c.phone}` : ''}${c.address ? ` / ${c.address}` : ''}${c.representative ? ` / 대표 ${c.representative}` : ''}`,
          `[작성일] ${longDate(ctx.today)}`,
          input.title ? `[원하는 제목] ${input.title}` : '',
          `[목적] ${input.purpose}`,
          `[받는 사람/대상] ${input.audience || '(지정 없음)'}`,
          '[핵심 내용 메모]',
          input.points || '(메모 없음 — 목적에 맞게 일반적인 내용으로 쓰되 확인이 필요한 부분은 표시)',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    },
    demo: demoWrite,
    /** 첫 줄의 "# 제목"을 떼어 제목과 본문으로 나눔 */
    parse(text) {
      const s = String(text || '').replace(/^\s*```(?:markdown|md)?\s*\n?|\n?```\s*$/g, '').trim();
      const m = s.match(/^#\s+(.+)\n?([\s\S]*)$/);
      if (!m) return { title: '', content: s };
      return { title: m[1].trim().slice(0, 150), content: m[2].trim() };
    },
  },
  {
    key: 'docs.revise',
    label: '문서 다듬기 (다시 쓰기·줄이기·정중하게·맞춤법)',
    group: '행정·서류',
    tier: 'fast',
    maxTokens: 3500,
    timeoutSec: 90,
    input: v.object({
      mode: v.enum(Object.keys(REVISE_MODES), { label: '다듬기 방식' }),
      text: v.string({ min: 2, max: 12000, label: '문서 내용' }),
      kind: v.enum(DOC_KINDS, { optional: true, default: '기타', label: '문서 종류' }),
    }),
    build(input, ctx) {
      const how = {
        rewrite: '같은 내용과 사실을 유지하면서, 더 읽기 쉽고 짜임새 있게 처음부터 다시 써 주세요. 필요하면 소제목과 목록으로 구조를 잡으세요.',
        shorter: '핵심만 남기고 분량을 절반 정도로 줄여 주세요. 날짜·시간·숫자·담당자 같은 중요한 정보는 빼지 마세요.',
        politer: '내용은 그대로 두고 더 정중하고 부드러운 존댓말로 바꿔 주세요. 명령조("~할 것", "~하라")는 요청 표현으로 바꾸세요.',
        proofread: '내용과 문체는 그대로 두고 맞춤법, 띄어쓰기, 어색한 문장, 오탈자만 고쳐 주세요.',
      }[input.mode];
      return {
        system: [ctx.baseSystem, '', '추가 지시: 고친 문서 전문만 출력합니다. 설명, 머리말, 코드 블록(```)은 쓰지 않습니다. 원래의 마크다운 구조(# 제목, 목록, 굵게, 표)는 최대한 유지합니다.'].join('\n'),
        prompt: [`[문서 종류] ${input.kind}`, `[요청] ${how}`, '', '[문서]', input.text].join('\n'),
      };
    },
    demo: demoRevise,
    parse(text) {
      return { content: String(text || '').replace(/^\s*```(?:markdown|md)?\s*\n?|\n?```\s*$/g, '').trim() };
    },
  },
  {
    key: 'docs.minutes',
    label: '회의록 요약 (결정 사항·할 일·담당자)',
    group: '행정·서류',
    tier: 'smart',
    maxTokens: 2000,
    timeoutSec: 120,
    input: v.object({
      title: v.string({ max: 150, optional: true, default: '', label: '회의 제목' }),
      date: v.date({ optional: true, label: '회의 날짜' }),
      attendees: v.string({ max: 1000, optional: true, default: '', label: '참석자' }),
      notes: v.string({ min: 10, max: 8000, label: '회의 메모' }),
    }),
    build(input, ctx) {
      const date = input.date || ctx.today;
      return {
        system: [
          ctx.baseSystem,
          '',
          '추가 지시: 치과 직원회의 메모를 회의록으로 정리합니다. 반드시 아래 JSON 하나만 ```json 코드 블록 안에 출력합니다.',
          '{"summary": "회의 전체 요약 2~4문장", "decisions": ["결정된 사항", ...], "actionItems": [{"task": "할 일 (동사로 끝나게)", "owner": "담당자 이름 또는 빈 글자", "due": "YYYY-MM-DD 또는 빈 글자"}]}',
          '- owner는 참석자 목록에 있는 이름 중에서만 고르고, 메모에 담당자가 없으면 빈 글자로 둡니다.',
          `- "다음 주 금요일", "10/20까지" 같은 표현은 회의 날짜(${date}, ${WEEK[time.weekday(date)]}요일) 기준으로 계산해 YYYY-MM-DD로 바꿉니다. 기한이 없으면 빈 글자.`,
          '- 메모에 없는 내용은 만들지 않습니다.',
        ].join('\n'),
        prompt: [`[회의 제목] ${input.title || '(제목 없음)'}`, `[회의 날짜] ${date}`, `[참석자] ${input.attendees || '(기록 없음)'}`, '[회의 메모]', input.notes].join('\n'),
      };
    },
    demo: demoMinutes,
    parse(text) {
      let d = null;
      try {
        d = extractJson(text);
      } catch {
        d = null;
      }
      return normalizeMinutes(d, text);
    },
  },
];

module.exports = { aiFeatures, DOC_KINDS, REVISE_MODES, normalizeMinutes, findDue };
