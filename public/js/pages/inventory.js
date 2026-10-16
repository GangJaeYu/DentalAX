/*
 * 이 파일이 하는 일: [B. 재고·구매] 재고 화면입니다.
 *
 *   #/inventory                 탭: 재고 현황 / 입출고 기록 / 경고 / 단가 변동
 *        ?tab=moves|alerts|prices, ?q=검색어, ?cat=분류, ?low=1(부족만), ?status=expiring|expired
 *   #/inventory/12              품목 상세 (로트·유효기간, 최근 기록, 단가 추이, 진행 중 발주)
 *
 *   - 목록에서 바로 [입고]·[출고] (작은 창에서 수량·로트·유효기간·단가 입력) → 클릭 수 최소화
 *   - 출고는 유효기간이 빠른 로트부터 자동으로 차감되고, 창에서 어느 로트가 빠질지 미리 보여 줌
 *   - [거래명세서로 입고]: 명세서 글을 붙여 넣으면 AI가 품목을 읽고, 기존 품목과 짝을 맞춰 한 번에 입고
 *   - 품목 추가·수정·실사 조정·CSV 가져오기는 실장 이상만 (버튼도 숨김, 서버에서도 막음)
 *
 * 다른 화면(발주서·거래처)에서도 쓰는 부품(수량 표시, 재고 막대, 단가 그래프, 입출고 창)을 export 합니다.
 */
import { html, useState, useEffect, useMemo, cx, fmtDate, fmtDateTime, fmtNumber, fmtMoney, toQuery, todayStr, daysUntil } from '../lib.js';
import { api, readFileAsText } from '../api.js';
import { navigate, setQuery } from '../router.js';
import { can, toast, confirmDialog } from '../store.js';
import {
  PageHeader, Card, Button, IconButton, LinkButton, Badge, Icon, Tabs, Seg, Stat, Modal, Field, Input, Textarea, Select, Checkbox, FormGrid,
  SearchInput, useApi, useForm, Loading, ErrorState, EmptyState, DataTable, Pagination, Menu, Callout, DdayBadge,
  PiiBanner, useAI, AiButton,
} from '../ui/index.js';

// ---------------- 공통 도우미 (다른 화면에서도 씀) ----------------
export const CATEGORY_COLOR = { 소모품: 'blue', 재료: 'purple', 약품: 'red', 기구: 'amber', '사무·위생': 'green', 기타: 'gray' };
export const CATEGORY_ICON = { 소모품: 'boxes', 재료: 'package', 약품: 'shield-check', 기구: 'wrench', '사무·위생': 'sparkles', 기타: 'tag' };
const NOTE_IN = ['택배 입고', '방문 납품', '샘플 받음'];
const NOTE_OUT = ['진료실 사용', '진료실 보충', '파손·오염 폐기', '반품'];

/** 수량 글자: 2.5 → '2.5' */
export const fq = (n) => fmtNumber(n, 2);

/** 수량 + 단위 (숫자는 굵게, 단위는 흐리게) */
export function Qty({ value, unit, class: cls }) {
  return html`<span class=${cx('inv-qty', cls)}><b>${fq(value)}</b><span class="unit">${unit}</span></span>`;
}

/** 재고 상태 배지 */
export function StatusBadge({ item }) {
  if (!item.active) return html`<${Badge}>보관됨</${Badge}>`;
  if (item.status === 'out') return html`<${Badge} color="red" dot>바닥</${Badge}>`;
  if (item.status === 'low') return html`<${Badge} color="amber" dot>부족</${Badge}>`;
  return html`<${Badge} color="green" dot>충분</${Badge}>`;
}

/** 유효기간 D-day 배지: 지남 빨강, 30일 이내 주황, 그 외 회색 */
export function ExpiryBadge({ days }) {
  if (days === null || days === undefined) return null;
  const color = days < 0 ? 'red' : days <= 30 ? 'amber' : 'gray';
  return html`<${Badge} color=${color}>${days < 0 ? `${-days}일 지남` : days === 0 ? 'D-day' : `D-${days}`}</${Badge}>`;
}

/** 유효기간 칸: 만료분이 있으면 빨강, 30일 이내면 D-n */
export function ExpiryCell({ item }) {
  const parts = [];
  if (item.expiredQty > 0) parts.push(html`<${Badge} color="red" title="유효기간이 지난 수량이 남아 있습니다">만료 ${fq(item.expiredQty)}${item.unit}</${Badge}>`);
  if (item.nextExpiry) {
    parts.push(
      item.expiringSoon
        ? html`<${ExpiryBadge} days=${item.daysToExpiry} />`
        : html`<span class="small muted num">${item.nextExpiry.replace(/-/g, '.')}</span>`
    );
  }
  if (!parts.length) return html`<span class="muted small">${item.trackExpiry ? '—' : ''}</span>`;
  return html`<div class="row wrap" style=${{ gap: '4px' }}>${parts}</div>`;
}

/** 재고 막대: 적정 재고의 2배를 가득 찬 상태로 보고, 가운데 선이 적정 재고 */
export function StockBar({ item }) {
  const full = Math.max(item.minQty * 2, item.currentQty, 1);
  const pct = Math.min(100, (item.currentQty / full) * 100);
  const minPct = item.minQty > 0 ? Math.min(100, (item.minQty / full) * 100) : null;
  return html`<div class=${cx('inv-bar', item.status === 'low' && 'low', item.status === 'out' && 'out')} aria-hidden="true">
    <span style=${{ width: `${pct}%` }}></span>
    ${minPct !== null ? html`<i style=${{ left: `${minPct}%` }}></i>` : null}
  </div>`;
}

/** 단가 추이 작은 그래프 (선 + 점) */
export function Sparkline({ values, width = 96, height = 28, trend }) {
  if (!values || values.length < 2) return html`<span class="muted small">—</span>`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = 3;
  const span = max - min || 1;
  const pts = values.map((v, i) => [pad + (i * (width - pad * 2)) / (values.length - 1), height - pad - ((v - min) / span) * (height - pad * 2)]);
  const line = pts.map((p) => p.map((x) => x.toFixed(1)).join(',')).join(' ');
  const area = `${pad},${height - pad} ${line} ${(width - pad).toFixed(1)},${height - pad}`;
  const last = pts[pts.length - 1];
  return html`<svg class=${cx('spark', trend)} width=${width} height=${height} viewBox=${`0 0 ${width} ${height}`} role="img" aria-label=${`단가 추이 ${values.map((v) => fmtNumber(v)).join(' → ')}원`}>
    <polygon class="area" points=${area} opacity="0.6" />
    <polyline class="line" points=${line} />
    <circle class="dot" cx=${last[0]} cy=${last[1]} r="2.6" />
  </svg>`;
}

/** 변동률 표시: ▲ 10.8% (빨강) / ▼ 5.3% (초록) */
export function Change({ pct }) {
  if (pct === null || pct === undefined) return html`<span class="muted small">변동 없음</span>`;
  if (pct === 0) return html`<span class="muted small">0%</span>`;
  const up = pct > 0;
  return html`<span class=${cx('inv-change', up ? 'up' : 'down')}><${Icon} name=${up ? 'trending-up' : 'trending-down'} size=${14} />${up ? '+' : ''}${fmtNumber(pct, 1)}%</span>`;
}

/** 분류·거래처 목록 (선택칸용) — 한 번 불러와 여러 창에서 같이 씀 */
let metaCache = null;
export function useMeta() {
  const [meta, setMeta] = useState(metaCache);
  useEffect(() => {
    let alive = true;
    api
      .get('/inventory/meta')
      .then((m) => {
        metaCache = m;
        if (alive) setMeta(m);
      })
      .catch(() => {});
    return () => (alive = false);
  }, []);
  return meta;
}
export function clearMetaCache() {
  metaCache = null;
}

/** 출고할 때 어느 로트에서 빠질지 미리 계산 (서버와 같은 순서: 유효기간 남은 것 빠른 순 → 유효기간 없음 → 로트 없는 재고 → 만료) */
function previewPlan(lots, untracked, qty) {
  const today = todayStr();
  const valid = lots.filter((l) => l.expiryDate && l.expiryDate >= today).sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  const noExp = lots.filter((l) => !l.expiryDate);
  const expired = lots.filter((l) => l.expiryDate && l.expiryDate < today);
  const order = [...valid, ...noExp, { id: null, qty: untracked }, ...expired];
  const plan = [];
  let left = qty;
  for (const l of order) {
    if (left <= 0) break;
    const take = Math.min(left, l.qty);
    if (take <= 0) continue;
    plan.push({ ...l, take });
    left = Math.round((left - take) * 1000) / 1000;
  }
  return plan;
}

/** − [ 숫자 ] + 수량 입력칸 (태블릿에서 누르기 쉽게 크게) */
export function QtyStepper({ value, onChange, unit, autoFocus, label = '수량', ...rest }) {
  const n = Number(value) || 0;
  const step = (d) => onChange(String(Math.max(0, Math.round((n + d) * 1000) / 1000)));
  return html`<div class="qty-stepper">
    <button type="button" onClick=${() => step(-1)} aria-label="1 줄이기"><${Icon} name="minus" size=${18} /></button>
    <input type="text" inputmode="decimal" value=${value} aria-label=${label} placeholder="0" onInput=${(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))} autofocus=${autoFocus} ...${rest} />
    ${unit ? html`<span class="unit">${unit}</span>` : null}
    <button type="button" onClick=${() => step(1)} aria-label="1 늘리기"><${Icon} name="plus" size=${18} /></button>
  </div>`;
}

function Chips({ items, value, onPick }) {
  return html`<div class="inv-chips">
    ${items.map((it) => {
      const v = typeof it === 'object' ? it.value : it;
      const l = typeof it === 'object' ? it.label : it;
      return html`<button type="button" class="inv-chip" aria-pressed=${String(value) === String(v) ? 'true' : 'false'} onClick=${() => onPick(v)}>${l}</button>`;
    })}
  </div>`;
}

/**
 * 입고·출고 작은 창
 * @param item  품목(목록 한 줄 또는 상세)
 * @param type  'in' | 'out'
 * @param lotId (선택) 이 로트에서만 출고 (만료품 폐기 등)
 */
