/*
 * 이 파일이 하는 일: [A. 데스크] 소통 도우미 화면입니다. 탭 3개로 나뉩니다.
 *
 *   #/comms?tab=scripts   전화 응대 스크립트 보관함 (검색·분류, 통화 중 읽기 좋은 큰 글씨) + AI로 상황별 스크립트 만들기
 *   #/comms?tab=review    온라인 리뷰 답글 초안 2~3개 (AI) + "주의 표현 검사" (과장·효과 보장·진료 정보 언급 등)
 *                         리뷰 글과 답글은 저장하지 않습니다. 화면을 떠나면 사라집니다.
 *   #/comms?tab=messages  문자·안내문 템플릿: {이름} {날짜} 변수, 휴대폰 모양 미리보기, 바이트 계산(SMS 90 / LMS 2000)
 */
import { html, useState, useEffect, useRef, fmtRelative, toQuery, smsBytes, cx } from '../lib.js';
import { api } from '../api.js';
import { setQuery } from '../router.js';
import { can, toast, confirmDialog } from '../store.js';
import {
  PageHeader, Card, Button, IconButton, Badge, Icon, Tabs, Seg, Modal, Field, Input, Textarea, Select, Checkbox, FormGrid, SearchInput,
  useApi, useForm, Loading, ErrorState, EmptyState, Menu, Progress, Callout, Markdown, stripMarkdown, copyText,
  PiiBanner, useAI, AiResult, AiButton,
} from '../ui/index.js';

const SCRIPT_ICONS = {
  진료시간: 'clock',
  '주차·오시는 길': 'building-2',
  '예약 변경·취소': 'calendar-clock',
  '비용 일반 문의': 'receipt',
  '보험 일반 안내': 'shield-check',
  '불만 응대': 'message-circle-reply',
  기타: 'phone',
};
const MESSAGE_ICONS = { '예약 안내': 'calendar-check', '휴진 안내': 'calendar-x', '진료 후 일반 안내': 'info', '보험·서류 안내': 'file-text', 기타: 'smartphone' };

/** 좁은 화면(태블릿 세로)에서 목록을 누르면 아래 상세로 스크롤 */
function scrollToDetail(id) {
  if (window.innerWidth > 1000) return;
  setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}

