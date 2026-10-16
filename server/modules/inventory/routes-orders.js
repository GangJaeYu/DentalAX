/*
 * 이 파일이 하는 일: 발주서 API입니다. (/api/inventory/orders/...) — 모두 실장 이상만 쓸 수 있습니다.
 *
 * 발주서 흐름:  작성 중(draft) → 발주함(ordered) → 입고 완료(received)
 *                     └──────────── 취소(cancelled) ←──┘
 *
 *   GET    /orders                    목록 (status, q, vendorId)
 *   GET    /orders/auto-preview       부족 품목을 거래처별로 묶은 "발주서 초안" 미리보기
 *   POST   /orders/auto               미리보기 내용(수정 가능)으로 작성 중 발주서 여러 개 만들기
 *   GET    /orders/:id                상세 (품목 줄, 거래처 정보)
 *   POST   /orders                    새 발주서 (작성 중)
 *   PATCH  /orders/:id                수정 (작성 중: 모두 / 발주함: 입고 예정일·메모만)
 *   POST   /orders/:id/order          발주함으로 표시
 *   POST   /orders/:id/receive        입고 처리 (줄마다 전부 또는 일부) → 재고 입고 기록 + 단가 기록
 *   POST   /orders/:id/cancel         취소
 *   DELETE /orders/:id                삭제 (작성 중·취소만)
 */
const { all, get, run, tx, where } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, badRequest, HttpError } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { requireRole } = require('../../core/auth');
const time = require('../../core/time');
const stock = require('./stock');
const views = require('./views');

const lineSchema = v.object({
  itemId: v.id({ label: '품목' }),
  qty: v.number({ min: 0, max: 1000000, label: '수량' }),
  unitPrice: v.int({ min: 0, max: 1000000000, optional: true, label: '단가' }),
});
const poSchema = v.object({
  vendorId: v.id({ optional: true, label: '거래처' }),
  orderDate: v.date({ optional: true, label: '발주일' }),
  expectedDate: v.date({ optional: true, label: '입고 예정일' }),
  note: v.string({ max: 1000, optional: true, label: '메모' }),
  items: v.array(lineSchema, { optional: true, max: 200, label: '품목' }),
});
const receiveSchema = v.object({
  lines: v.array(
    v.object({
      lineId: v.id({ label: '품목 줄' }),
      qty: v.number({ min: 0, max: 1000000, label: '입고 수량' }),
      unitPrice: v.int({ min: 0, max: 1000000000, optional: true, label: '단가' }),
      lotNo: v.string({ max: 50, optional: true, label: '로트 번호' }),
      expiryDate: v.date({ optional: true, label: '유효기간' }),
    }),
    { optional: true, max: 200, label: '입고 품목' }
  ),
  all: v.bool(), // true: 남은 수량을 모두 입고
  close: v.bool(), // true: 덜 온 수량은 더 받지 않고 입고 완료로 마감
  date: v.date({ optional: true, label: '입고일' }),
});

/** 오늘 날짜로 다음 발주번호 만들기: PO-20261016-01, -02 … */
function nextPoNo(date = time.today()) {
  const prefix = `PO-${date.replace(/-/g, '')}-`;
  const rows = all('SELECT po_no FROM purchase_orders WHERE po_no LIKE ?', `${prefix}%`);
  const max = rows.reduce((m, r) => Math.max(m, Number(r.po_no.slice(prefix.length)) || 0), 0);
  return prefix + String(max + 1).padStart(2, '0');
}

function poOr404(id) {
  const p = get('SELECT * FROM purchase_orders WHERE id = ?', id);
  if (!p) throw notFound('발주서');
  return p;
}

function checkVendor(id) {
  if (id && !get('SELECT id FROM vendors WHERE id = ?', id)) throw badRequest('거래처: 선택한 거래처를 찾을 수 없습니다.', { field: 'vendorId' });
}

/** 같은 품목이 두 줄이면 합치고, 단가가 비어 있으면 품목의 최근 단가를 씀 */
function normalizeLines(items) {
  const merged = new Map();
  for (const l of items || []) {
    if (!(l.qty > 0)) throw badRequest('수량: 0보다 큰 수량을 입력해 주세요. 필요 없는 품목은 줄을 지워 주세요.', { field: 'items' });
    const item = get('SELECT id, name, last_unit_price FROM inv_items WHERE id = ?', l.itemId);
    if (!item) throw badRequest('품목: 발주서에 넣은 품목을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.', { field: 'items' });
    const prev = merged.get(l.itemId);
    if (prev) prev.qty = stock.r3(prev.qty + l.qty);
    else merged.set(l.itemId, { itemId: l.itemId, qty: stock.r3(l.qty), unitPrice: l.unitPrice ?? item.last_unit_price ?? null });
  }
  return [...merged.values()];
}

