/*
 * 이 파일이 하는 일: 모든 AI 기능이 거치는 "한 개의 관문"입니다.
 *
 * AI 요청 하나가 처리되는 순서
 *   1) 입력 검사      — 기능별로 정해 둔 칸(목적, 내용 등)이 올바른지 확인
 *   2) 질문지 만들기   — 기능별 build()가 AI에게 보낼 지시문(system)과 본문(prompt)을 만듦
 *   3) 개인정보 필터   — 본문에서 주민번호·전화번호 등을 찾아 가리거나 차단 (pii.js)
 *   4) 공급자 결정     — 데모 모드이거나 키가 없으면 예시 응답, 아니면 실제 AI
 *   5) 예산 확인       — 이번 달 사용액이 월 예산을 넘었으면 차단(또는 경고)
 *   6) 호출·기록       — 사용 토큰과 예상 비용을 ai_usage 표에 기록 (글 내용은 저장하지 않음)
 *
 * 기능(feature) 정의 모양 — 각 모듈의 ai.js 에 있습니다.
 *   { key, label, group, tier:'fast'|'smart', maxTokens, input: v.object(...),
 *     build(input, ctx) → { system, prompt, messages?, sources? },
 *     demo(input, ctx) → '예시 응답 글', parse?(text) → 구조화 데이터 }
 */
const { get, run, all } = require('../core/db');
const { getSetting, setSetting } = require('../core/settings');
const { getSecret } = require('../core/secrets');
const { HttpError } = require('../core/errors');
const { defaultAiSettings, PROVIDERS } = require('./defaults');
const pii = require('./pii');
const { callProvider, AiError } = require('./providers');
const time = require('../core/time');

const features = new Map();

function registerFeatures(list) {
  for (const f of list || []) features.set(f.key, f);
}
function getFeature(key) {
  return features.get(key);
}
function listFeatures() {
  return [...features.values()];
}

// ---------- 설정 ----------
function getAiSettings() {
  const def = defaultAiSettings();
  const saved = getSetting('ai') || {};
  const s = { ...def, ...saved };
  s.models = { ...def.models };
  for (const p of Object.keys(def.models)) s.models[p] = { ...def.models[p], ...((saved.models || {})[p] || {}) };
  s.featureTiers = { ...(saved.featureTiers || {}) };
  if (!Array.isArray(s.prices) || !s.prices.length) s.prices = def.prices;
  return s;
}

function saveAiSettings(next) {
  setSetting('ai', next);
}

function tierFor(feature, settings) {
  return settings.featureTiers[feature.key] || feature.tier || 'fast';
}

function priceFor(settings, provider, model) {
  return settings.prices.find((p) => p.provider === provider && p.model === model) || null;
}

