/*
 * 이 파일이 하는 일: [F. 운영 지표] 지출 기록·분류·월별 요약 API 입니다. (모든 기능은 실장 이상만)
 *
 *   - 환자와 연결된 매출(진료비 등)은 다루지 않습니다. 병원이 "쓴 돈(지출)"만 기록합니다.
 *   - 분류(재료비, 기공료 …)마다 색과 "키워드"를 두고, 카드 내역을 가져올 때 키워드로 분류를 자동 추천합니다.
 *   - 월별 요약: 이번 달 합계, 전월 대비(이번 달이면 "지난달 같은 기간"과 비교), 분류별 비중, 12개월 추이, 많이 쓴 곳.
 *
 * API (/api/expenses/...)
 *   GET    /categories             분류 목록 (+ 건수)
 *   POST   /categories             분류 추가
 *   PATCH  /categories/:id         분류 수정·보관
 *   DELETE /categories/:id         분류 삭제 (쓰인 적 없는 것만)
 *   GET    /items                  지출 목록 (month, categoryId, method, q, page) + 합계
 *   POST   /items                  지출 추가
 *   PATCH  /items/:id              지출 수정
 *   DELETE /items/:id              지출 삭제
 *   GET    /export.csv             CSV 내보내기 (목록과 같은 조건)
 *   POST   /import/preview         CSV·카드 내역 글 → 미리보기 (분류 추천, 중복 표시)
 *   POST   /import/commit          미리보기에서 고른 줄 저장
 *   GET    /summary                월별 요약 (month)
 */
const { all, get, run, tx, where } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, badRequest, HttpError } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { requireRole, hasRole } = require('../../core/auth');
const { toCsv, sendCsv } = require('../../core/csv');
const time = require('../../core/time');
const rules = require('./rules');
const { aiFeatures } = require('./ai');
const { seed } = require('./seed');

/** 거래처 표(재고 모듈이 만듦)가 있는지 */
function hasVendors() {
  try {
    return !!get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'vendors'");
  } catch {
    return false;
  }
}

const migrations = [
  {
    id: 'expenses_001',
    // 거래처 표가 있을 때만 "거래처가 지워지면 비움" 연결을 겁니다. (표를 만드는 순간에 확인하려고 getter 사용)
    get up() {
      const vendorRef = hasVendors() ? ' REFERENCES vendors(id) ON DELETE SET NULL' : '';
      return `
      CREATE TABLE expense_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL DEFAULT '#94a3b8',
        sort INTEGER NOT NULL DEFAULT 0,
        keywords TEXT NOT NULL DEFAULT '',        -- 자동 분류용 키워드 (쉼표로 구분)
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        category_id INTEGER NOT NULL REFERENCES expense_categories(id),
        vendor_id INTEGER${vendorRef},
        payee TEXT NOT NULL DEFAULT '',           -- 지급처 (가맹점·업체 이름)
        description TEXT,
        amount INTEGER NOT NULL,                  -- 원 단위 (취소·환불은 음수)
        payment_method TEXT NOT NULL DEFAULT '카드' CHECK (payment_method IN ('카드','계좌이체','현금','자동이체','기타')),
        memo TEXT,
        source TEXT NOT NULL DEFAULT 'manual',     -- manual(직접 입력) / import(가져오기) / demo
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_expenses_date ON expenses(date);
      CREATE INDEX idx_expenses_cat ON expenses(category_id, date);
    `;
    },
  },
];