function replaceLines(poId, lines) {
  run('DELETE FROM purchase_order_items WHERE po_id = ?', poId);
  for (const l of lines) run('INSERT INTO purchase_order_items (po_id, item_id, qty, unit_price, received_qty) VALUES (?, ?, ?, ?, 0)', poId, l.itemId, l.qty, l.unitPrice);
}

/** 발주서 만들기 (자동 발주·직접 작성·데모 데이터가 같이 씀) */
function createPo({ vendorId, orderDate, expectedDate, note, items, status = 'draft' }, userId, opts = {}) {
  return tx(() => {
    const at = opts.at || time.nowIso();
    const date = opts.date || time.today();
    const lines = normalizeLines(items);
    const id = run(
      `INSERT INTO purchase_orders (po_no, vendor_id, status, order_date, expected_date, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      nextPoNo(date),
      vendorId || null,
      status,
      orderDate || null,
      expectedDate || null,
      note || null,
      userId || null,
      at,
      at
    ).lastInsertRowid;
    replaceLines(id, lines);
    return id;
  });
}

/**
 * 입고 처리: 줄마다 받은 수량만큼 재고 입고 기록을 만들고, 모든 줄을 다 받으면 "입고 완료"로 바꿉니다.
 * @returns {{ received: number, completed: boolean, warnings: string[] }}
 */
function receivePo(poId, d, userId, opts = {}) {
  return tx(() => {
    const po = poOr404(poId);
    if (po.status !== 'ordered') {
      throw badRequest(po.status === 'draft' ? '아직 발주하지 않은 발주서입니다. 먼저 [발주함으로 표시]를 눌러 주세요.' : '이미 입고 완료되었거나 취소된 발주서입니다.');
    }
    const lines = all('SELECT x.*, i.name FROM purchase_order_items x JOIN inv_items i ON i.id = x.item_id WHERE x.po_id = ?', poId);
    const byId = new Map(lines.map((l) => [l.id, l]));
    let todo = [];
    if (d.all) {
      todo = lines.filter((l) => l.qty - l.received_qty > 0).map((l) => ({ lineId: l.id, qty: stock.r3(l.qty - l.received_qty) }));
    } else {
      for (const x of d.lines || []) {
        if (!byId.has(x.lineId)) throw badRequest('이 발주서에 없는 품목 줄이 들어 있습니다. 화면을 새로고침해 주세요.');
        if (x.qty > 0) todo.push(x);
      }
    }
    if (!todo.length && !d.close) throw badRequest('입고할 수량을 하나 이상 입력해 주세요.');
    const warnings = [];
    for (const x of todo) {
      const l = byId.get(x.lineId);
      const price = x.unitPrice ?? l.unit_price ?? null;
      const r = stock.receive(
        l.item_id,
        { qty: x.qty, unitPrice: price, lotNo: x.lotNo, expiryDate: x.expiryDate, vendorId: po.vendor_id, poId, note: `발주서 ${po.po_no} 입고` },
        { userId, date: opts.date || d.date, at: opts.at }
      );
      warnings.push(...r.warnings.map((w) => `${l.name}: ${w}`));
      run('UPDATE purchase_order_items SET received_qty = received_qty + ? WHERE id = ?', x.qty, l.id);
    }
    const left = get('SELECT COUNT(*) AS n FROM purchase_order_items WHERE po_id = ? AND received_qty < qty', poId).n;
    const completed = left === 0 || d.close;
    const date = opts.date || d.date || time.today();
    run(
      'UPDATE purchase_orders SET status = ?, received_date = ?, updated_at = ? WHERE id = ?',
      completed ? 'received' : 'ordered',
      completed ? date : po.received_date,
      opts.at || time.nowIso(),
      poId
    );
    return { received: todo.length, completed, warnings };
  });
}

/** 부족 품목 → 거래처별 묶음 (자동 발주 미리보기) */
function autoPreview() {
  const openPo = stock.openPoItemMap();
  const low = stock.lowStockItems();
  const groups = new Map();
  const skipped = [];
  for (const i of low) {
    if (openPo[i.id]) {
      skipped.push({ itemId: i.id, name: i.name, spec: i.spec || '', poNo: openPo[i.id].poNo, status: openPo[i.id].status });
      continue;
    }
    const key = i.vendor_id || 0;
    if (!groups.has(key)) {
      const vend = i.vendor_id ? get('SELECT * FROM vendors WHERE id = ?', i.vendor_id) : null;
      groups.set(key, {
        vendorId: vend ? vend.id : null,
        vendorName: vend ? vend.name : null,
        orderMethod: vend ? vend.order_method : null,
        phone: vend ? vend.phone : null,
        note: vend ? null : '거래처가 정해지지 않은 품목입니다. 발주서를 만든 뒤 거래처를 지정하거나, 품목 정보에 거래처를 넣어 주세요.',
        items: [],
      });
    }
    const qty = stock.suggestedQty(i);
    groups.get(key).items.push({
      itemId: i.id,
      name: i.name,
      spec: i.spec || '',
      unit: i.unit,
      currentQty: stock.r3(i.current_qty),
      minQty: stock.r3(i.min_qty),
      reorderQty: stock.r3(i.reorder_qty),
      qty,
      unitPrice: i.last_unit_price,
      amount: Math.round(qty * (i.last_unit_price || 0)),
    });
  }
  // 거래처 있는 묶음 먼저, 거래처 없는 묶음은 맨 뒤
  const list = [...groups.values()].sort((a, b) => (a.vendorId ? 0 : 1) - (b.vendorId ? 0 : 1) || String(a.vendorName).localeCompare(String(b.vendorName)));
  for (const g of list) g.total = g.items.reduce((s, x) => s + x.amount, 0);
  return { groups: list, skipped, itemCount: list.reduce((s, g) => s + g.items.length, 0) };
}

function detail(id) {
  const po = views.getPoView(id);
  if (!po) throw notFound('발주서');
  const vend = po.vendorId ? get('SELECT * FROM vendors WHERE id = ?', po.vendorId) : null;
  const moves = all(`${views.MOVE_SQL} WHERE m.po_id = ? ORDER BY m.id`, id).map(views.moveView);
  return { ...po, lines: views.poLines(id), vendor: vend ? views.vendorView(vend) : null, moves };
}

function register(r) {
  const manager = requireRole('manager');

  r.get('/orders', manager, (req, res) => {
    const q = req.query;
    const status = ['draft', 'ordered', 'received', 'cancelled'].includes(q.status) ? q.status : null;
    const vendorId = Number(q.vendorId) > 0 ? Number(q.vendorId) : null;
    const w = where([
      [status && 'po.status = :status'],
      [vendorId && 'po.vendor_id = :vendorId'],
      [
        q.q &&
          '(po.po_no LIKE :q OR v.name LIKE :q OR po.note LIKE :q OR EXISTS (SELECT 1 FROM purchase_order_items x JOIN inv_items i ON i.id = x.item_id WHERE x.po_id = po.id AND i.name LIKE :q))',
      ],
    ]);
    const params = { status, vendorId, q: q.q ? `%${q.q}%` : null };
    const rows = all(`${views.PO_SQL} ${w.sql} ORDER BY CASE po.status WHEN 'draft' THEN 0 WHEN 'ordered' THEN 1 ELSE 2 END, po.created_at DESC, po.id DESC LIMIT 300`, params).map((p) =>
      views.poView(p)
    );
    const counts = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM purchase_orders GROUP BY status').map((x) => [x.status, x.n]));
    const open = stock.openPoItemMap();
    const lowCount = stock.lowStockItems().filter((i) => !open[i.id]).length;
    res.json({ rows, counts, lowWithoutPo: lowCount });
  });

  r.get('/orders/auto-preview', manager, (req, res) => {
    res.json(autoPreview());
  });

  const autoSchema = v.object({
    groups: v.array(
      v.object({
        vendorId: v.id({ optional: true, label: '거래처' }),
        expectedDate: v.date({ optional: true, label: '입고 예정일' }),
        items: v.array(lineSchema, { min: 1, max: 200, label: '품목' }),
      }),
      { optional: true, max: 50, label: '발주서 묶음' }
    ),
  });
  r.post('/orders/auto', manager, (req, res) => {
    const d = autoSchema.parse(req.body);
    // 화면에서 고친 묶음을 보내면 그대로, 안 보내면 미리보기 기본값으로 만듦
    const groups =
      d.groups && d.groups.length
        ? d.groups
        : autoPreview().groups.map((g) => ({ vendorId: g.vendorId, items: g.items.map((x) => ({ itemId: x.itemId, qty: x.qty, unitPrice: x.unitPrice })) }));
    if (!groups.length) throw badRequest('발주가 필요한 부족 품목이 없습니다.');
    for (const g of groups) checkVendor(g.vendorId);
    const ids = tx(() =>
      groups.map((g) =>
        createPo(
          {
            vendorId: g.vendorId,
            expectedDate: g.expectedDate,
            note: g.vendorId ? '부족 품목 자동 발주' : '부족 품목 자동 발주 — 거래처가 정해지지 않은 품목입니다. 거래처를 지정해 주세요.',
            items: g.items,
          },
          req.user.id
        )
      )
    );
    const created = ids.map((id) => views.getPoView(id));
    audit(req, 'create', 'purchase_orders', null, `부족 품목 자동 발주서 ${ids.length}건 작성: ${created.map((p) => p.poNo).join(', ')}`);
    res.status(201).json({ created });
  });

  r.get('/orders/:id', manager, (req, res) => {
    res.json(detail(idParam(req.params.id)));
  });

  r.post('/orders', manager, (req, res) => {
    const d = poSchema.parse(req.body);
    checkVendor(d.vendorId);
    const id = createPo(d, req.user.id);
    const po = views.getPoView(id);
    audit(req, 'create', 'purchase_orders', id, `발주서 작성: ${po.poNo}${po.vendorName ? ` (${po.vendorName})` : ''}`);
    res.status(201).json(detail(id));
  });

  r.patch('/orders/:id', manager, (req, res) => {
    const id = idParam(req.params.id);
    const po = poOr404(id);
    const d = poSchema.partial().parse(req.body);
    if (po.status !== 'draft') {
      const locked = ['vendorId', 'items', 'orderDate'].filter((k) => k in d);
      if (locked.length) throw badRequest('발주한 뒤에는 거래처·품목을 바꿀 수 없습니다. 입고 예정일과 메모만 고칠 수 있습니다. 품목을 바꾸려면 취소 후 새로 만들어 주세요.');
    }
    if ('vendorId' in d) checkVendor(d.vendorId);
    tx(() => {
      run(
        'UPDATE purchase_orders SET vendor_id = ?, order_date = ?, expected_date = ?, note = ?, updated_at = ? WHERE id = ?',
        'vendorId' in d ? d.vendorId : po.vendor_id,
        'orderDate' in d ? d.orderDate : po.order_date,
        'expectedDate' in d ? d.expectedDate : po.expected_date,
        'note' in d ? d.note : po.note,
        time.nowIso(),
        id
      );
      if (d.items) replaceLines(id, normalizeLines(d.items));
    });
    audit(req, 'update', 'purchase_orders', id, `발주서 수정: ${po.po_no}`);
    res.json(detail(id));
  });

  r.post('/orders/:id/order', manager, (req, res) => {
    const id = idParam(req.params.id);
    const po = poOr404(id);
    if (po.status !== 'draft') throw badRequest('작성 중인 발주서만 발주함으로 바꿀 수 있습니다.');
    const n = get('SELECT COUNT(*) AS n FROM purchase_order_items WHERE po_id = ?', id).n;
    if (!n) throw badRequest('품목이 하나도 없는 발주서입니다. 품목을 먼저 넣어 주세요.');
    const d = v.object({ orderDate: v.date({ optional: true, label: '발주일' }), expectedDate: v.date({ optional: true, label: '입고 예정일' }) }).parse(req.body);
    run(
      "UPDATE purchase_orders SET status = 'ordered', order_date = ?, expected_date = ?, updated_at = ? WHERE id = ?",
      d.orderDate || time.today(),
      d.expectedDate || po.expected_date,
      time.nowIso(),
      id
    );
    audit(req, 'update', 'purchase_orders', id, `발주함으로 표시: ${po.po_no}`);
    res.json(detail(id));
  });

  r.post('/orders/:id/receive', manager, (req, res) => {
    const id = idParam(req.params.id);
    const d = receiveSchema.parse(req.body);
    const po = poOr404(id);
    const result = receivePo(id, d, req.user.id);
    audit(req, 'update', 'purchase_orders', id, `발주서 입고 처리: ${po.po_no} (${result.received}개 품목${result.completed ? ', 입고 완료' : ', 일부 입고'})`);
    res.json({ ...detail(id), result });
  });

  r.post('/orders/:id/cancel', manager, (req, res) => {
    const id = idParam(req.params.id);
    const po = poOr404(id);
    if (!['draft', 'ordered'].includes(po.status)) throw badRequest('입고 완료되었거나 이미 취소된 발주서입니다.');
    run("UPDATE purchase_orders SET status = 'cancelled', updated_at = ? WHERE id = ?", time.nowIso(), id);
    audit(req, 'update', 'purchase_orders', id, `발주서 취소: ${po.po_no}`);
    res.json(detail(id));
  });

  r.delete('/orders/:id', manager, (req, res) => {
    const id = idParam(req.params.id);
    const po = poOr404(id);
    if (!['draft', 'cancelled'].includes(po.status)) throw new HttpError(409, '발주했거나 입고된 발주서는 지울 수 없습니다. 먼저 취소해 주세요.');
    run('DELETE FROM purchase_orders WHERE id = ?', id);
    audit(req, 'delete', 'purchase_orders', id, `발주서 삭제: ${po.po_no}`);
    res.json({ ok: true });
  });
}

module.exports = { register, createPo, receivePo, autoPreview, nextPoNo, detail };
