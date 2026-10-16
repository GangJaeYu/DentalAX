/*
 * 이 파일이 하는 일: 재고 품목·입출고·경고·단가·CSV 관련 API입니다. (/api/inventory/...)
 *
 *   GET    /meta                       분류·단위·거래처 목록 (선택칸용)
 *   GET    /items                      품목 목록 (q, category, low=1, status=expiring|expired, vendorId, archived=1)
 *   GET    /items.csv                  품목 CSV 내려받기
 *   GET    /items/template.csv         가져오기 양식
 *   POST   /items/import/preview       CSV 가져오기 미리보기 (실장 이상)  { text }
 *   POST   /items/import               CSV 가져오기 확정 (실장 이상)      { text }
 *   GET    /items/:id                  품목 상세 (로트, 최근 기록, 단가 기록, 진행 중 발주)
 *   POST   /items                      품목 추가 (실장 이상)
 *   PATCH  /items/:id                  품목 수정 (실장 이상)
 *   DELETE /items/:id                  품목 삭제 — 기록이 있으면 지우지 않고 "보관" (실장 이상)
 *   POST   /items/:id/in               입고 (누구나)
 *   POST   /items/:id/out              출고 (누구나)
 *   POST   /items/:id/adjust           실사 조정 (실장 이상)
 *   POST   /items/:id/prices           단가 직접 기록 (실장 이상)
 *   POST   /moves/bulk-in              여러 품목 한꺼번에 입고 (거래명세서 인식 후)
 *   GET    /moves                      입출고 기록 (type, itemId, from, to, q, page)
 *   GET    /moves.csv                  입출고 기록 CSV
 *   DELETE /moves/:id                  방금 한 기록 취소 (본인·당일 또는 실장 이상)
 *   GET    /alerts                     부족·임박·만료 목록
 *   GET    /prices                     단가 변동 목록
 */
const { all, get, run, tx, where } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, forbidden, badRequest, HttpError } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { requireRole, hasRole } = require('../../core/auth');
const { sendCsv } = require('../../core/csv');
const time = require('../../core/time');
const stock = require('./stock');
const views = require('./views');
const csvio = require('./csvimport');

const itemSchema = v.object({
  name: v.string({ min: 1, max: 100, label: '품목명' }),
  category: v.enum(stock.ITEM_CATEGORIES, { optional: true, default: '소모품', label: '분류' }),
  unit: v.string({ max: 20, optional: true, default: '개', label: '단위' }),
  spec: v.string({ max: 100, optional: true, label: '규격' }),
  vendorId: v.id({ optional: true, label: '거래처' }),
  minQty: v.number({ min: 0, max: 1000000, optional: true, default: 0, label: '적정 재고' }),
  reorderQty: v.number({ min: 0, max: 1000000, optional: true, default: 0, label: '발주 수량' }),
  location: v.string({ max: 100, optional: true, label: '보관 위치' }),
  trackExpiry: v.bool(),
  lastUnitPrice: v.int({ min: 0, max: 1000000000, optional: true, label: '단가' }),
  memo: v.string({ max: 1000, optional: true, label: '메모' }),
});
const createSchema = v.object({ initialQty: v.number({ min: 0, max: 1000000, optional: true, label: '시작 재고' }) });

// 0 이하 수량은 stock.js 에서 "0보다 큰 수량을 입력해 주세요"로 안내
const qtyField = (label = '수량') => v.number({ min: 0, max: 1000000, label });
const inSchema = v.object({
  qty: qtyField(),
  unitPrice: v.int({ min: 0, max: 1000000000, optional: true, label: '단가' }),
  lotNo: v.string({ max: 50, optional: true, label: '로트 번호' }),
  expiryDate: v.date({ optional: true, label: '유효기간' }),
  vendorId: v.id({ optional: true, label: '거래처' }),
  note: v.string({ max: 300, optional: true, label: '메모' }),
});
const outSchema = v.object({
  qty: qtyField(),
  lotId: v.id({ optional: true, label: '로트' }),
  note: v.string({ max: 300, optional: true, label: '메모' }),
});
const adjustSchema = v.object({
  actualQty: v.number({ min: 0, max: 1000000, label: '실제 수량' }),
  note: v.string({ max: 300, optional: true, label: '메모' }),
});
const bulkSchema = v.object({
  vendorId: v.id({ optional: true, label: '거래처' }),
  note: v.string({ max: 300, optional: true, label: '메모' }),
  lines: v.array(
    v.object({
      itemId: v.id({ optional: true, label: '품목' }),
      newItem: v.object(
        {
          name: v.string({ min: 1, max: 100, label: '새 품목 이름' }),
          spec: v.string({ max: 100, optional: true, label: '규격' }),
          unit: v.string({ max: 20, optional: true, default: '개', label: '단위' }),
          category: v.enum(stock.ITEM_CATEGORIES, { optional: true, default: '기타', label: '분류' }),
        },
        { optional: true }
      ),
      qty: qtyField(),
      unitPrice: v.int({ min: 0, max: 1000000000, optional: true, label: '단가' }),
      lotNo: v.string({ max: 50, optional: true, label: '로트 번호' }),
      expiryDate: v.date({ optional: true, label: '유효기간' }),
    }),
    { min: 1, max: 100, label: '입고 품목' }
  ),
});

