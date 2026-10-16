/*
 * 이 파일이 하는 일: [A. 데스크] 공지·인수인계 보드의 서버 기능입니다. (다른 모듈을 만들 때 본보기로 삼는 모듈)
 *
 *   - 공지(notice): 실장·원장이 작성. 위에 고정(pinned) 가능. 중요도(일반/중요/긴급).
 *   - 인수인계(handover): 누구나 작성. 다음 근무자에게 넘길 일.
 *   - 읽음 확인: 글을 열면 읽음으로 기록되고, 누가 아직 안 읽었는지 볼 수 있습니다.
 *   - AI: 대충 적은 메모를 깔끔한 공지/인수인계 글로 다듬어 줍니다. (board.polish)
 *
 * API (/api/board/...)
 *   GET    /posts            목록 (kind, q, page, archived)
 *   GET    /posts/:id        상세 + 읽은 사람/안 읽은 사람
 *   POST   /posts            작성
 *   PATCH  /posts/:id        수정 (작성자 또는 실장 이상)
 *   DELETE /posts/:id        삭제 (작성자 또는 실장 이상)
 *   POST   /posts/:id/read   읽음 표시
 */
const { all, get, run, tx, where } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, forbidden } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { hasRole } = require('../../core/auth');
const time = require('../../core/time');

const KIND_LABEL = { notice: '공지', handover: '인수인계' };
const IMPORTANCE = ['normal', 'important', 'urgent'];

const migrations = [
  {
    id: 'board_001',
    up: `
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('notice','handover')),
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        importance TEXT NOT NULL DEFAULT 'normal' CHECK (importance IN ('normal','important','urgent')),
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        due_date TEXT,                           -- (인수인계) 언제까지 확인/처리할 일인지
        author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_posts_kind ON posts(kind, archived, created_at);
      CREATE TABLE post_reads (
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        read_at TEXT NOT NULL,
        PRIMARY KEY (post_id, user_id)
      );
    `,
  },
];

const postSchema = v.object({
  kind: v.enum(['notice', 'handover'], { label: '종류' }),
  title: v.string({ min: 1, max: 120, label: '제목' }),
  body: v.string({ max: 10000, optional: true, default: '', label: '내용' }),
  importance: v.enum(IMPORTANCE, { optional: true, default: 'normal', label: '중요도' }),
  pinned: v.bool(),
  dueDate: v.date({ optional: true, label: '확인 기한' }),
});

/** 목록·상세에서 공통으로 쓰는 모양으로 바꾸기 */
function toView(p, userId) {
  return {
    id: p.id,
    kind: p.kind,
    kindLabel: KIND_LABEL[p.kind],
    title: p.title,
    body: p.body,
    importance: p.importance,
    pinned: !!p.pinned,
    archived: !!p.archived,
    dueDate: p.due_date,
    authorId: p.author_id,
    authorName: p.author_name || '(삭제된 사용자)',
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    readCount: p.read_count ?? 0,
    readByMe: !!p.read_by_me,
    mine: p.author_id === userId,
  };
}

const LIST_SQL = `
  SELECT p.*, u.name AS author_name,
    (SELECT COUNT(*) FROM post_reads r WHERE r.post_id = p.id) AS read_count,
    EXISTS (SELECT 1 FROM post_reads r WHERE r.post_id = p.id AND r.user_id = :me) AS read_by_me
  FROM posts p LEFT JOIN users u ON u.id = p.author_id`;

/** 작성자 본인이거나 실장 이상만 수정·삭제 가능 */
function canEdit(user, post) {
  return post.author_id === user.id || hasRole(user, 'manager');
}