export function MoveModal({ item, type: initialType = 'in', lotId, presetQty, presetNote, onClose, onDone }) {
  const [type, setType] = useState(initialType);
  const meta = useMeta();
  const detail = useApi(`/inventory/items/${item.id}`);
  const it = detail.data || item;
  const f = useForm({
    qty: presetQty ? String(presetQty) : '',
    unitPrice: item.lastUnitPrice ?? '',
    lotNo: '',
    expiryDate: '',
    vendorId: item.vendorId ? String(item.vendorId) : '',
    note: presetNote || '',
  });
  const [showLot, setShowLot] = useState(!!item.trackExpiry);
  const qty = Number(f.values.qty) || 0;
  const after = Math.round((type === 'in' ? it.currentQty + qty : it.currentQty - qty) * 1000) / 1000;
  const short = type === 'out' && qty > it.currentQty;
  const lots = detail.data ? detail.data.lots : [];
  const plan = type === 'out' && detail.data && qty > 0 && !short ? (lotId ? lots.filter((l) => l.id === lotId).map((l) => ({ ...l, take: Math.min(qty, l.qty) })) : previewPlan(lots, detail.data.untrackedQty, qty)) : [];

  const save = f.submit(async (v) => {
    const body =
      type === 'in'
        ? { qty: v.qty, unitPrice: v.unitPrice === '' ? null : v.unitPrice, lotNo: v.lotNo || null, expiryDate: v.expiryDate || null, vendorId: v.vendorId ? Number(v.vendorId) : null, note: v.note || null }
        : { qty: v.qty, note: v.note || null, lotId: lotId || null };
    const r = await api.post(`/inventory/items/${item.id}/${type}`, body);
    toast.success(`${item.name} ${fq(v.qty)}${item.unit} ${type === 'in' ? '입고' : '출고'}했습니다. (재고 ${fq(r.item.currentQty)}${item.unit})`);
    if (r.warnings && r.warnings.length) toast.warn(r.warnings.join('\n'));
    onDone && onDone(r);
  });

  const vendorOptions = (meta?.vendors || []).filter((x) => x.active || String(x.id) === f.values.vendorId).map((x) => ({ value: String(x.id), label: x.name }));
  return html`<${Modal}
    open=${true}
    title=${lotId ? '만료품 폐기' : type === 'in' ? '입고 기록' : '출고 기록'}
    onClose=${onClose}
    busy=${f.busy}
    footer=${html`
      <${Button} onClick=${onClose}>취소</${Button}>
      <${Button} variant=${type === 'in' ? 'primary' : lotId ? 'danger-solid' : 'primary'} icon=${type === 'in' ? 'package-plus' : 'package-minus'} loading=${f.busy} disabled=${short || !qty} onClick=${save}>
        ${lotId ? '폐기 기록' : type === 'in' ? '입고 기록' : '출고 기록'}
      </${Button}>
    `}
  >
    <form class="stack" onSubmit=${save}>
      ${!lotId
        ? html`<${Seg}
            label="입고 또는 출고"
            value=${type}
            onChange=${setType}
            items=${[
              { value: 'in', label: '입고 (들어옴)' },
              { value: 'out', label: '출고 (사용)' },
            ]}
          />`
        : null}
      <div class="inv-move-head">
        <div class=${`icon-box ${CATEGORY_COLOR[item.category] || ''}`}><${Icon} name=${CATEGORY_ICON[item.category] || 'package'} size=${16} /></div>
        <div class="grow inv-name">
          <span class="title ellipsis">${item.name}</span>
          <span class="sub ellipsis">${[item.spec, item.location].filter(Boolean).join(' · ') || item.category}</span>
        </div>
        <div class="inv-move-flow" aria-live="polite">
          <span class="now">${fq(it.currentQty)}</span>
          <${Icon} name="arrow-right" size=${14} class="muted" />
          <span class=${cx('next', short && 'danger-text', !short && type === 'out' && it.minQty > 0 && after <= it.minQty && 'warning-text')}>${short ? '부족' : fq(after)}</span>
          <span class="small muted">${item.unit}</span>
        </div>
      </div>

      <${Field} label=${`${type === 'in' ? '입고' : '출고'} 수량`} required error=${f.errors.qty || (short ? `지금 재고(${fq(it.currentQty)}${item.unit})보다 많이 출고할 수 없습니다.` : null)}>
        <${QtyStepper} value=${f.values.qty} onChange=${(x) => f.set('qty', x)} unit=${item.unit} autoFocus />
      </${Field}>
      <${Chips}
        items=${[...new Set([1, 2, 5, 10, ...(type === 'in' && it.reorderQty > 0 ? [it.reorderQty] : [])])].map((n) => ({ value: String(n), label: `${fq(n)}${item.unit}` }))}
        value=${f.values.qty}
        onPick=${(x) => f.set('qty', x)}
      />

      ${type === 'in'
        ? html`<${FormGrid}>
              <${Field} label="단가 (원)" hint=${item.lastUnitPrice ? `최근 단가 ${fmtMoney(item.lastUnitPrice)}` : '모르면 비워 두세요'} error=${f.errors.unitPrice}>
                <${Input} inputmode="numeric" ...${f.bind('unitPrice')} placeholder="예: 6500" />
              </${Field}>
              <${Field} label="거래처" error=${f.errors.vendorId}>
                <${Select} ...${f.bind('vendorId')} onChange=${(e) => f.set('vendorId', e.target.value)} placeholder="선택 안 함" options=${vendorOptions} />
              </${Field}>
            </${FormGrid}>
            ${showLot
              ? html`<${FormGrid}>
                  <${Field} label=${item.trackExpiry ? '유효기간' : '유효기간 (선택)'} required=${item.trackExpiry} error=${f.errors.expiryDate} hint=${item.trackExpiry ? '유효기간이 빠른 것부터 먼저 쓰도록 자동 차감됩니다' : null}>
                    <${Input} type="date" ...${f.bind('expiryDate')} />
                  </${Field}>
                  <${Field} label="로트(묶음) 번호 (선택)" error=${f.errors.lotNo}>
                    <${Input} ...${f.bind('lotNo')} placeholder="예: LD2410-03" maxlength="50" />
                  </${Field}>
                </${FormGrid}>`
              : html`<div><${Button} variant="ghost" size="sm" icon="plus" onClick=${() => setShowLot(true)}>로트·유효기간 입력</${Button}></div>`}`
        : html`${plan.length
            ? html`<div class="inv-plan" aria-label="차감될 로트">
                <div class="small strong text-2">${lotId ? '이 로트에서 뺍니다' : '유효기간이 빠른 것부터 이렇게 빠집니다'}</div>
                ${plan.map(
                  (p) => html`<div class="inv-plan-row">
                    <${Icon} name="package-minus" size=${13} class="muted" />
                    <span class="grow">${p.id ? p.lotNo || '로트' : '로트 없이 들어온 재고'}${p.expiryDate ? html` <span class="muted">· ${p.expiryDate.replace(/-/g, '.')}</span>` : null}</span>
                    ${p.expiryDate ? html`<${ExpiryBadge} days=${daysUntil(p.expiryDate)} />` : null}
                    <strong class="num">${fq(p.take)}${item.unit}</strong>
                  </div>`
                )}
              </div>`
            : null}`}

      <${Field} label="메모 (선택)" error=${f.errors.note}>
        <${Input} ...${f.bind('note')} placeholder=${type === 'in' ? '예: 택배 입고' : '예: 2번 체어 보충'} maxlength="300" />
      </${Field}>
      <${Chips} items=${type === 'in' ? NOTE_IN : NOTE_OUT} value=${f.values.note} onPick=${(x) => f.set('note', x)} />
      <button type="submit" class="sr-only" tabindex="-1">저장</button>
    </form>
  </${Modal}>`;
}