function checkVendor(id) {
  if (id && !get('SELECT id FROM vendors WHERE id = ?', id)) throw badRequest('거래처: 선택한 거래처를 찾을 수 없습니다.', { field: 'vendorId' });
}

function itemOr404(id) {
  const i = views.getItemView(id);
  if (!i) throw notFound('품목');
  return i;
}

/** 이 사람이 이 기록을 취소할 수 있는지: 실장 이상은 최근 7일 기록, 직원은 본인이 오늘 남긴 기록 */
function canUndo(user, m) {
  if (!m || m.po_id) return false;
  if (hasRole(user, 'manager')) return m.move_date >= time.addDays(time.today(), -7);
  return m.user_id === user.id && m.move_date === time.today();
}

/** 입출고 기록 검색 조건 (목록과 CSV에서 같이 씀) */
function moveFilter(q) {
  const type = ['in', 'out', 'adjust'].includes(q.type) ? q.type : null;
  const itemId = Number(q.itemId) > 0 ? Number(q.itemId) : null;
  const from = time.isValidDate(q.from) ? q.from : null;
  const to = time.isValidDate(q.to) ? q.to : null;
  const w = where([
    [type && 'm.type = :type'],
    [itemId && 'm.item_id = :itemId'],
    [from && 'm.move_date >= :from'],
    [to && 'm.move_date <= :to'],
    [q.q && '(i.name LIKE :q OR m.note LIKE :q OR m.lot_no LIKE :q)'],
  ]);
  return { sql: w.sql, params: { type, itemId, from, to, q: q.q ? `%${q.q}%` : null } };
}

