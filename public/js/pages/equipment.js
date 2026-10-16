/*
 * 이 파일이 하는 일: [E1. 장비·점검] 화면입니다. 원내 장비 목록과 점검·수리 이력을 관리합니다.
 *
 *   #/equipment        장비 목록 (상태 배지, 다음 점검 D-day, 상태·분류 필터, 목록에서 바로 [기록] 추가)
 *   #/equipment/12     장비 상세 (정보 + 점검·수리 이력 타임라인)
 *
 *   - "정기 점검"·"법정 검사"를 기록하면 다음 점검일이 자동으로 다시 계산됩니다.
 *   - 장비 등록·수정은 실장 이상, 점검·수리 기록은 누구나 남길 수 있습니다.
 *
 * 이 파일은 멸균기 기록·법정 일정 화면이 함께 쓰는 작은 부품(직원 목록, 월 선택 등)도 내보냅니다. (맨 아래 export)
 */
import { html, useState, useEffect, useRef, fmtDate, fmtDot, fmtMoney, fmtNumber, toQuery, todayStr, addDays, cx } from '../lib.js';
import { api } from '../api.js';
import { navigate, setQuery } from '../router.js';
import { can, toast, confirmDialog } from '../store.js';
import {
  PageHeader, Card, Button, IconButton, Badge, Icon, Seg, Modal, Field, Input, Textarea, Select, Checkbox, SearchInput, FormGrid,
  useApi, useForm, Loading, ErrorState, EmptyState, DataTable, Menu, Stat, DdayBadge, Callout,
} from '../ui/index.js';

// ---------------- 공통 값 (서버 server/modules/facility/common.js 와 같게) ----------------
export const EQUIP_CATEGORIES = ['유니트체어', '멸균기', '방사선 장비', '컴프레서', '석션', '핸드피스', '구강스캐너', '기타'];
const EQUIP_STATUS = ['정상', '점검 필요', '수리 중', '사용 중지'];
const STATUS_COLOR = { 정상: 'green', '점검 필요': 'amber', '수리 중': 'red', '사용 중지': 'gray' };
const LOG_TYPES = ['정기 점검', '수리', '부품 교체', '법정 검사', '기타'];
const LOG_COLOR = { '정기 점검': 'blue', '법정 검사': 'purple', 수리: 'red', '부품 교체': 'amber', 기타: 'gray' };
const CAT_ICON = { 유니트체어: 'activity', 멸균기: 'thermometer', '방사선 장비': 'monitor', 컴프레서: 'activity', 석션: 'activity', 핸드피스: 'wrench', 구강스캐너: 'monitor', 기타: 'wrench' };

// ---------------- 다른 화면과 함께 쓰는 작은 도우미 ----------------

/** 직원 목록(담당자 선택용). 불러오지 못하면 빈 목록 */
export function usePeople() {
  const [list, setList] = useState([]);
  useEffect(() => {
    let alive = true;
    api
      .get('/admin/people')
      .then((d) => alive && setList(Array.isArray(d) ? d : []))
      .catch(() => alive && setList([]));
    return () => (alive = false);
  }, []);
  return list;
}

/**
 * 거래처 목록 (재고 모듈의 거래처). 거래처 기능이 없거나 모양이 달라도 화면이 멈추지 않게,
 * 배열이든 { rows: [...] } 든 받아서 { id, name } 만 씁니다. enabled=false 면 부르지 않음.
 */
export function useVendors(enabled) {
  const [list, setList] = useState([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api
      .get('/inventory/vendors')
      .then((d) => {
        const rows = Array.isArray(d) ? d : Array.isArray(d && d.rows) ? d.rows : [];
        if (alive) setList(rows.filter((v) => v && v.id && v.name).map((v) => ({ id: v.id, name: v.name })));
      })
      .catch(() => alive && setList([]));
    return () => (alive = false);
  }, [enabled]);
  return list;
}

