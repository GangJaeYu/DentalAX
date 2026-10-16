/*
 * 이 파일이 하는 일: [G. 원내 AI 도우미] 화면
 *
 *   왼쪽(위): 질문하기 — 원내 매뉴얼·규정을 근거로 답하고, 근거 문서를 [1] [2] 카드로 보여 줌
 *   오른쪽(아래): 참고 문서 — 도우미가 읽는 문서 목록. 실장 이상은 문서를 붙여넣거나 파일(txt, md, csv, docx)로 등록
 *
 *  - 대화는 이 화면에만 잠시 보이고 서버에 저장되지 않습니다. (새로고침하면 사라짐)
 *  - "AI 문서 작성"에서 'AI 도우미가 참고'를 켠 문서도 자동으로 함께 검색됩니다.
 */
import { html, useState, useEffect, useRef, fmtRelative, fmtNumber } from '../lib.js';
import { api, readFileAsBase64 } from '../api.js';
import { can, toast, confirmDialog } from '../store.js';
import {
  PageHeader, Card, Button, Badge, Icon, Modal, Field, Input, Textarea, Select, Tabs, useApi, useForm,
  Loading, ErrorState, EmptyState, Markdown, Callout, PiiBanner, AiButton, Menu, useAiStatus,
} from '../ui/index.js';

// ---------------- 근거 문서 카드 ----------------
function SourceCards({ sources, onOpen }) {
  if (!sources || !sources.length) return null;
  return html`<div class="asst-sources">
    <div class="small strong text-2">근거 문서</div>
    <div class="asst-source-grid">
      ${sources.map(
        (s) => html`<button type="button" class="asst-source" onClick=${() => onOpen(s)} title="문서 열기">
          <span class="asst-num">${s.n}</span>
          <span class="grow">
            <span class="asst-source-title ellipsis">${s.title}${s.heading ? html`<span class="muted"> · ${s.heading}</span>` : null}</span>
            <span class="asst-source-snippet">${s.snippet}</span>
          </span>
        </button>`
      )}
    </div>
  </div>`;
}

// ---------------- 문서 보기 ----------------
function DocViewer({ source, onClose }) {
  const isKb = source.docRef.startsWith('kb:');
  const id = source.docRef.split(':')[1];
  const { data, loading, error } = useApi(isKb ? `/assistant/docs/${id}` : null);
  return html`<${Modal} open=${true} size="lg" title=${source.title} onClose=${onClose}
    footer=${html`${!isKb ? html`<a class="btn" href=${`#/documents/${id}`}>문서함에서 열기</a>` : null}<${Button} onClick=${onClose}>닫기</${Button}>`}>
    ${source.heading ? html`<${Callout} kind="info">찾은 위치: <strong>${source.heading}</strong></${Callout}>` : null}
    <div class="mt-3">
      ${!isKb
        ? html`<div class="prose"><p class="muted">문서함에 있는 문서입니다. 근거 문단:</p><blockquote>${source.snippet}</blockquote></div>`
        : error
          ? html`<${ErrorState} error=${error} compact />`
          : loading || !data
            ? html`<${Loading} />`
            : html`<${Markdown} text=${data.content} />`}
    </div>
  </${Modal}>`;
}

// ---------------- 질문하기 ----------------
function Chat({ docCount }) {
  const [turns, setTurns] = useState([]); // [{ q, a, sources, demo, notice, pii, error, busy }]
  const [q, setQ] = useState('');
  const [viewing, setViewing] = useState(null);
  const sugg = useApi('/assistant/suggestions');
  const endRef = useRef();
  const status = useAiStatus();

  useEffect(() => {
    endRef.current && endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, turns[turns.length - 1]?.busy]);

  const ask = async (question) => {
    const text = (question ?? q).trim();
    if (text.length < 2) return;
    setQ('');
    const history = turns.filter((t) => t.a && !t.error).slice(-2).map((t) => ({ q: t.q, a: t.a }));
    const idx = turns.length;
    setTurns((t) => [...t, { q: text, busy: true }]);
    try {
      const r = await api.post('/ai/run', { feature: 'assistant.ask', input: { question: text, history } });
      setTurns((t) => t.map((x, i) => (i === idx ? { q: text, a: r.text, sources: r.sources, demo: r.demo, notice: r.notice, pii: r.pii } : x)));
    } catch (e) {
      setTurns((t) => t.map((x, i) => (i === idx ? { q: text, error: e.message, pii: e.data && e.data.pii } : x)));
    }
  };

  return html`<${Card} class="asst-chat" flush>
    <div class="asst-thread" aria-live="polite">
      ${turns.length === 0
        ? html`<div class="asst-welcome">
            <div class="icon-box purple asst-hero"><${Icon} name="bot" size=${24} /></div>
            <h2 class="asst-hello">원내 규정·매뉴얼, 무엇이든 물어보세요</h2>
            <p class="muted">등록된 문서 ${fmtNumber(docCount)}건에서 근거를 찾아 답합니다. 답 아래 [1] [2] 카드를 누르면 원문을 볼 수 있어요.</p>
            ${status && status.demo ? html`<p class="small warning-text mt-1">지금은 데모 모드라 관련 문장을 찾아 그대로 보여 드립니다.</p>` : null}
            ${sugg.data && sugg.data.suggestions.length
              ? html`<div class="asst-suggest">
                  ${sugg.data.suggestions.map((s) => html`<button type="button" class="asst-chip" onClick=${() => ask(s)}>${s}</button>`)}
                </div>`
              : null}
          </div>`
        : turns.map(
            (t) => html`<div class="asst-turn">
              <div class="asst-q"><div class="asst-bubble">${t.q}</div></div>
              <div class="asst-a">
                <div class="icon-box purple asst-avatar"><${Icon} name="sparkles" size=${15} /></div>
                <div class="grow stack sm">
                  ${t.busy
                    ? html`<div class="ai-thinking" style=${{ padding: '6px 0' }}><span class="ai-dots"><span></span><span></span><span></span></span> 문서를 찾고 답을 쓰는 중…</div>`
                    : t.error
                      ? html`<${Callout} kind=${t.pii ? 'warn' : 'danger'}>${t.error}</${Callout}>`
                      : html`
                          ${t.pii && t.pii.message ? html`<${Callout} kind="warn" icon="shield-check">${t.pii.message}</${Callout}>` : null}
                          ${t.notice ? html`<${Callout} kind="info">${t.notice}</${Callout}>` : null}
                          <div class="row" style=${{ gap: '6px' }}>${t.demo ? html`<${Badge} color="amber">데모 예시</${Badge}>` : null}</div>
                          <${Markdown} text=${t.a} />
                          <${SourceCards} sources=${t.sources} onOpen=${setViewing} />
                        `}
                </div>
              </div>
            </div>`
          )}
      <div ref=${endRef}></div>
    </div>
    <form class="asst-compose" onSubmit=${(e) => {
      e.preventDefault();
      ask();
    }}>
      <${PiiBanner} compact />
      <div class="row top">
        <${Textarea}
          rows=${2}
          value=${q}
          onInput=${(e) => setQ(e.target.value)}
          placeholder="예: 연차는 며칠 전에 신청해야 하나요?  (Enter: 보내기 / Shift+Enter: 줄바꿈)"
          aria-label="질문"
          onKeyDown=${(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              ask();
            }
          }}
          class="asst-input"
        />
        <${AiButton} type="submit" disabled=${q.trim().length < 2 || turns.some((t) => t.busy)}>질문</${AiButton}>
      </div>
      <div class="row between small muted">
        <span>대화는 저장되지 않습니다. AI 답은 틀릴 수 있으니 근거 문서를 꼭 확인하세요.</span>
        ${turns.length ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => setTurns([])}>새 대화</button>` : null}
      </div>
    </form>
    ${viewing ? html`<${DocViewer} source=${viewing} onClose=${() => setViewing(null)} />` : null}
  </${Card}>`;
}

