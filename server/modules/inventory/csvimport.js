/*
 * 이 파일이 하는 일: 엑셀(CSV) 파일로 품목을 한꺼번에 가져오고(미리보기 → 확정), 품목·입출고 기록을 CSV로 내보냅니다.
 *
 *  - 머리글(첫 줄)은 한국어로 써도 됩니다: 품목명, 분류, 단위, 규격, 적정재고, 발주수량, 보관위치, 거래처, 현재고, 단가 …
 *  - 미리보기: 줄마다 "새 품목 / 기존 품목 수정 / 오류(이유)"를 보여 주고 DB는 바꾸지 않습니다.
 *  - 확정: 오류가 없는 줄만 저장합니다. 현재고 칸이 있으면 차이만큼 "실사 조정" 기록을 남깁니다.
 */
const { all, get, run, tx } = require('../../core/db');
const { parseCsvObjects, toCsv } = require('../../core/csv');
const { badRequest } = require('../../core/errors');
const time = require('../../core/time');
const stock = require('./stock');

// CSV 머리글 → 칸 이름 (여러 표현을 받아 줌)
const ALIASES = {
  name: ['품목명', '품목', '품명', '이름', '제품명', 'name'],
  category: ['분류', '카테고리', '종류', 'category'],
  unit: ['단위', 'unit'],
  spec: ['규격', '사양', '용량', 'spec'],
  minQty: ['적정재고', '적정 재고', '최소재고', '최소 재고', '안전재고', 'minqty', 'min'],
  reorderQty: ['발주수량', '발주 수량', '주문수량', '주문 수량', 'reorderqty'],
  location: ['보관위치', '보관 위치', '위치', 'location'],
  vendor: ['거래처', '업체', '공급처', '거래처명', 'vendor'],
  currentQty: ['현재고', '현재 재고', '재고', '재고수량', '수량', 'currentqty', 'qty'],
  lastUnitPrice: ['단가', '최근단가', '최근 단가', '최근 입고 단가', 'price', 'unitprice'],
  trackExpiry: ['유효기간관리', '유효기간 관리', '유효기간', 'trackexpiry'],
  memo: ['메모', '비고', 'memo'],
};

const YES = ['예', 'y', 'yes', 'o', '1', 'true', '관리', 'v', '✓'];

