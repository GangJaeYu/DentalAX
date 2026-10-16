/*
 * 이 파일이 하는 일: [C. 행정·서류] 회의록 화면입니다.
 *
 *   #/minutes               회의록 목록 + 오른쪽 "남은 할 일" (목록에서 바로 완료 체크)
 *   #/minutes/new           새 회의록: 날짜·제목·참석자 고르기 → 회의 메모를 붙여 넣고 [AI로 정리] → 요약·결정 사항·할 일 자동 정리
 *   #/minutes/12            회의록 보기: 요약, 할 일 체크리스트(누르면 바로 저장), 회의 내용, (실장 이상) 할 일을 공지로 올리기
 *   #/minutes/12/edit       회의록 고치기
 *   #/minutes/12/print      인쇄 화면 (결재란 포함 A4)
 */
import { html, useState, useEffect, fmtDate, fmtRelative, fmtDateTime, todayStr, toQuery, parseDate } from '../lib.js';
import { api } from '../api.js';
import { navigate, setQuery } from '../router.js';
import { can, toast, confirmDialog, session } from '../store.js';
import {
  PageHeader, Card, Button, Badge, Icon, Field, Input, Textarea, Checkbox, SearchInput, Seg,
  useApi, Loading, ErrorState, EmptyState, Pagination, Menu, Markdown, Progress, DdayBadge, IconButton,
  PiiBanner, useAI, AiResult, AiButton, PrintDoc, printNow,
} from '../ui/index.js';

/** 할 일 기한 배지 (끝난 일은 표시 안 함) */
function DueBadge({ item }) {
  if (item.done || item.dday === null || item.dday === undefined) return null;
  if (item.dday > 30) return html`<${Badge}>${fmtDate(item.due, { weekday: false })}</${Badge}>`;
  return html`<${DdayBadge} days=${item.dday} label=${item.dday === 0 ? '오늘까지' : item.dday < 0 ? `${-item.dday}일 지남` : undefined} />`;
}

