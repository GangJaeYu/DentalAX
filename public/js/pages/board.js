/*
 * 이 파일이 하는 일: [A. 데스크] 공지·인수인계 보드 화면입니다. (다른 화면을 만들 때 본보기)
 *
 *   #/board          목록 (탭: 전체/공지/인수인계/보관함, 검색, 안 읽은 글만)
 *   #/board/12       글 상세 (열면 자동으로 읽음 처리, 읽은 사람/안 읽은 사람 표시)
 *   [새 글] 버튼     작성 창. 메모를 대충 적고 [AI로 다듬기]를 누르면 깔끔한 글로 바꿔 줌
 */
import { html, useState, useEffect, fmtRelative, fmtDateTime, fmtDate, toQuery, daysUntil } from '../lib.js';
import { api } from '../api.js';
import { navigate, setQuery } from '../router.js';
import { can, toast, confirmDialog } from '../store.js';
import {
  PageHeader, Card, Button, Badge, Icon, Tabs, Seg, Modal, Field, Input, Textarea, Checkbox, SearchInput,
  useApi, useForm, Loading, ErrorState, EmptyState, Pagination, Menu, Avatar, Markdown,
  PiiBanner, useAI, AiResult, AiButton, DdayBadge,
} from '../ui/index.js';

const IMPORTANCE = {
  normal: { label: '일반', color: 'gray' },
  important: { label: '중요', color: 'amber' },
  urgent: { label: '긴급', color: 'red' },
};

function ImportanceBadge({ value }) {
  if (!value || value === 'normal') return null;
  const i = IMPORTANCE[value];
  return html`<${Badge} color=${i.color}>${i.label}</${Badge}>`;
}

// ---------------- 작성/수정 창 ----------------
function PostEditor({ open, onClose, post, defaultKind, onSaved }) {
  const isManager = can('manager');
  const f = useForm(
    post
      ? { kind: post.kind, title: post.title, body: post.body, importance: post.importance, pinned: post.pinned, dueDate: post.dueDate || '' }
      : { kind: defaultKind || (isManager ? 'notice' : 'handover'), title: '', body: '', importance: 'normal', pinned: false, dueDate: '' }
  );
  const ai = useAI('board.polish');
  const [showAi, setShowAi] = useState(false);

  const save = f.submit(async (v) => {
    const body = { ...v, dueDate: v.kind === 'handover' ? v.dueDate || null : null };
    const saved = post ? await api.patch(`/board/posts/${post.id}`, body) : await api.post('/board/posts', body);
    toast.success(post ? '수정했습니다.' : '등록했습니다.');
    onSaved(saved);
  });

  const runAi = () => {
    const text = [f.values.title, f.values.body].filter(Boolean).join('\n');
    if (text.trim().length < 2) return toast.warn('먼저 메모를 몇 줄 적어 주세요.');
    setShowAi(true);
    ai.run({ kind: f.values.kind, text });
  };

  return html`<${Modal}
    open=${open}
    size="lg"
    title=${post ? '글 수정' : '새 글 쓰기'}
    onClose=${onClose}
    busy=${f.busy}
    footer=${html`
      <${Button} onClick=${onClose}>취소</${Button}>
      <${Button} variant="primary" loading=${f.busy} onClick=${save}>${post ? '저장' : '등록'}</${Button}>
    `}
  >
    <form class="stack" onSubmit=${save}>
      <div class="row wrap between">
        <${Seg}
          label="종류"
          value=${f.values.kind}
          onChange=${(k) => {
            if (k === 'notice' && !isManager) return toast.warn('공지는 실장 이상만 쓸 수 있습니다. 인수인계로 작성해 주세요.');
            f.set('kind', k);
          }}
          items=${[
            { value: 'notice', label: '공지' },
            { value: 'handover', label: '인수인계' },
          ]}
        />
        <${Seg}
          label="중요도"
          value=${f.values.importance}
          onChange=${(v) => f.set('importance', v)}
          items=${Object.entries(IMPORTANCE).map(([value, i]) => ({ value, label: i.label }))}
        />
      </div>
      <${Field} label="제목" required error=${f.errors.title}>
        <${Input} ...${f.bind('title')} placeholder=${f.values.kind === 'notice' ? '예: 11월 진료시간 변경 안내' : '예: 기공물 도착 확인 부탁드립니다'} maxlength="120" />
      </${Field}>
      <${Field} label="내용" error=${f.errors.body} hint="대충 메모처럼 적고 아래 [AI로 다듬기]를 눌러도 됩니다.">
        <${Textarea} ...${f.bind('body')} rows=${8} placeholder="전달할 내용을 적어 주세요." />
      </${Field}>
      <div class="row wrap">
        ${f.values.kind === 'handover'
          ? html`<${Field} label="확인 기한 (선택)">
              <${Input} type="date" ...${f.bind('dueDate')} style=${{ width: '180px' }} />
            </${Field}>`
          : null}
        ${isManager ? html`<${Checkbox} label="맨 위에 고정" ...${f.bind('pinned', { type: 'checkbox' })} />` : null}
      </div>

      <div class="stack sm">
        <${PiiBanner} />
        <div class="row">
          <${AiButton} onClick=${runAi} loading=${ai.busy}>AI로 다듬기</${AiButton}>
          <span class="small muted">메모를 읽기 쉬운 ${f.values.kind === 'notice' ? '공지' : '인수인계'} 글로 바꿔 줍니다.</span>
        </div>
        ${showAi
          ? html`<${AiResult}
              ai=${ai}
              applyLabel="이 내용으로 바꾸기"
              onApply=${(text, r) => {
                const d = r.data || {};
                if (d.title) f.set('title', d.title);
                f.set('body', d.body || text);
                setShowAi(false);
                toast.success('AI 초안을 넣었습니다. 확인 후 등록하세요.');
              }}
            />`
          : null}
      </div>
    </form>
  </${Modal}>`;
}

