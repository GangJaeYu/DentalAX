/*
 * 이 파일이 하는 일: [D. 인사·근무] 신규 직원 온보딩 화면입니다.
 *
 *   #/onboarding                 직원별 진행 목록 (진행 중 / 완료 / 전체)
 *   #/onboarding/run/3           진행 상세: 첫날 · 첫 주 · 첫 달 항목을 체크 (누가 언제 체크했는지 기록)
 *   #/onboarding?tab=templates   템플릿 관리: 직종별 항목 묶음. [AI로 항목 초안]으로 10~15개 초안을 받아 고른 것만 넣기
 *   - 체크는 로그인한 누구나 할 수 있습니다(담당 선배·본인). 템플릿 편집과 온보딩 시작·삭제는 실장 이상.
 *   - 모든 항목을 체크하면 자동으로 "완료"가 됩니다.
 */
import { html, useState, useMemo, cx, todayStr, fmtDate, fmtDot, fmtDateTime, addDays } from '../lib.js';
import { api } from '../api.js';
import { navigate, setQuery } from '../router.js';
import { can, toast, confirmDialog, session } from '../store.js';
import {
  PageHeader, Card, Button, IconButton, Badge, Icon, Tabs, Seg, Modal, Field, Input, Textarea, Select, Callout, Progress,
  useApi, Loading, ErrorState, EmptyState, Avatar, Menu, PiiBanner, useAI, AiResult, AiButton,
} from '../ui/index.js';

const PHASES = ['첫날', '첫 주', '첫 달'];
const OWNERS = ['원장', '실장', '담당 선배', '본인'];
const PHASE_ICON = { 첫날: 'sun', '첫 주': 'calendar-days', '첫 달': 'calendar-check' };
const RUN_STATUS = { active: { label: '진행 중', color: 'blue' }, done: { label: '완료', color: 'green' }, cancelled: { label: '중단', color: 'gray' } };

