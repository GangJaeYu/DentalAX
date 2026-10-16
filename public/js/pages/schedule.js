/*
 * 이 파일이 하는 일: [D. 인사·근무] 월간 근무표 화면입니다. (#/schedule?month=2026-10)
 *
 *   - 줄 = 재직 중인 직원(원장 포함), 칸 = 날짜. 이름 칸은 가로로 넘겨도 왼쪽에 붙어 있습니다(태블릿 대응).
 *   - 실장 이상: 칸을 누르면 근무 유형을 고르는 작은 창이 뜹니다. 위쪽 "빠른 입력"에서 유형을 먼저 고르면 누르는 칸마다 바로 들어갑니다.
 *     키보드: 방향키로 칸 이동, 숫자 1~9 로 유형 입력, Delete 로 지우기, Enter 로 고르기 창.
 *   - 승인된 연차·반차는 칸에 자동으로 표시됩니다(승인 대기는 점선). 근무표 자체를 고치지 않아도 됩니다.
 *   - 직원별 합계(근무일·시간)는 이름 아래, 날짜별 근무 인원은 맨 아래 줄에 나옵니다.
 *   - 도우미: 전월 같은 요일 패턴 복사 / 한 주 패턴 반복, 줄마다 "평일 기본 채우기"
 *   - 인쇄: A4 가로로 한 장에 들어가게 출력합니다.
 */
import { html, useState, useEffect, useMemo, useRef, cx, todayStr, fmtDate, fmtNumber, addDays, parseDate } from '../lib.js';
import { api } from '../api.js';
import { setQuery } from '../router.js';
import { can, toast, confirmDialog, session } from '../store.js';
import {
  PageHeader, Card, Button, IconButton, Badge, Icon, Seg, Modal, Field, Input, Select, Checkbox, Callout,
  useApi, Loading, ErrorState, EmptyState, Menu, PrintDoc, printNow,
} from '../ui/index.js';

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

