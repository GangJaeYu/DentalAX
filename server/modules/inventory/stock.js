/*
 * 이 파일이 하는 일: 재고 수량을 바꾸는 핵심 계산(입고·출고·실사 조정·기록 취소)과 경고 계산을 모아 둔 곳입니다.
 *
 *  - 입고: 수량을 늘리고, 유효기간을 관리하는 품목이면 로트(묶음)를 만들고, 단가가 바뀌었으면 단가 기록을 남깁니다.
 *  - 출고: 유효기간이 빠른 로트부터 차감합니다(선입선출). 재고보다 많이 빼려고 하면 막습니다.
 *  - 실사 조정: 실제로 세어 본 수량으로 맞추고, 로트 수량도 합리적으로 맞춥니다.
 *  - 모든 변경은 tx()로 묶어서 "기록은 남았는데 수량은 안 바뀐" 상태가 생기지 않게 합니다.
 *
 * 여기 함수들은 화면 요청(routes)과 데모 데이터(seed) 양쪽에서 씁니다.
 * 데모 데이터는 과거 날짜로 기록을 만들어야 해서 opts.date / opts.at 으로 날짜를 바꿀 수 있습니다.
 */
const { all, get, run, tx } = require('../../core/db');
const { notFound, badRequest } = require('../../core/errors');
const time = require('../../core/time');

const ITEM_CATEGORIES = ['소모품', '재료', '약품', '기구', '사무·위생', '기타'];
const VENDOR_CATEGORIES = ['재료상', '기공소', '장비업체', '소모품', '기타'];
const ORDER_METHODS = ['전화', '카카오톡', '이메일', '웹사이트', '기타'];
const MOVE_LABEL = { in: '입고', out: '출고', adjust: '실사 조정' };
const EXPIRY_SOON_DAYS = 30; // 이 일수 안에 유효기간이 끝나면 "임박"

/** 소수점 계산 오차(0.1+0.2=0.30000000000000004) 정리: 소수 셋째 자리까지 */
function r3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

/** 수량을 보기 좋은 글자로: 3 → '3', 2.5 → '2.5' */
function fmtQty(n) {
  return String(r3(n));
}

function getItem(id) {
  const item = get('SELECT * FROM inv_items WHERE id = ?', id);
  if (!item) throw notFound('품목');
  return item;
}

/** 남은 수량이 있는 로트 목록 */
function openLots(itemId) {
  return all('SELECT * FROM inv_lots WHERE item_id = ? AND qty_remaining > 0 ORDER BY id', itemId);
}

/** 기록 시각: 데모 데이터는 과거 시각(opts.at), 평소에는 지금 */
function stamp(opts = {}) {
  return { date: opts.date || time.today(), at: opts.at || time.nowIso() };
}

function insertMove(m) {
  const info = run(
    `INSERT INTO inv_moves (item_id, type, qty, balance_after, unit_price, lot_id, lot_no, expiry_date, lots_json,
       vendor_id, po_id, note, user_id, move_date, created_at)
     VALUES (:item_id, :type, :qty, :balance_after, :unit_price, :lot_id, :lot_no, :expiry_date, :lots_json,
       :vendor_id, :po_id, :note, :user_id, :move_date, :created_at)`,
    m
  );
  return info.lastInsertRowid;
}

/** 단가가 마지막 기록과 다르면 단가 기록을 한 줄 남김 */
function recordPriceIfChanged(item, unitPrice, vendorId, date, source) {
  if (unitPrice === null || unitPrice === undefined) return false;
  const last = get('SELECT unit_price FROM inv_prices WHERE item_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1', item.id);
  // 처음 기록이거나, 마지막 기록과 단가가 다를 때만 남김 (같은 단가로 계속 입고하면 기록이 쌓이지 않음)
  if (last && last.unit_price === unitPrice) return false;
  run('INSERT INTO inv_prices (item_id, vendor_id, unit_price, recorded_at, source) VALUES (?, ?, ?, ?, ?)', item.id, vendorId || null, unitPrice, date, source);
  return true;
}