// ---------------- 품목 추가·수정 창 (실장 이상) ----------------
function ItemEditor({ item, onClose, onSaved }) {
  const meta = useMeta();
  const f = useForm(
    item
      ? {
          name: item.name,
          spec: item.spec || '',
          category: item.category,
          unit: item.unit,
          vendorId: item.vendorId ? String(item.vendorId) : '',
          location: item.location || '',
          minQty: String(item.minQty ?? ''),
          reorderQty: item.reorderQty ? String(item.reorderQty) : '',
          lastUnitPrice: item.lastUnitPrice ?? '',
          trackExpiry: item.trackExpiry,
          memo: item.memo || '',
        }
      : { name: '', spec: '', category: '소모품', unit: '개', vendorId: '', location: '', minQty: '', reorderQty: '', lastUnitPrice: '', initialQty: '', trackExpiry: false, memo: '' }
  );
  const save = f.submit(async (v) => {
    const body = {
      ...v,
      vendorId: v.vendorId ? Number(v.vendorId) : null,
      minQty: v.minQty === '' ? 0 : v.minQty,
      reorderQty: v.reorderQty === '' ? 0 : v.reorderQty,
      lastUnitPrice: v.lastUnitPrice === '' ? null : v.lastUnitPrice,
      spec: v.spec || null,
      location: v.location || null,
      memo: v.memo || null,
    };
    if (!item) body.initialQty = v.initialQty === '' ? null : v.initialQty;
    const saved = item ? await api.patch(`/inventory/items/${item.id}`, body) : await api.post('/inventory/items', body);
    clearMetaCache();
    toast.success(item ? '품목을 수정했습니다.' : '품목을 추가했습니다.');
    onSaved(saved);
  });
  return html`<${Modal}
    open=${true}
    size="lg"
    title=${item ? '품목 수정' : '품목 추가'}
    onClose=${onClose}
    busy=${f.busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${f.busy} onClick=${save}>${item ? '저장' : '추가'}</${Button}>`}
  >
    <form onSubmit=${save}>
      <${FormGrid}>
        <${Field} label="품목명" required error=${f.errors.name}>
          <${Input} ...${f.bind('name')} placeholder="예: 니트릴 장갑 M" maxlength="100" />
        </${Field}>
        <${Field} label="규격" error=${f.errors.spec} hint="같은 이름이라도 규격이 다르면 다른 품목으로 관리합니다">
          <${Input} ...${f.bind('spec')} placeholder="예: 100매, 4g 시린지" maxlength="100" />
        </${Field}>
        <${Field} label="분류" error=${f.errors.category}>
          <${Select} value=${f.values.category} onChange=${(e) => f.set('category', e.target.value)} options=${meta?.itemCategories || ['소모품', '재료', '약품', '기구', '사무·위생', '기타']} />
        </${Field}>
        <${Field} label="단위" error=${f.errors.unit} hint="세는 단위 (박스, 개, 봉 …)">
          <${Input} ...${f.bind('unit')} list="inv-units" maxlength="20" />
        </${Field}>
        <${Field} label="거래처" error=${f.errors.vendorId}>
          <${Select} value=${f.values.vendorId} onChange=${(e) => f.set('vendorId', e.target.value)} placeholder="정하지 않음" options=${(meta?.vendors || []).filter((x) => x.active || String(x.id) === f.values.vendorId).map((x) => ({ value: String(x.id), label: x.name }))} />
        </${Field}>
        <${Field} label="보관 위치" error=${f.errors.location}>
          <${Input} ...${f.bind('location')} placeholder="예: 소모품 창고 A-1" maxlength="100" />
        </${Field}>
        <${Field} label="적정 재고 (최소)" error=${f.errors.minQty} hint="이 수량 이하가 되면 '부족'으로 알려 줍니다">
          <${Input} inputmode="decimal" ...${f.bind('minQty')} placeholder="0" />
        </${Field}>
        <${Field} label="한 번에 주문할 수량" error=${f.errors.reorderQty} hint="비우면 (적정 재고×2 − 현재 수량)으로 계산">
          <${Input} inputmode="decimal" ...${f.bind('reorderQty')} placeholder="자동" />
        </${Field}>
        <${Field} label="최근 단가 (원)" error=${f.errors.lastUnitPrice}>
          <${Input} inputmode="numeric" ...${f.bind('lastUnitPrice')} placeholder="예: 6500" />
        </${Field}>
        ${!item
          ? html`<${Field} label="지금 있는 수량 (시작 재고)" error=${f.errors.initialQty} hint="실사 조정 기록으로 남습니다">
              <${Input} inputmode="decimal" ...${f.bind('initialQty')} placeholder="0" />
            </${Field}>`
          : html`<div></div>`}
        <div class="full">
          <${Checkbox} label="유효기간 관리 (입고할 때 유효기간을 적고, 빠른 것부터 사용)" ...${f.bind('trackExpiry', { type: 'checkbox' })} />
        </div>
        <${Field} label="메모" full error=${f.errors.memo}>
          <${Textarea} rows=${2} ...${f.bind('memo')} placeholder="예: 개봉 후 3개월 안에 사용" />
        </${Field}>
      </${FormGrid}>
      <datalist id="inv-units">${(meta?.units || ['개', '박스', '봉', '팩', '통']).map((u) => html`<option value=${u}></option>`)}</datalist>
      <button type="submit" class="sr-only" tabindex="-1">저장</button>
    </form>
  </${Modal}>`;
}

// ---------------- 실사 조정 창 (실장 이상) ----------------
function AdjustModal({ item, onClose, onDone }) {
  const f = useForm({ actualQty: String(item.currentQty), note: '' });
  const actual = f.values.actualQty === '' ? null : Number(f.values.actualQty);
  const delta = actual === null ? 0 : Math.round((actual - item.currentQty) * 1000) / 1000;
  const save = f.submit(async (v) => {
    const r = await api.post(`/inventory/items/${item.id}/adjust`, { actualQty: v.actualQty, note: v.note || null });
    toast.success(r.delta === 0 ? '실사 확인을 기록했습니다. (차이 없음)' : `재고를 ${fq(r.item.currentQty)}${item.unit}(으)로 맞췄습니다.`);
    onDone(r);
  });
  return html`<${Modal}
    open=${true}
    size="sm"
    title="실사 조정"
    onClose=${onClose}
    busy=${f.busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${f.busy} disabled=${actual === null} onClick=${save}>조정 기록</${Button}>`}
  >
    <form class="stack" onSubmit=${save}>
      <p class="small text-2">창고에서 실제로 세어 본 수량을 적으면, 차이만큼 기록을 남기고 재고를 맞춥니다.</p>
      <div class="inv-move-head">
        <div class="grow inv-name"><span class="title">${item.name}</span><span class="sub">시스템 재고 ${fq(item.currentQty)}${item.unit}</span></div>
        <div class="inv-move-flow">
          <span class=${cx('next', delta < 0 && 'danger-text', delta > 0 && 'success-text')}>${delta > 0 ? '+' : ''}${fq(delta)}</span><span class="small muted">${item.unit}</span>
        </div>
      </div>
      <${Field} label="실제 수량" required error=${f.errors.actualQty}>
        <${QtyStepper} value=${f.values.actualQty} onChange=${(x) => f.set('actualQty', x)} unit=${item.unit} autoFocus label="실제 수량" />
      </${Field}>
      <${Field} label="사유 (선택)" error=${f.errors.note}>
        <${Input} ...${f.bind('note')} placeholder="예: 월말 실사" maxlength="300" />
      </${Field}>
      <${Chips} items=${['월말 실사', '파손 폐기', '유효기간 만료 폐기', '수량 착오']} value=${f.values.note} onPick=${(x) => f.set('note', x)} />
      <button type="submit" class="sr-only" tabindex="-1">저장</button>
    </form>
  </${Modal}>`;
}