/** 할 일 체크 버튼 (누르면 바로 서버에 저장) */
function ActionRow({ minutesId, item, onChanged, showMeeting }) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      const m = await api.patch(`/documents/minutes/${minutesId}/actions/${item.index}`, { done: !item.done });
      toast.success(item.done ? '완료를 취소했습니다.' : '완료로 표시했습니다.');
      onChanged && onChanged(m);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class=${`mins-action ${item.done ? 'done' : ''}`}>
    <button
      type="button"
      class="mins-action-check"
      aria-pressed=${item.done ? 'true' : 'false'}
      aria-label=${`${item.task} ${item.done ? '완료 취소' : '완료로 표시'}`}
      title=${item.done ? '완료 취소' : '완료로 표시'}
      disabled=${busy}
      onClick=${toggle}
    >
      ${item.done ? html`<${Icon} name="check" size=${14} stroke=${3} />` : null}
    </button>
    <div class="grow">
      <div class="mins-action-task">${item.task}</div>
      <div class="list-meta row wrap" style=${{ gap: '6px' }}>
        <span>${item.owner || '담당 미정'}</span>
        ${item.due ? html`<span>·</span><span>${fmtDate(item.due)}까지</span>` : null}
        ${showMeeting ? html`<span>·</span><a href=${`#/minutes/${minutesId}`}>${showMeeting}</a>` : null}
      </div>
    </div>
    <${DueBadge} item=${item} />
  </div>`;
}

function DateBlock({ date }) {
  const d = parseDate(date);
  return html`<div class="mins-date" aria-hidden="true">
    <span class="mins-date-m">${d.getMonth() + 1}월</span>
    <span class="mins-date-d">${d.getDate()}</span>
  </div>`;
}

// ---------------- 목록 ----------------
function MinutesList({ route }) {
  const q = route.query;
  const [search, setSearch] = useState(q.q || '');
  const [mineOnly, setMineOnly] = useState(false);
  const page = Number(q.page) || 1;
  const { data, loading, error, reload } = useApi(`/documents/minutes${toQuery({ q: q.q || '', open: q.open || '', page })}`);
  const me = session.user ? session.user.name : '';

  useEffect(() => {
    const t = setTimeout(() => {
      if ((q.q || '') !== search) setQuery({ q: search, page: '' });
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // 지금 보이는 회의록들의 안 끝난 할 일 (기한 빠른 순)
  const openItems = data
    ? data.rows
        .flatMap((m) => m.actionItems.filter((x) => !x.done).map((x) => ({ ...x, minutesId: m.id, meeting: m.title })))
        .filter((x) => !mineOnly || (me && x.owner.includes(me)) || /^(전원|전체|모두)$/.test(x.owner))
        .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'))
    : [];
  const filtered = !!(q.q || q.open);

  return html`
    <${PageHeader}
      title="회의록"
      desc="회의 메모를 붙여 넣으면 AI가 요약·결정 사항·할 일(담당자·기한)을 정리해 줍니다. 할 일은 여기서 바로 체크할 수 있습니다."
      actions=${html`<${Button} variant="primary" icon="plus" onClick=${() => navigate('#/minutes/new')}>새 회의록</${Button}>`}
    />
    <div class="mins-layout">
      <${Card} flush>
        <div class="docs-filter">
          <${SearchInput} value=${search} onInput=${setSearch} placeholder="제목·내용·참석자·할 일 검색" style=${{ maxWidth: '320px', flex: '1 1 220px' }} />
          <${Checkbox} label="남은 할 일이 있는 회의만" checked=${q.open === '1'} onChange=${(c) => setQuery({ open: c ? '1' : '', page: '' })} />
        </div>
        ${error && !data
          ? html`<${ErrorState} error=${error} onRetry=${reload} />`
          : loading && !data
            ? html`<${Loading} rows=${5} />`
            : !data.rows.length
              ? html`<${EmptyState}
                  icon="notebook-pen"
                  title=${filtered ? '조건에 맞는 회의록이 없습니다' : '아직 회의록이 없습니다'}
                  desc=${filtered ? '검색어나 필터를 바꿔 보세요.' : '회의 중 적은 메모만 있으면 AI가 회의록으로 정리해 줍니다.'}
                  action=${filtered
                    ? html`<${Button} icon="x" onClick=${() => { setSearch(''); setQuery({ q: '', open: '', page: '' }); }}>필터 지우기</${Button}>`
                    : html`<${Button} variant="primary" icon="plus" onClick=${() => navigate('#/minutes/new')}>새 회의록</${Button}>`}
                />`
              : html`<div class="list">
                  ${data.rows.map(
                    (m) => html`<a class="list-item" href=${`#/minutes/${m.id}`} key=${m.id}>
                      <${DateBlock} date=${m.meetingDate} />
                      <div class="grow">
                        <div class="row wrap" style=${{ gap: '6px' }}>
                          <span class="list-title ellipsis">${m.title}</span>
                          ${m.overdueCount ? html`<${Badge} color="red">기한 지남 ${m.overdueCount}</${Badge}>` : null}
                          ${m.dueSoonCount ? html`<${Badge} color="amber">임박 ${m.dueSoonCount}</${Badge}>` : null}
                        </div>
                        <div class="list-meta row wrap" style=${{ gap: '6px' }}>
                          <span>${fmtDate(m.meetingDate)}</span><span>·</span>
                          <span title=${m.attendees.join(', ')}>참석 ${m.attendees.length}명${m.attendees.length ? ` (${m.attendees.slice(0, 3).join(', ')}${m.attendees.length > 3 ? ' 외' : ''})` : ''}</span>
                          <span>·</span><span>${m.createdName}</span>
                        </div>
                      </div>
                      ${m.totalCount
                        ? html`<div class="mins-progress stack sm">
                            <span class="small muted num" style=${{ textAlign: 'right' }}>할 일 ${m.doneCount}/${m.totalCount}</span>
                            <${Progress} value=${m.doneCount} max=${m.totalCount} color=${m.doneCount === m.totalCount ? 'green' : m.overdueCount ? 'red' : undefined} label="할 일 진행률" />
                          </div>`
                        : html`<span class="small muted mins-progress" style=${{ textAlign: 'right' }}>할 일 없음</span>`}
                      <${Icon} name="chevron-right" size=${16} class="muted" />
                    </a>`
                  )}
                </div>
                <${Pagination} page=${data.page} size=${data.size} total=${data.total} onChange=${(p) => setQuery({ page: p })} />`}
      </${Card}>

      <${Card}
        title="남은 할 일"
        icon="list-checks"
        sub=${data ? `${openItems.length}건` : ''}
        flush
        actions=${html`<${Seg} label="보기" value=${mineOnly ? 'mine' : 'all'} onChange=${(v) => setMineOnly(v === 'mine')} items=${[{ value: 'all', label: '전체' }, { value: 'mine', label: '내 할 일' }]} />`}
      >
        ${error && !data
          ? html`<${ErrorState} compact error=${error} onRetry=${reload} />`
          : loading && !data
            ? html`<${Loading} rows=${4} />`
            : !openItems.length
              ? html`<${EmptyState} compact icon="circle-check" title=${mineOnly ? '나에게 남은 할 일이 없습니다' : '남은 할 일이 없습니다'} desc="회의에서 정한 일을 모두 마쳤습니다." />`
              : html`<div>
                  ${openItems.slice(0, 12).map((x) => html`<${ActionRow} key=${`${x.minutesId}-${x.index}`} minutesId=${x.minutesId} item=${x} showMeeting=${x.meeting} onChanged=${reload} />`)}
                  ${openItems.length > 12 ? html`<div class="small muted" style=${{ padding: '10px 18px' }}>그 밖에 ${openItems.length - 12}건이 더 있습니다.</div>` : null}
                </div>`}
      </${Card}>
    </div>
  `;
}

// ---------------- 상세 ----------------
function MinutesDetail({ id }) {
  const { data: m, loading, error, reload, setData } = useApi(`/documents/minutes/${id}`);
  const [posting, setPosting] = useState(false);

  if (error && !m) return html`<${ErrorState} error=${error} onRetry=${reload} />`;
  if (loading && !m) return html`<${Loading} />`;
  if (!m) return null;

  const open = m.actionItems.filter((x) => !x.done);

  const remove = async () => {
    if (!(await confirmDialog({ title: '이 회의록을 삭제할까요?', message: `"${m.title}" 회의록과 할 일 ${m.totalCount}건이 함께 지워지며 되돌릴 수 없습니다.`, danger: true, confirmText: '삭제' }))) return;
    try {
      await api.del(`/documents/minutes/${id}`);
      toast.success('삭제했습니다.');
      navigate('#/minutes');
    } catch (e) {
      toast.error(e.message);
    }
  };

  /** 남은 할 일을 공지·인수인계 보드에 공지로 올리기 (기존 공지 API 사용) */
  const postNotice = async () => {
    const lines = open.map((x) => `- [ ] ${x.task}${x.owner ? ` — 담당 ${x.owner}` : ''}${x.due ? ` (${fmtDate(x.due)}까지)` : ''}`);
    const body = [`${fmtDate(m.meetingDate, { long: true })} "${m.title}"에서 정한 할 일입니다. 담당자분들은 기한 안에 처리하고 회의록 메뉴에서 완료 체크해 주세요.`, '', ...lines].join('\n');
    const title = `[회의 후속] ${m.title} 할 일 ${open.length}건`.slice(0, 120);
    const ok = await confirmDialog({ title: '할 일을 공지로 올릴까요?', message: `제목: ${title}\n\n${lines.join('\n')}`, confirmText: '공지로 올리기' });
    if (!ok) return;
    setPosting(true);
    try {
      const p = await api.post('/board/posts', { kind: 'notice', title, body, importance: open.some((x) => x.dday !== null && x.dday < 0) ? 'important' : 'normal' });
      toast.success('공지로 올렸습니다.');
      navigate(`#/board/${p.id}`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setPosting(false);
    }
  };

  return html`
    <div class="row" style=${{ marginBottom: '12px' }}>
      <a href="#/minutes" class="btn btn-ghost btn-sm"><${Icon} name="arrow-left" size=${14} />회의록 목록</a>
    </div>
    <${PageHeader}
      title=${m.title}
      desc=${`${fmtDate(m.meetingDate, { long: true })} · 참석 ${m.attendees.length}명 · 작성 ${m.createdName}`}
      actions=${html`
        <${Button} icon="printer" onClick=${() => navigate(`#/minutes/${id}/print`)}>인쇄·PDF</${Button}>
        ${can('manager') && open.length ? html`<${Button} icon="megaphone" loading=${posting} onClick=${postNotice}>할 일을 공지로 올리기</${Button}>` : null}
        ${m.canEdit ? html`<${Button} variant="primary" icon="pencil" onClick=${() => navigate(`#/minutes/${id}/edit`)}>수정</${Button}>` : null}
        ${m.canEdit ? html`<${Menu} size="" buttonVariant="secondary" items=${[{ label: '삭제', icon: 'trash-2', danger: true, onClick: remove }]} />` : null}
      `}
    />
    <div class="grid detail-grid">
      <div class="stack lg">
        <${Card} title="요약" icon="sparkles">
          ${m.summary ? html`<p class="mins-summary pre">${m.summary}</p>` : html`<p class="muted">요약이 없습니다.</p>`}
        </${Card}>
        <${Card}
          title="할 일"
          icon="list-checks"
          sub=${m.totalCount ? `${m.doneCount}/${m.totalCount} 완료` : ''}
          flush
          actions=${m.totalCount ? html`<div style=${{ width: '120px' }}><${Progress} value=${m.doneCount} max=${m.totalCount} color=${m.doneCount === m.totalCount ? 'green' : undefined} label="할 일 진행률" /></div>` : null}
        >
          ${m.actionItems.length
            ? m.actionItems.map((x) => html`<${ActionRow} key=${x.index} minutesId=${m.id} item=${x} onChanged=${(nm) => setData(nm)} />`)
            : html`<${EmptyState} compact icon="list-checks" title="정해진 할 일이 없습니다" desc=${m.canEdit ? '[수정]에서 할 일을 추가할 수 있습니다.' : ''} />`}
        </${Card}>
        <${Card} title="회의 내용" icon="notebook-pen">
          ${m.content ? html`<${Markdown} text=${m.content} />` : html`<p class="muted">내용이 없습니다.</p>`}
        </${Card}>
      </div>
      <div class="stack lg">
        <${Card} title="참석자" sub=${`${m.attendees.length}명`}>
          ${m.attendees.length
            ? html`<div class="mins-chips">${m.attendees.map((n) => html`<${Badge}>${n}</${Badge}>`)}</div>`
            : html`<p class="small muted">기록된 참석자가 없습니다.</p>`}
        </${Card}>
        <${Card} title="기록 정보">
          <div class="stack sm small">
            <div class="row"><span class="muted grow">회의 날짜</span><span>${fmtDate(m.meetingDate)}</span></div>
            <div class="row"><span class="muted grow">작성</span><span>${m.createdName} · ${fmtDateTime(m.createdAt)}</span></div>
            <div class="row"><span class="muted grow">마지막 수정</span><span>${fmtRelative(m.updatedAt)}</span></div>
          </div>
        </${Card}>
      </div>
    </div>
  `;
}