// ---------------- 상세 ----------------
function PostDetail({ id }) {
  const { data: p, loading, error, reload } = useApi(`/board/posts/${id}`);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    // 열면 읽음 처리
    if (p && !p.readByMe) api.post(`/board/posts/${id}/read`).catch(() => {});
  }, [p && p.id]);

  if (error) return html`<${ErrorState} error=${error} onRetry=${reload} />`;
  if (loading && !p) return html`<${Loading} />`;
  if (!p) return null;

  const togglePin = async () => {
    await api.patch(`/board/posts/${id}`, { pinned: !p.pinned });
    toast.success(p.pinned ? '고정을 풀었습니다.' : '맨 위에 고정했습니다.');
    reload();
  };
  const toggleArchive = async () => {
    await api.patch(`/board/posts/${id}`, { archived: !p.archived });
    toast.success(p.archived ? '보관을 해제했습니다.' : '보관함으로 옮겼습니다.');
    reload();
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: '이 글을 삭제할까요?', message: '삭제하면 되돌릴 수 없습니다. 지우지 않고 보관함으로 옮길 수도 있습니다.', danger: true, confirmText: '삭제' }))) return;
    await api.del(`/board/posts/${id}`);
    toast.success('삭제했습니다.');
    navigate('#/board');
  };

  return html`
    <div class="row mt-0" style=${{ marginBottom: '12px' }}>
      <a href="#/board" class="btn btn-ghost btn-sm"><${Icon} name="arrow-left" size=${14} />목록으로</a>
    </div>
    <div class="grid detail-grid">
      <${Card}>
        <div class="stack">
          <div class="row wrap">
            <${Badge} color=${p.kind === 'notice' ? 'blue' : 'purple'}>${p.kindLabel}</${Badge}>
            <${ImportanceBadge} value=${p.importance} />
            ${p.pinned ? html`<${Badge}><${Icon} name="pin" size=${12} />고정</${Badge}>` : null}
            ${p.archived ? html`<${Badge}>보관됨</${Badge}>` : null}
            ${p.dueDate ? html`<${Badge} color="amber">기한 ${fmtDate(p.dueDate)}</${Badge}>` : null}
            <div class="grow"></div>
            ${p.canEdit
              ? html`<${Button} size="sm" icon="pencil" onClick=${() => setEditing(true)}>수정</${Button}>
                  <${Menu} items=${[
                    can('manager') && { label: p.pinned ? '고정 풀기' : '맨 위에 고정', icon: 'pin', onClick: togglePin },
                    { label: p.archived ? '보관 해제' : '보관함으로', icon: 'archive', onClick: toggleArchive },
                    '-',
                    { label: '삭제', icon: 'trash-2', danger: true, onClick: remove },
                  ].filter(Boolean)} />`
              : null}
          </div>
          <h2 style=${{ fontSize: '20px', fontWeight: 700 }}>${p.title}</h2>
          <div class="row small muted">
            <${Avatar} name=${p.authorName} size="sm" />
            <span>${p.authorName}</span><span>·</span><span>${fmtDateTime(p.createdAt)}</span>
            ${p.updatedAt !== p.createdAt ? html`<span>· 수정 ${fmtRelative(p.updatedAt)}</span>` : null}
          </div>
          <hr class="divider" />
          ${p.body ? html`<${Markdown} text=${p.body} />` : html`<p class="muted">내용 없음</p>`}
        </div>
      </${Card}>
      <${Card} title="읽음 확인" sub=${`${p.readers.length}/${p.readers.length + p.unread.length}명`}>
        <div class="stack sm">
          ${p.unread.length
            ? html`<div class="small strong warning-text">아직 안 읽음 (${p.unread.length})</div>
                <div class="row wrap">${p.unread.map((u) => html`<${Badge} color="amber">${u.name}</${Badge}>`)}</div>`
            : html`<div class="small success-text strong">모두 읽었습니다 ✓</div>`}
          <hr class="divider" />
          <div class="small strong text-2">읽은 사람</div>
          ${p.readers.map(
            (u) => html`<div class="row small"><span class="grow">${u.name}</span><span class="muted num">${fmtDateTime(u.readAt)}</span></div>`
          )}
        </div>
      </${Card}>
    </div>
    ${editing
      ? html`<${PostEditor} open=${true} post=${p} onClose=${() => setEditing(false)} onSaved=${() => {
          setEditing(false);
          reload();
        }} />`
      : null}
  `;
}