// ---------------- 단가 직접 기록 창 (실장 이상) ----------------
function PriceModal({ item, onClose, onDone }) {
  const f = useForm({ unitPrice: item.lastUnitPrice ?? '', date: todayStr() });
  const save = f.submit(async (v) => {
    await api.post(`/inventory/items/${item.id}/prices`, { unitPrice: v.unitPrice, date: v.date });
    toast.success('단가를 기록했습니다.');
    onDone();
  });
  return html`<${Modal} open=${true} size="sm" title="단가 기록" onClose=${onClose} busy=${f.busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${f.busy} onClick=${save}>기록</${Button}>`}>
    <form class="stack" onSubmit=${save}>
      <p class="small text-2">견적이나 거래처 안내로 단가가 바뀌었을 때 기록합니다. 입고할 때 단가를 적으면 자동으로 기록됩니다.</p>
      <${Field} label="단가 (원)" required error=${f.errors.unitPrice}><${Input} inputmode="numeric" ...${f.bind('unitPrice')} /></${Field}>
      <${Field} label="날짜" error=${f.errors.date}><${Input} type="date" ...${f.bind('date')} /></${Field}>
      <button type="submit" class="sr-only" tabindex="-1">저장</button>
    </form>
  </${Modal}>`;
}

// ---------------- 거래명세서 → 입고 (AI) ----------------
const SAMPLE_INVOICE = `거래명세서 (공급자: 한빛덴탈)
No  품명                 규격        수량   단가      금액
1   복합레진 A2          4g 시린지   3      41,000    123,000
2   리도카인 앰플        1.8mL 50앰플  2      34,500    69,000
3   알지네이트 인상재    453g        4      8,500     34,000
4   교정용 왁스          5개입       2      3,000     6,000
합계                                                  232,000`;

/** 글자 비교용으로 정리: 공백·괄호·기호 없애고 소문자 */
const norm = (s) => String(s || '').toLowerCase().replace(/[\s()[\]\-_,./#·×x*]+/g, '').replace(/박스|box|bx/g, '');
function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}
/** 두 글이 얼마나 비슷한지 0~1 (글자 2개 묶음 겹침 정도). 한쪽이 다른 쪽을 포함하면 높게 */
function similarity(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return 0.9 * (Math.min(x.length, y.length) / Math.max(x.length, y.length)) + 0.1;
  const A = bigrams(x);
  const B = bigrams(y);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) || 0);
  const total = [...A.values()].reduce((s, n) => s + n, 0) + [...B.values()].reduce((s, n) => s + n, 0);
  return total ? (2 * inter) / total : 0;
}
/** 인식된 줄과 가장 비슷한 기존 품목 순서대로 */
function rankItems(line, items) {
  return items
    .map((it) => {
      const nameScore = similarity(line.name, it.name);
      const fullScore = similarity(`${line.name} ${line.spec || ''}`, `${it.name} ${it.spec || ''}`);
      return { it, score: Math.max(nameScore * 0.92, fullScore) };
    })
    .sort((a, b) => b.score - a.score);
}

function InvoiceModal({ onClose, onDone }) {
  const isManager = can('manager');
  const meta = useMeta();
  const itemsApi = useApi('/inventory/items');
  const ai = useAI('inventory.parseInvoice');
  const [text, setText] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const items = itemsApi.data ? itemsApi.data.rows : [];

  const run = async () => {
    if (text.trim().length < 2) return toast.warn('거래명세서 내용을 붙여 넣어 주세요.');
    const r = await ai.run({ text });
    if (!r) return;
    const lines = (r.data && r.data.lines) || [];
    if (!lines.length) {
      setRows([]);
      return;
    }
    // 기존 품목과 자동으로 짝 맞추기 (비슷한 정도 45% 이상이면 자동 연결)
    setRows(
      lines.map((l, i) => {
        const ranked = rankItems(l, items);
        const best = ranked[0];
        const auto = best && best.score >= 0.45;
        return {
          key: i,
          name: l.name,
          spec: l.spec || '',
          qty: String(l.qty ?? 1),
          unitPrice: l.unitPrice === null || l.unitPrice === undefined ? '' : String(l.unitPrice),
          target: auto ? String(best.it.id) : isManager ? 'new' : 'skip',
          score: best ? best.score : 0,
          ranked: ranked.slice(0, 12),
          lotNo: '',
          expiryDate: '',
        };
      })
    );
  };
  const setRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const active = (rows || []).filter((r) => r.target !== 'skip' && Number(r.qty) > 0);

  const submit = async () => {
    if (!active.length) return toast.warn('입고할 품목이 없습니다. 연결할 품목을 골라 주세요.');
    setBusy(true);
    try {
      const r = await api.post('/inventory/moves/bulk-in', {
        vendorId: vendorId ? Number(vendorId) : null,
        note: '거래명세서 입고',
        lines: active.map((x) =>
          x.target === 'new'
            ? { newItem: { name: x.name, spec: x.spec || null, unit: '개', category: '기타' }, qty: x.qty, unitPrice: x.unitPrice === '' ? null : x.unitPrice, lotNo: x.lotNo || null, expiryDate: x.expiryDate || null }
            : { itemId: Number(x.target), qty: x.qty, unitPrice: x.unitPrice === '' ? null : x.unitPrice, lotNo: x.lotNo || null, expiryDate: x.expiryDate || null }
        ),
      });
      toast.success(`${r.count}개 품목을 입고했습니다.${r.created ? ` (새 품목 ${r.created}개 등록 — 분류·단위를 확인해 주세요)` : ''}`);
      onDone();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const res = ai.result;
  return html`<${Modal}
    open=${true}
    size="xl"
    title="거래명세서로 한 번에 입고"
    onClose=${onClose}
    busy=${busy}
    footer=${rows && rows.length
      ? html`<${Button} variant="ghost" icon="arrow-left" onClick=${() => setRows(null)}>다시 붙여넣기</${Button}><div class="grow"></div>
          <${Button} onClick=${onClose}>취소</${Button}>
          <${Button} variant="primary" icon="package-plus" loading=${busy} disabled=${!active.length} onClick=${submit}>${active.length}개 품목 입고</${Button}>`
      : html`<${Button} onClick=${onClose}>닫기</${Button}>`}
  >
    ${!rows
      ? html`<div class="stack">
          <p class="small text-2">거래처에서 받은 거래명세서(납품서)의 글을 복사해 붙여 넣으면, AI가 품목·수량·단가를 읽어 기존 품목과 짝을 맞춰 줍니다. 확인한 뒤 한 번에 입고합니다.</p>
          <div class="row wrap">
            <${Field} label="거래처 (선택)">
              <${Select} value=${vendorId} onChange=${(e) => setVendorId(e.target.value)} placeholder="선택 안 함" options=${(meta?.vendors || []).filter((x) => x.active).map((x) => ({ value: String(x.id), label: x.name }))} style=${{ width: '220px' }} />
            </${Field}>
          </div>
          <${PiiBanner} />
          <${Field} label="거래명세서 내용" hint="엑셀·PDF·문자에서 표 부분을 복사해 그대로 붙여 넣으면 됩니다. (6,000자까지)">
            <${Textarea} rows=${10} value=${text} onInput=${(e) => setText(e.target.value)} placeholder=${'예)\n1  니트릴 장갑 M (100매)  10박스  7,200  72,000\n2  덴탈 마스크 50매  5  4,500  22,500'} maxlength="6000" />
          </${Field}>
          <div class="row wrap">
            <${AiButton} onClick=${run} loading=${ai.busy || itemsApi.loading} disabled=${!items.length && itemsApi.loading}>AI로 품목 인식</${AiButton}>
            <${Button} variant="ghost" size="sm" icon="file-text" onClick=${() => setText(SAMPLE_INVOICE)}>예시 넣어 보기</${Button}>
          </div>
          ${ai.busy ? html`<div class="ai-panel"><div class="ai-thinking"><span class="ai-dots"><span></span><span></span><span></span></span> AI가 거래명세서를 읽고 있습니다…</div></div>` : null}
          ${ai.error ? html`<${Callout} kind=${ai.error.data && ai.error.data.pii ? 'warn' : 'danger'} title=${ai.error.data && ai.error.data.pii ? '개인정보 감지' : 'AI 오류'}>${ai.error.message}</${Callout}>` : null}
        </div>`
      : !rows.length
        ? html`<${EmptyState} icon="receipt" title="품목 줄을 찾지 못했습니다" desc="품목 이름과 수량(단가)이 한 줄에 같이 있는지 확인하고 다시 붙여 넣어 주세요." action=${html`<${Button} icon="arrow-left" onClick=${() => setRows(null)}>다시 붙여넣기</${Button}>`} />`
        : html`<div class="stack">
            <div class="row wrap">
              ${res && res.demo ? html`<${Badge} color="amber">데모 예시 — 규칙으로 읽은 결과</${Badge}>` : html`<${Badge} color="purple">AI 인식 결과</${Badge}>`}
              <span class="small text-2">${rows.length}줄 인식 · 자동 연결 ${rows.filter((r) => r.target !== 'new' && r.target !== 'skip').length}개. 연결이 틀렸으면 고쳐 주세요.</span>
            </div>
            ${res && res.pii && res.pii.message ? html`<${Callout} kind="warn" icon="shield-check">${res.pii.message}</${Callout}>` : null}
            ${res && res.notice ? html`<${Callout} kind="info">${res.notice}</${Callout}>` : null}
            <div class="table-wrap">
              <table class="table table-compact inv-map">
                <thead><tr><th>명세서 품목</th><th>연결할 재고 품목</th><th class="right">수량</th><th class="right">단가(원)</th><th>유효기간 · 로트</th></tr></thead>
                <tbody>
                  ${rows.map((r) => {
                    const target = r.target !== 'new' && r.target !== 'skip' ? items.find((x) => String(x.id) === r.target) : null;
                    return html`<tr key=${r.key} class=${r.target === 'skip' ? 'skip' : ''}>
                      <td>
                        <div class="inv-name"><span class="title">${r.name}</span><span class="sub">${r.spec || '규격 없음'}</span></div>
                      </td>
                      <td style=${{ minWidth: '230px' }}>
                        <${Select}
                          value=${r.target}
                          aria-label="연결할 품목"
                          onChange=${(e) => setRow(r.key, { target: e.target.value })}
                          options=${[
                            { value: 'skip', label: '— 입고하지 않음 —' },
                            ...(isManager ? [{ value: 'new', label: `＋ 새 품목으로 등록: ${r.name}` }] : []),
                            ...r.ranked.map((x) => ({ value: String(x.it.id), label: `${x.it.name}${x.it.spec ? ` (${x.it.spec})` : ''}${x.score >= 0.3 ? ` · ${Math.round(x.score * 100)}%` : ''}` })),
                            ...items.filter((x) => !r.ranked.some((y) => y.it.id === x.id)).map((x) => ({ value: String(x.id), label: `${x.name}${x.spec ? ` (${x.spec})` : ''}` })),
                          ]}
                        />
                        <div class="small mt-1">
                          ${r.target === 'new'
                            ? html`<span class="warning-text">새 품목으로 만들어집니다 (분류: 기타)</span>`
                            : r.target === 'skip'
                              ? html`<span class="muted">${isManager ? '건너뜁니다' : '비슷한 품목이 없습니다. 품목을 고르거나 실장님께 새 품목 등록을 요청해 주세요.'}</span>`
                              : target
                                ? html`<span class="muted">현재 ${fq(target.currentQty)}${target.unit}${target.location ? ` · ${target.location}` : ''}</span>`
                                : null}
                        </div>
                      </td>
                      <td class="right"><${Input} class="num-in" inputmode="decimal" value=${r.qty} aria-label="수량" onInput=${(e) => setRow(r.key, { qty: e.target.value })} /></td>
                      <td class="right"><${Input} class="price-in" inputmode="numeric" value=${r.unitPrice} aria-label="단가" onInput=${(e) => setRow(r.key, { unitPrice: e.target.value })} /></td>
                      <td>
                        <div class="stack sm" style=${{ minWidth: '150px' }}>
                          <${Input} type="date" value=${r.expiryDate} aria-label="유효기간" onInput=${(e) => setRow(r.key, { expiryDate: e.target.value })} />
                          ${target && target.trackExpiry ? html`<span class="small warning-text">유효기간 관리 품목</span>` : null}
                        </div>
                      </td>
                    </tr>`;
                  })}
                </tbody>
              </table>
            </div>
          </div>`}
  </${Modal}>`;
}

// ---------------- CSV 가져오기 창 (실장 이상) ----------------
function ImportModal({ onClose, onDone }) {
  const [text, setText] = useState(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const pick = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const t = await readFileAsText(file);
      setText(t);
      setFileName(file.name);
      setPreview(await api.post('/inventory/items/import/preview', { text: t }));
    } catch (err) {
      setError(err);
      setPreview(null);
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };
  const commit = async () => {
    setBusy(true);
    try {
      const r = await api.post('/inventory/items/import', { text });
      toast.success(`가져오기 완료: 새 품목 ${r.created}개, 수정 ${r.updated}개${r.skipped ? `, 오류로 건너뜀 ${r.skipped}줄` : ''}`);
      clearMetaCache();
      onDone();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  const sum = preview && preview.summary;
  const count = sum ? sum.new + sum.update : 0;
  const ACTION = { new: ['blue', '새 품목'], update: ['purple', '수정'], error: ['red', '오류'] };
  return html`<${Modal}
    open=${true}
    size="lg"
    title="CSV로 품목 가져오기"
    onClose=${onClose}
    busy=${busy}
    footer=${html`<${Button} variant="ghost" icon="download" onClick=${() => api.download('/inventory/items/template.csv', '재고품목_가져오기_양식.csv').catch((e) => toast.error(e.message))}>양식 내려받기</${Button}>
      <div class="grow"></div>
      <${Button} onClick=${onClose}>취소</${Button}>
      <${Button} variant="primary" icon="upload" loading=${busy && !!preview} disabled=${!count} onClick=${commit}>${count ? `${count}개 반영하기` : '반영하기'}</${Button}>`}
  >
    <div class="stack">
      <p class="small text-2">엑셀에서 "CSV(쉼표로 분리)"로 저장한 파일을 고르세요. 첫 줄 머리글은 <strong>품목명, 분류, 규격, 단위, 현재고, 적정재고, 발주수량, 보관위치, 거래처, 단가</strong> 중 있는 것만 써도 됩니다. 이름·규격이 같은 품목은 수정, 없으면 새로 만듭니다.</p>
      <label class="inv-file">
        <input type="file" accept=".csv,text/csv" onChange=${pick} />
        <${Icon} name="file-spreadsheet" size=${26} />
        <strong>${fileName || 'CSV 파일 고르기'}</strong>
        <span class="small muted">${fileName ? '다른 파일을 고르려면 다시 누르세요' : '눌러서 파일을 고르세요 (한글 엑셀 파일도 자동 인식)'}</span>
      </label>
      ${busy && !preview ? html`<${Loading} label="파일을 확인하는 중…" />` : null}
      ${error ? html`<${Callout} kind="danger" title="파일을 읽지 못했습니다">${error.message}</${Callout}>` : null}
      ${preview
        ? html`<div class="row wrap">
              <${Badge} color="blue">새 품목 ${sum.new}</${Badge}>
              <${Badge} color="purple">수정 ${sum.update}</${Badge}>
              ${sum.unchanged ? html`<${Badge}>바뀐 것 없음 ${sum.unchanged}</${Badge}>` : null}
              ${sum.error ? html`<${Badge} color="red">오류 ${sum.error} (건너뜀)</${Badge}>` : null}
              <span class="small muted">미리보기입니다. 아직 저장되지 않았습니다.</span>
            </div>
            <div class="table-wrap" style=${{ maxHeight: '340px' }}>
              <table class="table table-compact">
                <thead><tr><th>줄</th><th>품목명</th><th>결과</th><th>내용</th></tr></thead>
                <tbody>
                  ${preview.rows.map(
                    (r) => html`<tr key=${r.line}>
                      <td class="num muted">${r.line}</td>
                      <td><div class="inv-name"><span class="title">${r.name || '(비어 있음)'}</span>${r.spec ? html`<span class="sub">${r.spec}</span>` : null}</div></td>
                      <td>${r.unchanged ? html`<${Badge}>변화 없음</${Badge}>` : html`<${Badge} color=${ACTION[r.action][0]}>${ACTION[r.action][1]}</${Badge}>`}</td>
                      <td class="small">
                        ${r.errors.map((e) => html`<div class="danger-text">${e}</div>`)}
                        ${r.warnings.map((e) => html`<div class="warning-text">${e}</div>`)}
                        ${r.changes && r.changes.length ? html`<div class="muted">바뀜: ${r.changes.join(', ')}</div>` : null}
                      </td>
                    </tr>`
                  )}
                </tbody>
              </table>
            </div>`
        : null}
    </div>
  </${Modal}>`;
}

// ---------------- 탭 1: 재고 현황 ----------------
function StockTab({ route, onMove, reloadKey }) {
  const q = route.query;
  const [search, setSearch] = useState(q.q || '');
  const params = { q: q.q || '', category: q.cat || '', low: q.low || '', status: q.status || '', archived: q.archived || '', _: reloadKey };
  const { data, loading, error, reload } = useApi(`/inventory/items${toQuery(params)}`);
  useEffect(() => {
    const t = setTimeout(() => (q.q || '') !== search && setQuery({ q: search }), 300);
    return () => clearTimeout(t);
  }, [search]);
  const sum = data && data.summary;
  const filtered = !!(q.q || q.cat || q.low || q.status || q.archived);
  const cats = ['소모품', '재료', '약품', '기구', '사무·위생', '기타'];

  const columns = [
    {
      key: 'name',
      label: '품목',
      render: (i) => html`<a class="inv-link inv-name" href=${`#/inventory/${i.id}`} onClick=${(e) => e.stopPropagation()}>
        <span class="title">${i.name}</span>
        <span class="sub">${[i.spec, i.vendorName].filter(Boolean).join(' · ') || '—'}</span>
      </a>`,
    },
    { key: 'category', label: '분류', render: (i) => html`<${Badge} color=${CATEGORY_COLOR[i.category]}>${i.category}</${Badge}>` },
    {
      key: 'qty',
      label: '현재 재고',
      render: (i) => html`<div class="inv-stock"><${Qty} value=${i.currentQty} unit=${i.unit} /><${StockBar} item=${i} /></div>`,
    },
    { key: 'min', label: '적정', align: 'right', render: (i) => (i.minQty ? html`<span class="num text-2">${fq(i.minQty)}</span>` : html`<span class="muted">—</span>`) },
    { key: 'status', label: '상태', render: (i) => html`<${StatusBadge} item=${i} />` },
    { key: 'exp', label: '유효기간', render: (i) => html`<${ExpiryCell} item=${i} />` },
    { key: 'loc', label: '보관 위치', render: (i) => html`<span class="small text-2">${i.location || '—'}</span>` },
    {
      key: 'act',
      label: '빠른 기록',
      class: 'actions',
      render: (i) =>
        i.active
          ? html`<div class="inv-quick" onClick=${(e) => e.stopPropagation()}>
              <${Button} size="sm" variant="soft" icon="plus" onClick=${() => onMove(i, 'in')}>입고</${Button}>
              <${Button} size="sm" icon="minus" disabled=${i.currentQty <= 0} onClick=${() => onMove(i, 'out')}>출고</${Button}>
            </div>`
          : null,
    },
  ];

  return html`
    <div class="stats inv-stats">
      <${Stat} label="관리 품목" icon="boxes" value=${sum ? sum.total : '–'} unit="개" hint=${sum && can('manager') ? `재고 금액 약 ${fmtNumber(Math.round(sum.stockValue / 10000))}만원` : '사용 중인 품목'} href="#/inventory" />
      <${Stat} label="재고 부족" icon="package" value=${sum ? sum.low : '–'} unit="품목" color=${sum && sum.low ? 'warning' : undefined} hint="적정 재고 이하" href="#/inventory?low=1" />
      <${Stat} label="유효기간 임박" icon="calendar-clock" value=${sum ? sum.expiring : '–'} unit="품목" color=${sum && sum.expiring ? 'warning' : undefined} hint="30일 이내" href="#/inventory?status=expiring" />
      <${Stat} label="유효기간 지남" icon="calendar-x" value=${sum ? sum.expired : '–'} unit="품목" color=${sum && sum.expired ? 'danger' : undefined} hint="남은 수량 폐기 필요" href="#/inventory?tab=alerts" />
    </div>
    <div class="inv-toolbar">
      <${SearchInput} value=${search} onInput=${setSearch} placeholder="품목·규격·위치·거래처 검색" />
      <${Seg}
        label="분류"
        value=${q.cat || ''}
        onChange=${(c) => setQuery({ cat: c })}
        items=${[{ value: '', label: '전체' }, ...cats.filter((c) => !data || data.categories[c] || q.cat === c).map((c) => ({ value: c, label: c }))]}
      />
      <${Checkbox} label="부족만" checked=${q.low === '1'} onChange=${(c) => setQuery({ low: c ? '1' : '', status: '' })} />
      ${q.status ? html`<${Badge} color="amber">${q.status === 'expiring' ? '유효기간 임박만' : '유효기간 지남만'} <button type="button" class="btn btn-ghost btn-sm btn-icon" style=${{ height: '18px', width: '18px' }} aria-label="필터 해제" onClick=${() => setQuery({ status: '' })}><${Icon} name="x" size=${12} /></button></${Badge}>` : null}
      <div class="grow"></div>
      ${sum && sum.archived ? html`<${Checkbox} label=${`보관된 품목 (${sum.archived})`} checked=${q.archived === '1'} onChange=${(c) => setQuery({ archived: c ? '1' : '' })} />` : null}
    </div>
    <${Card} flush>
      <${DataTable}
        columns=${columns}
        rows=${data && data.rows}
        loading=${loading}
        error=${error}
        onRetry=${reload}
        onRowClick=${(i) => navigate(`#/inventory/${i.id}`)}
        rowClass=${(i) => (i.status === 'out' ? 'inv-row-out' : i.status === 'low' ? 'inv-row-low' : '')}
        caption="재고 품목 목록"
        empty=${filtered
          ? { icon: 'search', title: '조건에 맞는 품목이 없습니다', desc: '검색어나 필터를 바꿔 보세요.', action: html`<${Button} icon="rotate-ccw" onClick=${() => { setSearch(''); setQuery({ q: '', cat: '', low: '', status: '', archived: '' }); }}>필터 지우기</${Button}>` }
          : { icon: 'package', title: '아직 등록된 품목이 없습니다', desc: can('manager') ? '오른쪽 위 [품목 추가]를 누르거나 CSV 파일로 한 번에 가져오세요.' : '실장님이 품목을 등록하면 여기에 보입니다.' }}
      />
    </${Card}>
  `;
}

// ---------------- 탭 2: 입출고 기록 ----------------
const MOVE_COLOR = { in: 'green', out: 'blue', adjust: 'purple' };
function MovesTab({ route, reloadKey, onChanged }) {
  const q = route.query;
  const [search, setSearch] = useState(q.q || '');
  const page = Number(q.page) || 1;
  const filter = { type: q.type || '', from: q.from || '', to: q.to || '', q: q.q || '', itemId: q.itemId || '' };
  const { data, loading, error, reload } = useApi(`/inventory/moves${toQuery({ ...filter, page, _: reloadKey })}`);
  useEffect(() => {
    const t = setTimeout(() => (q.q || '') !== search && setQuery({ q: search, page: '' }), 300);
    return () => clearTimeout(t);
  }, [search]);
  const undo = async (m) => {
    if (!(await confirmDialog({ title: '이 기록을 취소할까요?', message: `${m.itemName} ${m.typeLabel} ${fq(Math.abs(m.qty))}${m.unit} 기록을 지우고 재고를 되돌립니다.`, confirmText: '기록 취소', danger: true }))) return;
    try {
      await api.del(`/inventory/moves/${m.id}`);
      toast.success('기록을 취소하고 재고를 되돌렸습니다.');
      reload();
      onChanged && onChanged();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const columns = [
    { key: 'at', label: '일시', render: (m) => html`<div class="nowrap"><div class="num">${fmtDate(m.date, { weekday: false })}</div><div class="small muted num">${fmtDateTime(m.createdAt).slice(-5)}</div></div>` },
    { key: 'item', label: '품목', render: (m) => html`<a class="inv-link inv-name" href=${`#/inventory/${m.itemId}`}><span class="title">${m.itemName}</span>${m.spec ? html`<span class="sub">${m.spec}</span>` : null}</a>` },
    { key: 'type', label: '구분', render: (m) => html`<${Badge} color=${MOVE_COLOR[m.type]}>${m.typeLabel}</${Badge}>` },
    {
      key: 'qty',
      label: '수량',
      align: 'right',
      render: (m) => html`<span class=${cx('num strong nowrap', m.qty > 0 ? 'success-text' : m.qty < 0 ? 'text-2' : 'muted')}>${m.qty > 0 ? '+' : ''}${fq(m.qty)}<span class="small muted"> ${m.unit}</span></span>`,
    },
    { key: 'bal', label: '기록 후', align: 'right', render: (m) => html`<span class="num muted">${m.balanceAfter === null ? '' : fq(m.balanceAfter)}</span>` },
    { key: 'price', label: '단가', align: 'right', render: (m) => html`<span class="num small">${m.unitPrice != null ? fmtMoney(m.unitPrice) : ''}</span>` },
    {
      key: 'lot',
      label: '로트 · 유효기간',
      render: (m) => html`<span class="small text-2">${[m.lotNo, m.expiryDate && m.expiryDate.replace(/-/g, '.')].filter(Boolean).join(' · ')}</span>`,
    },
    {
      key: 'note',
      label: '메모',
      render: (m) => html`<span class="small">${m.poNo ? html`<a href=${`#/orders/${m.poId}`} class="nowrap">${m.poNo}</a> ` : null}${m.vendorName && !m.poNo ? html`<span class="muted">${m.vendorName} · </span>` : null}${m.note}</span>`,
    },
    { key: 'who', label: '기록', render: (m) => html`<span class="small text-2 nowrap">${m.userName || '—'}</span>` },
    { key: 'act', label: '', class: 'actions', render: (m) => (m.canUndo ? html`<${IconButton} icon="rotate-ccw" size="sm" label="이 기록 취소 (되돌리기)" onClick=${() => undo(m)} />` : null) },
  ];
  const filtered = !!(q.type || q.from || q.to || q.q || q.itemId);
  return html`
    <div class="inv-toolbar">
      <${Seg}
        label="구분"
        value=${q.type || ''}
        onChange=${(t) => setQuery({ type: t, page: '' })}
        items=${[
          { value: '', label: '전체' },
          { value: 'in', label: '입고' },
          { value: 'out', label: '출고' },
          { value: 'adjust', label: '실사 조정' },
        ]}
      />
      <div class="row" style=${{ gap: '6px' }}>
        <${Input} type="date" size="sm" value=${q.from || ''} aria-label="시작일" onChange=${(e) => setQuery({ from: e.target.value, page: '' })} style=${{ width: '150px' }} />
        <span class="muted">~</span>
        <${Input} type="date" size="sm" value=${q.to || ''} aria-label="종료일" onChange=${(e) => setQuery({ to: e.target.value, page: '' })} style=${{ width: '150px' }} />
      </div>
      <${SearchInput} value=${search} onInput=${setSearch} placeholder="품목·메모·로트 검색" />
      ${q.itemId ? html`<${Button} size="sm" variant="ghost" icon="x" onClick=${() => setQuery({ itemId: '' })}>품목 필터 해제</${Button}>` : null}
      <div class="grow"></div>
      <${Button} size="sm" icon="download" onClick=${() => api.download(`/inventory/moves.csv${toQuery(filter)}`, '입출고기록.csv').catch((e) => toast.error(e.message))}>CSV 내보내기</${Button}>
    </div>
    <${Card} flush>
      <${DataTable}
        columns=${columns}
        rows=${data && data.rows}
        loading=${loading}
        error=${error}
        onRetry=${reload}
        compact
        caption="입출고 기록"
        empty=${filtered
          ? { icon: 'search', title: '조건에 맞는 기록이 없습니다', desc: '기간이나 구분을 바꿔 보세요.', action: html`<${Button} icon="rotate-ccw" onClick=${() => { setSearch(''); setQuery({ type: '', from: '', to: '', q: '', itemId: '', page: '' }); }}>필터 지우기</${Button}>` }
          : { icon: 'history', title: '아직 입출고 기록이 없습니다', desc: '재고 현황에서 [입고]·[출고]를 누르면 여기에 쌓입니다.' }}
      />
      ${data ? html`<${Pagination} page=${data.page} size=${data.size} total=${data.total} onChange=${(p) => setQuery({ page: p })} />` : null}
    </${Card}>
  `;
}

