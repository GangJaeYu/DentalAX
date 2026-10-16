/*
 * 이 파일이 하는 일: [D. 인사·근무] 연차·휴가 화면입니다. (#/leave?tab=...)
 *
 *   탭  me        내 연차: 부여/사용/대기/잔여 + 내 신청 내역(대기 중이면 취소)
 *       calendar  팀 일정: 이번 달 누가 언제 쉬는지 달력으로 (사유는 보이지 않음)
 *       pending   승인 대기 (실장 이상): 같은 날 쉬는 사람·잔여를 보며 바로 승인/반려
 *       all       전체 신청 (실장 이상): 상태·직원·연도로 찾기
 *       balances  직원별 현황 (실장 이상): 부여 일수 직접 수정
 *   [연차·휴가 신청] 창에서 날짜를 고르면 며칠인지(휴진일·공휴일 제외), 같은 날 쉬는 사람, 신청 후 잔여를 바로 보여 줍니다.
 *   연차 계산은 근로기준법 일반 규칙(입사일 기준)을 따른 참고값이며 법률 자문이 아닙니다.
 */
import { html, useState, useEffect, useMemo, cx, todayStr, fmtDate, fmtDot, fmtNumber, fmtRelative, toQuery, parseDate } from '../lib.js';
import { api } from '../api.js';
import { setQuery } from '../router.js';
import { can, toast, confirmDialog, session } from '../store.js';
import {
  PageHeader, Card, Button, IconButton, Badge, Icon, Tabs, Seg, Modal, Field, Input, Textarea, Select, Checkbox, Callout, Stat,
  useApi, useForm, DataTable, Loading, ErrorState, EmptyState, Avatar,
} from '../ui/index.js';
import { MonthNav, monthLabel } from './schedule.js';

const TYPES = ['연차', '오전 반차', '오후 반차', '병가', '경조사', '공가', '기타'];
const HALF = ['오전 반차', '오후 반차'];
const DEDUCT = ['연차', '오전 반차', '오후 반차'];
const TYPE_COLOR = { 연차: 'blue', '오전 반차': 'purple', '오후 반차': 'purple', 병가: 'red', 경조사: 'amber', 공가: 'green', 기타: 'gray' };
const STATUS = {
  pending: { label: '승인 대기', color: 'amber', icon: 'hourglass' },
  approved: { label: '승인', color: 'green', icon: 'circle-check' },
  rejected: { label: '반려', color: 'red', icon: 'circle-x' },
  cancelled: { label: '취소', color: 'gray', icon: 'circle-dot' },
};
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const DISCLAIMER =
  '근로기준법 일반 규칙으로 계산한 참고값입니다. 5인 미만 사업장은 연차 규정이 적용되지 않는 등 예외가 있고, 병원마다 회계연도 기준으로 운영하기도 합니다. 정확한 기준은 노무사와 확인해 주세요. (법률 자문 아님)';