// ---------------- 온보딩 시작 창 ----------------
function StartModal({ onClose, onStarted }) {
  const people = useApi('/admin/people');
  const tpl = useApi('/hr/onboarding/templates');
  const [userId, setUserId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [startDate, setStartDate] = useState(todayStr());
  const [busy, setBusy] = useState(false);
  // 입사일이 최근인 사람을 위로 (새 직원을 찾기 쉽게)
  const list = useMemo(() => [...(people.data || [])].sort((a, b) => String(b.hireDate || '').localeCompare(String(a.hireDate || ''))), [people.data]);

  const choosePerson = (id) => {
    setUserId(id);
    const p = list.find((x) => String(x.id) === String(id));
    if (!p) return;
    // 직종이 맞는 템플릿 자동 선택, 시작일은 최근 입사자면 입사일
    const t = (tpl.data?.rows || []).find((x) => x.jobTitle && x.jobTitle === p.jobTitle);
    if (t) setTemplateId(String(t.id));
    if (p.hireDate && p.hireDate >= addDays(todayStr(), -60)) setStartDate(p.hireDate);
  };
  const go = async () => {
    if (!userId || !templateId) return toast.warn('직원과 템플릿을 골라 주세요.');
    setBusy(true);
    try {
      const r = await api.post('/hr/onboarding/runs', { userId: Number(userId), templateId: Number(templateId), startDate });
      toast.success(`${r.userName} 님 온보딩을 시작했습니다.`);
      onStarted(r);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const tplRows = tpl.data?.rows || [];
  return html`<${Modal} open=${true} title="온보딩 시작" onClose=${onClose} busy=${busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" icon="user-plus" loading=${busy} onClick=${go}>시작하기</${Button}>`}>
    <div class="stack">
      ${people.error || tpl.error ? html`<${Callout} kind="danger">${(people.error || tpl.error).message}</${Callout}>` : null}
      <${Field} label="새 직원" required hint="목록에 없으면 관리 → 사용자에서 먼저 직원을 추가해 주세요. (입사일이 최근인 순)">
        <${Select} value=${userId} placeholder="직원 고르기" onChange=${(e) => choosePerson(e.target.value)}
          options=${list.map((p) => ({ value: p.id, label: `${p.name} · ${p.jobTitle}${p.hireDate ? ` · 입사 ${fmtDot(p.hireDate)}` : ''}` }))} />
      </${Field}>
      <${Field} label="템플릿" required hint=${tplRows.length ? '직종이 같은 템플릿을 자동으로 골라 줍니다.' : '템플릿이 없습니다. 템플릿 탭에서 먼저 만들어 주세요.'}>
        <${Select} value=${templateId} placeholder="템플릿 고르기" onChange=${(e) => setTemplateId(e.target.value)}
          options=${tplRows.map((t) => ({ value: t.id, label: `${t.name} (${t.items.length}개 항목)` }))} />
      </${Field}>
      <${Field} label="시작일" hint="보통 입사일. 첫날·첫 주·첫 달 기한이 이 날짜로 정해집니다.">
        <${Input} type="date" value=${startDate} onInput=${(e) => setStartDate(e.target.value)} />
      </${Field}>
    </div>
  </${Modal}>`;
}

// ---------------- 진행 상세 ----------------
function RunDetail({ id }) {
  const { data: r, error, reload, setData } = useApi(`/hr/onboarding/runs/${id}`);
  const [busyItem, setBusyItem] = useState(null);
  const isManager = can('manager');

  if (error && !r) return html`<${BackLink} /><${Card}><${ErrorState} error=${error} onRetry=${reload} /></${Card}>`;
  if (!r) return html`<${BackLink} /><${Card}><${Loading} rows=${6} /></${Card}>`;

  const toggle = async (item) => {
    if (r.status === 'cancelled') return toast.warn('중단된 온보딩입니다.');
    setBusyItem(item.id);
    try {
      const next = await api.put(`/hr/onboarding/runs/${r.id}/checks/${item.id}`, { done: !item.done });
      setData(next);
      if (next.status === 'done' && r.status !== 'done') toast.success(`모든 항목을 마쳤습니다. ${r.userName} 님 온보딩 완료!`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusyItem(null);
    }
  };
  const setStatus = async (status, msg) => {
    try {
      setData(await api.patch(`/hr/onboarding/runs/${r.id}`, { status }));
      toast.success(msg);
    } catch (e) {
      toast.error(e.message);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: `${r.userName} 님 온보딩을 삭제할까요?`, message: '체크 기록도 함께 지워집니다. 되돌릴 수 없습니다.', danger: true, confirmText: '삭제' }))) return;
    try {
      await api.del(`/hr/onboarding/runs/${r.id}`);
      toast.success('삭제했습니다.');
      navigate('#/onboarding');
    } catch (e) {
      toast.error(e.message);
    }
  };
  const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
  const today = todayStr();

  return html`
    <${BackLink} />
    <${PageHeader} title=${`${r.userName} 님 온보딩`} desc=${`${r.templateName} · ${fmtDate(r.startDate)} 시작`}
      actions=${isManager
        ? html`<${Menu} label="온보딩 관리" buttonVariant="secondary" size="md" items=${[
            r.status !== 'done' && { label: '완료로 표시', icon: 'circle-check', onClick: () => setStatus('done', '완료로 표시했습니다.') },
            r.status !== 'active' && { label: '다시 진행 중으로', icon: 'rotate-ccw', onClick: () => setStatus('active', '진행 중으로 바꿨습니다.') },
            r.status === 'active' && { label: '중단', icon: 'circle-x', onClick: () => setStatus('cancelled', '중단했습니다.') },
            '-',
            { label: '삭제', icon: 'trash-2', danger: true, onClick: remove },
          ].filter(Boolean)} />`
        : null} />
    <div class="hr-ob-summary card">
      <div class="row" style=${{ gap: '12px' }}>
        <${Avatar} name=${r.userName} color=${r.userColor} />
        <div class="grow" style=${{ minWidth: 0 }}>
          <div class="row wrap" style=${{ gap: '6px' }}>
            <span class="strong">${r.userName}</span><span class="muted small">${r.jobTitle}</span>
            <${Badge} color=${RUN_STATUS[r.status].color}>${RUN_STATUS[r.status].label}</${Badge}>
            ${r.status === 'active' && r.dayN >= 1 ? html`<${Badge}>입사 ${r.dayN}일째</${Badge}>` : null}
          </div>
          <div class="small muted">${fmtDot(r.startDate)} ~ ${fmtDot(r.endDate)}</div>
        </div>
        <div class="hr-ob-pct"><strong class="num">${pct}%</strong><span class="small muted num">${r.done}/${r.total}</span></div>
      </div>
      <${Progress} value=${r.done} max=${r.total} color=${r.done >= r.total ? 'green' : ''} label="진행률" />
    </div>
    ${r.mine && r.status === 'active' ? html`<${Callout} kind="success" class="mt-3">환영합니다! 하나씩 해 보고 체크해 주세요. 모르는 것은 담당 선배나 실장님께 편하게 물어보세요.</${Callout}>` : null}
    ${r.status === 'cancelled' ? html`<${Callout} kind="warn" class="mt-3">중단된 온보딩입니다. 다시 진행하려면 실장님이 "다시 진행 중으로"를 눌러 주세요.</${Callout}>` : null}
    ${!r.phases.length ? html`<${Card} class="mt-4"><${EmptyState} icon="list-checks" title="템플릿에 항목이 없습니다" desc="템플릿 탭에서 항목을 추가하면 여기에 나타납니다." /></${Card}>` : null}
    <div class="hr-ob-phases mt-4">
      ${r.phases.map(
        (p) => html`<${Card} key=${p.phase} flush
          title=${html`<span class="row" style=${{ gap: '8px' }}><${Icon} name=${PHASE_ICON[p.phase]} size=${16} />${p.phase}</span>`}
          sub=${`${p.phase === '첫날' ? fmtDate(p.due) : `${fmtDate(p.due)}까지`} · ${p.items.length - p.left}/${p.items.length}`}
          actions=${p.left === 0 ? html`<${Badge} color="green"><${Icon} name="check" size=${12} />다 했어요</${Badge}>` : p.overdue ? html`<${Badge} color="amber">기한 지남 · ${p.left}개 남음</${Badge}>` : p.due >= today ? html`<${Badge}>${p.left}개 남음</${Badge}>` : null}>
          <div class="list">
            ${p.items.map(
              (it) => html`<button type="button" class=${cx('hr-ob-item', it.done && 'done')} key=${it.id} aria-pressed=${it.done ? 'true' : 'false'} disabled=${busyItem === it.id} onClick=${() => toggle(it)}>
                <span class=${cx('hr-pick-box lg', it.done && 'on')}>${it.done ? html`<${Icon} name="check" size=${14} />` : null}</span>
                <span class="grow" style=${{ minWidth: 0 }}>
                  <span class="hr-ob-title">${it.title}</span>
                  <span class="hr-ob-meta">
                    ${it.ownerRole ? html`<${Badge}>${it.ownerRole}</${Badge}>` : null}
                    ${it.done ? html`<span class="small muted">${it.doneByName || ''} · ${fmtDateTime(it.doneAt)}</span>` : null}
                  </span>
                </span>
              </button>`
            )}
          </div>
        </${Card}>`
      )}
    </div>
  `;
}

function BackLink() {
  return html`<div class="row" style=${{ marginBottom: '12px' }}>
    <a href="#/onboarding" class="btn btn-ghost btn-sm"><${Icon} name="arrow-left" size=${14} />온보딩 목록</a>
  </div>`;
}

// ---------------- 진행 목록 ----------------
function RunsTab({ query, onStart }) {
  const status = query.status || 'active';
  const { data, error, reload } = useApi(`/hr/onboarding/runs?status=${status}`);
  const me = session.user?.id;
  return html`
    <div class="row wrap" style=${{ marginBottom: '12px' }}>
      <${Seg} label="상태" value=${status} onChange=${(s) => setQuery({ status: s === 'active' ? '' : s })} items=${[
        { value: 'active', label: `진행 중${data?.counts?.active ? ` ${data.counts.active}` : ''}` },
        { value: 'done', label: `완료${data?.counts?.done ? ` ${data.counts.done}` : ''}` },
        { value: 'all', label: '전체' },
      ]} />
    </div>
    ${error && !data
      ? html`<${Card}><${ErrorState} error=${error} onRetry=${reload} /></${Card}>`
      : !data
        ? html`<${Card}><${Loading} rows=${4} /></${Card}>`
        : !data.rows.length
          ? html`<${Card}><${EmptyState} icon="user-plus" title=${status === 'active' ? '진행 중인 온보딩이 없습니다' : '해당하는 온보딩이 없습니다'}
              desc="새 직원이 들어오면 템플릿을 골라 온보딩을 시작하세요. 첫날·첫 주·첫 달 할 일을 빠짐없이 챙길 수 있습니다."
              action=${can('manager') ? html`<${Button} variant="primary" icon="user-plus" onClick=${onStart}>온보딩 시작</${Button}>` : null} /></${Card}>`
          : html`<div class="hr-ob-grid">
              ${data.rows.map((r) => {
                const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
                return html`<a class=${cx('card interactive hr-ob-card', r.userId === me && 'mine')} href=${`#/onboarding/run/${r.id}`} key=${r.id}>
                  <div class="row" style=${{ gap: '10px' }}>
                    <${Avatar} name=${r.userName} color=${r.userColor} />
                    <div class="grow" style=${{ minWidth: 0 }}>
                      <div class="row" style=${{ gap: '6px' }}><span class="strong ellipsis">${r.userName}</span>${r.userId === me ? html`<span class="hr-me">나</span>` : null}</div>
                      <div class="small muted ellipsis">${r.jobTitle} · ${r.templateName}</div>
                    </div>
                    <${Badge} color=${RUN_STATUS[r.status].color}>${RUN_STATUS[r.status].label}</${Badge}>
                  </div>
                  <div class="row between small">
                    <span class="muted">${fmtDot(r.startDate)} 시작${r.status === 'active' && r.dayN >= 1 ? ` · ${r.dayN}일째` : ''}</span>
                    <span class="num strong">${r.done}/${r.total} · ${pct}%</span>
                  </div>
                  <${Progress} value=${r.done} max=${r.total} color=${r.done >= r.total ? 'green' : ''} label=${`${r.userName} 진행률`} />
                </a>`;
              })}
            </div>`}
  `;
}

// ---------------- 템플릿: AI 초안 창 ----------------
function AiDraftModal({ template, onClose, onAdded }) {
  const ai = useAI('hr.onboarding');
  const [jobTitle, setJobTitle] = useState(template.jobTitle || template.name.replace(/\s*온보딩\s*$/, ''));
  const [notes, setNotes] = useState('');
  const [picked, setPicked] = useState(null); // 고른 항목 번호 Set
  const [busy, setBusy] = useState(false);
  const items = ai.result?.data?.items || [];

  const run = async () => {
    if (!jobTitle.trim()) return toast.warn('직종을 적어 주세요.');
    const r = await ai.run({ jobTitle, notes });
    if (r && r.data?.items) setPicked(new Set(r.data.items.map((_, i) => i)));
  };
  const add = async () => {
    const chosen = items.filter((_, i) => picked?.has(i));
    if (!chosen.length) return toast.warn('넣을 항목을 하나 이상 골라 주세요.');
    setBusy(true);
    try {
      await api.post(`/hr/onboarding/templates/${template.id}/items`, { items: chosen.map((x) => ({ title: x.title, phase: x.phase })) });
      toast.success(`${chosen.length}개 항목을 '${template.name}'에 넣었습니다.`);
      onAdded();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (i) =>
    setPicked((s) => {
      const n = new Set(s);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });

  return html`<${Modal} open=${true} size="lg" title="AI로 온보딩 항목 초안" onClose=${onClose} busy=${busy}
    footer=${items.length
      ? html`<span class="small muted grow">${picked?.size || 0}개 선택</span><${Button} onClick=${onClose}>닫기</${Button}>
          <${Button} variant="primary" icon="plus" loading=${busy} onClick=${add} disabled=${!picked?.size}>선택한 ${picked?.size || 0}개 템플릿에 넣기</${Button}>`
      : html`<${Button} onClick=${onClose}>닫기</${Button}>`}>
    <div class="stack">
      <${PiiBanner} />
      <div class="hr-form-row two">
        <${Field} label="직종" required>
          <${Input} maxlength="30" value=${jobTitle} placeholder="예: 치과위생사" onInput=${(e) => setJobTitle(e.target.value)} />
        </${Field}>
        <div class="field" style=${{ justifyContent: 'flex-end', alignItems: 'flex-start' }}>
          <${AiButton} onClick=${run} loading=${ai.busy}>${items.length ? '다시 만들기' : '항목 초안 만들기'}</${AiButton}>
        </div>
      </div>
      <${Field} label="우리 병원 메모 (선택)" hint="장비·프로그램·근무 방식 등. 환자 정보는 적지 마세요.">
        <${Textarea} rows=${3} maxlength="1500" value=${notes} placeholder="예) 디지털 엑스레이 사용, 점심시간 교대 근무, 토요일 격주 근무" onInput=${(e) => setNotes(e.target.value)} />
      </${Field}>
      ${ai.busy || ai.error || (ai.result && !items.length)
        ? html`<${AiResult} ai=${ai} title="AI 초안" />`
        : items.length
          ? html`<div class="ai-panel">
              <div class="ai-panel-head">
                <${Icon} name="sparkles" size=${15} /><span>AI 초안 · ${items.length}개</span>
                ${ai.result.demo ? html`<${Badge} color="amber">데모 예시</${Badge}>` : html`<${Badge} color="purple">AI</${Badge}>`}
                <span class="grow"></span>
                <${Button} size="sm" variant="ghost" onClick=${() => setPicked(new Set(picked?.size === items.length ? [] : items.map((_, i) => i)))}>${picked?.size === items.length ? '모두 해제' : '모두 선택'}</${Button}>
              </div>
              <div class="ai-panel-body stack sm">
                ${ai.result.pii?.message ? html`<${Callout} kind="warn" icon="shield-check">${ai.result.pii.message}</${Callout}>` : null}
                ${ai.result.notice ? html`<${Callout} kind="info">${ai.result.notice}</${Callout}>` : null}
                ${PHASES.map((ph) => {
                  const list = items.map((x, i) => [x, i]).filter(([x]) => x.phase === ph);
                  if (!list.length) return null;
                  return html`<div class="stack sm">
                    <div class="small strong text-2">${ph}</div>
                    ${list.map(
                      ([x, i]) => html`<button type="button" class=${cx('hr-pick', picked?.has(i) && 'on')} aria-pressed=${picked?.has(i) ? 'true' : 'false'} onClick=${() => toggle(i)}>
                        <span class=${cx('hr-pick-box', picked?.has(i) && 'on')}>${picked?.has(i) ? html`<${Icon} name="check" size=${12} />` : null}</span>
                        <span class="grow">${x.title}</span>
                      </button>`
                    )}
                  </div>`;
                })}
                <p class="small muted">AI 초안은 틀릴 수 있습니다. 우리 병원에 맞는 항목만 골라 넣고, 넣은 뒤에도 고칠 수 있습니다.</p>
              </div>
            </div>`
          : null}
    </div>
  </${Modal}>`;
}

// ---------------- 템플릿: 항목 고치기 / 템플릿 이름 ----------------
function ItemModal({ item, onClose, onSaved }) {
  const [v, setV] = useState({ title: item.title, phase: item.phase, ownerRole: item.ownerRole || '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/hr/onboarding/items/${item.id}`, { ...v, ownerRole: v.ownerRole || null });
      toast.success('항목을 고쳤습니다.');
      onSaved();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<${Modal} open=${true} size="sm" title="항목 고치기" onClose=${onClose} busy=${busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${busy} onClick=${save}>저장</${Button}>`}>
    <div class="stack">
      <${Field} label="항목" required><${Input} maxlength="100" value=${v.title} onInput=${(e) => setV({ ...v, title: e.target.value })} /></${Field}>
      <${Field} label="단계"><${Seg} label="단계" value=${v.phase} onChange=${(p) => setV({ ...v, phase: p })} items=${PHASES.map((p) => ({ value: p, label: p }))} /></${Field}>
      <${Field} label="담당"><${Select} value=${v.ownerRole} placeholder="정하지 않음" onChange=${(e) => setV({ ...v, ownerRole: e.target.value })} options=${OWNERS} /></${Field}>
    </div>
  </${Modal}>`;
}

function TemplateModal({ template, onClose, onSaved }) {
  const [name, setName] = useState(template?.name || '');
  const [jobTitle, setJobTitle] = useState(template?.jobTitle || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = template ? await api.patch(`/hr/onboarding/templates/${template.id}`, { name, jobTitle: jobTitle || null }) : await api.post('/hr/onboarding/templates', { name, jobTitle: jobTitle || null });
      toast.success(template ? '템플릿을 고쳤습니다.' : '템플릿을 만들었습니다.');
      onSaved(r);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<${Modal} open=${true} size="sm" title=${template ? '템플릿 고치기' : '새 템플릿'} onClose=${onClose} busy=${busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${busy} onClick=${save}>저장</${Button}>`}>
    <div class="stack">
      <${Field} label="템플릿 이름" required><${Input} maxlength="40" value=${name} placeholder="예: 간호조무사 온보딩" onInput=${(e) => setName(e.target.value)} /></${Field}>
      <${Field} label="직종 (선택)" hint="온보딩을 시작할 때 같은 직종이면 이 템플릿을 자동으로 골라 줍니다.">
        <${Input} maxlength="30" value=${jobTitle} placeholder="예: 간호조무사" list="hr-jobs" onInput=${(e) => setJobTitle(e.target.value)} />
      </${Field}>
      <datalist id="hr-jobs">${['원장', '실장', '치과위생사', '간호조무사', '치과기공사', '코디네이터', '기타'].map((j) => html`<option value=${j} />`)}</datalist>
    </div>
  </${Modal}>`;
}

// ---------------- 템플릿 탭 ----------------
function TemplatesTab({ query }) {
  const editable = can('manager');
  const { data, error, reload } = useApi('/hr/onboarding/templates');
  const [modal, setModal] = useState(null); // { kind: 'ai'|'item'|'tpl'|'newtpl', ... }
  const [newItem, setNewItem] = useState({ title: '', phase: '첫날', ownerRole: '' });
  const [adding, setAdding] = useState(false);
  const rows = data?.rows || [];
  const sel = rows.find((t) => String(t.id) === String(query.t)) || rows[0];

  const call = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast.success(msg);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const addItem = async (e) => {
    e.preventDefault();
    if (!newItem.title.trim()) return toast.warn('항목 내용을 적어 주세요.');
    setAdding(true);
    try {
      await api.post(`/hr/onboarding/templates/${sel.id}/items`, { items: [{ title: newItem.title, phase: newItem.phase, ownerRole: newItem.ownerRole || undefined }] });
      setNewItem({ ...newItem, title: '' });
      reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setAdding(false);
    }
  };
  const removeTemplate = async () => {
    if (!(await confirmDialog({ title: `'${sel.name}' 템플릿을 삭제할까요?`, message: '항목도 함께 지워집니다.', danger: true, confirmText: '삭제' }))) return;
    call(() => api.del(`/hr/onboarding/templates/${sel.id}`), '템플릿을 삭제했습니다.').then(() => setQuery({ t: '' }));
  };

  if (error && !data) return html`<${Card}><${ErrorState} error=${error} onRetry=${reload} /></${Card}>`;
  if (!data) return html`<${Card}><${Loading} rows=${5} /></${Card}>`;
  if (!rows.length) {
    return html`<${Card}><${EmptyState} icon="list-checks" title="템플릿이 없습니다" desc="직종별로 첫날·첫 주·첫 달 할 일을 묶어 두면, 새 직원이 올 때마다 그대로 쓸 수 있습니다."
      action=${editable ? html`<${Button} variant="primary" icon="plus" onClick=${() => setModal({ kind: 'newtpl' })}>새 템플릿</${Button}>` : null} /></${Card}>
      ${modal?.kind === 'newtpl' ? html`<${TemplateModal} onClose=${() => setModal(null)} onSaved=${(t) => { setModal(null); reload(); setQuery({ t: t.id }); }} />` : null}`;
  }

  return html`
    <div class="grid hr-ob-tpl-grid">
      <div class="stack sm">
        ${rows.map(
          (t) => html`<button type="button" class=${cx('hr-tpl-item', sel && sel.id === t.id && 'on')} onClick=${() => setQuery({ t: t.id })} key=${t.id}>
            <span class=${`icon-box ${sel && sel.id === t.id ? 'blue' : ''}`}><${Icon} name="list-checks" size=${16} /></span>
            <span class="grow" style=${{ minWidth: 0 }}>
              <span class="strong ellipsis" style=${{ display: 'block' }}>${t.name}</span>
              <span class="small muted">${t.jobTitle || '직종 미지정'} · ${t.items.length}개 항목${t.runCount ? ` · ${t.runCount}명 사용` : ''}</span>
            </span>
          </button>`
        )}
        ${editable ? html`<${Button} variant="ghost" icon="plus" onClick=${() => setModal({ kind: 'newtpl' })}>새 템플릿</${Button}>` : null}
      </div>
      ${sel
        ? html`<${Card} flush title=${sel.name} sub=${`${sel.jobTitle || '직종 미지정'} · ${sel.items.length}개`}
            actions=${editable
              ? html`<${AiButton} size="sm" onClick=${() => setModal({ kind: 'ai' })}>AI로 항목 초안</${AiButton}>
                  <${Menu} label="템플릿 관리" items=${[
                    { label: '이름·직종 고치기', icon: 'pencil', onClick: () => setModal({ kind: 'tpl' }) },
                    '-',
                    { label: '템플릿 삭제', icon: 'trash-2', danger: true, onClick: removeTemplate },
                  ]} />`
              : null}>
            ${!sel.items.length
              ? html`<${EmptyState} compact icon="list-checks" title="아직 항목이 없습니다" desc=${editable ? '아래에서 직접 넣거나 [AI로 항목 초안]을 눌러 보세요.' : undefined} />`
              : PHASES.map((ph) => {
                  const list = sel.items.filter((i) => i.phase === ph);
                  if (!list.length) return null;
                  return html`<div class="hr-tpl-phase">
                    <div class="hr-tpl-phase-head"><${Icon} name=${PHASE_ICON[ph]} size=${14} />${ph}<span class="muted">${list.length}</span></div>
                    ${list.map(
                      (it, i) => html`<div class="hr-tpl-row" key=${it.id}>
                        <span class="grow">${it.title}</span>
                        ${it.ownerRole ? html`<${Badge}>${it.ownerRole}</${Badge}>` : null}
                        ${editable
                          ? html`<div class="row hr-tpl-tools">
                              <${IconButton} icon="chevron-up" size="sm" label="위로" disabled=${i === 0} onClick=${() => call(() => api.post(`/hr/onboarding/items/${it.id}/move`, { dir: 'up' }))} />
                              <${IconButton} icon="chevron-down" size="sm" label="아래로" disabled=${i === list.length - 1} onClick=${() => call(() => api.post(`/hr/onboarding/items/${it.id}/move`, { dir: 'down' }))} />
                              <${IconButton} icon="pencil" size="sm" label="고치기" onClick=${() => setModal({ kind: 'item', item: it })} />
                              <${IconButton} icon="trash-2" size="sm" label="삭제" onClick=${() => call(() => api.del(`/hr/onboarding/items/${it.id}`), '항목을 지웠습니다.')} />
                            </div>`
                          : null}
                      </div>`
                    )}
                  </div>`;
                })}
            ${editable
              ? html`<form class="hr-tpl-add" onSubmit=${addItem}>
                  <${Input} value=${newItem.title} maxlength="100" placeholder="새 항목 (예: 비상 연락 체계 안내)" aria-label="새 항목" onInput=${(e) => setNewItem({ ...newItem, title: e.target.value })} />
                  <${Select} value=${newItem.phase} aria-label="단계" onChange=${(e) => setNewItem({ ...newItem, phase: e.target.value })} options=${PHASES} />
                  <${Select} value=${newItem.ownerRole} aria-label="담당" placeholder="담당 (선택)" onChange=${(e) => setNewItem({ ...newItem, ownerRole: e.target.value })} options=${OWNERS} />
                  <${Button} type="submit" icon="plus" loading=${adding}>추가</${Button}>
                </form>`
              : null}
          </${Card}>`
        : null}
    </div>
    ${modal?.kind === 'ai' && sel ? html`<${AiDraftModal} template=${sel} onClose=${() => setModal(null)} onAdded=${() => { setModal(null); reload(); }} />` : null}
    ${modal?.kind === 'item' ? html`<${ItemModal} item=${modal.item} onClose=${() => setModal(null)} onSaved=${() => { setModal(null); reload(); }} />` : null}
    ${modal?.kind === 'tpl' && sel ? html`<${TemplateModal} template=${sel} onClose=${() => setModal(null)} onSaved=${() => { setModal(null); reload(); }} />` : null}
    ${modal?.kind === 'newtpl' ? html`<${TemplateModal} onClose=${() => setModal(null)} onSaved=${(t) => { setModal(null); reload(); setQuery({ t: t.id }); }} />` : null}
  `;
}

// ---------------- 화면 ----------------
export default function OnboardingPage({ route }) {
  if (route.parts[1] === 'run' && route.parts[2]) return html`<${RunDetail} id=${route.parts[2]} key=${route.parts[2]} />`;
  return html`<${OnboardingList} route=${route} />`;
}

function OnboardingList({ route }) {
  const q = route.query;
  const tab = q.tab === 'templates' ? 'templates' : 'runs';
  const [starting, setStarting] = useState(false);
  const isManager = can('manager');
  return html`
    <${PageHeader}
      title="온보딩"
      desc="새 직원이 빨리 적응하도록 첫날·첫 주·첫 달에 챙길 일을 체크합니다."
      actions=${isManager ? html`<${Button} variant="primary" icon="user-plus" onClick=${() => setStarting(true)}>온보딩 시작</${Button}>` : null}
    />
    <${Tabs}
      value=${tab}
      onChange=${(t) => setQuery({ tab: t === 'runs' ? '' : t, status: '', t: '' })}
      items=${[
        { value: 'runs', label: '직원별 진행', icon: 'users' },
        { value: 'templates', label: '템플릿', icon: 'list-checks' },
      ]}
    />
    ${tab === 'runs' ? html`<${RunsTab} query=${q} onStart=${() => setStarting(true)} />` : html`<${TemplatesTab} query=${q} />`}
    ${starting ? html`<${StartModal} onClose=${() => setStarting(false)} onStarted=${(r) => { setStarting(false); navigate(`#/onboarding/run/${r.id}`); }} />` : null}
  `;
}