/**
 * 입고: 수량 늘리기 + (필요하면) 로트 만들기 + 단가 기록
 * @param {number} itemId
 * @param {{qty:number, unitPrice?:number|null, lotNo?:string|null, expiryDate?:string|null, vendorId?:number|null, poId?:number|null, note?:string|null}} d
 * @param {{userId?:number, date?:string, at?:string}} opts
 * @returns {{ moveId:number, warnings:string[] }}
 */
function receive(itemId, d, opts = {}) {
  return tx(() => {
    const item = getItem(itemId);
    if (!item.active) throw badRequest(`'${item.name}'은(는) 보관(사용 중지)된 품목입니다. 품목 수정에서 보관을 해제한 뒤 기록해 주세요.`);
    const qty = r3(d.qty);
    if (!(qty > 0)) throw badRequest('수량: 0보다 큰 수량을 입력해 주세요.', { field: 'qty' });
    const { date, at } = stamp(opts);
    const warnings = [];
    const lotNo = d.lotNo ? String(d.lotNo).trim() : null;
    const expiry = d.expiryDate || null;

    // 로트 번호나 유효기간을 적었으면 로트(묶음)로 따로 관리 (둘 다 없으면 "로트 없는 재고"로 들어감)
    let lotId = null;
    if (item.track_expiry && !expiry) warnings.push('유효기간을 적지 않았습니다. 나중에 품목 화면에서 확인해 주세요.');
    if (lotNo || expiry) {
      if (expiry && expiry < date) warnings.push('이미 유효기간이 지난 날짜로 입고했습니다. 날짜를 다시 확인해 주세요.');
      // 같은 로트번호·같은 유효기간이 이미 있으면 그 로트에 더함
      const same = get(
        `SELECT id FROM inv_lots WHERE item_id = ? AND IFNULL(lot_no, '') = ? AND IFNULL(expiry_date, '') = ? ORDER BY id DESC LIMIT 1`,
        item.id,
        lotNo || '',
        expiry || ''
      );
      if (same) {
        run('UPDATE inv_lots SET qty_remaining = qty_remaining + ? WHERE id = ?', qty, same.id);
        lotId = same.id;
      } else {
        lotId = run('INSERT INTO inv_lots (item_id, lot_no, expiry_date, qty_remaining, received_at) VALUES (?, ?, ?, ?, ?)', item.id, lotNo, expiry, qty, date)
          .lastInsertRowid;
      }
    }

    const unitPrice = d.unitPrice === null || d.unitPrice === undefined || d.unitPrice === '' ? null : Math.round(Number(d.unitPrice));
    const vendorId = d.vendorId || item.vendor_id || null;
    recordPriceIfChanged(item, unitPrice, vendorId, date, '입고');

    const balance = r3(item.current_qty + qty);
    run(
      'UPDATE inv_items SET current_qty = ?, last_unit_price = COALESCE(?, last_unit_price), updated_at = ? WHERE id = ?',
      balance,
      unitPrice,
      at,
      item.id
    );
    const moveId = insertMove({
      item_id: item.id,
      type: 'in',
      qty,
      balance_after: balance,
      unit_price: unitPrice,
      lot_id: lotId,
      lot_no: lotNo,
      expiry_date: expiry,
      lots_json: lotId ? JSON.stringify([{ lotId, qty }]) : null,
      vendor_id: vendorId,
      po_id: d.poId || null,
      note: d.note || null,
      user_id: opts.userId || null,
      move_date: date,
      created_at: at,
    });
    return { moveId, warnings };
  });
}

/**
 * 출고할 때 어느 로트에서 얼마나 뺄지 정합니다. (선입선출: 유효기간이 빠른 것부터)
 * 순서: ① 유효기간이 남은 로트(빠른 날짜부터) ② 유효기간이 없는 로트 ③ 로트 없이 들어온 재고
 *       ④ 그래도 모자라면 마지막으로 유효기간이 지난 로트
 * (지난 로트를 자동으로 먼저 쓰지 않는 이유: 만료품이 진료에 쓰이면 안 되므로, 만료품은 경고 화면에서 "폐기"로 따로 처리)
 * @returns {{lotId:number|null, qty:number}[]}
 */