// ---------------- 탭 3: 경고 ----------------
function AlertsTab({ reloadKey, onMove }) {
  const { data, loading, error, reload } = useApi(`/inventory/alerts?_=${reloadKey}`);
  if (error && !data) return html`<${ErrorState} error=${error} onRetry=${reload} />`;
  if (loading && !data) return html`<${Loading} rows=${6} />`;
  const nothing = !data.low.length && !data.expired.length && !data.expiring.length;
  if (nothing) return html`<${Card}><${EmptyState} icon="circle-check" title="경고가 없습니다" desc="재고가 모두 충분하고, 30일 안에 유효기간이 끝나는 품목도 없습니다." /></${Card}>`;
  const asItem = (l) => ({ id: l.itemId, name: l.itemName, unit: l.unit, spec: l.spec, location: l.location, category: '', currentQty: 0 });
  return html`<div class="grid inv-alert-grid">
    <${Card} title="재고 부족" icon="package" sub=${`${data.low.length}품목`} flush
      footer=${data.low.length && can('manager') ? html`<${LinkButton} href="#/orders?auto=1" variant="primary" size="sm" icon="shopping-cart">부족 품목으로 발주서 만들기</${LinkButton}>` : null}>
      ${data.low.length
        ? data.low.map(
            (i) => html`<div class="inv-alert-item" key=${i.id}>
              <div class="grow inv-name">
                <a class="inv-link" href=${`#/inventory/${i.id}`}><span class="title">${i.name}</span></a>
                <span class="sub">현재 <strong class=${i.status === 'out' ? 'danger-text' : 'warning-text'}>${fq(i.currentQty)}${i.unit}</strong> · 적정 ${fq(i.minQty)}${i.unit}${i.vendorName ? ` · ${i.vendorName}` : ''}</span>
                ${i.openPo ? html`<span class="small"><${Badge} color="blue">${i.openPo.status === 'draft' ? '발주서 작성 중' : '발주함'} ${i.openPo.poNo}</${Badge}></span>` : html`<span class="small muted">추천 주문 ${fq(i.suggestedQty)}${i.unit}</span>`}
              </div>
              <${Button} size="sm" variant="soft" icon="plus" onClick=${() => onMove(i, 'in')}>입고</${Button}>
            </div>`
          )
        : html`<${EmptyState} compact icon="circle-check" title="부족한 품목이 없습니다" />`}
    </${Card}>
    <${Card} title="유효기간 지남" icon="calendar-x" sub=${`${data.expired.length}건`} flush>
      ${data.expired.length
        ? data.expired.map(
            (l) => html`<div class="inv-alert-item" key=${l.lotId}>
              <div class="grow inv-name">
                <a class="inv-link" href=${`#/inventory/${l.itemId}`}><span class="title">${l.itemName}</span></a>
                <span class="sub">${l.lotNo ? `로트 ${l.lotNo} · ` : ''}<strong class="danger-text">${fq(l.qty)}${l.unit}</strong> 남음 · ${l.expiryDate.replace(/-/g, '.')} 만료</span>
              </div>
              <${ExpiryBadge} days=${l.days} />
              <${Button} size="sm" variant="danger" icon="trash-2" onClick=${() => onMove(asItem(l), 'out', { lotId: l.lotId, presetQty: l.qty, presetNote: '유효기간 만료 폐기' })}>폐기</${Button}>
            </div>`
          )
        : html`<${EmptyState} compact icon="circle-check" title="유효기간이 지난 재고가 없습니다" />`}
    </${Card}>
    <${Card} title="유효기간 임박" icon="calendar-clock" sub=${`${data.expirySoonDays}일 이내 · ${data.expiring.length}건`} flush>
      ${data.expiring.length
        ? data.expiring.map(
            (l) => html`<div class="inv-alert-item" key=${l.lotId}>
              <div class="grow inv-name">
                <a class="inv-link" href=${`#/inventory/${l.itemId}`}><span class="title">${l.itemName}</span></a>
                <span class="sub">${l.lotNo ? `로트 ${l.lotNo} · ` : ''}${fq(l.qty)}${l.unit} · ${l.expiryDate.replace(/-/g, '.')}까지${l.location ? ` · ${l.location}` : ''}</span>
              </div>
              <${ExpiryBadge} days=${l.days} />
            </div>`
          )
        : html`<${EmptyState} compact icon="circle-check" title="30일 안에 끝나는 유효기간이 없습니다" />`}
      ${data.expiring.length ? html`<div class="small muted" style=${{ padding: '10px 16px' }}>출고할 때 유효기간이 빠른 로트부터 자동으로 차감됩니다.</div>` : null}
    </${Card}>
  </div>`;
}

