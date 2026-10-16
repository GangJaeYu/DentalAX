/*
 * 이 파일이 하는 일: [C. 행정·서류] AI 문서 작성기와 문서함 화면입니다.
 *
 *   #/documents              문서함 (검색, 종류·상태 필터, AI 도우미 참고 문서만 보기) + 위쪽 "빠른 시작" 종류 카드
 *   #/documents/new?kind=공문  새 문서: 왼쪽에서 목적·대상·핵심 메모를 적고 [AI로 초안 만들기] → 오른쪽 편집기에 넣기
 *   #/documents/12           문서 열기·고치기 (편집/미리보기 전환, AI 다듬기 4가지, 저장, 복제, 삭제)
 *   #/documents/12/print     인쇄 화면 (병원 머리글이 있는 A4 종이 모양. 인쇄 창에서 PDF로 저장 가능)
 */
import { html, useState, useEffect, useRef, fmtRelative, fmtDateTime, fmtDot, toDateStr, toQuery } from '../lib.js';
import { api } from '../api.js';
import { navigate, setQuery } from '../router.js';
import { can, toast, confirmDialog } from '../store.js';
import {
  PageHeader, Card, Button, Badge, Icon, Seg, Field, Input, Textarea, Select, Checkbox, SearchInput,
  useApi, Loading, ErrorState, EmptyState, Pagination, Menu, Markdown, Callout,
  PiiBanner, useAI, AiResult, AiButton, PrintDoc, printNow,
} from '../ui/index.js';

/** 문서 종류별 아이콘·색·설명·입력 예시 */
export const KINDS = [
  { value: '공문', icon: 'building-2', color: 'blue', desc: '수신·제목·붙임·발신 명의를 갖춘 공문서', purpose: '예: 거래처에 정기 납품 일정 변경 요청', audience: '예: 한빛덴탈 영업팀장', points: '- 매주 목요일 → 수요일 오후로 변경\n- 다음 달 첫째 주부터 적용' },
  { value: '안내문', icon: 'megaphone', color: 'amber', desc: '환자·방문객에게 알리는 안내문', purpose: '예: 11월부터 목요일 야간진료 시작 안내', audience: '예: 내원 환자', points: '- 매주 목요일 20시까지 진료\n- 11월 첫째 주부터' },
  { value: '내부 규정', icon: 'shield-check', color: 'purple', desc: '제1조·제2조 조항 형식의 원내 규정', purpose: '예: 진료 중 휴대폰 사용 규정', audience: '예: 전 직원', points: '- 진료실 안에서는 휴대폰 사용 금지\n- 휴게시간에만 사용' },
  { value: '업무 매뉴얼', icon: 'book-open', color: 'green', desc: '누가 해도 같은 순서로 하는 단계별 절차', purpose: '예: 마감 시 석션 라인 세척 방법', audience: '예: 진료실 담당 치과위생사', points: '- 세척액 준비\n- 체어별로 1분씩 흘려보내기\n- 필터 확인 후 기록' },
  { value: '교육 자료', icon: 'graduation-cap', color: 'blue', desc: '학습 목표·핵심 내용·확인 문제', purpose: '예: 신규 직원 감염관리 기초 교육', audience: '예: 신규 입사자', points: '- 손 위생 시점\n- 보호구 착용 순서\n- 날카로운 것에 찔렸을 때' },
  { value: '채용 공고', icon: 'user-plus', color: 'red', desc: '모집 분야·자격·근무 조건·지원 방법', purpose: '예: 치과위생사 1명 채용', audience: '예: 치과위생사 (경력 무관)', points: '- 주 5일 근무\n- 목요일 야간진료 순번제\n- 신입 교육 있음' },
  { value: '기타', icon: 'file-text', color: '', desc: '그 밖의 업무 문서', purpose: '예: 원내 행사 준비 사항 정리', audience: '', points: '- 핵심 내용을 한 줄씩 적어 주세요' },
];
export const kindMeta = (k) => KINDS.find((x) => x.value === k) || KINDS[KINDS.length - 1];