function consumptionPlan(item, qty, today, lotId) {
  const lots = openLots(item.id);
  const lotSum = r3(lots.reduce((s, l) => s + l.qty_remaining, 0));
  const untracked = Math.max(0, r3(item.current_qty - lotSum));
  let order;
  if (lotId) {
    order = lots.filter((l) => l.id === lotId);
    if (!order.length) throw badRequest('선택한 로트를 찾을 수 없거나 이미 다 사용했습니다.');
  } else {
    const valid = lots.filter((l) => l.expiry_date && l.expiry_date >= today).sort((a, b) => a.expiry_date.localeCompare(b.expiry_date) || a.id - b.id);
    const noExpiry = lots.filter((l) => !l.expiry_date);
    const expired = lots.filter((l) => l.expiry_date && l.expiry_date < today).sort((a, b) => a.expiry_date.localeCompare(b.expiry_date) || a.id - b.id);
    order = [...valid, ...noExpiry, { id: null, qty_remaining: untracked }, ...expired];
  }
  const plan = [];
  let left = qty;
  for (const l of order) {
    if (left <= 0) break;
    const take = r3(Math.min(left, l.qty_remaining));
    if (take <= 0) continue;
    plan.push({ lotId: l.id, qty: take, lotNo: l.lot_no || null, expiry: l.expiry_date || null });
    left = r3(left - take);
  }
  return { plan, left };
}

/** 로트 차감 내용을 "L2401 3, L2402 2" 처럼 한 줄로 */
function planLabel(plan) {
  const named = plan.filter((p) => p.lotId);
  if (!named.length) return null;
  if (plan.length === 1) return named[0].lotNo || (named[0].expiry ? `유효 ${named[0].expiry}` : null);
  return plan.map((p) => `${p.lotId ? p.lotNo || p.expiry || '로트' : '기타'} ${fmtQty(p.qty)}`).join(', ');
}

/**
 * 출고: 유효기간이 빠른 로트부터 차감 (재고가 모자라면 막음)
 * @param {{qty:number, note?:string, lotId?:number}} d  lotId를 주면 그 로트에서만 뺌 (만료품 폐기 등)
 */
function consume(itemId, d, opts = {}) {
  return tx(() => {
    const item = getItem(itemId);
    const qty = r3(d.qty);
    if (!(qty > 0)) throw badRequest('수량: 0보다 큰 수량을 입력해 주세요.', { field: 'qty' });
    if (qty > r3(item.current_qty)) {
      throw badRequest(
        `재고가 부족합니다. '${item.name}'은(는) 지금 ${fmtQty(item.current_qty)}${item.unit} 남아 있어서 ${fmtQty(qty)}${item.unit}을(를) 출고할 수 없습니다. 실제 수량이 다르면 실장님께 실사 조정을 요청해 주세요.`,
        { field: 'qty' }
      );
    }
    const { date, at } = stamp(opts);
    const { plan, left } = consumptionPlan(item, qty, date, d.lotId || null);
    if (left > 0) throw badRequest(`선택한 로트에 남은 수량이 부족합니다. (${fmtQty(qty - left)}${item.unit}까지 가능)`, { field: 'qty' });
    const warnings = [];
    for (const p of plan) {
      if (!p.lotId) continue;
      run('UPDATE inv_lots SET qty_remaining = MAX(0, qty_remaining - ?) WHERE id = ?', p.qty, p.lotId);
      if (p.expiry && p.expiry < date && !d.lotId) warnings.push('유효기간이 지난 로트에서도 차감했습니다. 만료품이 섞여 있지 않은지 확인해 주세요.');
    }
    const balance = r3(item.current_qty - qty);
    run('UPDATE inv_items SET current_qty = ?, updated_at = ? WHERE id = ?', balance, at, item.id);
    const single = plan.length === 1 && plan[0].lotId ? plan[0] : null;
    const moveId = insertMove({
      item_id: item.id,
      type: 'out',
      qty: -qty,
      balance_after: balance,
      unit_price: null,
      lot_id: single ? single.lotId : null,
      lot_no: planLabel(plan),
      expiry_date: single ? single.expiry : null,
      lots_json: JSON.stringify(plan.map((p) => ({ lotId: p.lotId, qty: p.qty }))),
      vendor_id: null,
      po_id: null,
      note: d.note || null,
      user_id: opts.userId || null,
      move_date: date,
      created_at: at,
    });
    if (item.min_qty > 0 && balance <= item.min_qty) warnings.push(`재고가 적정 수량(${fmtQty(item.min_qty)}${item.unit}) 이하가 되었습니다. 발주가 필요합니다.`);
    return { moveId, warnings: [...new Set(warnings)] };
  });
}