/** 'YYYY-MM-DD' + n개월 (말일 넘지 않게: 1월 31일 + 1개월 = 2월 말일). 서버 계산과 같음 */
export function addMonthsStr(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const first = new Date(y, m - 1 + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const out = new Date(first.getFullYear(), first.getMonth(), Math.min(d, last));
  return `${out.getFullYear()}-${String(out.getMonth() + 1).padStart(2, '0')}-${String(out.getDate()).padStart(2, '0')}`;
}

/** 'YYYY-MM' + n개월 */
export function addMonthsYm(ym, n) {
  return addMonthsStr(`${ym}-01`, n).slice(0, 7);
}

/** '2026-10' → '2026년 10월' */
export function fmtYm(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  return `${y}년 ${m}월`;
}

/** 월 고르기: [‹] 2026년 10월 [›] [이번 달] */
export function MonthNav({ value, onChange }) {
  const ref = useRef();
  const thisYm = todayStr().slice(0, 7);
  const openPicker = () => {
    const el = ref.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  };
  return html`<div class="fx-month" role="group" aria-label="월 선택">
    <${IconButton} icon="chevron-left" label="이전 달" size="sm" variant="secondary" onClick=${() => onChange(addMonthsYm(value, -1))} />
    <button type="button" class="fx-month-label" onClick=${openPicker} aria-label=${`${fmtYm(value)} — 눌러서 달 고르기`}>
      <${Icon} name="calendar-days" size=${15} />${fmtYm(value)}
    </button>
    <input ref=${ref} type="month" class="fx-month-input" tabindex="-1" aria-hidden="true" value=${value} onChange=${(e) => e.target.value && onChange(e.target.value)} />
    <${IconButton} icon="chevron-right" label="다음 달" size="sm" variant="secondary" onClick=${() => onChange(addMonthsYm(value, 1))} />
    ${value !== thisYm ? html`<${Button} size="sm" variant="ghost" onClick=${() => onChange(thisYm)}>이번 달</${Button}>` : null}
  </div>`;
}

/** 큰 선택 버튼 묶음 (태블릿에서 누르기 쉽게). items: [{ value, label, tone?: 'pass'|'fail'|'pending' }] */
export function ChoiceGroup({ items, value, onChange, label, size }) {
  return html`<div class=${cx('fx-choices', size === 'sm' && 'sm')} role="radiogroup" aria-label=${label}>
    ${items.map(
      (it) => html`<button
        type="button"
        role="radio"
        aria-checked=${value === it.value ? 'true' : 'false'}
        class=${cx('fx-choice', it.tone && `tone-${it.tone}`)}
        onClick=${() => onChange(it.value)}
      >
        ${it.icon ? html`<${Icon} name=${it.icon} size=${15} />` : null}${it.label}
      </button>`
    )}
  </div>`;
}

/** 목록 아이콘 색: 상태가 정상이 아니면 상태 색, 정상이면 점검일 기준(지남 빨강·임박 주황·여유 파랑) */
function iconTone(e) {
  if (e.status === '사용 중지') return '';
  if (e.status !== '정상') return STATUS_COLOR[e.status];
  if (e.dday !== null && e.dday < 0) return 'red';
  if (e.dday !== null && e.dday <= 30) return 'amber';
  return 'blue';
}

function StatusBadge({ status }) {
  return html`<${Badge} color=${STATUS_COLOR[status] || 'gray'} dot>${status}</${Badge}>`;
}

/** 다음 점검일 + D-day */
function DueCell({ e }) {
  if (!e.nextDue) return html`<span class="small muted">${e.inspectionCycleDays ? '점검 기록 없음' : '주기 없음'}</span>`;
  return html`<div class="row nowrap" style=${{ gap: '6px' }}>
    <span class="num">${fmtDot(e.nextDue)}</span>
    ${e.status === '사용 중지' ? null : html`<${DdayBadge} days=${e.dday} label=${e.dday < 0 ? `${-e.dday}일 지남` : undefined} />`}
  </div>`;
}

function cycleText(days) {
  if (!days) return '주기 없음';
  if (days % 365 === 0) return `${days / 365}년마다`;
  if (days % 30 === 0) return `${days / 30}개월마다`;
  if (days % 7 === 0) return `${days / 7}주마다`;
  return `${days}일마다`;
}

// ---------------- 점검·수리 기록 추가 창 ----------------
function LogModal({ equipment: e, onClose, onSaved }) {
  const f = useForm({ date: todayStr(), type: '정기 점검', description: '', cost: '', vendorName: '', performedBy: '', setStatus: '' });
  const isInspection = f.values.type === '정기 점검' || f.values.type === '법정 검사';
  const preview = isInspection && e.inspectionCycleDays && f.values.date ? addDays(f.values.date, e.inspectionCycleDays) : null;

  // 종류를 고르면 자주 쓰는 다음 상태를 미리 골라 줌 (바꿀 수 있음)
  const pickType = (t) => {
    f.set('type', t);
    if ((t === '정기 점검' || t === '법정 검사') && e.status === '점검 필요') f.set('setStatus', '정상');
  };

  const save = f.submit(async (v) => {
    const body = {
      date: v.date,
      type: v.type,
      description: v.description,
      cost: v.cost === '' ? null : Number(String(v.cost).replace(/,/g, '')),
      vendorName: v.vendorName || null,
      performedBy: v.performedBy || null,
      setStatus: v.setStatus || null,
    };
    const r = await api.post(`/facility/equipment/${e.id}/logs`, body);
    toast.success('기록을 남겼습니다.');
    onSaved(r);
  });

  return html`<${Modal}
    open=${true}
    title=${`${e.name} — 점검·수리 기록`}
    onClose=${onClose}
    busy=${f.busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${f.busy} onClick=${save}>기록 저장</${Button}>`}
  >
    <form class="stack" onSubmit=${save}>
      <${Field} label="종류" required>
        <${ChoiceGroup} label="기록 종류" size="sm" value=${f.values.type} onChange=${pickType} items=${LOG_TYPES.map((t) => ({ value: t, label: t }))} />
      </${Field}>
      <${FormGrid}>
        <${Field} label="날짜" required error=${f.errors.date}><${Input} type="date" ...${f.bind('date')} max=${todayStr()} /></${Field}>
        <${Field} label="비용(원)" error=${f.errors.cost} hint="무상이면 비워 두세요."><${Input} inputmode="numeric" ...${f.bind('cost')} placeholder="예: 85000" /></${Field}>
      </${FormGrid}>
      <${Field} label="내용" required error=${f.errors.description}>
        <${Textarea} rows=${3} ...${f.bind('description')} placeholder=${f.values.type === '수리' ? '예: 석션 흡입력 약함 → 모터 브러시 교체' : '예: 필터 청소, 동작 정상 확인'} />
      </${Field}>
      <${FormGrid}>
        <${Field} label="업체"><${Input} ...${f.bind('vendorName')} placeholder="예: 한빛덴탈" /></${Field}>
        <${Field} label="작업자"><${Input} ...${f.bind('performedBy')} placeholder="예: 김기사 / 직접" /></${Field}>
      </${FormGrid}>
      <${Field} label="기록 후 장비 상태" hint=${`지금 상태: ${e.status}`}>
        <${Select} ...${f.bind('setStatus')} options=${[{ value: '', label: '그대로 두기' }, ...EQUIP_STATUS.map((s) => ({ value: s, label: `${s}(으)로 바꾸기` }))]} />
      </${Field}>
      ${isInspection
        ? html`<${Callout} kind="info" icon="calendar-check">
            ${preview ? html`저장하면 다음 점검일이 <strong>${fmtDate(preview)}</strong> 로 바뀝니다.` : '이 장비는 점검 주기가 없어 다음 점검일은 계산하지 않습니다.'}
          </${Callout}>`
        : null}
    </form>
  </${Modal}>`;
}

// ---------------- 장비 등록·수정 창 (실장 이상) ----------------
function EquipmentEditor({ item, vendors, onClose, onSaved }) {
  const f = useForm(
    item
      ? {
          name: item.name, category: item.category, model: item.model || '', serialNo: item.serialNo || '', location: item.location || '',
          vendorId: item.vendorId ? String(item.vendorId) : '', asContact: item.asContact || '', installDate: item.installDate || '',
          warrantyUntil: item.warrantyUntil || '', inspectionCycleDays: item.inspectionCycleDays ?? '', lastInspected: item.lastInspected || '',
          status: item.status, memo: item.memo || '',
        }
      : { name: '', category: '유니트체어', model: '', serialNo: '', location: '', vendorId: '', asContact: '', installDate: '', warrantyUntil: '', inspectionCycleDays: 180, lastInspected: '', status: '정상', memo: '' }
  );
  const save = f.submit(async (v) => {
    const body = {
      ...v,
      vendorId: v.vendorId ? Number(v.vendorId) : null,
      inspectionCycleDays: v.inspectionCycleDays === '' ? null : Number(v.inspectionCycleDays),
    };
    for (const k of ['model', 'serialNo', 'location', 'asContact', 'installDate', 'warrantyUntil', 'lastInspected', 'memo']) if (body[k] === '') body[k] = null;
    const saved = item ? await api.patch(`/facility/equipment/${item.id}`, body) : await api.post('/facility/equipment', body);
    toast.success(item ? '수정했습니다.' : '장비를 등록했습니다.');
    onSaved(saved);
  });
  const cycle = Number(f.values.inspectionCycleDays) || 0;
  return html`<${Modal}
    open=${true}
    size="lg"
    title=${item ? '장비 정보 수정' : '장비 등록'}
    onClose=${onClose}
    busy=${f.busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${f.busy} onClick=${save}>${item ? '저장' : '등록'}</${Button}>`}
  >
    <form class="stack" onSubmit=${save}>
      <${FormGrid}>
        <${Field} label="장비 이름" required error=${f.errors.name}><${Input} ...${f.bind('name')} placeholder="예: 유니트체어 4번" maxlength="80" /></${Field}>
        <${Field} label="분류" required error=${f.errors.category}><${Select} ...${f.bind('category')} options=${EQUIP_CATEGORIES} /></${Field}>
        <${Field} label="모델명"><${Input} ...${f.bind('model')} /></${Field}>
        <${Field} label="일련번호"><${Input} ...${f.bind('serialNo')} /></${Field}>
        <${Field} label="위치"><${Input} ...${f.bind('location')} placeholder="예: 진료실 1" /></${Field}>
        <${Field} label="상태"><${Select} ...${f.bind('status')} options=${EQUIP_STATUS} /></${Field}>
        ${vendors.length
          ? html`<${Field} label="거래처"><${Select} ...${f.bind('vendorId')} placeholder="선택 안 함" options=${vendors.map((v) => ({ value: String(v.id), label: v.name }))} /></${Field}>`
          : null}
        <${Field} label="업체 AS 연락처" hint="업체 이름과 대표 전화 (직원 개인 연락처는 적지 마세요)" class=${vendors.length ? '' : 'full'}>
          <${Input} ...${f.bind('asContact')} placeholder="예: 한빛덴탈 장비AS 02-555-0141" />
        </${Field}>
        <${Field} label="설치일"><${Input} type="date" ...${f.bind('installDate')} /></${Field}>
        <${Field} label="보증 만료일"><${Input} type="date" ...${f.bind('warrantyUntil')} /></${Field}>
        <${Field} label="점검 주기(일)" error=${f.errors.inspectionCycleDays} hint=${cycle ? cycleText(cycle) + ' 점검' : '비우면 다음 점검일을 계산하지 않습니다.'}>
          <${Input} inputmode="numeric" ...${f.bind('inspectionCycleDays')} placeholder="예: 180" />
        </${Field}>
        <${Field} label="마지막 점검일" hint="점검 기록을 남기면 자동으로 바뀝니다."><${Input} type="date" ...${f.bind('lastInspected')} max=${todayStr()} /></${Field}>
        <${Field} label="메모" full><${Textarea} rows=${3} ...${f.bind('memo')} placeholder="예: 매일 마감 때 물빼기" /></${Field}>
      </${FormGrid}>
      <div class="row wrap" style=${{ gap: '6px' }}>
        <span class="small muted">점검 주기 빠른 선택:</span>
        ${[[30, '1개월'], [90, '3개월'], [180, '6개월'], [365, '1년']].map(
          ([d, l]) => html`<button type="button" class="fx-chip" onClick=${() => f.set('inspectionCycleDays', d)}>${l}</button>`
        )}
      </div>
    </form>
  </${Modal}>`;
}

// ---------------- 상세 ----------------
function EquipmentDetail({ id }) {
  const { data: e, loading, error, reload } = useApi(`/facility/equipment/${id}`);
  const [logging, setLogging] = useState(false);
  const [editing, setEditing] = useState(false);
  const vendors = useVendors(!!(e && can('manager')));

  if (error && !e) return html`<${BackLink} /><${Card}><${ErrorState} error=${error} onRetry=${reload} /></${Card}>`;
  if (loading && !e) return html`<${BackLink} /><${Card}><${Loading} rows=${6} /></${Card}>`;
  if (!e) return null;

  const toggleArchive = async () => {
    try {
      await api.patch(`/facility/equipment/${id}`, { active: !e.active });
      toast.success(e.active ? '보관함으로 옮겼습니다.' : '보관을 해제했습니다.');
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: '이 장비를 삭제할까요?', message: '점검·수리 이력도 함께 지워지고 되돌릴 수 없습니다. 더 쓰지 않는 장비라면 [보관]을 권합니다.', danger: true, confirmText: '삭제' }))) return;
    try {
      await api.del(`/facility/equipment/${id}`);
      toast.success('삭제했습니다.');
      navigate('#/equipment');
    } catch (err) {
      toast.error(err.message);
    }
  };
  const removeLog = async (l) => {
    if (!(await confirmDialog({ title: '이 기록을 삭제할까요?', message: `${fmtDate(l.date)} ${l.type}: ${l.description}`, danger: true, confirmText: '삭제' }))) return;
    try {
      await api.del(`/facility/equipment/logs/${l.id}`);
      toast.success('기록을 삭제했습니다.');
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const info = [
    ['분류', e.category],
    ['모델명', e.model],
    ['일련번호', e.serialNo],
    ['위치', e.location],
    ['거래처', e.vendorName],
    ['업체 AS 연락처', e.asContact],
    ['설치일', e.installDate && fmtDate(e.installDate, { long: true, weekday: false })],
    ['점검 주기', e.inspectionCycleDays ? `${cycleText(e.inspectionCycleDays)} (${e.inspectionCycleDays}일)` : null],
  ];

  return html`
    <${BackLink} />
    <${PageHeader}
      title=${e.name}
      actions=${html`
        <${Button} variant="primary" icon="plus" onClick=${() => setLogging(true)}>점검·수리 기록</${Button}>
        ${e.canEdit
          ? html`<${Button} icon="pencil" onClick=${() => setEditing(true)}>수정</${Button}>
              <${Menu} size=${null} buttonVariant="secondary" items=${[
                { label: e.active ? '보관함으로' : '보관 해제', icon: 'archive', onClick: toggleArchive },
                '-',
                { label: '삭제', icon: 'trash-2', danger: true, onClick: remove },
              ]} />`
          : null}
      `}
    >
      <div class="row wrap mt-2" style=${{ gap: '6px' }}>
        <${StatusBadge} status=${e.status} />
        <${Badge}>${e.category}</${Badge}>
        ${!e.active ? html`<${Badge}>보관됨</${Badge}>` : null}
        ${e.warrantyActive ? html`<${Badge} color="blue">보증 ${fmtDot(e.warrantyUntil)}까지</${Badge}>` : null}
      </div>
    </${PageHeader}>

    ${e.status === '수리 중' || e.status === '점검 필요'
      ? html`<${Callout} kind=${e.status === '수리 중' ? 'danger' : 'warn'} class="fx-mb">
          지금 <strong>${e.status}</strong> 상태입니다. ${e.asContact ? html`AS 연락처: <span class="strong">${e.asContact}</span>.` : ''} 처리 후 기록을 남기며 상태를 "정상"으로 바꿔 주세요.
        </${Callout}>`
      : null}

    <div class="grid fx-stat-grid fx-mb">
      <${Stat} label="다음 점검" icon="calendar-clock" value=${e.nextDue ? fmtDot(e.nextDue) : '—'}
        hint=${e.nextDue ? (e.dday < 0 ? `${-e.dday}일 지남` : e.dday === 0 ? '오늘' : `${e.dday}일 남음`) : '점검 주기를 넣으면 계산합니다'}
        color=${e.dday !== null && e.dday < 0 ? 'danger' : e.dday !== null && e.dday <= 30 ? 'warning' : undefined} />
      <${Stat} label="마지막 점검" icon="calendar-check" value=${e.lastInspected ? fmtDot(e.lastInspected) : '—'} hint=${cycleText(e.inspectionCycleDays)} />
      <${Stat} label="누적 수리·점검 비용" icon="receipt" value=${fmtNumber(e.totalCost)} unit="원" hint=${`기록 ${e.logs.length}건`} />
      <${Stat} label="보증" icon="badge-check" value=${e.warrantyUntil ? (e.warrantyActive ? '보증 중' : '만료') : '—'} hint=${e.warrantyUntil ? `${fmtDot(e.warrantyUntil)}까지` : '보증 만료일 미입력'} />
    </div>

    <div class="grid detail-grid">
      <${Card} title="점검·수리 이력" sub=${`${e.logs.length}건`} flush
        actions=${html`<${Button} size="sm" icon="plus" onClick=${() => setLogging(true)}>기록 추가</${Button}>`}>
        ${e.logs.length
          ? html`<ol class="fx-timeline">
              ${e.logs.map(
                (l) => html`<li class=${`fx-tl-item tone-${LOG_COLOR[l.type] || 'gray'}`} key=${l.id}>
                  <span class="fx-tl-dot" aria-hidden="true"></span>
                  <div class="grow">
                    <div class="row wrap" style=${{ gap: '8px' }}>
                      <${Badge} color=${LOG_COLOR[l.type]}>${l.type}</${Badge}>
                      <span class="strong num">${fmtDate(l.date, { long: true })}</span>
                      ${l.cost ? html`<span class="small text-2 num">${fmtMoney(l.cost)}</span>` : null}
                      <span class="grow"></span>
                      ${l.canDelete ? html`<${IconButton} icon="trash-2" size="sm" label="기록 삭제" onClick=${() => removeLog(l)} />` : null}
                    </div>
                    <div class="mt-1 pre">${l.description}</div>
                    <div class="small muted mt-1">
                      ${[l.vendorName, l.performedBy && `작업 ${l.performedBy}`, l.createdByName && `기록 ${l.createdByName}`].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </li>`
              )}
            </ol>`
          : html`<${EmptyState} icon="history" title="아직 기록이 없습니다" desc="점검·수리·부품 교체를 기록해 두면 다음 점검일과 비용이 자동으로 정리됩니다."
              action=${html`<${Button} variant="primary" icon="plus" onClick=${() => setLogging(true)}>첫 기록 남기기</${Button}>`} />`}
      </${Card}>
      <div class="stack">
        <${Card} title="장비 정보">
          <dl class="fx-kv">
            ${info.map(([k, val]) => html`<dt>${k}</dt><dd class=${val ? '' : 'muted'}>${val || '—'}</dd>`)}
          </dl>
          ${e.memo ? html`<hr class="divider" /><div class="small strong text-2">메모</div><p class="pre mt-1">${e.memo}</p>` : null}
        </${Card}>
        ${e.category === '멸균기'
          ? html`<${Card} title="멸균 기록" icon="thermometer">
              <p class="small text-2">이 멸균기로 기록된 멸균 회차: <strong class="num">${fmtNumber(e.sterilizationCount)}</strong>회</p>
              <a class="btn btn-sm mt-2" href="#/sterilization"><${Icon} name="arrow-right" size=${14} />멸균기 기록으로</a>
            </${Card}>`
          : null}
      </div>
    </div>

    ${logging ? html`<${LogModal} equipment=${e} onClose=${() => setLogging(false)} onSaved=${() => { setLogging(false); reload(); }} />` : null}
    ${editing ? html`<${EquipmentEditor} item=${e} vendors=${vendors} onClose=${() => setEditing(false)} onSaved=${() => { setEditing(false); reload(); }} />` : null}
  `;
}

function BackLink() {
  return html`<div class="row" style=${{ marginBottom: '12px' }}>
    <a href="#/equipment" class="btn btn-ghost btn-sm"><${Icon} name="arrow-left" size=${14} />장비 목록</a>
  </div>`;
}

// ---------------- 목록 ----------------
function EquipmentList({ route }) {
  const q = route.query;
  const [search, setSearch] = useState(q.q || '');
  const [creating, setCreating] = useState(false);
  const [logFor, setLogFor] = useState(null);
  const { data, loading, error, reload } = useApi(
    `/facility/equipment${toQuery({ status: q.status || '', category: q.category || '', q: q.q || '', archived: q.archived || '' })}`
  );
  const isManager = can('manager');
  const vendors = useVendors(!!(isManager && data && data.vendorsAvailable));

  useEffect(() => {
    const t = setTimeout(() => {
      if ((q.q || '') !== search) setQuery({ q: search });
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const counts = data ? data.counts : null;
  const filtered = !!(q.status || q.category || q.q);

  const columns = [
    {
      key: 'name',
      label: '장비',
      render: (e) => html`<div class="row" style=${{ gap: '10px', minWidth: '200px' }}>
        <div class=${`icon-box ${iconTone(e)}`}><${Icon} name=${CAT_ICON[e.category] || 'wrench'} size=${16} /></div>
        <div class="grow">
          <div class="strong">${e.name}</div>
          <div class="small muted ellipsis">${[e.model, e.location].filter(Boolean).join(' · ') || e.category}</div>
        </div>
      </div>`,
    },
    { key: 'category', label: '분류', render: (e) => html`<span class="nowrap">${e.category}</span>` },
    { key: 'status', label: '상태', render: (e) => html`<${StatusBadge} status=${e.status} />` },
    { key: 'lastInspected', label: '마지막 점검', render: (e) => (e.lastInspected ? html`<span class="num nowrap">${fmtDot(e.lastInspected)}</span>` : html`<span class="small muted">없음</span>`) },
    { key: 'nextDue', label: '다음 점검', render: (e) => html`<${DueCell} e=${e} />` },
    {
      key: 'act',
      label: html`<span class="sr-only">빠른 기록</span>`,
      class: 'actions',
      render: (e) => html`<${Button}
        size="sm"
        variant="soft"
        icon="plus"
        onClick=${(ev) => { ev.stopPropagation(); setLogFor(e); }}
        onKeyDown=${(ev) => ev.stopPropagation()}
        aria-label=${`${e.name} 점검·수리 기록`}
      >기록</${Button}>`,
    },
  ];

  return html`
    <${PageHeader}
      title="장비·점검"
      desc="원내 장비와 점검·수리 이력. 정기 점검을 기록하면 다음 점검일이 자동으로 계산됩니다."
      actions=${isManager ? html`<${Button} variant="primary" icon="plus" onClick=${() => setCreating(true)}>장비 등록</${Button}>` : null}
    />
    ${counts
      ? html`<div class="grid fx-stat-grid fx-mb">
          <${Stat} label="사용 중인 장비" icon="wrench" value=${counts.total} unit="대" href="#/equipment" />
          <${Stat} label="점검일 지남" icon="circle-alert" value=${counts.overdue} unit="대" color=${counts.overdue ? 'danger' : undefined} href="#/equipment?status=due" hint="바로 점검이 필요해요" />
          <${Stat} label="30일 안에 점검" icon="calendar-clock" value=${counts.soon} unit="대" color=${counts.soon ? 'warning' : undefined} href="#/equipment?status=due" />
          <${Stat} label="점검 필요·수리 중" icon="triangle-alert" value=${counts.attention} unit="대" href="#/equipment?status=attention" hint=${counts.stopped ? `사용 중지 ${counts.stopped}대` : undefined} />
        </div>`
      : null}
    <div class="row wrap fx-filters">
      <${Seg}
        label="상태로 보기"
        value=${q.status || ''}
        onChange=${(v) => setQuery({ status: v })}
        items=${[
          { value: '', label: '전체' },
          { value: 'due', label: '점검 임박·지남' },
          { value: 'attention', label: '점검 필요·수리 중' },
          { value: '사용 중지', label: '사용 중지' },
        ]}
      />
      <${Select} size="sm" aria-label="분류" value=${q.category || ''} onChange=${(e) => setQuery({ category: e.target.value })} placeholder="모든 분류" options=${EQUIP_CATEGORIES} style=${{ width: '150px' }} />
      <${SearchInput} value=${search} onInput=${setSearch} placeholder="장비·모델·위치 검색" style=${{ maxWidth: '260px' }} />
      <${Checkbox} label="보관함" checked=${q.archived === '1'} onChange=${(c) => setQuery({ archived: c ? '1' : '' })} />
    </div>
    <${Card} flush>
      <${DataTable}
        columns=${columns}
        rows=${data && data.rows}
        loading=${loading}
        error=${error}
        onRetry=${reload}
        onRowClick=${(e) => navigate(`#/equipment/${e.id}`)}
        rowClass=${(e) => (e.status === '사용 중지' ? 'fx-dim' : '')}
        caption="장비 목록"
        empty=${{
          icon: 'wrench',
          title: filtered ? '조건에 맞는 장비가 없습니다' : q.archived === '1' ? '보관한 장비가 없습니다' : '등록된 장비가 없습니다',
          desc: filtered ? '필터나 검색어를 바꿔 보세요.' : '유니트체어·멸균기·방사선 장비 등을 등록하면 점검 일정을 챙겨 드립니다.',
          action: filtered
            ? html`<${Button} onClick=${() => { setSearch(''); setQuery({ status: '', category: '', q: '' }); }}>필터 지우기</${Button}>`
            : isManager && q.archived !== '1'
              ? html`<${Button} variant="primary" icon="plus" onClick=${() => setCreating(true)}>장비 등록</${Button}>`
              : null,
        }}
      />
    </${Card}>
    ${creating
      ? html`<${EquipmentEditor} vendors=${vendors} onClose=${() => setCreating(false)} onSaved=${(e) => { setCreating(false); navigate(`#/equipment/${e.id}`); }} />`
      : null}
    ${logFor ? html`<${LogModal} equipment=${logFor} onClose=${() => setLogFor(null)} onSaved=${() => { setLogFor(null); reload(); }} />` : null}
  `;
}

export default function EquipmentPage({ route }) {
  const id = route.parts[1];
  return id ? html`<${EquipmentDetail} id=${id} key=${id} />` : html`<${EquipmentList} route=${route} />`;
}