const STATUS = { draft: { label: '작성 중', color: 'amber' }, final: { label: '완료', color: 'green' } };
const REVISE = [
  { mode: 'rewrite', label: '다시 쓰기', icon: 'refresh-cw' },
  { mode: 'shorter', label: '더 짧게', icon: 'minus' },
  { mode: 'politer', label: '더 정중하게', icon: 'message-square-text' },
  { mode: 'proofread', label: '맞춤법·문장 다듬기', icon: 'wand-sparkles' },
];

function StatusBadge({ status }) {
  const s = STATUS[status] || STATUS.draft;
  return html`<${Badge} color=${s.color} dot>${s.label}</${Badge}>`;
}

function KbBadge() {
  return html`<${Badge} color="purple" title="원내 AI 도우미가 이 문서를 참고해 답합니다"><${Icon} name="bot" size=${12} />AI 참고</${Badge}>`;
}

/** 복제 → 새 문서로 이동 */
async function duplicateDoc(id) {
  try {
    const d = await api.post(`/documents/docs/${id}/duplicate`);
    toast.success('사본을 만들었습니다.');
    navigate(`#/documents/${d.id}`);
  } catch (e) {
    toast.error(e.message);
  }
}

async function removeDoc(doc, after) {
  const ok = await confirmDialog({
    title: '이 문서를 삭제할까요?',
    message: `"${doc.title}" 문서를 지우면 되돌릴 수 없습니다.${doc.includeInKb ? '\nAI 도우미도 더 이상 이 문서를 참고하지 않습니다.' : ''}`,
    danger: true,
    confirmText: '삭제',
  });
  if (!ok) return;
  try {
    await api.del(`/documents/docs/${doc.id}`);
    toast.success('삭제했습니다.');
    after && after();
  } catch (e) {
    toast.error(e.message);
  }
}