const short = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}(${WEEK[parseDate(s).getDay()]})`;
export function fmtRange(a, b) {
  return !b || a === b ? fmtDate(a) : `${short(a)} ~ ${short(b)}`;
}
const days = (n) => (n === null || n === undefined ? '—' : `${fmtNumber(n, 1)}일`);

function TypeBadge({ type }) {
  return html`<${Badge} color=${TYPE_COLOR[type] || 'gray'}>${type}</${Badge}>`;
}
function StatusBadge({ status }) {
  const s = STATUS[status];
  return html`<${Badge} color=${s.color} dot=${status === 'pending'}>${s.label}</${Badge}>`;
}

// ---------------- 신청 창 ----------------
function RequestEditor({ onClose, onSaved, defaultDate }) {
  const isManager = can('manager');
  const me = session.user;
  const people = useApi(isManager ? '/admin/people' : null);
  const f = useForm({ userId: me.id, type: '연차', startDate: defaultDate || todayStr(), endDate: defaultDate || todayStr(), reason: '', approve: false });
  const v = f.values;
  const half = HALF.includes(v.type);
  const [pv, setPv] = useState(null);
  const [pvErr, setPvErr] = useState(null);

  // 날짜·종류가 바뀔 때마다 미리 계산 (잠깐 기다렸다가 한 번만)
  useEffect(() => {
    if (!v.startDate) return;
    const t = setTimeout(async () => {
      try {
        const q = toQuery({ userId: v.userId, type: v.type, startDate: v.startDate, endDate: half ? '' : v.endDate });
        setPv(await api.get(`/hr/leave/preview${q}`));
        setPvErr(null);
      } catch (e) {
        setPv(null);
        setPvErr(e.message);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [v.userId, v.type, v.startDate, v.endDate]);

  const save = f.submit(async (val) => {
    const body = { ...val, userId: Number(val.userId), endDate: half ? undefined : val.endDate, reason: val.reason || undefined };
    const r = await api.post('/hr/leave/requests', body);
    toast.success(r.status === 'approved' ? '등록하고 바로 승인했습니다. 근무표에 표시됩니다.' : '신청했습니다. 실장님이 승인하면 근무표에 표시됩니다.');
    onSaved(r);
  });

  return html`<${Modal} open=${true} title="연차·휴가 신청" onClose=${onClose} busy=${f.busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}>
      <${Button} variant="primary" icon="send" loading=${f.busy} disabled=${!!(pv && (pv.conflict || pv.days <= 0))} onClick=${save}>${v.approve ? '등록·승인' : '신청하기'}</${Button}>`}>
    <form class="stack" onSubmit=${save}>
      ${isManager
        ? html`<${Field} label="누구의 휴가인가요?" error=${f.errors.userId}>
            <${Select} value=${v.userId} onChange=${(e) => f.set('userId', Number(e.target.value))}
              options=${(people.data || [{ id: me.id, name: me.name }]).map((p) => ({ value: p.id, label: p.id === me.id ? `${p.name} (나)` : `${p.name}${p.jobTitle ? ' · ' + p.jobTitle : ''}` }))} />
          </${Field}>`
        : null}
      <div class="field">
        <span class="label">종류</span>
        <div class="row wrap" role="group" aria-label="휴가 종류">
          ${TYPES.map((t) => html`<button type="button" class=${cx('hr-brush', v.type === t && 'on')} aria-pressed=${v.type === t ? 'true' : 'false'} onClick=${() => f.set('type', t)}>${t}</button>`)}
        </div>
        <div class="hint">${DEDUCT.includes(v.type) ? '연차에서 빠지는 휴가입니다. 반차는 0.5일입니다.' : '연차에서 빠지지 않는 휴가입니다.'}</div>
      </div>
      <div class="hr-form-row two">
        <${Field} label=${half ? '날짜' : '시작일'} required error=${f.errors.startDate}>
          <${Input} type="date" value=${v.startDate} onInput=${(e) => {
            const s = e.target.value;
            f.set('startDate', s);
            if (!v.endDate || v.endDate < s) f.set('endDate', s);
          }} />
        </${Field}>
        ${half
          ? null
          : html`<${Field} label="끝나는 날" error=${f.errors.endDate}>
              <${Input} type="date" value=${v.endDate} min=${v.startDate} onInput=${(e) => f.set('endDate', e.target.value)} />
            </${Field}>`}
      </div>
      <${Field} label="사유 (선택)" error=${f.errors.reason} hint="짧게만 적어 주세요. 병명 같은 자세한 내용은 적지 않아도 됩니다. 다른 직원에게는 보이지 않습니다.">
        <${Input} value=${v.reason} maxlength="60" placeholder="예: 개인 사유" onInput=${(e) => f.set('reason', e.target.value)} />
      </${Field}>

      ${pvErr ? html`<${Callout} kind="danger">${pvErr}</${Callout}>` : null}
      ${pv
        ? html`<div class="hr-preview">
            <div class="hr-preview-main">
              <span class="muted small">휴가 일수</span>
              <strong class="num">${days(pv.days)}</strong>
              ${pv.skipped.length ? html`<span class="small muted">휴진일·공휴일 ${pv.skipped.length}일 제외</span>` : null}
            </div>
            ${pv.deductible && pv.balance.remaining !== null
              ? html`<div class="hr-preview-bal small">
                  <span>지금 잔여 <strong class="num">${days(pv.balance.remaining)}</strong></span>
                  ${pv.balance.pending ? html`<span class="muted">· 대기 중 ${days(pv.balance.pending)}</span>` : null}
                  <${Icon} name="arrow-right" size=${13} />
                  <span>신청 후 <strong class=${cx('num', pv.balance.after < 0 && 'danger-text')}>${days(pv.balance.after)}</strong></span>
                </div>`
              : pv.deductible
                ? html`<div class="small muted">입사일이 없어 잔여를 계산할 수 없습니다.</div>`
                : html`<div class="small muted">연차에서 빠지지 않습니다.</div>`}
          </div>
          ${pv.days <= 0 ? html`<${Callout} kind="danger">고른 날짜가 모두 휴진일 또는 공휴일입니다.</${Callout}>` : null}
          ${pv.conflict ? html`<${Callout} kind="danger" title="이미 신청한 휴가가 있습니다">${pv.conflict.type} · ${fmtRange(pv.conflict.startDate, pv.conflict.endDate)}</${Callout}>` : null}
          ${pv.deductible && pv.balance.after !== null && pv.balance.after < 0 ? html`<${Callout} kind="warn">잔여 연차보다 많습니다. 신청은 할 수 있지만 실장님과 먼저 상의해 주세요.</${Callout}>` : null}
          ${pv.overlaps.length
            ? html`<${Callout} kind="warn" title="같은 기간에 쉬는 사람">
                ${pv.overlaps.map((o) => html`<span class="hr-overlap">${o.name} · ${o.type} ${fmtRange(o.startDate, o.endDate)}${o.status === 'pending' ? ' (대기)' : ''}</span>`)}
              </${Callout}>`
            : null}`
        : null}
      ${isManager ? html`<${Checkbox} label="바로 승인하기 (대신 등록하는 경우)" checked=${v.approve} onChange=${(c) => f.set('approve', c)} />` : null}
    </form>
  </${Modal}>`;
}

