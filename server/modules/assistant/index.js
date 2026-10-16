/*
 * 이 파일이 하는 일: [G. 원내 AI 도우미] 서버 기능
 *
 *  - 원내 매뉴얼·규정 문서를 등록합니다 (붙여넣기 또는 txt/md/csv/docx 파일).
 *    "AI 문서 작성" 메뉴에서 'AI 도우미가 참고'를 켠 문서도 자동으로 함께 검색됩니다.
 *  - 질문하면 search.js 로 관련 문단을 찾고, 그 문단만 근거로 AI가 답합니다(assistant.ask).
 *    답과 함께 근거가 된 문서·문단을 [1], [2] 번호로 보여 줍니다.
 *  - 키가 없는 데모 모드에서도 "관련 문단에서 뽑은 핵심 문장"을 근거와 함께 보여 주므로 쓸 수 있습니다.
 *  - 질문 내용은 저장하지 않습니다 (사용 기록에는 토큰 수와 비용만 남음).
 *
 * API (/api/assistant/...)
 *   GET    /docs           등록 문서 목록 (+ 문서함에서 연결된 문서)
 *   GET    /docs/:id       문서 내용 보기
 *   POST   /docs           등록 { title, category, text } 또는 { title, category, filename, base64 }  (실장 이상)
 *   PATCH  /docs/:id       제목·분류·사용 여부·내용 수정 (실장 이상)
 *   DELETE /docs/:id       삭제 (실장 이상)
 *   GET    /search?q=      AI 없이 관련 문단만 찾기 (비용 없음)
 *   GET    /suggestions    예시 질문
 */
const { all, get, run, tx } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, badRequest } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { requireRole } = require('../../core/auth');
const time = require('../../core/time');
const { extractText } = require('./extract');
const { chunkText, buildIndex, search, bestSentences } = require('./search');

const CATEGORIES = ['업무 매뉴얼', '내부 규정', '감염관리', '장비 사용법', '응대 안내', '인사·복무', '기타'];
const MAX_CHARS = 300000; // 문서 하나 최대 글자 수 (약 150쪽)

const migrations = [
  {
    id: 'assistant_001',
    up: `
      CREATE TABLE kb_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '기타',
        source TEXT NOT NULL DEFAULT 'paste',      -- paste(붙여넣기) / file(파일)
        filename TEXT,
        content TEXT NOT NULL,
        chars INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE kb_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        heading TEXT,
        text TEXT NOT NULL
      );
      CREATE INDEX idx_kb_chunks_doc ON kb_chunks(doc_id);
    `,
  },
];

// ---------- 검색 색인 (문서가 바뀌었을 때만 다시 만듦) ----------
let cache = { sig: null, index: null };

/** "AI 문서 작성" 메뉴의 문서 중 도우미가 참고하도록 표시된 것 (문서 모듈이 없으면 빈 목록) */
function linkedDocuments() {
  try {
    return all("SELECT id, title, doc_kind, content, updated_at FROM documents WHERE include_in_kb = 1 AND type = 'doc'");
  } catch {
    return [];
  }
}

function signature() {
  const a = get('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), \'\') AS m FROM kb_docs WHERE active = 1');
  let b = { n: 0, m: '' };
  try {
    b = get("SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS m FROM documents WHERE include_in_kb = 1 AND type = 'doc'");
  } catch {
    /* 문서 모듈 없음 */
  }
  return `${a.n}|${a.m}|${b.n}|${b.m}`;
}

function getIndex() {
  const sig = signature();
  if (cache.sig === sig && cache.index) return cache.index;
  const chunks = all(
    `SELECT c.id, c.doc_id, c.heading, c.text, d.title FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE d.active = 1 ORDER BY c.doc_id, c.idx`
  ).map((c) => ({ key: `kb:${c.id}`, docRef: `kb:${c.doc_id}`, title: c.title, heading: c.heading || '', text: c.text }));
  for (const d of linkedDocuments()) {
    chunkText(d.content).forEach((c, i) => chunks.push({ key: `doc:${d.id}:${i}`, docRef: `doc:${d.id}`, title: d.title, heading: c.heading, text: c.text }));
  }
  cache = { sig, index: buildIndex(chunks) };
  return cache.index;
}