// ---------------- 문서함 (목록) ----------------
function DocList({ route }) {
  const q = route.query;
  const [search, setSearch] = useState(q.q || '');
  const page = Number(q.page) || 1;
  const params = { q: q.q || '', kind: q.kind || '', status: q.status || '', kb: q.kb || '', page };
  const { data, loading, error, reload } = useApi(`/documents/docs${toQuery(params)}`);
  const filtered = !!(q.q || q.kind || q.status || q.kb);

  useEffect(() => {
    const t = setTimeout(() => {
      if ((q.q || '') !== search) setQuery({ q: search, page: '' });
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const counts = (data && data.counts) || {};
  const newDoc = (kind) => navigate(`#/documents/new${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`);

  return html`
    <${PageHeader}
      title="AI 문서 작성"
      desc="목적과 핵심 메모만 적으면 AI가 공문·안내문·규정·매뉴얼 초안을 써 줍니다. 저장한 문서는 문서함에서 다시 고치고 인쇄할 수 있습니다."
      actions=${html`<${Button} variant="primary" icon="plus" onClick=${() => newDoc('')}>새 문서</${Button}>`}
    />
    <div class="docs-kinds" role="list" aria-label="문서 종류를 골라 바로 시작">
      ${KINDS.map(
        (k) => html`<button type="button" class="docs-kind" role="listitem" onClick=${() => newDoc(k.value)}>
          <span class=${`icon-box ${k.color}`}><${Icon} name=${k.icon} size=${16} /></span>
          <span class="docs-kind-name">${k.value}</span>
          <span class="docs-kind-desc">${k.desc}</span>
        </button>`
      )}
    </div>

    <${Card} flush title="문서함" icon="archive" sub=${data ? `전체 ${data.totalAll}건 · AI 참고 ${data.kbCount}건` : ''}>
      <div class="docs-filter">
        <${SearchInput} value=${search} onInput=${setSearch} placeholder="제목·내용·꼬리표 검색" style=${{ maxWidth: '280px', flex: '1 1 200px' }} />
        <${Select}
          value=${q.kind || ''}
          onChange=${(e) => setQuery({ kind: e.target.value, page: '' })}
          placeholder="모든 종류"
          options=${KINDS.map((k) => ({ value: k.value, label: `${k.value}${counts[k.value] ? ` (${counts[k.value]})` : ''}` }))}
          aria-label="문서 종류"
          style=${{ width: '160px' }}
        />
        <${Seg}
          label="상태"
          value=${q.status || ''}
          onChange=${(v) => setQuery({ status: v, page: '' })}
          items=${[
            { value: '', label: '전체' },
            { value: 'draft', label: '작성 중' },
            { value: 'final', label: '완료' },
          ]}
        />
        <${Checkbox} label="AI 도우미 참고 문서만" checked=${q.kb === '1'} onChange=${(c) => setQuery({ kb: c ? '1' : '', page: '' })} />
      </div>
      ${error && !data
        ? html`<${ErrorState} error=${error} onRetry=${reload} />`
        : loading && !data
          ? html`<${Loading} rows=${6} />`
          : !data.rows.length
            ? html`<${EmptyState}
                icon="file-text"
                title=${filtered ? '조건에 맞는 문서가 없습니다' : '아직 저장한 문서가 없습니다'}
                desc=${filtered ? '검색어나 필터를 바꿔 보세요.' : '위에서 문서 종류를 고르면 AI가 초안을 써 줍니다.'}
                action=${filtered
                  ? html`<${Button} icon="x" onClick=${() => { setSearch(''); setQuery({ q: '', kind: '', status: '', kb: '', page: '' }); }}>필터 지우기</${Button}>`
                  : html`<${Button} variant="primary" icon="plus" onClick=${() => newDoc('')}>새 문서</${Button}>`}
              />`
            : html`<div class="list">
                ${data.rows.map((d) => {
                  const k = kindMeta(d.kind);
                  return html`<div class="list-item docs-row" key=${d.id}>
                    <a class="docs-row-link" href=${`#/documents/${d.id}`}>
                      <span class=${`icon-box ${k.color}`}><${Icon} name=${k.icon} size=${16} /></span>
                      <span class="grow">
                        <span class="row wrap" style=${{ gap: '6px' }}>
                          <span class="list-title ellipsis">${d.title}</span>
                          <${StatusBadge} status=${d.status} />
                          ${d.includeInKb ? html`<${KbBadge} />` : null}
                        </span>
                        ${d.excerpt ? html`<div class="docs-excerpt ellipsis">${d.excerpt}</div>` : null}
                        <span class="list-meta row wrap" style=${{ gap: '6px' }}>
                          <span>${d.kind}</span><span>·</span><span>${d.updatedName}</span><span>·</span><span>${fmtRelative(d.updatedAt)} 수정</span>
                          ${d.tags.length ? html`<span>·</span><span class="docs-tag">${d.tags.map((t) => `#${t}`).join(' ')}</span>` : null}
                        </span>
                      </span>
                    </a>
                    <${Menu}
                      label=${`${d.title} 메뉴`}
                      items=${[
                        { label: '열기', icon: 'pencil', onClick: () => navigate(`#/documents/${d.id}`) },
                        { label: '인쇄·PDF', icon: 'printer', onClick: () => navigate(`#/documents/${d.id}/print`) },
                        { label: '복제', icon: 'copy', onClick: () => duplicateDoc(d.id) },
                        d.canEdit && '-',
                        d.canEdit && { label: '삭제', icon: 'trash-2', danger: true, onClick: () => removeDoc(d, reload) },
                      ].filter(Boolean)}
                    />
                  </div>`;
                })}
              </div>
              <${Pagination} page=${data.page} size=${data.size} total=${data.total} onChange=${(p) => setQuery({ page: p })} />`}
    </${Card}>
  `;
}

// ---------------- AI 초안 만들기 (왼쪽 칸) ----------------
function WriterPanel({ kind, onKind, onApply, collapsed: startCollapsed }) {
  const ai = useAI('docs.write');
  const [open, setOpen] = useState(!startCollapsed);
  const [form, setForm] = useState({ purpose: '', audience: '', points: '', tone: '정중', length: '보통' });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const k = kindMeta(kind);
  const purposeRef = useRef();

  useEffect(() => {
    // 사용자가 이미 다른 입력칸에서 쓰고 있으면 초점을 빼앗지 않음
    const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (open && !startCollapsed) setTimeout(() => !typing() && purposeRef.current && purposeRef.current.focus(), 50);
  }, [open]);

  const run = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (form.purpose.trim().length < 2) {
      toast.warn('문서의 목적을 먼저 적어 주세요.');
      purposeRef.current && purposeRef.current.focus();
      return;
    }
    ai.run({ kind, ...form });
  };

  return html`<${Card}
    title="AI 초안 만들기"
    icon="sparkles"
    actions=${startCollapsed ? html`<${Button} size="sm" variant="ghost" iconRight=${open ? 'chevron-up' : 'chevron-down'} onClick=${() => setOpen(!open)}>${open ? '접기' : '펼치기'}</${Button}>` : null}
  >
    ${!open
      ? html`<p class="small muted">목적과 핵심 메모로 새 초안을 만들어 지금 내용과 바꿀 수 있습니다.</p>`
      : html`<form class="stack" onSubmit=${run}>
          <${Field} label="문서 종류">
            <${Select} value=${kind} onChange=${(e) => onKind(e.target.value)} options=${KINDS.map((x) => x.value)} />
          </${Field}>
          <${PiiBanner} />
          <${Field} label="목적" required hint="무엇을 위한 문서인지 한 줄로">
            <input class="input" ref=${purposeRef} value=${form.purpose} onInput=${(e) => set('purpose', e.target.value)} placeholder=${k.purpose} maxlength="500" />
          </${Field}>
          <${Field} label="받는 사람 / 대상">
            <${Input} value=${form.audience} onInput=${(e) => set('audience', e.target.value)} placeholder=${k.audience || '예: 전 직원'} maxlength="200" />
          </${Field}>
          <${Field} label="핵심 내용" hint="한 줄에 하나씩 대충 적어도 됩니다. 날짜·시간·숫자는 그대로 들어갑니다.">
            <${Textarea} rows=${5} value=${form.points} onInput=${(e) => set('points', e.target.value)} placeholder=${k.points} maxlength="4000" />
          </${Field}>
          <div class="row wrap between">
            <${Field} label="어조">
              <${Seg} label="어조" value=${form.tone} onChange=${(v) => set('tone', v)} items=${['정중', '친근', '공식'].map((x) => ({ value: x, label: x }))} />
            </${Field}>
            <${Field} label="분량">
              <${Seg} label="분량" value=${form.length} onChange=${(v) => set('length', v)} items=${['짧게', '보통', '자세히'].map((x) => ({ value: x, label: x }))} />
            </${Field}>
          </div>
          <${AiButton} type="submit" block loading=${ai.busy}>AI로 초안 만들기</${AiButton}>
          <${AiResult}
            ai=${ai}
            title=${`${kind} 초안`}
            applyLabel="편집기에 넣기"
            onApply=${async (text, r) => {
              const ok = await onApply(r.data || { title: '', content: text });
              if (ok) ai.reset();
            }}
          />
        </form>`}
  </${Card}>`;
}

// ---------------- 문서 편집 ----------------
function DocEditor({ id, route }) {
  const isNew = id === 'new';
  const remote = useApi(isNew ? null : `/documents/docs/${id}`);
  const startKind = KINDS.some((k) => k.value === route.query.kind) ? route.query.kind : '안내문';
  const blank = { kind: startKind, title: '', content: '', status: 'draft', tags: '', includeInKb: false };
  const [doc, setDoc] = useState(isNew ? blank : null);
  const [savedSnap, setSavedSnap] = useState(isNew ? JSON.stringify(blank) : null);
  const [mode, setMode] = useState(isNew ? 'edit' : 'preview');
  const [busy, setBusy] = useState(false);
  const [titleError, setTitleError] = useState('');
  const revise = useAI('docs.revise');
  const [reviseMode, setReviseMode] = useState(null);
  const isManager = can('manager');

  // 서버에서 불러온 문서를 편집용 값으로
  useEffect(() => {
    if (remote.data) {
      const d = remote.data;
      const v = { kind: d.kind, title: d.title, content: d.content, status: d.status, tags: d.tags.join(', '), includeInKb: d.includeInKb };
      setDoc(v);
      setSavedSnap(JSON.stringify(v));
    }
  }, [remote.data]);

  const dirty = doc && savedSnap !== JSON.stringify(doc);
  const set = (k, v) => setDoc((d) => ({ ...d, [k]: v }));
  const canEdit = isNew || (remote.data && remote.data.canEdit);

  // 저장하지 않고 창을 닫으려 하면 브라우저가 한 번 물어봄
  useEffect(() => {
    if (!dirty) return;
    const fn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', fn);
    return () => window.removeEventListener('beforeunload', fn);
  }, [dirty]);

  const save = async () => {
    if (busy || !doc) return;
    if (!doc.title.trim()) {
      setTitleError('제목을 입력해 주세요.');
      toast.warn('제목을 입력해 주세요.');
      return;
    }
    setBusy(true);
    try {
      const body = { ...doc };
      if (!isManager) delete body.includeInKb;
      const saved = isNew ? await api.post('/documents/docs', body) : await api.patch(`/documents/docs/${id}`, body);
      const v = { kind: saved.kind, title: saved.title, content: saved.content, status: saved.status, tags: saved.tags.join(', '), includeInKb: saved.includeInKb };
      setSavedSnap(JSON.stringify(v));
      setDoc(v);
      toast.success(isNew ? '문서함에 저장했습니다.' : '저장했습니다.');
      if (isNew) navigate(`#/documents/${saved.id}`);
      else remote.setData(saved);
    } catch (e) {
      if (e.data && e.data.field === 'title') setTitleError(e.message.replace(/^[^:]+:\s*/, ''));
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Ctrl+S 로 저장
  useEffect(() => {
    const fn = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (canEdit) save();
      }
    };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  });

  if (remote.error && !doc) return html`<${ErrorState} error=${remote.error} onRetry=${remote.reload} />`;
  if (!doc) return html`<${Loading} />`;

  /** AI 초안을 편집기에 넣기 (이미 쓴 내용이 있으면 한 번 물어봄) */
  const applyDraft = async (d) => {
    if (doc.content.trim() && doc.content.trim() !== String(d.content || '').trim()) {
      const ok = await confirmDialog({ title: '지금 내용을 AI 초안으로 바꿀까요?', message: '편집기에 있는 글이 AI 초안으로 바뀝니다. 저장하기 전까지는 되돌릴 수 없으니 필요하면 먼저 복사해 두세요.', confirmText: '바꾸기' });
      if (!ok) return false;
    }
    setDoc((cur) => ({ ...cur, title: d.title && (!cur.title.trim() || isNew) ? d.title : cur.title, content: d.content || '' }));
    setTitleError('');
    setMode('edit');
    toast.success('AI 초안을 넣었습니다. 확인하고 고친 뒤 저장하세요.');
    return true;
  };

  const runRevise = (m) => {
    if (doc.content.trim().length < 2) return toast.warn('먼저 본문을 쓰거나 AI 초안을 넣어 주세요.');
    setReviseMode(m);
    revise.run({ mode: m, text: doc.content, kind: doc.kind });
  };

  const k = kindMeta(doc.kind);
  const r = remote.data;
  const reviseLabel = (REVISE.find((x) => x.mode === reviseMode) || {}).label;

  return html`
    <div class="row wrap" style=${{ marginBottom: '12px' }}>
      <a href="#/documents" class="btn btn-ghost btn-sm"><${Icon} name="arrow-left" size=${14} />문서함</a>
      <div class="grow"></div>
      ${dirty ? html`<span class="docs-dirty"><span class="dot amber"></span>저장하지 않은 변경 사항</span>` : !isNew ? html`<span class="small muted">저장됨</span>` : null}
    </div>
    <${PageHeader}
      title=${isNew ? '새 문서' : '문서 편집'}
      desc=${isNew ? '목적과 핵심 메모를 적고 [AI로 초안 만들기]를 누르세요. 직접 써도 됩니다.' : null}
      actions=${html`
        ${!isNew ? html`<${Button} icon="printer" onClick=${() => (dirty ? toast.warn('먼저 저장한 뒤 인쇄해 주세요.') : navigate(`#/documents/${id}/print`))}>인쇄·PDF</${Button}>` : null}
        ${canEdit ? html`<${Button} variant="primary" icon="save" loading=${busy} onClick=${save}>${isNew ? '문서함에 저장' : '저장'}</${Button}>` : null}
        ${!isNew
          ? html`<${Menu} size="" buttonVariant="secondary" items=${[
              { label: '복제 (사본 만들기)', icon: 'copy', onClick: () => duplicateDoc(id) },
              r && r.canEdit && '-',
              r && r.canEdit && { label: '삭제', icon: 'trash-2', danger: true, onClick: () => removeDoc(r, () => navigate('#/documents')) },
            ].filter(Boolean)} />`
          : null}
      `}
    />
    ${!canEdit ? html`<${Callout} kind="info" class="mt-0">다른 사람이 쓴 문서라 읽기만 할 수 있습니다. 고치려면 [복제]로 사본을 만들어 쓰세요.</${Callout}>` : null}
    <div class="docs-workspace" style=${{ marginTop: canEdit ? 0 : '12px' }}>
      <aside class="docs-aside">
        ${canEdit ? html`<${WriterPanel} kind=${doc.kind} onKind=${(v) => set('kind', v)} onApply=${applyDraft} collapsed=${!isNew} key=${isNew ? 'new' : id} />` : null}
        <${Card} title="문서 설정" icon="settings">
          <div class="stack">
            <${Field} label="종류">
              <${Select} value=${doc.kind} disabled=${!canEdit} onChange=${(e) => set('kind', e.target.value)} options=${KINDS.map((x) => x.value)} />
            </${Field}>
            <${Field} label="상태">
              <${Seg}
                label="상태"
                value=${doc.status}
                onChange=${(v) => canEdit && set('status', v)}
                items=${[
                  { value: 'draft', label: '작성 중' },
                  { value: 'final', label: '완료' },
                ]}
              />
            </${Field}>
            <${Field} label="꼬리표" hint="쉼표로 구분 (예: 감염관리, 필수)">
              <${Input} value=${doc.tags} disabled=${!canEdit} onInput=${(e) => set('tags', e.target.value)} placeholder="예: 데스크, 전화" maxlength="300" />
            </${Field}>
            ${isManager
              ? html`<div class="docs-kb-box">
                  <${Icon} name="bot" size=${18} class="muted" />
                  <div class="stack sm grow">
                    <${Checkbox} label="원내 AI 도우미가 참고" checked=${doc.includeInKb} disabled=${!canEdit} onChange=${(c) => set('includeInKb', c)} />
                    <span class="small muted">켜 두면 직원이 원내 AI 도우미에 질문할 때 이 문서를 근거로 답합니다. 규정·매뉴얼처럼 확정된 문서에 켜 주세요.</span>
                  </div>
                </div>`
              : doc.includeInKb
                ? html`<div class="docs-kb-box"><${Icon} name="bot" size=${18} class="muted" /><span class="small">원내 AI 도우미가 참고하는 문서입니다. (설정은 실장 이상)</span></div>`
                : null}
            ${r
              ? html`<div class="docs-meta-line">
                  <span>작성 ${r.createdName} · ${fmtDateTime(r.createdAt)}</span>
                  <span>마지막 수정 ${r.updatedName} · ${fmtRelative(r.updatedAt)}</span>
                </div>`
              : null}
          </div>
        </${Card}>
      </aside>

      <section class="card" aria-label="문서 편집기">
        <div class="docs-head">
          <input
            class="docs-title-input"
            value=${doc.title}
            readonly=${!canEdit}
            onInput=${(e) => {
              set('title', e.target.value);
              setTitleError('');
            }}
            placeholder="제목 (AI 초안을 넣으면 자동으로 채워집니다)"
            aria-label="문서 제목"
            aria-invalid=${titleError ? 'true' : undefined}
            maxlength="150"
          />
          ${titleError ? html`<div class="field-error">${titleError}</div>` : null}
          <div class="row wrap" style=${{ gap: '6px', marginTop: '4px' }}>
            <${Badge} color=${k.color || undefined}><${Icon} name=${k.icon} size=${12} />${doc.kind}</${Badge}>
            <${StatusBadge} status=${doc.status} />
            ${doc.includeInKb ? html`<${KbBadge} />` : null}
            <span class="small muted">${doc.content.length.toLocaleString('ko-KR')}자</span>
          </div>
        </div>
        <div class="docs-toolbar">
          <${Seg}
            label="보기 방식"
            value=${mode}
            onChange=${setMode}
            items=${[
              { value: 'edit', label: '편집' },
              { value: 'preview', label: '미리보기' },
            ]}
          />
          <div class="grow"></div>
          ${canEdit
            ? html`<span class="docs-toolbar-label"><${Icon} name="sparkles" size=${13} />AI 다듬기</span>
                ${REVISE.map(
                  (x) => html`<${Button} size="sm" variant="ghost" icon=${x.icon} disabled=${revise.busy} loading=${revise.busy && reviseMode === x.mode} onClick=${() => runRevise(x.mode)}>${x.label}</${Button}>`
                )}`
            : null}
        </div>
        ${canEdit
          ? html`<div class="docs-revise-box" hidden=${!(revise.busy || revise.result || revise.error)}>
              <${AiResult}
                ai=${revise}
                title=${`AI 다듬기 · ${reviseLabel || ''}`}
                applyLabel="이 내용으로 바꾸기"
                onApply=${(text, res) => {
                  set('content', (res.data && res.data.content) || text);
                  revise.reset();
                  setMode('edit');
                  toast.success('본문을 바꿨습니다. 확인 후 저장하세요.');
                }}
                extra=${html`<div class="row"><${Button} size="sm" variant="ghost" icon="x" onClick=${revise.reset}>닫기 (지금 내용 유지)</${Button}></div>`}
              />
            </div>`
          : null}
        ${mode === 'edit' && canEdit
          ? html`<div>
              <div style=${{ padding: '8px 14px 0' }}><${PiiBanner} compact /></div>
              <textarea
                class="docs-editor"
                value=${doc.content}
                onInput=${(e) => set('content', e.target.value)}
                placeholder=${'본문을 직접 쓰거나, [AI 초안 만들기]로 만든 초안을 넣으세요.\n\n# 큰 제목   ## 작은 제목   - 목록   **굵게**  처럼 쓰면 미리보기와 인쇄에서 보기 좋게 바뀝니다.'}
                aria-label="문서 본문"
                spellcheck="false"
              ></textarea>
            </div>`
          : html`<div class="docs-preview">
              ${doc.content.trim()
                ? html`<${Markdown} text=${doc.content} />`
                : html`<${EmptyState} compact icon="file-text" title="아직 본문이 없습니다" desc=${canEdit ? '[편집]을 눌러 쓰거나 AI 초안을 만들어 보세요.' : ''} />`}
            </div>`}
      </section>
    </div>
  `;
}

// ---------------- 인쇄 화면 ----------------
function DocPrint({ id }) {
  const { data: d, loading, error, reload } = useApi(`/documents/docs/${id}`);
  if (error && !d) return html`<${ErrorState} error=${error} onRetry=${reload} />`;
  if (loading && !d) return html`<${Loading} />`;
  if (!d) return null;
  // 공문은 본문 안에 "제목:" 줄이 있으므로 가운데 큰 제목을 따로 넣지 않음
  const showTitle = d.kind !== '공문';
  return html`
    <div class="docs-print-bar no-print">
      <a href=${`#/documents/${id}`} class="btn btn-ghost btn-sm"><${Icon} name="arrow-left" size=${14} />문서로 돌아가기</a>
      <div class="grow"></div>
      <span class="small muted">인쇄 창에서 대상을 "PDF로 저장"으로 고르면 PDF 파일이 됩니다.</span>
      <${Button} variant="primary" icon="printer" onClick=${printNow}>인쇄</${Button}>
    </div>
    <${PrintDoc} title=${showTitle ? d.title : null} meta=${`${d.kind}\n${fmtDot(toDateStr(new Date(d.updatedAt)))}`}>
      ${d.content.trim() ? html`<${Markdown} text=${d.content} />` : html`<p class="muted">(본문 없음)</p>`}
    </${PrintDoc}>
  `;
}

export default function DocumentsPage({ route }) {
  const [, id, sub] = route.parts;
  if (id && sub === 'print') return html`<${DocPrint} id=${id} key=${`p${id}`} />`;
  if (id) return html`<${DocEditor} id=${id} route=${route} key=${id} />`;
  return html`<${DocList} route=${route} />`;
}