// ---------------- 목록 ----------------
function PostList({ route }) {
  const q = route.query;
  const tab = q.tab || 'all';
  const [search, setSearch] = useState(q.q || '');
  const [creating, setCreating] = useState(false);
  const page = Number(q.page) || 1;
  const params = {
    kind: tab === 'notice' || tab === 'handover' ? tab : '',
    archived: tab === 'archived' ? '1' : '',
    q: q.q || '',
    unread: q.unread || '',
    page,
  };
  const { data, loading, error, reload } = useApi(`/board/posts${toQuery(params)}`);

  useEffect(() => {
    const t = setTimeout(() => {
      if ((q.q || '') !== search) setQuery({ q: search, page: '' });
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  return html`
    <${PageHeader}
      title="공지·인수인계"
      desc="원내 공지와 근무자 간 인수인계를 한곳에서. 글을 열면 읽음으로 표시됩니다."
      actions=${html`<${Button} variant="primary" icon="plus" onClick=${() => setCreating(true)}>새 글</${Button}>`}
    />
    <${Tabs}
      value=${tab}
      onChange=${(t) => setQuery({ tab: t === 'all' ? '' : t, page: '' })}
      items=${[
        { value: 'all', label: '전체' },
        { value: 'notice', label: '공지', icon: 'megaphone' },
        { value: 'handover', label: '인수인계', icon: 'send' },
        { value: 'archived', label: '보관함', icon: 'archive' },
      ]}
    />
    <div class="row wrap" style=${{ marginBottom: '12px' }}>
      <${SearchInput} value=${search} onInput=${setSearch} placeholder="제목·내용 검색" style=${{ maxWidth: '320px' }} />
      <${Checkbox} label="안 읽은 글만" checked=${q.unread === '1'} onChange=${(c) => setQuery({ unread: c ? '1' : '', page: '' })} />
    </div>
    <${Card} flush>
      ${error && !data
        ? html`<${ErrorState} error=${error} onRetry=${reload} />`
        : loading && !data
          ? html`<${Loading} rows=${6} />`
          : !data.rows.length
            ? html`<${EmptyState}
                icon="megaphone"
                title=${q.q || q.unread ? '조건에 맞는 글이 없습니다' : '아직 글이 없습니다'}
                desc=${q.q || q.unread ? '검색어나 필터를 바꿔 보세요.' : '첫 공지나 인수인계를 남겨 보세요.'}
                action=${!q.q && !q.unread ? html`<${Button} variant="primary" icon="plus" onClick=${() => setCreating(true)}>새 글</${Button}>` : null}
              />`
            : html`<div class="list">
                ${data.rows.map(
                  (p) => html`<a class="list-item" href=${`#/board/${p.id}`} key=${p.id}>
                    <div class=${`icon-box ${p.kind === 'notice' ? 'blue' : 'purple'}`}><${Icon} name=${p.kind === 'notice' ? 'megaphone' : 'send'} size=${16} /></div>
                    <div class="grow">
                      <div class="row" style=${{ gap: '6px' }}>
                        ${!p.readByMe ? html`<span class="dot blue" title="안 읽음"></span>` : null}
                        ${p.pinned ? html`<${Icon} name="pin" size=${13} class="muted" />` : null}
                        <span class=${`list-title ellipsis ${p.readByMe ? '' : 'strong'}`}>${p.title}</span>
                        <${ImportanceBadge} value=${p.importance} />
                      </div>
                      <div class="list-meta row wrap" style=${{ gap: '6px' }}>
                        <span>${p.kindLabel}</span><span>·</span><span>${p.authorName}</span><span>·</span><span>${fmtRelative(p.createdAt)}</span>
                        <span>·</span><span>읽음 ${p.readCount}/${data.activeUsers}</span>
                      </div>
                    </div>
                    ${p.dueDate ? html`<${DdayBadge} days=${daysUntil(p.dueDate)} label=${daysUntil(p.dueDate) < 0 ? '기한 지남' : daysUntil(p.dueDate) === 0 ? '오늘까지' : undefined} />` : null}
                    <${Icon} name="chevron-right" size=${16} class="muted" />
                  </a>`
                )}
              </div>
              <${Pagination} page=${data.page} size=${data.size} total=${data.total} onChange=${(p) => setQuery({ page: p })} />`}
    </${Card}>
    ${creating
      ? html`<${PostEditor}
          open=${true}
          defaultKind=${tab === 'handover' ? 'handover' : undefined}
          onClose=${() => setCreating(false)}
          onSaved=${(p) => {
            setCreating(false);
            navigate(`#/board/${p.id}`);
          }}
        />`
      : null}
  `;
}

export default function BoardPage({ route }) {
  const id = route.parts[1];
  return id ? html`<${PostDetail} id=${id} key=${id} />` : html`<${PostList} route=${route} />`;
}

export { PostEditor };