function register(r) {
  const manager = requireRole('manager');

  // ---------- 선택칸용 기본 정보 ----------
  r.get('/meta', (req, res) => {
    res.json({
      itemCategories: stock.ITEM_CATEGORIES,
      vendorCategories: stock.VENDOR_CATEGORIES,
      orderMethods: stock.ORDER_METHODS,
      units: [...new Set(['개', '박스', '봉', '팩', '통', '병', '세트', '롤', '매', ...all('SELECT DISTINCT unit FROM inv_items ORDER BY unit').map((x) => x.unit)])],
      vendors: all('SELECT id, name, category, active FROM vendors ORDER BY active DESC, name').map((x) => ({ id: x.id, name: x.name, category: x.category, active: !!x.active })),
      expirySoonDays: stock.EXPIRY_SOON_DAYS,
    });
  });

  // ---------- 품목 목록 ----------
  r.get('/items', (req, res) => {
    const q = req.query;
    const today = time.today();
    const soon = time.addDays(today, stock.EXPIRY_SOON_DAYS);
    const category = stock.ITEM_CATEGORIES.includes(q.category) ? q.category : null;
    const vendorId = Number(q.vendorId) > 0 ? Number(q.vendorId) : null;
    const w = where([
      [q.archived === '1' ? 'i.active = 0' : 'i.active = 1'],
      [q.q && '(i.name LIKE :q OR i.spec LIKE :q OR i.location LIKE :q OR v.name LIKE :q)'],
      [category && 'i.category = :category'],
      [vendorId && 'i.vendor_id = :vendorId'],
      [q.low === '1' && 'i.min_qty > 0 AND i.current_qty <= i.min_qty'],
      [q.status === 'expiring' && 'EXISTS (SELECT 1 FROM inv_lots l WHERE l.item_id = i.id AND l.qty_remaining > 0 AND l.expiry_date >= :today AND l.expiry_date <= :soon)'],
      [q.status === 'expired' && 'EXISTS (SELECT 1 FROM inv_lots l WHERE l.item_id = i.id AND l.qty_remaining > 0 AND l.expiry_date < :today)'],
    ]);
    const params = { q: q.q ? `%${q.q}%` : null, category, vendorId, today, soon };
    const rows = all(`${views.ITEM_SQL} ${w.sql} ORDER BY (i.min_qty > 0 AND i.current_qty <= i.min_qty) DESC, i.category, i.name, i.spec`, params).map((i) => views.itemView(i, today));
    // 위쪽 숫자 카드용 요약 (검색 조건과 상관없이 전체 기준)
    const summary = {
      total: get('SELECT COUNT(*) AS n FROM inv_items WHERE active = 1').n,
      low: get('SELECT COUNT(*) AS n FROM inv_items WHERE active = 1 AND min_qty > 0 AND current_qty <= min_qty').n,
      expiring: get(
        'SELECT COUNT(DISTINCT l.item_id) AS n FROM inv_lots l JOIN inv_items i ON i.id = l.item_id WHERE i.active = 1 AND l.qty_remaining > 0 AND l.expiry_date >= ? AND l.expiry_date <= ?',
        today,
        soon
      ).n,
      expired: get('SELECT COUNT(DISTINCT l.item_id) AS n FROM inv_lots l JOIN inv_items i ON i.id = l.item_id WHERE i.active = 1 AND l.qty_remaining > 0 AND l.expiry_date < ?', today).n,
      archived: get('SELECT COUNT(*) AS n FROM inv_items WHERE active = 0').n,
      stockValue: Math.round(get('SELECT COALESCE(SUM(current_qty * COALESCE(last_unit_price, 0)), 0) AS n FROM inv_items WHERE active = 1').n),
    };
    const categories = Object.fromEntries(all('SELECT category, COUNT(*) AS n FROM inv_items WHERE active = 1 GROUP BY category').map((x) => [x.category, x.n]));
    res.json({ rows, total: rows.length, summary, categories });
  });

  // ---------- CSV (주소가 /items/:id 와 겹치지 않게 먼저 등록) ----------
  r.get('/items.csv', (req, res) => {
    const rows = all(`${views.ITEM_SQL} WHERE i.active = 1 ORDER BY i.category, i.name`, { today: time.today() });
    sendCsv(res, `재고품목_${time.today()}.csv`, csvio.itemsCsv(rows));
  });
  r.get('/items/template.csv', (req, res) => {
    sendCsv(res, '재고품목_가져오기_양식.csv', csvio.templateCsv());
  });
  const importSchema = v.object({ text: v.string({ min: 1, max: 2000000, trim: false, label: 'CSV 내용' }) });
  r.post('/items/import/preview', manager, (req, res) => {
    const { text } = importSchema.parse(req.body);
    res.json(csvio.analyze(text));
  });
  r.post('/items/import', manager, (req, res) => {
    const { text } = importSchema.parse(req.body);
    const result = csvio.commit(text, req.user.id);
    audit(req, 'import', 'inv_items', null, `CSV 가져오기: 새 품목 ${result.created}개, 수정 ${result.updated}개, 건너뜀 ${result.skipped}줄`);
    res.json(result);
  });

  // ---------- 품목 상세 ----------
  r.get('/items/:id', (req, res) => {
    const id = idParam(req.params.id);
    const item = itemOr404(id);
    const today = time.today();
    const lots = all(
      `SELECT * FROM inv_lots WHERE item_id = ? AND qty_remaining > 0 ORDER BY (expiry_date IS NULL), expiry_date, id`,
      id
    ).map((l) => ({
      id: l.id,
      lotNo: l.lot_no,
      expiryDate: l.expiry_date,
      qty: stock.r3(l.qty_remaining),
      receivedAt: l.received_at,
      days: l.expiry_date ? time.diffDays(today, l.expiry_date) : null,
    }));
    const lotSum = stock.r3(lots.reduce((s, l) => s + l.qty, 0));
    const moves = all(`${views.MOVE_SQL} WHERE m.item_id = ? ORDER BY m.id DESC LIMIT 30`, id).map(views.moveView);
    const latest = get('SELECT * FROM inv_moves WHERE item_id = ? ORDER BY id DESC LIMIT 1', id);
    const prices = all(
      `SELECT p.*, v.name AS vendor_name FROM inv_prices p LEFT JOIN vendors v ON v.id = p.vendor_id WHERE p.item_id = ? ORDER BY p.recorded_at, p.id`,
      id
    ).map((p) => ({ id: p.id, unitPrice: p.unit_price, date: p.recorded_at, source: p.source, vendorName: p.vendor_name || null }));
    const openPos = all(
      `SELECT po.id, po.po_no, po.status, po.expected_date, x.qty, x.received_qty FROM purchase_order_items x JOIN purchase_orders po ON po.id = x.po_id
       WHERE x.item_id = ? AND po.status IN ('draft','ordered') ORDER BY po.id DESC`,
      id
    ).map((p) => ({ id: p.id, poNo: p.po_no, status: p.status, statusLabel: views.PO_STATUS_LABEL[p.status], expectedDate: p.expected_date, qty: stock.r3(p.qty), receivedQty: stock.r3(p.received_qty) }));
    const usage30 = stock.r3(
      -get("SELECT COALESCE(SUM(qty), 0) AS n FROM inv_moves WHERE item_id = ? AND type = 'out' AND move_date >= ?", id, time.addDays(today, -30)).n
    );
    res.json({
      ...item,
      lots,
      untrackedQty: Math.max(0, stock.r3(item.currentQty - lotSum)),
      moves,
      prices,
      openPos,
      usage30,
      suggestedQty: stock.suggestedQty({ reorder_qty: item.reorderQty, min_qty: item.minQty, current_qty: item.currentQty }),
      undoMoveId: canUndo(req.user, latest) ? latest.id : null,
    });
  });

  // ---------- 품목 추가·수정·삭제 (실장 이상) ----------
  r.post('/items', manager, (req, res) => {
    const d = itemSchema.parse(req.body);
    const { initialQty } = createSchema.parse(req.body);
    checkVendor(d.vendorId);
    const dup = get("SELECT id FROM inv_items WHERE lower(name) = lower(?) AND IFNULL(lower(spec), '') = IFNULL(lower(?), '')", d.name, d.spec || null);
    if (dup) throw new HttpError(409, '같은 이름과 규격의 품목이 이미 있습니다. 기존 품목을 수정하거나 규격을 다르게 적어 주세요.', { field: 'name' });
    const now = time.nowIso();
    const id = tx(() => {
      const nid = run(
        `INSERT INTO inv_items (name, category, unit, spec, vendor_id, min_qty, reorder_qty, location, current_qty, track_expiry, last_unit_price, memo, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?)`,
        d.name,
        d.category,
        d.unit || '개',
        d.spec,
        d.vendorId,
        d.minQty,
        d.reorderQty,
        d.location,
        d.trackExpiry,
        d.lastUnitPrice,
        d.memo,
        now,
        now
      ).lastInsertRowid;
      if (d.lastUnitPrice != null) run("INSERT INTO inv_prices (item_id, vendor_id, unit_price, recorded_at, source) VALUES (?, ?, ?, ?, '수동')", nid, d.vendorId, d.lastUnitPrice, time.today());
      if (initialQty > 0) stock.adjust(nid, { actualQty: initialQty, note: '처음 등록할 때의 재고' }, { userId: req.user.id });
      return nid;
    });
    audit(req, 'create', 'inv_items', id, `품목 추가: ${d.name}${d.spec ? ` (${d.spec})` : ''}`);
    res.status(201).json(views.getItemView(id));
  });

  r.patch('/items/:id', manager, (req, res) => {
    const id = idParam(req.params.id);
    const old = stock.getItem(id);
    const d = itemSchema.partial().parse(req.body);
    if ('vendorId' in d) checkVendor(d.vendorId);
    const active = req.body.active === undefined ? old.active : v.bool()(req.body.active) ? 1 : 0;
    const next = {
      name: d.name ?? old.name,
      category: d.category ?? old.category,
      unit: d.unit || old.unit,
      spec: 'spec' in d ? d.spec : old.spec,
      vendor_id: 'vendorId' in d ? d.vendorId : old.vendor_id,
      min_qty: d.minQty ?? old.min_qty,
      reorder_qty: d.reorderQty ?? old.reorder_qty,
      location: 'location' in d ? d.location : old.location,
      track_expiry: 'trackExpiry' in d ? (d.trackExpiry ? 1 : 0) : old.track_expiry,
      last_unit_price: 'lastUnitPrice' in d ? d.lastUnitPrice : old.last_unit_price,
      memo: 'memo' in d ? d.memo : old.memo,
    };
    const dup = get(
      "SELECT id FROM inv_items WHERE id != ? AND lower(name) = lower(?) AND IFNULL(lower(spec), '') = IFNULL(lower(?), '')",
      id,
      next.name,
      next.spec || null
    );
    if (dup) throw new HttpError(409, '같은 이름과 규격의 품목이 이미 있습니다.', { field: 'name' });
    tx(() => {
      run(
        `UPDATE inv_items SET name = :name, category = :category, unit = :unit, spec = :spec, vendor_id = :vendor_id, min_qty = :min_qty, reorder_qty = :reorder_qty,
           location = :location, track_expiry = :track_expiry, last_unit_price = :last_unit_price, memo = :memo, active = :active, updated_at = :now WHERE id = :id`,
        { ...next, active, now: time.nowIso(), id }
      );
      // 단가를 직접 바꿨으면 단가 기록에도 남김
      if ('lastUnitPrice' in d && d.lastUnitPrice != null && d.lastUnitPrice !== old.last_unit_price) {
        stock.recordPriceIfChanged(old, d.lastUnitPrice, next.vendor_id, time.today(), '수동');
      }
    });
    const what = active !== old.active ? (active ? ' (보관 해제)' : ' (보관)') : '';
    audit(req, 'update', 'inv_items', id, `품목 수정: ${next.name}${what}`);
    res.json(views.getItemView(id));
  });

  r.delete('/items/:id', manager, (req, res) => {
    const id = idParam(req.params.id);
    const item = stock.getItem(id);
    const used = get('SELECT (SELECT COUNT(*) FROM inv_moves WHERE item_id = ?) + (SELECT COUNT(*) FROM purchase_order_items WHERE item_id = ?) AS n', id, id).n;
    if (used > 0) {
      // 기록이 남아 있는 품목은 지우면 과거 기록이 사라지므로 "보관"으로 대신함
      run('UPDATE inv_items SET active = 0, updated_at = ? WHERE id = ?', time.nowIso(), id);
      audit(req, 'update', 'inv_items', id, `품목 보관(입출고 기록이 있어 삭제 대신): ${item.name}`);
      return res.json({ ok: true, archived: true, message: '입출고·발주 기록이 있어 삭제하지 않고 보관했습니다. 보관함에서 다시 꺼낼 수 있습니다.' });
    }
    run('DELETE FROM inv_items WHERE id = ?', id);
    audit(req, 'delete', 'inv_items', id, `품목 삭제: ${item.name}`);
    res.json({ ok: true, archived: false });
  });

  // ---------- 입고·출고·실사 조정 ----------
  r.post('/items/:id/in', (req, res) => {
    const id = idParam(req.params.id);
    const d = inSchema.parse(req.body);
    checkVendor(d.vendorId);
    const { moveId, warnings } = stock.receive(id, d, { userId: req.user.id });
    const item = views.getItemView(id);
    audit(req, 'create', 'inv_moves', moveId, `입고: ${item.name} ${stock.fmtQty(d.qty)}${item.unit}`);
    res.status(201).json({ item, move: views.moveView(get(`${views.MOVE_SQL} WHERE m.id = ?`, moveId)), warnings });
  });

  r.post('/items/:id/out', (req, res) => {
    const id = idParam(req.params.id);
    const d = outSchema.parse(req.body);
    const { moveId, warnings } = stock.consume(id, d, { userId: req.user.id });
    const item = views.getItemView(id);
    audit(req, 'create', 'inv_moves', moveId, `출고: ${item.name} ${stock.fmtQty(d.qty)}${item.unit}${d.lotId ? ' (로트 지정)' : ''}`);
    res.status(201).json({ item, move: views.moveView(get(`${views.MOVE_SQL} WHERE m.id = ?`, moveId)), warnings });
  });

  r.post('/items/:id/adjust', manager, (req, res) => {
    const id = idParam(req.params.id);
    const d = adjustSchema.parse(req.body);
    const before = stock.getItem(id);
    const { moveId, delta } = stock.adjust(id, d, { userId: req.user.id });
    const item = views.getItemView(id);
    audit(req, 'update', 'inv_moves', moveId, `실사 조정: ${item.name} ${stock.fmtQty(before.current_qty)} → ${stock.fmtQty(d.actualQty)}${item.unit}`);
    res.status(201).json({ item, delta, move: views.moveView(get(`${views.MOVE_SQL} WHERE m.id = ?`, moveId)) });
  });

  r.post('/items/:id/prices', manager, (req, res) => {
    const id = idParam(req.params.id);
    const item = stock.getItem(id);
    const d = v
      .object({
        unitPrice: v.int({ min: 0, max: 1000000000, label: '단가' }),
        date: v.date({ optional: true, label: '날짜' }),
        vendorId: v.id({ optional: true, label: '거래처' }),
      })
      .parse(req.body);
    checkVendor(d.vendorId);
    const date = d.date || time.today();
    tx(() => {
      run("INSERT INTO inv_prices (item_id, vendor_id, unit_price, recorded_at, source) VALUES (?, ?, ?, ?, '수동')", id, d.vendorId || item.vendor_id, d.unitPrice, date);
      run('UPDATE inv_items SET last_unit_price = ?, updated_at = ? WHERE id = ?', d.unitPrice, time.nowIso(), id);
    });
    audit(req, 'create', 'inv_prices', id, `단가 기록: ${item.name} ${d.unitPrice.toLocaleString('ko-KR')}원`);
    res.status(201).json(views.getItemView(id));
  });

  // ---------- 여러 품목 한꺼번에 입고 (거래명세서) ----------
  r.post('/moves/bulk-in', (req, res) => {
    const d = bulkSchema.parse(req.body);
    checkVendor(d.vendorId);
    if (d.lines.some((l) => !l.itemId && !l.newItem)) throw badRequest('연결할 품목을 고르지 않은 줄이 있습니다. 품목을 고르거나 그 줄을 빼 주세요.');
    if (d.lines.some((l) => !l.itemId && l.newItem) && !hasRole(req.user, 'manager')) throw forbidden();
    const now = time.nowIso();
    const result = tx(() => {
      const moves = [];
      let created = 0;
      for (const l of d.lines) {
        let itemId = l.itemId;
        if (!itemId) {
          const exists = get(
            "SELECT id FROM inv_items WHERE lower(name) = lower(?) AND IFNULL(lower(spec), '') = IFNULL(lower(?), '')",
            l.newItem.name,
            l.newItem.spec || null
          );
          itemId = exists
            ? exists.id
            : run(
                `INSERT INTO inv_items (name, category, unit, spec, vendor_id, track_expiry, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
                l.newItem.name,
                l.newItem.category,
                l.newItem.unit || '개',
                l.newItem.spec,
                d.vendorId,
                l.expiryDate ? 1 : 0,
                now,
                now
              ).lastInsertRowid;
          if (!exists) created++;
        }
        const r1 = stock.receive(itemId, { ...l, vendorId: d.vendorId, note: d.note || '거래명세서 입고' }, { userId: req.user.id });
        moves.push(r1.moveId);
      }
      return { moves, created };
    });
    audit(req, 'create', 'inv_moves', null, `거래명세서 입고: ${d.lines.length}개 품목${result.created ? ` (새 품목 ${result.created}개 등록)` : ''}`);
    res.status(201).json({ count: result.moves.length, created: result.created, moveIds: result.moves });
  });

  // ---------- 입출고 기록 ----------
  r.get('/moves', (req, res) => {
    const f = moveFilter(req.query);
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = 50;
    const total = get(`SELECT COUNT(*) AS n FROM inv_moves m JOIN inv_items i ON i.id = m.item_id ${f.sql}`, f.params).n;
    const rows = all(`${views.MOVE_SQL} ${f.sql} ORDER BY m.created_at DESC, m.id DESC LIMIT :limit OFFSET :offset`, { ...f.params, limit: size, offset: (page - 1) * size });
    // 각 품목의 가장 마지막 기록만 취소 가능 → 화면에 [취소] 버튼을 보여 줄 기록 표시
    const lastIds = new Set(all('SELECT MAX(id) AS id FROM inv_moves GROUP BY item_id').map((x) => x.id));
    res.json({
      rows: rows.map((m) => ({ ...views.moveView(m), canUndo: lastIds.has(m.id) && canUndo(req.user, m) })),
      total,
      page,
      size,
    });
  });

  r.get('/moves.csv', (req, res) => {
    const f = moveFilter(req.query);
    const rows = all(`${views.MOVE_SQL} ${f.sql} ORDER BY m.created_at DESC, m.id DESC LIMIT 20000`, f.params);
    sendCsv(res, `입출고기록_${time.today()}.csv`, csvio.movesCsv(rows));
  });

  r.delete('/moves/:id', (req, res) => {
    const id = idParam(req.params.id);
    const m = get('SELECT * FROM inv_moves WHERE id = ?', id);
    if (!m) throw notFound('입출고 기록');
    if (!canUndo(req.user, m)) {
      if (m.po_id) throw badRequest('발주서로 입고한 기록은 여기서 취소할 수 없습니다. 수량이 틀렸다면 실사 조정으로 맞춰 주세요.');
      throw forbidden();
    }
    const { item, balance } = stock.undoMove(id);
    audit(req, 'delete', 'inv_moves', id, `기록 취소: ${item.name} ${stock.MOVE_LABEL[m.type]} ${stock.fmtQty(Math.abs(m.qty))}${item.unit} (재고 ${stock.fmtQty(balance)}${item.unit})`);
    res.json({ ok: true, item: views.getItemView(item.id) });
  });

  // ---------- 경고 ----------
  r.get('/alerts', (req, res) => {
    const today = time.today();
    const openPo = stock.openPoItemMap();
    const low = stock.lowStockItems().map((i) => ({
      ...views.itemView(i, today),
      suggestedQty: stock.suggestedQty(i),
      openPo: openPo[i.id] || null,
    }));
    const { expired, expiring } = stock.expiryLots(today);
    res.json({ low, expiring, expired, expirySoonDays: stock.EXPIRY_SOON_DAYS });
  });

  // ---------- 단가 변동 ----------
  r.get('/prices', (req, res) => {
    const rows = all(
      `SELECT p.*, i.name, i.spec, i.unit, i.last_unit_price, v.name AS vendor_name FROM inv_prices p
       JOIN inv_items i ON i.id = p.item_id LEFT JOIN vendors v ON v.id = i.vendor_id
       WHERE i.active = 1 ORDER BY p.item_id, p.recorded_at, p.id`
    );
    const byItem = new Map();
    for (const p of rows) {
      if (!byItem.has(p.item_id)) byItem.set(p.item_id, { itemId: p.item_id, name: p.name, spec: p.spec || '', unit: p.unit, vendorName: p.vendor_name || null, series: [] });
      byItem.get(p.item_id).series.push({ date: p.recorded_at, price: p.unit_price, source: p.source });
    }
    const out = [...byItem.values()].map((x) => {
      const s = x.series;
      const latest = s[s.length - 1];
      // 직전 "다른" 단가를 찾아 변동률 계산
      let prev = null;
      for (let i = s.length - 2; i >= 0; i--) {
        if (s[i].price !== latest.price) {
          prev = s[i];
          break;
        }
      }
      const changePct = prev && prev.price > 0 ? Math.round(((latest.price - prev.price) / prev.price) * 1000) / 10 : null;
      const first = s[0];
      return {
        ...x,
        series: s.slice(-12),
        count: s.length,
        latestPrice: latest.price,
        latestDate: latest.date,
        previousPrice: prev ? prev.price : null,
        previousDate: prev ? prev.date : null,
        changePct,
        firstPrice: first.price,
        totalChangePct: first.price > 0 && s.length > 1 ? Math.round(((latest.price - first.price) / first.price) * 1000) / 10 : null,
      };
    });
    out.sort((a, b) => (b.changePct !== null) - (a.changePct !== null) || String(b.latestDate).localeCompare(String(a.latestDate)) || a.name.localeCompare(b.name));
    res.json({ rows: out, changed: out.filter((x) => x.changePct !== null).length });
  });
}

module.exports = { register };
