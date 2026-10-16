/*
 * 이 파일이 하는 일: [C. 행정·서류] 모듈의 서버 기능입니다. (문서함, 회의록, 서식 보관함)
 *
 *   - 문서함(documents, type='doc'): 공문·안내문·내부 규정·업무 매뉴얼 등. AI 초안 → 편집 → 저장 → 인쇄.
 *       include_in_kb = 1 이면 "원내 AI 도우미가 참고하는 문서" (실장 이상만 켜고 끌 수 있음)
 *   - 회의록(documents, type='minutes'): 날짜·참석자·내용·요약·할 일 목록(action_items JSON)
 *   - 서식 보관함(files): 파일을 DB 안에 그대로 저장 (백업이 DB 파일 하나로 끝나도록)
 *   AI 기능은 ai.js, 예시 데이터는 seed.js 에 있습니다.
 *
 * API (/api/documents/...)
 *   GET    /docs                 문서 목록 (q, kind, status, kb, page)
 *   GET    /docs/:id             문서 하나
 *   POST   /docs                 새 문서
 *   PATCH  /docs/:id             수정 (작성자 또는 실장 이상)
 *   DELETE /docs/:id             삭제 (작성자 또는 실장 이상)
 *   POST   /docs/:id/duplicate   복제 (사본 만들기)
 *   GET    /minutes              회의록 목록 (q, open=1: 안 끝난 할 일이 있는 것만, page)
 *   GET    /minutes/:id          회의록 하나
 *   POST   /minutes              새 회의록
 *   PATCH  /minutes/:id          수정 (작성자 또는 실장 이상)
 *   DELETE /minutes/:id          삭제 (작성자 또는 실장 이상)
 *   PATCH  /minutes/:id/actions/:idx   할 일 완료/해제 (누구나 — 자기 할 일을 바로 체크할 수 있게)
 *   GET    /files                파일 목록 (q, category)  ※ 파일 내용은 빼고 보냄
 *   POST   /files                파일 올리기 { name, mime, data(base64), category, description } (20MB 이하)
 *   PATCH  /files/:id            이름·분류·설명 수정 (올린 사람 또는 실장 이상)
 *   DELETE /files/:id            삭제 (올린 사람 또는 실장 이상)
 *   GET    /files/:id/download   내려받기
 *   GET    /files/:id/preview    미리보기 (그림은 그대로, 글자 파일은 { text })
 */
const { all, get, run, where } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, forbidden, badRequest, HttpError } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { hasRole } = require('../../core/auth');
const time = require('../../core/time');
const { aiFeatures, DOC_KINDS } = require('./ai');
const { seed } = require('./seed');

const FILE_CATEGORIES = ['서식', '계약서', '교육 자료', '매뉴얼', '기타'];
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB
const STATUS_LABEL = { draft: '작성 중', final: '완료' };

const migrations = [
  {
    id: 'documents_001',
    up: `
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK (type IN ('doc','minutes')),   -- doc: 일반 문서 / minutes: 회의록
        doc_kind TEXT,                                          -- 공문/안내문/내부 규정/업무 매뉴얼/교육 자료/채용 공고/기타
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',                       -- 본문 (마크다운)
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
        tags TEXT NOT NULL DEFAULT '',                          -- 쉼표로 구분한 꼬리표
        include_in_kb INTEGER NOT NULL DEFAULT 0,               -- 1 = 원내 AI 도우미가 참고하는 문서
        meeting_date TEXT,                                      -- (회의록) 회의 날짜
        attendees TEXT NOT NULL DEFAULT '',                     -- (회의록) 참석 직원 이름, 쉼표로 구분
        action_items TEXT NOT NULL DEFAULT '[]',                -- (회의록) [{task, owner, due, done}]
        summary TEXT NOT NULL DEFAULT '',                       -- (회의록) 요약
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_documents_type ON documents(type, updated_at);
      CREATE INDEX idx_documents_kb ON documents(include_in_kb);
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        mime TEXT NOT NULL DEFAULT 'application/octet-stream',
        size INTEGER NOT NULL,
        data BLOB NOT NULL,
        category TEXT NOT NULL DEFAULT '기타',
        description TEXT NOT NULL DEFAULT '',
        uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_files_category ON files(category, created_at);
    `,
  },
];

