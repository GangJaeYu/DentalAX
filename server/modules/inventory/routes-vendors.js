/*
 * 이 파일이 하는 일: 거래처 API입니다. (/api/inventory/vendors/...)
 *   보기는 누구나, 추가·수정·삭제는 실장 이상. 발주 금액이 보이는 "최근 발주서"는 실장 이상에게만 보냅니다.
 *
 *   GET    /vendors          목록 (q, category, archived=1) + 품목 수, 진행 중 발주 수, 최근 발주서
 *   GET    /vendors/:id      상세 + 이 거래처 품목 + 최근 발주서
 *   POST   /vendors          추가
 *   PATCH  /vendors/:id      수정 (active로 보관/해제)
 *   DELETE /vendors/:id      삭제 — 다른 기록(품목·발주·지출·장비 등)에서 쓰고 있으면 지우지 않고 "보관"
 */
const { all, get, run, where } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, HttpError } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { requireRole, hasRole } = require('../../core/auth');
const time = require('../../core/time');
const stock = require('./stock');
const views = require('./views');

const vendorSchema = v.object({
  name: v.string({ min: 1, max: 100, label: '거래처 이름' }),
  category: v.enum(stock.VENDOR_CATEGORIES, { optional: true, default: '재료상', label: '분류' }),
  contactName: v.string({ max: 50, optional: true, label: '담당자' }),
  phone: v.string({ max: 40, optional: true, label: '전화번호' }),
  email: v.string({
    max: 120,
    optional: true,
    label: '이메일',
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    patternMessage: '이메일 형식이 올바르지 않습니다. (예: order@example.com)',
  }),
  orderMethod: v.enum(stock.ORDER_METHODS, { optional: true, default: '전화', label: '주문 방법' }),
  website: v.string({
    max: 200,
    optional: true,
    label: '웹사이트',
    // 주소 칸에 javascript: 같은 위험한 값이 들어가지 않도록 일반 웹 주소 모양만 허용
    pattern: /^(?!(?!https?:)[a-z][a-z0-9+.-]*:)(https?:\/\/)?[A-Za-z0-9가-힣][^\s<>"']*$/i,
    patternMessage: '웹 주소 형식이 올바르지 않습니다. (예: www.example.com)',
  }),
  paymentTerms: v.string({ max: 200, optional: true, label: '결제 조건' }),
  memo: v.string({ max: 2000, optional: true, label: '메모' }),
});

/** 다른 표(지출·장비 등 다른 모듈 포함)에서 이 거래처를 몇 번 쓰고 있는지 — DB 연결 정보를 보고 자동으로 찾음 */
function usageCount(vendorId) {
  let n = 0;
  const tables = all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const t of tables) {
    const fks = all(`PRAGMA foreign_key_list("${t.name.replace(/"/g, '')}")`).filter((f) => f.table === 'vendors');
    for (const f of fks) n += get(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '')}" WHERE "${String(f.from).replace(/"/g, '')}" = ?`, vendorId).n;
  }
  return n;
}

function recentPos(vendorId, limit = 3) {
  return all(`${views.PO_SQL} WHERE po.vendor_id = :vendorId ORDER BY po.created_at DESC, po.id DESC LIMIT :limit`, { vendorId, limit }).map((p) => views.poView(p));
}

function register(r) {
  const manager = requireRole('manager');

  r.get('/vendors', (req, res) => {
    const q = req.query;
    const category = stock.VENDOR_CATEGORIES.includes(q.category) ? q.category : null;
    const w = where([
      [q.archived === '1' ? 'vd.active = 0' : 'vd.active = 1'],
      [category && 'vd.category = :category'],
      [q.q && '(vd.name LIKE :q OR vd.contact_name LIKE :q OR vd.memo LIKE :q)'],
    ]);
    const rows = all(
      `SELECT vd.*,
        (SELECT COUNT(*) FROM inv_items i WHERE i.vendor_id = vd.id AND i.active = 1) AS item_count,
        (SELECT COUNT(*) FROM inv_items i WHERE i.vendor_id = vd.id AND i.active = 1 AND i.min_qty > 0 AND i.current_qty <= i.min_qty) AS low_count,
        (SELECT COUNT(*) FROM purchase_orders po WHERE po.vendor_id = vd.id AND po.status IN ('draft','ordered')) AS open_po_count,
        (SELECT MAX(po.order_date) FROM purchase_orders po WHERE po.vendor_id = vd.id AND po.status IN ('ordered','received')) AS last_order_date
       FROM vendors vd ${w.sql} ORDER BY vd.name`,
      { category, q: q.q ? `%${q.q}%` : null }
    );
    const isManager = hasRole(req.user, 'manager');
    res.json({
      rows: rows.map((x) => ({
        ...views.vendorView(x),
        itemCount: x.item_count,
        lowCount: x.low_count,
        openPoCount: x.open_po_count,
        lastOrderDate: x.last_order_date,
        recentPos: isManager ? recentPos(x.id) : undefined,
      })),
      archivedCount: get('SELECT COUNT(*) AS n FROM vendors WHERE active = 0').n,
    });
  });

  r.get('/vendors/:id', (req, res) => {
    const id = idParam(req.params.id);
    const x = get('SELECT * FROM vendors WHERE id = ?', id);
    if (!x) throw notFound('거래처');
    const today = time.today();
    const items = all(`${views.ITEM_SQL} WHERE i.vendor_id = :id AND i.active = 1 ORDER BY i.category, i.name`, { id, today }).map((i) => views.itemView(i, today));
    const isManager = hasRole(req.user, 'manager');
    const yearTotal = isManager
      ? Math.round(
          get(
            `SELECT COALESCE(SUM(ROUND(x.qty * COALESCE(x.unit_price, 0))), 0) AS n FROM purchase_order_items x JOIN purchase_orders po ON po.id = x.po_id
             WHERE po.vendor_id = ? AND po.status IN ('ordered','received') AND po.order_date >= ?`,
            id,
            `${today.slice(0, 4)}-01-01`
          ).n
        )
      : undefined;
    res.json({ ...views.vendorView(x), items, recentPos: isManager ? recentPos(id, 10) : undefined, yearTotal });
  });

  r.post('/vendors', manager, (req, res) => {
    const d = vendorSchema.parse(req.body);
    if (get('SELECT id FROM vendors WHERE lower(name) = lower(?)', d.name)) throw new HttpError(409, '같은 이름의 거래처가 이미 있습니다.', { field: 'name' });
    const now = time.nowIso();
    const id = run(
      `INSERT INTO vendors (name, category, contact_name, phone, email, order_method, website, payment_terms, memo, active, created_at, updated_at)
       VALUES (:name, :category, :contactName, :phone, :email, :orderMethod, :website, :paymentTerms, :memo, 1, :now, :now)`,
      { ...d, now }
    ).lastInsertRowid;
    audit(req, 'create', 'vendors', id, `거래처 추가: ${d.name}`);
    res.status(201).json(views.vendorView(get('SELECT * FROM vendors WHERE id = ?', id)));
  });

  r.patch('/vendors/:id', manager, (req, res) => {
    const id = idParam(req.params.id);
    const old = get('SELECT * FROM vendors WHERE id = ?', id);
    if (!old) throw notFound('거래처');
    const d = vendorSchema.partial().parse(req.body);
    if (d.name && get('SELECT id FROM vendors WHERE lower(name) = lower(?) AND id != ?', d.name, id)) throw new HttpError(409, '같은 이름의 거래처가 이미 있습니다.', { field: 'name' });
    const pick = (k, col) => (k in d ? d[k] : old[col]);
    const active = req.body.active === undefined ? old.active : v.bool()(req.body.active) ? 1 : 0;
    run(
      `UPDATE vendors SET name = ?, category = ?, contact_name = ?, phone = ?, email = ?, order_method = ?, website = ?, payment_terms = ?, memo = ?, active = ?, updated_at = ? WHERE id = ?`,
      d.name ?? old.name,
      d.category ?? old.category,
      pick('contactName', 'contact_name'),
      pick('phone', 'phone'),
      pick('email', 'email'),
      d.orderMethod ?? old.order_method,
      pick('website', 'website'),
      pick('paymentTerms', 'payment_terms'),
      pick('memo', 'memo'),
      active,
      time.nowIso(),
      id
    );
    audit(req, 'update', 'vendors', id, `거래처 수정: ${d.name ?? old.name}${active !== old.active ? (active ? ' (보관 해제)' : ' (보관)') : ''}`);
    res.json(views.vendorView(get('SELECT * FROM vendors WHERE id = ?', id)));
  });

  r.delete('/vendors/:id', manager, (req, res) => {
    const id = idParam(req.params.id);
    const old = get('SELECT * FROM vendors WHERE id = ?', id);
    if (!old) throw notFound('거래처');
    const used = usageCount(id);
    if (used > 0) {
      run('UPDATE vendors SET active = 0, updated_at = ? WHERE id = ?', time.nowIso(), id);
      audit(req, 'update', 'vendors', id, `거래처 보관(다른 기록에서 사용 중이라 삭제 대신): ${old.name}`);
      return res.json({ ok: true, archived: true, message: `품목·발주서 등 ${used}건의 기록에서 쓰고 있어 삭제하지 않고 보관했습니다.` });
    }
    run('DELETE FROM vendors WHERE id = ?', id);
    audit(req, 'delete', 'vendors', id, `거래처 삭제: ${old.name}`);
    res.json({ ok: true, archived: false });
  });
}

module.exports = { register };
