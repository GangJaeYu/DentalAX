/*
 * 이 파일이 하는 일: [B. 재고·구매] 거래처 화면입니다.
 *
 *   #/vendors        거래처 카드 목록 (분류 필터, 검색, 품목 수·부족 품목·진행 중 발주, 최근 발주서)
 *   #/vendors/3      거래처 상세 (연락처, 이 거래처 품목과 재고, 최근 발주서)
 *
 *   - 보기는 누구나, 추가·수정·보관·삭제는 실장 이상 (버튼도 숨김)
 *   - 발주 금액이 보이는 "최근 발주서"는 실장 이상에게만 보입니다.
 *   - 다른 기록(품목·발주서·지출 등)에서 쓰는 거래처는 지우지 않고 "보관"합니다.
 */
import { html, useState, useEffect, cx, fmtDate, fmtNumber, fmtMoney, toQuery } from '../lib.js';
import { api } from '../api.js';
import { navigate, setQuery } from '../router.js';
import { can, toast, confirmDialog } from '../store.js';
import {
  PageHeader, Card, Button, LinkButton, Badge, Icon, Seg, Modal, Field, Input, Textarea, Select, Checkbox, FormGrid,
  SearchInput, useApi, useForm, Loading, ErrorState, EmptyState, DataTable, Menu, Callout, DdayBadge,
} from '../ui/index.js';
import { Qty, StatusBadge, StockBar, ExpiryCell, clearMetaCache } from './inventory.js';

const CATEGORIES = ['재료상', '기공소', '장비업체', '소모품', '기타'];
const METHODS = ['전화', '카카오톡', '이메일', '웹사이트', '기타'];
const CAT_STYLE = {
  재료상: { color: 'blue', icon: 'package' },
  기공소: { color: 'purple', icon: 'wrench' },
  장비업체: { color: 'amber', icon: 'monitor' },
  소모품: { color: 'green', icon: 'boxes' },
  기타: { color: '', icon: 'building-2' },
};
const METHOD_ICON = { 전화: 'phone', 카카오톡: 'message-square-text', 이메일: 'mail', 웹사이트: 'external-link', 기타: 'send' };
const PO_STATUS = { draft: ['gray', '작성 중'], ordered: ['blue', '발주함'], received: ['green', '입고 완료'], cancelled: ['red', '취소'] };
const webHref = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

function MethodBadge({ method }) {
  return html`<${Badge} color="blue"><${Icon} name=${METHOD_ICON[method] || 'send'} size=${12} />${method} 주문</${Badge}>`;
}

