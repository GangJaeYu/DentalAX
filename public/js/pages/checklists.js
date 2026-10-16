/*
 * 이 파일이 하는 일: [A. 데스크] 오픈·마감 체크리스트 화면입니다.
 *
 *   #/checklists                 오늘 체크 (템플릿별 카드, 줄을 누르면 바로 체크 → 누가/언제 기록)
 *   #/checklists?date=2026-10-12 지난 날짜 기록 보기 (직원은 최근 7일까지 고칠 수 있음)
 *   #/checklists?tab=history     최근 30일 완료율 (템플릿 × 날짜 칸 색으로 한눈에)
 *   #/checklists?tab=templates   템플릿 관리 (실장 이상): 만들기·항목 추가·순서·AI 항목 추천
 */
import { html, useState, useEffect, useRef, fmtDate, fmtTime, fmtRelative, todayStr, addDays, cx } from '../lib.js';
import { api } from '../api.js';
import { setQuery } from '../router.js';
import { can, toast, confirmDialog } from '../store.js';
import {
  PageHeader, Card, Button, IconButton, Badge, Icon, Tabs, Seg, Modal, Field, Input, Textarea, Checkbox,
  useApi, useForm, Loading, ErrorState, EmptyState, Menu, Progress, Callout, Stat,
  PiiBanner, useAI, AiResult, AiButton,
} from '../ui/index.js';

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const TIMING = {
  open: { label: '오픈', icon: 'sun', color: 'amber', days: [1, 2, 3, 4, 5, 6] },
  close: { label: '마감', icon: 'moon', color: 'purple', days: [1, 2, 3, 4, 5, 6] },
  weekly: { label: '주간', icon: 'calendar-check', color: 'blue', days: [5] },
  custom: { label: '기타', icon: 'list-checks', color: 'green', days: [1, 2, 3, 4, 5] },
};
const timingOf = (t) => TIMING[t] || TIMING.custom;

// ======================= 오늘 체크 =======================