// ---------------- 작성·수정 ----------------

/** AI 결과(JSON)를 사람이 읽기 좋은 마크다운으로 */
function toMarkdown(d) {
  if (!d) return '';
  const L = [];
  if (d.summary) L.push('## 요약', d.summary, '');
  if (d.decisions && d.decisions.length) L.push('## 결정 사항', ...d.decisions.map((x) => `- ${x}`), '');
  if (d.actionItems && d.actionItems.length) {
    L.push('## 할 일', ...d.actionItems.map((x) => `- [ ] ${x.task}${x.owner ? ` — **${x.owner}**` : ''}${x.due ? ` (${fmtDate(x.due)}까지)` : ''}`));
  }
  return L.join('\n').trim() || '정리할 내용을 찾지 못했습니다. 메모를 조금 더 자세히 적어 주세요.';
}

function MinutesEditor({ id }) {
  const isNew = !id;
  const remote = useApi(isNew ? null : `/documents/minutes/${id}`);
  const people = useApi('/admin/people');
  const [m, setM] = useState(isNew ? { title: '', meetingDate: todayStr(), attendees: [], summary: '', content: '', actionItems: [] } : null);
  const [notes, setNotes] = useState('');
  const [guest, setGuest] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [contentMode, setContentMode] = useState('edit');
  const ai = useAI('docs.minutes');

  useEffect(() => {
    if (remote.data) {
      const d = remote.data;
      setM({ title: d.title, meetingDate: d.meetingDate, attendees: d.attendees, summary: d.summary, content: d.content, actionItems: d.actionItems.map((x) => ({ task: x.task, owner: x.owner, due: x.due, done: x.done })) });
      setContentMode(d.content ? 'preview' : 'edit');
    }
  }, [remote.data]);

  if (remote.error && !m) return html`<${ErrorState} error=${remote.error} onRetry=${remote.reload} />`;
  if (!m) return html`<${Loading} />`;
  if (remote.data && !remote.data.canEdit) {
    return html`<${ErrorState} error=${{ message: '이 회의록은 작성자나 실장 이상만 고칠 수 있습니다.' }} />`;
  }

  const set = (k, v) => {
    setM((cur) => ({ ...cur, [k]: v }));
    setErrors((e) => ({ ...e, [k]: null }));
  };
  const names = (people.data || []).map((p) => p.name);
  const allNames = [...new Set([...names, ...m.attendees])];
  const toggleAttendee = (n) => set('attendees', m.attendees.includes(n) ? m.attendees.filter((x) => x !== n) : [...m.attendees, n]);
  const addGuest = () => {
    const n = guest.trim().replace(/,/g, '');
    if (!n) return;
    if (!m.attendees.includes(n)) set('attendees', [...m.attendees, n]);
    setGuest('');
  };
  const setItem = (i, k, v) => set('actionItems', m.actionItems.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const ownerOptions = [...new Set([...m.attendees, ...names, ...m.actionItems.map((x) => x.owner).filter(Boolean)])];

  const runAi = () => {
    if (notes.trim().length < 10) return toast.warn('회의 메모를 10자 이상 적어 주세요.');
    ai.run({ title: m.title, date: m.meetingDate || undefined, attendees: m.attendees.join(', '), notes });
  };

  /** AI 정리 결과를 회의록 칸에 넣기 */
  const applyAi = async (d) => {
    if (!d) return;
    const hasContent = m.summary.trim() || m.content.trim();
    if (hasContent && !(await confirmDialog({ title: '요약과 회의 내용을 바꿀까요?', message: '지금 적혀 있는 요약·회의 내용이 AI 정리 결과로 바뀝니다. 할 일은 기존 목록 뒤에 추가됩니다.', confirmText: '바꾸기' }))) return;
    const content = [d.decisions.length ? ['## 결정 사항', ...d.decisions.map((x) => `- ${x}`)].join('\n') : '', notes.trim() ? `## 회의 메모\n${notes.trim()}` : ''].filter(Boolean).join('\n\n');
    const existing = new Set(m.actionItems.map((x) => x.task));
    setM((cur) => ({
      ...cur,
      summary: d.summary || cur.summary,
      content: content || cur.content,
      actionItems: [...cur.actionItems, ...d.actionItems.filter((x) => !existing.has(x.task)).map((x) => ({ task: x.task, owner: x.owner, due: x.due, done: false }))],
    }));
    setContentMode('preview');
    ai.reset();
    toast.success('회의록에 넣었습니다. 확인하고 저장하세요.');
  };

  const save = async () => {
    if (busy) return;
    const errs = {};
    if (!m.title.trim()) errs.title = '회의 제목을 입력해 주세요.';
    if (!m.meetingDate) errs.meetingDate = '회의 날짜를 골라 주세요.';
    if (m.actionItems.some((x) => !x.task.trim())) errs.actionItems = '내용이 빈 할 일이 있습니다. 적거나 지워 주세요.';
    if (Object.keys(errs).length) {
      setErrors(errs);
      return toast.warn(Object.values(errs)[0]);
    }
    setBusy(true);
    try {
      const body = { ...m, actionItems: m.actionItems.map((x) => ({ task: x.task.trim(), owner: x.owner || '', due: x.due || null, done: !!x.done })) };
      const saved = isNew ? await api.post('/documents/minutes', body) : await api.patch(`/documents/minutes/${id}`, body);
      toast.success('회의록을 저장했습니다.');
      navigate(`#/minutes/${saved.id}`);
    } catch (e) {
      const field = e.data && e.data.field ? String(e.data.field).split(/[.[]/)[0] : null;
      if (field) setErrors({ [field]: e.message.replace(/^[^:]+:\s*/, '') });
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return html`
    <div class="row" style=${{ marginBottom: '12px' }}>
      <a href=${isNew ? '#/minutes' : `#/minutes/${id}`} class="btn btn-ghost btn-sm"><${Icon} name="arrow-left" size=${14} />${isNew ? '회의록 목록' : '회의록으로 돌아가기'}</a>
    </div>
    <${PageHeader}
      title=${isNew ? '새 회의록' : '회의록 수정'}
      desc="회의 메모를 붙여 넣고 [AI로 회의록 정리]를 누르면 요약·할 일·회의 내용이 채워집니다. 직접 적어도 됩니다."
      actions=${html`<${Button} variant="primary" icon="save" loading=${busy} onClick=${save}>저장</${Button}>`}
    />
    <div class="docs-workspace mins-workspace">
      <div class="docs-aside">
        <${Card} title="회의 정보" icon="calendar-days">
          <div class="stack">
            <${Field} label="회의 제목" required error=${errors.title}>
              <${Input} value=${m.title} onInput=${(e) => set('title', e.target.value)} placeholder="예: 11월 정기 직원회의" maxlength="150" />
            </${Field}>
            <${Field} label="회의 날짜" required error=${errors.meetingDate}>
              <${Input} type="date" value=${m.meetingDate} onInput=${(e) => set('meetingDate', e.target.value)} style=${{ maxWidth: '200px' }} />
            </${Field}>
            <div class="field">
              <div class="row between">
                <span class="label">참석자 <span class="muted" style=${{ fontWeight: 400 }}>${m.attendees.length}명</span></span>
                ${names.length
                  ? html`<${Button} size="sm" variant="ghost" onClick=${() => set('attendees', m.attendees.length >= names.length ? [] : [...new Set([...m.attendees, ...names])])}>${m.attendees.length >= names.length ? '모두 해제' : '모두 선택'}</${Button}>`
                  : null}
              </div>
              ${people.error
                ? html`<${ErrorState} compact error=${people.error} onRetry=${people.reload} />`
                : people.loading && !people.data
                  ? html`<${Loading} label="직원 목록을 불러오는 중…" />`
                  : html`<div class="mins-chips" role="group" aria-label="참석자 고르기">
                      ${allNames.map((n) => {
                        const p = (people.data || []).find((x) => x.name === n);
                        return html`<button type="button" class="mins-chip" aria-pressed=${m.attendees.includes(n) ? 'true' : 'false'} onClick=${() => toggleAttendee(n)}>
                          ${m.attendees.includes(n) ? html`<${Icon} name="check" size=${13} />` : html`<span class="dot" style=${{ background: (p && p.color) || 'var(--text-3)' }}></span>`}${n}
                        </button>`;
                      })}
                    </div>`}
              <div class="row mt-1">
                <${Input} size="sm" value=${guest} onInput=${(e) => setGuest(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && (e.preventDefault(), addGuest())} placeholder="외부 참석자 직접 추가 (예: 기공소 담당)" maxlength="30" aria-label="참석자 직접 추가" />
                <${Button} size="sm" icon="plus" onClick=${addGuest}>추가</${Button}>
              </div>
            </div>
          </div>
        </${Card}>
        <${Card} title="회의 메모 → AI 정리" icon="sparkles">
          <div class="stack">
            <${PiiBanner} />
            <${Field} label="회의 메모" hint="회의 중 적은 메모를 그대로 붙여 넣으세요. '이서연 10/20까지 ~'처럼 이름·날짜를 적으면 담당자와 기한도 찾아 줍니다.">
              <${Textarea}
                rows=${10}
                value=${notes}
                onInput=${(e) => setNotes(e.target.value)}
                placeholder=${'예)\n- 목요일 야간진료는 순번제로 하기로 결정\n- 이서연 10/20까지 야간 마감 체크리스트 작성\n- 최유나 다음 주 금요일까지 장갑 재고 확인\n- 주차 등록 방법 다시 공유'}
                maxlength="8000"
              />
            </${Field}>
            <${AiButton} block loading=${ai.busy} onClick=${runAi}>AI로 회의록 정리</${AiButton}>
            <${AiResult}
              ai=${{ ...ai, result: ai.result && { ...ai.result, text: toMarkdown(ai.result.data) } }}
              title="회의록 정리 결과"
              applyLabel="회의록에 넣기"
              onApply=${(text, r) => applyAi(r.data)}
            />
          </div>
        </${Card}>
      </div>

      <div class="stack lg">
        <${Card} title="요약">
          <${Field} error=${errors.summary}>
            <${Textarea} rows=${3} value=${m.summary} onInput=${(e) => set('summary', e.target.value)} placeholder="회의 전체를 2~3문장으로 (AI 정리를 누르면 자동으로 채워집니다)" aria-label="요약" maxlength="3000" />
          </${Field}>
        </${Card}>
        <${Card}
          title="할 일"
          icon="list-checks"
          sub=${m.actionItems.length ? `${m.actionItems.length}건` : ''}
          actions=${html`<${Button} size="sm" icon="plus" onClick=${() => set('actionItems', [...m.actionItems, { task: '', owner: '', due: '', done: false }])}>할 일 추가</${Button}>`}
        >
          ${errors.actionItems ? html`<div class="field-error" style=${{ marginBottom: '8px' }}>${errors.actionItems}</div>` : null}
          ${m.actionItems.length
            ? html`<div class="stack sm">
                <div class="mins-edit-row small muted strong desktop-only"><span>할 일</span><span>담당</span><span>기한</span><span></span></div>
                ${m.actionItems.map(
                  (x, i) => html`<div class="mins-edit-row" key=${i}>
                    <div class="row" style=${{ gap: '6px' }}>
                      <${Checkbox} label="" checked=${x.done} onChange=${(c) => setItem(i, 'done', c)} aria-label="완료" title="완료" />
                      <${Input} value=${x.task} onInput=${(e) => setItem(i, 'task', e.target.value)} placeholder="무엇을 할지 적어 주세요" aria-label=${`할 일 ${i + 1}`} maxlength="300" />
                    </div>
                    <select class="select" value=${x.owner} onChange=${(e) => setItem(i, 'owner', e.target.value)} aria-label=${`할 일 ${i + 1} 담당자`}>
                      <option value="">담당 미정</option>
                      <option value="전원">전원</option>
                      ${ownerOptions.map((n) => html`<option value=${n}>${n}</option>`)}
                    </select>
                    <div class="row" style=${{ gap: '4px' }}>
                      <${Input} type="date" value=${x.due || ''} onInput=${(e) => setItem(i, 'due', e.target.value)} aria-label=${`할 일 ${i + 1} 기한`} />
                    </div>
                    <${IconButton} icon="trash-2" label="이 할 일 지우기" onClick=${() => set('actionItems', m.actionItems.filter((_, j) => j !== i))} />
                  </div>`
                )}
              </div>`
            : html`<${EmptyState} compact icon="list-checks" title="아직 할 일이 없습니다" desc="AI 정리를 누르거나 [할 일 추가]로 직접 적어 주세요." />`}
        </${Card}>
        <${Card}
          title="회의 내용"
          icon="notebook-pen"
          actions=${html`<${Seg} label="보기 방식" value=${contentMode} onChange=${setContentMode} items=${[{ value: 'edit', label: '편집' }, { value: 'preview', label: '미리보기' }]} />`}
        >
          ${contentMode === 'edit'
            ? html`<${Textarea}
                rows=${12}
                value=${m.content}
                onInput=${(e) => set('content', e.target.value)}
                placeholder=${'논의 내용과 결정 사항을 적어 주세요.\n\n## 결정 사항\n- 야간진료는 순번제로 한다'}
                aria-label="회의 내용"
                maxlength="30000"
              />`
            : m.content.trim()
              ? html`<${Markdown} text=${m.content} />`
              : html`<${EmptyState} compact icon="notebook-pen" title="내용이 없습니다" desc="[편집]을 눌러 적어 주세요." />`}
        </${Card}>
      </div>
    </div>
  `;
}

// ---------------- 인쇄 ----------------
function MinutesPrint({ id }) {
  const { data: m, loading, error, reload } = useApi(`/documents/minutes/${id}`);
  if (error && !m) return html`<${ErrorState} error=${error} onRetry=${reload} />`;
  if (loading && !m) return html`<${Loading} />`;
  if (!m) return null;
  return html`
    <div class="docs-print-bar no-print">
      <a href=${`#/minutes/${id}`} class="btn btn-ghost btn-sm"><${Icon} name="arrow-left" size=${14} />회의록으로 돌아가기</a>
      <div class="grow"></div>
      <span class="small muted">인쇄 창에서 "PDF로 저장"을 고르면 PDF 파일이 됩니다.</span>
      <${Button} variant="primary" icon="printer" onClick=${printNow}>인쇄</${Button}>
    </div>
    <${PrintDoc} title="회 의 록" meta=${fmtDate(m.meetingDate, { long: true })}>
      <table class="paper-kv">
        <tbody>
          <tr><th>회의명</th><td>${m.title}</td></tr>
          <tr><th>일시</th><td>${fmtDate(m.meetingDate, { long: true })}</td></tr>
          <tr><th>참석자</th><td>${m.attendees.join(', ') || '-'} ${m.attendees.length ? `(${m.attendees.length}명)` : ''}</td></tr>
          <tr><th>작성자</th><td>${m.createdName}</td></tr>
        </tbody>
      </table>
      ${m.summary ? html`<div class="paper-section">요약</div><p class="pre">${m.summary}</p>` : null}
      ${m.content ? html`<div class="paper-section">회의 내용</div><${Markdown} text=${m.content} />` : null}
      ${m.actionItems.length
        ? html`<div class="paper-section">할 일</div>
            <table class="paper-table">
              <thead><tr><th style=${{ width: '36px' }}>번호</th><th>할 일</th><th style=${{ width: '90px' }}>담당</th><th style=${{ width: '110px' }}>기한</th><th style=${{ width: '50px' }}>완료</th></tr></thead>
              <tbody>
                ${m.actionItems.map(
                  (x, i) => html`<tr>
                    <td class="center num">${i + 1}</td>
                    <td>${x.task}</td>
                    <td>${x.owner || '-'}</td>
                    <td class="num">${x.due ? fmtDate(x.due) : '-'}</td>
                    <td class="center">${x.done ? '☑' : '☐'}</td>
                  </tr>`
                )}
              </tbody>
            </table>`
        : null}
      <div class="paper-sign" aria-label="결재란">
        <div><span>작성</span><i></i></div>
        <div><span>실장</span><i></i></div>
        <div><span>원장</span><i></i></div>
      </div>
    </${PrintDoc}>
  `;
}

export default function MinutesPage({ route }) {
  const [, id, sub] = route.parts;
  if (id === 'new') return html`<${MinutesEditor} key="new" />`;
  if (id && sub === 'edit') return html`<${MinutesEditor} id=${id} key=${`e${id}`} />`;
  if (id && sub === 'print') return html`<${MinutesPrint} id=${id} key=${`p${id}`} />`;
  if (id) return html`<${MinutesDetail} id=${id} key=${id} />`;
  return html`<${MinutesList} route=${route} />`;
}
