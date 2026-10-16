/*
 * 이 파일이 하는 일: [D. 인사·근무] 교육 이수 화면입니다. (#/training?tab=...)
 *
 *   탭  matrix   현황표: 직원 × 교육. 완료(다음 기한) / 임박(30일 이내) / 만료 / 미이수를 색으로 보여 줍니다.
 *                실장 이상은 칸을 누르면 그 직원·교육으로 이수 기록 창이 바로 열립니다.
 *       records  이수 기록: 언제 누가 어떤 교육을 받았는지 (교육·직원으로 찾기, 삭제)
 *       items    교육 항목: 분류·주기·대상·근거 메모. "주기 확인 필요" 표시가 있는 것은 법령·업종에 따라 달라 꼭 확인하세요.
 *   [이수 기록 추가] 창에서는 단체 교육처럼 여러 직원을 한 번에 기록할 수 있습니다.
 *   (법률 자문 아님 — 교육 대상·주기는 법령 개정과 사업장 규모에 따라 달라질 수 있습니다.)
 */
import { html, useState, useMemo, cx, todayStr, fmtDate, fmtDot, fmtNumber, toQuery } from '../lib.js';
import { api } from '../api.js';
import { setQuery } from '../router.js';
import { can, toast, confirmDialog } from '../store.js';
import {
  PageHeader, Card, Button, IconButton, Badge, Icon, Tabs, Seg, Modal, Field, Input, Textarea, Select, Checkbox, Callout,
  useApi, DataTable, Loading, ErrorState, EmptyState, Avatar,
} from '../ui/index.js';

const JOBS = ['원장', '실장', '치과위생사', '간호조무사', '치과기공사', '코디네이터', '기타'];
const CATEGORY_COLOR = { '법정 의무': 'blue', 직무: 'purple', 기타: 'gray' };
const STATUS = {
  done: { label: '완료', color: 'green' },
  soon: { label: '임박', color: 'amber' },
  expired: { label: '만료', color: 'red' },
  missing: { label: '미이수', color: 'red' },
};
const DISCLAIMER = '교육 대상·주기는 법령 개정, 업종, 사업장 규모에 따라 달라질 수 있습니다. "주기 확인 필요" 항목은 관할 기관이나 노무사에게 확인해 주세요. (법률 자문 아님)';

const shortDate = (s) => (s ? `${s.slice(2, 4)}.${s.slice(5, 7)}.${s.slice(8, 10)}` : '');
const cycleText = (t) => (t.cycleMonths ? (t.cycleMonths % 12 === 0 ? `${t.cycleMonths / 12}년마다` : `${t.cycleMonths}개월마다`) : '주기 없음');

/** 현황표 칸 하나의 모양 */
function StatusPill({ c }) {
  if (!c || c.status === 'na') return html`<span class="hr-tr-na" title="대상 아님">—</span>`;
  if (c.status === 'missing') return html`<span class="hr-tr missing">미이수</span>`;
  if (c.status === 'expired') return html`<span class="hr-tr expired">만료 ${-c.dday}일</span>`;
  if (c.status === 'soon') return html`<span class="hr-tr soon">${c.dday === 0 ? 'D-day' : `D-${c.dday}`}</span>`;
  return html`<span class="hr-tr done">${c.nextDue ? `~${shortDate(c.nextDue)}` : '완료'}</span>`;
}