/** 체크 한 줄: 줄 전체가 큰 버튼(태블릿에서 손가락으로 누르기 쉽게), 오른쪽에 누가/언제 + 메모 버튼 */
function CheckRow({ item, card, date, editable, onUpdate }) {
  const [busy, setBusy] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(item.note || '');
  const inputRef = useRef();

  useEffect(() => setNote(item.note || ''), [item.note]);
  useEffect(() => {
    if (noteOpen && inputRef.current) inputRef.current.focus();
  }, [noteOpen]);

  const send = async (body) => {
    setBusy(true);
    try {
      const target = item.itemId ? { itemId: item.itemId } : { checkId: item.checkId };
      const updated = await api.post('/checklists/mark', { templateId: card.id, date, ...target, ...body });
      onUpdate(updated);
      return true;
    } catch (e) {
      toast.error(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = () => {
    if (!editable || busy) return;
    if (item.checked && !item.canUncheck) {
      return toast.warn(`${item.checkedByName || '다른 직원'}님이 체크한 항목입니다. 본인이나 실장님만 해제할 수 있습니다.`);
    }
    send({ checked: !item.checked });
  };

  const saveNote = async () => {
    const v = note.trim();
    if (v === (item.note || '')) return setNoteOpen(false);
    if (await send({ note: v })) {
      setNoteOpen(false);
      toast.success(v ? '메모를 남겼습니다.' : '메모를 지웠습니다.');
    }
  };

  return html`<li class=${cx('ck-row', item.checked && 'done', !editable && 'readonly')}>
    <div class="ck-row-main">
      <button
        type="button"
        class="ck-toggle"
        role="checkbox"
        aria-checked=${item.checked ? 'true' : 'false'}
        disabled=${!editable}
        aria-busy=${busy ? 'true' : undefined}
        onClick=${toggle}
      >
        <span class="ck-box" aria-hidden="true">${busy ? html`<span class="spinner"></span>` : item.checked ? html`<${Icon} name="check" size=${16} />` : null}</span>
        <span class="ck-text">
          <span class="ck-label">
            ${item.text}
            ${!item.required ? html`<${Badge} class="ck-opt">선택</${Badge}>` : null}
            ${item.removed ? html`<${Badge} color="amber">템플릿에서 삭제됨</${Badge}>` : null}
          </span>
          ${item.hint ? html`<span class="ck-hint">${item.hint}</span>` : null}
        </span>
      </button>
      <div class="ck-meta">
        ${item.checked
          ? html`<span class="ck-who" title=${`${item.checkedByName} · ${fmtTime(item.checkedAt)}`}>
              <span class="ck-who-name">${item.checkedByName}</span><span class="num">${fmtTime(item.checkedAt)}</span>
            </span>`
          : null}
        ${editable
          ? html`<${IconButton}
              icon="message-square-text"
              size="sm"
              label=${item.note ? '메모 고치기' : '메모 남기기'}
              class=${cx('ck-note-btn', item.note && 'has-note')}
              onClick=${() => setNoteOpen(!noteOpen)}
            />`
          : null}
      </div>
    </div>
    ${noteOpen
      ? html`<form class="ck-note-edit" onSubmit=${(e) => { e.preventDefault(); saveNote(); }}>
          <input
            class="input input-sm"
            ref=${inputRef}
            value=${note}
            maxlength="100"
            placeholder="예: 소독제 1통 남음 (환자 정보는 적지 마세요)"
            aria-label="항목 메모"
            onInput=${(e) => setNote(e.target.value)}
            onKeyDown=${(e) => e.key === 'Escape' && (setNote(item.note || ''), setNoteOpen(false))}
          />
          <${Button} size="sm" variant="primary" type="submit" loading=${busy}>저장</${Button}>
          ${item.note ? html`<${Button} size="sm" variant="ghost" onClick=${() => { setNote(''); send({ note: '' }).then((ok) => ok && setNoteOpen(false)); }}>지우기</${Button}>` : null}
        </form>`
      : item.note
        ? html`<div class="ck-note"><${Icon} name="message-square-text" size=${13} /><span>${item.note}</span>${item.noteByName ? html`<span class="muted"> · ${item.noteByName}</span>` : null}</div>`
        : null}
  </li>`;
}

function ChecklistCard({ card, date, onUpdate }) {
  const tm = timingOf(card.timing);
  const p = card.progress;
  const left = p.reqTotal - p.reqDone;
  return html`<section class=${cx('card ck-card', card.complete && 'complete')} aria-label=${card.name}>
    <div class="ck-card-head">
      <div class=${`icon-box ${tm.color}`}><${Icon} name=${tm.icon} size=${17} /></div>
      <div class="grow">
        <div class="ck-card-title">${card.name}</div>
        <div class="small muted">${tm.label} · ${card.weekdaysLabel}</div>
      </div>
      <div class="ck-count num" aria-label=${`${p.total}개 중 ${p.done}개 체크`}><strong>${p.done}</strong><span>/${p.total}</span></div>
    </div>
    <div class="ck-progress"><${Progress} value=${p.done} max=${p.total || 1} color=${card.complete ? 'green' : ''} label=${`${card.name} 진행률`} /></div>
    ${card.complete
      ? html`<div class="ck-stamp" role="status">
          <${Icon} name="badge-check" size=${18} />
          <span><strong>완료</strong> · ${card.completedByName || ''} · ${fmtTime(card.completedAt)}</span>
        </div>`
      : p.done > 0
        ? html`<div class="ck-left small">필수 항목 ${left}개 남음</div>`
        : null}
    ${card.items.length
      ? html`<ul class="ck-list">${card.items.map((it) => html`<${CheckRow} key=${it.key} item=${it} card=${card} date=${date} editable=${card.editable} onUpdate=${onUpdate} />`)}</ul>`
      : html`<${EmptyState} compact icon="list-checks" title="항목이 없습니다" desc=${can('manager') ? '템플릿 관리에서 항목을 추가하세요.' : '실장님께 항목 추가를 요청해 주세요.'} />`}
    ${card.description ? html`<div class="ck-card-foot small muted">${card.description}</div>` : null}
  </section>`;
}

function DateBar({ date, today, summary }) {
  const go = (d) => setQuery({ date: d === today ? '' : d });
  return html`<div class="ck-datebar">
    <div class="row ck-date-nav">
      <${IconButton} icon="chevron-left" label="전날" variant="secondary" onClick=${() => go(addDays(date, -1))} />
      <label class="ck-date-pick">
        <${Icon} name="calendar-days" size=${16} />
        <span class="strong">${fmtDate(date, { long: true })}</span>
        <input type="date" value=${date} max="2100-12-31" aria-label="날짜 고르기" onChange=${(e) => e.target.value && go(e.target.value)} />
      </label>
      <${IconButton} icon="chevron-right" label="다음 날" variant="secondary" onClick=${() => go(addDays(date, 1))} />
      ${date !== today ? html`<${Button} size="sm" variant="soft" icon="rotate-ccw" onClick=${() => go(today)}>오늘로</${Button}>` : html`<${Badge} color="blue">오늘</${Badge}>`}
    </div>
    ${summary}
  </div>`;
}

function CheckTab({ route }) {
  const today = todayStr();
  const date = route.query.date || today;
  const { data, loading, error, reload, setData } = useApi(`/checklists/day?date=${date}`);

  const onUpdate = (card) => setData((d) => ({ ...d, templates: d.templates.map((t) => (t.id === card.id ? card : t)) }));

  if (error && !data) return html`<${DateBar} date=${date} today=${today} /><${Card}><${ErrorState} error=${error} onRetry=${reload} /></${Card}>`;
  if (!data) return html`<${DateBar} date=${date} today=${today} /><div class="ck-grid">${[1, 2].map(() => html`<${Card}><${Loading} rows=${7} /></${Card}>`)}</div>`;

  const done = data.templates.filter((t) => t.complete).length;
  const summary = data.templates.length
    ? html`<div class=${cx('ck-summary', done === data.templates.length && 'all')}>
        ${done === data.templates.length ? html`<${Icon} name="circle-check" size=${16} />` : null}
        <span>${data.templates.length}개 중 <strong class="num">${done}</strong>개 완료</span>
      </div>`
    : null;
  const serverDate = data.date;

  return html`
    <${DateBar} date=${serverDate} today=${data.today} summary=${summary} />
    ${data.isFuture ? html`<${Callout} kind="info" class="ck-callout">미래 날짜는 항목만 미리 볼 수 있습니다. 체크는 그날 해 주세요.</${Callout}>` : null}
    ${!data.isFuture && !data.editable ? html`<${Callout} kind="warn" class="ck-callout">직원은 최근 7일 이내 기록만 고칠 수 있습니다. 빠진 기록은 실장님께 요청해 주세요.</${Callout}>` : null}
    ${!data.templates.length
      ? html`<${Card}>
          ${data.templateCount === 0
            ? html`<${EmptyState}
                icon="list-checks"
                title="아직 체크리스트가 없습니다"
                desc=${can('manager') ? '오픈·마감 체크리스트를 만들어 매일 점검을 기록해 보세요. AI가 항목 초안을 만들어 줍니다.' : '실장님이 체크리스트를 만들면 여기에 나타납니다.'}
                action=${can('manager') ? html`<${Button} variant="primary" icon="plus" onClick=${() => setQuery({ tab: 'templates', date: '' })}>체크리스트 만들기</${Button}>` : null}
              />`
            : html`<${EmptyState} icon="calendar-check" title=${`${fmtDate(serverDate)}에는 할 체크리스트가 없습니다`} desc="쉬는 날이거나 해당 요일이 아닌 점검표만 있습니다." />`}
        </${Card}>`
      : html`<div class="ck-grid">${data.templates.map((c) => html`<${ChecklistCard} key=${c.id} card=${c} date=${serverDate} onUpdate=${onUpdate} />`)}</div>`}
    ${data.notApplicable.length
      ? html`<p class="small muted ck-na"><${Icon} name="info" size=${13} /> 이날 해당 없음: ${data.notApplicable.map((t) => `${t.name}(${t.weekdaysLabel})`).join(', ')}</p>`
      : null}
  `;
}

// ======================= 기록 (최근 30일) =======================

function cellState(c, today) {
  if (!c.applicable) return 'na';
  if (c.complete) return 'complete';
  if (c.date === today) return c.done ? 'today-partial' : 'today';
  if (!c.hasRun || c.done === 0) return 'missed';
  return 'partial';
}
const CELL_LABEL = { na: '해당 없음', complete: '완료', partial: '덜 끝남', missed: '기록 없음', today: '오늘 · 진행 전', 'today-partial': '오늘 · 진행 중' };

function HistoryTab() {
  const { data, loading, error, reload } = useApi('/checklists/history?days=30');
  const wrapRef = useRef();
  // 좁은 화면에서는 표가 옆으로 넘치므로, 처음에 오늘(오른쪽 끝)이 보이도록 스크롤
  useEffect(() => {
    if (wrapRef.current) wrapRef.current.scrollLeft = wrapRef.current.scrollWidth;
  }, [data]);
  if (error && !data) return html`<${Card}><${ErrorState} error=${error} onRetry=${reload} /></${Card}>`;
  if (loading && !data) return html`<${Card}><${Loading} rows=${6} /></${Card}>`;
  if (!data.templates.length) return html`<${Card}><${EmptyState} icon="chart-column" title="아직 기록이 없습니다" desc="체크리스트를 만들고 체크하면 날짜별 완료율이 여기에 쌓입니다." /></${Card}>`;
  const today = data.to;
  const openDay = (d) => setQuery({ tab: '', date: d === todayStr() ? '' : d });

  return html`
    <div class="stats ck-stats">
      ${data.templates.filter((t) => t.active).map(
        (t) => html`<${Stat}
          label=${t.name}
          icon=${timingOf(t.timing).icon}
          value=${t.rate === null ? '-' : t.rate}
          unit=${t.rate === null ? '' : '%'}
          color=${t.rate !== null && t.rate < 80 ? 'warning' : undefined}
          hint=${t.applicableDays ? `해야 했던 ${t.applicableDays}일 중 ${t.completedDays}일 완료` : '아직 해당 날짜 없음'}
        />`
      )}
    </div>
    <${Card} title="최근 30일 완료 현황" icon="chart-column" sub=${`${fmtDate(data.from, { weekday: false })} ~ ${fmtDate(data.to, { weekday: false })}`} flush>
      <div class="table-wrap" ref=${wrapRef}>
        <table class="ck-heat">
          <thead>
            <tr>
              <th scope="col" class="ck-heat-name">체크리스트</th>
              ${data.days.map((d) => {
                const wd = new Date(d + 'T00:00:00').getDay();
                return html`<th scope="col" class=${cx('ck-heat-day', wd === 0 && 'sun', wd === 6 && 'sat', d === today && 'is-today')} title=${fmtDate(d)}>
                  <span>${Number(d.slice(8))}</span><span class="ck-wd">${WEEK[wd]}</span>
                </th>`;
              })}
              <th scope="col" class="ck-heat-rate">완료율</th>
            </tr>
          </thead>
          <tbody>
            ${data.templates.map(
              (t) => html`<tr>
                <th scope="row" class="ck-heat-name">
                  <div class="ellipsis strong">${t.name}</div>
                  <div class="small muted">${t.weekdaysLabel}${!t.active ? ' · 사용 중지' : ''}</div>
                </th>
                ${t.cells.map((c) => {
                  const st = cellState(c, today);
                  const label = `${fmtDate(c.date)} · ${CELL_LABEL[st]}${c.total ? ` (${c.done}/${c.total})` : ''}`;
                  return html`<td class="ck-heat-cell">
                    ${st === 'na'
                      ? html`<span class="ck-cell na" title=${label} aria-label=${label}></span>`
                      : html`<button type="button" class=${`ck-cell ${st}`} title=${label} aria-label=${label} onClick=${() => openDay(c.date)}
                          style=${st === 'partial' || st === 'today-partial' ? { '--fill': `${Math.round((c.done / (c.total || 1)) * 100)}%` } : null}></button>`}
                  </td>`;
                })}
                <td class="ck-heat-rate num">${t.rate === null ? html`<span class="muted">-</span>` : html`<strong class=${t.rate < 80 ? 'warning-text' : ''}>${t.rate}%</strong>`}</td>
              </tr>`
            )}
          </tbody>
        </table>
      </div>
      <div class="ck-legend small muted">
        <span><span class="ck-cell complete"></span>완료</span>
        <span><span class="ck-cell partial" style=${{ '--fill': '50%' }}></span>덜 끝남</span>
        <span><span class="ck-cell missed"></span>기록 없음</span>
        <span><span class="ck-cell na"></span>해당 없는 날</span>
        <span class="grow"></span>
        <span>칸을 누르면 그날 기록으로 이동합니다</span>
      </div>
    </${Card}>
    <div class="mt-4"></div>
    <${Card} title="최근 메모" icon="message-square-text" sub=${data.notes.length ? `${data.notes.length}건` : ''} flush>
      ${data.notes.length
        ? html`<div class="list">
            ${data.notes.map(
              (n) => html`<button type="button" class="list-item" onClick=${() => openDay(n.date)}>
                <div class="icon-box amber"><${Icon} name="message-square-text" size=${15} /></div>
                <div class="grow">
                  <div class="list-title">${n.note}</div>
                  <div class="list-meta">${fmtDate(n.date)} · ${n.templateName} · ${n.itemText}${n.byName ? ` · ${n.byName}` : ''}</div>
                </div>
                <${Icon} name="chevron-right" size=${16} class="muted" />
              </button>`
            )}
          </div>`
        : html`<${EmptyState} compact icon="message-square-text" title="최근 30일 메모가 없습니다" desc="체크 항목 옆 메모 버튼으로 '소독제 부족' 같은 내용을 남길 수 있습니다." />`}
    </${Card}>
  `;
}

// ======================= 템플릿 관리 (실장 이상) =======================

/** 두 항목이 거의 같은 말인지 (서버 checklists/ai.js 의 similar 와 같은 방법) — AI 추천에서 겹치는 항목 표시용 */
function similar(a, b) {
  const norm = (s) => String(s || '').replace(/[^가-힣A-Za-z0-9]/g, '');
  const grams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const gx = grams(x);
  const gy = grams(y);
  let same = 0;
  for (const g of gx) if (gy.has(g)) same++;
  return (2 * same) / (gx.size + gy.size) >= 0.6;
}

/** 요일 고르기 (여러 개) */
function WeekdayPicker({ value, onChange }) {
  const toggle = (d) => onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d].sort());
  return html`<div class="ck-days" role="group" aria-label="하는 요일">
    ${[1, 2, 3, 4, 5, 6, 0].map(
      (d) => html`<button type="button" aria-pressed=${value.includes(d) ? 'true' : 'false'} class=${cx(d === 0 && 'sun', d === 6 && 'sat')} onClick=${() => toggle(d)}>${WEEK[d]}</button>`
    )}
  </div>`;
}

function TemplateEditor({ template, onClose, onSaved }) {
  const isNew = !template;
  const f = useForm(
    template
      ? { name: template.name, timing: template.timing, weekdays: template.weekdays, description: template.description, active: template.active }
      : { name: '', timing: 'open', weekdays: TIMING.open.days, description: '', active: true, itemsText: '' }
  );
  const save = f.submit(async (v) => {
    const body = { name: v.name, timing: v.timing, weekdays: v.weekdays, description: v.description, active: v.active };
    if (isNew) {
      body.items = String(v.itemsText || '')
        .split('\n')
        .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
        .filter(Boolean)
        .map((text) => ({ text }));
    }
    const saved = isNew ? await api.post('/checklists/templates', body) : await api.patch(`/checklists/templates/${template.id}`, body);
    toast.success(isNew ? '체크리스트를 만들었습니다.' : '저장했습니다.');
    onSaved(saved);
  });
  return html`<${Modal}
    open=${true}
    title=${isNew ? '새 체크리스트' : '체크리스트 설정'}
    onClose=${onClose}
    busy=${f.busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${f.busy} onClick=${save}>${isNew ? '만들기' : '저장'}</${Button}>`}
  >
    <form class="stack" onSubmit=${save}>
      <${Field} label="이름" required error=${f.errors.name}>
        <${Input} ...${f.bind('name')} maxlength="60" placeholder="예: 오픈 체크, 마감 체크, 주간 점검" />
      </${Field}>
      <${Field} label="언제 하는 점검인가요?">
        <${Seg}
          label="시점"
          value=${f.values.timing}
          onChange=${(t) => {
            f.set('timing', t);
            if (isNew) f.set('weekdays', TIMING[t].days);
          }}
          items=${Object.entries(TIMING).map(([value, t]) => ({ value, label: t.label }))}
        />
      </${Field}>
      <${Field} label="하는 요일" error=${f.errors.weekdays} hint="선택한 요일에만 오늘 체크 화면과 대시보드에 나타납니다.">
        <${WeekdayPicker} value=${f.values.weekdays} onChange=${(d) => f.set('weekdays', d)} />
      </${Field}>
      <${Field} label="설명 (선택)" error=${f.errors.description}>
        <${Input} ...${f.bind('description')} maxlength="300" placeholder="예: 첫 진료 시작 전에 확인합니다." />
      </${Field}>
      ${isNew
        ? html`<${Field} label="처음 넣을 항목 (선택)" hint="한 줄에 하나씩. 나중에 추가하거나 AI 추천으로 채워도 됩니다.">
            <${Textarea} ...${f.bind('itemsText')} rows=${5} placeholder=${'컴프레서·석션 전원 켜기\n유니트체어 수관 플러싱 2분\n진료실 표면 소독'} />
          </${Field}>`
        : html`<${Checkbox} label="사용 중 (끄면 오늘 체크 화면에 나오지 않고, 지난 기록은 남습니다)" ...${f.bind('active', { type: 'checkbox' })} />`}
    </form>
  </${Modal}>`;
}

/** AI 항목 추천 창: 설명 → 추천 목록 → 골라서 템플릿에 추가 */
function SuggestModal({ template, onClose, onAdded }) {
  const ai = useAI('checklists.suggest');
  const [desc, setDesc] = useState(`${template.name}${template.description ? ` — ${template.description}` : ''}`);
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const existing = template.items.map((i) => i.text.trim());
  const isDup = (text) => existing.some((e) => similar(e, text));
  const items = (ai.result && ai.result.data && ai.result.data.items) || [];

  useEffect(() => {
    // 새 추천이 오면 이미 있는 항목만 빼고 모두 선택
    setPicked(new Set(items.map((_, i) => i).filter((i) => !isDup(items[i].text))));
  }, [ai.result]);

  const run = () => {
    if (desc.trim().length < 2) return toast.warn('어떤 체크리스트인지 짧게 설명해 주세요.');
    ai.run({ description: desc.trim(), timing: template.timing, existing: existing.slice(0, 60) });
  };
  const toggle = (i) => setPicked((s) => {
    const n = new Set(s);
    n.has(i) ? n.delete(i) : n.add(i);
    return n;
  });
  const add = async () => {
    const chosen = items.filter((_, i) => picked.has(i)).map((it) => ({ text: it.text, hint: it.hint || '' }));
    if (!chosen.length) return toast.warn('추가할 항목을 골라 주세요.');
    setBusy(true);
    try {
      const saved = await api.post(`/checklists/templates/${template.id}/items`, { items: chosen });
      toast.success(`${chosen.length}개 항목을 추가했습니다.`);
      onAdded(saved);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return html`<${Modal}
    open=${true}
    size="lg"
    title=${`AI 항목 추천 · ${template.name}`}
    onClose=${onClose}
    busy=${busy}
    footer=${html`<${Button} onClick=${onClose}>닫기</${Button}>
      ${items.length ? html`<${Button} variant="primary" icon="plus" loading=${busy} disabled=${!picked.size} onClick=${add}>선택한 ${picked.size}개 추가</${Button}>` : null}`}
  >
    <div class="stack">
      <${PiiBanner} />
      <${Field} label="어떤 체크리스트인가요?" hint="병원 특징을 함께 적으면 더 알맞게 추천합니다. 예: 소아 환자가 많은 치과의 마감 체크, 임플란트 수술이 많은 날 오픈 체크">
        <${Textarea} rows=${2} value=${desc} maxlength="500" onInput=${(e) => setDesc(e.target.value)} />
      </${Field}>
      <div class="row">
        <${AiButton} onClick=${run} loading=${ai.busy}>${items.length ? '다시 추천받기' : '항목 추천받기'}</${AiButton}>
        <span class="small muted">8~15개를 추천합니다. 필요한 것만 골라 넣으세요.</span>
      </div>
      ${ai.busy || ai.error ? html`<${AiResult} ai=${ai} />` : null}
      ${!ai.busy && ai.result
        ? items.length
          ? html`<div class="ck-suggest">
              <div class="row between ck-suggest-head">
                <div class="row small">
                  ${ai.result.demo ? html`<${Badge} color="amber">데모 예시</${Badge}>` : html`<${Badge} color="purple">AI 추천</${Badge}>`}
                  <span class="muted">${items.length}개 중 ${picked.size}개 선택</span>
                </div>
                <div class="row">
                  <${Button} size="sm" variant="ghost" onClick=${() => setPicked(new Set(items.map((_, i) => i)))}>모두 선택</${Button}>
                  <${Button} size="sm" variant="ghost" onClick=${() => setPicked(new Set())}>모두 해제</${Button}>
                </div>
              </div>
              ${ai.result.pii && ai.result.pii.message ? html`<${Callout} kind="warn" icon="shield-check">${ai.result.pii.message}</${Callout}>` : null}
              <ul class="ck-suggest-list">
                ${items.map(
                  (it, i) => html`<li>
                    <label class=${cx('ck-suggest-item', picked.has(i) && 'on')}>
                      <input type="checkbox" checked=${picked.has(i)} onChange=${() => toggle(i)} />
                      <span class="grow">
                        <span class="strong">${it.text}</span>
                        ${isDup(it.text) ? html` <${Badge} color="amber">비슷한 항목 있음</${Badge}>` : null}
                        ${it.hint ? html`<span class="ck-hint">${it.hint}</span>` : null}
                      </span>
                    </label>
                  </li>`
                )}
              </ul>
              <p class="small muted">AI 추천은 참고용입니다. 우리 병원 실제 순서·장비에 맞는지 확인하고 넣어 주세요.</p>
            </div>`
          : html`<${Callout} kind="warn">추천 항목을 읽지 못했습니다. [다시 추천받기]를 눌러 주세요.</${Callout}>`
        : null}
    </div>
  </${Modal}>`;
}

/** 템플릿 항목 한 줄 (순서 바꾸기·고치기·지우기) */
function ItemRow({ item, index, count, onMove, onSave, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [vals, setVals] = useState({ text: item.text, hint: item.hint, required: item.required });
  const [busy, setBusy] = useState(false);
  useEffect(() => setVals({ text: item.text, hint: item.hint, required: item.required }), [item.text, item.hint, item.required]);
  const save = async (e) => {
    e && e.preventDefault();
    if (!vals.text.trim()) return toast.warn('항목 내용을 입력해 주세요.');
    setBusy(true);
    const ok = await onSave(item, vals);
    setBusy(false);
    if (ok) setEditing(false);
  };
  if (editing) {
    return html`<li class="ck-item editing">
      <form class="ck-item-form" onSubmit=${save}>
        <${Input} value=${vals.text} maxlength="120" aria-label="항목 내용" onInput=${(e) => setVals({ ...vals, text: e.target.value })} />
        <${Input} size="sm" value=${vals.hint} maxlength="200" placeholder="도움말 (선택) 예: 압력 게이지 초록 범위 확인" aria-label="도움말" onInput=${(e) => setVals({ ...vals, hint: e.target.value })} />
        <div class="row wrap">
          <${Checkbox} label="필수 항목 (완료 판단에 포함)" checked=${vals.required} onChange=${(c) => setVals({ ...vals, required: c })} />
          <span class="grow"></span>
          <${Button} size="sm" onClick=${() => setEditing(false)}>취소</${Button}>
          <${Button} size="sm" variant="primary" type="submit" loading=${busy}>저장</${Button}>
        </div>
      </form>
    </li>`;
  }
  return html`<li class="ck-item">
    <span class="ck-item-no num">${index + 1}</span>
    <div class="grow">
      <div class="ck-item-text">${item.text}${!item.required ? html` <${Badge} class="ck-opt">선택</${Badge}>` : null}</div>
      ${item.hint ? html`<div class="ck-hint">${item.hint}</div>` : null}
    </div>
    <div class="ck-item-actions">
      <${IconButton} icon="chevron-up" size="sm" label="위로" disabled=${index === 0} onClick=${() => onMove(index, -1)} />
      <${IconButton} icon="chevron-down" size="sm" label="아래로" disabled=${index === count - 1} onClick=${() => onMove(index, 1)} />
      <${IconButton} icon="pencil" size="sm" label="고치기" onClick=${() => setEditing(true)} />
      <${IconButton} icon="trash-2" size="sm" label="삭제" onClick=${() => onDelete(item)} />
    </div>
  </li>`;
}

function TemplateCard({ t, onChange, onRemoved, onEdit, onSuggest }) {
  const tm = timingOf(t.timing);
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);

  const call = async (fn, msg) => {
    try {
      const saved = await fn();
      onChange(saved);
      if (msg) toast.success(msg);
      return true;
    } catch (e) {
      toast.error(e.message);
      return false;
    }
  };
  const addItem = async (e) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    setAdding(true);
    const ok = await call(() => api.post(`/checklists/templates/${t.id}/items`, { items: [{ text: v }] }));
    setAdding(false);
    if (ok) setText('');
  };
  const move = (i, dir) => {
    const ids = t.items.map((x) => x.id);
    const j = i + dir;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    // 화면 먼저 바꾸고(빠른 반응) 서버에 저장
    onChange({ ...t, items: ids.map((id) => t.items.find((x) => x.id === id)) });
    call(() => api.put(`/checklists/templates/${t.id}/order`, { itemIds: ids }));
  };
  const saveItem = (item, vals) => call(() => api.patch(`/checklists/items/${item.id}`, vals), '항목을 고쳤습니다.');
  const deleteItem = async (item) => {
    if (!(await confirmDialog({ title: '이 항목을 삭제할까요?', message: `"${item.text}"\n\n지난 날짜의 체크 기록은 그대로 남습니다.`, danger: true, confirmText: '삭제' }))) return;
    call(() => api.del(`/checklists/items/${item.id}`), '항목을 삭제했습니다.');
  };
  const toggleActive = () => call(() => api.patch(`/checklists/templates/${t.id}`, { active: !t.active }), t.active ? '사용을 중지했습니다.' : '다시 사용합니다.');
  const remove = async () => {
    if (!(await confirmDialog({
      title: `"${t.name}"을(를) 삭제할까요?`,
      message: '이 체크리스트의 지난 수행 기록도 모두 함께 삭제되며 되돌릴 수 없습니다.\n기록을 남기려면 삭제 대신 [사용 중지]를 고르세요.',
      danger: true,
      confirmText: '삭제',
      typeToConfirm: t.name,
    }))) return;
    try {
      await api.del(`/checklists/templates/${t.id}`);
      toast.success('삭제했습니다.');
      onRemoved(t.id);
    } catch (e) {
      toast.error(e.message);
    }
  };

  return html`<section class=${cx('card ck-tpl', !t.active && 'inactive')} aria-label=${t.name}>
    <div class="card-header">
      <div class="row grow">
        <div class=${`icon-box ${tm.color}`}><${Icon} name=${tm.icon} size=${16} /></div>
        <div class="grow">
          <div class="card-title">${t.name}${!t.active ? html`<${Badge}>사용 중지</${Badge}>` : null}</div>
          <div class="small muted">${tm.label} · ${t.weekdaysLabel} · 항목 ${t.items.length}개</div>
        </div>
      </div>
      <div class="row">
        <${AiButton} size="sm" onClick=${() => onSuggest(t)}>AI 항목 추천</${AiButton}>
        <${Menu} items=${[
          { label: '이름·요일 설정', icon: 'settings', onClick: () => onEdit(t) },
          { label: t.active ? '사용 중지' : '다시 사용', icon: t.active ? 'archive' : 'rotate-ccw', onClick: toggleActive },
          '-',
          { label: '삭제', icon: 'trash-2', danger: true, onClick: remove },
        ]} />
      </div>
    </div>
    ${t.items.length
      ? html`<ol class="ck-items">${t.items.map((it, i) => html`<${ItemRow} key=${it.id} item=${it} index=${i} count=${t.items.length} onMove=${move} onSave=${saveItem} onDelete=${deleteItem} />`)}</ol>`
      : html`<${EmptyState} compact icon="list-checks" title="항목이 없습니다" desc="아래에 직접 입력하거나 [AI 항목 추천]으로 채워 보세요." />`}
    <form class="ck-add" onSubmit=${addItem}>
      <${Icon} name="plus" size=${16} class="muted" />
      <input class="ck-add-input" value=${text} maxlength="120" placeholder="새 항목 입력 후 Enter" aria-label=${`${t.name}에 항목 추가`} onInput=${(e) => setText(e.target.value)} />
      ${text.trim() ? html`<${Button} size="sm" variant="primary" type="submit" loading=${adding}>추가</${Button}>` : null}
    </form>
  </section>`;
}

function TemplatesTab() {
  const { data, loading, error, reload, setData } = useApi('/checklists/templates');
  const [editing, setEditing] = useState(null); // null | 'new' | template
  const [suggest, setSuggest] = useState(null);

  const replace = (saved) => setData((d) => ({ ...d, rows: d.rows.some((x) => x.id === saved.id) ? d.rows.map((x) => (x.id === saved.id ? saved : x)) : [...d.rows, saved] }));
  const header = html`<div class="row between ck-tpl-bar">
    <p class="small muted">항목 순서는 실제로 하는 순서대로 맞춰 두면 좋습니다. 바꾼 내용은 오늘 체크부터 반영되고, 지난 기록은 그대로 남습니다.</p>
    <${Button} variant="primary" icon="plus" onClick=${() => setEditing('new')}>새 체크리스트</${Button}>
  </div>`;

  let body;
  if (error && !data) body = html`<${Card}><${ErrorState} error=${error} onRetry=${reload} /></${Card}>`;
  else if (loading && !data) body = html`<${Card}><${Loading} rows=${6} /></${Card}>`;
  else if (!data.rows.length)
    body = html`<${Card}><${EmptyState} icon="list-checks" title="체크리스트가 없습니다" desc="오픈 체크·마감 체크처럼 매일 반복하는 점검표를 만들어 보세요." action=${html`<${Button} variant="primary" icon="plus" onClick=${() => setEditing('new')}>새 체크리스트</${Button}>`} /></${Card}>`;
  else
    body = html`<div class="ck-tpl-grid">
      ${data.rows.map((t) => html`<${TemplateCard} key=${t.id} t=${t} onChange=${replace} onRemoved=${(id) => setData((d) => ({ ...d, rows: d.rows.filter((x) => x.id !== id) }))} onEdit=${setEditing} onSuggest=${setSuggest} />`)}
    </div>`;

  return html`
    ${header}
    ${body}
    ${editing
      ? html`<${TemplateEditor}
          template=${editing === 'new' ? null : editing}
          onClose=${() => setEditing(null)}
          onSaved=${(saved) => {
            const wasNew = editing === 'new';
            setEditing(null);
            replace(saved);
            if (wasNew && !saved.items.length) setSuggest(saved);
          }}
        />`
      : null}
    ${suggest
      ? html`<${SuggestModal}
          template=${suggest}
          onClose=${() => setSuggest(null)}
          onAdded=${(saved) => {
            replace(saved);
            setSuggest(null);
          }}
        />`
      : null}
  `;
}

// ======================= 화면 =======================
export default function ChecklistsPage({ route }) {
  const isManager = can('manager');
  const tab = route.query.tab === 'history' ? 'history' : route.query.tab === 'templates' && isManager ? 'templates' : 'check';
  return html`
    <${PageHeader} title="오픈·마감 체크" desc="줄을 누르면 체크됩니다. 누가 언제 했는지 자동으로 남고, 필수 항목을 다 하면 완료 도장이 찍힙니다." />
    <${Tabs}
      value=${tab}
      onChange=${(t) => setQuery({ tab: t === 'check' ? '' : t })}
      items=${[
        { value: 'check', label: '체크하기', icon: 'list-checks' },
        { value: 'history', label: '기록', icon: 'chart-column' },
        isManager && { value: 'templates', label: '템플릿 관리', icon: 'settings' },
      ].filter(Boolean)}
    />
    ${tab === 'check' ? html`<${CheckTab} route=${route} />` : tab === 'history' ? html`<${HistoryTab} />` : html`<${TemplatesTab} />`}
  `;
}