/**
 * 실사 조정: 실제로 세어 본 수량으로 맞춤
 *  - 줄어들었으면: 로트 없이 들어온 재고 → 유효기간 지난 로트 → 유효기간 빠른 로트 순으로 줄임 (보통 버린 것·쓴 것부터 빠지므로)
 *  - 늘었으면: 로트 없는 재고로 더함 (어느 로트인지 모르므로)
 */
function adjust(itemId, d, opts = {}) {
  return tx(() => {
    const item = getItem(itemId);
    const actual = r3(d.actualQty);
    if (!(actual >= 0)) throw badRequest('실제 수량: 0 이상으로 입력해 주세요.', { field: 'actualQty' });
    const { date, at } = stamp(opts);
    const delta = r3(actual - item.current_qty);
    const plan = [];
    if (delta < 0) {
      const lots = openLots(item.id);
      const lotSum = r3(lots.reduce((s, l) => s + l.qty_remaining, 0));
      let reduceLots = r3(lotSum - actual); // 로트 합계가 실제 수량보다 많으면 그만큼 로트에서 줄여야 함
      const expired = lots.filter((l) => l.expiry_date && l.expiry_date < date).sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
      const valid = lots.filter((l) => l.expiry_date && l.expiry_date >= date).sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
      const noExp = lots.filter((l) => !l.expiry_date);
      for (const l of [...expired, ...valid, ...noExp]) {
        if (reduceLots <= 0) break;
        const take = r3(Math.min(reduceLots, l.qty_remaining));
        run('UPDATE inv_lots SET qty_remaining = qty_remaining - ? WHERE id = ?', take, l.id);
        plan.push({ lotId: l.id, qty: take });
        reduceLots = r3(reduceLots - take);
      }
    }
    run('UPDATE inv_items SET current_qty = ?, updated_at = ? WHERE id = ?', actual, at, item.id);
    const moveId = insertMove({
      item_id: item.id,
      type: 'adjust',
      qty: delta,
      balance_after: actual,
      unit_price: null,
      lot_id: null,
      lot_no: null,
      expiry_date: null,
      lots_json: plan.length ? JSON.stringify(plan) : null,
      vendor_id: null,
      po_id: null,
      note: d.note || (delta === 0 ? '실사 확인 (차이 없음)' : null),
      user_id: opts.userId || null,
      move_date: date,
      created_at: at,
    });
    return { moveId, delta, warnings: [] };
  });
}

/**
 * 기록 취소(되돌리기): 그 품목의 "가장 마지막" 기록만 취소할 수 있습니다.
 * (중간 기록을 지우면 그 뒤 기록의 재고 숫자가 모두 틀어지기 때문)
 */