/** 질문으로 근거 문단 찾기 → [{ n, docRef, title, heading, text, snippet, score }] */
function findSources(question, limit = 5) {
  const hits = search(getIndex(), question, { limit });
  return hits.map((h, i) => ({
    n: i + 1,
    docRef: h.chunk.docRef,
    title: h.chunk.title,
    heading: h.chunk.heading,
    text: h.chunk.text,
    snippet: (bestSentences(h.chunk.text, question, 2).join(' ') || h.chunk.text).slice(0, 220),
    score: Math.round(h.score * 100) / 100,
  }));
}

/** 문서를 저장하고 조각(chunk)으로 나눠 둠 */
function saveChunks(docId, content) {
  run('DELETE FROM kb_chunks WHERE doc_id = ?', docId);
  chunkText(content).forEach((c, i) => run('INSERT INTO kb_chunks (doc_id, idx, heading, text) VALUES (?, ?, ?, ?)', docId, i, c.heading, c.text));
}

function docView(d, withContent) {
  return {
    id: d.id,
    ref: `kb:${d.id}`,
    title: d.title,
    category: d.category,
    source: d.source,
    filename: d.filename,
    chars: d.chars,
    active: !!d.active,
    chunks: d.chunk_count ?? undefined,
    createdBy: d.created_by_name,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    ...(withContent ? { content: d.content } : {}),
  };
}

const createSchema = v.object({
  title: v.string({ min: 1, max: 120, label: '제목' }),
  category: v.enum(CATEGORIES, { optional: true, default: '기타', label: '분류' }),
  text: v.string({ max: MAX_CHARS, optional: true, label: '내용', trim: false }),
  filename: v.string({ max: 200, optional: true }),
  base64: v.string({ max: 28 * 1024 * 1024, optional: true, trim: false }),
});