/** '1,200' '1200원' → 1200 / 빈 칸 → null / 숫자가 아니면 NaN */
function num(s) {
  if (s === undefined || s === null || String(s).trim() === '') return null;
  const n = Number(String(s).replace(/[,\s원]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

const keyOf = (name, spec) => `${String(name || '').trim().toLowerCase()}|${String(spec || '').trim().toLowerCase()}`;

/**
 * CSV 글을 읽어 줄마다 무엇을 할지 계산합니다. (DB는 바꾸지 않음)
 * @returns {{ rows: object[], summary: {new:number, update:number, error:number}, headers: string[], missing: string[] }}
 */
function analyze(text) {
  const parsed = parseCsvObjects(text, ALIASES);
  if (!parsed.headers.length) throw badRequest('파일에 내용이 없습니다. 첫 줄에 머리글(품목명, 분류, 단위 …)이 있는 CSV 파일을 골라 주세요.');
  if (!parsed.mapped.includes('name')) {
    throw badRequest(`'품목명' 열을 찾지 못했습니다. 첫 줄 머리글에 '품목명'이 있는지 확인해 주세요. (읽은 머리글: ${parsed.headers.slice(0, 8).join(', ')})`);
  }
  if (parsed.rows.length > 2000) throw badRequest('한 번에 2,000줄까지 가져올 수 있습니다. 파일을 나눠 주세요.');

  const existing = new Map(all('SELECT * FROM inv_items').map((i) => [keyOf(i.name, i.spec), i]));
  const vendors = all('SELECT id, name FROM vendors');
  const findVendor = (name) => vendors.find((v) => v.name.replace(/\s/g, '').toLowerCase() === String(name).replace(/\s/g, '').toLowerCase());
  const seen = new Set();
  const rows = parsed.rows.map((r, idx) => {
    const line = idx + 2; // 엑셀에서 보이는 줄 번호 (머리글이 1번 줄)
    const errors = [];
    const warnings = [];
    const name = (r.name || '').trim();
    const spec = (r.spec || '').trim();
    if (!name) errors.push('품목명이 비어 있습니다.');
    if (name.length > 100) errors.push('품목명은 100자 이하로 적어 주세요.');
    const k = keyOf(name, spec);
    if (name && seen.has(k)) errors.push('파일 안에 같은 품목(이름·규격)이 두 번 있습니다.');
    seen.add(k);
    const old = existing.get(k);

    const data = {};
    if ('category' in r && r.category) {
      const cat = stock.ITEM_CATEGORIES.find((c) => c === r.category.trim() || c.replace('·', '') === r.category.trim().replace(/[·\s/]/g, ''));
      if (!cat) errors.push(`분류는 ${stock.ITEM_CATEGORIES.join(', ')} 중 하나로 적어 주세요. (적힌 값: ${r.category})`);
      else data.category = cat;
    }
    if (r.unit) data.unit = r.unit.trim().slice(0, 20);
    if ('spec' in r) data.spec = spec || null;
    for (const [key, label] of [
      ['minQty', '적정재고'],
      ['reorderQty', '발주수량'],
      ['currentQty', '현재고'],
      ['lastUnitPrice', '단가'],
    ]) {
      if (!(key in r)) continue;
      const n = num(r[key]);
      if (n === null) continue;
      if (Number.isNaN(n) || n < 0) errors.push(`${label}에는 0 이상의 숫자를 적어 주세요. (적힌 값: ${r[key]})`);
      else data[key] = key === 'lastUnitPrice' ? Math.round(n) : stock.r3(n);
    }
    if (r.location) data.location = r.location.trim().slice(0, 100);
    if (r.memo) data.memo = r.memo.trim().slice(0, 1000);
    if (r.trackExpiry) data.trackExpiry = YES.includes(r.trackExpiry.trim().toLowerCase()) ? 1 : 0;
    if (r.vendor) {
      const v = findVendor(r.vendor);
      if (v) data.vendorId = v.id;
      else warnings.push(`거래처 '${r.vendor}'을(를) 찾지 못해 비워 둡니다. (거래처 화면에서 먼저 등록하면 연결됩니다)`);
    }
    const action = errors.length ? 'error' : old ? 'update' : 'new';
    const changes = [];
    if (old && !errors.length) {
      const cmp = { category: 'category', unit: 'unit', minQty: 'min_qty', reorderQty: 'reorder_qty', location: 'location', vendorId: 'vendor_id', lastUnitPrice: 'last_unit_price', currentQty: 'current_qty', trackExpiry: 'track_expiry', memo: 'memo' };
      const labels = { category: '분류', unit: '단위', minQty: '적정재고', reorderQty: '발주수량', location: '보관위치', vendorId: '거래처', lastUnitPrice: '단가', currentQty: '현재고', trackExpiry: '유효기간 관리', memo: '메모' };
      for (const [k2, col] of Object.entries(cmp)) if (k2 in data && String(data[k2] ?? '') !== String(old[col] ?? '')) changes.push(labels[k2]);
    }
    return { line, name, spec, action, errors, warnings, changes, data, itemId: old ? old.id : null, unchanged: action === 'update' && !changes.length };
  });
  const summary = {
    new: rows.filter((r) => r.action === 'new').length,
    update: rows.filter((r) => r.action === 'update' && !r.unchanged).length,
    unchanged: rows.filter((r) => r.unchanged).length,
    error: rows.filter((r) => r.action === 'error').length,
  };
  return { rows, summary, headers: parsed.headers, missing: parsed.missing };
}

/** 미리보기 결과 중 오류가 없는 줄을 실제로 저장합니다. */
function commit(text, userId) {
  const a = analyze(text);
  const now = time.nowIso();
  const today = time.today();
  let created = 0;
  let updated = 0;
  tx(() => {
    for (const r of a.rows) {
      if (r.action === 'error' || r.unchanged) continue;
      const d = r.data;
      let itemId = r.itemId;
      if (r.action === 'new') {
        itemId = run(
          `INSERT INTO inv_items (name, category, unit, spec, vendor_id, min_qty, reorder_qty, location, current_qty, track_expiry, last_unit_price, memo, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?)`,
          r.name,
          d.category || '기타',
          d.unit || '개',
          d.spec || null,
          d.vendorId || null,
          d.minQty || 0,
          d.reorderQty || 0,
          d.location || null,
          d.trackExpiry || 0,
          d.lastUnitPrice ?? null,
          d.memo || null,
          now,
          now
        ).lastInsertRowid;
        if (d.lastUnitPrice != null) run("INSERT INTO inv_prices (item_id, vendor_id, unit_price, recorded_at, source) VALUES (?, ?, ?, ?, '수동')", itemId, d.vendorId || null, d.lastUnitPrice, today);
        created++;
      } else {
        const old = get('SELECT * FROM inv_items WHERE id = ?', itemId);
        run(
          `UPDATE inv_items SET category = ?, unit = ?, spec = ?, vendor_id = ?, min_qty = ?, reorder_qty = ?, location = ?, track_expiry = ?, last_unit_price = ?, memo = ?, active = 1, updated_at = ? WHERE id = ?`,
          d.category ?? old.category,
          d.unit ?? old.unit,
          'spec' in d ? d.spec : old.spec,
          'vendorId' in d ? d.vendorId : old.vendor_id,
          d.minQty ?? old.min_qty,
          d.reorderQty ?? old.reorder_qty,
          d.location ?? old.location,
          d.trackExpiry ?? old.track_expiry,
          d.lastUnitPrice ?? old.last_unit_price,
          d.memo ?? old.memo,
          now,
          itemId
        );
        if (d.lastUnitPrice != null && d.lastUnitPrice !== old.last_unit_price) stock.recordPriceIfChanged(old, d.lastUnitPrice, d.vendorId ?? old.vendor_id, today, '수동');
        updated++;
      }
      // 현재고 칸이 있으면 그 수량으로 맞춤 (차이만큼 실사 조정 기록)
      if (d.currentQty != null) {
        const cur = get('SELECT current_qty FROM inv_items WHERE id = ?', itemId).current_qty;
        if (stock.r3(cur) !== d.currentQty) stock.adjust(itemId, { actualQty: d.currentQty, note: r.action === 'new' ? 'CSV 가져오기 (시작 재고)' : 'CSV 가져오기로 수량 맞춤' }, { userId });
      }
    }
  });
  return { created, updated, skipped: a.summary.error, unchanged: a.summary.unchanged, summary: a.summary };
}

// ---------------- 내보내기 ----------------
const ITEM_COLUMNS = [
  { key: 'name', label: '품목명' },
  { key: 'category', label: '분류' },
  { key: 'spec', label: '규격' },
  { key: 'unit', label: '단위' },
  { key: 'current_qty', label: '현재고', value: (r) => stock.r3(r.current_qty) },
  { key: 'min_qty', label: '적정재고', value: (r) => stock.r3(r.min_qty) },
  { key: 'reorder_qty', label: '발주수량', value: (r) => stock.r3(r.reorder_qty) },
  { key: 'location', label: '보관위치' },
  { key: 'vendor_name', label: '거래처' },
  { key: 'last_unit_price', label: '단가' },
  { key: 'track_expiry', label: '유효기간관리', value: (r) => (r.track_expiry ? '예' : '아니오') },
  { key: 'next_expiry', label: '가장 빠른 유효기간' },
  { key: 'memo', label: '메모' },
];

const MOVE_COLUMNS = [
  { key: 'move_date', label: '날짜' },
  { key: 'created_at', label: '시각', value: (r) => new Date(r.created_at).toTimeString().slice(0, 5) },
  { key: 'item_name', label: '품목명' },
  { key: 'spec', label: '규격' },
  { key: 'type', label: '구분', value: (r) => stock.MOVE_LABEL[r.type] },
  { key: 'qty', label: '수량', value: (r) => stock.r3(r.qty) },
  { key: 'unit', label: '단위' },
  { key: 'unit_price', label: '단가' },
  { key: 'lot_no', label: '로트' },
  { key: 'expiry_date', label: '유효기간' },
  { key: 'vendor_name', label: '거래처' },
  { key: 'po_no', label: '발주번호' },
  { key: 'balance_after', label: '기록 후 재고', value: (r) => (r.balance_after === null ? '' : stock.r3(r.balance_after)) },
  { key: 'note', label: '메모' },
  { key: 'user_name', label: '기록한 사람' },
];

function itemsCsv(rows) {
  return toCsv(ITEM_COLUMNS, rows);
}
function movesCsv(rows) {
  return toCsv(MOVE_COLUMNS, rows);
}
/** 가져오기 양식(빈 파일 + 예시 한 줄) */
function templateCsv() {
  const cols = ['품목명', '분류', '규격', '단위', '현재고', '적정재고', '발주수량', '보관위치', '거래처', '단가', '유효기간관리', '메모'].map((l) => ({ key: l, label: l }));
  return toCsv(cols, [{ 품목명: '니트릴 장갑 L', 분류: '소모품', 규격: '100매', 단위: '박스', 현재고: 5, 적정재고: 4, 발주수량: 10, 보관위치: '소모품 창고 A-1', 거래처: '', 단가: 6800, 유효기간관리: '아니오', 메모: '' }]);
}

module.exports = { analyze, commit, itemsCsv, movesCsv, templateCsv, ALIASES };
