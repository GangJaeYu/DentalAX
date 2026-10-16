/*
 * 이 파일이 하는 일: [A. 데스크] 소통 도우미의 서버 기능입니다.
 *
 *   1) 전화 응대 스크립트 보관함 (call_scripts): 진료시간·주차·예약 변경 등 상황별 응대 문구. AI로 만들어 저장 가능
 *   2) 리뷰 답글: AI 초안 + "주의 표현 검사"(규칙 기반, rules.js). 리뷰 원문과 답글은 DB에 저장하지 않습니다.
 *   3) 문자·안내문 템플릿 (message_templates): {이름} {날짜} {시간} 같은 변수가 들어간 안내 문구
 *
 *   누구나 만들 수 있고, 고치기·지우기는 만든 사람 또는 실장 이상만 할 수 있습니다.
 *   환자 정보는 저장하지 않습니다. (템플릿에는 변수만 두고 실제 이름·번호는 넣지 않도록 안내)
 *
 * API (/api/comms/...)
 *   GET    /meta                       분류 목록, 변수 목록, 미리보기 예시 값
 *   GET    /scripts?q=&category=       스크립트 목록 (+ 분류별 개수)
 *   POST   /scripts                    스크립트 저장
 *   PATCH  /scripts/:id                스크립트 수정
 *   DELETE /scripts/:id                스크립트 삭제
 *   GET    /templates?q=&category=     문자 템플릿 목록 (+ 분류별 개수, 바이트 수)
 *   POST   /templates                  템플릿 저장
 *   PATCH  /templates/:id              템플릿 수정
 *   DELETE /templates/:id              템플릿 삭제
 *   POST   /check-reply                답글 주의 표현 검사 { text } → { ok, warnings, counts } (저장하지 않음)
 */
const { all, get, run } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, forbidden } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { hasRole } = require('../../core/auth');
const { getSetting } = require('../../core/settings');
const time = require('../../core/time');
const { checkReply, smsBytes, smsKind, listVars, fillVars } = require('./rules');
const { aiFeatures, SCRIPT_CATEGORIES, MESSAGE_CATEGORIES, TONES, VARIABLES, sampleValues } = require('./ai');
const { seed, starter } = require('./seed');

const migrations = [
  {
    id: 'comms_001',
    up: `
      CREATE TABLE call_scripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '기타',
        body TEXT NOT NULL DEFAULT '',
        author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_call_scripts_cat ON call_scripts(category);
      CREATE TABLE message_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '기타',
        body TEXT NOT NULL DEFAULT '',
        author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_message_templates_cat ON message_templates(category);
    `,
  },
];

const scriptSchema = v.object({
  title: v.string({ min: 1, max: 80, label: '제목' }),
  category: v.enum(SCRIPT_CATEGORIES, { optional: true, default: '기타', label: '분류' }),
  body: v.string({ min: 1, max: 8000, label: '내용' }),
});
const templateSchema = v.object({
  title: v.string({ min: 1, max: 80, label: '제목' }),
  category: v.enum(MESSAGE_CATEGORIES, { optional: true, default: '기타', label: '분류' }),
  body: v.string({ min: 1, max: 2000, label: '문구' }),
});

function canEdit(user, row) {
  return row.author_id === user.id || hasRole(user, 'manager');
}

/**
 * 화면으로 보낼 모양. 문자 템플릿은 바이트 수도 함께 계산합니다.
 * (실제로 보낼 때처럼 변수를 예시 값으로 채운 기준 — 화면 미리보기와 같은 숫자가 나오게)
 */
function toView(row, user, kind, sample) {
  const out = {
    id: row.id,
    title: row.title,
    category: row.category,
    body: row.body,
    authorId: row.author_id,
    authorName: row.author_name || '(삭제된 사용자)',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canEdit: canEdit(user, row),
  };
  if (kind === 'template') {
    const bytes = smsBytes(fillVars(row.body, sample || {}));
    out.bytes = bytes;
    out.smsKind = smsKind(bytes).kind;
    out.vars = listVars(row.body);
  }
  return out;
}

/**
 * 스크립트·템플릿은 모양이 같아서 같은 함수로 API를 만듭니다.
 * @param table 표 이름, base 주소, label 화면에 보일 이름, schema 입력 검사, cats 분류 목록
 */
