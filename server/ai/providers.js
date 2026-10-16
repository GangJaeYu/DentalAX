/*
 * 이 파일이 하는 일: 실제 AI 회사(Anthropic Claude, OpenAI, Google Gemini)의 API를 호출합니다.
 *
 * 세 회사의 요청·응답 형식이 서로 달라서, 여기서 "같은 모양"으로 맞춰 줍니다.
 *   입력: { apiKey, model, system, messages:[{role:'user'|'assistant', content}], maxTokens, timeoutMs }
 *   출력: { text, inputTokens, outputTokens, cachedTokens, model }
 *
 * 오류가 나면 AiError(종류, 쉬운 한국어 안내)를 던집니다. 화면에는 그 안내가 그대로 보입니다.
 * 회사 SDK(전용 라이브러리)를 쓰지 않고 공식 REST API를 직접 호출합니다 (의존성 최소화).
 */

class AiError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind; // auth / rate / quota / timeout / network / server / bad_request / empty / safety
    this.status = status;
  }
}

// 사고(reasoning)형 모델은 답을 쓰기 전에 생각하는 데도 토큰을 씁니다. 답이 잘리지 않도록 여유분을 더합니다.
const THINKING_HEADROOM = 4000;

/** HTTP 오류를 쉬운 한국어로 바꿈 */
function httpErrorToAi(status, bodyText, providerLabel) {
  const lower = String(bodyText || '').toLowerCase();
  if (status === 401 || status === 403) {
    return new AiError('auth', `${providerLabel} API 키가 올바르지 않거나 권한이 없습니다. 관리 → AI 설정에서 키를 확인해 주세요.`, status);
  }
  if (status === 429) {
    if (lower.includes('quota') || lower.includes('billing') || lower.includes('credit') || lower.includes('insufficient')) {
      return new AiError('quota', `${providerLabel} 계정의 사용 한도나 충전 잔액이 부족합니다. 해당 회사 사이트에서 결제 정보를 확인해 주세요.`, status);
    }
    return new AiError('rate', '잠깐 사이에 요청이 많았습니다. 1분쯤 뒤에 다시 시도해 주세요.', status);
  }
  if (status === 402) {
    return new AiError('quota', `${providerLabel} 계정의 충전 잔액이 부족합니다.`, status);
  }
  if (status === 400 || status === 404 || status === 422) {
    if (lower.includes('model')) {
      return new AiError('bad_request', `AI 모델 이름이 올바르지 않거나 더 이상 제공되지 않습니다. 관리 → AI 설정에서 모델 이름을 확인해 주세요.`, status);
    }
    if (lower.includes('credit') || lower.includes('balance')) {
      return new AiError('quota', `${providerLabel} 계정의 충전 잔액이 부족합니다.`, status);
    }
    return new AiError('bad_request', `AI 요청 형식에 문제가 있습니다(${status}). 글이 너무 길면 줄여서 다시 시도해 주세요.`, status);
  }
  if (status === 529 || status >= 500) {
    return new AiError('server', `${providerLabel} 서비스가 일시적으로 혼잡하거나 장애 중입니다. 잠시 후 다시 시도해 주세요.`, status);
  }
  return new AiError('server', `AI 서비스에서 알 수 없는 오류(${status})가 났습니다.`, status);
}

/** 시간 제한이 있는 fetch. 시간이 넘으면 중단하고 timeout 오류 */
async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, providerLabel) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw httpErrorToAi(res.status, text, providerLabel);
    try {
      return JSON.parse(text);
    } catch {
      throw new AiError('server', 'AI 서비스 응답을 해석하지 못했습니다.');
    }
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e.name === 'AbortError') {
      throw new AiError('timeout', `AI 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않아 중단했습니다. 내용을 줄이거나 잠시 후 다시 시도해 주세요.`);
    }
    throw new AiError('network', 'AI 서비스에 연결하지 못했습니다. 이 PC의 인터넷 연결을 확인해 주세요.');
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- Anthropic Claude ----------------
async function callAnthropic(opts, fetchImpl) {
  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens + THINKING_HEADROOM,
    system: opts.system || undefined,
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
    // ※ 최신 Claude 모델은 temperature 등을 기본값이 아닌 값으로 보내면 오류가 나므로 보내지 않습니다.
  };
  const data = await fetchWithTimeout(
    fetchImpl,
    (opts.baseUrl || 'https://api.anthropic.com') + '/v1/messages',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs,
    'Anthropic'
  );
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  const u = data.usage || {};
  if (!text) {
    if (data.stop_reason === 'refusal') throw new AiError('safety', 'AI가 이 요청에 답하지 않았습니다. 표현을 바꿔 다시 시도해 주세요.');
    throw new AiError('empty', 'AI가 빈 답을 보냈습니다. 다시 시도해 주세요.');
  }
  return {
    text,
    // 캐시 읽기/쓰기 토큰도 입력에 포함해 계산 (보수적으로)
    inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    cachedTokens: u.cache_read_input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    model: data.model || opts.model,
    truncated: data.stop_reason === 'max_tokens',
  };
}

