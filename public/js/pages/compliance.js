/*
 * 이 파일이 하는 일: [E3. 법정 일정] 화면입니다. 방사선·소방·개인정보·감염관리 같은 정기 의무 일정을 챙깁니다.
 *
 *   #/compliance              일정 목록 (기한 지난 것 → 가까운 순, D-day, 분류·상태 필터, 목록에서 바로 [완료])
 *   #/compliance/12           일정 상세 창 (정보, 완료 이력, 완료 취소)
 *
 *   - [완료]를 누르면 기록이 남고 다음 일정 = 완료일 + 주기 로 자동 계산됩니다.
 *   - 주기를 확신할 수 없는 항목은 "주기 확인 필요"로 크게 표시합니다. 실장 이상이 주기를 고칠 수 있습니다.
 *   - 법령·지자체 기준은 바뀔 수 있으므로 화면 맨 위에 "법률 자문이 아님" 안내를 둡니다. (docs/DECISIONS.md D-12)
 */
import { html, useState, useEffect, fmtDate, fmtDot, toQuery, todayStr, cx } from '../lib.js';
import { api } from '../api.js';
import { navigate, setQuery } from '../router.js';
import { can, toast, confirmDialog } from '../store.js';
import {
  PageHeader, Card, Button, IconButton, Badge, Icon, Seg, Modal, Field, Input, Textarea, Select, Checkbox, SearchInput, FormGrid,
  useApi, useForm, Loading, ErrorState, EmptyState, Menu, Stat, DdayBadge, Callout,
} from '../ui/index.js';
import { usePeople, addMonthsStr } from './equipment.js';

const CATEGORIES = ['방사선', '감염관리', '소방·안전', '개인정보', '의료폐기물', '노무·교육', '면허·신고', '시설', '기타'];
const CAT_ICON = {
  방사선: 'monitor',
  감염관리: 'shield-check',
  '소방·안전': 'triangle-alert',
  개인정보: 'lock',
  의료폐기물: 'trash-2',
  '노무·교육': 'graduation-cap',
  '면허·신고': 'badge-check',
  시설: 'building-2',
  기타: 'clipboard-list',
};
const CYCLE_CHOICES = [
  [null, '수시·일회성'],
  [1, '매월'],
  [3, '3개월'],
  [6, '6개월'],
  [12, '1년'],
  [24, '2년'],
  [36, '3년'],
];

function cycleLabel(m) {
  if (!m) return '수시·일회성';
  if (m % 12 === 0) return `${m / 12}년마다`;
  if (m === 1) return '매월';
  return `${m}개월마다`;
}

function tone(t) {
  return t.state === 'overdue' ? 'red' : t.state === 'soon' ? 'amber' : t.state === 'none' ? '' : 'blue';
}

/** 법률 자문이 아님 안내 (화면에 늘 보이게) */
function Disclaimer() {
  return html`<${Callout} kind="warn" icon="info" class="fx-mb">
    법정 주기는 법령·지자체 기준에 따라 다를 수 있으니 관할 보건소·관련 기관에 확인하세요. 이 서비스는 법률 자문이 아닙니다.
    <span class="text-2"> "주기 확인 필요" 표시가 있는 항목은 특히 확인 후 주기를 고쳐 주세요.</span>
  </${Callout}>`;
}

function TaskBadges({ t }) {
  return html`<span class="fx-badges">
    ${t.needsCheck ? html`<${Badge} color="amber" title="주기나 대상 여부를 관할 기관에 확인해야 합니다"><${Icon} name="circle-help" size=${12} />주기 확인 필요</${Badge}>` : null}
    ${t.internal ? html`<${Badge} color="purple" title="법정 의무가 아닌 원내 자체 기준">원내 자체</${Badge}>` : null}
    ${!t.active ? html`<${Badge}>보관됨</${Badge}>` : null}
  </span>`;
}

function DueBlock({ t }) {
  if (!t.nextDue) return html`<div class="fx-task-due"><span class="small muted">다음 일정 미정</span></div>`;
  return html`<div class="fx-task-due">
    <span class="num small text-2">${fmtDot(t.nextDue)}</span>
    <${DdayBadge} days=${t.dday} label=${t.dday < 0 ? `${-t.dday}일 지남` : undefined} />
  </div>`;
}