function crud(r, { table, base, label, schema, cats, kind }) {
  const SELECT = `SELECT x.*, u.name AS author_name FROM ${table} x LEFT JOIN users u ON u.id = x.author_id`;
  const one = (id) => get(`${SELECT} WHERE x.id = ?`, id);
  const sample = () => (kind === 'template' ? sampleValues(getSetting('clinic')) : null);

  r.get(base, (req, res) => {
    const q = String(req.query.q || '').trim();
    const category = cats.includes(req.query.category) ? req.query.category : null;
    const params = { q: q ? `%${q}%` : null, category };
    const conds = [q && '(x.title LIKE :q OR x.body LIKE :q)', category && 'x.category = :category'].filter(Boolean);
    const rows = all(`${SELECT} ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY x.updated_at DESC, x.id DESC LIMIT 300`, params);
    // 분류별 개수 (검색어만 반영 — 분류 칩 옆 숫자)
    const counts = all(`SELECT category, COUNT(*) AS n FROM ${table} x ${q ? 'WHERE (x.title LIKE :q OR x.body LIKE :q)' : ''} GROUP BY category`, params);
    const smp = sample();
    res.json({
      rows: rows.map((x) => toView(x, req.user, kind, smp)),
      total: rows.length,
      counts: Object.fromEntries(counts.map((c) => [c.category, c.n])),
    });
  });

  r.post(base, (req, res) => {
    const d = schema.parse(req.body);
    const now = time.nowIso();
    const info = run(`INSERT INTO ${table} (title, category, body, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, d.title, d.category, d.body, req.user.id, now, now);
    audit(req, 'create', table, info.lastInsertRowid, `${label} 저장: ${d.title}`);
    res.status(201).json(toView(one(info.lastInsertRowid), req.user, kind, sample()));
  });

  r.patch(`${base}/:id`, (req, res) => {
    const id = idParam(req.params.id);
    const row = get(`SELECT * FROM ${table} WHERE id = ?`, id);
    if (!row) throw notFound(label);
    if (!canEdit(req.user, row)) throw forbidden();
    const d = schema.partial().parse(req.body);
    run(`UPDATE ${table} SET title = ?, category = ?, body = ?, updated_at = ? WHERE id = ?`, d.title ?? row.title, d.category ?? row.category, d.body ?? row.body, time.nowIso(), id);
    audit(req, 'update', table, id, `${label} 수정: ${d.title ?? row.title}`);
    res.json(toView(one(id), req.user, kind, sample()));
  });

  r.delete(`${base}/:id`, (req, res) => {
    const id = idParam(req.params.id);
    const row = get(`SELECT * FROM ${table} WHERE id = ?`, id);
    if (!row) throw notFound(label);
    if (!canEdit(req.user, row)) throw forbidden();
    run(`DELETE FROM ${table} WHERE id = ?`, id);
    audit(req, 'delete', table, id, `${label} 삭제: ${row.title}`);
    res.json({ ok: true });
  });
}

function register(r) {
  r.get('/meta', (req, res) => {
    const clinic = getSetting('clinic');
    res.json({
      scriptCategories: SCRIPT_CATEGORIES,
      messageCategories: MESSAGE_CATEGORIES,
      tones: TONES,
      variables: VARIABLES,
      sample: sampleValues(clinic),
      // 스크립트에 쓰이는 병원 정보가 비어 있는지 화면에서 알려 주기 위함
      clinic: { name: clinic.name, phone: clinic.phone, address: clinic.address, hours: clinic.hours, parking: clinic.parking, directions: clinic.directions, insuranceNote: clinic.insuranceNote },
    });
  });

  crud(r, { table: 'call_scripts', base: '/scripts', label: '응대 스크립트', schema: scriptSchema, cats: SCRIPT_CATEGORIES, kind: 'script' });
  crud(r, { table: 'message_templates', base: '/templates', label: '문자 템플릿', schema: templateSchema, cats: MESSAGE_CATEGORIES, kind: 'template' });

  // 답글 주의 표현 검사 — 글은 저장하지 않고 결과만 돌려줌
  r.post('/check-reply', (req, res) => {
    const { text } = v.object({ text: v.string({ max: 3000, optional: true, default: '', label: '답글' }) }).parse(req.body);
    res.json(checkReply(text));
  });
}

module.exports = {
  name: 'comms',
  migrations,
  register,
  aiFeatures,
  seed,
  starter,
  resetTables: ['call_scripts', 'message_templates'],
};