// ---------------- 반려 창 ----------------
function RejectModal({ req, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await api.post(`/hr/leave/requests/${req.id}/decide`, { decision: 'rejected', note: note || undefined });
      toast.success('반려했습니다.');
      onDone();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<${Modal} open=${true} size="sm" title="휴가 반려" onClose=${onClose} busy=${busy}
    footer=${html`<${Button} onClick=${onClose}>닫기</${Button}><${Button} variant="danger-solid" loading=${busy} onClick=${go}>반려</${Button}>`}>
    <div class="stack sm">
      <p class="text-2">${req.userName} · ${req.type} · ${fmtRange(req.startDate, req.endDate)}</p>
      <${Field} label="신청자에게 남길 말 (선택)">
        <${Textarea} rows=${3} maxlength="100" value=${note} placeholder="예: 같은 날 휴가자가 있어 다른 날로 조정 부탁드립니다." onInput=${(e) => setNote(e.target.value)} />
      </${Field}>
    </div>
  </${Modal}>`;
}

// ---------------- 부여 일수 수정 창 ----------------
function GrantModal({ row, onClose, onDone }) {
  const [daysV, setDays] = useState(String(row.granted ?? row.computed ?? ''));
  const [note, setNote] = useState(row.override?.note || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/hr/leave/grants', { userId: row.userId, year: row.period.year, days: Number(daysV), note: note || undefined });
      toast.success('부여 일수를 저장했습니다.');
      onDone();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const revert = async () => {
    setBusy(true);
    try {
      await api.del(`/hr/leave/grants/${row.userId}/${row.period.year}`);
      toast.success('자동 계산으로 되돌렸습니다.');
      onDone();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<${Modal} open=${true} size="sm" title=${`${row.name} 님 연차 부여 일수`} onClose=${onClose} busy=${busy}
    footer=${html`${row.override ? html`<${Button} variant="ghost" icon="rotate-ccw" onClick=${revert} disabled=${busy}>자동 계산으로</${Button}>` : null}
      <span class="grow"></span>
      <${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${busy} onClick=${save}>저장</${Button}>`}>
    <div class="stack">
      <div class="small text-2">
        기간 <strong class="num">${fmtDot(row.period.start)} ~ ${fmtDot(row.period.end)}</strong>
        ${row.basis === 'calendar' ? ' (입사일이 없어 1월~12월 기준)' : ''}
      </div>
      <div class="small text-2">자동 계산값: <strong>${row.computed === null ? '계산 불가 (입사일 없음)' : days(row.computed)}</strong></div>
      <${Field} label="부여 일수" hint="0.5일 단위. 회계연도 기준·포상 휴가 등 병원 운영에 맞게 고칠 수 있습니다.">
        <${Input} type="number" min="0" max="60" step="0.5" value=${daysV} onInput=${(e) => setDays(e.target.value)} />
      </${Field}>
      <${Field} label="메모 (선택)">
        <${Input} maxlength="100" value=${note} placeholder="예: 회계연도 기준 조정" onInput=${(e) => setNote(e.target.value)} />
      </${Field}>
    </div>
  </${Modal}>`;
}

// ---------------- 신청 한 줄 ----------------
function RequestItem({ r, onChanged, showName, onReject, balance }) {
  const [busy, setBusy] = useState(false);
  const cancel = async () => {
    if (!(await confirmDialog({ title: '이 휴가를 취소할까요?', message: `${r.type} · ${fmtRange(r.startDate, r.endDate)}`, confirmText: '휴가 취소', danger: true }))) return;
    setBusy(true);
    try {
      await api.post(`/hr/leave/requests/${r.id}/cancel`);
      toast.success('취소했습니다.');
      onChanged();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const approve = async () => {
    setBusy(true);
    try {
      await api.post(`/hr/leave/requests/${r.id}/decide`, { decision: 'approved' });
      toast.success(`${r.userName} 님 ${r.type}을(를) 승인했습니다.`);
      onChanged();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const st = STATUS[r.status];
  return html`<div class=${cx('list-item hr-req', r.status === 'cancelled' && 'muted-row')}>
    ${showName
      ? html`<${Avatar} name=${r.userName} color=${r.userColor} />`
      : html`<div class=${`icon-box ${st.color === 'gray' ? '' : st.color}`}><${Icon} name=${st.icon} size=${16} /></div>`}
    <div class="grow">
      <div class="row wrap" style=${{ gap: '6px' }}>
        ${showName ? html`<span class="strong">${r.userName}</span>` : null}
        <${TypeBadge} type=${r.type} />
        <span class="list-title">${fmtRange(r.startDate, r.endDate)}</span>
        <span class="small muted num">${days(r.days)}${r.deducts ? '' : ' · 연차 차감 없음'}</span>
      </div>
      <div class="list-meta row wrap" style=${{ gap: '6px' }}>
        ${r.reason ? html`<span>사유: ${r.reason}</span>` : null}
        ${r.requestedByName ? html`<span>· ${r.requestedByName} 님이 대신 신청</span>` : null}
        <span>· 신청 ${fmtRelative(r.createdAt)}</span>
        ${r.decidedByName && r.status !== 'pending' ? html`<span>· ${r.decidedByName} 님 ${st.label} ${fmtRelative(r.decidedAt)}</span>` : null}
      </div>
      ${r.decisionNote ? html`<div class="small text-2 mt-1"><${Icon} name="message-circle-reply" size=${13} /> ${r.decisionNote}</div>` : null}
      ${r.overlaps && r.overlaps.length
        ? html`<div class="hr-overlap-line small"><${Icon} name="users" size=${13} /> 같은 기간 휴가: ${r.overlaps.map((o) => `${o.name}(${o.type} ${fmtRange(o.startDate, o.endDate)}${o.status === 'pending' ? ', 대기' : ''})`).join(', ')}</div>`
        : null}
      ${balance && r.deducts && balance.remaining !== null
        ? html`<div class="small muted mt-1">${r.userName} 님 잔여 ${days(balance.remaining)} → 승인 후 <strong class=${cx(balance.remaining - r.days < 0 && 'danger-text')}>${days(Math.round((balance.remaining - r.days) * 10) / 10)}</strong></div>`
        : null}
    </div>
    <div class="row hr-req-actions">
      ${r.canDecide
        ? html`<${Button} size="sm" onClick=${() => onReject(r)} disabled=${busy}>반려</${Button}>
            <${Button} size="sm" variant="primary" icon="check" loading=${busy} onClick=${approve}>승인</${Button}>`
        : html`<${StatusBadge} status=${r.status} />`}
      ${r.canCancel && !r.canDecide ? html`<${Button} size="sm" variant="ghost" loading=${busy} onClick=${cancel}>취소</${Button}>` : null}
    </div>
  </div>`;
}

// ---------------- 탭: 내 연차 ----------------
function MyTab({ onNew, version }) {
  const bal = useApi(`/hr/leave/balances?v=${version}`);
  const reqs = useApi(`/hr/leave/requests?v=${version}&userId=${session.user.id}`);
  const me = session.user.id;
  const b = bal.data && bal.data.rows.find((x) => x.userId === me);
  const mine = reqs.data ? reqs.data.rows.filter((r) => r.userId === me) : null;
  return html`
    ${bal.error && !bal.data ? html`<${Card}><${ErrorState} error=${bal.error} onRetry=${bal.reload} compact /></${Card}>` : null}
    ${!bal.data && !bal.error ? html`<div class="stats"><div class="stat"><${Loading} /></div></div>` : null}
    ${b
      ? html`<div class="stats hr-stats">
          <${Stat} label="부여" icon="calendar-days" value=${b.granted === null ? '—' : fmtNumber(b.granted, 1)} unit=${b.granted === null ? '' : '일'}
            hint=${html`${fmtDot(b.period.start)} ~ ${fmtDot(b.period.end)}${b.override ? ' · 직접 수정' : ''}`} />
          <${Stat} label="사용" icon="calendar-check" value=${fmtNumber(b.used, 1)} unit="일" hint="승인된 연차·반차" />
          <${Stat} label="승인 대기" icon="hourglass" value=${fmtNumber(b.pending, 1)} unit="일" />
          <${Stat} label="잔여" icon="circle-check" value=${b.remaining === null ? '—' : fmtNumber(b.remaining, 1)} unit=${b.remaining === null ? '' : '일'} color=${b.remaining !== null && b.remaining < 0 ? 'danger' : undefined}
            hint=${b.service ? `근속 ${b.service.label}${b.period.firstYear ? ' · 1년 미만은 매월 1일씩 생김' : ''}` : '입사일 없음'} />
        </div>`
      : null}
    ${b && b.granted === null
      ? html`<${Callout} kind="warn" class="mt-3">입사일이 등록되지 않아 연차를 자동 계산할 수 없습니다. 관리 → 사용자에서 입사일을 넣거나(원장·관리자), 실장 이상이 "직원별 현황" 탭에서 부여 일수를 직접 넣을 수 있습니다.</${Callout}>`
      : null}
    <${Card} title="내 신청 내역" class="mt-4" flush actions=${html`<${Button} size="sm" icon="plus" onClick=${onNew}>신청</${Button}>`}>
      ${reqs.error && !reqs.data
        ? html`<${ErrorState} error=${reqs.error} onRetry=${reqs.reload} />`
        : !mine
          ? html`<${Loading} rows=${4} />`
          : !mine.length
            ? html`<${EmptyState} icon="calendar-check" title="아직 신청한 휴가가 없습니다" desc="쉬고 싶은 날을 골라 신청하면 실장님이 승인합니다." action=${html`<${Button} variant="primary" icon="plus" onClick=${onNew}>연차·휴가 신청</${Button}>`} />`
            : html`<div class="list">${mine.map((r) => html`<${RequestItem} key=${r.id} r=${r} onChanged=${() => { reqs.reload(); bal.reload(); }} />`)}</div>`}
    </${Card}>
    <details class="hr-help mt-3">
      <summary><${Icon} name="circle-help" size=${14} /> 연차는 어떻게 계산되나요?</summary>
      <p>${bal.data?.basisNote || ''}</p>
      <p>휴가 일수는 정기 휴진 요일과 공휴일을 빼고 세며, 반차는 0.5일입니다. 병가·경조사·공가·기타는 연차에서 빠지지 않습니다.</p>
      <p class="hr-disclaimer">${DISCLAIMER}</p>
    </details>
  `;
}

// ---------------- 탭: 팀 일정 (달력) ----------------
function CalendarTab({ month, onMonth, onNewOn }) {
  const { data, loading, error, reload } = useApi(`/hr/leave/calendar?month=${month}`);
  const cells = useMemo(() => {
    if (!data) return [];
    const [y, m] = month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const n = new Date(y, m, 0).getDate();
    const out = [];
    for (let i = 0; i < first.getDay(); i++) out.push(null);
    for (let d = 1; d <= n; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      const wd = (first.getDay() + d - 1) % 7;
      const closed = data.closedWeekdays.includes(wd);
      const holiday = data.holidays[date];
      const list = closed || holiday ? [] : data.rows.filter((r) => r.startDate <= date && r.endDate >= date);
      out.push({ date, d, wd, closed, holiday, list });
    }
    while (out.length % 7) out.push(null);
    return out;
  }, [data, month]);
  const people = data ? new Set(data.rows.filter((r) => r.status === 'approved').map((r) => r.userId)).size : 0;
  return html`
    <div class="row wrap between" style=${{ marginBottom: '12px' }}>
      <${MonthNav} month=${month} onChange=${onMonth} />
      ${data ? html`<span class="small muted">${monthLabel(month)} 휴가 ${data.rows.length}건 · ${people}명 · 점선은 승인 대기</span>` : null}
    </div>
    ${error && !data
      ? html`<${Card}><${ErrorState} error=${error} onRetry=${reload} /></${Card}>`
      : !data
        ? html`<${Card}><${Loading} rows=${6} /></${Card}>`
        : html`<div class="hr-cal-wrap"><div class="calendar-grid hr-cal">
            ${WEEK.map((w, i) => html`<div class=${cx('hr-cal-head', i === 0 && 'sun', i === 6 && 'sat')}>${w}</div>`)}
            ${cells.map((c) =>
              !c
                ? html`<div class="hr-cal-empty"></div>`
                : html`<div class=${cx('hr-cal-day', c.closed && 'closed', c.holiday && 'holiday', c.date === data.today && 'today')}>
                    <div class="hr-cal-top">
                      <span class=${cx('hr-cal-num num', (c.wd === 0 || c.holiday) && 'sun', c.wd === 6 && 'sat')}>${c.d}</span>
                      ${c.holiday ? html`<span class="hr-cal-hol ellipsis">${c.holiday}</span>` : null}
                      ${!c.closed && !c.holiday && c.date >= data.today
                        ? html`<button type="button" class="hr-cal-add" aria-label=${`${fmtDate(c.date)} 휴가 신청`} title="이 날 휴가 신청" onClick=${() => onNewOn(c.date)}><${Icon} name="plus" size=${13} /></button>`
                        : null}
                    </div>
                    ${c.list.slice(0, 4).map(
                      (r) => html`<div class=${cx('hr-cal-chip', r.status === 'pending' && 'pending', r.mine && 'mine')} title=${`${r.userName} · ${r.type}${r.status === 'pending' ? ' (승인 대기)' : ''}`}>
                        <span class="hr-person-dot" style=${{ background: r.userColor || 'var(--text-3)' }}></span>
                        <span class="ellipsis">${r.userName}</span>
                        <span class="hr-cal-type">${r.type.replace(' 반차', '반차')}</span>
                      </div>`
                    )}
                    ${c.list.length > 4 ? html`<div class="small muted">+${c.list.length - 4}명</div>` : null}
                  </div>`
            )}
          </div></div>`}
  `;
}

// ---------------- 탭: 승인 대기 ----------------
function PendingTab({ version, onChanged }) {
  const { data, loading, error, reload } = useApi(`/hr/leave/requests?status=pending&v=${version}`);
  const bal = useApi(`/hr/leave/balances?v=${version}`);
  const [rejecting, setRejecting] = useState(null);
  const byUser = useMemo(() => Object.fromEntries((bal.data?.rows || []).map((b) => [b.userId, b])), [bal.data]);
  const changed = () => {
    reload();
    bal.reload();
    onChanged();
  };
  return html`
    <${Card} flush>
      ${error && !data
        ? html`<${ErrorState} error=${error} onRetry=${reload} />`
        : !data
          ? html`<${Loading} rows=${4} />`
          : !data.rows.length
            ? html`<${EmptyState} icon="circle-check" title="승인할 신청이 없습니다" desc="새 신청이 들어오면 여기와 대시보드에 표시됩니다." action=${html`<${Button} size="sm" onClick=${() => setQuery({ tab: 'calendar' })}>팀 일정 보기</${Button}>`} />`
            : html`<div class="list">${data.rows.map((r) => html`<${RequestItem} key=${r.id} r=${r} showName balance=${byUser[r.userId]} onChanged=${changed} onReject=${setRejecting} />`)}</div>`}
    </${Card}>
    ${rejecting ? html`<${RejectModal} req=${rejecting} onClose=${() => setRejecting(null)} onDone=${() => { setRejecting(null); changed(); }} />` : null}
  `;
}

// ---------------- 탭: 전체 신청 ----------------
function AllTab({ query, version, onChanged }) {
  const status = query.status || '';
  const year = query.year || todayStr().slice(0, 4);
  const userId = query.user || '';
  const people = useApi('/admin/people');
  const { data, loading, error, reload } = useApi(`/hr/leave/requests${toQuery({ status, year, userId, v: version })}`);
  const [rejecting, setRejecting] = useState(null);
  const thisYear = Number(todayStr().slice(0, 4));
  const changed = () => {
    reload();
    onChanged();
  };
  const act = async (r, path, body, msg) => {
    try {
      await api.post(`/hr/leave/requests/${r.id}/${path}`, body);
      toast.success(msg);
      changed();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const cols = [
    { key: 'userName', label: '직원', render: (r) => html`<div class="row" style=${{ gap: '8px' }}><span class="hr-person-dot" style=${{ background: r.userColor || 'var(--text-3)' }}></span><span class="strong nowrap">${r.userName}</span></div>` },
    { key: 'type', label: '종류', render: (r) => html`<${TypeBadge} type=${r.type} />` },
    { key: 'startDate', label: '기간', render: (r) => html`<span class="nowrap">${fmtRange(r.startDate, r.endDate)}</span>` },
    { key: 'days', label: '일수', align: 'right', render: (r) => html`<span class="num">${fmtNumber(r.days, 1)}</span>${r.deducts ? '' : html`<span class="muted small"> (차감 없음)</span>`}` },
    { key: 'reason', label: '사유', render: (r) => html`<span class="text-2">${r.reason || ''}</span>` },
    { key: 'status', label: '상태', render: (r) => html`<${StatusBadge} status=${r.status} />` },
    { key: 'decided', label: '처리', render: (r) => html`<span class="small muted nowrap">${r.decidedByName && r.status !== 'pending' && r.status !== 'cancelled' ? `${r.decidedByName} · ${fmtDot(r.decidedAt?.slice(0, 10))}` : ''}</span>` },
    {
      key: 'actions',
      label: '',
      class: 'actions',
      render: (r) => html`<div class="row end">
        ${r.canDecide
          ? html`<${Button} size="sm" onClick=${() => setRejecting(r)}>반려</${Button}><${Button} size="sm" variant="primary" onClick=${() => act(r, 'decide', { decision: 'approved' }, '승인했습니다.')}>승인</${Button}>`
          : null}
        ${r.canCancel && !r.canDecide
          ? html`<${Button} size="sm" variant="ghost" onClick=${async () => {
              if (await confirmDialog({ title: '이 휴가를 취소할까요?', message: `${r.userName} · ${r.type} · ${fmtRange(r.startDate, r.endDate)}`, danger: true, confirmText: '휴가 취소' })) act(r, 'cancel', {}, '취소했습니다.');
            }}>취소</${Button}>`
          : null}
      </div>`,
    },
  ];
  return html`
    <div class="row wrap" style=${{ marginBottom: '12px' }}>
      <${Seg} label="상태" value=${status} onChange=${(s) => setQuery({ status: s })} items=${[{ value: '', label: '전체' }, ...Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }))]} />
      <${Select} size="sm" value=${userId} onChange=${(e) => setQuery({ user: e.target.value })} placeholder="모든 직원" options=${(people.data || []).map((p) => ({ value: p.id, label: p.name }))} aria-label="직원" style=${{ width: '150px' }} />
      <${Select} size="sm" value=${year} onChange=${(e) => setQuery({ year: e.target.value })} options=${[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => ({ value: String(y), label: `${y}년` }))} aria-label="연도" style=${{ width: '110px' }} />
    </div>
    <${Card} flush>
      <${DataTable} columns=${cols} rows=${data?.rows} loading=${loading} error=${error} onRetry=${reload}
        rowClass=${(r) => r.status === 'cancelled' && 'muted-row'}
        empty=${{ icon: 'calendar-check', title: '조건에 맞는 신청이 없습니다', desc: '상태·직원·연도를 바꿔 보세요.' }} />
    </${Card}>
    ${rejecting ? html`<${RejectModal} req=${rejecting} onClose=${() => setRejecting(null)} onDone=${() => { setRejecting(null); changed(); }} />` : null}
  `;
}

// ---------------- 탭: 직원별 현황 ----------------
function BalancesTab({ version }) {
  const { data, loading, error, reload } = useApi(`/hr/leave/balances?v=${version}`);
  const [editing, setEditing] = useState(null);
  const cols = [
    {
      key: 'name',
      label: '직원',
      render: (b) => html`<div class="row" style=${{ gap: '8px' }}><${Avatar} name=${b.name} color=${b.color} size="sm" /><div><div class="strong nowrap">${b.name}</div><div class="small muted">${b.jobTitle}</div></div></div>`,
    },
    { key: 'hireDate', label: '입사일 · 근속', render: (b) => (b.hireDate ? html`<span class="num nowrap">${fmtDot(b.hireDate)}</span><div class="small muted">${b.service?.label || '입사 전'}</div>` : html`<span class="muted small">입사일 없음</span>`) },
    { key: 'period', label: '연차 기간', render: (b) => html`<span class="num small nowrap">${fmtDot(b.period.start)} ~ ${fmtDot(b.period.end)}</span>${b.period.firstYear ? html`<div class="small muted">1년 미만 (매월 1일)</div>` : null}` },
    { key: 'computed', label: '자동 계산', align: 'right', render: (b) => html`<span class="num muted">${days(b.computed)}</span>` },
    {
      key: 'granted',
      label: '부여',
      align: 'right',
      render: (b) => html`<span class="num strong">${days(b.granted)}</span>${b.override ? html`<div><${Badge} color="purple" title=${b.override.note || ''}>직접 수정</${Badge}></div>` : null}`,
    },
    { key: 'used', label: '사용', align: 'right', render: (b) => html`<span class="num">${days(b.used)}</span>` },
    { key: 'pending', label: '대기', align: 'right', render: (b) => (b.pending ? html`<span class="num warning-text">${days(b.pending)}</span>` : html`<span class="muted">—</span>`) },
    {
      key: 'remaining',
      label: '잔여',
      align: 'right',
      render: (b) => html`<span class=${cx('num strong hr-remain', b.remaining !== null && b.remaining < 0 && 'danger-text', b.remaining !== null && b.remaining <= 2 && b.remaining >= 0 && 'warning-text')}>${days(b.remaining)}</span>`,
    },
    { key: 'actions', label: '', class: 'actions', render: (b) => html`<${IconButton} icon="pencil" size="sm" label=${`${b.name} 부여 일수 고치기`} onClick=${() => setEditing(b)} />` },
  ];
  return html`
    <${Callout} kind="info">${data?.basisNote || '입사일 기준 1년 단위로 계산합니다.'} 부여 일수는 직원별로 직접 고칠 수 있습니다.</${Callout}>
    <${Card} flush class="mt-3">
      <${DataTable} columns=${cols} rows=${data?.rows} loading=${loading} error=${error} onRetry=${reload} rowKey="userId"
        empty=${{ icon: 'users', title: '재직 중인 직원이 없습니다' }} />
    </${Card}>
    <p class="hr-disclaimer mt-3">${DISCLAIMER}</p>
    ${editing ? html`<${GrantModal} row=${editing} onClose=${() => setEditing(null)} onDone=${() => { setEditing(null); reload(); }} />` : null}
  `;
}

// ---------------- 화면 ----------------
export default function LeavePage({ route }) {
  const isManager = can('manager');
  const q = route.query;
  const tabs = ['me', 'calendar', ...(isManager ? ['pending', 'all', 'balances'] : [])];
  const tab = tabs.includes(q.tab) ? q.tab : isManager ? 'pending' : 'me';
  const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : todayStr().slice(0, 7);
  const [creating, setCreating] = useState(null); // null | { date }
  const [version, setVersion] = useState(0);
  const pending = useApi(isManager ? `/hr/leave/requests?status=pending&v=${version}` : null);
  const bump = () => setVersion((x) => x + 1);

  return html`
    <${PageHeader}
      title="연차·휴가"
      desc="휴가를 신청하면 실장님이 승인합니다. 승인된 휴가는 근무표에 자동으로 표시됩니다."
      actions=${html`<${Button} variant="primary" icon="plus" onClick=${() => setCreating({})}>연차·휴가 신청</${Button}>`}
    />
    <${Tabs}
      value=${tab}
      onChange=${(t) => setQuery({ tab: t, status: '', user: '' })}
      items=${[
        { value: 'me', label: '내 연차', icon: 'user' },
        { value: 'calendar', label: '팀 일정', icon: 'calendar-days' },
        ...(isManager
          ? [
              { value: 'pending', label: '승인 대기', icon: 'hourglass', count: pending.data?.rows.length || 0, countColor: 'amber' },
              { value: 'all', label: '전체 신청', icon: 'list' },
              { value: 'balances', label: '직원별 현황', icon: 'users' },
            ]
          : []),
      ]}
    />
    ${tab === 'me' ? html`<${MyTab} version=${version} onNew=${() => setCreating({})} />` : null}
    ${tab === 'calendar' ? html`<${CalendarTab} key=${version} month=${month} onMonth=${(m) => setQuery({ month: m })} onNewOn=${(date) => setCreating({ date })} />` : null}
    ${tab === 'pending' ? html`<${PendingTab} version=${version} onChanged=${bump} />` : null}
    ${tab === 'all' ? html`<${AllTab} query=${q} version=${version} onChanged=${bump} />` : null}
    ${tab === 'balances' ? html`<${BalancesTab} version=${version} />` : null}
    ${creating
      ? html`<${RequestEditor} defaultDate=${creating.date} onClose=${() => setCreating(null)} onSaved=${() => {
          setCreating(null);
          bump();
        }} />`
      : null}
  `;
}