// ---------------- 이수 기록 추가 ----------------
function RecordModal({ matrix, preset, onClose, onSaved }) {
  const trainings = matrix.trainings;
  const [trainingId, setTrainingId] = useState(preset?.trainingId || trainings[0]?.id || '');
  const [userIds, setUserIds] = useState(preset?.userId ? [preset.userId] : []);
  const [date, setDate] = useState(todayStr());
  const [hours, setHours] = useState('');
  const [provider, setProvider] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const tid = Number(trainingId);
  const t = trainings.find((x) => x.id === tid);
  const cellOf = (uid) => matrix.cells[uid]?.[tid];
  const toggle = (id) => setUserIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const pick = (fn) => setUserIds(matrix.staff.filter((s) => fn(cellOf(s.id))).map((s) => s.id));

  const save = async () => {
    if (!userIds.length) return toast.warn('이수한 직원을 한 명 이상 골라 주세요.');
    setBusy(true);
    try {
      const r = await api.post('/hr/training/records', {
        trainingId: tid,
        userIds,
        completedDate: date,
        hours: hours === '' ? undefined : Number(hours),
        provider: provider || undefined,
        memo: memo || undefined,
      });
      toast.success(`${t?.name || '교육'} 이수 기록 ${r.added}건을 저장했습니다.`);
      onSaved();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return html`<${Modal} open=${true} size="lg" title="이수 기록 추가" onClose=${onClose} busy=${busy}
    footer=${html`<span class="small muted grow">${userIds.length}명 선택</span><${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" icon="check" loading=${busy} onClick=${save}>저장</${Button}>`}>
    <div class="stack">
      <div class="hr-form-row two">
        <${Field} label="교육" required>
          <${Select} value=${trainingId} onChange=${(e) => setTrainingId(e.target.value)} options=${trainings.map((x) => ({ value: x.id, label: x.name }))} />
        </${Field}>
        <${Field} label="이수일" required>
          <${Input} type="date" value=${date} max=${todayStr()} onInput=${(e) => setDate(e.target.value)} />
        </${Field}>
      </div>
      ${t ? html`<div class="small muted">${t.category} · ${cycleText(t)} · 대상 ${t.requiredLabel}${t.needsCheck ? ' · 주기 확인 필요' : ''}</div>` : null}
      <div class="field">
        <div class="row between wrap">
          <span class="label">이수한 직원</span>
          <div class="row wrap" style=${{ gap: '4px' }}>
            <${Button} size="sm" variant="ghost" onClick=${() => pick((c) => c && c.required)}>대상자 전체</${Button}>
            <${Button} size="sm" variant="ghost" onClick=${() => pick((c) => c && c.required && c.status !== 'done')}>미이수·만료·임박만</${Button}>
            <${Button} size="sm" variant="ghost" onClick=${() => setUserIds([])}>모두 해제</${Button}>
          </div>
        </div>
        <div class="hr-pick-grid">
          ${matrix.staff.map((s) => {
            const c = cellOf(s.id);
            const on = userIds.includes(s.id);
            return html`<button type="button" class=${cx('hr-pick', on && 'on')} aria-pressed=${on ? 'true' : 'false'} onClick=${() => toggle(s.id)}>
              <span class=${cx('hr-pick-box', on && 'on')}>${on ? html`<${Icon} name="check" size=${12} />` : null}</span>
              <span class="grow" style=${{ minWidth: 0 }}>
                <span class="strong ellipsis" style=${{ display: 'block' }}>${s.name}</span>
                <span class="small muted">${s.jobTitle}</span>
              </span>
              <${StatusPill} c=${c} />
            </button>`;
          })}
        </div>
      </div>
      <div class="hr-form-row">
        <${Field} label="교육 시간">
          <${Input} type="number" min="0" max="200" step="0.5" value=${hours} placeholder="예: 1" onInput=${(e) => setHours(e.target.value)} />
        </${Field}>
        <${Field} label="교육 기관">
          <${Input} maxlength="60" value=${provider} placeholder="예: 원내 단체 교육" onInput=${(e) => setProvider(e.target.value)} />
        </${Field}>
        <${Field} label="메모">
          <${Input} maxlength="200" value=${memo} placeholder="예: 수료증 서식 보관함에 보관" onInput=${(e) => setMemo(e.target.value)} />
        </${Field}>
      </div>
    </div>
  </${Modal}>`;
}

// ---------------- 교육 항목 추가·수정 ----------------
function TrainingModal({ item, onClose, onSaved }) {
  const all = !item || item.requiredFor === 'all';
  const [v, setV] = useState({
    name: item?.name || '',
    category: item?.category || '법정 의무',
    cycleMonths: item?.cycleMonths ?? '',
    needsCheck: item?.needsCheck || false,
    allStaff: all,
    jobs: all ? [] : item.requiredFor.split(','),
    description: item?.description || '',
    legalNote: item?.legalNote || '',
    active: item ? item.active : true,
  });
  const [busy, setBusy] = useState(false);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const save = async () => {
    if (!v.name.trim()) return toast.warn('교육 이름을 넣어 주세요.');
    if (!v.allStaff && !v.jobs.length) return toast.warn('대상 직종을 하나 이상 고르거나 "전 직원"을 켜 주세요.');
    setBusy(true);
    const body = {
      name: v.name,
      category: v.category,
      cycleMonths: v.cycleMonths === '' ? null : Number(v.cycleMonths),
      needsCheck: v.needsCheck,
      requiredFor: v.allStaff ? 'all' : v.jobs.join(','),
      description: v.description || null,
      legalNote: v.legalNote || null,
      active: v.active,
    };
    try {
      if (item) await api.patch(`/hr/trainings/${item.id}`, body);
      else await api.post('/hr/trainings', body);
      toast.success(item ? '교육 항목을 고쳤습니다.' : '교육 항목을 추가했습니다.');
      onSaved();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<${Modal} open=${true} title=${item ? '교육 항목 고치기' : '교육 항목 추가'} onClose=${onClose} busy=${busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${busy} onClick=${save}>저장</${Button}>`}>
    <div class="stack">
      <${Field} label="교육 이름" required>
        <${Input} maxlength="60" value=${v.name} placeholder="예: 심폐소생술(CPR) 교육" onInput=${(e) => set('name', e.target.value)} />
      </${Field}>
      <div class="row wrap between">
        <${Seg} label="분류" value=${v.category} onChange=${(x) => set('category', x)} items=${['법정 의무', '직무', '기타'].map((x) => ({ value: x, label: x }))} />
        <${Checkbox} label="주기 확인 필요" checked=${v.needsCheck} onChange=${(c) => set('needsCheck', c)} />
      </div>
      <${Field} label="다시 받는 주기 (개월)" hint="비워 두면 주기 없음(한 번 이수하면 완료)으로 봅니다. 예: 매년 = 12">
        <${Input} type="number" min="1" max="120" value=${v.cycleMonths} placeholder="예: 12" onInput=${(e) => set('cycleMonths', e.target.value)} />
      </${Field}>
      <div class="field">
        <span class="label">대상</span>
        <${Checkbox} label="전 직원" checked=${v.allStaff} onChange=${(c) => set('allStaff', c)} />
        ${!v.allStaff
          ? html`<div class="row wrap mt-1">
              ${JOBS.map((j) => html`<button type="button" class=${cx('hr-brush', v.jobs.includes(j) && 'on')} aria-pressed=${v.jobs.includes(j) ? 'true' : 'false'}
                onClick=${() => set('jobs', v.jobs.includes(j) ? v.jobs.filter((x) => x !== j) : [...v.jobs, j])}>${j}</button>`)}
            </div>`
          : null}
      </div>
      <${Field} label="설명">
        <${Input} maxlength="300" value=${v.description} placeholder="예: 전 직원 대상, 연 1회" onInput=${(e) => set('description', e.target.value)} />
      </${Field}>
      <${Field} label="근거·참고 메모" hint="법령 이름이나 확인한 곳을 적어 두면 다음에 확인하기 쉽습니다.">
        <${Textarea} rows=${2} maxlength="300" value=${v.legalNote} onInput=${(e) => set('legalNote', e.target.value)} />
      </${Field}>
      ${item ? html`<${Checkbox} label="사용 중 (끄면 현황표에서 숨김, 기록은 보존)" checked=${v.active} onChange=${(c) => set('active', c)} />` : null}
    </div>
  </${Modal}>`;
}

// ---------------- 탭: 현황표 ----------------
function MatrixTab({ data, reload, query, onCell }) {
  const editable = can('manager');
  const filter = query.only || '';
  const cat = query.cat || '';
  const trainings = data.trainings.filter((t) => !cat || t.category === cat);
  const needs = (s) => trainings.some((t) => {
    const c = data.cells[s.id]?.[t.id];
    return c && c.required && c.status !== 'done';
  });
  const staff = filter === 'todo' ? data.staff.filter(needs) : data.staff;
  const T = data.totals;
  return html`
    <div class="stats hr-tr-stats">
      ${[
        ['done', '완료', 'circle-check', null],
        ['soon', `임박 (${data.soonDays}일 이내)`, 'hourglass', 'warning'],
        ['expired', '만료', 'circle-alert', 'danger'],
        ['missing', '미이수', 'circle-x', 'danger'],
      ].map(
        ([k, label, icon, color]) => html`<button type="button" class=${cx('stat hr-stat-btn', filter === 'todo' && k !== 'done' && 'on')} onClick=${() => setQuery({ only: k === 'done' ? '' : 'todo' })}>
          <div class="stat-label"><${Icon} name=${icon} size=${14} />${label}</div>
          <div class=${cx('stat-value', T[k] && color && `${color}-text`)}>${T[k]}<span class="stat-unit">칸</span></div>
        </button>`
      )}
    </div>
    <div class="row wrap between mt-4" style=${{ marginBottom: '10px' }}>
      <div class="row wrap">
        <${Seg} label="보기" value=${filter} onChange=${(x) => setQuery({ only: x })} items=${[{ value: '', label: '전체 직원' }, { value: 'todo', label: '챙길 사람만' }]} />
        <${Seg} label="분류" value=${cat} onChange=${(x) => setQuery({ cat: x })} items=${[{ value: '', label: '모든 교육' }, { value: '법정 의무', label: '법정 의무' }, { value: '직무', label: '직무' }, { value: '기타', label: '기타' }]} />
      </div>
      ${editable ? html`<span class="small muted">칸을 누르면 이수 기록을 바로 넣을 수 있습니다.</span>` : null}
    </div>
    <${Card} flush>
      ${!trainings.length
        ? html`<${EmptyState} icon="graduation-cap" title="교육 항목이 없습니다" desc="교육 항목 탭에서 추가해 주세요." />`
        : !staff.length
          ? html`<${EmptyState} icon="circle-check" title="챙길 사람이 없습니다" desc="모든 대상자가 기한 안에 이수했습니다." />`
          : html`<div class="table-wrap hr-tr-wrap">
              <table class="table hr-tr-table">
                <thead>
                  <tr>
                    <th class="hr-tr-name">직원</th>
                    ${trainings.map(
                      (t) => html`<th class="hr-tr-head" title=${[t.description, t.legalNote].filter(Boolean).join('\n')}>
                        <div class="hr-tr-title">${t.name}</div>
                        <div class="hr-tr-sub">${cycleText(t)}${t.requiredFor !== 'all' ? ` · ${t.requiredLabel}` : ''}</div>
                        ${t.needsCheck ? html`<${Badge} color="amber">주기 확인 필요</${Badge}>` : null}
                      </th>`
                    )}
                  </tr>
                </thead>
                <tbody>
                  ${staff.map(
                    (s) => html`<tr key=${s.id}>
                      <th class="hr-tr-name" scope="row">
                        <div class="row" style=${{ gap: '8px' }}>
                          <${Avatar} name=${s.name} color=${s.color} size="sm" />
                          <div style=${{ minWidth: 0 }}><div class="strong nowrap">${s.name}</div><div class="small muted nowrap">${s.jobTitle}</div></div>
                        </div>
                      </th>
                      ${trainings.map((t) => {
                        const c = data.cells[s.id]?.[t.id];
                        const title = c && c.status !== 'na' ? `${s.name} · ${t.name}\n${c.lastDate ? `마지막 이수 ${fmtDate(c.lastDate)}` : '이수 기록 없음'}${c.nextDue ? `\n다음 기한 ${fmtDate(c.nextDue)}` : ''}` : '대상 아님';
                        return html`<td class="hr-tr-cell">
                          ${editable && c && c.status !== 'na'
                            ? html`<button type="button" class="hr-tr-btn" title=${title} aria-label=${title} onClick=${() => onCell(s.id, t.id)}><${StatusPill} c=${c} /></button>`
                            : html`<span title=${title}><${StatusPill} c=${c} /></span>`}
                        </td>`;
                      })}
                    </tr>`
                  )}
                </tbody>
              </table>
            </div>`}
      <div class="hr-legend">
        <span class="hr-legend-item"><span class="hr-tr done">~27.04.30</span>완료 (다음 기한)</span>
        <span class="hr-legend-item"><span class="hr-tr soon">D-12</span>${data.soonDays}일 안에 기한</span>
        <span class="hr-legend-item"><span class="hr-tr expired">만료</span>기한 지남</span>
        <span class="hr-legend-item"><span class="hr-tr missing">미이수</span>기록 없음</span>
        <span class="hr-legend-item"><span class="hr-tr-na">—</span>대상 아님</span>
      </div>
    </${Card}>
    <p class="hr-disclaimer mt-3">${DISCLAIMER}</p>
  `;
}

// ---------------- 탭: 이수 기록 ----------------
function RecordsTab({ matrix, query, version, onChanged }) {
  const editable = can('manager');
  const trainingId = query.training || '';
  const userId = query.user || '';
  const { data, loading, error, reload } = useApi(`/hr/training/records${toQuery({ trainingId, userId, v: version })}`);
  const remove = async (r) => {
    if (!(await confirmDialog({ title: '이 이수 기록을 삭제할까요?', message: `${r.userName} · ${r.trainingName} · ${fmtDate(r.completedDate)}`, danger: true, confirmText: '삭제' }))) return;
    try {
      await api.del(`/hr/training/records/${r.id}`);
      toast.success('삭제했습니다.');
      reload();
      onChanged();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const cols = [
    { key: 'completedDate', label: '이수일', render: (r) => html`<span class="num nowrap">${fmtDot(r.completedDate)}</span>` },
    { key: 'trainingName', label: '교육', render: (r) => html`<span class="strong">${r.trainingName}</span>` },
    { key: 'userName', label: '직원' },
    { key: 'hours', label: '시간', align: 'right', render: (r) => (r.hours ? html`<span class="num">${fmtNumber(r.hours, 1)}시간</span>` : '') },
    { key: 'provider', label: '교육 기관', render: (r) => html`<span class="text-2">${r.provider || ''}</span>` },
    { key: 'memo', label: '메모', render: (r) => html`<span class="small muted">${r.memo || ''}</span>` },
    ...(editable ? [{ key: 'actions', label: '', class: 'actions', render: (r) => html`<${IconButton} icon="trash-2" size="sm" label="기록 삭제" onClick=${() => remove(r)} />` }] : []),
  ];
  return html`
    <div class="row wrap" style=${{ marginBottom: '12px' }}>
      <${Select} size="sm" value=${trainingId} placeholder="모든 교육" onChange=${(e) => setQuery({ training: e.target.value })} options=${matrix.trainings.map((t) => ({ value: t.id, label: t.name }))} aria-label="교육" style=${{ width: '220px' }} />
      <${Select} size="sm" value=${userId} placeholder="모든 직원" onChange=${(e) => setQuery({ user: e.target.value })} options=${matrix.staff.map((s) => ({ value: s.id, label: s.name }))} aria-label="직원" style=${{ width: '150px' }} />
      ${data ? html`<span class="small muted">${data.rows.length}건</span>` : null}
    </div>
    <${Card} flush>
      <${DataTable} columns=${cols} rows=${data?.rows} loading=${loading} error=${error} onRetry=${reload}
        empty=${{ icon: 'graduation-cap', title: trainingId || userId ? '조건에 맞는 기록이 없습니다' : '아직 이수 기록이 없습니다', desc: editable ? '오른쪽 위 [이수 기록 추가]로 단체 교육도 한 번에 기록할 수 있습니다.' : undefined }} />
    </${Card}>
  `;
}

// ---------------- 탭: 교육 항목 ----------------
function ItemsTab({ version, onChanged }) {
  const editable = can('manager');
  const { data, loading, error, reload } = useApi(`/hr/trainings?all=1&v=${version}`);
  const [editing, setEditing] = useState(null); // null | {} (새로) | item
  const remove = async (t) => {
    if (!(await confirmDialog({ title: `'${t.name}'을(를) 삭제할까요?`, message: '이수 기록이 있는 교육은 기록을 지키기 위해 "사용 안 함"으로만 바뀝니다.', danger: true, confirmText: '삭제' }))) return;
    try {
      const r = await api.del(`/hr/trainings/${t.id}`);
      toast.success(r.archived ? `기록 ${r.records}건이 있어 "사용 안 함"으로 바꿨습니다.` : '삭제했습니다.');
      reload();
      onChanged();
    } catch (e) {
      toast.error(e.message);
    }
  };
  return html`
    <${Callout} kind="warn">${DISCLAIMER}</${Callout}>
    <div class="row between mt-4" style=${{ marginBottom: '10px' }}>
      <span class="small muted">${data ? `${data.rows.filter((t) => t.active).length}개 사용 중` : ''}</span>
      ${editable ? html`<${Button} size="sm" icon="plus" onClick=${() => setEditing({})}>교육 항목 추가</${Button}>` : null}
    </div>
    <${Card} flush>
      ${error && !data
        ? html`<${ErrorState} error=${error} onRetry=${reload} />`
        : !data
          ? html`<${Loading} rows=${5} />`
          : !data.rows.length
            ? html`<${EmptyState} icon="graduation-cap" title="교육 항목이 없습니다" action=${editable ? html`<${Button} variant="primary" icon="plus" onClick=${() => setEditing({})}>교육 항목 추가</${Button}>` : null} />`
            : html`<div class="list">
                ${data.rows.map(
                  (t) => html`<div class=${cx('list-item hr-req', !t.active && 'muted-row')} key=${t.id}>
                    <div class=${`icon-box ${CATEGORY_COLOR[t.category] || ''}`}><${Icon} name="graduation-cap" size=${16} /></div>
                    <div class="grow">
                      <div class="row wrap" style=${{ gap: '6px' }}>
                        <span class="list-title">${t.name}</span>
                        <${Badge} color=${CATEGORY_COLOR[t.category]}>${t.category}</${Badge}>
                        <${Badge}>${cycleText(t)}</${Badge}>
                        ${t.needsCheck ? html`<${Badge} color="amber" dot>주기 확인 필요</${Badge}>` : null}
                        ${!t.active ? html`<${Badge}>사용 안 함</${Badge}>` : null}
                      </div>
                      <div class="list-meta">대상: ${t.requiredLabel}${t.description ? ` · ${t.description}` : ''} · 기록 ${t.recordCount}건</div>
                      ${t.legalNote ? html`<div class="small text-2 mt-1"><${Icon} name="book-open" size=${12} /> ${t.legalNote}</div>` : null}
                    </div>
                    ${editable
                      ? html`<div class="row hr-req-actions">
                          <${IconButton} icon="pencil" size="sm" label="고치기" onClick=${() => setEditing(t)} />
                          <${IconButton} icon="trash-2" size="sm" label="삭제" onClick=${() => remove(t)} />
                        </div>`
                      : null}
                  </div>`
                )}
              </div>`}
    </${Card}>
    ${editing ? html`<${TrainingModal} item=${editing.id ? editing : null} onClose=${() => setEditing(null)} onSaved=${() => { setEditing(null); reload(); onChanged(); }} />` : null}
  `;
}

// ---------------- 화면 ----------------
export default function TrainingPage({ route }) {
  const q = route.query;
  const tab = ['matrix', 'records', 'items'].includes(q.tab) ? q.tab : 'matrix';
  const editable = can('manager');
  const [version, setVersion] = useState(0);
  const matrix = useApi(`/hr/training/matrix?v=${version}`);
  const [recording, setRecording] = useState(null); // null | { trainingId?, userId? }
  const bump = () => setVersion((x) => x + 1);

  return html`
    <${PageHeader}
      title="교육 이수"
      desc="법정 의무교육과 직무 교육을 누가 언제 받았는지, 다음 기한은 언제인지 한눈에 봅니다."
      actions=${editable ? html`<${Button} variant="primary" icon="plus" disabled=${!matrix.data} onClick=${() => setRecording({})}>이수 기록 추가</${Button}>` : null}
    />
    <${Tabs}
      value=${tab}
      onChange=${(t) => setQuery({ tab: t === 'matrix' ? '' : t })}
      items=${[
        { value: 'matrix', label: '현황표', icon: 'layout-dashboard', count: matrix.data ? matrix.data.totals.expired + matrix.data.totals.soon : 0, countColor: 'red' },
        { value: 'records', label: '이수 기록', icon: 'history' },
        { value: 'items', label: '교육 항목', icon: 'graduation-cap' },
      ]}
    />
    ${tab === 'items'
      ? html`<${ItemsTab} version=${version} onChanged=${bump} />`
      : matrix.error && !matrix.data
        ? html`<${Card}><${ErrorState} error=${matrix.error} onRetry=${matrix.reload} /></${Card}>`
        : !matrix.data
          ? html`<${Card}><${Loading} rows=${6} /></${Card}>`
          : tab === 'records'
            ? html`<${RecordsTab} matrix=${matrix.data} query=${q} version=${version} onChanged=${bump} />`
            : html`<${MatrixTab} data=${matrix.data} reload=${matrix.reload} query=${q} onCell=${(userId, trainingId) => setRecording({ userId, trainingId })} />`}
    ${recording && matrix.data
      ? html`<${RecordModal} matrix=${matrix.data} preset=${recording} onClose=${() => setRecording(null)} onSaved=${() => { setRecording(null); bump(); }} />`
      : null}
  `;
}