// ---------------- 문서 등록 ----------------
function DocEditor({ categories, onClose, onSaved }) {
  const [mode, setMode] = useState('paste');
  const [file, setFile] = useState(null);
  const f = useForm({ title: '', category: '업무 매뉴얼', text: '' });
  const save = f.submit(async (v) => {
    let body = { title: v.title, category: v.category };
    if (mode === 'paste') body.text = v.text;
    else {
      if (!file) throw new Error('파일을 골라 주세요.');
      if (file.size > 20 * 1024 * 1024) throw new Error('파일이 너무 큽니다. 20MB 이하만 등록할 수 있습니다.');
      body = { ...body, filename: file.name, base64: await readFileAsBase64(file) };
    }
    const d = await api.post('/assistant/docs', body);
    toast.success(`"${d.title}" 문서를 등록했습니다. 이제 질문에 활용됩니다.`);
    onSaved();
  });
  return html`<${Modal} open=${true} size="lg" title="참고 문서 등록" onClose=${onClose} busy=${f.busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${f.busy} onClick=${save}>등록</${Button}>`}>
    <form class="stack" onSubmit=${save}>
      <${Callout} kind="info">원내 매뉴얼·규정처럼 <strong>환자 정보가 없는 문서</strong>만 등록하세요. 등록한 내용은 질문할 때 AI로 함께 보내집니다.</${Callout}>
      <div class="form-grid">
        <${Field} label="제목" required error=${f.errors.title}><${Input} ...${f.bind('title')} placeholder="예: 멸균 절차 매뉴얼" /></${Field}>
        <${Field} label="분류"><${Select} ...${f.bind('category')} options=${categories} /></${Field}>
      </div>
      <${Tabs} value=${mode} onChange=${setMode} items=${[{ value: 'paste', label: '붙여넣기', icon: 'clipboard-list' }, { value: 'file', label: '파일 올리기', icon: 'file-up' }]} />
      ${mode === 'paste'
        ? html`<${Field} label="내용" error=${f.errors.text} hint="제목은 # 으로 시작하면 더 정확하게 찾습니다. 예) # 제3조 연차 사용">
            <${Textarea} rows=${12} ...${f.bind('text')} placeholder="문서 내용을 붙여넣으세요." />
          </${Field}>`
        : html`<div class="stack sm">
            <label class="asst-drop">
              <${Icon} name="file-up" size=${22} />
              <span>${file ? html`<strong>${file.name}</strong> (${Math.round(file.size / 1024)} KB)` : '여기를 눌러 파일을 고르세요 (txt, md, csv, docx)'}</span>
              <input type="file" accept=".txt,.md,.csv,.docx" class="sr-only" onChange=${(e) => {
                const fl = e.target.files[0];
                setFile(fl || null);
                if (fl && !f.values.title) f.set('title', fl.name.replace(/\.[^.]+$/, ''));
              }} />
            </label>
            <p class="small muted">PDF·한글(HWP)은 내용을 복사해 [붙여넣기]로 등록하세요. 한글 파일은 "다른 이름으로 저장 → docx"도 됩니다.</p>
          </div>`}
    </form>
  </${Modal}>`;
}

function DocList({ data, reload }) {
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState(null);
  const manager = can('manager');
  const toggle = async (d) => {
    await api.patch(`/assistant/docs/${d.id}`, { active: !d.active });
    toast.success(d.active ? '도우미가 이 문서를 참고하지 않습니다.' : '다시 참고합니다.');
    reload();
  };
  const remove = async (d) => {
    if (!(await confirmDialog({ title: `"${d.title}" 문서를 삭제할까요?`, danger: true, confirmText: '삭제' }))) return;
    await api.del(`/assistant/docs/${d.id}`);
    toast.success('삭제했습니다.');
    reload();
  };
  const total = data.docs.length + data.linked.length;
  return html`<${Card}
    title="참고 문서"
    sub=${`${total}건`}
    flush
    actions=${manager ? html`<${Button} size="sm" variant="primary" icon="plus" onClick=${() => setAdding(true)}>문서 등록</${Button}>` : null}
  >
    ${total === 0
      ? html`<${EmptyState} icon="book-open" title="아직 등록된 문서가 없습니다" desc=${manager ? '원내 매뉴얼·규정을 등록하면 도우미가 그 내용으로 답합니다.' : '실장님께 매뉴얼 등록을 요청하세요.'} action=${manager ? html`<${Button} variant="primary" icon="plus" onClick=${() => setAdding(true)}>문서 등록</${Button}>` : null} />`
      : html`<div class="list">
          ${data.docs.map(
            (d) => html`<div class="list-item" key=${d.ref}>
              <div class=${`icon-box ${d.active ? 'purple' : ''}`}><${Icon} name="book-open" size=${16} /></div>
              <button type="button" class="grow asst-doc-btn" onClick=${() => setViewing({ docRef: d.ref, title: d.title, heading: '' })}>
                <div class="list-title ellipsis">${d.title}</div>
                <div class="list-meta">${d.category} · ${fmtNumber(d.chars)}자${d.filename ? ' · ' + d.filename : ''} · ${fmtRelative(d.updatedAt)}</div>
              </button>
              ${!d.active ? html`<${Badge}>참고 안 함</${Badge}>` : null}
              ${manager
                ? html`<${Menu} items=${[
                    { label: d.active ? '참고하지 않기' : '다시 참고하기', icon: d.active ? 'eye' : 'check', onClick: () => toggle(d) },
                    '-',
                    { label: '삭제', icon: 'trash-2', danger: true, onClick: () => remove(d) },
                  ]} />`
                : null}
            </div>`
          )}
          ${data.linked.map(
            (d) => html`<a class="list-item" href=${d.href} key=${d.ref}>
              <div class="icon-box blue"><${Icon} name="file-text" size=${16} /></div>
              <div class="grow">
                <div class="list-title ellipsis">${d.title}</div>
                <div class="list-meta">문서함 · ${d.category} · ${fmtNumber(d.chars)}자</div>
              </div>
              <${Badge} color="blue">문서함 연결</${Badge}>
            </a>`
          )}
        </div>`}
    ${adding ? html`<${DocEditor} categories=${data.categories} onClose=${() => setAdding(false)} onSaved=${() => {
      setAdding(false);
      reload();
    }} />` : null}
    ${viewing ? html`<${DocViewer} source=${viewing} onClose=${() => setViewing(null)} />` : null}
  </${Card}>`;
}

export default function AssistantPage() {
  const { data, loading, error, reload } = useApi('/assistant/docs');
  return html`
    <${PageHeader} title="원내 AI 도우미" desc="원내 매뉴얼·규정 문서를 근거로 질문에 답합니다. 답과 함께 근거 문서를 보여 드려요." />
    ${error && !data
      ? html`<${ErrorState} error=${error} onRetry=${reload} />`
      : loading && !data
        ? html`<${Loading} />`
        : html`<div class="grid asst-layout">
            <${Chat} docCount=${data.docs.filter((d) => d.active).length + data.linked.length} />
            <${DocList} data=${data} reload=${reload} />
          </div>`}
  `;
}
