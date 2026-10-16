/*
 * 이 파일이 하는 일: 원내 문서에서 질문과 관련 있는 문단을 찾습니다. (검색 엔진)
 *
 * 왜 이렇게 만들었나
 *   한국어는 "멸균기는", "멸균기를"처럼 단어 뒤에 조사가 붙어서 단어 단위로 찾으면 잘 안 맞습니다.
 *   그래서 글을 "글자 두 개 묶음"(바이그램: 멸균, 균기, 기는 …)으로 잘라 비교합니다.
 *   점수는 검색 엔진에서 널리 쓰는 BM25 방식으로 매깁니다(드문 단어가 겹칠수록, 짧은 문단일수록 높은 점수).
 *   외부 AI(임베딩)를 쓰지 않으므로 비용이 없고, 문서 내용이 밖으로 나가지 않습니다.
 *
 *   chunkText(text)       : 긴 문서를 제목·문단 기준으로 600자 안팎의 조각으로 나눔
 *   buildIndex(chunks)    : 조각들로 검색 색인을 만듦
 *   search(index, query)  : 질문과 가장 관련 있는 조각을 점수 순으로 돌려줌
 */

/** 글 → 검색용 조각(토큰) 목록 */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];
  // 한글 덩어리 / 영문·숫자 덩어리로 나눔
  for (const m of s.matchAll(/[가-힣]+|[a-z0-9]+/g)) {
    const w = m[0];
    if (/^[가-힣]+$/.test(w)) {
      if (w.length === 1) tokens.push(w);
      else for (let i = 0; i < w.length - 1; i++) tokens.push(w.slice(i, i + 2));
    } else if (w.length >= 2 || /\d/.test(w)) {
      tokens.push(w);
    }
  }
  return tokens;
}

// 질문에 자주 붙지만 뜻이 약한 말 (점수 계산에서 뺌)
const STOP = new Set(['어떻', '떻게', '하나', '나요', '는지', '인가', '가요', '있나', '하면', '해야', '합니', '니까', '무엇', '언제', '어디', '알려', '려줘', '주세', '세요', '은지', '에서', '하는', '되나', '있어', '해줘', '방법']);

/**
 * 긴 글을 조각으로 나눔. 제목(#)이 나오면 새 조각을 시작하고, 각 조각에 소속 제목을 기억합니다.
 * @returns {{heading:string, text:string}[]}
 */
function chunkText(text, target = 600) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const chunks = [];
  let heading = '';
  let buf = [];
  let size = 0;
  const flush = () => {
    const t = buf.join('\n').trim();
    if (t) chunks.push({ heading, text: t });
    buf = [];
    size = 0;
  };
  for (const line of lines) {
    const h = line.match(/^#{1,4}\s+(.*)$/) || line.match(/^(제\s?\d+\s?조.*)$/) || line.match(/^(\d+\.\s+\S.{0,40})$/);
    if (h && line.match(/^#{1,4}\s+/)) {
      flush();
      heading = h[1].trim();
      continue;
    }
    if (h && size > target * 0.4) {
      // "제3조 …" 같은 조항 제목이나 "1. 준비" 같은 번호 제목에서 조각을 나눔
      flush();
    }
    buf.push(line);
    size += line.length + 1;
    if (size >= target && line.trim() === '') flush();
    else if (size >= target * 1.6) flush();
  }
  flush();
  return chunks;
}

/**
 * @param {{id:any, docId:any, title:string, heading:string, text:string}[]} chunks
 */
function buildIndex(chunks) {
  const docs = chunks.map((c) => {
    // 문서 제목과 소제목도 함께 색인 (제목에 나온 말이 맞으면 점수가 올라가게)
    const toks = tokenize(`${c.title} ${c.heading} ${c.heading} ${c.text}`);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { chunk: c, tf, len: toks.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avgLen = docs.reduce((n, d) => n + d.len, 0) / Math.max(1, docs.length);
  return { docs, df, avgLen, N: docs.length };
}

/**
 * @returns {{chunk, score:number}[]}  점수 높은 순
 */
function search(index, query, { limit = 5, minScore = 0.8 } = {}) {
  const q = [...new Set(tokenize(query).filter((t) => !STOP.has(t)))];
  if (!q.length || !index.N) return [];
  const k1 = 1.2;
  const b = 0.75;
  const results = [];
  for (const d of index.docs) {
    let score = 0;
    let matched = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      matched++;
      const n = index.df.get(t) || 0;
      const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / index.avgLen)));
    }
    // 질문 조각 중 많이 겹칠수록 가산 (일부 단어만 우연히 겹친 문단을 낮춤)
    if (matched) score *= 0.5 + matched / q.length;
    if (score >= minScore) results.push({ chunk: d.chunk, score });
  }
  results.sort((a, b2) => b2.score - a.score);
  return results.slice(0, limit);
}

/** 조각 안에서 질문과 가장 많이 겹치는 문장들을 골라 짧은 요약(미리보기)으로 */
function bestSentences(text, query, max = 3) {
  const q = new Set(tokenize(query).filter((t) => !STOP.has(t)));
  const sents = String(text)
    .split(/(?<=[.!?。다요])\s+|\n+/)
    .map((s) => s.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((s) => s.length > 4);
  const scored = sents.map((s, i) => {
    const toks = tokenize(s);
    const hit = toks.filter((t) => q.has(t)).length;
    return { s, i, hit: hit / Math.sqrt(toks.length + 1) };
  });
  return scored
    .filter((x) => x.hit > 0)
    .sort((a, b) => b.hit - a.hit)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);
}

module.exports = { tokenize, chunkText, buildIndex, search, bestSentences };