function register(r) {
  r.get('/posts', (req, res) => {
    const q = req.query;
    const kind = q.kind === 'notice' || q.kind === 'handover' ? q.kind : null;
    const page = Math.max(1, Number(q.page) || 1);
    const size = 30;
    const w = where([
      [kind && 'p.kind = :kind'],
      [q.archived === '1' ? 'p.archived = 1' : 'p.archived = 0'],
      [q.q && '(p.title LIKE :q OR p.body LIKE :q)'],
      [q.unread === '1' && 'NOT EXISTS (SELECT 1 FROM post_reads r WHERE r.post_id = p.id AND r.user_id = :me)'],
    ]);
    const params = { me: req.user.id, kind, q: q.q ? `%${q.q}%` : null, limit: size, offset: (page - 1) * size };
    const total = get(`SELECT COUNT(*) AS n FROM posts p ${w.sql}`, params).n;
    const rows = all(`${LIST_SQL} ${w.sql} ORDER BY p.pinned DESC, p.created_at DESC LIMIT :limit OFFSET :offset`, params);
    const activeUsers = get("SELECT COUNT(*) AS n FROM users WHERE status = 'active'").n;
    res.json({ rows: rows.map((p) => toView(p, req.user.id)), total, page, size, activeUsers });
  });

  r.get('/posts/:id', (req, res) => {
    const id = idParam(req.params.id);
    const p = get(`${LIST_SQL} WHERE p.id = :id`, { id, me: req.user.id });
    if (!p) throw notFound('글');
    const readers = all(
      `SELECT u.id, u.name, u.job_title AS jobTitle, r.read_at AS readAt FROM post_reads r JOIN users u ON u.id = r.user_id
       WHERE r.post_id = ? ORDER BY r.read_at`,
      id
    );
    const unread = all(
      `SELECT id, name, job_title AS jobTitle FROM users WHERE status = 'active'
       AND id NOT IN (SELECT user_id FROM post_reads WHERE post_id = ?) ORDER BY id`,
      id
    );
    res.json({ ...toView(p, req.user.id), readers, unread, canEdit: canEdit(req.user, p) });
  });

  r.post('/posts', (req, res) => {
    const d = postSchema.parse(req.body);
    // 공지와 상단 고정은 실장 이상만
    if (d.kind === 'notice' && !hasRole(req.user, 'manager')) throw forbidden();
    if (d.pinned && !hasRole(req.user, 'manager')) d.pinned = false;
    const now = time.nowIso();
    const id = tx(() => {
      const info = run(
        `INSERT INTO posts (kind, title, body, importance, pinned, due_date, author_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        d.kind,
        d.title,
        d.body,
        d.importance,
        d.pinned,
        d.dueDate,
        req.user.id,
        now,
        now
      );
      // 작성자는 자동으로 읽음 처리
      run('INSERT INTO post_reads (post_id, user_id, read_at) VALUES (?, ?, ?)', info.lastInsertRowid, req.user.id, now);
      return info.lastInsertRowid;
    });
    audit(req, 'create', 'posts', id, `${KIND_LABEL[d.kind]} 작성: ${d.title}`);
    res.status(201).json(toView(get(`${LIST_SQL} WHERE p.id = :id`, { id, me: req.user.id }), req.user.id));
  });

  r.patch('/posts/:id', (req, res) => {
    const id = idParam(req.params.id);
    const p = get('SELECT * FROM posts WHERE id = ?', id);
    if (!p) throw notFound('글');
    if (!canEdit(req.user, p)) throw forbidden();
    const d = postSchema.partial().parse(req.body);
    if ('pinned' in d && !hasRole(req.user, 'manager')) delete d.pinned;
    if (d.kind === 'notice' && !hasRole(req.user, 'manager')) throw forbidden();
    const archived = req.body.archived === undefined ? p.archived : v.bool()(req.body.archived);
    run(
      `UPDATE posts SET kind = ?, title = ?, body = ?, importance = ?, pinned = ?, due_date = ?, archived = ?, updated_at = ? WHERE id = ?`,
      d.kind ?? p.kind,
      d.title ?? p.title,
      d.body ?? p.body,
      d.importance ?? p.importance,
      'pinned' in d ? d.pinned : p.pinned,
      'dueDate' in d ? d.dueDate : p.due_date,
      archived,
      time.nowIso(),
      id
    );
    audit(req, 'update', 'posts', id, `글 수정: ${d.title ?? p.title}${archived !== p.archived ? (archived ? ' (보관)' : ' (보관 해제)') : ''}`);
    res.json(toView(get(`${LIST_SQL} WHERE p.id = :id`, { id, me: req.user.id }), req.user.id));
  });

  r.delete('/posts/:id', (req, res) => {
    const id = idParam(req.params.id);
    const p = get('SELECT * FROM posts WHERE id = ?', id);
    if (!p) throw notFound('글');
    if (!canEdit(req.user, p)) throw forbidden();
    run('DELETE FROM posts WHERE id = ?', id);
    audit(req, 'delete', 'posts', id, `글 삭제: ${p.title}`);
    res.json({ ok: true });
  });

  r.post('/posts/:id/read', (req, res) => {
    const id = idParam(req.params.id);
    if (!get('SELECT id FROM posts WHERE id = ?', id)) throw notFound('글');
    run('INSERT OR IGNORE INTO post_reads (post_id, user_id, read_at) VALUES (?, ?, ?)', id, req.user.id, time.nowIso());
    res.json({ ok: true });
  });
}

// ---------- AI 기능 ----------
const aiFeatures = [
  {
    key: 'board.polish',
    label: '공지·인수인계 글 다듬기',
    group: '데스크',
    tier: 'fast',
    maxTokens: 900,
    input: v.object({
      kind: v.enum(['notice', 'handover'], { label: '종류' }),
      text: v.string({ min: 2, max: 3000, label: '메모' }),
    }),
    build(input, ctx) {
      const what = input.kind === 'notice' ? '직원 대상 원내 공지' : '다음 근무자에게 넘기는 인수인계';
      return {
        prompt: [
          `아래 메모를 ${what} 글로 다듬어 주세요.`,
          '형식:',
          '첫 줄: "제목: (20자 이내 제목)"',
          '빈 줄 다음에 본문. 본문은 핵심을 먼저, 할 일은 "- " 목록으로, 날짜·시간·담당자는 메모에 있는 그대로 유지.',
          '메모에 없는 사실은 추가하지 마세요.',
          '',
          '[메모]',
          input.text,
        ].join('\n'),
      };
    },
    demo(input) {
      const lines = input.text
        .split(/\n|(?<=[.!?。])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const first = lines[0] || input.text;
      const title = (input.kind === 'notice' ? '[공지] ' : '[인수인계] ') + first.replace(/[.!?]$/, '').slice(0, 18);
      return [
        `제목: ${title}`,
        '',
        input.kind === 'notice' ? '안녕하세요, 원내 공지 드립니다.' : '다음 근무자분께 전달드립니다.',
        '',
        ...lines.map((l) => `- ${l.replace(/[.]$/, '')}`),
        '',
        input.kind === 'notice' ? '확인 후 읽음 표시 부탁드립니다.' : '처리 후 보드에 완료 표시 부탁드립니다.',
        '',
        '(데모 모드 예시입니다. AI 키를 넣으면 실제 AI가 문장을 다듬습니다.)',
      ].join('\n');
    },
    parse(text) {
      const m = text.match(/^\s*제목\s*[:：]\s*(.+)\s*\n([\s\S]*)$/);
      if (!m) return { title: '', body: text.trim() };
      return { title: m[1].trim().slice(0, 120), body: m[2].trim() };
    },
  },
];

// ---------- 대시보드 ----------
function dashboard(user) {
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  const rows = all(
    `${LIST_SQL} WHERE p.archived = 0 AND (p.pinned = 1 OR p.created_at >= :since) ORDER BY p.pinned DESC, p.created_at DESC LIMIT 6`,
    { me: user.id, since }
  );
  const unreadImportant = get(
    `SELECT COUNT(*) AS n FROM posts p WHERE p.archived = 0 AND p.importance != 'normal'
     AND NOT EXISTS (SELECT 1 FROM post_reads r WHERE r.post_id = p.id AND r.user_id = ?)`,
    user.id
  ).n;
  const handoversDue = all(
    `SELECT id, title, due_date FROM posts WHERE kind = 'handover' AND archived = 0 AND due_date IS NOT NULL AND due_date <= ? ORDER BY due_date LIMIT 5`,
    time.today()
  );
  const todos = [];
  if (unreadImportant > 0) {
    todos.push({ id: 'board-unread', module: 'board', title: `안 읽은 중요 공지 ${unreadImportant}건`, href: '#/board?unread=1', level: 'warn' });
  }
  for (const h of handoversDue) {
    todos.push({ id: `handover-${h.id}`, module: 'board', title: `인수인계: ${h.title}`, detail: h.due_date < time.today() ? '기한 지남' : '오늘까지', href: `#/board/${h.id}`, level: h.due_date < time.today() ? 'danger' : 'warn' });
  }
  return {
    notices: rows.map((p) => ({
      id: p.id,
      kind: p.kind,
      kindLabel: KIND_LABEL[p.kind],
      title: p.title,
      pinned: !!p.pinned,
      importance: p.importance,
      author: p.author_name,
      createdAt: p.created_at,
      unread: !p.read_by_me,
      href: `#/board/${p.id}`,
    })),
    todos,
  };
}

// ---------- 데모 데이터 ----------
function seed(ctx) {
  const { users, today } = ctx;
  const at = (daysAgo, h = 9) => {
    const d = time.parseDate(time.addDays(today, -daysAgo));
    d.setHours(h, 10);
    return d.toISOString();
  };
  const posts = [
    ['notice', '11월 진료시간 변경 안내 (매주 목요일 야간진료)', '11월부터 매주 목요일은 20:00까지 야간진료를 합니다.\n\n- 야간 근무는 근무표에서 확인해 주세요.\n- 전화 응대 시 변경된 진료시간으로 안내 부탁드립니다.\n- 홈페이지·안내 문자 문구는 실장님이 수정 예정입니다.', 'important', 1, users.admin, 1],
    ['notice', '감염관리 자체 점검 결과 공유', '지난주 자체 점검 결과 대부분 양호했습니다.\n\n개선할 점\n- 진료실 소독제 개봉일 표기 누락 2건 → 개봉일 꼭 적어 주세요.\n- 멸균 파우치 보관함 문 닫아 두기\n\n다음 점검은 다음 달 첫째 주입니다.', 'normal', 0, users.manager, 3],
    ['notice', '연말 연차 사용 계획 제출 요청', '올해 남은 연차 사용 계획을 이번 달 말까지 연차·휴가 메뉴에서 신청해 주세요. 진료 일정 조정을 위해 겹치는 날은 협의 부탁드립니다.', 'normal', 0, users.manager, 6],
    ['handover', '기공소 보철물 도착 확인 필요', '오후 4시쯤 기공소 택배 도착 예정입니다.\n- 도착하면 기공물 보관함에 넣고 보드에 완료 댓글\n- 미도착 시 내일 오전 기공소에 전화 확인', 'important', 0, users.hyg1, 0],
    ['handover', '2번 유니트체어 석션 약함', '오전 진료 중 2번 체어 석션 흡입력이 약했습니다. 필터 청소 후에도 같으면 장비 점검 이력에 기록하고 업체 AS 요청 부탁드립니다.', 'urgent', 0, users.hyg2, 1],
  ];
  for (const [kind, title, body, importance, pinned, author, daysAgo] of posts) {
    const created = at(daysAgo);
    const info = run(
      `INSERT INTO posts (kind, title, body, importance, pinned, due_date, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      kind,
      title,
      body,
      importance,
      pinned,
      kind === 'handover' ? today : null,
      author,
      created,
      created
    );
    // 일부 직원은 읽은 것으로
    for (const uid of [author, users.manager, users.hyg1].filter(Boolean)) {
      run('INSERT OR IGNORE INTO post_reads (post_id, user_id, read_at) VALUES (?, ?, ?)', info.lastInsertRowid, uid, created);
    }
  }
}

module.exports = {
  name: 'board',
  migrations,
  register,
  aiFeatures,
  dashboard,
  seed,
  resetTables: ['post_reads', 'posts'],
};