// ---------- 날짜 도우미 ----------
export function addMonthYm(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${y}년 ${m}월`;
}
const md = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
const fmtHours = (h) => `${fmtNumber(h, 1)}시간`;

/** 월 이동 (이전 달 · 이번 달 · 다음 달) — 근무표와 연차 달력이 함께 씀 */
export function MonthNav({ month, onChange }) {
  const cur = todayStr().slice(0, 7);
  return html`<div class="hr-monthnav" role="group" aria-label="달 선택">
    <${IconButton} icon="chevron-left" label="이전 달" onClick=${() => onChange(addMonthYm(month, -1))} />
    <span class="hr-monthnav-label num">${monthLabel(month)}</span>
    <${IconButton} icon="chevron-right" label="다음 달" onClick=${() => onChange(addMonthYm(month, 1))} />
    ${month !== cur ? html`<${Button} size="sm" variant="ghost" onClick=${() => onChange(cur)}>이번 달</${Button}>` : null}
  </div>`;
}

/** 근무 유형 색으로 연하게 칠한 배경 (다크 모드에서도 자연스럽게 섞임) */
const tint = (color, pct = 18) => ({ background: `color-mix(in srgb, ${color || '#64748b'} ${pct}%, transparent)` });

/** 직원별 합계와 날짜별 근무 인원 계산 (승인된 하루 휴가는 근무에서 빼고, 반차는 시간을 절반으로) */
function computeTotals(data) {
  const types = Object.fromEntries(data.shiftTypes.map((t) => [t.id, t]));
  const perUser = {};
  const perDay = {};
  for (const s of data.staff) {
    let days = 0;
    let hours = 0;
    let leave = 0;
    for (const d of data.days) {
      const e = data.entries[s.id]?.[d.date];
      const l = leaveOn(data, s.id, d);
      const approved = l && l.status === 'approved';
      if (approved && !l.half) {
        leave += 1;
        continue;
      }
      if (approved && l.half) leave += 0.5;
      const t = e && types[e.shiftTypeId];
      if (!t || t.isOff) continue;
      days++;
      hours += approved && l.half ? t.hours / 2 : t.hours;
      perDay[d.date] = (perDay[d.date] || 0) + 1;
    }
    perUser[s.id] = { days, hours, leave };
  }
  return { perUser, perDay };
}

/** 그날의 휴가 (휴진일·공휴일은 휴가 일수에 안 들어가므로 표시하지 않음) */
function leaveOn(data, userId, day) {
  if (day.closed || day.holiday) return null;
  return data.leaves[userId]?.[day.date] || null;
}

// ---------------- 근무 고르기 작은 창 ----------------
function Picker({ at, types, current, onPick, onClose }) {
  const ref = useRef();
  useEffect(() => {
    setTimeout(() => ref.current?.querySelector('button')?.focus(), 10);
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && onClose();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose(true);
      }
      const n = Number(e.key);
      if (n >= 1 && n <= types.length) {
        e.preventDefault();
        onPick(types[n - 1].id);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, []);
  const h = 58 + types.length * 40 + 44;
  const top = at.rect.bottom + h + 8 > window.innerHeight ? Math.max(8, at.rect.top - h - 4) : at.rect.bottom + 4;
  const left = Math.min(Math.max(8, at.rect.left - 90), window.innerWidth - 268);
  return html`<div class="hr-picker" ref=${ref} role="dialog" aria-label="근무 고르기" style=${{ top: top + 'px', left: left + 'px' }}>
    <div class="hr-picker-head">
      <strong>${at.name}</strong><span class="muted">${fmtDate(at.date)}</span>
    </div>
    ${at.leave ? html`<div class="hr-picker-leave"><${Icon} name="calendar-check" size=${13} />${at.leave.status === 'approved' ? '승인된' : '승인 대기'} ${at.leave.type}</div>` : null}
    <div class="hr-picker-list">
      ${types.map(
        (t, i) => html`<button type="button" class=${cx('hr-picker-item', current === t.id && 'on')} onClick=${() => onPick(t.id)}>
          <span class="hr-chip" style=${{ ...tint(t.color, 22), color: 'var(--text)' }}>${t.code}</span>
          <span class="grow">${t.name}${t.startTime ? html`<span class="muted small"> ${t.startTime}~${t.endTime}</span>` : null}</span>
          <span class="kbd">${i + 1}</span>
        </button>`
      )}
    </div>
    <button type="button" class="hr-picker-item clear" onClick=${() => onPick(null)} disabled=${!current}>
      <${Icon} name="x" size=${14} /><span class="grow">비우기</span><span class="kbd">Del</span>
    </button>
  </div>`;
}

// ---------------- 근무 유형 관리 ----------------
function ShiftTypesModal({ onClose, onChanged }) {
  const { data, loading, error, reload } = useApi('/hr/shift-types');
  const blank = { id: null, code: '', name: '', startTime: '', endTime: '', hours: '', color: '#2f6fed', isOff: false };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // 시작·끝 시각을 넣으면 근무 시간을 자동으로 계산 (점심 1시간은 직접 빼 주세요)
  const autoHours = (st, en) => {
    if (!/^\d\d:\d\d$/.test(st || '') || !/^\d\d:\d\d$/.test(en || '')) return null;
    const m = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    const diff = (m(en) - m(st)) / 60;
    return diff > 0 ? Math.round(diff * 2) / 2 : null;
  };

  const save = async (e) => {
    e && e.preventDefault();
    setBusy(true);
    try {
      const body = { ...form, hours: form.hours === '' ? 0 : Number(form.hours), startTime: form.startTime || null, endTime: form.endTime || null };
      if (form.id) await api.patch(`/hr/shift-types/${form.id}`, body);
      else await api.post('/hr/shift-types', body);
      toast.success(form.id ? '근무 유형을 고쳤습니다.' : '근무 유형을 추가했습니다.');
      setForm(blank);
      reload();
      onChanged();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (t) => {
    if (!(await confirmDialog({ title: `'${t.name}' 유형을 삭제할까요?`, message: '이미 근무표에 쓰인 유형은 지난 근무표가 사라지지 않도록 목록에서만 숨깁니다.', danger: true, confirmText: '삭제' }))) return;
    try {
      const r = await api.del(`/hr/shift-types/${t.id}`);
      toast.success(r.archived ? '근무표에 쓰인 유형이라 목록에서 숨겼습니다.' : '삭제했습니다.');
      reload();
      onChanged();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return html`<${Modal} open=${true} size="lg" title="근무 유형 관리" onClose=${onClose}>
    <div class="stack">
      ${error ? html`<${ErrorState} error=${error} onRetry=${reload} compact />` : loading && !data ? html`<${Loading} rows=${4} />` : html`
        <div class="list hr-bordered">
          ${data.map(
            (t, i) => html`<div class="list-item" key=${t.id}>
              <span class="hr-chip lg" style=${tint(t.color, 22)}>${t.code}</span>
              <div class="grow">
                <div class="list-title">${t.name} ${t.isOff ? html`<${Badge}>쉬는 날</${Badge}>` : null}</div>
                <div class="list-meta">${t.startTime ? `${t.startTime} ~ ${t.endTime}` : '시간 없음'}${!t.isOff ? ` · ${fmtHours(t.hours)}` : ''} · 단축키 ${i + 1}</div>
              </div>
              <${IconButton} icon="pencil" label="고치기" size="sm" onClick=${() => setForm({ ...t, startTime: t.startTime || '', endTime: t.endTime || '', hours: t.hours })} />
              <${IconButton} icon="trash-2" label="삭제" size="sm" onClick=${() => remove(t)} />
            </div>`
          )}
        </div>`}
      <form class="hr-subform stack sm" onSubmit=${save}>
        <div class="small strong text-2">${form.id ? `'${form.name}' 고치기` : '새 근무 유형 추가'}</div>
        <div class="hr-form-row">
          <${Field} label="짧은 이름" required hint="칸에 보이는 글자 (4자까지)">
            <${Input} value=${form.code} maxlength="4" placeholder="예: 단축" onInput=${(e) => set('code', e.target.value)} />
          </${Field}>
          <${Field} label="전체 이름" required>
            <${Input} value=${form.name} maxlength="30" placeholder="예: 단축 근무" onInput=${(e) => set('name', e.target.value)} />
          </${Field}>
          <${Field} label="색">
            <input type="color" class="hr-color" value=${form.color} onInput=${(e) => set('color', e.target.value)} aria-label="색 고르기" />
          </${Field}>
        </div>
        <div class="hr-form-row">
          <${Field} label="시작">
            <${Input} type="time" value=${form.startTime} disabled=${form.isOff} onInput=${(e) => {
              const st = e.target.value;
              setForm((f) => ({ ...f, startTime: st, hours: autoHours(st, f.endTime) ?? f.hours }));
            }} />
          </${Field}>
          <${Field} label="끝">
            <${Input} type="time" value=${form.endTime} disabled=${form.isOff} onInput=${(e) => {
              const en = e.target.value;
              setForm((f) => ({ ...f, endTime: en, hours: autoHours(f.startTime, en) ?? f.hours }));
            }} />
          </${Field}>
          <${Field} label="근무 시간" hint="점심시간은 빼고 적어 주세요">
            <${Input} type="number" min="0" max="24" step="0.5" value=${form.hours} disabled=${form.isOff} onInput=${(e) => set('hours', e.target.value)} />
          </${Field}>
        </div>
        <div class="row wrap between">
          <${Checkbox} label="쉬는 날로 셈 (휴무)" checked=${form.isOff} onChange=${(c) => set('isOff', c)} />
          <div class="row">
            ${form.id ? html`<${Button} onClick=${() => setForm(blank)}>취소</${Button}>` : null}
            <${Button} type="submit" variant="primary" icon=${form.id ? 'check' : 'plus'} loading=${busy}>${form.id ? '저장' : '추가'}</${Button}>
          </div>
        </div>
      </form>
    </div>
  </${Modal}>`;
}

// ---------------- 공휴일·휴진 요일 ----------------
function HolidayModal({ year: initialYear, onClose, onChanged }) {
  const [year, setYear] = useState(initialYear);
  const { data, loading, error, reload } = useApi(`/hr/holidays?year=${year}`);
  const settings = useApi('/hr/settings');
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const thisYear = Number(todayStr().slice(0, 4));

  const toggleDay = async (n) => {
    const cur = settings.data?.closedWeekdays || [0];
    const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n];
    try {
      const r = await api.put('/hr/settings', { closedWeekdays: next });
      settings.setData(r);
      toast.success(`정기 휴진: ${r.closedWeekdays.map((x) => WEEK[x] + '요일').join(', ') || '없음'}`);
      onChanged();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const add = async (e) => {
    e.preventDefault();
    if (!date || !name.trim()) return toast.warn('날짜와 이름을 넣어 주세요.');
    setBusy(true);
    try {
      await api.post('/hr/holidays', { date, name });
      toast.success('공휴일을 추가했습니다.');
      if (date.slice(0, 4) !== String(year)) setYear(Number(date.slice(0, 4)));
      setDate('');
      setName('');
      reload();
      onChanged();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (h) => {
    try {
      await api.del(`/hr/holidays/${h.id}`);
      toast.success(`${h.name}을(를) 지웠습니다.`);
      reload();
      onChanged();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const addFixed = async () => {
    try {
      const r = await api.post('/hr/holidays/fixed', { year });
      toast.success(r.added ? `${year}년 고정 공휴일 ${r.added}개를 넣었습니다.` : '이미 모두 들어 있습니다.');
      reload();
      onChanged();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return html`<${Modal} open=${true} size="lg" title="공휴일·휴진일 설정" onClose=${onClose}>
    <div class="stack lg">
      <section class="stack sm">
        <div class="strong">정기 휴진 요일</div>
        <div class="small muted">이 요일은 근무표에서 회색으로 보이고, 연차 일수에서도 빠집니다.</div>
        <div class="row wrap">
          ${WEEK.map(
            (w, n) => html`<button type="button" class=${cx('hr-daytoggle', (settings.data?.closedWeekdays || []).includes(n) && 'on', n === 0 && 'sun', n === 6 && 'sat')}
              aria-pressed=${(settings.data?.closedWeekdays || []).includes(n) ? 'true' : 'false'} onClick=${() => toggleDay(n)} disabled=${!settings.data}>${w}</button>`
          )}
        </div>
      </section>
      <hr class="divider" />
      <section class="stack sm">
        <div class="row between wrap">
          <div class="strong">공휴일</div>
          <${Seg} label="연도" value=${year} onChange=${setYear} items=${[thisYear - 1, thisYear, thisYear + 1].map((y) => ({ value: y, label: `${y}년` }))} />
        </div>
        <${Callout} kind="info">설날·추석·대체공휴일·선거일은 해마다 날짜가 달라 자동으로 넣지 않았습니다. 달력을 보고 아래에서 직접 추가해 주세요.</${Callout}>
        ${error
          ? html`<${ErrorState} error=${error} onRetry=${reload} compact />`
          : loading && !data
            ? html`<${Loading} rows=${3} />`
            : !data.rows.length
              ? html`<${EmptyState} compact icon="calendar-x" title=${`${year}년 공휴일이 없습니다`} action=${html`<${Button} size="sm" icon="plus" onClick=${addFixed}>${year}년 고정 공휴일 넣기</${Button}>`} />`
              : html`<div class="hr-holiday-list">
                  ${data.rows.map(
                    (h) => html`<div class="hr-holiday" key=${h.id}>
                      <span class="num strong">${md(h.date)}</span><span class="muted small">(${h.weekdayLabel})</span>
                      <span class="grow ellipsis">${h.name}</span>
                      <${IconButton} icon="x" size="sm" label=${`${h.name} 지우기`} onClick=${() => remove(h)} />
                    </div>`
                  )}
                </div>
                <div><${Button} size="sm" variant="ghost" icon="rotate-ccw" onClick=${addFixed}>빠진 고정 공휴일 다시 넣기</${Button}></div>`}
        <form class="hr-subform row wrap" onSubmit=${add}>
          <${Input} type="date" value=${date} onInput=${(e) => setDate(e.target.value)} aria-label="공휴일 날짜" style=${{ width: '170px' }} />
          <${Input} value=${name} maxlength="30" placeholder="예: 추석 연휴" onInput=${(e) => setName(e.target.value)} aria-label="공휴일 이름" class="grow" style=${{ minWidth: '140px', flex: 1 }} />
          <${Button} type="submit" icon="plus" loading=${busy}>추가</${Button}>
        </form>
      </section>
    </div>
  </${Modal}>`;
}

// ---------------- 패턴 복사 ----------------
function CopyModal({ month, onClose, onDone }) {
  const [mode, setMode] = useState('week');
  // 고를 수 있는 주: 이번 달 첫날 일주일 전 ~ 이번 달 마지막 주 (월요일 시작)
  const weeks = useMemo(() => {
    const first = `${month}-01`;
    let d = addDays(first, -7);
    while (parseDate(d).getDay() !== 1) d = addDays(d, -1);
    const lastDay = `${month}-${String(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
    const out = [];
    while (d <= lastDay) {
      out.push({ value: d, label: `${md(d)}(월) ~ ${md(addDays(d, 6))}(일)` });
      d = addDays(d, 7);
    }
    return out;
  }, [month]);
  // 기본값: 지난주 (이번 달이 아니면 첫 번째 주)
  const defaultWeek = useMemo(() => {
    const t = todayStr();
    let m = addDays(t, -7);
    while (parseDate(m).getDay() !== 1) m = addDays(m, -1);
    return weeks.find((w) => w.value === m)?.value || weeks[0]?.value;
  }, [weeks]);
  const [weekStart, setWeekStart] = useState(defaultWeek);
  const [untilEnd, setUntilEnd] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post('/hr/schedule/copy', { month, mode, weekStart: mode === 'week' ? weekStart : undefined, untilEnd, overwrite });
      toast.success(`${r.changed}칸을 채웠습니다.${r.skippedHoliday ? ` (공휴일 ${r.skippedHoliday}일은 건너뜀)` : ''}`);
      onDone();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return html`<${Modal} open=${true} title="근무 패턴 복사" onClose=${onClose} busy=${busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" icon="copy" loading=${busy} onClick=${go}>복사하기</${Button}>`}>
    <div class="stack">
      <${Seg} label="복사 방식" value=${mode} onChange=${setMode} items=${[{ value: 'week', label: '한 주 패턴 반복' }, { value: 'prevMonth', label: '전월 같은 요일' }]} />
      ${mode === 'week'
        ? html`<${Field} label="기준이 되는 주" hint="이 주의 근무를 그다음 주들에 똑같이 넣습니다. (예: 지난주 → 이번 주부터)">
              <${Select} value=${weekStart} onChange=${(e) => setWeekStart(e.target.value)} options=${weeks} />
            </${Field}>
            <${Checkbox} label=${`${monthLabel(month)} 끝까지 반복 (끄면 바로 다음 1주만)`} checked=${untilEnd} onChange=${setUntilEnd} />`
        : html`<p class="text-2 small">${monthLabel(addMonthYm(month, -1))}의 "같은 주차·같은 요일" 근무를 ${monthLabel(month)}에 넣습니다. 예) 지난달 셋째 목요일 → 이번 달 셋째 목요일</p>`}
      <${Checkbox} label="이미 입력된 칸도 덮어쓰기" checked=${overwrite} onChange=${setOverwrite} />
      <p class="small muted">공휴일로 등록된 날은 건너뜁니다. 원본에 비어 있는 칸은 복사하지 않습니다.</p>
    </div>
  </${Modal}>`;
}

// ---------------- 인쇄용 ----------------
function PrintSchedule({ data, totals, types }) {
  return html`<div class="print-only hr-print">
    <${PrintDoc} title=${`${monthLabel(data.month)} 근무표`} meta=${`출력 ${todayStr().replace(/-/g, '.')}`} footer=${false}>
      <table class="table hr-print-table">
        <thead>
          <tr>
            <th>이름</th>
            ${data.days.map((d) => html`<th class=${cx(d.weekday === 0 || d.holiday ? 'sun' : d.weekday === 6 && 'sat')}>${d.day}<br />${d.weekdayLabel}</th>`)}
            <th>일수</th>
            <th>시간</th>
          </tr>
        </thead>
        <tbody>
          ${data.staff.map(
            (s) => html`<tr>
              <td class="nowrap">${s.name}</td>
              ${data.days.map((d) => {
                const l = leaveOn(data, s.id, d);
                const e = data.entries[s.id]?.[d.date];
                const t = e && types[e.shiftTypeId];
                if (l && l.status === 'approved' && !l.half) return html`<td class="lv">${l.type.slice(0, 2)}</td>`;
                return html`<td class=${cx(t && t.isOff && 'off')}>${t ? t.code : ''}${l && l.status === 'approved' && l.half ? '½' : ''}</td>`;
              })}
              <td>${totals.perUser[s.id].days}</td>
              <td>${fmtNumber(totals.perUser[s.id].hours, 1)}</td>
            </tr>`
          )}
          <tr>
            <td>인원</td>
            ${data.days.map((d) => html`<td>${totals.perDay[d.date] || ''}</td>`)}
            <td></td><td></td>
          </tr>
        </tbody>
      </table>
      <div class="hr-print-legend">
        ${Object.values(types)
          .filter((t) => !t.archived)
          .map((t) => html`<span><strong>${t.code}</strong> ${t.name}${t.startTime ? ` ${t.startTime}~${t.endTime}` : ''}</span>`)}
        <span><strong>연차 등</strong> 승인된 휴가 · <strong>½</strong> 반차</span>
      </div>
    </${PrintDoc}>
  </div>`;
}

// ---------------- 화면 ----------------
export default function SchedulePage({ route }) {
  const month = /^\d{4}-\d{2}$/.test(route.query.month || '') ? route.query.month : todayStr().slice(0, 7);
  const { data, loading, error, reload, setData } = useApi(`/hr/schedule?month=${month}`);
  const editable = can('manager');
  const me = session.user?.id;
  const [picker, setPicker] = useState(null); // { userId, date, rect, name, leave }
  const [brush, setBrush] = useState(null); // 빠른 입력: 근무 유형 id 또는 'erase'
  const [modal, setModal] = useState(null); // 'types' | 'holidays' | 'copy'
  const scrollRef = useRef();

  const types = useMemo(() => (data ? Object.fromEntries(data.shiftTypes.map((t) => [t.id, t])) : {}), [data]);
  const activeTypes = useMemo(() => (data ? data.shiftTypes.filter((t) => !t.archived) : []), [data]);
  const totals = useMemo(() => (data ? computeTotals(data) : null), [data]);
  const monthHolidays = data ? data.days.filter((d) => d.holiday) : [];
  const openDays = data ? data.days.filter((d) => !d.closed && !d.holiday).length : 0;

  // 가로로 넘길 때 고르기 창 닫기
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !picker) return;
    const close = () => setPicker(null);
    el.addEventListener('scroll', close, { passive: true });
    window.addEventListener('scroll', close, { passive: true });
    return () => {
      el.removeEventListener('scroll', close);
      window.removeEventListener('scroll', close);
    };
  }, [picker, data]);

  // 오늘 날짜가 보이게 가로 위치 맞추기 (태블릿)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !data) return;
    const th = el.querySelector('th.today');
    if (th && th.offsetLeft > el.clientWidth - 80) el.scrollLeft = th.offsetLeft - 200;
  }, [data && data.month]);

  /** 칸 하나 저장 (화면에 먼저 반영하고, 실패하면 되돌림) */
  const saveCell = async (userId, date, shiftTypeId) => {
    const prev = data.entries[userId]?.[date] || null;
    if ((prev?.shiftTypeId || null) === (shiftTypeId || null)) return;
    const apply = (val) =>
      setData((d) => {
        const row = { ...(d.entries[userId] || {}) };
        if (val) row[date] = val;
        else delete row[date];
        return { ...d, entries: { ...d.entries, [userId]: row } };
      });
    apply(shiftTypeId ? { shiftTypeId, note: null } : null);
    try {
      await api.put('/hr/schedule/entry', { userId, date, shiftTypeId: shiftTypeId || null });
    } catch (e) {
      apply(prev);
      toast.error(e.message);
    }
  };

  const focusCell = (r, c) => {
    const el = scrollRef.current?.querySelector(`[data-cell="${r}-${c}"]`);
    if (el) el.focus();
  };

  const onCellKey = (e, r, c, s, d) => {
    const k = e.key;
    if (k === 'ArrowRight') focusCell(r, c + 1);
    else if (k === 'ArrowLeft') focusCell(r, c - 1);
    else if (k === 'ArrowDown') focusCell(r + 1, c);
    else if (k === 'ArrowUp') focusCell(r - 1, c);
    else if (k === 'Delete' || k === 'Backspace') saveCell(s.id, d.date, null);
    else if (/^[1-9]$/.test(k) && activeTypes[Number(k) - 1]) saveCell(s.id, d.date, activeTypes[Number(k) - 1].id);
    else return;
    e.preventDefault();
  };

  const onCellClick = (e, s, d, r, c) => {
    if (brush) return saveCell(s.id, d.date, brush === 'erase' ? null : brush);
    setPicker({ userId: s.id, date: d.date, rect: e.currentTarget.getBoundingClientRect(), name: s.name, leave: data.leaves[s.id]?.[d.date], r, c });
  };

  /** 줄 도우미: 이 직원의 평일(진료일) 빈칸을 기본 근무로 채우기 / 이 달 모두 지우기 */
  const fillRow = async (s) => {
    const def = activeTypes.find((t) => !t.isOff);
    if (!def) return toast.warn('먼저 근무 유형을 만들어 주세요.');
    const entries = data.days
      .filter((d) => !d.closed && !d.holiday && d.weekday >= 1 && d.weekday <= 5 && !data.entries[s.id]?.[d.date] && (!s.hireDate || d.date >= s.hireDate))
      .map((d) => ({ userId: s.id, date: d.date, shiftTypeId: def.id }));
    if (!entries.length) return toast.info('채울 빈칸이 없습니다.');
    try {
      await api.post('/hr/schedule/bulk', { entries });
      toast.success(`${s.name} 님 평일 ${entries.length}칸을 '${def.name}'(으)로 채웠습니다.`);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const clearRow = async (s) => {
    const dates = Object.keys(data.entries[s.id] || {});
    if (!dates.length) return toast.info('지울 칸이 없습니다.');
    if (!(await confirmDialog({ title: `${s.name} 님의 ${monthLabel(month)} 근무를 모두 지울까요?`, message: `${dates.length}칸이 비워집니다. 휴가 기록은 그대로 남습니다.`, danger: true, confirmText: '모두 지우기' }))) return;
    try {
      await api.post('/hr/schedule/bulk', { entries: dates.map((date) => ({ userId: s.id, date, shiftTypeId: null })) });
      toast.success('지웠습니다.');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const header = html`<${PageHeader}
    title="근무표"
    desc="한 달 근무를 한눈에 봅니다. 승인된 연차·반차는 칸에 자동으로 표시됩니다."
    actions=${html`
      <${MonthNav} month=${month} onChange=${(m) => setQuery({ month: m })} />
      <${Button} icon="printer" onClick=${printNow} disabled=${!data}>인쇄</${Button}>
      ${editable
        ? html`<${Button} icon="copy" onClick=${() => setModal('copy')}>패턴 복사</${Button}>
            <${Menu} label="근무표 설정" icon="settings" size="md" buttonVariant="secondary" items=${[
              { label: '근무 유형 관리', icon: 'clock', onClick: () => setModal('types') },
              { label: '공휴일·휴진일 설정', icon: 'calendar-x', onClick: () => setModal('holidays') },
            ]} />`
        : null}
    `}
  />`;

  if (error && !data) return html`${header}<${Card}><${ErrorState} error=${error} onRetry=${reload} /></${Card}>`;
  if (!data) return html`${header}<${Card}><${Loading} rows=${8} /></${Card}>`;

  const today = data.today;
  return html`
    <div class="no-print">
      ${header}
      ${editable
        ? html`<div class="hr-toolbar" role="toolbar" aria-label="빠른 입력">
            <span class="small strong text-2">빠른 입력</span>
            <button type="button" class=${cx('hr-brush', !brush && 'on')} aria-pressed=${!brush ? 'true' : 'false'} onClick=${() => setBrush(null)}>
              <${Icon} name="list" size=${14} />칸마다 고르기
            </button>
            ${activeTypes.map(
              (t, i) => html`<button type="button" class=${cx('hr-brush', brush === t.id && 'on')} aria-pressed=${brush === t.id ? 'true' : 'false'} onClick=${() => setBrush(brush === t.id ? null : t.id)} title=${`${t.name}${t.startTime ? ` ${t.startTime}~${t.endTime}` : ''} (단축키 ${i + 1})`}>
                <span class="hr-swatch" style=${{ background: t.color }}></span>${t.code}
              </button>`
            )}
            <button type="button" class=${cx('hr-brush', brush === 'erase' && 'on')} aria-pressed=${brush === 'erase' ? 'true' : 'false'} onClick=${() => setBrush(brush === 'erase' ? null : 'erase')}>
              <${Icon} name="x" size=${14} />지우개
            </button>
            <span class="grow"></span>
            <span class="small muted desktop-only">${brush ? '누르는 칸마다 바로 입력됩니다' : '칸을 눌러 고르거나, 방향키로 이동 후 숫자 1~' + activeTypes.length + ' · Delete'}</span>
          </div>`
        : null}
      <${Card} flush class="hr-sched-card">
        ${!data.staff.length
          ? html`<${EmptyState} icon="users" title="재직 중인 직원이 없습니다" desc="관리 → 사용자에서 직원을 먼저 추가해 주세요." />`
          : html`<div class="hr-sched-scroll" ref=${scrollRef}>
          <table class="hr-sched" style=${{ '--days': data.days.length }}>
            <thead>
              <tr>
                <th class="hr-name-col" scope="col">
                  <div class="small muted">직원 · 합계</div>
                </th>
                ${data.days.map(
                  (d) => html`<th scope="col" title=${d.holiday || (d.closed ? '정기 휴진' : '')}
                    class=${cx('hr-day', d.weekday === 1 && 'mon', d.weekday === 6 && 'sat', (d.weekday === 0 || d.holiday) && 'sun', d.closed && 'closed', d.holiday && 'holiday', d.date === today && 'today')}>
                    <span class="hr-day-num num">${d.day}</span>
                    <span class="hr-day-wk">${d.weekdayLabel}</span>
                    ${d.holiday ? html`<span class="hr-day-dot" aria-label=${d.holiday}></span>` : null}
                  </th>`
                )}
              </tr>
            </thead>
            <tbody>
              ${data.staff.map((s, r) => {
                const t = totals.perUser[s.id];
                return html`<tr key=${s.id} class=${cx(s.id === me && 'me')}>
                  <th scope="row" class="hr-name-col">
                    <div class="hr-name">
                      <span class="hr-person-dot" style=${{ background: s.color || 'var(--text-3)' }}></span>
                      <div class="grow" style=${{ minWidth: 0 }}>
                        <div class="ellipsis strong">${s.name}${s.id === me ? html`<span class="hr-me">나</span>` : null}</div>
                        <div class="hr-name-sub num">${t.days}일 · ${fmtNumber(t.hours, 1)}h${t.leave ? html` · <span class="warning-text">휴가 ${t.leave}</span>` : null}</div>
                      </div>
                      ${editable
                        ? html`<${Menu} label=${`${s.name} 줄 도우미`} items=${[
                            { label: '평일 빈칸 기본 근무로 채우기', icon: 'wand-sparkles', onClick: () => fillRow(s) },
                            { label: '이 달 근무 모두 지우기', icon: 'trash-2', danger: true, onClick: () => clearRow(s) },
                          ]} />`
                        : null}
                    </div>
                  </th>
                  ${data.days.map((d, c) => {
                    const e = data.entries[s.id]?.[d.date];
                    const st = e && types[e.shiftTypeId];
                    const l = leaveOn(data, s.id, d);
                    const fullLeave = l && l.status === 'approved' && !l.half;
                    const label = [s.name, fmtDate(d.date), st ? st.name : '비어 있음', l ? `${l.status === 'approved' ? '' : '승인 대기 '}${l.type}` : ''].filter(Boolean).join(', ');
                    const inner = fullLeave
                      ? html`<span class="hr-leave">${l.type.length > 2 ? l.type.slice(0, 2) : l.type}</span>`
                      : st
                        ? html`<span class=${cx('hr-shift', st.isOff && 'off')} style=${st.isOff ? null : tint(st.color)}>${st.code}${l && l.status === 'approved' && l.half ? html`<span class="hr-half" title=${l.type}>½</span>` : null}</span>`
                        : l && l.status === 'approved' && l.half
                          ? html`<span class="hr-leave half">${l.type.slice(0, 2)}</span>`
                          : null;
                    const cls = cx('hr-cell', d.weekday === 1 && 'mon', d.closed && 'closed', d.holiday && 'holiday', d.date === today && 'today', l && l.status === 'pending' && 'pending', picker && picker.userId === s.id && picker.date === d.date && 'active');
                    return html`<td class=${cls} key=${d.date}>
                      ${editable
                        ? html`<button type="button" class="hr-cell-btn" data-cell=${`${r}-${c}`} aria-label=${label} title=${label}
                            onClick=${(ev) => onCellClick(ev, s, d, r, c)} onKeyDown=${(ev) => onCellKey(ev, r, c, s, d)}>${inner}</button>`
                        : html`<div class="hr-cell-btn" title=${label}>${inner}</div>`}
                    </td>`;
                  })}
                </tr>`;
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" class="hr-name-col"><span class="small strong text-2">근무 인원</span></th>
                ${data.days.map(
                  (d) => html`<td class=${cx('hr-count num', d.weekday === 1 && 'mon', d.closed && 'closed', d.holiday && 'holiday', d.date === today && 'today')}>${totals.perDay[d.date] || (d.closed || d.holiday ? '' : html`<span class="danger-text">0</span>`)}</td>`
                )}
              </tr>
            </tfoot>
          </table>
        </div>`}
        <div class="hr-legend">
          ${activeTypes.map((t) => html`<span class="hr-legend-item"><span class="hr-chip" style=${t.isOff ? null : tint(t.color, 22)}>${t.code}</span>${t.name}${t.startTime ? html`<span class="muted num">${t.startTime}~${t.endTime}</span>` : null}</span>`)}
          <span class="hr-legend-item"><span class="hr-leave">연차</span>승인된 휴가</span>
          <span class="hr-legend-item"><span class="hr-chip pending-sample">　</span>승인 대기</span>
          <span class="hr-legend-item"><span class="hr-half solo">½</span>반차</span>
        </div>
      </${Card}>
      <div class="hr-sched-foot small muted">
        <span><${Icon} name="calendar-days" size=${13} /> ${monthLabel(month)} 진료일 <strong class="text-2">${openDays}일</strong></span>
        ${monthHolidays.length ? html`<span>· 공휴일 ${monthHolidays.map((d) => `${md(d.date)} ${d.holiday}`).join(', ')}</span>` : null}
        <span>· 정기 휴진 ${data.closedWeekdays.map((n) => WEEK[n]).join('·') || '없음'}요일</span>
        ${editable ? html`<span>· 설날·추석·대체공휴일·선거일은 <button type="button" class="hr-linkbtn" onClick=${() => setModal('holidays')}>공휴일 설정</button>에서 직접 추가해 주세요.</span>` : null}
      </div>
    </div>
    <${PrintSchedule} data=${data} totals=${totals} types=${types} />
    ${picker
      ? html`<${Picker}
          at=${picker}
          types=${activeTypes}
          current=${data.entries[picker.userId]?.[picker.date]?.shiftTypeId || null}
          onClose=${(refocus) => {
            const p = picker;
            setPicker(null);
            if (refocus === true) setTimeout(() => focusCell(p.r, p.c), 0);
          }}
          onPick=${(id) => {
            const p = picker;
            saveCell(p.userId, p.date, id);
            setPicker(null);
            // 다음 칸(오른쪽)으로 초점을 옮겨 연속 입력을 쉽게
            setTimeout(() => focusCell(p.r, p.c + 1), 0);
          }}
        />`
      : null}
    ${modal === 'types' ? html`<${ShiftTypesModal} onClose=${() => setModal(null)} onChanged=${reload} />` : null}
    ${modal === 'holidays' ? html`<${HolidayModal} year=${Number(month.slice(0, 4))} onClose=${() => setModal(null)} onChanged=${reload} />` : null}
    ${modal === 'copy' ? html`<${CopyModal} month=${month} onClose=${() => setModal(null)} onDone=${() => { setModal(null); reload(); }} />` : null}
  `;
}