// ---------------- OpenAI (및 OpenAI 호환 서버) ----------------
async function callOpenAI(opts, fetchImpl) {
  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) messages.push({ role: m.role, content: m.content });
  const body = {
    model: opts.model,
    messages,
    // 사고형 모델은 max_tokens 대신 max_completion_tokens 를 씁니다 (생각 토큰 포함 상한)
    max_completion_tokens: opts.maxTokens + THINKING_HEADROOM,
  };
  if (opts.reasoningEffort && !opts.baseUrl) body.reasoning_effort = opts.reasoningEffort;
  const base = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const data = await fetchWithTimeout(
    fetchImpl,
    base + '/chat/completions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(body),
    },
    opts.timeoutMs,
    'OpenAI'
  );
  const choice = (data.choices || [])[0] || {};
  const text = String(choice.message?.content || '').trim();
  const u = data.usage || {};
  if (!text) {
    if (choice.message?.refusal) throw new AiError('safety', 'AI가 이 요청에 답하지 않았습니다. 표현을 바꿔 다시 시도해 주세요.');
    if (choice.finish_reason === 'length') throw new AiError('empty', 'AI가 생각하는 데 글자 수를 다 써서 답을 못 했습니다. 내용을 줄여 다시 시도해 주세요.');
    throw new AiError('empty', 'AI가 빈 답을 보냈습니다. 다시 시도해 주세요.');
  }
  const cached = u.prompt_tokens_details?.cached_tokens || 0;
  return {
    text,
    inputTokens: Math.max(0, (u.prompt_tokens || 0) - cached),
    cachedTokens: cached,
    outputTokens: u.completion_tokens || 0, // 생각(reasoning) 토큰 포함
    model: data.model || opts.model,
    truncated: choice.finish_reason === 'length',
  };
}

// ---------------- Google Gemini ----------------
async function callGemini(opts, fetchImpl) {
  const body = {
    contents: opts.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: opts.maxTokens + THINKING_HEADROOM },
  };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
  const base = (opts.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const data = await fetchWithTimeout(
    fetchImpl,
    `${base}/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body: JSON.stringify(body),
    },
    opts.timeoutMs,
    'Google Gemini'
  );
  const cand = (data.candidates || [])[0] || {};
  const text = (cand.content?.parts || [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
  const u = data.usageMetadata || {};
  if (!text) {
    if (data.promptFeedback?.blockReason || cand.finishReason === 'SAFETY') {
      throw new AiError('safety', 'AI 안전 정책 때문에 답을 받지 못했습니다. 표현을 바꿔 다시 시도해 주세요.');
    }
    throw new AiError('empty', 'AI가 빈 답을 보냈습니다. 다시 시도해 주세요.');
  }
  const cached = u.cachedContentTokenCount || 0;
  return {
    text,
    inputTokens: Math.max(0, (u.promptTokenCount || 0) - cached),
    cachedTokens: cached,
    // 생각 토큰(thoughtsTokenCount)도 출력 요금으로 청구됨
    outputTokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
    model: data.modelVersion || opts.model,
    truncated: cand.finishReason === 'MAX_TOKENS',
  };
}

const CALLERS = { anthropic: callAnthropic, openai: callOpenAI, gemini: callGemini };

/**
 * 공급자 이름으로 호출. fetchImpl은 테스트에서 가짜 서버를 끼우려고 바꿀 수 있게 둠
 */
async function callProvider(provider, opts, fetchImpl = globalThis.fetch) {
  const fn = CALLERS[provider];
  if (!fn) throw new AiError('bad_request', '지원하지 않는 AI 공급자입니다.');
  return fn(opts, fetchImpl);
}

module.exports = { callProvider, AiError, httpErrorToAi, THINKING_HEADROOM };