// ---------------- 완료 처리 창 ----------------
function CompleteModal({ task, onClose, onSaved }) {
  const f = useForm({ doneDate: todayStr(), note: '', nextDue: '' });
  const auto = task.cycleMonths && f.values.doneDate ? addMonthsStr(f.values.doneDate, task.cycleMonths) : null;
  const save = f.submit(async (v) => {
    const r = await api.post(`/facility/compliance/tasks/${task.id}/complete`, { doneDate: v.doneDate, note: v.note || null, nextDue: v.nextDue || null });
    toast.success(r.nextDue ? `완료했습니다. 다음 일정은 ${fmtDate(r.nextDue)} 입니다.` : '완료했습니다.');
    onSaved(r);
  });
  return html`<${Modal}
    open=${true}
    title=${`완료 처리 — ${task.name}`}
    onClose=${onClose}
    busy=${f.busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" icon="check" loading=${f.busy} onClick=${save}>완료로 기록</${Button}>`}
  >
    <form class="stack" onSubmit=${save}>
      <${Field} label="완료한 날" required error=${f.errors.doneDate}>
        <${Input} type="date" ...${f.bind('doneDate')} max=${todayStr()} style=${{ maxWidth: '200px' }} />
      </${Field}>
      ${auto
        ? html`<${Callout} kind="info" icon="calendar-check">
            다음 일정이 <strong>${fmtDate(auto, { long: true })}</strong> 로 자동 계산됩니다. (${cycleLabel(task.cycleMonths)})
          </${Callout}>`
        : html`<${Field} label="다음 일정 (선택)" hint="주기가 없는 항목입니다. 다음에 할 날짜를 알면 적어 두세요." error=${f.errors.nextDue}>
            <${Input} type="date" ...${f.bind('nextDue')} style=${{ maxWidth: '200px' }} />
          </${Field}>`}
      <${Field} label="메모" hint="예: 검사기관, 성적서 번호, 교육 이수 인원 (환자 정보는 적지 마세요)">
        <${Textarea} rows=${3} ...${f.bind('note')} placeholder="예: 검사 적합, 성적서는 서식 보관함에 보관" />
      </${Field}>
      ${task.needsCheck ? html`<${Callout} kind="warn" icon="circle-help">이 항목은 <strong>주기 확인 필요</strong> 상태입니다. 완료하면서 관할 기관에 다음 주기도 함께 확인해 보세요.</${Callout}>` : null}
    </form>
  </${Modal}>`;
}

// ---------------- 추가·수정 창 (실장 이상) ----------------
function TaskEditor({ task, people, onClose, onSaved }) {
  const f = useForm(
    task
      ? {
          name: task.name, category: task.category, legalBasis: task.legalBasis || '', cycleMonths: task.cycleMonths ?? '', needsCheck: task.needsCheck,
          internal: task.internal, lastDone: task.lastDone || '', nextDue: task.nextDue || '', ownerId: task.ownerId ? String(task.ownerId) : '', notes: task.notes || '',
        }
      : { name: '', category: '기타', legalBasis: '', cycleMonths: 12, needsCheck: false, internal: false, lastDone: '', nextDue: '', ownerId: '', notes: '' }
  );
  // 다음 일정을 사용자가 직접 고쳤는지 (안 고쳤으면 서버가 주기로 다시 계산하게 보내지 않음)
  const [touchedDue, setTouchedDue] = useState(false);
  const v = f.values;
  const cycle = v.cycleMonths === '' || v.cycleMonths === null ? null : Number(v.cycleMonths);
  const autoDue = cycle && v.lastDone ? addMonthsStr(v.lastDone, cycle) : null;

  // 주기나 마지막 완료일을 바꾸면 (직접 고치지 않은 경우) 다음 일정 칸도 미리 계산해서 보여 줌
  useEffect(() => {
    if (!touchedDue && autoDue) f.set('nextDue', autoDue);
  }, [autoDue]);

  const save = f.submit(async (val) => {
    const body = {
      name: val.name,
      category: val.category,
      legalBasis: val.legalBasis || null,
      cycleMonths: cycle,
      needsCheck: val.needsCheck,
      internal: val.internal,
      lastDone: val.lastDone || null,
      ownerId: val.ownerId ? Number(val.ownerId) : null,
      notes: val.notes || null,
    };
    if (touchedDue || !task) body.nextDue = val.nextDue || null;
    const saved = task ? await api.patch(`/facility/compliance/tasks/${task.id}`, body) : await api.post('/facility/compliance/tasks', body);
    toast.success(task ? '수정했습니다.' : '일정을 추가했습니다.');
    onSaved(saved);
  });

  return html`<${Modal}
    open=${true}
    size="lg"
    title=${task ? '법정 일정 수정' : '법정 일정 추가'}
    onClose=${onClose}
    busy=${f.busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${f.busy} onClick=${save}>${task ? '저장' : '추가'}</${Button}>`}
  >
    <form class="stack" onSubmit=${save}>
      <${FormGrid}>
        <${Field} label="일정 이름" required error=${f.errors.name} full>
          <${Input} ...${f.bind('name')} placeholder="예: 소방시설 자체점검" maxlength="100" />
        </${Field}>
        <${Field} label="분류" required error=${f.errors.category}><${Select} ...${f.bind('category')} options=${CATEGORIES} /></${Field}>
        <${Field} label="담당자"><${Select} ...${f.bind('ownerId')} placeholder="정하지 않음" options=${people.map((p) => ({ value: String(p.id), label: p.name }))} /></${Field}>
        <${Field} label="근거 (짧게)" full hint="예: 개인정보 보호법 / 원내 자체 기준">
          <${Input} ...${f.bind('legalBasis')} maxlength="200" />
        </${Field}>
        <${Field} label="주기" full error=${f.errors.cycleMonths}>
          <div class="stack sm">
            <div class="fx-cycle-chips" role="group" aria-label="주기 빠른 선택">
              ${CYCLE_CHOICES.map(
                ([m, l]) => html`<button type="button" class="fx-chip" aria-pressed=${cycle === m ? 'true' : 'false'} onClick=${() => f.set('cycleMonths', m === null ? '' : m)}>${l}</button>`
              )}
            </div>
            <div class="row" style=${{ gap: '8px' }}>
              <${Input} inputmode="numeric" aria-label="주기(개월)" value=${v.cycleMonths ?? ''} onInput=${(e) => f.set('cycleMonths', e.target.value.replace(/\D/g, ''))} placeholder="비우면 수시" style=${{ width: '120px' }} />
              <span class="small muted">개월마다 · ${cycleLabel(cycle)}</span>
            </div>
          </div>
        </${Field}>
        <${Field} label="마지막 완료일"><${Input} type="date" ...${f.bind('lastDone')} max=${todayStr()} /></${Field}>
        <${Field} label="다음 일정" error=${f.errors.nextDue} hint=${autoDue ? `자동 계산: ${fmtDate(autoDue)} (직접 고칠 수 있음)` : '주기가 없으면 직접 적어 주세요.'}>
          <${Input} type="date" value=${v.nextDue} onInput=${(e) => { setTouchedDue(true); f.set('nextDue', e.target.value); }} />
        </${Field}>
        <div class="full stack sm">
          <${Checkbox} label="주기 확인 필요 (관할 기관에 주기·대상 여부를 아직 확인하지 못함)" ...${f.bind('needsCheck', { type: 'checkbox' })} />
          <${Checkbox} label="원내 자체 기준 (법정 의무는 아니지만 정기적으로 챙기는 일)" ...${f.bind('internal', { type: 'checkbox' })} />
        </div>
        <${Field} label="메모" full><${Textarea} rows=${3} ...${f.bind('notes')} placeholder="예: 검사기관 연락처, 준비 서류" /></${Field}>
      </${FormGrid}>
    </form>
  </${Modal}>`;
}