// 처음 넣어 두는 분류 (색은 밝은·어두운 화면 모두에서 구분되는 중간 밝기)
const DEFAULT_CATEGORIES = [
  ['재료비', '#3b82f6', '덴탈, 메디칼, 치과재료, 재료상, 임플란트, 레진, 인상재, 본이식, 멤브레인, 글러브, 소독제'],
  ['기공료', '#8b5cf6', '기공소, 기공, 덴탈랩'],
  ['인건비', '#0ea5e9', '급여, 상여, 수당, 인건비, 아르바이트, 퇴직'],
  ['임대료', '#f59e0b', '임대료, 월세, 임대인'],
  ['관리비·공과금', '#14b8a6', '관리비, 관리사무소, 전기요금, 수도요금, 도시가스, 가스요금, 통신, 인터넷, 전화요금'],
  ['장비·유지보수', '#64748b', '유지보수, 수리, AS센터, 렌탈, 리스, 장비, 설비'],
  ['마케팅·광고', '#ec4899', '광고, 마케팅, 홍보, 블로그, 검색광고, 전단, 현수막, 인쇄'],
  ['사무·소모품', '#84cc16', '사무용품, 문구, 다이소, 오피스, 토너, 복사지, 생활용품, 온라인몰'],
  ['세금·보험', '#ef4444', '세금, 국세, 지방세, 원천세, 부가세, 보험, 국민연금, 건강보험, 고용보험, 산재, 4대보험'],
  ['복리후생', '#f97316', '식대, 식당, 카페, 커피, 회식, 간식, 배달, 경조사, 베이커리, 도시락'],
  ['기타', '#94a3b8', '수수료'],
];

const itemSchema = v.object({
  date: v.date({ label: '날짜' }),
  categoryId: v.id({ label: '분류' }),
  vendorId: v.id({ optional: true, label: '거래처' }),
  payee: v.string({ min: 1, max: 100, label: '지급처' }),
  description: v.string({ max: 200, optional: true, label: '내용' }),
  amount: v.int({ min: -1000000000, max: 1000000000, label: '금액' }),
  paymentMethod: v.enum(rules.PAYMENT_METHODS, { optional: true, default: '카드', label: '결제 수단' }),
  memo: v.string({ max: 1000, optional: true, label: '메모' }),
});