/** 검색어 입력 후 잠깐 기다렸다가 주소(?q=)에 반영 */
function useSearch(q) {
  const [search, setSearch] = useState(q || '');
  useEffect(() => {
    const t = setTimeout(() => {
      if ((q || '') !== search) setQuery({ q: search, id: '' });
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  return [search, setSearch];
}

/** 분류 칩 (전체 + 분류별 개수) */
function CategoryChips({ cats, value, counts = {}, onChange }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return html`<div class="cm-chips" role="group" aria-label="분류">
    <button type="button" aria-pressed=${!value ? 'true' : 'false'} onClick=${() => onChange('')}>전체 <span class="num">${total}</span></button>
    ${cats.map(
      (c) => html`<button type="button" aria-pressed=${value === c ? 'true' : 'false'} onClick=${() => onChange(c)}>
        ${c}${counts[c] ? html` <span class="num">${counts[c]}</span>` : null}
      </button>`
    )}
  </div>`;
}

// =====================================================================
// 1) 전화 응대 스크립트
// =====================================================================

function ScriptEditor({ script, initial, meta, onClose, onSaved }) {
  const isNew = !script;
  const f = useForm(script ? { title: script.title, category: script.category, body: script.body } : { title: '', category: '기타', body: '', ...initial });
  const save = f.submit(async (v) => {
    const saved = isNew ? await api.post('/comms/scripts', v) : await api.patch(`/comms/scripts/${script.id}`, v);
    toast.success(isNew ? '보관함에 저장했습니다.' : '저장했습니다.');
    onSaved(saved);
  });
  return html`<${Modal}
    open=${true}
    size="lg"
    title=${isNew ? '스크립트 저장' : '스크립트 수정'}
    onClose=${onClose}
    busy=${f.busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${f.busy} onClick=${save}>저장</${Button}>`}
  >
    <form class="stack" onSubmit=${save}>
      <${FormGrid}>
        <${Field} label="제목" required error=${f.errors.title}>
          <${Input} ...${f.bind('title')} maxlength="80" placeholder="예: 진료시간 문의" />
        </${Field}>
        <${Field} label="분류" error=${f.errors.category}>
          <${Select} ...${f.bind('category')} onChange=${(e) => f.set('category', e.target.value)} options=${meta.scriptCategories} />
        </${Field}>
      </${FormGrid}>
      <${Field} label="내용" required error=${f.errors.body} hint='"## 제목", "- 목록", "**굵게**" 로 쓰면 보기 좋게 표시됩니다. 환자 이름·연락처는 적지 마세요.'>
        <${Textarea} ...${f.bind('body')} rows=${16} class="cm-mono" />
      </${Field}>
    </form>
  </${Modal}>`;
}

/** 스크립트에 쓰이는 병원 정보가 채워져 있는지 보여 줌 */
function ClinicFacts({ clinic }) {
  const facts = [
    ['병원 이름', clinic.name],
    ['대표 전화', clinic.phone],
    ['주소', clinic.address],
    ['진료시간', clinic.hours],
    ['주차', clinic.parking],
    ['오시는 길', clinic.directions],
    ['보험 안내', clinic.insuranceNote],
  ];
  const missing = facts.filter(([, v]) => !v || !String(v).trim());
  return html`<div class="cm-facts">
    <div class="small muted">AI가 참고하는 병원 정보</div>
    <div class="row wrap cm-facts-list">
      ${facts.map(([k, v]) => html`<${Badge} color=${v && String(v).trim() ? 'green' : 'amber'} title=${v || '비어 있음'}>${v && String(v).trim() ? html`<${Icon} name="check" size=${11} />` : null}${k}</${Badge}>`)}
    </div>
    ${missing.length
      ? html`<div class="small warning-text">
          비어 있는 정보는 "확인 필요"로 표시됩니다.
          ${can('admin') ? html`<a href="#/admin">관리 → 병원 정보</a>에서 채워 주세요.` : '원장님께 병원 정보 입력을 요청해 주세요.'}
        </div>`
      : null}
  </div>`;
}

function ScriptAiModal({ meta, onClose, onSave }) {
  const ai = useAI('comms.script');
  const cats = meta.scriptCategories.filter((c) => c !== '기타');
  const [chip, setChip] = useState(cats[0]);
  const [custom, setCustom] = useState('');
  const [notes, setNotes] = useState('');
  const situation = custom.trim() || chip;
  const run = () => {
    if (situation.length < 2) return toast.warn('상황을 골라 주세요.');
    ai.run({ situation, notes: notes.trim() });
  };
  return html`<${Modal} open=${true} size="lg" title="AI로 전화 응대 스크립트 만들기" onClose=${onClose}>
    <div class="stack">
      <${PiiBanner} />
      <${Field} label="어떤 전화인가요?">
        <div class="cm-chips" role="group" aria-label="상황">
          ${cats.map((c) => html`<button type="button" aria-pressed=${!custom.trim() && chip === c ? 'true' : 'false'} onClick=${() => { setChip(c); setCustom(''); }}>
            <${Icon} name=${SCRIPT_ICONS[c]} size=${13} />${c}
          </button>`)}
        </div>
      </${Field}>
      <${Field} label="직접 입력 (선택)" hint="위 분류에 없는 상황이면 적어 주세요. 예: 예약 없이 오늘 바로 가도 되는지 문의">
        <${Input} value=${custom} maxlength="100" placeholder="상황을 짧게" onInput=${(e) => setCustom(e.target.value)} />
      </${Field}>
      <${Field} label="추가로 넣을 내용 (선택)" hint="예: 목요일 야간진료(20시까지) 안내도 넣기, 엘리베이터 위치 안내">
        <${Textarea} rows=${2} value=${notes} maxlength="1000" onInput=${(e) => setNotes(e.target.value)} />
      </${Field}>
      <${ClinicFacts} clinic=${meta.clinic} />
      <div class="row">
        <${AiButton} onClick=${run} loading=${ai.busy}>스크립트 만들기</${AiButton}>
        <span class="small muted">인사 → 안내 → 마무리, 예상 질문과 답까지 만들어 줍니다.</span>
      </div>
      <${AiResult}
        ai=${ai}
        editable
        plain
        applyLabel="보관함에 저장"
        onApply=${(text, r) => {
          const d = r.data || {};
          onSave({
            title: d.title || situation.slice(0, 80),
            category: !custom.trim() ? chip : d.category || '기타',
            body: d.title ? d.body : text,
          });
        }}
      />
    </div>
  </${Modal}>`;
}

function ScriptDetail({ s, onEdit, onDeleted }) {
  const remove = async () => {
    if (!(await confirmDialog({ title: '이 스크립트를 삭제할까요?', message: `"${s.title}"\n삭제하면 되돌릴 수 없습니다.`, danger: true, confirmText: '삭제' }))) return;
    try {
      await api.del(`/comms/scripts/${s.id}`);
      toast.success('삭제했습니다.');
      onDeleted(s.id);
    } catch (e) {
      toast.error(e.message);
    }
  };
  return html`<${Card}
    id="cm-detail"
    title=${s.title}
    icon=${SCRIPT_ICONS[s.category] || 'phone'}
    actions=${html`
      <${Button} size="sm" icon="copy" onClick=${() => copyText(stripMarkdown(s.body))}>복사</${Button}>
      ${s.canEdit ? html`<${Button} size="sm" icon="pencil" onClick=${onEdit}>수정</${Button}>` : null}
      ${s.canEdit ? html`<${Menu} items=${[{ label: '삭제', icon: 'trash-2', danger: true, onClick: remove }]} />` : null}
    `}
    footer=${html`<span class="small muted grow">${s.category} · ${s.authorName} · ${fmtRelative(s.updatedAt)} 수정</span>`}
  >
    <div class="cm-script"><${Markdown} text=${s.body} /></div>
  </${Card}>`;
}

function ScriptsTab({ route, meta }) {
  const q = route.query;
  const [search, setSearch] = useSearch(q.q);
  const { data, loading, error, reload, setData } = useApi(`/comms/scripts${toQuery({ q: q.q, category: q.cat })}`);
  const [editor, setEditor] = useState(null); // { script } 또는 { initial }
  const [aiOpen, setAiOpen] = useState(false);
  const rows = (data && data.rows) || [];
  const selected = rows.find((x) => String(x.id) === q.id) || rows[0];

  const onSaved = (saved) => {
    setEditor(null);
    setAiOpen(false);
    setData((d) => (d ? { ...d, rows: [saved, ...d.rows.filter((x) => x.id !== saved.id)] } : d));
    setQuery({ id: saved.id, cat: '', q: '' });
    setSearch('');
    reload();
  };

  return html`
    <div class="cm-toolbar">
      <${SearchInput} value=${search} onInput=${setSearch} placeholder="제목·내용 검색" class="cm-search" />
      <div class="grow"></div>
      <${Button} icon="plus" onClick=${() => setEditor({ initial: { category: q.cat || '기타' } })}>직접 쓰기</${Button}>
      <${AiButton} onClick=${() => setAiOpen(true)}>AI로 스크립트 만들기</${AiButton}>
    </div>
    <${CategoryChips} cats=${meta.scriptCategories} value=${q.cat || ''} counts=${data ? data.counts : {}} onChange=${(c) => setQuery({ cat: c, id: '' })} />
    ${error && !data
      ? html`<${Card}><${ErrorState} error=${error} onRetry=${reload} /></${Card}>`
      : loading && !data
        ? html`<div class="cm-split"><${Card} flush><${Loading} rows=${6} /></${Card}><${Card}><${Loading} rows=${10} /></${Card}></div>`
        : !rows.length
          ? html`<${Card}><${EmptyState}
              icon="phone"
              title=${q.q || q.cat ? '조건에 맞는 스크립트가 없습니다' : '저장된 스크립트가 없습니다'}
              desc=${q.q || q.cat ? '검색어나 분류를 바꿔 보세요.' : '자주 받는 전화의 응대 문구를 AI로 만들어 저장해 두세요.'}
              action=${html`<${AiButton} onClick=${() => setAiOpen(true)}>AI로 스크립트 만들기</${AiButton}>`}
            /></${Card}>`
          : html`<div class="cm-split">
              <${Card} flush class="cm-list-card">
                <div class="list" role="list">
                  ${rows.map(
                    (s) => html`<button type="button" role="listitem" class=${cx('list-item cm-item', selected && s.id === selected.id && 'active')} aria-current=${selected && s.id === selected.id ? 'true' : undefined}
                      onClick=${() => { setQuery({ id: s.id }); scrollToDetail('cm-detail'); }}>
                      <div class="icon-box blue"><${Icon} name=${SCRIPT_ICONS[s.category] || 'phone'} size=${15} /></div>
                      <div class="grow">
                        <div class="list-title ellipsis">${s.title}</div>
                        <div class="list-meta ellipsis">${s.category} · ${fmtRelative(s.updatedAt)}</div>
                      </div>
                    </button>`
                  )}
                </div>
              </${Card}>
              ${selected ? html`<${ScriptDetail} key=${selected.id} s=${selected} onEdit=${() => setEditor({ script: selected })} onDeleted=${() => { setQuery({ id: '' }); reload(); }} />` : null}
            </div>`}
    ${editor ? html`<${ScriptEditor} script=${editor.script} initial=${editor.initial} meta=${meta} onClose=${() => setEditor(null)} onSaved=${onSaved} />` : null}
    ${aiOpen && !editor ? html`<${ScriptAiModal} meta=${meta} onClose=${() => setAiOpen(false)} onSave=${(initial) => setEditor({ initial })} />` : null}
  `;
}

// =====================================================================
// 2) 리뷰 답글
// =====================================================================

/** 주의 표현을 노란·빨간 형광펜으로 칠해서 보여 줌 */
function Highlighted({ text, warnings }) {
  const parts = [];
  let last = 0;
  for (const w of [...warnings].sort((a, b) => a.index - b.index)) {
    if (w.index < last) continue;
    if (w.index > last) parts.push(text.slice(last, w.index));
    parts.push(html`<mark class=${`cm-mark ${w.level}`} title=${w.reason}>${text.slice(w.index, w.index + w.length)}</mark>`);
    last = w.index + w.length;
  }
  parts.push(text.slice(last));
  return html`<p class="cm-reply-text">${parts}</p>`;
}

/** 검사 결과 목록 */
function WarningList({ check }) {
  if (!check) return null;
  if (check.ok) return html`<div class="cm-check-ok"><${Icon} name="circle-check" size=${15} /> 주의 표현이 보이지 않습니다. 그래도 한 번 더 읽어 보고 올려 주세요.</div>`;
  return html`<ul class="cm-warns">
    ${check.warnings.map(
      (w) => html`<li class=${`cm-warn ${w.level}`}>
        <${Badge} color=${w.level === 'danger' ? 'red' : 'amber'}>${w.kind}</${Badge}>
        <div class="grow">
          <div><strong>"${w.phrase}"</strong> <span class="text-2">— ${w.reason}</span></div>
          ${w.suggest ? html`<div class="small muted">→ 바꾸기: ${w.suggest}</div>` : null}
        </div>
      </li>`
    )}
  </ul>`;
}

/** 답글 초안 한 개: 형광펜 표시 + 직접 고치기 + 고칠 때마다 다시 검사 + 복사 */
function DraftCard({ label, initialText, initialCheck, manual }) {
  const [text, setText] = useState(initialText || '');
  const [editing, setEditing] = useState(!!manual);
  const [check, setCheck] = useState(initialCheck || null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current && initialCheck) {
      first.current = false;
      return;
    }
    first.current = false;
    if (!text.trim()) return setCheck(null);
    const t = setTimeout(() => {
      api.post('/comms/check-reply', { text }).then(setCheck).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [text]);

  const dangerCount = check ? check.counts.danger : 0;
  const warnCount = check ? check.counts.warn : 0;
  return html`<div class=${cx('cm-draft', manual && 'manual')}>
    ${manual && !text.trim() ? null : html`<div class="cm-draft-head">
      ${manual ? null : html`<${Icon} name="sparkles" size=${15} /><strong>${label}</strong>`}
      ${check && !check.ok
        ? html`${dangerCount ? html`<${Badge} color="red">위험 ${dangerCount}</${Badge}>` : null}${warnCount ? html`<${Badge} color="amber">주의 ${warnCount}</${Badge}>` : null}`
        : check && check.ok
          ? html`<${Badge} color="green"><${Icon} name="check" size=${11} />검사 통과</${Badge}>`
          : null}
      <span class="grow"></span>
      <span class="small muted num">${text.length}자</span>
    </div>`}
    ${editing
      ? html`<${Textarea} rows=${manual ? 5 : 5} value=${text} aria-label=${`${label} 고치기`} placeholder=${manual ? '올리려는 답글을 붙여 넣으면 주의 표현을 바로 찾아 줍니다.' : ''} onInput=${(e) => setText(e.target.value)} />`
      : html`<${Highlighted} text=${text} warnings=${check ? check.warnings : []} />`}
    ${text.trim() ? html`<${WarningList} check=${check} />` : null}
    ${!manual || text.trim()
      ? html`<div class="row wrap">
          <${Button} size="sm" icon="copy" disabled=${!text.trim()} onClick=${() => {
            if (dangerCount) toast.warn('위험 표현이 남아 있습니다. 고친 뒤 올려 주세요.');
            copyText(text);
          }}>복사</${Button}>
          ${!manual ? html`<${Button} size="sm" variant="ghost" icon=${editing ? 'eye' : 'pencil'} onClick=${() => setEditing(!editing)}>${editing ? '표시 보기' : '직접 고치기'}</${Button}>` : null}
        </div>`
      : null}
  </div>`;
}

function Stars({ value, onChange }) {
  return html`<div class="cm-stars" role="radiogroup" aria-label="별점">
    ${[1, 2, 3, 4, 5].map(
      (n) => html`<button type="button" role="radio" aria-checked=${value === n ? 'true' : 'false'} aria-label=${`${n}점`} class=${n <= value ? 'on' : ''} onClick=${() => onChange(n)}>
        <${Icon} name="star" size=${24} />
      </button>`
    )}
    <span class="cm-stars-label">${value}점 · ${value >= 4 ? '좋은 평가' : value === 3 ? '보통' : '불만 리뷰'}</span>
  </div>`;
}

function ReviewTab({ meta }) {
  const ai = useAI('comms.review');
  const [review, setReview] = useState('');
  const [rating, setRating] = useState(5);
  const [tone, setTone] = useState('정중');
  const run = () => {
    if (review.trim().length < 2) return toast.warn('리뷰 내용을 붙여 넣어 주세요.');
    ai.run({ review: review.trim(), rating, tone });
  };
  const r = ai.result;
  const replies = (r && r.data && r.data.replies) || [];

  return html`<div class="cm-review">
    <div class="stack">
      <${Card} title="리뷰 붙여 넣기" icon="star">
        <div class="stack">
          <${PiiBanner} />
          <${Field} label="리뷰 내용" hint="리뷰 글은 저장되지 않습니다. 작성자 닉네임·실명은 지우고 붙여 넣어 주세요.">
            <${Textarea} rows=${6} value=${review} maxlength="2000" placeholder="예: 직원분들이 친절하고 설명을 자세히 해 주셨어요. 다만 대기 시간이 조금 길었어요." onInput=${(e) => setReview(e.target.value)} />
          </${Field}>
          <${Field} label="별점"><${Stars} value=${rating} onChange=${setRating} /></${Field}>
          <${Field} label="말투">
            <${Seg} label="말투" value=${tone} onChange=${setTone} items=${meta.tones.map((t) => ({ value: t, label: { 정중: '정중하게', 따뜻: '따뜻하게', 간결: '간결하게' }[t] || t }))} />
          </${Field}>
          <${AiButton} onClick=${run} loading=${ai.busy} block>답글 초안 3개 만들기</${AiButton}>
        </div>
      </${Card}>
      <${Callout} kind="info" title="답글 원칙">
        <ul class="cm-rules">
          <li>작성자가 환자였는지 확인하지 않기 ("내원해 주셔서", "치료받으신" ✕)</li>
          <li>리뷰에 나온 진료 이름(임플란트·교정 등)을 답글에 쓰지 않기</li>
          <li>효과 보장·과장(최고·100%·완치·무통)·다른 병원 비교 ✕</li>
          <li>불만 리뷰는 변명보다 공감 → 대표번호로 직접 연락 권하기</li>
        </ul>
      </${Callout}>
    </div>
    <div class="stack">
      ${ai.busy || ai.error ? html`<${AiResult} ai=${ai} />` : null}
      ${!ai.busy && r
        ? html`<div class="cm-results">
            <div class="row cm-results-head">
              <${Icon} name="sparkles" size=${16} class="cm-purple" />
              <strong>답글 초안</strong>
              ${r.demo ? html`<${Badge} color="amber">데모 예시</${Badge}>` : html`<${Badge} color="purple">AI</${Badge}>`}
              <span class="grow"></span>
              <${Button} size="sm" variant="ghost" icon="refresh-cw" onClick=${ai.retry}>다시 만들기</${Button}>
            </div>
            ${r.pii && r.pii.message ? html`<${Callout} kind="warn" icon="shield-check">${r.pii.message}</${Callout}>` : null}
            ${r.notice ? html`<${Callout} kind="info">${r.notice}</${Callout}>` : null}
            ${replies.length
              ? replies.map((rep, i) => html`<${DraftCard} key=${`${i}-${rep.text}`} label=${`${i + 1}안 · ${rep.label}`} initialText=${rep.text} initialCheck=${rep.check} />`)
              : html`<${Callout} kind="warn">답글을 읽지 못했습니다. [다시 만들기]를 눌러 주세요.</${Callout}>`}
            <p class="small muted">AI 초안은 그대로 올리기 전에 꼭 읽어 보세요. 형광펜 표시는 규칙으로 찾은 것이라 놓치는 표현이 있을 수 있습니다.</p>
          </div>`
        : null}
      ${!ai.busy && !r && !ai.error
        ? html`<${Card}><${EmptyState} icon="message-circle-reply" title="리뷰를 붙여 넣고 [답글 초안 만들기]를 누르세요" desc="별점과 말투에 맞춘 답글 3개를 만들고, 의료광고·개인정보 측면에서 주의할 표현을 형광펜으로 표시합니다." /></${Card}>`
        : null}
      <${Card} title="직접 쓴 답글 검사" icon="shield-check" sub="저장되지 않음">
        <${DraftCard} manual label="내 답글" initialText="" />
      </${Card}>
    </div>
  </div>`;
}

// =====================================================================
// 3) 문자·안내문 템플릿
// =====================================================================

/** 미리보기: 변수는 예시 값으로 채우고, 모르는 변수는 표시 */
function PreviewText({ body, sample }) {
  const parts = String(body || '').split(/(\{[^{}\n]{1,20}\})/g);
  return parts.map((p) => {
    const m = p.match(/^\{([^{}\n]{1,20})\}$/);
    if (!m) return p;
    const v = sample[m[1].trim()];
    return v ? html`<span class="cm-var-fill" title=${`{${m[1]}} 자리`}>${v}</span>` : html`<mark class="cm-var-unknown" title="예시 값이 없는 변수">${p}</mark>`;
  });
}

function fill(body, sample) {
  return String(body || '').replace(/\{([^{}\n]{1,20})\}/g, (all, k) => sample[k.trim()] || all);
}

function ByteMeter({ bytes }) {
  const kind = bytes <= 90 ? 'sms' : bytes <= 2000 ? 'lms' : 'over';
  const max = kind === 'sms' ? 90 : 2000;
  return html`<div class=${`cm-bytes ${kind}`}>
    <div class="row between">
      <span><strong class="num">${bytes.toLocaleString('ko-KR')}</strong><span class="muted num"> / ${max.toLocaleString('ko-KR')}바이트</span></span>
      <${Badge} color=${kind === 'sms' ? 'green' : kind === 'lms' ? 'blue' : 'red'}>${kind === 'sms' ? '단문(SMS)' : kind === 'lms' ? '장문(LMS)' : '너무 김'}</${Badge}>
    </div>
    <${Progress} value=${bytes} max=${max} color=${kind === 'sms' ? 'green' : kind === 'lms' ? '' : 'red'} label="문자 바이트" />
    <div class="small muted">
      ${kind === 'sms' ? `단문까지 ${90 - bytes}바이트 남음` : kind === 'lms' ? `단문(90바이트)보다 ${bytes - 90}바이트 김 · 장문 요금` : '2,000바이트를 넘으면 문자로 보낼 수 없습니다.'}
    </div>
  </div>`;
}

function MessageEditor({ t, initial, meta, onSaved, onDeleted, onCancelNew }) {
  const isNew = !t;
  const start = t ? { title: t.title, category: t.category, body: t.body } : { title: '', category: '기타', body: '', ...initial };
  const [vals, setVals] = useState(start);
  const [saved, setSavedVals] = useState(start);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const taRef = useRef();
  const shorten = useAI('comms.message');
  const sample = meta.sample;
  const dirty = isNew || vals.title !== saved.title || vals.category !== saved.category || vals.body !== saved.body;
  const filled = fill(vals.body, sample);
  const bytes = smsBytes(filled);
  const canEdit = isNew || t.canEdit;

  const set = (k, v) => {
    setVals((x) => ({ ...x, [k]: v }));
    setErrors((e) => ({ ...e, [k]: null }));
  };
  /** 커서 자리에 {변수} 넣기 */
  const insertVar = (name) => {
    const ta = taRef.current;
    const token = `{${name}}`;
    if (!ta) return set('body', vals.body + token);
    const s = ta.selectionStart ?? vals.body.length;
    const e = ta.selectionEnd ?? s;
    const next = vals.body.slice(0, s) + token + vals.body.slice(e);
    set('body', next);
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(s + token.length, s + token.length);
    }, 0);
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = isNew ? await api.post('/comms/templates', vals) : await api.patch(`/comms/templates/${t.id}`, vals);
      toast.success(isNew ? '템플릿을 저장했습니다.' : '저장했습니다.');
      setSavedVals(vals);
      onSaved(r);
    } catch (e) {
      const field = e.data && e.data.field;
      if (field) setErrors({ [field]: e.message.replace(/^[^:]+:\s*/, '') });
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: '이 템플릿을 삭제할까요?', message: `"${t.title}"\n삭제하면 되돌릴 수 없습니다.`, danger: true, confirmText: '삭제' }))) return;
    try {
      await api.del(`/comms/templates/${t.id}`);
      toast.success('삭제했습니다.');
      onDeleted(t.id);
    } catch (e) {
      toast.error(e.message);
    }
  };

  return html`<${Card}
    id="cm-detail"
    title=${isNew ? '새 템플릿' : '템플릿 편집'}
    icon=${isNew ? 'plus' : MESSAGE_ICONS[vals.category] || 'smartphone'}
    actions=${html`
      <${Button} size="sm" icon="copy" disabled=${!vals.body.trim()} onClick=${() => copyText(vals.body)}>문구 복사</${Button}>
      ${!isNew && t.canEdit ? html`<${Menu} items=${[
        { label: '예시 값으로 채워 복사', icon: 'copy', onClick: () => copyText(filled) },
        '-',
        { label: '삭제', icon: 'trash-2', danger: true, onClick: remove },
      ]} />` : null}
    `}
    footer=${html`
      ${!isNew ? html`<span class="small muted grow">${t.authorName} · ${fmtRelative(t.updatedAt)} 수정</span>` : html`<span class="grow"></span>`}
      ${isNew ? html`<${Button} onClick=${onCancelNew}>취소</${Button}>` : dirty ? html`<${Button} variant="ghost" onClick=${() => setVals(saved)}>되돌리기</${Button}>` : null}
      ${canEdit ? html`<${Button} variant="primary" icon="save" loading=${busy} disabled=${!dirty} onClick=${save}>저장</${Button}>` : null}
    `}
  >
    <div class="cm-msg">
      <div class="stack">
        ${!canEdit ? html`<${Callout} kind="info">다른 직원이 만든 템플릿이라 고칠 수 없습니다. 복사해서 쓰거나 실장님께 요청해 주세요.</${Callout}>` : null}
        <${FormGrid}>
          <${Field} label="제목" required error=${errors.title}>
            <${Input} value=${vals.title} maxlength="80" disabled=${!canEdit} placeholder="예: 예약 전날 안내" onInput=${(e) => set('title', e.target.value)} />
          </${Field}>
          <${Field} label="분류">
            <${Select} value=${vals.category} disabled=${!canEdit} options=${meta.messageCategories} onChange=${(e) => set('category', e.target.value)} />
          </${Field}>
        </${FormGrid}>
        <${Field} label="문구" required error=${errors.body}>
          <textarea
            ref=${taRef}
            class="textarea cm-body"
            rows="9"
            maxlength="2000"
            disabled=${!canEdit}
            value=${vals.body}
            placeholder="[{병원명}] {이름}님, {날짜} {시간} 예약입니다."
            onInput=${(e) => set('body', e.target.value)}
          ></textarea>
        </${Field}>
        ${canEdit
          ? html`<div class="cm-vars">
              <span class="small muted">변수 넣기</span>
              ${meta.variables.map((v) => html`<button type="button" class="cm-var-chip" onClick=${() => insertVar(v)}>{${v}}</button>`)}
            </div>`
          : null}
        ${canEdit && bytes > 90
          ? html`<div class="stack sm">
              <${PiiBanner} compact />
              <div class="row wrap">
                <${AiButton} size="sm" loading=${shorten.busy} onClick=${() => shorten.run({ text: vals.body, purpose: vals.title, short: true })}>90바이트 단문으로 줄이기</${AiButton}>
                <span class="small muted">핵심만 남긴 단문 문구를 제안합니다.</span>
              </div>
              <${AiResult}
                ai=${shorten}
                plain
                title="단문 제안"
                applyLabel="이 문구로 바꾸기"
                onApply=${(text, r) => {
                  set('body', (r.data && r.data.body) || text);
                  shorten.reset();
                  toast.success('문구를 바꿨습니다. 확인 후 저장하세요.');
                }}
              />
            </div>`
          : null}
      </div>
      <div class="cm-preview">
        <div class="cm-phone" aria-label="문자 미리보기">
          <div class="cm-phone-top"><span>${meta.sample.병원명}</span></div>
          <div class="cm-phone-screen">
            ${vals.body.trim()
              ? html`<div class="cm-bubble"><${PreviewText} body=${vals.body} sample=${sample} /></div>`
              : html`<div class="cm-bubble empty">문구를 입력하면 여기에 미리 보입니다.</div>`}
          </div>
        </div>
        <${ByteMeter} bytes=${bytes} />
        <p class="small muted cm-sample-note">미리보기는 예시 값(${sample.이름}, ${sample.날짜}, ${sample.시간})으로 채운 모습입니다. 실제 바이트는 이름 길이 등에 따라 조금 달라집니다.</p>
      </div>
    </div>
  </${Card}>`;
}

function MessageAiModal({ onClose, onApply }) {
  const ai = useAI('comms.message');
  const [purpose, setPurpose] = useState('');
  const [short, setShort] = useState(false);
  const run = () => {
    if (purpose.trim().length < 2) return toast.warn('어떤 안내 문자인지 적어 주세요.');
    ai.run({ purpose: purpose.trim(), short });
  };
  const examples = ['다음 주 수요일 원내 교육으로 휴진', '예약 전날 방문 안내', '연말 스케일링 건강보험 안내', '주차장 공사로 주차 안내 변경'];
  return html`<${Modal} open=${true} size="lg" title="AI로 안내 문자 만들기" onClose=${onClose}>
    <div class="stack">
      <${PiiBanner} />
      <${Field} label="어떤 문자인가요?" hint="날짜·이름 같은 바뀌는 값은 {날짜} {이름} 변수로 들어갑니다.">
        <${Textarea} rows=${3} value=${purpose} maxlength="500" placeholder="예: 10월 22일 수요일 원내 교육으로 휴진, 예약 변경 안내" onInput=${(e) => setPurpose(e.target.value)} />
      </${Field}>
      <div class="cm-chips">
        ${examples.map((ex) => html`<button type="button" aria-pressed="false" onClick=${() => setPurpose(ex)}>${ex}</button>`)}
      </div>
      <${Checkbox} label="90바이트 단문(SMS)으로 짧게 만들기" checked=${short} onChange=${setShort} />
      <div class="row">
        <${AiButton} onClick=${run} loading=${ai.busy}>문구 만들기</${AiButton}>
        ${ai.result && ai.result.data ? html`<span class="small muted num">${smsBytes(ai.result.data.body)}바이트 (변수 그대로 기준)</span>` : null}
      </div>
      <${AiResult}
        ai=${ai}
        plain
        applyLabel="새 템플릿으로 열기"
        onApply=${(text, r) => {
          const d = r.data || {};
          onApply({ title: d.title || purpose.slice(0, 40), body: d.body || text });
        }}
      />
    </div>
  </${Modal}>`;
}

function guessMessageCategory(s, cats) {
  if (/휴진|휴무/.test(s)) return '휴진 안내';
  if (/예약/.test(s)) return '예약 안내';
  if (/보험|서류|영수증|스케일링/.test(s)) return '보험·서류 안내';
  if (/진료 후|주의/.test(s)) return '진료 후 일반 안내';
  return cats.includes('기타') ? '기타' : cats[0];
}

function MessagesTab({ route, meta }) {
  const q = route.query;
  const [search, setSearch] = useSearch(q.q);
  const { data, loading, error, reload, setData } = useApi(`/comms/templates${toQuery({ q: q.q, category: q.cat })}`);
  const [draft, setDraft] = useState(null); // 새 템플릿 초안 (AI 결과 등)
  const [aiOpen, setAiOpen] = useState(false);
  const rows = (data && data.rows) || [];
  const isNew = q.id === 'new';
  const selected = !isNew && (rows.find((x) => String(x.id) === q.id) || rows[0]);

  const startNew = (initial) => {
    setDraft({ category: q.cat || '기타', ...initial, key: Date.now() });
    setQuery({ id: 'new' });
    scrollToDetail('cm-detail');
  };
  const onSaved = (saved) => {
    setDraft(null);
    setData((d) => (d ? { ...d, rows: [saved, ...d.rows.filter((x) => x.id !== saved.id)] } : d));
    if (isNew) setQuery({ id: saved.id, cat: '', q: '' });
    reload();
  };

  const editor = isNew
    ? html`<${MessageEditor} key=${`new-${draft ? draft.key : 0}`} initial=${draft || {}} meta=${meta} onSaved=${onSaved} onCancelNew=${() => { setDraft(null); setQuery({ id: '' }); }} />`
    : selected
      ? html`<${MessageEditor} key=${selected.id} t=${selected} meta=${meta} onSaved=${onSaved} onDeleted=${() => { setQuery({ id: '' }); reload(); }} />`
      : null;

  return html`
    <div class="cm-toolbar">
      <${SearchInput} value=${search} onInput=${setSearch} placeholder="제목·문구 검색" class="cm-search" />
      <div class="grow"></div>
      <${Button} icon="plus" onClick=${() => startNew({})}>새 템플릿</${Button}>
      <${AiButton} onClick=${() => setAiOpen(true)}>AI로 문구 만들기</${AiButton}>
    </div>
    <${CategoryChips} cats=${meta.messageCategories} value=${q.cat || ''} counts=${data ? data.counts : {}} onChange=${(c) => setQuery({ cat: c, id: '' })} />
    ${error && !data
      ? html`<${Card}><${ErrorState} error=${error} onRetry=${reload} /></${Card}>`
      : loading && !data
        ? html`<div class="cm-split"><${Card} flush><${Loading} rows=${6} /></${Card}><${Card}><${Loading} rows=${10} /></${Card}></div>`
        : !rows.length && !isNew
          ? html`<${Card}><${EmptyState}
              icon="smartphone"
              title=${q.q || q.cat ? '조건에 맞는 템플릿이 없습니다' : '저장된 문자 템플릿이 없습니다'}
              desc=${q.q || q.cat ? '검색어나 분류를 바꿔 보세요.' : '예약 안내·휴진 안내처럼 자주 보내는 문자를 템플릿으로 만들어 두세요.'}
              action=${html`<div class="row"><${Button} icon="plus" onClick=${() => startNew({})}>새 템플릿</${Button}><${AiButton} onClick=${() => setAiOpen(true)}>AI로 문구 만들기</${AiButton}></div>`}
            /></${Card}>`
          : html`<div class="cm-split">
              <${Card} flush class="cm-list-card">
                ${rows.length
                  ? html`<div class="list" role="list">
                      ${isNew ? html`<div class="list-item cm-item active" role="listitem"><div class="icon-box purple"><${Icon} name="plus" size=${15} /></div><div class="grow"><div class="list-title">${(draft && draft.title) || '새 템플릿'}</div><div class="list-meta">저장 전</div></div></div>` : null}
                      ${rows.map(
                        (t) => html`<button type="button" role="listitem" class=${cx('list-item cm-item', selected && t.id === selected.id && 'active')} aria-current=${selected && t.id === selected.id ? 'true' : undefined}
                          onClick=${() => { setQuery({ id: t.id }); scrollToDetail('cm-detail'); }}>
                          <div class="icon-box green"><${Icon} name=${MESSAGE_ICONS[t.category] || 'smartphone'} size=${15} /></div>
                          <div class="grow">
                            <div class="list-title ellipsis">${t.title}</div>
                            <div class="list-meta ellipsis">${t.category} · ${t.body.replace(/\s+/g, ' ').slice(0, 40)}</div>
                          </div>
                          <${Badge} color=${t.smsKind === 'SMS' ? 'green' : t.smsKind === 'LMS' ? 'blue' : 'red'} title=${`${t.bytes}바이트 (예시 값으로 채운 기준)`}>${t.smsKind === 'SMS' ? '단문' : t.smsKind === 'LMS' ? '장문' : '초과'}</${Badge}>
                        </button>`
                      )}
                    </div>`
                  : html`<${EmptyState} compact icon="smartphone" title="저장된 템플릿 없음" />`}
              </${Card}>
              ${editor}
            </div>`}
    ${aiOpen
      ? html`<${MessageAiModal}
          onClose=${() => setAiOpen(false)}
          onApply=${(d) => {
            setAiOpen(false);
            startNew({ ...d, category: guessMessageCategory(`${d.title} ${d.body}`, meta.messageCategories) });
            toast.success('새 템플릿으로 열었습니다. 확인 후 저장하세요.');
          }}
        />`
      : null}
  `;
}

// =====================================================================
// 화면
// =====================================================================
const TABS = [
  { value: 'scripts', label: '전화 응대 스크립트', icon: 'phone' },
  { value: 'review', label: '리뷰 답글', icon: 'star' },
  { value: 'messages', label: '문자·안내문', icon: 'smartphone' },
];

export default function CommsPage({ route }) {
  const tab = TABS.some((t) => t.value === route.query.tab) ? route.query.tab : 'scripts';
  const meta = useApi('/comms/meta');
  return html`
    <${PageHeader} title="소통 도우미" desc="전화 응대 스크립트, 리뷰 답글, 안내 문자를 한곳에서. AI가 초안을 만들고 의료광고 주의 표현을 검사합니다." />
    <${Tabs} value=${tab} onChange=${(t) => setQuery({ tab: t === 'scripts' ? '' : t, q: '', id: '', cat: '' })} items=${TABS} />
    ${meta.error && !meta.data
      ? html`<${Card}><${ErrorState} error=${meta.error} onRetry=${meta.reload} /></${Card}>`
      : !meta.data
        ? html`<${Card}><${Loading} rows=${6} /></${Card}>`
        : tab === 'scripts'
          ? html`<${ScriptsTab} route=${route} meta=${meta.data} />`
          : tab === 'review'
            ? html`<${ReviewTab} meta=${meta.data} />`
            : html`<${MessagesTab} route=${route} meta=${meta.data} />`}
  `;
}