// ---------------- 상세 창 (정보 + 완료 이력) ----------------
function TaskDetail({ id, people, onChanged, backHref }) {
  const { data: t, loading, error, reload } = useApi(`/facility/compliance/tasks/${id}`);
  const [completing, setCompleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const close = () => navigate(backHref);
  const changed = () => {
    reload();
    onChanged();
  };

  const undo = async (l) => {
    if (!(await confirmDialog({ title: '이 완료 기록을 취소할까요?', message: `${fmtDate(l.doneDate)} 완료 기록을 지우고, 가장 최근 기록이면 마지막 완료일·다음 일정을 이전 값으로 되돌립니다.`, danger: true, confirmText: '완료 취소' }))) return;
    try {
      await api.del(`/facility/compliance/logs/${l.id}`);
      toast.success('완료 기록을 취소했습니다.');
      changed();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const toggleArchive = async () => {
    try {
      await api.patch(`/facility/compliance/tasks/${id}`, { active: !t.active });
      toast.success(t.active ? '보관했습니다.' : '보관을 해제했습니다.');
      changed();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: '이 일정을 삭제할까요?', message: '완료 이력도 함께 지워지고 되돌릴 수 없습니다. 더 챙기지 않을 일정이라면 [보관]을 권합니다.', danger: true, confirmText: '삭제' }))) return;
    try {
      await api.del(`/facility/compliance/tasks/${id}`);
      toast.success('삭제했습니다.');
      onChanged();
      close();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const body = error && !t
    ? html`<${ErrorState} error=${error} onRetry=${reload} compact />`
    : !t
      ? html`<${Loading} rows=${6} />`
      : html`<div class="stack">
          <div class="row wrap" style=${{ gap: '6px' }}>
            <${Badge} color="blue">${t.category}</${Badge}>
            <${TaskBadges} t=${t} />
            ${t.nextDue ? html`<${DdayBadge} days=${t.dday} label=${t.dday < 0 ? `${-t.dday}일 지남` : undefined} />` : null}
          </div>
          ${t.needsCheck
            ? html`<${Callout} kind="warn" icon="circle-help" title="주기 확인 필요">
                이 항목의 주기·대상 여부는 관할 보건소나 관련 기관에 확인이 필요합니다.${t.canEdit ? ' 확인한 뒤 [수정]에서 주기를 고치고 "주기 확인 필요"를 풀어 주세요.' : ' 확인 결과는 실장님께 알려 주세요.'}
              </${Callout}>`
            : null}
          <dl class="fx-kv">
            <dt>근거</dt><dd class=${t.legalBasis ? '' : 'muted'}>${t.legalBasis || '—'}</dd>
            <dt>주기</dt><dd>${t.cycleLabel}</dd>
            <dt>담당자</dt><dd class=${t.ownerName ? '' : 'muted'}>${t.ownerName || '정하지 않음'}</dd>
            <dt>마지막 완료</dt><dd class=${t.lastDone ? '' : 'muted'}>${t.lastDone ? fmtDate(t.lastDone, { long: true }) : '기록 없음'}</dd>
            <dt>다음 일정</dt><dd class=${t.nextDue ? 'strong' : 'muted'}>${t.nextDue ? fmtDate(t.nextDue, { long: true }) : '미정'}</dd>
          </dl>
          ${t.notes ? html`<div><div class="small strong text-2">메모</div><p class="pre mt-1">${t.notes}</p></div>` : null}
          <hr class="divider" />
          <div class="row between">
            <div class="strong">완료 이력 <span class="small muted">${t.logs.length}건</span></div>
          </div>
          ${t.logs.length
            ? html`<ol class="fx-timeline" style=${{ padding: 0 }}>
                ${t.logs.map(
                  (l) => html`<li class=${cx('fx-tl-item', l.latest ? 'tone-blue' : '')} key=${l.id} style=${{ paddingLeft: '6px', paddingRight: 0 }}>
                    <span class="fx-tl-dot" aria-hidden="true"></span>
                    <div class="grow">
                      <div class="row wrap" style=${{ gap: '8px' }}>
                        <span class="strong">${fmtDate(l.doneDate, { long: true })}</span>
                        ${l.latest ? html`<${Badge} color="blue">최근</${Badge}>` : null}
                        <span class="small muted">${l.userName || ''}</span>
                        <span class="grow"></span>
                        ${t.canEdit ? html`<${Button} size="sm" variant="ghost" icon="rotate-ccw" onClick=${() => undo(l)}>완료 취소</${Button}>` : null}
                      </div>
                      ${l.note ? html`<div class="small text-2 mt-1 pre">${l.note}</div>` : null}
                    </div>
                  </li>`
                )}
              </ol>`
            : html`<${EmptyState} compact icon="history" title="아직 완료 기록이 없습니다" desc="일을 마치면 [완료 처리]를 눌러 기록해 주세요." />`}
        </div>`;

  return html`
    <${Modal}
      open=${!completing && !editing}
      size="lg"
      title=${t ? t.name : '법정 일정'}
      onClose=${close}
      footer=${t
        ? html`
            ${t.canEdit
              ? html`<${Menu} buttonVariant="secondary" size=${null} label="더 보기" items=${[
                  { label: t.active ? '보관하기' : '보관 해제', icon: 'archive', onClick: toggleArchive },
                  '-',
                  { label: '삭제', icon: 'trash-2', danger: true, onClick: remove },
                ]} />
                <${Button} icon="pencil" onClick=${() => setEditing(true)}>수정</${Button}>`
              : null}
            <span class="grow"></span>
            <${Button} onClick=${close}>닫기</${Button}>
            <${Button} variant="primary" icon="check" onClick=${() => setCompleting(true)}>완료 처리</${Button}>
          `
        : null}
    >
      ${body}
    </${Modal}>
    ${completing && t ? html`<${CompleteModal} task=${t} onClose=${() => setCompleting(false)} onSaved=${() => { setCompleting(false); changed(); }} />` : null}
    ${editing && t ? html`<${TaskEditor} task=${t} people=${people} onClose=${() => setEditing(false)} onSaved=${() => { setEditing(false); changed(); }} />` : null}
  `;
}

// ---------------- 목록 ----------------
export default function CompliancePage({ route }) {
  const q = route.query;
  const openId = route.parts[1];
  const [search, setSearch] = useState(q.q || '');
  const [creating, setCreating] = useState(false);
  const [completeFor, setCompleteFor] = useState(null);
  const people = usePeople();
  const isManager = can('manager');
  const { data, loading, error, reload } = useApi(
    `/facility/compliance/tasks${toQuery({ status: q.status || '', category: q.category || '', q: q.q || '', archived: q.archived || '' })}`
  );

  useEffect(() => {
    const t = setTimeout(() => {
      if ((q.q || '') !== search) setQuery({ q: search });
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const c = data && data.counts;
  const filtered = !!(q.status || q.category || q.q);
  const qs = toQuery({ status: q.status || '', category: q.category || '', q: q.q || '', archived: q.archived || '' });

  return html`
    <${PageHeader}
      title="법정 일정"
      desc="정기적으로 챙겨야 하는 검사·교육·점검. [완료]를 누르면 다음 일정이 자동으로 계산됩니다."
      actions=${isManager ? html`<${Button} variant="primary" icon="plus" onClick=${() => setCreating(true)}>일정 추가</${Button}>` : null}
    />
    <${Disclaimer} />
    ${c
      ? html`<div class="grid fx-stat-grid fx-mb">
          <${Stat} label="기한 지남" icon="circle-alert" value=${c.overdue} unit="건" color=${c.overdue ? 'danger' : undefined} href="#/compliance?status=overdue" hint=${c.overdue ? '가장 먼저 챙겨 주세요' : '지난 일정 없음'} />
          <${Stat} label="30일 안에 할 일" icon="calendar-clock" value=${c.soon} unit="건" color=${c.soon ? 'warning' : undefined} href="#/compliance?status=soon" />
          <${Stat} label="주기 확인 필요" icon="circle-help" value=${c.needsCheck} unit="건" href="#/compliance?status=check" hint="관할 기관에 확인할 항목" />
          <${Stat} label="전체 일정" icon="shield-check" value=${c.total} unit="건" href="#/compliance" hint=${c.noDate ? `다음 일정 미정 ${c.noDate}건` : undefined} />
        </div>`
      : null}
    <div class="row wrap fx-filters">
      <${Seg}
        label="상태로 보기"
        value=${q.status || ''}
        onChange=${(s) => setQuery({ status: s })}
        items=${[
          { value: '', label: '전체' },
          { value: 'overdue', label: '기한 지남' },
          { value: 'soon', label: '30일 이내' },
          { value: 'check', label: '주기 확인 필요' },
        ]}
      />
      <${Select}
        size="sm"
        aria-label="분류"
        value=${q.category || ''}
        onChange=${(e) => setQuery({ category: e.target.value })}
        placeholder="모든 분류"
        options=${CATEGORIES.map((x) => ({ value: x, label: c && c.byCategory[x] ? `${x} (${c.byCategory[x]})` : x }))}
        style=${{ width: '160px' }}
      />
      <${SearchInput} value=${search} onInput=${setSearch} placeholder="일정·근거 검색" style=${{ maxWidth: '240px' }} />
      ${isManager ? html`<${Checkbox} label="보관함" checked=${q.archived === '1'} onChange=${(x) => setQuery({ archived: x ? '1' : '' })} />` : null}
    </div>
    <${Card} flush>
      ${error && !data
        ? html`<${ErrorState} error=${error} onRetry=${reload} />`
        : loading && !data
          ? html`<${Loading} rows=${8} />`
          : !data.rows.length
            ? html`<${EmptyState}
                icon="shield-check"
                title=${filtered ? '조건에 맞는 일정이 없습니다' : q.archived === '1' ? '보관한 일정이 없습니다' : '등록된 법정 일정이 없습니다'}
                desc=${filtered ? (q.status === 'overdue' ? '기한 지난 일정이 없습니다. 잘 챙기고 계세요!' : '필터나 검색어를 바꿔 보세요.') : '방사선 검사, 소방 점검, 의무 교육 같은 정기 일정을 추가해 보세요.'}
                action=${filtered
                  ? html`<${Button} onClick=${() => { setSearch(''); setQuery({ status: '', category: '', q: '' }); }}>필터 지우기</${Button}>`
                  : isManager && q.archived !== '1'
                    ? html`<${Button} variant="primary" icon="plus" onClick=${() => setCreating(true)}>일정 추가</${Button}>`
                    : null}
              />`
            : html`<div class="list">
                ${data.rows.map(
                  (t) => html`<div
                    class=${cx('list-item fx-row-click', t.state === 'overdue' && 'fx-overdue', t.state === 'soon' && 'fx-soon')}
                    key=${t.id}
                    onClick=${() => navigate(`#/compliance/${t.id}${qs}`)}
                  >
                    <div class=${`icon-box ${tone(t)}`}><${Icon} name=${CAT_ICON[t.category] || 'clipboard-list'} size=${16} /></div>
                    <div class="grow">
                      <div class="row wrap" style=${{ gap: '6px' }}>
                        <a class="list-title fx-title-link" href=${`#/compliance/${t.id}${qs}`} onClick=${(e) => e.stopPropagation()}>${t.name}</a>
                        <${TaskBadges} t=${t} />
                      </div>
                      <div class="list-meta row wrap" style=${{ gap: '5px' }}>
                        <span>${t.category}</span><span>·</span><span>${t.cycleLabel}</span>
                        ${t.legalBasis ? html`<span>·</span><span class="ellipsis" style=${{ maxWidth: '320px' }}>${t.legalBasis}</span>` : null}
                        ${t.ownerName ? html`<span>·</span><span>담당 ${t.ownerName}</span>` : null}
                        <span>·</span><span>${t.lastDone ? `마지막 ${fmtDot(t.lastDone)}` : '완료 기록 없음'}</span>
                      </div>
                    </div>
                    <${DueBlock} t=${t} />
                    <div class="fx-task-actions" onClick=${(e) => e.stopPropagation()}>
                      <${Button} size="sm" variant=${t.state === 'overdue' || t.state === 'soon' ? 'primary' : 'soft'} icon="check" onClick=${() => setCompleteFor(t)} aria-label=${`${t.name} 완료 처리`}>완료</${Button}>
                    </div>
                  </div>`
                )}
              </div>`}
    </${Card}>
    ${openId ? html`<${TaskDetail} id=${openId} key=${openId} people=${people} onChanged=${reload} backHref=${'#/compliance' + qs} />` : null}
    ${creating ? html`<${TaskEditor} people=${people} onClose=${() => setCreating(false)} onSaved=${() => { setCreating(false); reload(); }} />` : null}
    ${completeFor ? html`<${CompleteModal} task=${completeFor} onClose=${() => setCompleteFor(null)} onSaved=${() => { setCompleteFor(null); reload(); }} />` : null}
  `;
}