const categorySchema = v.object({
  name: v.string({ min: 1, max: 30, label: '분류 이름' }),
  color: v.string({ optional: true, default: '#94a3b8', pattern: /^#[0-9a-fA-F]{6}$/, patternMessage: '#RRGGBB 형식으로 골라 주세요.', label: '색' }),
  keywords: v.string({ max: 1000, optional: true, default: '', label: '키워드' }),
  sort: v.int({ min: 0, max: 999, optional: true, label: '순서' }),
});

function itemSql() {
  const vend = hasVendors();
  return `SELECT x.*, c.name AS category_name, c.color AS category_color, u.name AS created_by_name, ${vend ? 'vd.name' : 'NULL'} AS vendor_name
    FROM expenses x
    LEFT JOIN expense_categories c ON c.id = x.category_id
    LEFT JOIN users u ON u.id = x.created_by
    ${vend ? 'LEFT JOIN vendors vd ON vd.id = x.vendor_id' : ''}`;
}

function toView(x) {
  return {
    id: x.id,
    date: x.date,
    categoryId: x.category_id,
    categoryName: x.category_name,
    categoryColor: x.category_color,
    vendorId: x.vendor_id,
    vendorName: x.vendor_name || null,
    payee: x.payee,
    description: x.description,
    amount: x.amount,
    paymentMethod: x.payment_method,
    memo: x.memo,
    source: x.source,
    createdByName: x.created_by_name || null,
    createdAt: x.created_at,
    updatedAt: x.updated_at,
  };
}

function loadOne(id) {
  const x = get(`${itemSql()} WHERE x.id = ?`, id);
  if (!x) throw notFound('지출');
  return x;
}

function checkCategory(id) {
  const c = get('SELECT id, name FROM expense_categories WHERE id = ?', id);
  if (!c) throw badRequest('분류: 선택한 분류를 찾을 수 없습니다.', { field: 'categoryId' });
  return c;
}

function checkVendor(id) {
  if (!id) return null;
  if (!hasVendors() || !get('SELECT id FROM vendors WHERE id = ?', id)) throw badRequest('거래처: 선택한 거래처를 찾을 수 없습니다.', { field: 'vendorId' });
  return id;
}

function validMonth(m) {
  return typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m : null;
}

/** 목록·내보내기에서 같이 쓰는 조건 */
function listWhere(q) {
  const month = validMonth(q.month);
  const categoryId = Number(q.categoryId) || null;
  const method = rules.PAYMENT_METHODS.includes(q.method) ? q.method : null;
  const w = where([
    [month && 'x.date >= :from AND x.date <= :to'],
    [categoryId && 'x.category_id = :categoryId'],
    [method && 'x.payment_method = :method'],
    [q.q && '(x.payee LIKE :q OR x.description LIKE :q OR x.memo LIKE :q)'],
  ]);
  return { sql: w.sql, params: { from: month ? `${month}-01` : null, to: month ? `${month}-31` : null, categoryId, method, q: q.q ? `%${q.q}%` : null } };
}

// 정렬 기준은 정해진 목록에서만 고름 (사용자 입력을 SQL에 그대로 넣지 않기 위해)
const SORTS = { date: 'x.date DESC, x.id DESC', date_asc: 'x.date ASC, x.id ASC', amount: 'x.amount DESC, x.date DESC', amount_asc: 'x.amount ASC, x.date DESC' };

/** 한 달 합계 */
function monthTotal(ym, upToDay) {
  const to = upToDay ? `${ym}-${String(upToDay).padStart(2, '0')}` : `${ym}-31`;
  return get('SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS n FROM expenses WHERE date >= ? AND date <= ?', `${ym}-01`, to);
}

/** 월별 요약 계산 (화면의 "월별 요약" 탭과 대시보드 숫자 카드에서 사용) */
function summary(month) {
  const ym = validMonth(month) || time.thisMonth();
  const prev = time.addMonthsYm(ym, -1);
  const isCurrent = ym === time.thisMonth();
  const cur = monthTotal(ym);
  const prevFull = monthTotal(prev);
  // 이번 달은 아직 끝나지 않았으므로 "지난달 같은 기간(1일~오늘 날짜)"과 비교해야 공정함
  const day = Number(time.today().slice(8, 10));
  const prevSame = isCurrent ? monthTotal(prev, Math.min(day, time.daysInMonth(prev))) : prevFull;
  const base = prevSame.s;
  const changePct = base > 0 ? Math.round(((cur.s - base) / base) * 1000) / 10 : null;

  const cats = all('SELECT id, name, color, sort, active FROM expense_categories ORDER BY sort, id');
  const curBy = Object.fromEntries(
    all('SELECT category_id AS id, SUM(amount) AS s, COUNT(*) AS n FROM expenses WHERE date >= ? AND date <= ? GROUP BY category_id', `${ym}-01`, `${ym}-31`).map((r) => [r.id, r])
  );
  const prevBy = Object.fromEntries(
    all('SELECT category_id AS id, SUM(amount) AS s FROM expenses WHERE date >= ? AND date <= ? GROUP BY category_id', `${prev}-01`, `${prev}-31`).map((r) => [r.id, r.s])
  );
  const byCategory = cats
    .filter((c) => c.active || curBy[c.id])
    .map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      total: curBy[c.id]?.s || 0,
      count: curBy[c.id]?.n || 0,
      prevTotal: prevBy[c.id] || 0,
      share: cur.s > 0 ? Math.round(((curBy[c.id]?.s || 0) / cur.s) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // 12개월 추이 (고른 달 포함 이전 12개월)
  const first = time.addMonthsYm(ym, -11);
  const monthly = Object.fromEntries(
    all(`SELECT substr(date, 1, 7) AS m, SUM(amount) AS s, COUNT(*) AS n FROM expenses WHERE date >= ? AND date <= ? GROUP BY m`, `${first}-01`, `${ym}-31`).map((r) => [r.m, r])
  );
  const trend = [];
  for (let i = 11; i >= 0; i--) {
    const m = time.addMonthsYm(ym, -i);
    trend.push({ month: m, total: monthly[m]?.s || 0, count: monthly[m]?.n || 0, partial: m === time.thisMonth() });
  }
  const complete = trend.filter((t) => !t.partial && t.total > 0);
  const avg = complete.length ? Math.round(complete.reduce((s, t) => s + t.total, 0) / complete.length) : 0;

  const vend = hasVendors();
  const topPayees = all(
    `SELECT COALESCE(${vend ? 'vd.name' : 'NULL'}, x.payee) AS payee, SUM(x.amount) AS total, COUNT(*) AS n
     FROM expenses x ${vend ? 'LEFT JOIN vendors vd ON vd.id = x.vendor_id' : ''}
     WHERE x.date >= ? AND x.date <= ? GROUP BY 1 ORDER BY total DESC LIMIT 6`,
    `${ym}-01`,
    `${ym}-31`
  ).map((r) => ({ payee: r.payee, total: r.total, count: r.n }));

  const largest = all(`${itemSql()} WHERE x.date >= ? AND x.date <= ? ORDER BY x.amount DESC LIMIT 5`, `${ym}-01`, `${ym}-31`).map(toView);

  return {
    month: ym,
    isCurrent,
    total: cur.s,
    count: cur.n,
    prevMonth: prev,
    prevTotal: prevFull.s,
    compareBase: base,
    compareLabel: isCurrent ? `지난달 같은 기간(1~${Math.min(day, time.daysInMonth(prev))}일)` : '지난달',
    change: cur.s - base,
    changePct,
    average12: avg,
    byCategory,
    trend,
    topPayees,
    largest,
  };
}

function register(r) {
  // 지출은 병원 경영 정보라 모든 API를 실장 이상만 쓸 수 있게 막습니다.
  r.use(requireRole('manager'));

  // ---------- 분류 ----------
  r.get('/categories', (req, res) => {
    const rows = all(
      `SELECT c.*, (SELECT COUNT(*) FROM expenses x WHERE x.category_id = c.id) AS n FROM expense_categories c ORDER BY c.sort, c.id`
    );
    res.json(rows.map((c) => ({ id: c.id, name: c.name, color: c.color, sort: c.sort, keywords: c.keywords, active: !!c.active, count: c.n })));
  });

  r.post('/categories', (req, res) => {
    const d = categorySchema.parse(req.body);
    if (get('SELECT id FROM expense_categories WHERE name = ?', d.name)) throw new HttpError(409, '같은 이름의 분류가 이미 있습니다.', { field: 'name' });
    const sort = d.sort ?? (get('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM expense_categories').n);
    const info = run('INSERT INTO expense_categories (name, color, sort, keywords, active) VALUES (?, ?, ?, ?, 1)', d.name, d.color, sort, d.keywords);
    audit(req, 'create', 'expense_categories', info.lastInsertRowid, `지출 분류 추가: ${d.name}`);
    res.status(201).json({ id: info.lastInsertRowid, ...d, sort, active: true, count: 0 });
  });

  r.patch('/categories/:id', (req, res) => {
    const id = idParam(req.params.id);
    const c = get('SELECT * FROM expense_categories WHERE id = ?', id);
    if (!c) throw notFound('분류');
    const d = categorySchema.partial().parse(req.body);
    if (d.name && d.name !== c.name && get('SELECT id FROM expense_categories WHERE name = ? AND id != ?', d.name, id)) {
      throw new HttpError(409, '같은 이름의 분류가 이미 있습니다.', { field: 'name' });
    }
    const active = req.body.active === undefined ? c.active : v.bool()(req.body.active) ? 1 : 0;
    run(
      'UPDATE expense_categories SET name = ?, color = ?, sort = ?, keywords = ?, active = ? WHERE id = ?',
      d.name ?? c.name,
      d.color ?? c.color,
      d.sort ?? c.sort,
      'keywords' in d ? d.keywords || '' : c.keywords,
      active,
      id
    );
    audit(req, 'update', 'expense_categories', id, `지출 분류 수정: ${d.name ?? c.name}${active !== c.active ? (active ? ' (다시 사용)' : ' (보관)') : ''}`);
    const n = get('SELECT COUNT(*) AS n FROM expenses WHERE category_id = ?', id).n;
    const u = get('SELECT * FROM expense_categories WHERE id = ?', id);
    res.json({ id, name: u.name, color: u.color, sort: u.sort, keywords: u.keywords, active: !!u.active, count: n });
  });

  r.delete('/categories/:id', (req, res) => {
    const id = idParam(req.params.id);
    const c = get('SELECT * FROM expense_categories WHERE id = ?', id);
    if (!c) throw notFound('분류');
    const n = get('SELECT COUNT(*) AS n FROM expenses WHERE category_id = ?', id).n;
    if (n > 0) throw new HttpError(409, `이 분류로 기록된 지출이 ${n}건 있어 삭제할 수 없습니다. 더 쓰지 않으려면 [보관]을 눌러 주세요.`);
    run('DELETE FROM expense_categories WHERE id = ?', id);
    audit(req, 'delete', 'expense_categories', id, `지출 분류 삭제: ${c.name}`);
    res.json({ ok: true });
  });

  // ---------- 지출 ----------
  r.get('/items', (req, res) => {
    const q = req.query;
    const w = listWhere(q);
    const page = Math.max(1, Number(q.page) || 1);
    const size = Math.min(200, Math.max(10, Number(q.size) || 50));
    const order = SORTS[q.sort] || SORTS.date;
    const agg = get(`SELECT COUNT(*) AS n, COALESCE(SUM(x.amount), 0) AS s FROM expenses x ${w.sql}`, w.params);
    const rows = all(`${itemSql()} ${w.sql} ORDER BY ${order} LIMIT :limit OFFSET :offset`, { ...w.params, limit: size, offset: (page - 1) * size });
    res.json({ rows: rows.map(toView), total: agg.n, sum: agg.s, page, size, vendorsAvailable: hasVendors() });
  });

  r.get('/items/:id', (req, res) => res.json(toView(loadOne(idParam(req.params.id)))));

  r.post('/items', (req, res) => {
    const d = itemSchema.parse(req.body);
    if (d.amount === 0) throw badRequest('금액: 0원은 저장할 수 없습니다.', { field: 'amount' });
    checkCategory(d.categoryId);
    checkVendor(d.vendorId);
    const now = time.nowIso();
    const info = run(
      `INSERT INTO expenses (date, category_id, vendor_id, payee, description, amount, payment_method, memo, source, created_by, created_at, updated_at)
       VALUES (:date, :categoryId, :vendorId, :payee, :description, :amount, :paymentMethod, :memo, 'manual', :me, :now, :now)`,
      { ...d, me: req.user.id, now }
    );
    audit(req, 'create', 'expenses', info.lastInsertRowid, `지출 추가: ${d.date} ${d.payee} ${d.amount.toLocaleString('ko-KR')}원`);
    res.status(201).json(toView(loadOne(info.lastInsertRowid)));
  });

  r.patch('/items/:id', (req, res) => {
    const id = idParam(req.params.id);
    const x = loadOne(id);
    const d = itemSchema.partial().parse(req.body);
    if (d.amount === 0) throw badRequest('금액: 0원은 저장할 수 없습니다.', { field: 'amount' });
    if ('categoryId' in d) checkCategory(d.categoryId);
    if ('vendorId' in d) checkVendor(d.vendorId);
    run(
      `UPDATE expenses SET date = ?, category_id = ?, vendor_id = ?, payee = ?, description = ?, amount = ?, payment_method = ?, memo = ?, updated_at = ? WHERE id = ?`,
      d.date ?? x.date,
      d.categoryId ?? x.category_id,
      'vendorId' in d ? d.vendorId : x.vendor_id,
      d.payee ?? x.payee,
      'description' in d ? d.description : x.description,
      d.amount ?? x.amount,
      d.paymentMethod ?? x.payment_method,
      'memo' in d ? d.memo : x.memo,
      time.nowIso(),
      id
    );
    audit(req, 'update', 'expenses', id, `지출 수정: ${d.date ?? x.date} ${d.payee ?? x.payee}`);
    res.json(toView(loadOne(id)));
  });

  r.delete('/items/:id', (req, res) => {
    const id = idParam(req.params.id);
    const x = loadOne(id);
    run('DELETE FROM expenses WHERE id = ?', id);
    audit(req, 'delete', 'expenses', id, `지출 삭제: ${x.date} ${x.payee} ${x.amount.toLocaleString('ko-KR')}원`);
    res.json({ ok: true });
  });

  // ---------- CSV 내보내기 ----------
  r.get('/export.csv', (req, res) => {
    const w = listWhere(req.query);
    const rows = all(`${itemSql()} ${w.sql} ORDER BY x.date, x.id`, w.params).map(toView);
    const csv = toCsv(
      [
        { key: 'date', label: '날짜' },
        { key: 'categoryName', label: '분류' },
        { label: '지급처', value: (r) => r.vendorName || r.payee },
        { key: 'description', label: '내용' },
        { key: 'amount', label: '금액' },
        { key: 'paymentMethod', label: '결제수단' },
        { key: 'memo', label: '메모' },
      ],
      rows
    );
    const month = validMonth(req.query.month);
    audit(req, 'export', 'expenses', null, `지출 CSV 내보내기 ${month || '전체'} (${rows.length}건)`);
    sendCsv(res, `지출_${month || '전체'}.csv`, csv);
  });

  // ---------- CSV·카드 내역 가져오기 ----------
  r.post('/import/preview', (req, res) => {
    const { text } = v.object({ text: v.string({ min: 5, max: 2000000, trim: false, label: '내용' }) }).parse(req.body);
    const parsed = rules.parseExpenseText(text);
    if (!parsed.rows.length) {
      throw badRequest(
        parsed.missing.includes('date') || parsed.missing.includes('amount')
          ? '날짜와 금액 칸을 찾지 못했습니다. 첫 줄(머리글)에 "날짜, 가맹점, 금액" 이 있는지 확인해 주세요.'
          : '읽을 수 있는 줄이 없습니다.'
      );
    }
    if (parsed.rows.length > 2000) throw badRequest('한 번에 2,000줄까지 가져올 수 있습니다. 파일을 나눠 주세요.');
    const cats = all('SELECT id, name, keywords FROM expense_categories WHERE active = 1 ORDER BY sort, id');
    const etc = cats.find((c) => c.name === '기타') || cats[cats.length - 1];
    const rows = parsed.rows.map((row) => {
      // 1) 파일에 분류 이름이 적혀 있으면 그대로  2) 키워드 규칙  3) 기타
      let categoryId = null;
      let suggestedBy = null;
      let keyword = null;
      const named = row.categoryName && cats.find((c) => c.name === row.categoryName);
      if (named) {
        categoryId = named.id;
        suggestedBy = 'file';
      } else {
        const s = rules.suggestCategory(`${row.payee} ${row.description}`, cats);
        if (s) {
          categoryId = s.id;
          suggestedBy = 'rule';
          keyword = s.keyword;
        } else if (etc) categoryId = etc.id;
      }
      // 이미 같은 날짜·금액·지급처로 저장된 지출이 있으면 "중복 의심"
      const duplicate =
        !row.error && !!get('SELECT 1 FROM expenses WHERE date = ? AND amount = ? AND payee = ? LIMIT 1', row.date, row.amount, row.payee);
      return { ...row, categoryId, suggestedBy, keyword, duplicate, include: !row.error && !duplicate };
    });
    res.json({
      format: parsed.format,
      headerless: parsed.headerless,
      headers: parsed.headers,
      rows,
      counts: {
        total: rows.length,
        ok: rows.filter((r) => !r.error).length,
        errors: rows.filter((r) => r.error).length,
        duplicates: rows.filter((r) => r.duplicate).length,
        suggested: rows.filter((r) => r.suggestedBy).length,
      },
    });
  });

  r.post('/import/commit', (req, res) => {
    const { rows } = v
      .object({
        rows: v.array(
          v.object({
            date: v.date({ label: '날짜' }),
            categoryId: v.id({ label: '분류' }),
            payee: v.string({ min: 1, max: 100, label: '지급처' }),
            description: v.string({ max: 200, optional: true, label: '내용' }),
            amount: v.int({ min: -1000000000, max: 1000000000, label: '금액' }),
            paymentMethod: v.enum(rules.PAYMENT_METHODS, { optional: true, default: '카드', label: '결제 수단' }),
          }),
          { min: 1, max: 2000, label: '저장할 줄' }
        ),
      })
      .parse(req.body);
    const catIds = new Set(all('SELECT id FROM expense_categories').map((c) => c.id));
    rows.forEach((row, i) => {
      if (!catIds.has(row.categoryId)) throw badRequest(`${i + 1}번째 줄: 분류를 찾을 수 없습니다.`);
      if (row.amount === 0) throw badRequest(`${i + 1}번째 줄: 금액이 0원입니다.`);
    });
    const now = time.nowIso();
    tx(() => {
      for (const row of rows) {
        run(
          `INSERT INTO expenses (date, category_id, payee, description, amount, payment_method, source, created_by, created_at, updated_at)
           VALUES (:date, :categoryId, :payee, :description, :amount, :paymentMethod, 'import', :me, :now, :now)`,
          { ...row, me: req.user.id, now }
        );
      }
    });
    const sum = rows.reduce((s, row) => s + row.amount, 0);
    audit(req, 'import', 'expenses', null, `지출 가져오기 ${rows.length}건 (합계 ${sum.toLocaleString('ko-KR')}원)`);
    res.json({ inserted: rows.length, sum });
  });

  // ---------- 월별 요약 ----------
  r.get('/summary', (req, res) => res.json(summary(req.query.month)));
}

// ---------- 대시보드 (실장 이상에게만 숫자 카드) ----------
function dashboard(user) {
  if (!hasRole(user, 'manager')) return {};
  const s = summary(time.thisMonth());
  let hint = '';
  if (s.changePct !== null) {
    const pct = Math.abs(s.changePct);
    hint = pct < 1 ? '지난달 같은 기간과 비슷' : `지난달 같은 기간보다 ${pct}% ${s.changePct > 0 ? '많음' : '적음'}`;
  } else hint = `${s.count}건`;
  return {
    stats: [
      {
        key: 'expenses-month',
        label: '이번 달 지출',
        value: s.total >= 10000 ? Math.round(s.total / 10000).toLocaleString('ko-KR') : s.total.toLocaleString('ko-KR'),
        unit: s.total >= 10000 ? '만원' : '원',
        hint,
        href: '#/expenses',
        icon: 'wallet',
      },
    ],
  };
}

module.exports = {
  name: 'expenses',
  migrations,
  register,
  aiFeatures,
  seed: (ctx) => seed(ctx, DEFAULT_CATEGORIES),
  // 처음 실행(데모 없이)에도 기본 분류가 있도록, 표를 만든 직후 기본 분류를 넣는 마이그레이션을 따로 둠
  resetTables: ['expenses'],
  dashboard,
  summary,
  DEFAULT_CATEGORIES,
};

// 기본 분류 넣기: 데모 데이터 없이 시작해도 분류는 있어야 하므로 마이그레이션으로 넣습니다.
migrations.push({
  id: 'expenses_002',
  get up() {
    const esc = (s) => String(s).replace(/'/g, "''");
    return DEFAULT_CATEGORIES.map(
      ([name, color, kw], i) => `INSERT OR IGNORE INTO expense_categories (name, color, sort, keywords, active) VALUES ('${esc(name)}', '${color}', ${i + 1}, '${esc(kw)}', 1);`
    ).join('\n');
  },
});
