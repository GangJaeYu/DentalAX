/*
 * 이 파일이 하는 일: AI 기능 화면에서 공통으로 쓰는 부품입니다.
 *
 *   PiiBanner  : "환자 개인정보 입력 금지" 안내 (AI 입력칸 바로 위에 꼭 둡니다)
 *   useAI      : AI 기능 실행 도우미 → const ai = useAI('docs.write'); await ai.run({ ...입력 });
 *   AiResult   : AI 결과 상자 (생각 중 표시, 데모 배지, 개인정보 가림 안내, 복사·다시 만들기·적용 버튼)
 *   AiStatus   : 지금 데모 모드인지 실제 AI인지 보여 주는 작은 배지
 */
import { html, useState, useEffect } from '../lib.js';
import { api } from '../api.js';
import { toast, createStore, useStore } from '../store.js';
import { Icon } from './icons.js';
import { Button, Badge, Callout } from './core.js';
import { Markdown, stripMarkdown } from './markdown.js';
import { Textarea } from './form.js';

export function PiiBanner({ compact }) {
  return html`<div class="pii-banner" role="note">
    <${Icon} name="shield-check" size=${15} />
    <span>${compact ? '환자 개인정보 입력 금지' : '환자 개인정보(이름·연락처·주민번호·차트번호·진료 내용)는 입력하지 마세요. 감지되면 자동으로 가리거나 전송을 막습니다.'}</span>
  </div>`;
}

// AI 상태(데모 여부)는 여러 화면에서 쓰므로 한 번 불러와 보관
const statusStore = createStore(null);
let statusLoading = false;
export function refreshAiStatus() {
  statusLoading = true;
  return api
    .get('/ai/status')
    .then((s) => statusStore.set(s))
    .catch(() => {})
    .finally(() => (statusLoading = false));
}
export function useAiStatus() {
  const s = useStore(statusStore);
  useEffect(() => {
    if (!s && !statusLoading) refreshAiStatus();
  }, []);
  return s;
}

export function AiStatus() {
  const s = useAiStatus();
  if (!s) return null;
  if (s.demo) return html`<${Badge} color="amber" title="API 키가 없어 예시 응답을 보여 줍니다. 관리 → AI 설정에서 키를 넣으면 실제 AI로 동작합니다.">데모 모드</${Badge}>`;
  return html`<${Badge} color="purple">${s.providerLabel}</${Badge}>`;
}

/**
 * AI 실행 도우미
 * @param {string} feature 서버에 등록된 AI 기능 이름 (예: 'board.polish')
 */
export function useAI(feature) {
  const [state, setState] = useState({ busy: false, result: null, error: null, lastInput: null });
  const run = async (input) => {
    setState((s) => ({ ...s, busy: true, error: null, lastInput: input }));
    try {
      const result = await api.post('/ai/run', { feature, input });
      setState({ busy: false, result, error: null, lastInput: input });
      if (result.notice && /예산/.test(result.notice)) refreshAiStatus();
      return result;
    } catch (error) {
      setState((s) => ({ ...s, busy: false, error }));
      return null;
    }
  };
  return {
    ...state,
    run,
    retry: () => state.lastInput && run(state.lastInput),
    reset: () => setState({ busy: false, result: null, error: null, lastInput: null }),
    setText: (text) => setState((s) => ({ ...s, result: s.result ? { ...s.result, text } : s.result })),
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // http 접속(원내 IP)에서는 clipboard API가 막힐 수 있어 예전 방식으로 복사
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast.success('복사했습니다.');
}
export { copyText };

/**
 * AI 결과 상자
 * @param ai          useAI() 결과
 * @param onApply     [적용] 버튼을 눌렀을 때 (결과 글, 결과 전체)
 * @param applyLabel  [적용] 버튼 이름 (예: '본문에 넣기')
 * @param editable    결과를 바로 고칠 수 있게 할지
 * @param plain       복사할 때 마크다운 기호를 뺄지 (문자 메시지 등)
 */
export function AiResult({ ai, onApply, applyLabel = '적용하기', editable = false, plain = false, title = 'AI 초안', extra, hideCopy }) {
  const [editing, setEditing] = useState(false);
  if (!ai.busy && !ai.result && !ai.error) return null;
  if (ai.busy) {
    return html`<div class="ai-panel" aria-live="polite">
      <div class="ai-thinking"><span class="ai-dots"><span></span><span></span><span></span></span> AI가 작성하고 있습니다… (보통 5~20초)</div>
    </div>`;
  }
  if (ai.error) {
    const pii = ai.error.data && ai.error.data.pii;
    return html`<${Callout} kind=${pii ? 'warn' : 'danger'} title=${pii ? '개인정보 감지' : 'AI 오류'}>
      ${ai.error.message}
      ${!pii && ai.retry ? html`<div class="mt-2"><${Button} size="sm" icon="refresh-cw" onClick=${ai.retry}>다시 시도</${Button}></div>` : null}
    </${Callout}>`;
  }
  const r = ai.result;
  const text = r.text || '';
  return html`<div class="ai-panel" aria-live="polite">
    <div class="ai-panel-head">
      <${Icon} name="sparkles" size=${15} />
      <span>${title}</span>
      ${r.demo ? html`<${Badge} color="amber">데모 예시</${Badge}>` : html`<${Badge} color="purple" title=${r.model}>${r.tier === 'smart' ? '상위 모델' : '빠른 모델'}</${Badge}>`}
      <span class="grow"></span>
      ${r.usage ? html`<span class="small muted num" title="예상 비용">${r.usage.inputTokens + r.usage.outputTokens}토큰 · 약 ${r.usage.costKrw < 1 ? '1원 미만' : Math.round(r.usage.costKrw) + '원'}</span>` : null}
    </div>
    <div class="ai-panel-body stack">
      ${r.pii && r.pii.message ? html`<${Callout} kind="warn" icon="shield-check">${r.pii.message}</${Callout}>` : null}
      ${r.notice ? html`<${Callout} kind="info">${r.notice}</${Callout}>` : null}
      ${editable && editing
        ? html`<${Textarea} rows=${14} value=${text} onInput=${(e) => ai.setText(e.target.value)} aria-label="AI 결과 고치기" />`
        : html`<${Markdown} text=${text} />`}
      ${extra}
      <div class="row wrap">
        ${onApply ? html`<${Button} variant="primary" icon="check" onClick=${() => onApply(text, r)}>${applyLabel}</${Button}>` : null}
        ${!hideCopy ? html`<${Button} icon="copy" onClick=${() => copyText(plain ? stripMarkdown(text) : text)}>복사</${Button}>` : null}
        ${editable ? html`<${Button} icon=${editing ? 'eye' : 'pencil'} onClick=${() => setEditing(!editing)}>${editing ? '미리보기' : '직접 고치기'}</${Button}>` : null}
        <${Button} variant="ghost" icon="refresh-cw" onClick=${ai.retry}>다시 만들기</${Button}>
      </div>
      <p class="small muted">AI 초안은 틀릴 수 있습니다. 사실·금액·날짜는 꼭 확인한 뒤 사용하세요.</p>
    </div>
  </div>`;
}

/** AI 실행 버튼 (보라색) */
export function AiButton({ children = 'AI로 만들기', ...rest }) {
  return html`<${Button} variant="ai" icon="sparkles" ...${rest}>${children}</${Button}>`;
}