function undoMove(moveId) {
  return tx(() => {
    const m = get('SELECT * FROM inv_moves WHERE id = ?', moveId);
    if (!m) throw notFound('입출고 기록');
    if (m.po_id) throw badRequest('발주서로 입고한 기록은 여기서 취소할 수 없습니다. 수량이 틀렸다면 실사 조정으로 맞춰 주세요.');
    const last = get('SELECT id FROM inv_moves WHERE item_id = ? ORDER BY id DESC LIMIT 1', m.item_id);
    if (!last || last.id !== m.id) throw badRequest('이 품목의 가장 최근 기록만 취소할 수 있습니다. 이전 기록이 틀렸다면 실사 조정으로 맞춰 주세요.');
    const item = getItem(m.item_id);
    const plan = m.lots_json ? JSON.parse(m.lots_json) : [];
    if (m.type === 'in') {
      if (r3(item.current_qty - m.qty) < 0) throw badRequest('이미 사용한 수량이 있어 입고 기록을 취소할 수 없습니다.');
      for (const p of plan) if (p.lotId) run('UPDATE inv_lots SET qty_remaining = MAX(0, qty_remaining - ?) WHERE id = ?', p.qty, p.lotId);
    } else {
      // 출고·조정 취소: 뺐던 로트에 다시 돌려줌
      for (const p of plan) if (p.lotId) run('UPDATE inv_lots SET qty_remaining = qty_remaining + ? WHERE id = ?', p.qty, p.lotId);
    }
    const balance = r3(item.current_qty - m.qty);
    run('UPDATE inv_items SET current_qty = ?, updated_at = ? WHERE id = ?', balance, time.nowIso(), item.id);
    run('DELETE FROM inv_moves WHERE id = ?', m.id);
    // 이 입고로 새로 생긴 로트가 비었으면 정리
    if (m.type === 'in' && m.lot_id) {
      const used = get('SELECT COUNT(*) AS n FROM inv_moves WHERE lot_id = ?', m.lot_id).n;
      run('DELETE FROM inv_lots WHERE id = ? AND qty_remaining <= 0 AND ? = 0', m.lot_id, used);
    }
    return { item, move: m, balance };
  });
}

// ---------------- 경고 계산 ----------------
/** 재고 부족 품목: 적정 재고를 정해 둔 품목 중 현재 수량이 적정 이하 */
function lowStockItems() {
  return all(
    `SELECT i.*, v.name AS vendor_name FROM inv_items i LEFT JOIN vendors v ON v.id = i.vendor_id
     WHERE i.active = 1 AND i.min_qty > 0 AND i.current_qty <= i.min_qty
     ORDER BY (i.current_qty / i.min_qty), i.name`
  );
}

/** 유효기간 임박(오늘~30일 이내) 로트와 이미 지난 로트 (남은 수량이 있는 것만) */
function expiryLots(today = time.today()) {
  const rows = all(
    `SELECT l.*, i.name AS item_name, i.unit, i.spec, i.location FROM inv_lots l JOIN inv_items i ON i.id = l.item_id
     WHERE i.active = 1 AND l.qty_remaining > 0 AND l.expiry_date IS NOT NULL AND l.expiry_date <= ?
     ORDER BY l.expiry_date, i.name`,
    time.addDays(today, EXPIRY_SOON_DAYS)
  );
  const view = (l) => ({
    lotId: l.id,
    itemId: l.item_id,
    itemName: l.item_name,
    spec: l.spec,
    unit: l.unit,
    location: l.location,
    lotNo: l.lot_no,
    expiryDate: l.expiry_date,
    qty: r3(l.qty_remaining),
    days: time.diffDays(today, l.expiry_date),
  });
  return {
    expired: rows.filter((l) => l.expiry_date < today).map(view),
    expiring: rows.filter((l) => l.expiry_date >= today).map(view),
  };
}

/** 부족 품목 주문 수량: 정해 둔 발주 수량, 없으면 (적정 재고 × 2 − 현재 수량), 최소 1 */
function suggestedQty(item) {
  if (item.reorder_qty > 0) return r3(item.reorder_qty);
  return Math.max(1, Math.ceil(item.min_qty * 2 - item.current_qty));
}

/** 이미 진행 중인 발주서(작성 중·발주함)에 들어 있는 품목 → { item_id: 'PO-…' } */
function openPoItemMap() {
  const rows = all(
    `SELECT poi.item_id, po.po_no, po.status FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.po_id
     WHERE po.status IN ('draft','ordered') AND poi.received_qty < poi.qty`
  );
  const map = {};
  for (const r of rows) if (!map[r.item_id]) map[r.item_id] = { poNo: r.po_no, status: r.status };
  return map;
}

module.exports = {
  ITEM_CATEGORIES,
  VENDOR_CATEGORIES,
  ORDER_METHODS,
  MOVE_LABEL,
  EXPIRY_SOON_DAYS,
  r3,
  fmtQty,
  getItem,
  openLots,
  receive,
  consume,
  adjust,
  undoMove,
  consumptionPlan,
  recordPriceIfChanged,
  lowStockItems,
  expiryLots,
  suggestedQty,
  openPoItemMap,
};
