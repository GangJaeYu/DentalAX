/*
 * 이 파일이 하는 일: [B. 재고·구매] 발주서 화면입니다. (실장 이상)
 *
 *   #/orders               발주서 목록 (상태 탭: 작성 중 / 발주함 / 입고 완료 / 취소)
 *        ?auto=1           "부족 품목으로 발주서 만들기" 창을 바로 엶 (대시보드·재고 경고에서 연결)
 *   #/orders/12            발주서 상세: 품목 고치기(작성 중일 때) → 발주함으로 표시 → 입고 처리(전부/일부)
 *                          + AI로 거래처에 보낼 주문 메시지(카톡·문자·이메일) 만들기
 *   #/orders/12/print      A4 인쇄용 발주서 (인쇄 창에서 "PDF로 저장"을 고르면 PDF 파일)
 *
 * 흐름: 작성 중 → 발주함 → 입고 완료 (중간에 취소 가능). 입고 처리하면 재고에 자동으로 입고 기록이 생기고 단가도 기록됩니다.
 */
import { html, useState, useEffect, cx, fmtDate, fmtMoney, fmtNumber, toQuery, todayStr, addDays, daysUntil } from '../lib.js';
import { api } from '../api.js';
import { navigate, setQuery } from '../router.js';
import { toast, confirmDialog } from '../store.js';
import {
  PageHeader, Card, Button, IconButton, LinkButton, Badge, Icon, Tabs, Seg, Modal, Field, Input, Textarea, Select, Checkbox,
  SearchInput, useApi, Loading, ErrorState, EmptyState, DataTable, Menu, Callout, DdayBadge, Progress,
  PiiBanner, useAI, AiResult, AiButton, PrintDoc, printNow,
} from '../ui/index.js';
import { useClinic } from '../clinic.js';
import { fq, Qty, useMeta, clearMetaCache } from './inventory.js';

const STATUS = {
  draft: { label: '작성 중', color: 'gray', icon: 'pencil' },
  ordered: { label: '발주함', color: 'blue', icon: 'send' },
  received: { label: '입고 완료', color: 'green', icon: 'circle-check' },
  cancelled: { label: '취소', color: 'red', icon: 'circle-x' },
};
const METHOD_ICON = { 전화: 'phone', 카카오톡: 'message-square-text', 이메일: 'mail', 웹사이트: 'external-link', 기타: 'send' };

function StatusBadge({ po }) {
  const s = STATUS[po.status];
  return html`<${Badge} color=${s.color}>${s.label}</${Badge}>`;
}

/** 입고 예정일 표시: 발주함 상태에서만 D-day (지나면 빨강) */
function ExpectedCell({ po }) {
  if (!po.expectedDate) return html`<span class="muted">—</span>`;
  const d = daysUntil(po.expectedDate);
  return html`<div class="row" style=${{ gap: '6px' }}>
    <span class="num">${fmtDate(po.expectedDate, { weekday: false })}</span>
    ${po.status === 'ordered' ? html`<${DdayBadge} days=${d} label=${d < 0 ? `${-d}일 지남` : undefined} />` : null}
  </div>`;
}

const won = (n) => `${fmtNumber(Math.round(n || 0))}원`;
/** 웹 주소에 http가 없으면 붙여서 링크로 */
export const webHref = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