// ---------------- 탭 4: 단가 변동 ----------------
function PricesTab({ route, reloadKey }) {
  const all = route.query.all === '1';
  const { data, loading, error, reload } = useApi(`/inventory/prices?_=${reloadKey}`);
  const rows = data ? (all ? data.rows : data.rows.filter((r) => r.changePct !== null)) : null;
  const columns = [
    { key: 'name', label: '품목', render: (r) => html`<a class="inv-link inv-name" href=${`#/inventory/${r.itemId}`}><span class="title">${r.name}</span><span class="sub">${[r.spec, r.vendorName].filter(Boolean).join(' · ') || '—'}</span></a>` },
    { key: 'prev', label: '이전 단가', align: 'right', render: (r) => html`<span class="num text-2">${r.previousPrice != null ? fmtMoney(r.previousPrice) : '—'}</span>${r.previousDate ? html`<div class="small muted num">${fmtDate(r.previousDate, { weekday: false })}</div>` : null}` },
    { key: 'latest', label: '최근 단가', align: 'right', render: (r) => html`<strong class="num">${fmtMoney(r.latestPrice)}</strong><div class="small muted num">${fmtDate(r.latestDate, { weekday: false })}</div>` },
    { key: 'chg', label: '변동', align: 'right', render: (r) => html`<${Change} pct=${r.changePct} />` },
    { key: 'trend', label: '추이', render: (r) => html`<${Sparkline} values=${r.series.map((x) => x.price)} trend=${r.changePct > 0 ? 'up' : r.changePct < 0 ? 'down' : ''} />` },
    { key: 'cnt', label: '기록', align: 'right', render: (r) => html`<span class="small muted num">${r.count}회</span>` },
  ];
  return html`
    <div class="inv-toolbar">
      <${Seg} label="보기" value=${all ? 'all' : 'changed'} onChange=${(v) => setQuery({ all: v === 'all' ? '1' : '' })} items=${[{ value: 'changed', label: `단가가 바뀐 품목${data ? ` (${data.changed})` : ''}` }, { value: 'all', label: '단가 기록 전체' }]} />
      <span class="small muted">입고할 때 적은 단가가 이전과 다르면 자동으로 기록됩니다.</span>
    </div>
    <${Card} flush>
      <${DataTable}
        columns=${columns}
        rows=${rows}
        loading=${loading}
        error=${error}
        onRetry=${reload}
        onRowClick=${(r) => navigate(`#/inventory/${r.itemId}`)}
        caption="단가 변동"
        empty=${{ icon: 'trending-up', title: all ? '단가 기록이 없습니다' : '단가가 바뀐 품목이 없습니다', desc: '입고할 때 단가를 적으면 변동이 자동으로 기록됩니다.', action: !all ? html`<${Button} onClick=${() => setQuery({ all: '1' })}>단가 기록 전체 보기</${Button}>` : null }}
      />
    </${Card}>
  `;
}

// ---------------- 품목 상세 ----------------
function ItemDetail({ id }) {
  const { data: it, loading, error, reload } = useApi(`/inventory/items/${id}`);
  const [modal, setModal] = useState(null); // { kind: 'move'|'edit'|'adjust'|'price', type }
  const isManager = can('manager');
  if (error && !it) return html`<div class="inv-back"><a href="#/inventory" class="btn btn-ghost btn-sm"><${Icon} name="arrow-left" size=${14} />재고 목록</a></div><${ErrorState} error=${error} onRetry=${reload} />`;
  if (loading && !it) return html`<${Loading} rows=${8} />`;
  if (!it) return null;
  const close = () => setModal(null);
  const done = () => {
    setModal(null);
    reload();
  };
  const toggleArchive = async () => {
    try {
      await api.patch(`/inventory/items/${id}`, { active: !it.active });
      toast.success(it.active ? '보관함으로 옮겼습니다. 목록과 경고에서 빠집니다.' : '보관을 해제했습니다.');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: '이 품목을 삭제할까요?', message: '입출고·발주 기록이 있으면 지우지 않고 보관함으로 옮깁니다.', danger: true, confirmText: '삭제' }))) return;
    try {
      const r = await api.del(`/inventory/items/${id}`);
      toast.success(r.archived ? r.message : '삭제했습니다.');
      navigate('#/inventory');
    } catch (e) {
      toast.error(e.message);
    }
  };
  const undo = async () => {
    const m = it.moves.find((x) => x.id === it.undoMoveId);
    if (!m) return;
    if (!(await confirmDialog({ title: '가장 최근 기록을 취소할까요?', message: `${m.typeLabel} ${fq(Math.abs(m.qty))}${it.unit} (${fmtDateTime(m.createdAt)}) 기록을 지우고 재고를 되돌립니다.`, confirmText: '기록 취소', danger: true }))) return;
    try {
      await api.del(`/inventory/moves/${m.id}`);
      toast.success('기록을 취소했습니다.');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const prices = it.prices || [];
  const latestPrice = prices.length ? prices[prices.length - 1].unitPrice : null;
  const prevPrice = (() => {
    for (let i = prices.length - 2; i >= 0; i--) if (prices[i].unitPrice !== latestPrice) return prices[i].unitPrice;
    return null;
  })();
  const pct = prevPrice ? Math.round(((latestPrice - prevPrice) / prevPrice) * 1000) / 10 : null;

  return html`
    <div class="inv-back"><a href="#/inventory" class="btn btn-ghost btn-sm"><${Icon} name="arrow-left" size=${14} />재고 목록</a></div>
    <header class="page-header">
      <div class="inv-hero grow">
        <div class=${`icon-box ${CATEGORY_COLOR[it.category] || ''}`}><${Icon} name=${CATEGORY_ICON[it.category] || 'package'} size=${22} /></div>
        <div class="grow" style=${{ minWidth: '220px' }}>
          <div class="row wrap" style=${{ gap: '6px', marginBottom: '4px' }}>
            <${Badge} color=${CATEGORY_COLOR[it.category]}>${it.category}</${Badge}>
            <${StatusBadge} item=${it} />
            ${it.trackExpiry ? html`<${Badge}><${Icon} name="calendar-clock" size=${12} />유효기간 관리</${Badge}>` : null}
          </div>
          <h1>${it.name}${it.spec ? html` <span class="muted" style=${{ fontWeight: 500, fontSize: '16px' }}>${it.spec}</span>` : null}</h1>
          <p class="page-desc">${[it.location && `보관: ${it.location}`, it.vendorName && `거래처: ${it.vendorName}`].filter(Boolean).join(' · ') || '보관 위치·거래처 미지정'}</p>
        </div>
      </div>
      <div class="page-actions">
        ${it.active
          ? html`<${Button} variant="primary" icon="package-plus" onClick=${() => setModal({ kind: 'move', type: 'in' })}>입고</${Button}>
              <${Button} icon="package-minus" disabled=${it.currentQty <= 0} onClick=${() => setModal({ kind: 'move', type: 'out' })}>출고</${Button}>`
          : null}
        ${isManager
          ? html`<${Button} icon="pencil" onClick=${() => setModal({ kind: 'edit' })}>수정</${Button}>
              <${Menu} size="md" items=${[
                { label: '실사 조정 (실제 수량 맞추기)', icon: 'list-checks', onClick: () => setModal({ kind: 'adjust' }), hidden: !it.active },
                { label: '단가 기록', icon: 'tag', onClick: () => setModal({ kind: 'price' }) },
                { label: '입출고 기록 전체 보기', icon: 'history', onClick: () => navigate(`#/inventory?tab=moves&itemId=${it.id}`) },
                '-',
                { label: it.active ? '보관함으로 (사용 중지)' : '보관 해제', icon: 'archive', onClick: toggleArchive },
                { label: '삭제', icon: 'trash-2', danger: true, onClick: remove },
              ]} />`
          : html`<${Button} variant="ghost" icon="history" onClick=${() => navigate(`#/inventory?tab=moves&itemId=${it.id}`)}>기록 전체</${Button}>`}
      </div>
    </header>
    ${!it.active ? html`<${Callout} kind="info" class="mt-0" title="보관된 품목입니다.">목록과 경고에서 빠져 있고 입출고를 기록할 수 없습니다.</${Callout}><div class="mt-3"></div>` : null}

    <div class="stats inv-stats">
      <div class="stat">
        <div class="stat-label"><${Icon} name="boxes" size=${14} />현재 재고</div>
        <div class=${cx('stat-value', it.status === 'out' && 'danger-text', it.status === 'low' && 'warning-text')}>${fq(it.currentQty)}<span class="stat-unit">${it.unit}</span></div>
        <div class="mt-2"><${StockBar} item=${it} /></div>
      </div>
      <${Stat} label="적정 재고 (최소)" icon="package" value=${it.minQty ? fq(it.minQty) : '—'} unit=${it.minQty ? it.unit : ''} hint=${`한 번에 주문 ${fq(it.reorderQty || it.suggestedQty)}${it.unit}${it.reorderQty ? '' : ' (자동 계산)'}`} />
      <${Stat} label="최근 30일 사용" icon="activity" value=${fq(it.usage30)} unit=${it.unit} hint=${it.usage30 > 0 && it.currentQty > 0 ? `지금 속도면 약 ${Math.max(1, Math.round(it.currentQty / (it.usage30 / 30)))}일 사용` : '출고 기록 기준'} />
      <${Stat} label="최근 단가" icon="tag" value=${it.lastUnitPrice != null ? fmtNumber(it.lastUnitPrice) : '—'} unit=${it.lastUnitPrice != null ? '원' : ''} hint=${pct !== null ? html`<${Change} pct=${pct} /> 이전 ${fmtMoney(prevPrice)}` : '단가 변동 없음'} />
    </div>

    <div class="grid detail-grid">
      <div class="stack lg">
        <${Card} title="로트 · 유효기간" icon="calendar-clock" sub=${it.lots.length ? `${it.lots.length}개 로트` : ''} flush>
          ${it.lots.length || it.untrackedQty > 0
            ? html`<div class="table-wrap"><table class="table table-compact">
                <thead><tr><th>로트</th><th>유효기간</th><th class="right">남은 수량</th><th>입고일</th></tr></thead>
                <tbody>
                  ${it.lots.map(
                    (l, idx) => html`<tr key=${l.id}>
                      <td><span class="strong">${l.lotNo || '번호 없음'}</span>${idx === 0 && it.lots.length > 1 && (!l.days || l.days >= 0) ? html` <${Badge} color="blue">다음 출고</${Badge}>` : null}</td>
                      <td>${l.expiryDate ? html`<div class="row" style=${{ gap: '6px' }}><span class="num">${l.expiryDate.replace(/-/g, '.')}</span>${l.days !== null && l.days <= 60 ? html`<${ExpiryBadge} days=${l.days} />` : null}</div>` : html`<span class="muted">없음</span>`}</td>
                      <td class="right"><${Qty} value=${l.qty} unit=${it.unit} /></td>
                      <td class="small muted num">${l.receivedAt ? l.receivedAt.replace(/-/g, '.') : ''}</td>
                    </tr>`
                  )}
                  ${it.untrackedQty > 0
                    ? html`<tr><td colspan="2" class="text-2">로트 없이 들어온 재고</td><td class="right"><${Qty} value=${it.untrackedQty} unit=${it.unit} /></td><td></td></tr>`
                    : null}
                </tbody>
              </table></div>`
            : html`<${EmptyState} compact icon="calendar-clock" title=${it.trackExpiry ? '남은 로트가 없습니다' : '로트로 관리하지 않는 품목입니다'} desc=${it.trackExpiry ? '입고할 때 유효기간을 적으면 여기에 표시됩니다.' : '입고할 때 유효기간·로트를 적으면 따로 관리됩니다.'} />`}
        </${Card}>

        <${Card} title="최근 입출고" icon="history" flush
          actions=${it.undoMoveId ? html`<${Button} size="sm" variant="ghost" icon="rotate-ccw" onClick=${undo}>최근 기록 취소</${Button}>` : null}
          footer=${it.moves.length >= 30 ? html`<${LinkButton} size="sm" variant="ghost" href=${`#/inventory?tab=moves&itemId=${it.id}`} icon="history">전체 기록 보기</${LinkButton}>` : null}>
          ${it.moves.length
            ? html`<div class="table-wrap"><table class="table table-compact">
                <thead><tr><th>일시</th><th>구분</th><th class="right">수량</th><th class="right">기록 후</th><th>내용</th><th>기록</th></tr></thead>
                <tbody>
                  ${it.moves.map(
                    (m) => html`<tr key=${m.id}>
                      <td class="nowrap num small">${fmtDateTime(m.createdAt)}</td>
                      <td><${Badge} color=${MOVE_COLOR[m.type]}>${m.typeLabel}</${Badge}></td>
                      <td class="right"><span class=${cx('num strong', m.qty > 0 && 'success-text')}>${m.qty > 0 ? '+' : ''}${fq(m.qty)}</span></td>
                      <td class="right num muted">${m.balanceAfter === null ? '' : fq(m.balanceAfter)}</td>
                      <td class="small">
                        ${m.poNo ? html`<a href=${`#/orders/${m.poId}`}>${m.poNo}</a> ` : null}
                        ${[m.unitPrice != null && fmtMoney(m.unitPrice), m.lotNo, m.note].filter(Boolean).join(' · ')}
                      </td>
                      <td class="small text-2 nowrap">${m.userName}</td>
                    </tr>`
                  )}
                </tbody>
              </table></div>`
            : html`<${EmptyState} compact icon="history" title="아직 기록이 없습니다" desc="[입고]·[출고]를 누르면 여기에 쌓입니다." />`}
        </${Card}>
      </div>

      <div class="stack lg">
        <${Card} title="단가 기록" icon="tag" sub=${prices.length ? `${prices.length}회` : ''}>
          ${prices.length
            ? html`<div class="stack">
                <div class="row between">
                  <div><div class="strong num" style=${{ fontSize: '18px' }}>${fmtMoney(latestPrice)}</div><${Change} pct=${pct} /></div>
                  <${Sparkline} values=${prices.map((p) => p.unitPrice)} width=${120} height=${36} trend=${pct > 0 ? 'up' : pct < 0 ? 'down' : ''} />
                </div>
                <div class="stack sm">
                  ${[...prices].reverse().slice(0, 6).map(
                    (p) => html`<div class="row small"><span class="num muted" style=${{ width: '82px' }}>${p.date.replace(/-/g, '.')}</span><span class="grow text-2 ellipsis">${p.source}${p.vendorName ? ` · ${p.vendorName}` : ''}</span><span class="num strong">${fmtMoney(p.unitPrice)}</span></div>`
                  )}
                </div>
              </div>`
            : html`<p class="small muted">아직 단가 기록이 없습니다. 입고할 때 단가를 적으면 자동으로 쌓입니다.</p>`}
        </${Card}>
        ${it.openPos.length
          ? html`<${Card} title="진행 중인 발주" icon="shopping-cart">
              <div class="stack sm">
                ${it.openPos.map(
                  (p) => html`<a href=${can('manager') ? `#/orders/${p.id}` : undefined} class="row small inv-link">
                    <${Badge} color=${p.status === 'draft' ? 'gray' : 'blue'}>${p.statusLabel}</${Badge}>
                    <span class="grow num">${p.poNo}</span>
                    <span class="num">${fq(p.qty)}${it.unit}</span>
                    ${p.expectedDate ? html`<${DdayBadge} days=${daysUntil(p.expectedDate)} label=${daysUntil(p.expectedDate) < 0 ? '예정일 지남' : undefined} />` : null}
                  </a>`
                )}
              </div>
            </${Card}>`
          : null}
        <${Card} title="품목 정보" icon="info">
          <dl class="inv-dl">
            <dt>분류</dt><dd>${it.category}</dd>
            <dt>단위</dt><dd>${it.unit}</dd>
            <dt>규격</dt><dd>${it.spec || '—'}</dd>
            <dt>거래처</dt><dd>${it.vendorId ? html`<a href=${`#/vendors/${it.vendorId}`}>${it.vendorName}</a>` : '—'}</dd>
            <dt>보관 위치</dt><dd>${it.location || '—'}</dd>
            <dt>유효기간</dt><dd>${it.trackExpiry ? '관리함 (빠른 것부터 출고)' : '관리 안 함'}</dd>
            ${it.memo ? html`<dt>메모</dt><dd class="pre">${it.memo}</dd>` : null}
          </dl>
        </${Card}>
      </div>
    </div>

    ${modal && modal.kind === 'move' ? html`<${MoveModal} item=${it} type=${modal.type} onClose=${close} onDone=${done} />` : null}
    ${modal && modal.kind === 'edit' ? html`<${ItemEditor} item=${it} onClose=${close} onSaved=${done} />` : null}
    ${modal && modal.kind === 'adjust' ? html`<${AdjustModal} item=${it} onClose=${close} onDone=${done} />` : null}
    ${modal && modal.kind === 'price' ? html`<${PriceModal} item=${it} onClose=${close} onDone=${done} />` : null}
  `;
}

// ---------------- 재고 화면 (탭 묶음) ----------------
function InventoryHome({ route }) {
  const q = route.query;
  const tab = q.tab || 'stock';
  const isManager = can('manager');
  const [modal, setModal] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const counts = useApi(`/inventory/alerts?_=${reloadKey}`);
  const alertCount = counts.data ? counts.data.low.length + counts.data.expired.length + counts.data.expiring.length : 0;
  const refresh = () => setReloadKey((k) => k + 1);
  const openMove = (item, type, extra = {}) => setModal({ kind: 'move', item, type, ...extra });
  const close = () => setModal(null);

  return html`
    <${PageHeader}
      title="재고"
      desc="재료·소모품의 현재 수량과 입출고를 기록합니다. 출고는 유효기간이 빠른 것부터 자동으로 차감됩니다."
      actions=${html`
        <${AiButton} onClick=${() => setModal({ kind: 'invoice' })}>거래명세서로 입고</${AiButton}>
        <${Menu}
          label="CSV 가져오기·내보내기"
          icon="file-spreadsheet"
          buttonVariant="secondary"
          size="md"
          items=${[
            { label: '품목 목록 CSV 내려받기', icon: 'download', onClick: () => api.download('/inventory/items.csv', '재고품목.csv').catch((e) => toast.error(e.message)) },
            { label: '입출고 기록 CSV 내려받기', icon: 'download', onClick: () => api.download('/inventory/moves.csv', '입출고기록.csv').catch((e) => toast.error(e.message)) },
            isManager && '-',
            isManager && { label: 'CSV로 품목 가져오기', icon: 'upload', onClick: () => setModal({ kind: 'import' }) },
            isManager && { label: '가져오기 양식 내려받기', icon: 'file-spreadsheet', onClick: () => api.download('/inventory/items/template.csv', '양식.csv').catch((e) => toast.error(e.message)) },
          ].filter(Boolean)}
        />
        ${isManager ? html`<${Button} variant="primary" icon="plus" onClick=${() => setModal({ kind: 'edit' })}>품목 추가</${Button}>` : null}
      `}
    />
    <${Tabs}
      value=${tab}
      onChange=${(t) => setQuery({ tab: t === 'stock' ? '' : t, page: '', type: '', from: '', to: '', itemId: '', all: '' })}
      items=${[
        { value: 'stock', label: '재고 현황', icon: 'boxes' },
        { value: 'moves', label: '입출고 기록', icon: 'history' },
        { value: 'alerts', label: '경고', icon: 'triangle-alert', count: alertCount || null, countColor: counts.data && counts.data.expired.length ? 'red' : 'amber' },
        { value: 'prices', label: '단가 변동', icon: 'trending-up' },
      ]}
    />
    ${tab === 'stock' ? html`<${StockTab} route=${route} onMove=${openMove} reloadKey=${reloadKey} />` : null}
    ${tab === 'moves' ? html`<${MovesTab} route=${route} reloadKey=${reloadKey} onChanged=${refresh} />` : null}
    ${tab === 'alerts' ? html`<${AlertsTab} reloadKey=${reloadKey} onMove=${openMove} />` : null}
    ${tab === 'prices' ? html`<${PricesTab} route=${route} reloadKey=${reloadKey} />` : null}

    ${modal && modal.kind === 'move'
      ? html`<${MoveModal} item=${modal.item} type=${modal.type} lotId=${modal.lotId} presetQty=${modal.presetQty} presetNote=${modal.presetNote} onClose=${close} onDone=${() => { close(); refresh(); }} />`
      : null}
    ${modal && modal.kind === 'edit' ? html`<${ItemEditor} onClose=${close} onSaved=${(it) => { close(); navigate(`#/inventory/${it.id}`); }} />` : null}
    ${modal && modal.kind === 'import' ? html`<${ImportModal} onClose=${close} onDone=${() => { close(); refresh(); }} />` : null}
    ${modal && modal.kind === 'invoice' ? html`<${InvoiceModal} onClose=${close} onDone=${() => { close(); refresh(); }} />` : null}
  `;
}

export default function InventoryPage({ route }) {
  const id = route.parts[1];
  return id ? html`<${ItemDetail} id=${id} key=${id} />` : html`<${InventoryHome} route=${route} />`;
}
