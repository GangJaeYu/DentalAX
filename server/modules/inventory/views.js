/*
 * 이 파일이 하는 일: DB에서 꺼낸 줄(snake_case)을 화면이 쓰기 좋은 모양(camelCase)으로 바꾸는 함수와,
 *                   여러 API가 같이 쓰는 조회 SQL을 모아 둡니다.
 */
const { all, get } = require('../../core/db');
const time = require('../../core/time');
const { r3, MOVE_LABEL, EXPIRY_SOON_DAYS } = require('./stock');

const PO_STATUS_LABEL = { draft: '작성 중', ordered: '발주함', received: '입고 완료', cancelled: '취소' };

// 품목 목록 SQL: 가장 가까운 유효기간, 만료된 수량을 함께 계산
const ITEM_SQL = `
  SELECT i.*, v.name AS vendor_name,
    (SELECT MIN(l.expiry_date) FROM inv_lots l WHERE l.item_id = i.id AND l.qty_remaining > 0 AND l.expiry_date >= :today) AS next_expiry,
    (SELECT COALESCE(SUM(l.qty_remaining), 0) FROM inv_lots l WHERE l.item_id = i.id AND l.qty_remaining > 0 AND l.expiry_date < :today) AS expired_qty
  FROM inv_items i LEFT JOIN vendors v ON v.id = i.vendor_id`;

/** 품목 한 줄 → 화면용 */
function itemView(i, today = time.today()) {
  const low = i.active && i.min_qty > 0 && i.current_qty <= i.min_qty;
  const nextExpiry = i.next_expiry || null;
  const daysToExpiry = nextExpiry ? time.diffDays(today, nextExpiry) : null;
  const expiredQty = r3(i.expired_qty || 0);
  let status = 'ok';
  if (i.current_qty <= 0 && i.min_qty > 0) status = 'out';
  else if (low) status = 'low';
  return {
    id: i.id,
    name: i.name,
    category: i.category,
    unit: i.unit,
    spec: i.spec || '',
    vendorId: i.vendor_id,
    vendorName: i.vendor_name || null,
    minQty: r3(i.min_qty),
    reorderQty: r3(i.reorder_qty),
    location: i.location || '',
    currentQty: r3(i.current_qty),
    trackExpiry: !!i.track_expiry,
    lastUnitPrice: i.last_unit_price,
    memo: i.memo || '',
    active: !!i.active,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    status, // ok | low(부족) | out(바닥)
    low,
    nextExpiry,
    daysToExpiry,
    expiringSoon: daysToExpiry !== null && daysToExpiry <= EXPIRY_SOON_DAYS,
    expiredQty,
  };
}

function getItemView(id) {
  const today = time.today();
  const row = get(`${ITEM_SQL} WHERE i.id = :id`, { id, today });
  return row ? itemView(row, today) : null;
}

const MOVE_SQL = `
  SELECT m.*, i.name AS item_name, i.unit, i.spec, u.name AS user_name, v.name AS vendor_name, po.po_no
  FROM inv_moves m
  JOIN inv_items i ON i.id = m.item_id
  LEFT JOIN users u ON u.id = m.user_id
  LEFT JOIN vendors v ON v.id = m.vendor_id
  LEFT JOIN purchase_orders po ON po.id = m.po_id`;

function moveView(m) {
  return {
    id: m.id,
    itemId: m.item_id,
    itemName: m.item_name,
    spec: m.spec || '',
    unit: m.unit,
    type: m.type,
    typeLabel: MOVE_LABEL[m.type],
    qty: r3(m.qty),
    balanceAfter: m.balance_after === null ? null : r3(m.balance_after),
    unitPrice: m.unit_price,
    lotNo: m.lot_no,
    expiryDate: m.expiry_date,
    vendorName: m.vendor_name || null,
    poId: m.po_id,
    poNo: m.po_no || null,
    note: m.note || '',
    userId: m.user_id,
    userName: m.user_name || '',
    date: m.move_date,
    createdAt: m.created_at,
  };
}

function vendorView(v) {
  return {
    id: v.id,
    name: v.name,
    category: v.category,
    contactName: v.contact_name || '',
    phone: v.phone || '',
    email: v.email || '',
    orderMethod: v.order_method,
    website: v.website || '',
    paymentTerms: v.payment_terms || '',
    memo: v.memo || '',
    active: !!v.active,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
  };
}

// 발주서 목록 SQL: 품목 수, 합계, 첫 품목 이름을 함께
const PO_SQL = `
  SELECT po.*, v.name AS vendor_name, u.name AS created_by_name,
    (SELECT COUNT(*) FROM purchase_order_items x WHERE x.po_id = po.id) AS line_count,
    (SELECT COALESCE(SUM(ROUND(x.qty * COALESCE(x.unit_price, 0))), 0) FROM purchase_order_items x WHERE x.po_id = po.id) AS total,
    (SELECT COALESCE(SUM(x.qty), 0) FROM purchase_order_items x WHERE x.po_id = po.id) AS qty_total,
    (SELECT COALESCE(SUM(MIN(x.received_qty, x.qty)), 0) FROM purchase_order_items x WHERE x.po_id = po.id) AS received_total,
    (SELECT i.name FROM purchase_order_items x JOIN inv_items i ON i.id = x.item_id WHERE x.po_id = po.id ORDER BY x.id LIMIT 1) AS first_item
  FROM purchase_orders po
  LEFT JOIN vendors v ON v.id = po.vendor_id
  LEFT JOIN users u ON u.id = po.created_by`;

function poView(p, today = time.today()) {
  const overdue = p.status === 'ordered' && p.expected_date && p.expected_date < today;
  return {
    id: p.id,
    poNo: p.po_no,
    vendorId: p.vendor_id,
    vendorName: p.vendor_name || null,
    status: p.status,
    statusLabel: PO_STATUS_LABEL[p.status],
    orderDate: p.order_date,
    expectedDate: p.expected_date,
    receivedDate: p.received_date,
    note: p.note || '',
    createdBy: p.created_by,
    createdByName: p.created_by_name || '',
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    lineCount: p.line_count || 0,
    total: Math.round(p.total || 0),
    qtyTotal: r3(p.qty_total || 0),
    receivedTotal: r3(p.received_total || 0),
    firstItem: p.first_item || null,
    overdue: !!overdue,
    daysToExpected: p.expected_date ? time.diffDays(today, p.expected_date) : null,
  };
}

function poLines(poId) {
  return all(
    `SELECT x.*, i.name AS item_name, i.spec, i.unit, i.track_expiry, i.current_qty, i.active AS item_active
     FROM purchase_order_items x JOIN inv_items i ON i.id = x.item_id WHERE x.po_id = ? ORDER BY x.id`,
    poId
  ).map((x) => ({
    id: x.id,
    itemId: x.item_id,
    itemName: x.item_name,
    spec: x.spec || '',
    unit: x.unit,
    trackExpiry: !!x.track_expiry,
    currentQty: r3(x.current_qty),
    qty: r3(x.qty),
    unitPrice: x.unit_price,
    amount: Math.round(x.qty * (x.unit_price || 0)),
    receivedQty: r3(x.received_qty),
    remaining: Math.max(0, r3(x.qty - x.received_qty)),
  }));
}

function getPoView(id) {
  const p = get(`${PO_SQL} WHERE po.id = :id`, { id });
  return p ? poView(p) : null;
}

module.exports = { PO_STATUS_LABEL, ITEM_SQL, itemView, getItemView, MOVE_SQL, moveView, vendorView, PO_SQL, poView, poLines, getPoView };