// ---------- 공통 도우미 ----------

/** 꼬리표 정리: "감염, #멸균 ,  필수" → "감염, 멸균, 필수" (중복 제거, 최대 10개) */
function normTags(s) {
  const list = String(s || '')
    .split(/[,，#\n]+/)
    .map((t) => t.trim().slice(0, 20))
    .filter(Boolean);
  return [...new Set(list)].slice(0, 10).join(', ');
}

function parseItems(json) {
  try {
    const a = JSON.parse(json || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** 작성자 본인이거나 실장 이상만 수정·삭제 */
function canEdit(user, row, ownerKey = 'created_by') {
  return row[ownerKey] === user.id || hasRole(user, 'manager');
}

const DOC_SQL = `SELECT d.*, cu.name AS created_name, uu.name AS updated_name
  FROM documents d LEFT JOIN users cu ON cu.id = d.created_by LEFT JOIN users uu ON uu.id = d.updated_by`;

/** 문서 → 화면용 모양 (목록에서는 본문 대신 앞부분 미리보기만) */
function docView(d, user, { full = true } = {}) {
  const out = {
    id: d.id,
    kind: d.doc_kind || '기타',
    title: d.title,
    status: d.status,
    statusLabel: STATUS_LABEL[d.status],
    tags: d.tags ? d.tags.split(/,\s*/).filter(Boolean) : [],
    includeInKb: !!d.include_in_kb,
    createdBy: d.created_by,
    createdName: d.created_name || '(삭제된 사용자)',
    updatedName: d.updated_name || d.created_name || '(삭제된 사용자)',
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    canEdit: canEdit(user, d),
  };
  if (full) out.content = d.content;
  else
    out.excerpt = String(d.content || '')
      .replace(/[#*>`|-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  return out;
}

/** 회의록 → 화면용 모양. 할 일마다 번호(index)와 남은 날(dday)을 붙여 줌 */
function minutesView(d, user, { full = true } = {}) {
  const today = time.today();
  const items = parseItems(d.action_items).map((x, index) => ({
    index,
    task: x.task || '',
    owner: x.owner || '',
    due: x.due || '',
    done: !!x.done,
    dday: x.due && time.isValidDate(x.due) ? time.diffDays(today, x.due) : null,
  }));
  const open = items.filter((x) => !x.done);
  const out = {
    id: d.id,
    title: d.title,
    meetingDate: d.meeting_date,
    attendees: d.attendees ? d.attendees.split(/,\s*/).filter(Boolean) : [],
    summary: d.summary,
    actionItems: items,
    totalCount: items.length,
    doneCount: items.length - open.length,
    overdueCount: open.filter((x) => x.dday !== null && x.dday < 0).length,
    dueSoonCount: open.filter((x) => x.dday !== null && x.dday >= 0 && x.dday <= 7).length,
    createdBy: d.created_by,
    createdName: d.created_name || '(삭제된 사용자)',
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    canEdit: canEdit(user, d),
  };
  if (full) out.content = d.content;
  return out;
}

// ---------- 입력 검사 규칙 ----------

const docSchema = v.object({
  kind: v.enum(DOC_KINDS, { label: '문서 종류' }),
  title: v.string({ min: 1, max: 150, label: '제목' }),
  content: v.string({ max: 60000, optional: true, default: '', label: '내용' }),
  status: v.enum(['draft', 'final'], { optional: true, default: 'draft', label: '상태' }),
  tags: v.string({ max: 300, optional: true, default: '', label: '꼬리표' }),
  includeInKb: v.bool(),
});

/** 참석자: ['이서연','최유나'] 또는 "이서연, 최유나" 둘 다 받음 */
function attendeesCheck(val, field) {
  if (val === undefined || val === null || val === '') return '';
  const list = Array.isArray(val) ? val : String(val).split(/[,，\n]/);
  if (list.length > 40) throw badRequest('참석자: 최대 40명까지 적을 수 있습니다.', { field });
  return [...new Set(list.map((s) => String(s).replace(/[,\u0000-\u001F]/g, '').trim().slice(0, 30)).filter(Boolean))].join(', ');
}

const actionItemSchema = v.object({
  task: v.string({ min: 1, max: 300, label: '할 일' }),
  owner: v.string({ max: 30, optional: true, default: '', label: '담당자' }),
  due: v.date({ optional: true, label: '기한' }),
  done: v.bool(),
});

const minutesSchema = v.object({
  title: v.string({ min: 1, max: 150, label: '회의 제목' }),
  meetingDate: v.date({ label: '회의 날짜' }),
  attendees: attendeesCheck,
  content: v.string({ max: 30000, optional: true, default: '', label: '회의 내용' }),
  summary: v.string({ max: 3000, optional: true, default: '', label: '요약' }),
  actionItems: v.array(actionItemSchema, { optional: true, max: 50, label: '할 일 목록' }),
});

const fileMetaSchema = v.object({
  name: v.string({ min: 1, max: 200, label: '파일 이름' }),
  category: v.enum(FILE_CATEGORIES, { optional: true, default: '기타', label: '분류' }),
  description: v.string({ max: 500, optional: true, default: '', label: '설명' }),
});

// ---------- 파일 도우미 ----------

const EXT_MIME = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', log: 'text/plain', json: 'application/json',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  hwp: 'application/x-hwp', hwpx: 'application/haansofthwpx', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', html: 'text/html', htm: 'text/html', svg: 'image/svg+xml', xml: 'application/xml', js: 'text/javascript',
};
// 브라우저가 열면 스크립트가 실행될 수 있는 종류 → 내려받을 때 "그냥 파일(octet-stream)"로 보냄
const RISKY_EXT = new Set(['html', 'htm', 'xhtml', 'shtml', 'svg', 'svgz', 'js', 'mjs', 'cjs', 'xml', 'xsl', 'xslt', 'hta', 'php']);
const PREVIEW_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
const PREVIEW_TEXT_EXT = new Set(['txt', 'md', 'csv', 'tsv', 'log', 'json']);

function extOf(name) {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : '';
}

/** 파일 이름 정리: 폴더 경로·제어 문자·윈도우에서 못 쓰는 글자 제거 */
function cleanFileName(name) {
  let n = String(name || '').split(/[\\/]/).pop();
  n = n.replace(/[\u0000-\u001F\u007F<>:"|?*]/g, '').replace(/^\.+/, '').trim();
  if (n.length > 200) {
    const ext = extOf(n);
    n = n.slice(0, 200 - (ext ? ext.length + 1 : 0)) + (ext ? '.' + ext : '');
  }
  return n || '이름 없는 파일';
}

/** 저장할 파일 종류(mime) 정하기: 확장자를 우선으로 믿고, 없으면 보낸 값(형식이 맞을 때만) */
function pickMime(name, sent) {
  const byExt = EXT_MIME[extOf(name)];
  if (byExt) return byExt;
  if (typeof sent === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(sent) && sent.length < 120) return sent.toLowerCase();
  return 'application/octet-stream';
}

function isRisky(name, mime) {
  return RISKY_EXT.has(extOf(name)) || /html|xml|javascript|ecmascript|svg/i.test(mime || '');
}

/** base64 글자 검사 후 실제 파일 내용(Buffer)으로. 잘못됐거나 20MB를 넘으면 한국어 안내로 거절 */
function decodeBase64(data) {
  if (typeof data !== 'string' || !data) throw badRequest('파일 내용이 비어 있습니다. 파일을 다시 골라 주세요.', { field: 'data' });
  const s = data.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    throw badRequest('파일 내용이 올바르지 않습니다. 파일을 다시 골라 주세요.', { field: 'data' });
  }
  const bytes = (s.length / 4) * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
  if (bytes > MAX_FILE_BYTES) throw new HttpError(413, '파일이 너무 큽니다. 20MB 이하 파일만 올릴 수 있습니다.', { field: 'data' });
  const buf = Buffer.from(s, 'base64');
  if (!buf.length) throw badRequest('빈 파일은 올릴 수 없습니다.', { field: 'data' });
  return buf;
}

/** Content-Disposition 머리글: 한글 이름도 깨지지 않게 RFC 5987 방식(filename*)을 함께 보냄 */
function contentDisposition(type, name) {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\;]/g, '_') || 'file';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** 글자 파일 읽기: UTF-8이 아니면 한국어 윈도우 기본(EUC-KR)으로 */
function decodeText(buf) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      text = new TextDecoder('euc-kr').decode(buf);
    } catch {
      text = buf.toString('latin1');
    }
  }
  return text.replace(/^\uFEFF/, '');
}

function fileView(f, user) {
  return {
    id: f.id,
    name: f.name,
    mime: f.mime,
    ext: extOf(f.name),
    size: f.size,
    category: f.category,
    description: f.description,
    uploadedBy: f.uploaded_by,
    uploaderName: f.uploader_name || '(삭제된 사용자)',
    createdAt: f.created_at,
    previewable: PREVIEW_IMAGE.has(f.mime) ? 'image' : PREVIEW_TEXT_EXT.has(extOf(f.name)) ? 'text' : null,
    canEdit: canEdit(user, f, 'uploaded_by'),
  };
}

const FILE_SQL = `SELECT f.id, f.name, f.mime, f.size, f.category, f.description, f.uploaded_by, f.created_at, u.name AS uploader_name
  FROM files f LEFT JOIN users u ON u.id = f.uploaded_by`;

// ---------- API ----------

function register(r) {
  // ===== 문서함 =====
  r.get('/docs', (req, res) => {
    const q = req.query;
    const page = Math.max(1, Number(q.page) || 1);
    const size = 30;
    const kind = DOC_KINDS.includes(q.kind) ? q.kind : null;
    const status = q.status === 'draft' || q.status === 'final' ? q.status : null;
    const w = where([
      ["d.type = 'doc'"],
      [kind && 'd.doc_kind = :kind'],
      [status && 'd.status = :status'],
      [q.kb === '1' && 'd.include_in_kb = 1'],
      [q.q && '(d.title LIKE :q OR d.content LIKE :q OR d.tags LIKE :q)'],
    ]);
    const params = { kind, status, q: q.q ? `%${q.q}%` : null, limit: size, offset: (page - 1) * size };
    const total = get(`SELECT COUNT(*) AS n FROM documents d ${w.sql}`, params).n;
    const rows = all(`${DOC_SQL} ${w.sql} ORDER BY d.updated_at DESC LIMIT :limit OFFSET :offset`, params);
    const counts = {};
    for (const c of all("SELECT doc_kind AS kind, COUNT(*) AS n FROM documents WHERE type = 'doc' GROUP BY doc_kind")) counts[c.kind || '기타'] = c.n;
    const all_ = get("SELECT COUNT(*) AS n, SUM(include_in_kb) AS kb FROM documents WHERE type = 'doc'");
    res.json({ rows: rows.map((d) => docView(d, req.user, { full: false })), total, page, size, counts, totalAll: all_.n, kbCount: all_.kb || 0 });
  });

  r.get('/docs/:id', (req, res) => {
    const d = get(`${DOC_SQL} WHERE d.id = ? AND d.type = 'doc'`, idParam(req.params.id));
    if (!d) throw notFound('문서');
    res.json(docView(d, req.user));
  });

  r.post('/docs', (req, res) => {
    const d = docSchema.parse(req.body);
    // AI 도우미 참고 문서 지정은 실장 이상만 (원내 기준 문서를 아무나 바꾸지 못하게)
    if (!hasRole(req.user, 'manager')) d.includeInKb = false;
    const now = time.nowIso();
    const info = run(
      `INSERT INTO documents (type, doc_kind, title, content, status, tags, include_in_kb, created_by, updated_by, created_at, updated_at)
       VALUES ('doc', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.kind, d.title, d.content, d.status, normTags(d.tags), d.includeInKb, req.user.id, req.user.id, now, now
    );
    audit(req, 'create', 'documents', info.lastInsertRowid, `문서 작성(${d.kind}): ${d.title}`);
    res.status(201).json(docView(get(`${DOC_SQL} WHERE d.id = ?`, info.lastInsertRowid), req.user));
  });

  r.patch('/docs/:id', (req, res) => {
    const id = idParam(req.params.id);
    const p = get("SELECT * FROM documents WHERE id = ? AND type = 'doc'", id);
    if (!p) throw notFound('문서');
    if (!canEdit(req.user, p)) throw forbidden();
    const d = docSchema.partial().parse(req.body);
    if ('includeInKb' in d && !hasRole(req.user, 'manager')) {
      if (Object.keys(d).length === 1) throw forbidden();
      delete d.includeInKb;
    }
    run(
      `UPDATE documents SET doc_kind = ?, title = ?, content = ?, status = ?, tags = ?, include_in_kb = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      d.kind ?? p.doc_kind,
      d.title ?? p.title,
      d.content ?? p.content,
      d.status ?? p.status,
      'tags' in d ? normTags(d.tags) : p.tags,
      'includeInKb' in d ? d.includeInKb : p.include_in_kb,
      req.user.id,
      time.nowIso(),
      id
    );
    const extra = 'includeInKb' in d && !!d.includeInKb !== !!p.include_in_kb ? (d.includeInKb ? ' (AI 도우미 참고 켬)' : ' (AI 도우미 참고 끔)') : '';
    audit(req, 'update', 'documents', id, `문서 수정: ${d.title ?? p.title}${extra}`);
    res.json(docView(get(`${DOC_SQL} WHERE d.id = ?`, id), req.user));
  });

  r.delete('/docs/:id', (req, res) => {
    const id = idParam(req.params.id);
    const p = get("SELECT * FROM documents WHERE id = ? AND type = 'doc'", id);
    if (!p) throw notFound('문서');
    if (!canEdit(req.user, p)) throw forbidden();
    run('DELETE FROM documents WHERE id = ?', id);
    audit(req, 'delete', 'documents', id, `문서 삭제: ${p.title}`);
    res.json({ ok: true });
  });

  r.post('/docs/:id/duplicate', (req, res) => {
    const id = idParam(req.params.id);
    const p = get("SELECT * FROM documents WHERE id = ? AND type = 'doc'", id);
    if (!p) throw notFound('문서');
    const now = time.nowIso();
    const title = `${p.title} (사본)`.slice(0, 150);
    // 사본은 "작성 중"으로, AI 도우미 참고는 끈 상태로 시작 (같은 내용이 두 번 검색되지 않게)
    const info = run(
      `INSERT INTO documents (type, doc_kind, title, content, status, tags, include_in_kb, created_by, updated_by, created_at, updated_at)
       VALUES ('doc', ?, ?, ?, 'draft', ?, 0, ?, ?, ?, ?)`,
      p.doc_kind, title, p.content, p.tags, req.user.id, req.user.id, now, now
    );
    audit(req, 'create', 'documents', info.lastInsertRowid, `문서 복제: ${p.title}`);
    res.status(201).json(docView(get(`${DOC_SQL} WHERE d.id = ?`, info.lastInsertRowid), req.user));
  });

  // ===== 회의록 =====
  r.get('/minutes', (req, res) => {
    const q = req.query;
    const page = Math.max(1, Number(q.page) || 1);
    const size = 30;
    const w = where([
      ["d.type = 'minutes'"],
      [q.q && '(d.title LIKE :q OR d.content LIKE :q OR d.summary LIKE :q OR d.attendees LIKE :q OR d.action_items LIKE :q)'],
      [q.open === '1' && `EXISTS (SELECT 1 FROM json_each(d.action_items) j WHERE COALESCE(json_extract(j.value, '$.done'), 0) IN (0, 'false'))`],
    ]);
    const params = { q: q.q ? `%${q.q}%` : null, limit: size, offset: (page - 1) * size };
    const total = get(`SELECT COUNT(*) AS n FROM documents d ${w.sql}`, params).n;
    const rows = all(`${DOC_SQL} ${w.sql} ORDER BY d.meeting_date DESC, d.id DESC LIMIT :limit OFFSET :offset`, params);
    res.json({ rows: rows.map((d) => minutesView(d, req.user, { full: false })), total, page, size });
  });

  r.get('/minutes/:id', (req, res) => {
    const d = get(`${DOC_SQL} WHERE d.id = ? AND d.type = 'minutes'`, idParam(req.params.id));
    if (!d) throw notFound('회의록');
    res.json(minutesView(d, req.user));
  });

  r.post('/minutes', (req, res) => {
    const d = minutesSchema.parse(req.body);
    const now = time.nowIso();
    const items = (d.actionItems || []).map((x) => ({ task: x.task, owner: x.owner || '', due: x.due || '', done: !!x.done }));
    const info = run(
      `INSERT INTO documents (type, title, content, status, meeting_date, attendees, action_items, summary, created_by, updated_by, created_at, updated_at)
       VALUES ('minutes', ?, ?, 'final', ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.title, d.content, d.meetingDate, d.attendees, JSON.stringify(items), d.summary, req.user.id, req.user.id, now, now
    );
    audit(req, 'create', 'documents', info.lastInsertRowid, `회의록 작성: ${d.title} (${d.meetingDate})`);
    res.status(201).json(minutesView(get(`${DOC_SQL} WHERE d.id = ?`, info.lastInsertRowid), req.user));
  });

  r.patch('/minutes/:id', (req, res) => {
    const id = idParam(req.params.id);
    const p = get("SELECT * FROM documents WHERE id = ? AND type = 'minutes'", id);
    if (!p) throw notFound('회의록');
    if (!canEdit(req.user, p)) throw forbidden();
    const d = minutesSchema.partial().parse(req.body);
    const items = d.actionItems ? JSON.stringify(d.actionItems.map((x) => ({ task: x.task, owner: x.owner || '', due: x.due || '', done: !!x.done }))) : p.action_items;
    run(
      `UPDATE documents SET title = ?, content = ?, meeting_date = ?, attendees = ?, action_items = ?, summary = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      d.title ?? p.title,
      d.content ?? p.content,
      d.meetingDate ?? p.meeting_date,
      'attendees' in d ? d.attendees : p.attendees,
      items,
      d.summary ?? p.summary,
      req.user.id,
      time.nowIso(),
      id
    );
    audit(req, 'update', 'documents', id, `회의록 수정: ${d.title ?? p.title}`);
    res.json(minutesView(get(`${DOC_SQL} WHERE d.id = ?`, id), req.user));
  });

  r.delete('/minutes/:id', (req, res) => {
    const id = idParam(req.params.id);
    const p = get("SELECT * FROM documents WHERE id = ? AND type = 'minutes'", id);
    if (!p) throw notFound('회의록');
    if (!canEdit(req.user, p)) throw forbidden();
    run('DELETE FROM documents WHERE id = ?', id);
    audit(req, 'delete', 'documents', id, `회의록 삭제: ${p.title}`);
    res.json({ ok: true });
  });

  // 할 일 하나 완료/해제 — 담당 직원이 목록에서 바로 체크할 수 있도록 누구나 가능
  r.patch('/minutes/:id/actions/:idx', (req, res) => {
    const id = idParam(req.params.id);
    const idx = Number(req.params.idx);
    const p = get("SELECT * FROM documents WHERE id = ? AND type = 'minutes'", id);
    if (!p) throw notFound('회의록');
    const items = parseItems(p.action_items);
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) throw notFound('할 일');
    const done = v.bool()(req.body.done);
    items[idx] = { ...items[idx], done };
    run('UPDATE documents SET action_items = ?, updated_at = ? WHERE id = ?', JSON.stringify(items), time.nowIso(), id);
    audit(req, 'update', 'documents', id, `회의 할 일 ${done ? '완료' : '완료 취소'}: ${items[idx].task}`);
    res.json(minutesView(get(`${DOC_SQL} WHERE d.id = ?`, id), req.user));
  });

  // ===== 서식 보관함 =====
  r.get('/files', (req, res) => {
    const q = req.query;
    const category = FILE_CATEGORIES.includes(q.category) ? q.category : null;
    const w = where([[category && 'f.category = :category'], [q.q && '(f.name LIKE :q OR f.description LIKE :q)']]);
    const rows = all(`${FILE_SQL} ${w.sql} ORDER BY f.created_at DESC, f.id DESC LIMIT 500`, { category, q: q.q ? `%${q.q}%` : null });
    const counts = {};
    for (const c of all('SELECT category, COUNT(*) AS n FROM files GROUP BY category')) counts[c.category] = c.n;
    const sum = get('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files');
    res.json({ rows: rows.map((f) => fileView(f, req.user)), counts, totalAll: sum.n, totalBytes: sum.bytes, maxBytes: MAX_FILE_BYTES, categories: FILE_CATEGORIES });
  });

  r.post('/files', (req, res) => {
    const body = req.body || {};
    const meta = fileMetaSchema.parse({ ...body, name: cleanFileName(body.name) });
    const buf = decodeBase64(body.data);
    const mime = pickMime(meta.name, body.mime);
    const info = run(
      'INSERT INTO files (name, mime, size, data, category, description, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      meta.name, mime, buf.length, new Uint8Array(buf.buffer, buf.byteOffset, buf.length), meta.category, meta.description, req.user.id, time.nowIso()
    );
    audit(req, 'create', 'files', info.lastInsertRowid, `서식 올리기: ${meta.name} (${Math.round(buf.length / 1024)}KB)`);
    res.status(201).json(fileView(get(`${FILE_SQL} WHERE f.id = ?`, info.lastInsertRowid), req.user));
  });

  r.patch('/files/:id', (req, res) => {
    const id = idParam(req.params.id);
    const f = get('SELECT id, name, category, description, uploaded_by FROM files WHERE id = ?', id);
    if (!f) throw notFound('파일');
    if (!canEdit(req.user, f, 'uploaded_by')) throw forbidden();
    const body = { ...req.body };
    if ('name' in body) {
      // 확장자는 바꾸지 못하게 (내려받을 때 파일 종류가 달라지지 않도록)
      let n = cleanFileName(body.name);
      const ext = extOf(f.name);
      if (ext && extOf(n) !== ext) n = `${n}.${ext}`;
      body.name = n;
    }
    const d = fileMetaSchema.partial().parse(body);
    run('UPDATE files SET name = ?, category = ?, description = ? WHERE id = ?', d.name ?? f.name, d.category ?? f.category, d.description ?? f.description, id);
    audit(req, 'update', 'files', id, `서식 정보 수정: ${d.name ?? f.name}`);
    res.json(fileView(get(`${FILE_SQL} WHERE f.id = ?`, id), req.user));
  });

  r.delete('/files/:id', (req, res) => {
    const id = idParam(req.params.id);
    const f = get('SELECT id, name, uploaded_by FROM files WHERE id = ?', id);
    if (!f) throw notFound('파일');
    if (!canEdit(req.user, f, 'uploaded_by')) throw forbidden();
    run('DELETE FROM files WHERE id = ?', id);
    audit(req, 'delete', 'files', id, `서식 삭제: ${f.name}`);
    res.json({ ok: true });
  });

  r.get('/files/:id/download', (req, res) => {
    const f = get('SELECT * FROM files WHERE id = ?', idParam(req.params.id));
    if (!f) throw notFound('파일');
    // 위험한 종류(html, svg, js…)는 브라우저가 열어 실행하지 않도록 "그냥 파일"로 보냄
    const type = isRisky(f.name, f.mime) ? 'application/octet-stream' : f.mime || 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', contentDisposition('attachment', f.name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Length', String(f.data.length));
    res.end(Buffer.from(f.data));
  });

  r.get('/files/:id/preview', (req, res) => {
    const f = get('SELECT * FROM files WHERE id = ?', idParam(req.params.id));
    if (!f) throw notFound('파일');
    if (PREVIEW_IMAGE.has(f.mime) && !isRisky(f.name, f.mime)) {
      res.setHeader('Content-Type', f.mime);
      res.setHeader('Content-Disposition', contentDisposition('inline', f.name));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      return res.end(Buffer.from(f.data));
    }
    if (PREVIEW_TEXT_EXT.has(extOf(f.name))) {
      const LIMIT = 200 * 1024; // 미리보기는 앞부분 200KB만
      const buf = Buffer.from(f.data);
      return res.json({ kind: 'text', ext: extOf(f.name), text: decodeText(buf.subarray(0, LIMIT)), truncated: buf.length > LIMIT });
    }
    throw badRequest('이 파일은 미리보기를 지원하지 않습니다. 내려받아서 열어 주세요.');
  });
}

// ---------- 대시보드 ----------

/** 담당자 칸에 내 이름이 있거나 "전원/모두"면 내 할 일로 봄 */
function isMine(owner, user) {
  const o = String(owner || '').trim();
  if (!o) return false;
  if (/^(전원|전체|모두|전 직원)$/.test(o)) return true;
  return !!user.name && o.includes(user.name);
}

function dashboard(user) {
  const today = time.today();
  const rows = all("SELECT id, title, action_items FROM documents WHERE type = 'minutes' AND action_items NOT IN ('', '[]') ORDER BY meeting_date DESC LIMIT 200");
  const todos = [];
  const upcoming = [];
  const others = [];
  for (const m of rows) {
    parseItems(m.action_items).forEach((x, i) => {
      if (x.done || !x.due || !time.isValidDate(x.due)) return;
      const days = time.diffDays(today, x.due);
      if (isMine(x.owner, user)) {
        if (days <= 7) {
          todos.push({
            id: `minutes-${m.id}-${i}`,
            module: 'documents',
            title: `회의 할 일: ${x.task}`,
            detail: `${m.title} · ${days < 0 ? `${-days}일 지남` : days === 0 ? '오늘까지' : `${days}일 남음`}`,
            href: `#/minutes/${m.id}`,
            level: days < 0 ? 'danger' : days <= 2 ? 'warn' : 'info',
            icon: 'notebook-pen',
            _days: days,
          });
        } else if (days <= 30) {
          upcoming.push({ id: `minutes-${m.id}-${i}`, module: 'documents', title: `회의 할 일: ${x.task}`, date: x.due, dday: days, detail: m.title, href: `#/minutes/${m.id}`, icon: 'notebook-pen' });
        }
      } else if (days <= 7) {
        others.push({ owner: x.owner, days });
      }
    });
  }
  todos.sort((a, b) => a._days - b._days);
  todos.forEach((t) => delete t._days);
  // 실장 이상에게는 다른 직원의 기한 지남·임박 할 일을 한 줄로 요약
  if (hasRole(user, 'manager') && others.length) {
    const overdue = others.filter((o) => o.days < 0).length;
    const owners = [...new Set(others.map((o) => o.owner).filter(Boolean))];
    todos.push({
      id: 'minutes-others',
      module: 'documents',
      title: `직원 회의 할 일 ${others.length}건 마감 임박${overdue ? ` (기한 지남 ${overdue}건)` : ''}`,
      detail: owners.length ? `담당: ${owners.slice(0, 3).join(', ')}${owners.length > 3 ? ` 외 ${owners.length - 3}명` : ''}` : '담당자 미정',
      href: '#/minutes?open=1',
      level: overdue ? 'warn' : 'info',
      icon: 'notebook-pen',
    });
  }
  return { todos, upcoming };
}

module.exports = {
  name: 'documents',
  migrations,
  register,
  aiFeatures,
  seed,
  dashboard,
  resetTables: ['files', 'documents'],
};
