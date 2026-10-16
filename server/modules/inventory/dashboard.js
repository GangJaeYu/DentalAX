/*
 * 이 파일이 하는 일: 첫 화면(대시보드)에 보여 줄 재고·구매 요약을 만듭니다.
 *   alerts   : 재고 부족(주황), 유효기간 만료(빨강), 유효기간 임박(주황, 'D-12' 배지)
 *   stats    : 재고 부족 n품목, 유효기간 임박 n건
 *   todos    : (실장 이상) 작성 중인 발주서, 입고 예정일이 지난 발주서
 *   upcoming : (실장 이상) 30일 안에 들어올 발주 입고 예정
 * 쿼리 몇 개로 가볍게 계산합니다.
 */
const { all } = require('../../core/db');
const { hasRole } = require('../../core/auth');
const time = require('../../core/time');
const stock = require('./stock');

const MAX_EACH = 5; // 경고는 종류별로 최대 5개만 (나머지는 "외 n개"로)

function dashboard(user) {
  const today = time.today();
  const alerts = [];
  const low = stock.lowStockItems();
  const { expired, expiring } = stock.expiryLots(today);

  for (const l of expired.slice(0, MAX_EACH)) {
    alerts.push({
      id: `inv-expired-${l.lotId}`,
      module: 'inventory',
      title: `${l.itemName} 유효기간 지남`,
      detail: `${l.lotNo ? `로트 ${l.lotNo} · ` : ''}${fmtQtyUnit(l.qty, l.unit)} 남음 · ${l.expiryDate} 만료`,
      href: `#/inventory/${l.itemId}`,
      level: 'danger',
      badge: '만료',
    });
  }
  for (const i of low.slice(0, MAX_EACH)) {
    alerts.push({
      id: `inv-low-${i.id}`,
      module: 'inventory',
      title: `${i.name}${i.spec ? ` (${i.spec})` : ''} 재고 부족`,
      detail: `현재 ${fmtQtyUnit(i.current_qty, i.unit)} · 적정 ${fmtQtyUnit(i.min_qty, i.unit)}${i.vendor_name ? ` · ${i.vendor_name}` : ''}`,
      href: `#/inventory/${i.id}`,
      level: 'warn',
      badge: i.current_qty <= 0 ? '바닥' : '부족',
    });
  }
  if (low.length > MAX_EACH) {
    alerts.push({ id: 'inv-low-more', module: 'inventory', title: `재고 부족 품목 외 ${low.length - MAX_EACH}개 더`, href: '#/inventory?low=1', level: 'warn' });
  }
  for (const l of expiring.slice(0, MAX_EACH)) {
    alerts.push({
      id: `inv-expiring-${l.lotId}`,
      module: 'inventory',
      title: `${l.itemName} 유효기간 임박`,
      detail: `${l.lotNo ? `로트 ${l.lotNo} · ` : ''}${fmtQtyUnit(l.qty, l.unit)} · ${l.expiryDate}까지`,
      href: `#/inventory/${l.itemId}`,
      level: 'warn',
      badge: l.days === 0 ? 'D-day' : `D-${l.days}`,
    });
  }

  const expiringItems = new Set(expiring.map((l) => l.itemId)).size;
  const stats = [
    { key: 'inv-low', label: '재고 부족', value: low.length, unit: '품목', href: '#/inventory?low=1', icon: 'package', color: low.length ? 'warning' : undefined, hint: low.length ? '적정 재고 이하' : '모두 충분합니다' },
    {
      key: 'inv-expiring',
      label: '유효기간 임박',
      value: expiringItems + new Set(expired.map((l) => l.itemId)).size,
      unit: '품목',
      href: '#/inventory?tab=alerts',
      icon: 'calendar-clock',
      color: expired.length ? 'danger' : expiringItems ? 'warning' : undefined,
      hint: expired.length ? `만료 ${new Set(expired.map((l) => l.itemId)).size}품목 포함` : `${stock.EXPIRY_SOON_DAYS}일 이내`,
    },
  ];

  const todos = [];
  const upcoming = [];
  if (hasRole(user, 'manager')) {
    const drafts = all("SELECT id, po_no FROM purchase_orders WHERE status = 'draft' ORDER BY created_at DESC");
    if (drafts.length) {
      todos.push({
        id: 'inv-po-draft',
        module: 'inventory',
        title: `작성 중인 발주서 ${drafts.length}건`,
        detail: '확인 후 거래처에 발주해 주세요',
        href: drafts.length === 1 ? `#/orders/${drafts[0].id}` : '#/orders?status=draft',
        level: 'info',
        icon: 'shopping-cart',
      });
    }
    const ordered = all(
      `SELECT po.id, po.po_no, po.expected_date, v.name AS vendor_name FROM purchase_orders po LEFT JOIN vendors v ON v.id = po.vendor_id
       WHERE po.status = 'ordered' AND po.expected_date IS NOT NULL AND po.expected_date <= ? ORDER BY po.expected_date`,
      time.addDays(today, 30)
    );
    for (const p of ordered) {
      if (p.expected_date < today) {
        todos.push({
          id: `inv-po-late-${p.id}`,
          module: 'inventory',
          title: `${p.vendor_name || '거래처 미정'} 발주 입고 확인`,
          detail: `${p.po_no} · 입고 예정일(${p.expected_date})이 지났습니다`,
          href: `#/orders/${p.id}`,
          level: 'danger',
          icon: 'truck',
        });
      } else {
        upcoming.push({
          id: `inv-po-due-${p.id}`,
          module: 'inventory',
          title: `${p.vendor_name || '거래처 미정'} 발주품 입고 예정`,
          date: p.expected_date,
          dday: time.diffDays(today, p.expected_date),
          detail: p.po_no,
          href: `#/orders/${p.id}`,
          icon: 'truck',
        });
      }
    }
    const open = stock.openPoItemMap();
    const lowNoPo = low.filter((i) => !open[i.id]).length;
    if (lowNoPo > 0) {
      todos.push({ id: 'inv-low-order', module: 'inventory', title: `부족 품목 ${lowNoPo}개 발주 필요`, detail: '부족 품목으로 발주서를 바로 만들 수 있습니다', href: '#/orders?auto=1', level: 'warn', icon: 'package' });
    }
  }
  return { alerts, stats, todos, upcoming };
}

function fmtQtyUnit(q, unit) {
  return `${stock.fmtQty(q)}${unit || ''}`;
}

module.exports = { dashboard };