// ---------------- 부족 품목 → 거래처별 발주서 만들기 ----------------
function AutoPoModal({ onClose, onDone }) {
  const { data, loading, error, reload } = useApi('/inventory/orders/auto-preview');
  const [groups, setGroups] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setGroups(data.groups.map((g, gi) => ({ ...g, key: gi, on: true, expectedDate: '', items: g.items.map((x) => ({ ...x, on: true, qty: String(x.qty), unitPrice: x.unitPrice ?? '' })) })));
  }, [data]);
  const setItem = (gk, id, patch) => setGroups((gs) => gs.map((g) => (g.key === gk ? { ...g, items: g.items.map((x) => (x.itemId === id ? { ...x, ...patch } : x)) } : g)));
  const setGroup = (gk, patch) => setGroups((gs) => gs.map((g) => (g.key === gk ? { ...g, ...patch } : g)));
  const chosen = (groups || []).filter((g) => g.on).map((g) => ({ ...g, items: g.items.filter((x) => x.on && Number(x.qty) > 0) })).filter((g) => g.items.length);
  const total = chosen.reduce((s, g) => s + g.items.reduce((t, x) => t + Number(x.qty) * (Number(x.unitPrice) || 0), 0), 0);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post('/inventory/orders/auto', {
        groups: chosen.map((g) => ({ vendorId: g.vendorId, expectedDate: g.expectedDate || null, items: g.items.map((x) => ({ itemId: x.itemId, qty: x.qty, unitPrice: x.unitPrice === '' ? null : x.unitPrice })) })),
      });
      toast.success(`발주서 ${r.created.length}건을 만들었습니다. 내용을 확인하고 거래처에 발주하세요.`);
      onDone(r.created);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return html`<${Modal}
    open=${true}
    size="xl"
    title="부족 품목으로 발주서 만들기"
    onClose=${onClose}
    busy=${busy}
    footer=${html`<span class="small text-2 grow">${chosen.length ? html`발주서 <strong>${chosen.length}건</strong> · 품목 ${chosen.reduce((s, g) => s + g.items.length, 0)}개 · 예상 금액 <strong class="num">${won(total)}</strong>` : '만들 발주서가 없습니다'}</span>
      <${Button} onClick=${onClose}>취소</${Button}>
      <${Button} variant="primary" icon="shopping-cart" loading=${busy} disabled=${!chosen.length} onClick=${create}>${chosen.length ? `발주서 ${chosen.length}건 만들기` : '발주서 만들기'}</${Button}>`}
  >
    ${error && !data
      ? html`<${ErrorState} error=${error} onRetry=${reload} />`
      : loading || !groups
        ? html`<${Loading} rows=${6} />`
        : !groups.length
          ? html`<${EmptyState} icon="circle-check" title="발주가 필요한 부족 품목이 없습니다" desc=${data.skipped.length ? `부족한 품목 ${data.skipped.length}개는 이미 진행 중인 발주서에 들어 있습니다.` : '모든 품목이 적정 재고보다 많습니다.'} />`
          : html`<div class="stack">
              <p class="small text-2">적정 재고 이하인 품목을 거래처별로 묶었습니다. 주문 수량은 "한 번에 주문할 수량"(없으면 적정 재고×2 − 현재 수량)입니다. 필요 없는 품목은 체크를 끄고, 수량·단가는 바로 고칠 수 있습니다. "작성 중" 상태로 만들어지니 안심하고 만드세요.</p>
              ${data.skipped.length ? html`<${Callout} kind="info">이미 진행 중인 발주서에 들어 있어 뺀 품목: ${data.skipped.map((x) => `${x.name} (${x.poNo})`).join(', ')}</${Callout}>` : null}
              ${groups.map(
                (g) => html`<${Card}
                  key=${g.key}
                  class="po-group"
                  title=${html`<${Checkbox} label=${g.vendorName || '거래처 미지정'} checked=${g.on} onChange=${(c) => setGroup(g.key, { on: c })} />`}
                  sub=${g.vendorName ? [g.orderMethod, g.phone].filter(Boolean).join(' · ') : null}
                  actions=${html`<${Input} type="date" size="sm" value=${g.expectedDate} aria-label="입고 희망일" title="입고 희망일 (선택)" onInput=${(e) => setGroup(g.key, { expectedDate: e.target.value })} style=${{ width: '150px' }} />`}
                  flush
                >
                  ${g.note ? html`<div style=${{ padding: '10px 16px 0' }}><${Callout} kind="warn">${g.note}</${Callout}></div>` : null}
                  <div class="table-wrap">
                    <table class="table table-compact po-lines">
                      <thead><tr><th style=${{ width: '36px' }}></th><th>품목</th><th class="right">현재 / 적정</th><th class="right">주문 수량</th><th class="right">단가(원)</th><th class="right">금액</th></tr></thead>
                      <tbody>
                        ${g.items.map(
                          (x) => html`<tr key=${x.itemId} class=${x.on && g.on ? '' : 'muted'}>
                            <td><input type="checkbox" checked=${x.on} aria-label=${`${x.name} 포함`} onChange=${(e) => setItem(g.key, x.itemId, { on: e.target.checked })} /></td>
                            <td><div class="inv-name"><span class="title">${x.name}</span><span class="sub">${x.spec || '—'}</span></div></td>
                            <td class="right num"><span class=${x.currentQty <= 0 ? 'danger-text strong' : 'warning-text strong'}>${fq(x.currentQty)}</span> / ${fq(x.minQty)} ${x.unit}</td>
                            <td class="right"><div class="row end" style=${{ gap: '4px' }}><${Input} class="num-in" inputmode="decimal" value=${x.qty} aria-label="주문 수량" onInput=${(e) => setItem(g.key, x.itemId, { qty: e.target.value })} /><span class="small muted">${x.unit}</span></div></td>
                            <td class="right"><${Input} class="price-in" inputmode="numeric" value=${x.unitPrice} aria-label="단가" onInput=${(e) => setItem(g.key, x.itemId, { unitPrice: e.target.value })} /></td>
                            <td class="right num">${won(Number(x.qty) * (Number(x.unitPrice) || 0))}</td>
                          </tr>`
                        )}
                      </tbody>
                    </table>
                  </div>
                </${Card}>`
              )}
            </div>`}
  </${Modal}>`;
}