/** 토큰 수 → 예상 비용 (USD, 원) */
function estimateCost(settings, provider, model, inputTokens, outputTokens, cachedTokens = 0) {
  const p = priceFor(settings, provider, model);
  if (!p) return { usd: 0, krw: 0, priced: false };
  const usd = (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output + (cachedTokens / 1e6) * (p.cached ?? p.input);
  return { usd, krw: usd * (Number(settings.exchangeRate) || 0), priced: true };
}

// ---------- 예산 ----------
function monthStartIso() {
  const [y, m] = time.thisMonth().split('-').map(Number);
  return new Date(y, m - 1, 1).toISOString();
}

function monthSpendKrw() {
  const r = get("SELECT COALESCE(SUM(cost_krw), 0) AS krw FROM ai_usage WHERE at >= ? AND status = 'ok'", monthStartIso());
  return r.krw;
}

function budgetStatus(settings = getAiSettings()) {
  const used = monthSpendKrw();
  const limit = Number(settings.monthlyBudgetKrw) || 0;
  const ratio = limit > 0 ? used / limit : 0;
  return {
    usedKrw: Math.round(used),
    limitKrw: limit,
    ratio,
    warn: limit > 0 && ratio >= (settings.warnRatio || 0.8),
    over: limit > 0 && used >= limit,
    action: settings.budgetAction,
  };
}

// ---------- 사용량 기록 ----------
function logUsage(row) {
  run(
    `INSERT INTO ai_usage (at, user_id, user_name, feature, provider, model, input_tokens, output_tokens, cached_tokens,
       cost_usd, cost_krw, status, pii_types, duration_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    new Date().toISOString(),
    row.userId ?? null,
    row.userName ?? null,
    row.feature,
    row.provider,
    row.model ?? null,
    row.inputTokens || 0,
    row.outputTokens || 0,
    row.cachedTokens || 0,
    row.costUsd || 0,
    row.costKrw || 0,
    row.status,
    row.piiTypes || null,
    row.durationMs ?? null,
    row.error ? String(row.error).slice(0, 300) : null
  );
}

/** 대략적인 토큰 수 추정 (데모 모드 기록용). 한국어는 글자당 약 1토큰으로 넉넉히 계산 */
function roughTokens(s) {
  return Math.ceil(String(s || '').length * 1.0);
}

// ---------- 공통 지시문 ----------
function clinicContext() {
  const c = getSetting('clinic');
  return c;
}

/** 모든 AI 기능 앞에 붙는 공통 원칙 */
function baseSystem(clinic) {
  const name = clinic?.name ? `"${clinic.name}"` : '한 치과의원';
  return [
    `당신은 ${name}의 원내 업무를 돕는 AI 비서입니다. 사용자는 원장, 실장, 치과위생사, 간호조무사 등 치과 직원입니다.`,
    '원칙:',
    '- 한국어로, 정중하고 자연스럽게, 실제 치과에서 바로 쓸 수 있는 문장으로 씁니다.',
    '- 환자 개인정보(이름, 연락처, 주민번호, 차트번호, 진료 내용)를 만들어 내거나 추측하지 않습니다. 필요한 자리는 {이름}처럼 빈칸으로 둡니다.',
    '- [이름], [전화번호]처럼 대괄호로 가려진 부분은 개인정보 보호를 위해 가린 것이니 그대로 두거나 빈칸으로 처리합니다.',
    '- 의료법상 의료광고 규정을 지킵니다: 치료 효과를 보장하거나 단정하지 않고, "최고/최초/유일/100%" 같은 과장 표현, 다른 병원과의 비교, 치료 경험담 유도를 쓰지 않습니다.',
    '- 모르는 사실(가격, 법령 세부 조항 등)은 지어내지 말고 "확인 필요"라고 표시합니다.',
    '- 법률·노무·세무 자문을 대신하지 않습니다. 필요하면 전문가 확인을 권합니다.',
    '- 마크다운은 제목(#), 목록(-), 굵게(**) 정도만 간단히 씁니다.',
  ].join('\n');
}

// ---------- 실행 ----------
/**
 * AI 기능 하나를 실행합니다.
 * @param {string} featureKey  예) 'docs.write'
 * @param {object} rawInput    화면에서 보낸 입력
 * @param {object} req         Express 요청 (사용자 정보)
 * @param {{fetchImpl?: Function}} [opts]
 */
async function runFeature(featureKey, rawInput, req, opts = {}) {
  const feature = getFeature(featureKey);
  if (!feature) throw new HttpError(404, '알 수 없는 AI 기능입니다.');
  const input = feature.input ? feature.input.parse(rawInput || {}) : rawInput || {};
  const settings = getAiSettings();
  const clinic = clinicContext();
  const ctx = { clinic, user: req.user, today: time.today(), baseSystem: baseSystem(clinic) };
  const built = await feature.build(input, ctx);
  const system = built.system || ctx.baseSystem;
  const messages = built.messages || [{ role: 'user', content: built.prompt || '' }];

  // 3) 개인정보 필터 — 사용자가 입력한 본문(+검색해 붙인 원내 문서)에 적용
  const allow = [clinic.phone, clinic.email].filter(Boolean);
  const scan = pii.scanMany(
    messages.map((m) => m.content),
    { allow, mode: settings.piiMode }
  );
  const piiInfo = { findings: scan.findings, blocked: scan.blocked, message: pii.describe(scan.findings, scan.blocked) };
  const userInfo = { userId: req.user?.id, userName: req.user?.name };
  const piiTypes = scan.findings.map((f) => f.type).join(',') || null;

  if (scan.blocked) {
    logUsage({ ...userInfo, feature: featureKey, provider: settings.provider, status: 'blocked_pii', piiTypes });
    throw new HttpError(422, piiInfo.message, { kind: 'pii', pii: piiInfo });
  }
  const safeMessages = messages.map((m, i) => ({ role: m.role, content: scan.texts[i] }));

  // 4) 공급자 결정
  const tier = tierFor(feature, settings);
  let provider = settings.provider;
  let notice = '';
  let apiKey = null;
  if (provider !== 'demo') {
    apiKey = getSecret(`ai_key_${provider}`);
    if (!apiKey) {
      notice = `${PROVIDERS[provider]?.label || provider} API 키가 없거나 읽을 수 없어 데모 모드로 응답했습니다. 관리 → AI 설정에서 키를 입력해 주세요.`;
      provider = 'demo';
    }
  }

  const started = Date.now();
  if (provider === 'demo') {
    // 데모 응답도 개인정보를 가린 입력으로 만듦 (실제 AI와 똑같이 가려진 결과를 보게 됨)
    const text = await feature.demo(maskDeep(input, { allow, mode: settings.piiMode }), ctx);
    logUsage({
      ...userInfo,
      feature: featureKey,
      provider: 'demo',
      model: 'demo',
      inputTokens: roughTokens(system) + safeMessages.reduce((n, m) => n + roughTokens(m.content), 0),
      outputTokens: roughTokens(text),
      status: 'demo',
      piiTypes,
      durationMs: Date.now() - started,
    });
    return finish(feature, { text, demo: true, notice, pii: piiInfo, tier, provider: 'demo', model: 'demo', sources: built.sources });
  }

  // 5) 예산 확인
  const budget = budgetStatus(settings);
  if (budget.over && settings.budgetAction === 'block') {
    logUsage({ ...userInfo, feature: featureKey, provider, status: 'blocked_budget', piiTypes });
    throw new HttpError(
      429,
      `이번 달 AI 예산(${budget.limitKrw.toLocaleString('ko-KR')}원)을 모두 사용해 AI 기능을 잠시 멈췄습니다. 원장님이 관리 → AI 설정에서 예산을 늘릴 수 있습니다.`,
      { kind: 'budget', budget }
    );
  }

  // 6) 실제 호출
  const model = settings.models[provider]?.[tier];
  const timeoutMs = (feature.timeoutSec || settings.timeoutSec || 60) * 1000;
  try {
    const r = await callProvider(
      provider,
      {
        apiKey,
        model,
        system,
        messages: safeMessages,
        maxTokens: feature.maxTokens || 1500,
        timeoutMs,
        baseUrl: provider === 'openai' ? settings.openaiBaseUrl || '' : '',
        reasoningEffort: provider === 'openai' ? settings.openaiReasoningEffort : undefined,
      },
      opts.fetchImpl
    );
    const cost = estimateCost(settings, provider, model, r.inputTokens, r.outputTokens, r.cachedTokens);
    logUsage({
      ...userInfo,
      feature: featureKey,
      provider,
      model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cachedTokens: r.cachedTokens,
      costUsd: cost.usd,
      costKrw: cost.krw,
      status: 'ok',
      piiTypes,
      durationMs: Date.now() - started,
    });
    const after = budgetStatus(settings);
    if (r.truncated) notice = (notice ? notice + ' ' : '') + '답이 길어 중간에 잘렸을 수 있습니다.';
    if (after.over) notice = (notice ? notice + ' ' : '') + `이번 달 AI 예산을 넘었습니다(${after.usedKrw.toLocaleString('ko-KR')}원 / ${after.limitKrw.toLocaleString('ko-KR')}원).`;
    else if (after.warn) notice = (notice ? notice + ' ' : '') + `이번 달 AI 예산의 ${Math.round(after.ratio * 100)}%를 사용했습니다.`;
    return finish(feature, {
      text: r.text,
      demo: false,
      notice,
      pii: piiInfo,
      tier,
      provider,
      model,
      usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, costKrw: Math.round(cost.krw * 100) / 100 },
      sources: built.sources,
    });
  } catch (e) {
    const msg = e instanceof AiError ? e.message : 'AI 처리 중 알 수 없는 문제가 생겼습니다.';
    logUsage({
      ...userInfo,
      feature: featureKey,
      provider,
      model,
      status: 'error',
      piiTypes,
      durationMs: Date.now() - started,
      error: e instanceof AiError ? `${e.kind}:${e.status || ''}` : String(e.message || e),
    });
    if (!(e instanceof AiError)) console.error('[AI 오류]', e);
    throw new HttpError(502, msg, { kind: e.kind || 'unknown' });
  }
}

/** 입력 묶음 안의 모든 글자에 개인정보 가리기를 적용한 사본 */
function maskDeep(val, opts) {
  if (typeof val === 'string') return pii.scanText(val, opts).text;
  if (Array.isArray(val)) return val.map((x) => maskDeep(x, opts));
  if (val && typeof val === 'object') return Object.fromEntries(Object.entries(val).map(([k, x]) => [k, maskDeep(x, opts)]));
  return val;
}

/** 기능별 후처리(parse)를 붙여 최종 응답을 만듭니다 */
function finish(feature, result) {
  if (feature.parse) {
    try {
      result.data = feature.parse(result.text);
    } catch {
      result.data = null;
    }
  }
  return result;
}

/** AI 설정 화면의 "연결 테스트" 버튼 */
async function testConnection(provider, req, opts = {}) {
  const settings = getAiSettings();
  const apiKey = getSecret(`ai_key_${provider}`);
  if (!apiKey) throw new HttpError(400, '먼저 API 키를 저장해 주세요.');
  const model = settings.models[provider]?.fast;
  const started = Date.now();
  try {
    const r = await callProvider(
      provider,
      {
        apiKey,
        model,
        system: '연결 테스트입니다.',
        messages: [{ role: 'user', content: '"연결 성공"이라고만 답하세요.' }],
        maxTokens: 50,
        timeoutMs: 30000,
        baseUrl: provider === 'openai' ? settings.openaiBaseUrl || '' : '',
        reasoningEffort: provider === 'openai' ? settings.openaiReasoningEffort : undefined,
      },
      opts.fetchImpl
    );
    const cost = estimateCost(settings, provider, model, r.inputTokens, r.outputTokens, r.cachedTokens);
    logUsage({
      userId: req.user?.id,
      userName: req.user?.name,
      feature: 'admin.test',
      provider,
      model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUsd: cost.usd,
      costKrw: cost.krw,
      status: 'ok',
      durationMs: Date.now() - started,
    });
    return { ok: true, model, reply: r.text.slice(0, 100), durationMs: Date.now() - started };
  } catch (e) {
    logUsage({ userId: req.user?.id, userName: req.user?.name, feature: 'admin.test', provider, model, status: 'error', error: e.kind || e.message });
    throw new HttpError(502, e instanceof AiError ? e.message : '연결 테스트 중 문제가 생겼습니다.', { kind: e.kind });
  }
}

/** AI 응답 안의 JSON을 꺼냅니다 (```json ... ``` 코드 블록 또는 첫 [ / { 부터) */
function extractJson(text) {
  const s = String(text || '');
  const block = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = block ? block[1] : s;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const open = candidate[start];
  const close = open === '[' ? ']' : '}';
  const end = candidate.lastIndexOf(close);
  if (end <= start) return null;
  return JSON.parse(candidate.slice(start, end + 1));
}

/** 사용량 통계 (관리 화면용) */
function usageSummary(month) {
  const ym = month || time.thisMonth();
  const [y, m] = ym.split('-').map(Number);
  const from = new Date(y, m - 1, 1).toISOString();
  const to = new Date(y, m, 1).toISOString();
  const rows = all('SELECT * FROM ai_usage WHERE at >= ? AND at < ? ORDER BY at DESC', from, to);
  const total = { calls: 0, ok: 0, errors: 0, blockedPii: 0, blockedBudget: 0, demo: 0, inputTokens: 0, outputTokens: 0, costKrw: 0, costUsd: 0 };
  const byFeature = {};
  const byUser = {};
  const byDay = {};
  for (const r of rows) {
    total.calls++;
    if (r.status === 'ok') total.ok++;
    else if (r.status === 'error') total.errors++;
    else if (r.status === 'blocked_pii') total.blockedPii++;
    else if (r.status === 'blocked_budget') total.blockedBudget++;
    else if (r.status === 'demo') total.demo++;
    total.inputTokens += r.input_tokens;
    total.outputTokens += r.output_tokens;
    total.costKrw += r.cost_krw;
    total.costUsd += r.cost_usd;
    const f = (byFeature[r.feature] ||= { feature: r.feature, label: getFeature(r.feature)?.label || r.feature, calls: 0, costKrw: 0, tokens: 0 });
    f.calls++;
    f.costKrw += r.cost_krw;
    f.tokens += r.input_tokens + r.output_tokens;
    const uName = r.user_name || '알 수 없음';
    const u = (byUser[uName] ||= { user: uName, calls: 0, costKrw: 0 });
    u.calls++;
    u.costKrw += r.cost_krw;
    const day = time.toDateStr(new Date(r.at));
    const d = (byDay[day] ||= { day, calls: 0, costKrw: 0 });
    d.calls++;
    d.costKrw += r.cost_krw;
  }
  const recent = rows.slice(0, 50).map((r) => ({
    at: r.at,
    user: r.user_name,
    feature: getFeature(r.feature)?.label || r.feature,
    provider: r.provider,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costKrw: r.cost_krw,
    status: r.status,
    piiTypes: r.pii_types,
    durationMs: r.duration_ms,
    error: r.error,
  }));
  return {
    month: ym,
    total,
    byFeature: Object.values(byFeature).sort((a, b) => b.calls - a.calls),
    byUser: Object.values(byUser).sort((a, b) => b.calls - a.calls),
    byDay: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
    recent,
    budget: budgetStatus(),
  };
}

module.exports = {
  registerFeatures,
  getFeature,
  listFeatures,
  getAiSettings,
  saveAiSettings,
  estimateCost,
  budgetStatus,
  monthSpendKrw,
  runFeature,
  testConnection,
  extractJson,
  usageSummary,
  baseSystem,
  tierFor,
  logUsage,
};