function register(r) {
  const managerUp = requireRole('manager');

  r.get('/docs', (req, res) => {
    const rows = all(
      `SELECT d.id, d.title, d.category, d.source, d.filename, d.chars, d.active, d.created_at, d.updated_at,
         u.name AS created_by_name, (SELECT COUNT(*) FROM kb_chunks c WHERE c.doc_id = d.id) AS chunk_count
       FROM kb_docs d LEFT JOIN users u ON u.id = d.created_by ORDER BY d.updated_at DESC`
    );
    const linked = linkedDocuments().map((d) => ({
      ref: `doc:${d.id}`,
      id: d.id,
      title: d.title,
      category: d.doc_kind || '문서함',
      chars: (d.content || '').length,
      updatedAt: d.updated_at,
      href: `#/documents/${d.id}`,
    }));
    res.json({ docs: rows.map((d) => docView(d)), linked, categories: CATEGORIES });
  });

  r.get('/docs/:id', (req, res) => {
    const d = get('SELECT * FROM kb_docs WHERE id = ?', idParam(req.params.id));
    if (!d) throw notFound('문서');
    res.json(docView(d, true));
  });

  r.post('/docs', managerUp, (req, res) => {
    const d = createSchema.parse(req.body);
    let content = d.text || '';
    let source = 'paste';
    if (d.base64) {
      const buf = Buffer.from(d.base64, 'base64');
      if (buf.length > 20 * 1024 * 1024) throw badRequest('파일이 너무 큽니다. 20MB 이하만 등록할 수 있습니다.');
      content = extractText(d.filename || '', buf);
      source = 'file';
    }
    content = content.replace(/\r\n/g, '\n').trim();
    if (content.length < 10) throw badRequest('문서 내용이 너무 짧거나 글자를 찾지 못했습니다.');
    if (content.length > MAX_CHARS) throw badRequest(`문서가 너무 깁니다. ${MAX_CHARS.toLocaleString('ko-KR')}자 이하로 나눠서 등록해 주세요.`);
    const now = time.nowIso();
    const id = tx(() => {
      const info = run(
        `INSERT INTO kb_docs (title, category, source, filename, content, chars, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        d.title,
        d.category,
        source,
        d.filename,
        content,
        content.length,
        req.user.id,
        now,
        now
      );
      saveChunks(info.lastInsertRowid, content);
      return info.lastInsertRowid;
    });
    audit(req, 'create', 'kb_docs', id, `AI 도우미 문서 등록: ${d.title} (${content.length.toLocaleString('ko-KR')}자)`);
    res.status(201).json(docView(get('SELECT * FROM kb_docs WHERE id = ?', id)));
  });

  r.patch('/docs/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const cur = get('SELECT * FROM kb_docs WHERE id = ?', id);
    if (!cur) throw notFound('문서');
    const d = v
      .object({
        title: v.string({ min: 1, max: 120, label: '제목' }),
        category: v.enum(CATEGORIES, { label: '분류' }),
        active: v.bool(),
        text: v.string({ min: 10, max: MAX_CHARS, label: '내용', trim: false }),
      })
      .partial()
      .parse(req.body);
    const content = d.text !== undefined ? d.text.replace(/\r\n/g, '\n').trim() : cur.content;
    tx(() => {
      run(
        'UPDATE kb_docs SET title = ?, category = ?, active = ?, content = ?, chars = ?, updated_at = ? WHERE id = ?',
        d.title ?? cur.title,
        d.category ?? cur.category,
        'active' in d ? d.active : cur.active,
        content,
        content.length,
        time.nowIso(),
        id
      );
      if (d.text !== undefined) saveChunks(id, content);
    });
    audit(req, 'update', 'kb_docs', id, `AI 도우미 문서 수정: ${d.title ?? cur.title}`);
    res.json(docView(get('SELECT * FROM kb_docs WHERE id = ?', id)));
  });

  r.delete('/docs/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const cur = get('SELECT * FROM kb_docs WHERE id = ?', id);
    if (!cur) throw notFound('문서');
    run('DELETE FROM kb_docs WHERE id = ?', id);
    audit(req, 'delete', 'kb_docs', id, `AI 도우미 문서 삭제: ${cur.title}`);
    res.json({ ok: true });
  });

  r.get('/search', (req, res) => {
    const q = String(req.query.q || '').slice(0, 300);
    res.json({ q, results: q.trim() ? findSources(q, 8) : [] });
  });

  r.get('/suggestions', (req, res) => {
    const idx = getIndex();
    const headings = [...new Set(idx.docs.map((d) => d.chunk.heading).filter((h) => h && h.length >= 3 && h.length <= 24))];
    const picks = headings.slice(0, 40).sort(() => Math.random() - 0.5).slice(0, 4);
    const clean = (h) => h.replace(/^제\s?\d+\s?조\s*/, '').replace(/^\d+[.)]\s*/, '').replace(/[()]/g, '').trim();
    res.json({ suggestions: picks.map((h) => `${clean(h)} 관련 내용을 알려 주세요`), docCount: new Set(idx.docs.map((d) => d.chunk.docRef)).size });
  });
}

// ---------- AI 기능 ----------
const askInput = v.object({
  question: v.string({ min: 2, max: 1000, label: '질문' }),
  history: v.array(v.object({ q: v.string({ max: 1000, optional: true, default: '' }), a: v.string({ max: 4000, optional: true, default: '' }) }), { optional: true, max: 3 }),
});

const aiFeatures = [
  {
    key: 'assistant.ask',
    label: '원내 AI 도우미 질문',
    group: '원내 AI 도우미',
    tier: 'smart',
    maxTokens: 1200,
    input: askInput,
    build(input, ctx) {
      const sources = findSources(input.question, 5);
      const context = sources.length
        ? sources.map((s) => `[${s.n}] 문서: ${s.title}${s.heading ? ' > ' + s.heading : ''}\n${s.text}`).join('\n\n---\n\n')
        : '(관련 문서를 찾지 못했습니다)';
      const system = [
        ctx.baseSystem,
        '',
        '추가 지시: 당신은 원내 규정·매뉴얼 도우미입니다.',
        '- 아래 [원내 문서]에 있는 내용만 근거로 답합니다. 문서에 없는 내용은 추측하지 말고 "등록된 원내 문서에서 찾지 못했습니다. 원장님/실장님께 확인해 주세요."라고 답합니다.',
        '- 근거로 쓴 문단 번호를 문장 끝에 [1], [2]처럼 붙입니다.',
        '- 답은 짧고 실무적으로: 핵심 한두 문장 → 필요하면 단계별 목록.',
      ].join('\n');
      const messages = [];
      for (const h of input.history || []) {
        if (h.q) messages.push({ role: 'user', content: h.q });
        if (h.a) messages.push({ role: 'assistant', content: h.a });
      }
      messages.push({ role: 'user', content: `[원내 문서]\n${context}\n\n[질문]\n${input.question}` });
      return { system, messages, sources: sources.map(({ text, ...rest }) => rest) };
    },
    demo(input) {
      const sources = findSources(input.question, 5);
      if (!sources.length) {
        return '등록된 원내 문서에서 관련 내용을 찾지 못했습니다. 원장님/실장님께 확인해 주세요.\n\n(데모 모드: 관련 문단을 찾아 보여 주는 기능만 동작합니다. AI 키를 넣으면 문서 내용을 바탕으로 자연스럽게 답합니다.)';
      }
      const lines = ['등록된 원내 문서에서 찾은 관련 내용입니다.', ''];
      for (const s of sources.slice(0, 3)) {
        const sents = bestSentences(s.text, input.question, 2);
        lines.push(`- ${(sents.length ? sents.join(' ') : s.text.slice(0, 160)).replace(/\s+/g, ' ')} [${s.n}]`);
      }
      lines.push('', '(데모 모드: 관련 문장을 그대로 보여 드렸습니다. AI 키를 넣으면 이 근거를 바탕으로 정리된 답을 드립니다.)');
      return lines.join('\n');
    },
  },
];

// ---------- 데모 데이터 ----------
const DEMO_DOCS = [
  {
    title: '원내 복무 규정',
    category: '인사·복무',
    content: `# 원내 복무 규정

## 제1조 근무 시간
평일 근무는 09:00부터 18:30까지이며, 진료 시작 30분 전까지 출근해 오픈 체크를 합니다.
토요일은 09:00부터 14:00까지 교대로 근무합니다. 근무표는 매월 25일까지 다음 달 근무표를 확정해 공지합니다.

## 제2조 지각·조퇴
지각이 예상되면 출근 시간 전까지 실장에게 전화 또는 메시지로 알립니다.
조퇴는 하루 전까지 연차·휴가 메뉴에서 반차로 신청합니다. 급한 경우 실장 승인 후 사후 신청할 수 있습니다.

## 제3조 연차 사용
연차는 사용 희망일 7일 전까지 연차·휴가 메뉴에서 신청합니다. 같은 날 휴가자가 2명 이상이면 진료 일정을 위해 조정을 요청할 수 있습니다.
반차는 오전(09:00~13:00) 또는 오후(14:00~18:30) 단위로 사용합니다.
연말에 남은 연차는 다음 해 1월 중 사용 계획을 협의합니다.

## 제4조 복장과 위생
근무 중에는 지급된 근무복과 실내화를 착용합니다. 진료실에서는 장신구(반지, 팔찌)를 착용하지 않습니다.
손톱은 짧게 유지하고 진료 전후 손 위생을 지킵니다.

## 제5조 개인정보 보호
환자 정보는 업무 목적 외에 열람·복사·외부 전송하지 않습니다.
개인 휴대전화로 환자 정보를 촬영하거나 메신저로 보내지 않습니다.
AI 도구(이 서비스 포함)에는 환자 이름, 연락처, 주민등록번호, 차트번호, 진료 내용을 입력하지 않습니다.
`,
  },
  {
    title: '응급 상황 대응 절차',
    category: '업무 매뉴얼',
    content: `# 응급 상황 대응 절차

## 1. 진료 중 환자가 어지러움을 호소할 때
즉시 진료를 멈추고 체어를 눕혀 다리를 약간 올립니다. 원장에게 바로 알리고 활력징후 측정을 준비합니다.
산소와 응급키트를 체어 옆으로 가져옵니다.

## 2. 응급키트 위치와 점검
응급키트와 산소통은 2진료실 입구 왼쪽 수납장에 있습니다.
매월 첫째 주 월요일에 응급약품 유효기간과 산소 잔량을 점검하고 체크리스트에 기록합니다.
자동심장충격기(AED)는 데스크 뒤 벽에 있으며 배터리 표시등을 주 1회 확인합니다.

## 3. 119 신고
원장이 지시하면 데스크 담당자가 119에 신고합니다. 병원 주소와 층수, 엘리베이터 위치를 정확히 안내합니다.
구급대가 도착하면 직원 한 명이 1층 입구에서 안내합니다.

## 4. 기록
상황이 끝나면 당일 안에 원장과 실장이 발생 경위를 공지·인수인계 보드에 내부 보고로 남깁니다. 환자 개인정보는 보드에 적지 않습니다.
`,
  },
];

function seed(ctx) {
  const now = time.nowIso();
  for (const d of DEMO_DOCS) {
    const info = run(
      `INSERT INTO kb_docs (title, category, source, content, chars, created_by, created_at, updated_at) VALUES (?, ?, 'paste', ?, ?, ?, ?, ?)`,
      d.title,
      d.category,
      d.content.trim(),
      d.content.trim().length,
      ctx.users.admin,
      now,
      now
    );
    saveChunks(info.lastInsertRowid, d.content.trim());
  }
}

module.exports = {
  name: 'assistant',
  migrations,
  register,
  aiFeatures,
  seed,
  resetTables: ['kb_chunks', 'kb_docs'],
  findSources,
  CATEGORIES,
};