// ---------------- 새 발주서 (빈 발주서 → 상세에서 품목 추가) ----------------
function NewPoModal({ onClose, onDone }) {
  const meta = useMeta();
  const [vendorId, setVendorId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setBusy(true);
    try {
      const po = await api.post('/inventory/orders', { vendorId: vendorId ? Number(vendorId) : null, expectedDate: expectedDate || null });
      toast.success(`${po.poNo} 발주서를 만들었습니다. 품목을 추가해 주세요.`);
      onDone(po);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<${Modal} open=${true} size="sm" title="새 발주서" onClose=${onClose} busy=${busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${busy} onClick=${create}>만들기</${Button}>`}>
    <form class="stack" onSubmit=${create}>
      <${Field} label="거래처" hint="거래처를 고르면 그 거래처 품목을 먼저 보여 줍니다">
        <${Select} value=${vendorId} onChange=${(e) => setVendorId(e.target.value)} placeholder="나중에 정하기" options=${(meta?.vendors || []).filter((x) => x.active).map((x) => ({ value: String(x.id), label: `${x.name} (${x.category})` }))} />
      </${Field}>
      <${Field} label="입고 희망일 (선택)"><${Input} type="date" value=${expectedDate} min=${todayStr()} onInput=${(e) => setExpectedDate(e.target.value)} /></${Field}>
      <button type="submit" class="sr-only" tabindex="-1">만들기</button>
    </form>
  </${Modal}>`;
}

// ---------------- 목록 ----------------
function PoList({ route }) {
  const q = route.query;
  const status = q.status || '';
  const [search, setSearch] = useState(q.q || '');
  const [modal, setModal] = useState(q.auto === '1' ? 'auto' : null);
  const { data, loading, error, reload } = useApi(`/inventory/orders${toQuery({ status, q: q.q || '' })}`);
  useEffect(() => {
    const t = setTimeout(() => (q.q || '') !== search && setQuery({ q: search }), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    if (q.auto === '1') {
      setModal('auto');
      setQuery({ auto: '' });
    }
  }, [q.auto]);
  const c = (data && data.counts) || {};
  const allCount = Object.values(c).reduce((s, n) => s + n, 0);

  const columns = [
    { key: 'no', label: '발주번호', render: (p) => html`<div><a href=${`#/orders/${p.id}`} class="strong num nowrap" onClick=${(e) => e.stopPropagation()}>${p.poNo}</a><div class="small muted">${p.createdByName ? `${p.createdByName} 작성` : ''}</div></div>` },
    { key: 'vendor', label: '거래처', render: (p) => (p.vendorName ? html`<span class="strong">${p.vendorName}</span>` : html`<${Badge} color="amber">거래처 미지정</${Badge}>`) },
    { key: 'items', label: '품목', render: (p) => html`<span class="text-2">${p.firstItem ? `${p.firstItem}${p.lineCount > 1 ? ` 외 ${p.lineCount - 1}건` : ''}` : html`<span class="muted">품목 없음</span>`}</span>` },
    { key: 'total', label: '합계', align: 'right', render: (p) => html`<span class="num strong nowrap">${won(p.total)}</span>` },
    { key: 'date', label: '발주일', render: (p) => html`<span class="num small">${p.orderDate ? fmtDate(p.orderDate, { weekday: false }) : html`<span class="muted">—</span>`}</span>` },
    { key: 'exp', label: '입고 예정', render: (p) => html`<${ExpectedCell} po=${p} />` },
    {
      key: 'status',
      label: '상태',
      render: (p) => html`<div class="stack sm" style=${{ minWidth: '84px', alignItems: 'flex-start' }}>
        <${StatusBadge} po=${p} />
        ${p.status === 'ordered' && p.receivedTotal > 0 ? html`<div title=${`받은 수량 ${fq(p.receivedTotal)} / ${fq(p.qtyTotal)}`}><${Progress} value=${p.receivedTotal} max=${p.qtyTotal} label="입고 진행" /></div>` : null}
      </div>`,
    },
  ];

  return html`
    <${PageHeader}
      title="발주서"
      desc="부족한 품목을 거래처별로 묶어 발주서를 만들고, 발주 → 입고까지 기록합니다. 입고 처리하면 재고에 자동으로 반영됩니다."
      actions=${html`
        <${Button} icon="plus" onClick=${() => setModal('new')}>새 발주서</${Button}>
        <${Button} variant="primary" icon="wand-sparkles" onClick=${() => setModal('auto')}>부족 품목으로 발주서 만들기</${Button}>
      `}
    />
    ${data && data.lowWithoutPo > 0
      ? html`<${Callout} kind="warn" class="mt-0">
          <div class="row wrap between"><span>발주가 필요한 부족 품목이 <strong>${data.lowWithoutPo}개</strong> 있습니다. 거래처별 발주서를 한 번에 만들 수 있습니다.</span>
          <${Button} size="sm" variant="primary" icon="wand-sparkles" onClick=${() => setModal('auto')}>발주서 만들기</${Button}></div>
        </${Callout}><div style=${{ height: '14px' }}></div>`
      : null}
    <${Tabs}
      value=${status}
      onChange=${(s) => setQuery({ status: s })}
      items=${[
        { value: '', label: '전체', count: allCount || null },
        { value: 'draft', label: '작성 중', icon: 'pencil', count: c.draft || null, countColor: 'gray' },
        { value: 'ordered', label: '발주함', icon: 'send', count: c.ordered || null, countColor: 'blue' },
        { value: 'received', label: '입고 완료', icon: 'circle-check', count: c.received || null },
        { value: 'cancelled', label: '취소', icon: 'circle-x', count: c.cancelled || null },
      ]}
    />
    <div class="inv-toolbar"><${SearchInput} value=${search} onInput=${setSearch} placeholder="발주번호·거래처·품목 검색" /></div>
    <${Card} flush>
      <${DataTable}
        columns=${columns}
        rows=${data && data.rows}
        loading=${loading}
        error=${error}
        onRetry=${reload}
        onRowClick=${(p) => navigate(`#/orders/${p.id}`)}
        rowClass=${(p) => (p.overdue ? 'inv-row-out' : '')}
        caption="발주서 목록"
        empty=${q.q || status
          ? { icon: 'search', title: '조건에 맞는 발주서가 없습니다', desc: '다른 탭을 보거나 검색어를 바꿔 보세요.' }
          : { icon: 'shopping-cart', title: '아직 발주서가 없습니다', desc: '부족한 품목으로 발주서를 자동으로 만들거나, 새 발주서를 직접 작성해 보세요.', action: html`<${Button} variant="primary" icon="wand-sparkles" onClick=${() => setModal('auto')}>부족 품목으로 발주서 만들기</${Button}>` }}
      />
    </${Card}>
    ${modal === 'auto'
      ? html`<${AutoPoModal} onClose=${() => setModal(null)} onDone=${(created) => {
          setModal(null);
          if (created.length === 1) navigate(`#/orders/${created[0].id}`);
          else {
            setQuery({ status: 'draft' });
            reload();
          }
        }} />`
      : null}
    ${modal === 'new' ? html`<${NewPoModal} onClose=${() => setModal(null)} onDone=${(po) => navigate(`#/orders/${po.id}`)} />` : null}
  `;
}

// ---------------- 상세: 진행 단계 ----------------
function Steps({ po }) {
  if (po.status === 'cancelled') return html`<div class="po-steps"><${Badge} color="red"><${Icon} name="circle-x" size=${12} />취소된 발주서</${Badge}></div>`;
  const idx = { draft: 0, ordered: 1, received: 2 }[po.status];
  const steps = ['작성', '발주', '입고 완료'];
  return html`<div class="po-steps" aria-label=${`진행 단계: ${steps[idx]}`}>
    ${steps.map(
      (s, i) => html`${i > 0 ? html`<span class=${cx('po-step-line', i <= idx && 'done')}></span>` : null}
        <span class=${cx('po-step', i < idx && 'done', i === idx && (po.status === 'received' ? 'done' : 'current'))}>
          <span class="num">${i < idx || po.status === 'received' ? html`<${Icon} name="check" size=${12} stroke=${3} />` : i + 1}</span>${s}
        </span>`
    )}
  </div>`;
}

// ---------------- 상세: 품목 편집 (작성 중일 때) ----------------
function LinesEditor({ po, onSaved }) {
  const items = useApi('/inventory/items');
  const [lines, setLines] = useState(po.lines.map((l) => ({ itemId: l.itemId, name: l.itemName, spec: l.spec, unit: l.unit, currentQty: l.currentQty, qty: String(l.qty), unitPrice: l.unitPrice ?? '' })));
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(lines.map((l) => [l.itemId, Number(l.qty), l.unitPrice === '' ? null : Number(l.unitPrice)])) !== JSON.stringify(po.lines.map((l) => [l.itemId, l.qty, l.unitPrice ?? null]));
  const all = (items.data && items.data.rows) || [];
  // 이 거래처 품목 → 부족 품목 → 나머지 순서로
  const options = all
    .filter((x) => !lines.some((l) => l.itemId === x.id))
    .sort((a, b) => (b.vendorId === po.vendorId) - (a.vendorId === po.vendorId) || b.low - a.low || a.name.localeCompare(b.name))
    .map((x) => ({ value: String(x.id), label: `${x.vendorId === po.vendorId && po.vendorId ? '★ ' : ''}${x.name}${x.spec ? ` (${x.spec})` : ''} · 재고 ${fq(x.currentQty)}${x.unit}${x.low ? ' · 부족' : ''}` }));
  const add = (id) => {
    const x = all.find((i) => String(i.id) === id);
    if (!x) return;
    const suggested = x.reorderQty > 0 ? x.reorderQty : Math.max(1, Math.ceil(x.minQty * 2 - x.currentQty));
    setLines((ls) => [...ls, { itemId: x.id, name: x.name, spec: x.spec, unit: x.unit, currentQty: x.currentQty, qty: String(suggested), unitPrice: x.lastUnitPrice ?? '' }]);
    setAdding('');
  };
  const set = (id, patch) => setLines((ls) => ls.map((l) => (l.itemId === id ? { ...l, ...patch } : l)));
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.patch(`/inventory/orders/${po.id}`, { items: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitPrice: l.unitPrice === '' ? null : l.unitPrice })) });
      toast.success('품목을 저장했습니다.');
      onSaved(r);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const total = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
  return html`<${Card}
    title="품목"
    icon="list"
    sub=${`${lines.length}개`}
    flush
    actions=${dirty ? html`<${Badge} color="amber">저장 안 됨</${Badge}><${Button} size="sm" variant="primary" icon="save" loading=${busy} onClick=${save}>품목 저장</${Button}>` : null}
  >
    ${lines.length
      ? html`<div class="table-wrap"><table class="table table-compact po-lines">
          <thead><tr><th>품목</th><th class="right">현재 재고</th><th class="right">주문 수량</th><th class="right">단가(원)</th><th class="right">금액</th><th></th></tr></thead>
          <tbody>
            ${lines.map(
              (l) => html`<tr key=${l.itemId}>
                <td><div class="inv-name"><span class="title">${l.name}</span><span class="sub">${l.spec || '—'}</span></div></td>
                <td class="right num text-2">${fq(l.currentQty)}${l.unit}</td>
                <td class="right"><div class="row end" style=${{ gap: '4px' }}><${Input} class="num-in" inputmode="decimal" value=${l.qty} aria-label=${`${l.name} 주문 수량`} onInput=${(e) => set(l.itemId, { qty: e.target.value })} /><span class="small muted">${l.unit}</span></div></td>
                <td class="right"><${Input} class="price-in" inputmode="numeric" value=${l.unitPrice} aria-label=${`${l.name} 단가`} onInput=${(e) => set(l.itemId, { unitPrice: e.target.value })} /></td>
                <td class="right num">${won((Number(l.qty) || 0) * (Number(l.unitPrice) || 0))}</td>
                <td class="actions"><${IconButton} icon="trash-2" size="sm" label="이 품목 빼기" onClick=${() => setLines((ls) => ls.filter((x) => x.itemId !== l.itemId))} /></td>
              </tr>`
            )}
          </tbody>
        </table></div>`
      : html`<${EmptyState} compact icon="package-plus" title="아직 품목이 없습니다" desc="아래에서 주문할 품목을 골라 추가하세요." />`}
    <div class="row wrap" style=${{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
      <${Select} value=${adding} aria-label="추가할 품목" onChange=${(e) => add(e.target.value)} placeholder=${items.loading ? '품목 불러오는 중…' : '＋ 품목 추가 (고르면 바로 들어갑니다)'} options=${options} style=${{ maxWidth: '460px' }} />
      <div class="grow"></div>
      <span class="small muted">합계</span><strong class="num" style=${{ fontSize: '17px' }}>${won(total)}</strong>
    </div>
  </${Card}>`;
}

/** 상세: 품목 (작성 중이 아닐 때, 읽기 전용 + 받은 수량) */
function LinesView({ po }) {
  return html`<${Card} title="품목" icon="list" sub=${`${po.lines.length}개`} flush>
    <div class="table-wrap"><table class="table table-compact">
      <thead><tr><th>품목</th><th class="right">주문</th><th class="right">단가</th><th class="right">금액</th>${po.status !== 'cancelled' ? html`<th>입고</th>` : null}</tr></thead>
      <tbody>
        ${po.lines.map(
          (l) => html`<tr key=${l.id}>
            <td><a class="inv-link inv-name" href=${`#/inventory/${l.itemId}`}><span class="title">${l.itemName}</span><span class="sub">${l.spec || '—'}</span></a></td>
            <td class="right"><${Qty} value=${l.qty} unit=${l.unit} /></td>
            <td class="right num">${l.unitPrice != null ? fmtMoney(l.unitPrice) : '—'}</td>
            <td class="right num strong">${won(l.amount)}</td>
            ${po.status !== 'cancelled'
              ? html`<td style=${{ minWidth: '130px' }}>
                  ${l.receivedQty >= l.qty
                    ? html`<${Badge} color="green"><${Icon} name="check" size=${12} />다 받음</${Badge}>`
                    : l.receivedQty > 0
                      ? html`<div class="stack sm"><span class="small">${fq(l.receivedQty)} / ${fq(l.qty)}${l.unit} 받음</span><${Progress} value=${l.receivedQty} max=${l.qty} color="amber" /></div>`
                      : html`<span class="small muted">${po.status === 'received' ? '받지 않고 마감' : '아직'}</span>`}
                </td>`
              : null}
          </tr>`
        )}
      </tbody>
    </table></div>
    <div class="po-total"><span class="muted small">합계 (${po.lines.length}개 품목)</span><b>${won(po.total)}</b></div>
  </${Card}>`;
}

// ---------------- 입고 처리 창 ----------------
function ReceiveModal({ po, onClose, onDone }) {
  const open = po.lines.filter((l) => l.remaining > 0);
  const [rows, setRows] = useState(open.map((l) => ({ lineId: l.id, qty: String(l.remaining), unitPrice: l.unitPrice ?? '', lotNo: '', expiryDate: '' })));
  const [close, setClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (id, patch) => setRows((rs) => rs.map((r) => (r.lineId === id ? { ...r, ...patch } : r)));
  const partial = rows.some((r) => Number(r.qty) < open.find((l) => l.id === r.lineId).remaining);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/inventory/orders/${po.id}/receive`, {
        lines: rows.map((x) => ({ lineId: x.lineId, qty: x.qty || 0, unitPrice: x.unitPrice === '' ? null : x.unitPrice, lotNo: x.lotNo || null, expiryDate: x.expiryDate || null })),
        close,
      });
      toast.success(r.result.completed ? '입고 처리했습니다. 발주서가 "입고 완료"로 바뀌었습니다.' : '일부 입고를 기록했습니다. 나머지는 도착하면 다시 입고 처리하세요.');
      if (r.result.warnings && r.result.warnings.length) toast.warn(r.result.warnings.join('\n'));
      onDone(r);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<${Modal}
    open=${true}
    size="xl"
    title=${`입고 처리 · ${po.poNo}`}
    onClose=${onClose}
    busy=${busy}
    footer=${html`<${Checkbox} label="덜 온 수량은 더 받지 않고 마감" checked=${close} onChange=${setClose} />
      <div class="grow"></div>
      <${Button} onClick=${onClose}>취소</${Button}>
      <${Button} variant="primary" icon="package-plus" loading=${busy} onClick=${submit}>${partial && !close ? '받은 만큼 입고' : '입고 완료'}</${Button}>`}
  >
    <div class="stack">
      <p class="small text-2">실제로 받은 수량을 확인하세요. 처음에는 남은 수량이 모두 채워져 있습니다. 덜 왔으면 받은 수량만 고치면 되고, 나머지는 나중에 다시 입고 처리할 수 있습니다. 유효기간을 관리하는 품목은 유효기간을 적어 주세요.</p>
      <div class="table-wrap">
        <table class="table table-compact inv-map">
          <thead><tr><th>품목</th><th class="right">주문 / 받음</th><th class="right">이번에 받은 수량</th><th class="right">단가(원)</th><th>유효기간</th><th>로트</th></tr></thead>
          <tbody>
            ${open.map((l) => {
              const r = rows.find((x) => x.lineId === l.id);
              return html`<tr key=${l.id}>
                <td><div class="inv-name"><span class="title">${l.itemName}</span><span class="sub">${l.spec || '—'}</span></div></td>
                <td class="right num text-2 nowrap">${fq(l.qty)} / ${fq(l.receivedQty)}${l.unit}</td>
                <td class="right"><div class="row end" style=${{ gap: '4px' }}>
                  <${Input} class="num-in" inputmode="decimal" value=${r.qty} aria-label=${`${l.itemName} 받은 수량`} onInput=${(e) => set(l.id, { qty: e.target.value })} />
                  <span class="small muted">${l.unit}</span>
                </div></td>
                <td class="right"><${Input} class="price-in" inputmode="numeric" value=${r.unitPrice} aria-label="단가" onInput=${(e) => set(l.id, { unitPrice: e.target.value })} /></td>
                <td>${l.trackExpiry || r.expiryDate ? html`<${Input} type="date" value=${r.expiryDate} aria-label="유효기간" onInput=${(e) => set(l.id, { expiryDate: e.target.value })} style=${{ minWidth: '140px' }} />` : html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => set(l.id, { expiryDate: addDays(todayStr(), 365) })}>＋ 입력</button>`}</td>
                <td>${l.trackExpiry || r.lotNo ? html`<${Input} value=${r.lotNo} aria-label="로트 번호" placeholder="선택" onInput=${(e) => set(l.id, { lotNo: e.target.value })} style=${{ width: '110px' }} />` : html`<span class="muted small">—</span>`}</td>
              </tr>`;
            })}
          </tbody>
        </table>
      </div>
    </div>
  </${Modal}>`;
}

// ---------------- 상세: AI 발주 메시지 ----------------
function VendorMessage({ po }) {
  const ai = useAI('inventory.vendorMessage');
  const preferred = po.vendor && po.vendor.orderMethod === '이메일' ? 'email' : po.vendor && po.vendor.orderMethod === '전화' ? 'sms' : 'kakao';
  const [style, setStyle] = useState(preferred);
  const [extra, setExtra] = useState('');
  const run = () => {
    if (!po.lines.length) return toast.warn('먼저 품목을 넣어 주세요.');
    ai.run({ poId: po.id, style, extra: extra.trim() || null });
  };
  return html`<${Card} title="거래처에 보낼 주문 메시지" icon="sparkles">
    <div class="stack">
      <${Seg} label="메시지 종류" value=${style} onChange=${setStyle} items=${[{ value: 'kakao', label: '카카오톡' }, { value: 'sms', label: '문자' }, { value: 'email', label: '이메일' }]} />
      <${PiiBanner} compact />
      <${Input} value=${extra} onInput=${(e) => setExtra(e.target.value)} placeholder="추가로 전할 말 (선택) 예: 오전 배송 부탁" maxlength="500" aria-label="추가로 전할 말" />
      <div><${AiButton} onClick=${run} loading=${ai.busy} size="sm">AI로 메시지 만들기</${AiButton}></div>
      <${AiResult} ai=${ai} title="주문 메시지 초안" editable plain />
    </div>
  </${Card}>`;
}

// ---------------- 상세 ----------------
function PoDetail({ id }) {
  const { data: po, loading, error, reload, setData } = useApi(`/inventory/orders/${id}`);
  const meta = useMeta();
  const [modal, setModal] = useState(null);
  const [info, setInfo] = useState(null); // 일정·메모 편집 값
  useEffect(() => {
    if (po) setInfo({ vendorId: po.vendorId ? String(po.vendorId) : '', expectedDate: po.expectedDate || '', note: po.note || '' });
  }, [po && po.updatedAt]);

  if (error && !po) return html`<div class="inv-back"><a href="#/orders" class="btn btn-ghost btn-sm"><${Icon} name="arrow-left" size=${14} />발주서 목록</a></div><${ErrorState} error=${error} onRetry=${reload} />`;
  if ((loading && !po) || !info) return html`<${Loading} rows=${8} />`;

  const act = async (path, msg, body = {}) => {
    try {
      const r = await api.post(`/inventory/orders/${id}/${path}`, body);
      setData(r);
      toast.success(msg);
    } catch (e) {
      toast.error(e.message);
    }
  };
  const markOrdered = async () => {
    if (!po.vendorId && !(await confirmDialog({ title: '거래처가 정해지지 않았습니다', message: '거래처 없이 발주함으로 표시할까요? 오른쪽 "발주 정보"에서 거래처를 먼저 고를 수 있습니다.', confirmText: '그래도 발주' }))) return;
    act('order', '발주함으로 표시했습니다. 물건이 오면 [입고 처리]를 눌러 주세요.', { expectedDate: info.expectedDate || null });
  };
  const cancel = async () => {
    if (!(await confirmDialog({ title: '이 발주서를 취소할까요?', message: po.status === 'ordered' ? '이미 거래처에 주문했다면 거래처에도 취소를 알려 주세요. 이미 입고된 수량은 재고에 그대로 남습니다.' : '취소한 발주서는 목록의 "취소" 탭에 남습니다.', danger: true, confirmText: '발주 취소' }))) return;
    act('cancel', '발주서를 취소했습니다.');
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: '이 발주서를 삭제할까요?', message: '삭제하면 되돌릴 수 없습니다.', danger: true, confirmText: '삭제' }))) return;
    try {
      await api.del(`/inventory/orders/${id}`);
      toast.success('삭제했습니다.');
      navigate('#/orders');
    } catch (e) {
      toast.error(e.message);
    }
  };
  const saveInfo = async () => {
    try {
      const body = { expectedDate: info.expectedDate || null, note: info.note || null };
      if (po.status === 'draft') body.vendorId = info.vendorId ? Number(info.vendorId) : null;
      const r = await api.patch(`/inventory/orders/${id}`, body);
      setData(r);
      toast.success('발주 정보를 저장했습니다.');
    } catch (e) {
      toast.error(e.message);
    }
  };
  const infoDirty = info.expectedDate !== (po.expectedDate || '') || info.note !== (po.note || '') || (po.status === 'draft' && info.vendorId !== (po.vendorId ? String(po.vendorId) : ''));
  const editable = po.status === 'draft' || po.status === 'ordered';
  const v = po.vendor;

  return html`
    <div class="inv-back"><a href="#/orders" class="btn btn-ghost btn-sm"><${Icon} name="arrow-left" size=${14} />발주서 목록</a></div>
    <header class="page-header">
      <div class="grow">
        <div class="row wrap" style=${{ gap: '8px', marginBottom: '6px' }}>
          <${StatusBadge} po=${po} />
          ${po.overdue ? html`<${Badge} color="red">입고 예정일 지남</${Badge}>` : null}
        </div>
        <h1 class="page-title">${po.vendorName || '거래처 미지정'} 발주서 <span class="muted num" style=${{ fontWeight: 500, fontSize: '15px' }}>${po.poNo}</span></h1>
        <div class="mt-2"><${Steps} po=${po} /></div>
      </div>
      <div class="page-actions">
        ${po.status === 'draft' ? html`<${Button} variant="primary" icon="send" disabled=${!po.lines.length} onClick=${markOrdered}>발주함으로 표시</${Button}>` : null}
        ${po.status === 'ordered' ? html`<${Button} variant="primary" icon="package-plus" onClick=${() => setModal('receive')}>입고 처리</${Button}>` : null}
        <${LinkButton} href=${`#/orders/${po.id}/print`} icon="printer">인쇄·PDF</${LinkButton}>
        <${Menu} size="md" items=${[
          { label: '발주 취소', icon: 'circle-x', onClick: cancel, hidden: !editable },
          { label: '삭제', icon: 'trash-2', danger: true, onClick: remove, hidden: !(po.status === 'draft' || po.status === 'cancelled') },
        ]} />
      </div>
    </header>
    ${po.status === 'draft' && !po.vendorId ? html`<${Callout} kind="warn" title="거래처가 정해지지 않았습니다.">오른쪽 "발주 정보"에서 거래처를 고르면 인쇄물과 주문 메시지에 거래처 정보가 들어갑니다.</${Callout}><div style=${{ height: '14px' }}></div>` : null}

    <div class="grid detail-grid">
      <div class="stack lg">
        ${po.status === 'draft' ? html`<${LinesEditor} po=${po} key=${po.updatedAt} onSaved=${setData} />` : html`<${LinesView} po=${po} />`}
        ${po.moves.length
          ? html`<${Card} title="입고 기록" icon="history" sub=${`${po.moves.length}건`} flush>
              <div class="table-wrap"><table class="table table-compact">
                <thead><tr><th>날짜</th><th>품목</th><th class="right">수량</th><th class="right">단가</th><th>로트 · 유효기간</th><th>기록</th></tr></thead>
                <tbody>${po.moves.map(
                  (m) => html`<tr key=${m.id}>
                    <td class="num small nowrap">${fmtDate(m.date, { weekday: false })}</td>
                    <td><a href=${`#/inventory/${m.itemId}`}>${m.itemName}</a></td>
                    <td class="right num success-text strong">+${fq(m.qty)}${m.unit}</td>
                    <td class="right num small">${m.unitPrice != null ? fmtMoney(m.unitPrice) : ''}</td>
                    <td class="small text-2">${[m.lotNo, m.expiryDate].filter(Boolean).join(' · ')}</td>
                    <td class="small text-2">${m.userName}</td>
                  </tr>`
                )}</tbody>
              </table></div>
            </${Card}>`
          : null}
      </div>
      <div class="stack lg">
        <${Card} title="발주 정보" icon="clipboard-list" footer=${editable && infoDirty ? html`<${Button} size="sm" onClick=${() => setInfo({ vendorId: po.vendorId ? String(po.vendorId) : '', expectedDate: po.expectedDate || '', note: po.note || '' })}>되돌리기</${Button}><${Button} size="sm" variant="primary" icon="save" onClick=${saveInfo}>저장</${Button}>` : null}>
          <div class="stack">
            ${po.status === 'draft'
              ? html`<${Field} label="거래처"><${Select} value=${info.vendorId} onChange=${(e) => setInfo({ ...info, vendorId: e.target.value })} placeholder="정하지 않음" options=${(meta?.vendors || []).filter((x) => x.active || String(x.id) === info.vendorId).map((x) => ({ value: String(x.id), label: x.name }))} /></${Field}>`
              : null}
            <dl class="inv-dl">
              <dt>작성</dt><dd>${fmtDate(po.createdAt.slice(0, 10))}${po.createdByName ? ` · ${po.createdByName}` : ''}</dd>
              <dt>발주일</dt><dd>${po.orderDate ? fmtDate(po.orderDate) : html`<span class="muted">아직 발주 전</span>`}</dd>
              ${po.receivedDate ? html`<dt>입고 완료</dt><dd>${fmtDate(po.receivedDate)}</dd>` : null}
            </dl>
            ${editable
              ? html`<${Field} label="입고 희망일"><${Input} type="date" value=${info.expectedDate} onInput=${(e) => setInfo({ ...info, expectedDate: e.target.value })} /></${Field}>
                  <${Field} label="메모"><${Textarea} rows=${3} value=${info.note} onInput=${(e) => setInfo({ ...info, note: e.target.value })} placeholder="예: 오전 배송 요청" maxlength="1000" /></${Field}>`
              : html`<dl class="inv-dl"><dt>입고 희망일</dt><dd>${po.expectedDate ? fmtDate(po.expectedDate) : '—'}</dd>${po.note ? html`<dt>메모</dt><dd class="pre">${po.note}</dd>` : null}</dl>`}
          </div>
        </${Card}>
        ${v
          ? html`<${Card} title="거래처" icon="truck" actions=${html`<${LinkButton} size="sm" variant="ghost" href=${`#/vendors/${v.id}`} iconRight="chevron-right">거래처 보기</${LinkButton}>`}>
              <dl class="inv-dl">
                <dt>이름</dt><dd class="strong">${v.name}</dd>
                ${v.contactName ? html`<dt>담당자</dt><dd>${v.contactName}</dd>` : null}
                ${v.phone ? html`<dt>전화</dt><dd class="num">${v.phone}</dd>` : null}
                ${v.email ? html`<dt>이메일</dt><dd>${v.email}</dd>` : null}
                <dt>주문 방법</dt><dd><${Badge} color="blue"><${Icon} name=${METHOD_ICON[v.orderMethod] || 'send'} size=${12} />${v.orderMethod}</${Badge}></dd>
                ${v.website ? html`<dt>웹사이트</dt><dd><a href=${webHref(v.website)} target="_blank" rel="noopener noreferrer">${v.website}</a></dd>` : null}
                ${v.paymentTerms ? html`<dt>결제 조건</dt><dd>${v.paymentTerms}</dd>` : null}
              </dl>
            </${Card}>`
          : null}
        ${editable ? html`<${VendorMessage} po=${po} />` : null}
      </div>
    </div>
    ${modal === 'receive' ? html`<${ReceiveModal} po=${po} onClose=${() => setModal(null)} onDone=${(r) => { setModal(null); setData(r); clearMetaCache(); }} />` : null}
  `;
}

// ---------------- 인쇄용 발주서 ----------------
function PoPrint({ id }) {
  const { data: po, loading, error, reload } = useApi(`/inventory/orders/${id}`);
  const clinic = useClinic();
  if (error && !po) return html`<${ErrorState} error=${error} onRetry=${reload} />`;
  if (loading && !po) return html`<${Loading} />`;
  const c = clinic || {};
  const v = po.vendor;
  const d = po.orderDate || todayStr();
  const [y, m, dd] = d.split('-');
  return html`
    <div class="po-print-bar no-print">
      <a href=${`#/orders/${po.id}`} class="btn btn-ghost btn-sm"><${Icon} name="arrow-left" size=${14} />발주서로</a>
      <div class="grow"></div>
      <span class="small muted">인쇄 창에서 대상(프린터)을 "PDF로 저장"으로 고르면 PDF 파일이 됩니다.</span>
      <${Button} variant="primary" icon="printer" onClick=${printNow}>인쇄</${Button}>
    </div>
    <${PrintDoc} title="발 주 서" meta=${`발주번호 ${po.poNo}\n발주일 ${d.replace(/-/g, '.')}`}>
      <div class="po-paper-parties">
        <div class="box">
          <h3>받는 곳 (공급처)</h3>
          <div class="who">${v ? v.name : '(거래처 미정)'} 귀중</div>
          ${v && v.contactName ? html`<div>담당: ${v.contactName}</div>` : null}
          ${v && v.phone ? html`<div>전화: ${v.phone}</div>` : null}
          ${v && v.email ? html`<div>이메일: ${v.email}</div>` : null}
        </div>
        <div class="box">
          <h3>보내는 곳 (발주처)</h3>
          <div class="who">${c.name || ''}</div>
          ${c.address ? html`<div>${c.address}</div>` : null}
          ${c.phone ? html`<div>전화: ${c.phone}</div>` : null}
          ${po.createdByName ? html`<div>담당: ${po.createdByName}</div>` : null}
        </div>
      </div>
      <p style=${{ marginBottom: '10px' }}>아래와 같이 발주하오니 기일 내 납품하여 주시기 바랍니다.</p>
      <table class="table po-paper-table">
        <thead><tr><th class="center" style=${{ width: '36px' }}>No</th><th>품목명</th><th>규격</th><th class="center">단위</th><th class="right">수량</th><th class="right">단가</th><th class="right">금액</th></tr></thead>
        <tbody>
          ${po.lines.map(
            (l, i) => html`<tr key=${l.id}>
              <td class="center">${i + 1}</td><td>${l.itemName}</td><td>${l.spec}</td><td class="center">${l.unit}</td>
              <td class="right num">${fq(l.qty)}</td><td class="right num">${l.unitPrice != null ? fmtNumber(l.unitPrice) : ''}</td><td class="right num">${fmtNumber(l.amount)}</td>
            </tr>`
          )}
          ${Array.from({ length: Math.max(0, 8 - po.lines.length) }).map(() => html`<tr><td> </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`)}
        </tbody>
        <tfoot><tr><td colspan="4" class="center">합계</td><td class="right num">${fq(po.lines.reduce((s, l) => s + l.qty, 0))}</td><td></td><td class="right num">${fmtNumber(po.total)}</td></tr></tfoot>
      </table>
      <div class="po-paper-sum"><span>합계 금액</span><b class="num">${won(po.total)}</b></div>
      <div class="po-paper-notes">
        <div><strong>납품 희망일:</strong> ${po.expectedDate ? fmtDate(po.expectedDate, { long: true }) : '협의'}</div>
        ${v && v.paymentTerms ? html`<div><strong>결제 조건:</strong> ${v.paymentTerms}</div>` : null}
        ${po.note ? html`<div><strong>비고:</strong> ${po.note}</div>` : null}
        <div class="muted">※ 단가는 최근 거래 단가 기준이며, 변동이 있으면 납품 전에 알려 주시기 바랍니다.</div>
      </div>
      <div class="po-sign">
        ${y}년 ${Number(m)}월 ${Number(dd)}일<br />
        <strong>${c.name || ''}</strong>${c.representative ? ` 대표 ${c.representative}` : ''} (인)
      </div>
    </${PrintDoc}>
  `;
}

export default function OrdersPage({ route }) {
  const id = route.parts[1];
  if (id && route.parts[2] === 'print') return html`<${PoPrint} id=${id} key=${`p${id}`} />`;
  return id ? html`<${PoDetail} id=${id} key=${id} />` : html`<${PoList} route=${route} />`;
}