// ---------------- 추가·수정 창 (실장 이상) ----------------
function VendorEditor({ vendor, onClose, onSaved }) {
  const f = useForm(
    vendor
      ? {
          name: vendor.name,
          category: vendor.category,
          contactName: vendor.contactName,
          phone: vendor.phone,
          email: vendor.email,
          orderMethod: vendor.orderMethod,
          website: vendor.website,
          paymentTerms: vendor.paymentTerms,
          memo: vendor.memo,
        }
      : { name: '', category: '재료상', contactName: '', phone: '', email: '', orderMethod: '전화', website: '', paymentTerms: '', memo: '' }
  );
  const save = f.submit(async (v) => {
    const body = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' && x.trim() === '' && k !== 'name' ? null : x]));
    const saved = vendor ? await api.patch(`/inventory/vendors/${vendor.id}`, body) : await api.post('/inventory/vendors', body);
    clearMetaCache();
    toast.success(vendor ? '거래처를 수정했습니다.' : '거래처를 추가했습니다.');
    onSaved(saved);
  });
  return html`<${Modal}
    open=${true}
    size="lg"
    title=${vendor ? '거래처 수정' : '거래처 추가'}
    onClose=${onClose}
    busy=${f.busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${f.busy} onClick=${save}>${vendor ? '저장' : '추가'}</${Button}>`}
  >
    <form onSubmit=${save}>
      <${FormGrid}>
        <${Field} label="거래처 이름" required error=${f.errors.name}><${Input} ...${f.bind('name')} placeholder="예: 한빛덴탈" maxlength="100" /></${Field}>
        <${Field} label="분류" error=${f.errors.category}>
          <${Select} value=${f.values.category} onChange=${(e) => f.set('category', e.target.value)} options=${CATEGORIES} />
        </${Field}>
        <${Field} label="담당자" error=${f.errors.contactName} hint="업체 담당자 이름·직함"><${Input} ...${f.bind('contactName')} placeholder="예: 강도윤 과장" maxlength="50" /></${Field}>
        <${Field} label="전화번호" error=${f.errors.phone}><${Input} type="tel" ...${f.bind('phone')} placeholder="예: 02-555-0187" maxlength="40" /></${Field}>
        <${Field} label="이메일" error=${f.errors.email}><${Input} type="email" ...${f.bind('email')} placeholder="예: order@example.com" maxlength="120" /></${Field}>
        <${Field} label="주로 주문하는 방법" error=${f.errors.orderMethod}>
          <${Select} value=${f.values.orderMethod} onChange=${(e) => f.set('orderMethod', e.target.value)} options=${METHODS} />
        </${Field}>
        <${Field} label="웹사이트" error=${f.errors.website}><${Input} ...${f.bind('website')} placeholder="예: www.example.com" maxlength="200" /></${Field}>
        <${Field} label="결제 조건" error=${f.errors.paymentTerms}><${Input} ...${f.bind('paymentTerms')} placeholder="예: 월말 마감, 익월 10일 이체" maxlength="200" /></${Field}>
        <${Field} label="메모" full error=${f.errors.memo}><${Textarea} rows=${3} ...${f.bind('memo')} placeholder="예: 오후 3시 전 주문하면 다음 날 도착" /></${Field}>
      </${FormGrid}>
      <button type="submit" class="sr-only" tabindex="-1">저장</button>
    </form>
  </${Modal}>`;
}

// ---------------- 목록 ----------------
function VendorCard({ v }) {
  const st = CAT_STYLE[v.category] || CAT_STYLE.기타;
  return html`<a class="card interactive vendor-card" href=${`#/vendors/${v.id}`}>
    <div class="head">
      <div class=${cx('icon-box', st.color)}><${Icon} name=${st.icon} size=${17} /></div>
      <div class="grow">
        <div class="name ellipsis">${v.name}</div>
        <div class="row" style=${{ gap: '6px' }}><${Badge} color=${st.color}>${v.category}</${Badge}>${!v.active ? html`<${Badge}>보관됨</${Badge}>` : null}</div>
      </div>
      <${Icon} name="chevron-right" size=${16} class="muted" />
    </div>
    <div class="vendor-meta">
      <div class="row"><${Icon} name="user" size=${14} /><span class="ellipsis">${v.contactName || '담당자 미등록'}</span></div>
      <div class="row"><${Icon} name="phone" size=${14} /><span class="num">${v.phone || '—'}</span></div>
      <div class="row"><${Icon} name=${METHOD_ICON[v.orderMethod] || 'send'} size=${14} /><span>${v.orderMethod}로 주문${v.paymentTerms ? ` · ${v.paymentTerms}` : ''}</span></div>
    </div>
    <div class="vendor-nums">
      <div><div class="n">${v.itemCount}</div><div class="l">품목</div></div>
      <div><div class=${cx('n', v.lowCount && 'warning-text')}>${v.lowCount}</div><div class="l">재고 부족</div></div>
      <div><div class=${cx('n', v.openPoCount && 'accent')}>${v.openPoCount}</div><div class="l">진행 중 발주</div></div>
    </div>
    ${v.recentPos && v.recentPos.length
      ? html`<div class="vendor-pos">
          <div class="small strong text-2">최근 발주</div>
          ${v.recentPos.map(
            (p) => html`<div class="row"><${Badge} color=${PO_STATUS[p.status][0]}>${PO_STATUS[p.status][1]}</${Badge}><span class="grow ellipsis text-2">${p.firstItem || '품목 없음'}${p.lineCount > 1 ? ` 외 ${p.lineCount - 1}` : ''}</span><span class="num muted">${fmtDate((p.orderDate || p.createdAt).slice(0, 10), { weekday: false })}</span></div>`
          )}
        </div>`
      : v.recentPos
        ? html`<div class="small muted">아직 발주 기록이 없습니다</div>`
        : null}
    ${v.memo ? html`<div class="vendor-memo">${v.memo}</div>` : null}
  </a>`;
}

function VendorList({ route }) {
  const q = route.query;
  const isManager = can('manager');
  const [search, setSearch] = useState(q.q || '');
  const [creating, setCreating] = useState(false);
  const { data, loading, error, reload } = useApi(`/inventory/vendors${toQuery({ q: q.q || '', category: q.cat || '', archived: q.archived || '' })}`);
  useEffect(() => {
    const t = setTimeout(() => (q.q || '') !== search && setQuery({ q: search }), 300);
    return () => clearTimeout(t);
  }, [search]);
  const filtered = !!(q.q || q.cat || q.archived);
  return html`
    <${PageHeader}
      title="거래처"
      desc="재료상·기공소·장비업체 연락처와 주문 방법을 한곳에. 거래처별 품목과 발주 기록도 볼 수 있습니다."
      actions=${isManager ? html`<${Button} variant="primary" icon="plus" onClick=${() => setCreating(true)}>거래처 추가</${Button}>` : null}
    />
    <div class="inv-toolbar">
      <${SearchInput} value=${search} onInput=${setSearch} placeholder="거래처·담당자·메모 검색" />
      <${Seg} label="분류" value=${q.cat || ''} onChange=${(c) => setQuery({ cat: c })} items=${[{ value: '', label: '전체' }, ...CATEGORIES.map((c) => ({ value: c, label: c }))]} />
      <div class="grow"></div>
      ${isManager && data && (data.archivedCount || q.archived) ? html`<${Checkbox} label=${`보관된 거래처 (${data.archivedCount})`} checked=${q.archived === '1'} onChange=${(c) => setQuery({ archived: c ? '1' : '' })} />` : null}
    </div>
    ${error && !data
      ? html`<${Card}><${ErrorState} error=${error} onRetry=${reload} /></${Card}>`
      : loading && !data
        ? html`<div class="vendor-grid">${[0, 1, 2].map(() => html`<${Card}><${Loading} rows=${4} /></${Card}>`)}</div>`
        : !data.rows.length
          ? html`<${Card}><${EmptyState}
              icon="truck"
              title=${filtered ? '조건에 맞는 거래처가 없습니다' : '아직 등록된 거래처가 없습니다'}
              desc=${filtered ? '검색어나 분류를 바꿔 보세요.' : isManager ? '자주 주문하는 재료상·기공소부터 등록해 보세요.' : '실장님이 거래처를 등록하면 여기에 보입니다.'}
              action=${!filtered && isManager ? html`<${Button} variant="primary" icon="plus" onClick=${() => setCreating(true)}>거래처 추가</${Button}>` : filtered ? html`<${Button} icon="rotate-ccw" onClick=${() => { setSearch(''); setQuery({ q: '', cat: '', archived: '' }); }}>필터 지우기</${Button}>` : null}
            /></${Card}>`
          : html`<div class="vendor-grid">${data.rows.map((v) => html`<${VendorCard} v=${v} key=${v.id} />`)}</div>`}
    ${creating ? html`<${VendorEditor} onClose=${() => setCreating(false)} onSaved=${(v) => navigate(`#/vendors/${v.id}`)} />` : null}
  `;
}

// ---------------- 상세 ----------------
function VendorDetail({ id }) {
  const { data: v, loading, error, reload } = useApi(`/inventory/vendors/${id}`);
  const [editing, setEditing] = useState(false);
  const isManager = can('manager');
  if (error && !v) return html`<div class="inv-back"><a href="#/vendors" class="btn btn-ghost btn-sm"><${Icon} name="arrow-left" size=${14} />거래처 목록</a></div><${ErrorState} error=${error} onRetry=${reload} />`;
  if (loading && !v) return html`<${Loading} rows=${8} />`;
  const st = CAT_STYLE[v.category] || CAT_STYLE.기타;

  const toggleArchive = async () => {
    try {
      await api.patch(`/inventory/vendors/${id}`, { active: !v.active });
      clearMetaCache();
      toast.success(v.active ? '보관했습니다. 새 품목·발주서의 거래처 목록에서 빠집니다.' : '보관을 해제했습니다.');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: `'${v.name}'을(를) 삭제할까요?`, message: '품목·발주서·지출 등 다른 기록에서 쓰고 있으면 지우지 않고 보관합니다.', danger: true, confirmText: '삭제' }))) return;
    try {
      const r = await api.del(`/inventory/vendors/${id}`);
      clearMetaCache();
      toast.success(r.archived ? r.message : '삭제했습니다.');
      if (r.archived) reload();
      else navigate('#/vendors');
    } catch (e) {
      toast.error(e.message);
    }
  };
  const columns = [
    { key: 'name', label: '품목', render: (i) => html`<a class="inv-link inv-name" href=${`#/inventory/${i.id}`}><span class="title">${i.name}</span><span class="sub">${i.spec || '—'}</span></a>` },
    { key: 'qty', label: '현재 재고', render: (i) => html`<div class="inv-stock"><${Qty} value=${i.currentQty} unit=${i.unit} /><${StockBar} item=${i} /></div>` },
    { key: 'status', label: '상태', render: (i) => html`<${StatusBadge} item=${i} />` },
    { key: 'exp', label: '유효기간', render: (i) => html`<${ExpiryCell} item=${i} />` },
    { key: 'price', label: '최근 단가', align: 'right', render: (i) => html`<span class="num">${i.lastUnitPrice != null ? fmtMoney(i.lastUnitPrice) : '—'}</span>` },
  ];
  const lowCount = v.items.filter((i) => i.low).length;

  return html`
    <div class="inv-back"><a href="#/vendors" class="btn btn-ghost btn-sm"><${Icon} name="arrow-left" size=${14} />거래처 목록</a></div>
    <header class="page-header">
      <div class="inv-hero grow">
        <div class=${cx('icon-box', st.color)}><${Icon} name=${st.icon} size=${22} /></div>
        <div class="grow">
          <div class="row wrap" style=${{ gap: '6px', marginBottom: '4px' }}>
            <${Badge} color=${st.color}>${v.category}</${Badge}>
            <${MethodBadge} method=${v.orderMethod} />
            ${!v.active ? html`<${Badge}>보관됨</${Badge}>` : null}
          </div>
          <h1>${v.name}</h1>
          <p class="page-desc">${[v.contactName, v.phone].filter(Boolean).join(' · ') || '연락처 미등록'}</p>
        </div>
      </div>
      ${isManager
        ? html`<div class="page-actions">
            ${lowCount ? html`<${LinkButton} href="#/orders?auto=1" icon="shopping-cart" variant="soft">부족 품목 발주 (${lowCount})</${LinkButton}>` : null}
            <${Button} icon="pencil" onClick=${() => setEditing(true)}>수정</${Button}>
            <${Menu} size="md" items=${[
              { label: v.active ? '보관 (거래 중지)' : '보관 해제', icon: 'archive', onClick: toggleArchive },
              { label: '삭제', icon: 'trash-2', danger: true, onClick: remove },
            ]} />
          </div>`
        : null}
    </header>
    ${!v.active ? html`<${Callout} kind="info" title="보관된 거래처입니다.">새 품목·발주서의 거래처 목록에 나오지 않습니다. 과거 기록은 그대로 남아 있습니다.</${Callout}><div style=${{ height: '14px' }}></div>` : null}
    <div class="grid detail-grid">
      <div class="stack lg">
        <${Card} title="이 거래처 품목" icon="boxes" sub=${`${v.items.length}개${lowCount ? ` · 부족 ${lowCount}` : ''}`} flush>
          <${DataTable}
            columns=${columns}
            rows=${v.items}
            onRowClick=${(i) => navigate(`#/inventory/${i.id}`)}
            rowClass=${(i) => (i.status === 'out' ? 'inv-row-out' : i.status === 'low' ? 'inv-row-low' : '')}
            caption="거래처 품목"
            empty=${{ icon: 'package', title: '연결된 품목이 없습니다', desc: isManager ? '재고 화면에서 품목을 수정해 거래처를 이 업체로 지정하세요.' : '' }}
          />
        </${Card}>
        ${v.recentPos
          ? html`<${Card} title="최근 발주서" icon="shopping-cart" sub=${v.recentPos.length ? `최근 ${v.recentPos.length}건` : ''} flush>
              ${v.recentPos.length
                ? html`<div class="list">
                    ${v.recentPos.map(
                      (p) => html`<a class="list-item" href=${`#/orders/${p.id}`} key=${p.id}>
                        <${Badge} color=${PO_STATUS[p.status][0]}>${PO_STATUS[p.status][1]}</${Badge}>
                        <div class="grow">
                          <div class="list-title num">${p.poNo}</div>
                          <div class="list-meta">${p.firstItem || '품목 없음'}${p.lineCount > 1 ? ` 외 ${p.lineCount - 1}건` : ''} · ${fmtDate((p.orderDate || p.createdAt).slice(0, 10), { weekday: false })}</div>
                        </div>
                        ${p.status === 'ordered' && p.expectedDate ? html`<${DdayBadge} days=${p.daysToExpected} label=${p.daysToExpected < 0 ? '예정일 지남' : undefined} />` : null}
                        <span class="num strong">${fmtNumber(p.total)}원</span>
                        <${Icon} name="chevron-right" size=${16} class="muted" />
                      </a>`
                    )}
                  </div>`
                : html`<${EmptyState} compact icon="shopping-cart" title="아직 발주서가 없습니다" />`}
            </${Card}>`
          : null}
      </div>
      <div class="stack lg">
        <${Card} title="연락처" icon="phone">
          <dl class="inv-dl">
            <dt>담당자</dt><dd>${v.contactName || '—'}</dd>
            <dt>전화</dt><dd class="num">${v.phone || '—'}</dd>
            <dt>이메일</dt><dd>${v.email || '—'}</dd>
            <dt>주문 방법</dt><dd>${v.orderMethod}</dd>
            <dt>웹사이트</dt><dd>${v.website ? html`<a href=${webHref(v.website)} target="_blank" rel="noopener noreferrer">${v.website} <${Icon} name="external-link" size=${12} /></a>` : '—'}</dd>
            <dt>결제 조건</dt><dd>${v.paymentTerms || '—'}</dd>
          </dl>
        </${Card}>
        ${v.yearTotal !== undefined
          ? html`<div class="stat"><div class="stat-label"><${Icon} name="wallet" size=${14} />올해 발주 금액</div><div class="stat-value">${fmtNumber(v.yearTotal)}<span class="stat-unit">원</span></div><div class="stat-hint">발주함·입고 완료 발주서 기준</div></div>`
          : null}
        ${v.memo ? html`<${Card} title="메모" icon="notebook-pen"><p class="pre text-2">${v.memo}</p></${Card}>` : null}
      </div>
    </div>
    ${editing ? html`<${VendorEditor} vendor=${v} onClose=${() => setEditing(false)} onSaved=${() => { setEditing(false); reload(); }} />` : null}
  `;
}

export default function VendorsPage({ route }) {
  const id = route.parts[1];
  return id ? html`<${VendorDetail} id=${id} key=${id} />` : html`<${VendorList} route=${route} />`;
}
