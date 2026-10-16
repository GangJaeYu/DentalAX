/*
 * 이 파일이 하는 일: AI 연동 자동 테스트 — 실제 AI 회사에 접속하지 않고 "가짜 응답"으로 확인합니다.
 *  - 3개 공급자(Claude/OpenAI/Gemini)의 요청 형식(주소, 머리글, 본문)과 사용량 해석
 *  - 오류(키 오류, 한도 초과, 서버 오류, 시간 초과, 인터넷 끊김)를 쉬운 한국어로 바꾸는지
 *  - 비용 계산, 월 예산 차단/경고, 개인정보 필터(가린 글만 전송, 주민번호는 전송 자체를 안 함)
 *  - API 키 암호화 저장, 화면으로 키가 나가지 않는지, 키가 없으면 데모로 대체되는지
 */
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeUser } = require('./helpers');
const { callProvider, AiError } = require('../server/ai/providers');

// ---------- 가짜 fetch ----------
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const r = await handler(url, init);
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status || 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

const anthropicOk = { body: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: '안녕하세요' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0 } } };
const openaiOk = { body: { model: 'gpt-6-luna', choices: [{ message: { content: '좋아요' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 } } } };
const geminiOk = { body: { candidates: [{ content: { parts: [{ text: '생각', thought: true }, { text: '결과' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 100, thoughtsTokenCount: 50 } } };

const baseOpts = { apiKey: 'sk-test-key-1234', model: 'm', system: '시스템', messages: [{ role: 'user', content: '질문' }], maxTokens: 500, timeoutMs: 2000 };

test('Anthropic 요청 형식과 사용량 해석', async () => {
  const f = fakeFetch(() => anthropicOk);
  const r = await callProvider('anthropic', { ...baseOpts, model: 'claude-haiku-5-5' }, f);
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.headers['x-api-key'], 'sk-test-key-1234');
  assert.equal(c.headers['anthropic-version'], '2023-06-01');
  assert.equal(c.body.system, '시스템');
  assert.equal(c.body.model, 'claude-haiku-5-5');
  assert.ok(!('temperature' in c.body), '최신 Claude는 temperature를 보내면 오류가 나므로 보내지 않음');
  assert.ok(c.body.max_tokens >= 500);
  assert.deepEqual(r, { text: '안녕하세요', inputTokens: 1000, cachedTokens: 0, outputTokens: 500, model: 'claude-haiku-5-5', truncated: false });
});

test('OpenAI 요청 형식(max_completion_tokens, reasoning_effort)과 캐시 토큰 분리', async () => {
  const f = fakeFetch(() => openaiOk);
  const r = await callProvider('openai', { ...baseOpts, model: 'gpt-6-luna', reasoningEffort: 'low' }, f);
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(c.headers.authorization, 'Bearer sk-test-key-1234');
  assert.equal(c.body.messages[0].role, 'system');
  assert.ok(c.body.max_completion_tokens >= 500);
  assert.ok(!('max_tokens' in c.body));
  assert.equal(c.body.reasoning_effort, 'low');
  assert.equal(r.inputTokens, 1000);
  assert.equal(r.cachedTokens, 200);
  assert.equal(r.outputTokens, 300);
  // OpenAI 호환 서버 주소를 쓰면 그 주소로 보내고 reasoning_effort는 빼고 보냄
  const f2 = fakeFetch(() => openaiOk);
  await callProvider('openai', { ...baseOpts, baseUrl: 'http://192.168.0.20:11434/v1/', reasoningEffort: 'low' }, f2);
  assert.equal(f2.calls[0].url, 'http://192.168.0.20:11434/v1/chat/completions');
  assert.ok(!('reasoning_effort' in f2.calls[0].body));
});

test('Gemini 요청 형식과 생각 토큰을 출력 요금에 포함', async () => {
  const f = fakeFetch(() => geminiOk);
  const r = await callProvider('gemini', { ...baseOpts, model: 'gemini-3.5-flash-lite' }, f);
  const c = f.calls[0];
  assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(c.headers['x-goog-api-key'], 'sk-test-key-1234');
  assert.ok(!c.url.includes('key='), '키를 주소에 넣지 않음(기록 노출 방지)');
  assert.equal(c.body.systemInstruction.parts[0].text, '시스템');
  assert.equal(c.body.contents[0].role, 'user');
  assert.equal(r.text, '결과', '생각(thought) 부분은 답에서 제외');
  assert.equal(r.outputTokens, 150);
});

test('오류를 쉬운 한국어로 바꾼다', async () => {
  const cases = [
    [{ status: 401, body: '{"error":"invalid x-api-key"}' }, 'auth', /키가 올바르지/],
    [{ status: 429, body: '{"error":"rate limit"}' }, 'rate', /잠깐 사이에/],
    [{ status: 429, body: '{"error":{"code":"insufficient_quota"}}' }, 'quota', /한도나 충전/],
    [{ status: 529, body: 'overloaded' }, 'server', /혼잡/],
    [{ status: 404, body: '{"error":"model not found"}' }, 'bad_request', /모델 이름/],
  ];
  for (const [resp, kind, re] of cases) {
    await assert.rejects(callProvider('anthropic', baseOpts, fakeFetch(() => resp)), (e) => e instanceof AiError && e.kind === kind && re.test(e.message));
  }
  await assert.rejects(callProvider('openai', baseOpts, fakeFetch(() => new TypeError('fetch failed'))), (e) => e.kind === 'network' && /인터넷/.test(e.message));
});

test('응답이 늦으면 시간 초과로 중단한다', async () => {
  const slow = async (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  await assert.rejects(callProvider('gemini', { ...baseOpts, timeoutMs: 150 }, slow), (e) => e.kind === 'timeout' && /초 안에/.test(e.message));
});

// ---------- 서버를 통한 통합 테스트 ----------
let s;
let staff;
const realFetch = globalThis.fetch;
let providerCalls = [];

before(async () => {
  s = await startServer({ demo: true });
  staff = (await makeUser(s.admin, { name: '직원AI', role: 'staff', username: 'aistaff' })).client;
});
after(async () => {
  globalThis.fetch = realFetch;
  if (s) await s.close();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 테스트 서버는 같은 프로세스에서 돌므로, AI 회사 주소로 가는 요청만 가로챔 */
function interceptProviders(handler) {
  providerCalls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (/anthropic\.com|openai\.com|googleapis\.com/.test(u)) {
      providerCalls.push({ url: u, body: JSON.parse(init.body) });
      const r = await handler(u, init);
      return new Response(JSON.stringify(r.body), { status: r.status || 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
}

async function aiSettings(patch) {
  const cur = (await s.admin.get('/api/admin/ai')).data.settings;
  const r = await s.admin.put('/api/admin/ai', { ...cur, ...patch });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

test('API 키는 암호화되어 저장되고 화면으로 나가지 않는다', async () => {
  const key = 'sk-ant-test-SECRET-abcdef9876';
  const r = await s.admin.put('/api/admin/ai/key', { provider: 'anthropic', key });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.data).includes(key));
  assert.equal(r.data.keys.anthropic.hint, '9876');
  const view = await s.admin.get('/api/admin/ai');
  assert.ok(!JSON.stringify(view.data).includes('SECRET'));
  const { get } = require('../server/core/db');
  const row = get("SELECT * FROM secrets WHERE name = 'ai_key_anthropic'");
  assert.ok(!row.ciphertext.includes('SECRET'));
  assert.ok(!Buffer.from(row.ciphertext, 'base64').toString('utf8').includes('SECRET'));
  // 직원은 AI 설정을 볼 수 없음
  assert.equal((await staff.get('/api/admin/ai')).status, 403);
});

test('실제 공급자로 호출하면 비용을 계산해 기록하고, 개인정보는 가린 글만 보낸다', async () => {
  await aiSettings({ provider: 'anthropic', exchangeRate: 1400, monthlyBudgetKrw: 30000, budgetAction: 'block' });
  interceptProviders(() => anthropicOk);
  const r = await staff.post('/api/ai/run', { feature: 'board.polish', input: { kind: 'handover', text: '홍길동 환자 010-9876-5432 리콜 전화' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.demo, false);
  assert.equal(r.data.provider, 'anthropic');
  assert.equal(providerCalls.length, 1);
  const sent = JSON.stringify(providerCalls[0].body);
  assert.ok(!sent.includes('010-9876-5432'), '전화번호 원문은 전송되지 않음');
  assert.ok(sent.includes('[전화번호]'));
  assert.ok(!sent.includes('홍길동'));
  assert.equal(providerCalls[0].body.model, 'claude-haiku-5-5', 'board.polish 기본 등급 fast → Haiku');
  // 비용: 입력 1000 × $0.1/1M + 출력 500 × $0.5/1M = $0.00035 → 0.49원
  assert.equal(r.data.usage.inputTokens, 1000);
  assert.equal(r.data.usage.costKrw, 0.49);
  const { get } = require('../server/core/db');
  const row = get("SELECT * FROM ai_usage WHERE status = 'ok' ORDER BY id DESC LIMIT 1");
  assert.equal(row.feature, 'board.polish');
  assert.ok(Math.abs(row.cost_usd - 0.00035) < 1e-9);
  assert.equal(row.pii_types, 'phone,name');
});

test('주민등록번호가 있으면 AI로 아예 보내지 않는다', async () => {
  interceptProviders(() => anthropicOk);
  const r = await staff.post('/api/ai/run', { feature: 'board.polish', input: { kind: 'notice', text: '주민번호 900101-1234567 확인' } });
  assert.equal(r.status, 422);
  assert.equal(r.data.error.kind, 'pii');
  assert.match(r.data.error.message, /보내지 않았습니다/);
  assert.equal(providerCalls.length, 0);
});

test('기능별 등급을 상위로 바꾸면 상위 모델을 쓴다', async () => {
  await aiSettings({ featureTiers: { 'board.polish': 'smart' } });
  interceptProviders(() => anthropicOk);
  await staff.post('/api/ai/run', { feature: 'board.polish', input: { kind: 'notice', text: '회의 안내' } });
  assert.equal(providerCalls[0].body.model, 'claude-sonnet-5-5');
  await aiSettings({ featureTiers: {} });
});

test('월 예산을 넘으면 차단하고, 경고 모드에서는 안내만 한다', async () => {
  const { run } = require('../server/core/db');
  run(
    "INSERT INTO ai_usage (at, feature, provider, model, cost_usd, cost_krw, status) VALUES (?, 'board.polish', 'anthropic', 'x', 1, 50000, 'ok')",
    new Date().toISOString()
  );
  interceptProviders(() => anthropicOk);
  const blocked = await staff.post('/api/ai/run', { feature: 'board.polish', input: { kind: 'notice', text: '회의 안내' } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.error.kind, 'budget');
  assert.equal(providerCalls.length, 0);
  await aiSettings({ budgetAction: 'warn' });
  const warned = await staff.post('/api/ai/run', { feature: 'board.polish', input: { kind: 'notice', text: '회의 안내' } });
  assert.equal(warned.status, 200);
  assert.match(warned.data.notice, /예산을 넘었습니다/);
  // 정리
  run("DELETE FROM ai_usage WHERE cost_krw = 50000");
  await aiSettings({ budgetAction: 'block' });
});

test('공급자 오류는 502와 쉬운 안내로 돌려주고 기록한다', async () => {
  interceptProviders(() => ({ status: 401, body: { error: 'bad key' } }));
  const r = await staff.post('/api/ai/run', { feature: 'board.polish', input: { kind: 'notice', text: '회의 안내' } });
  assert.equal(r.status, 502);
  assert.match(r.data.error.message, /API 키가 올바르지/);
  const { get } = require('../server/core/db');
  assert.equal(get("SELECT status FROM ai_usage ORDER BY id DESC LIMIT 1").status, 'error');
});

test('연결 테스트 버튼', async () => {
  interceptProviders(() => anthropicOk);
  const r = await s.admin.post('/api/admin/ai/test', { provider: 'anthropic' });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test('OpenAI·Gemini로 바꿔도 같은 기능이 동작한다', async () => {
  await s.admin.put('/api/admin/ai/key', { provider: 'openai', key: 'sk-openai-test-1111' });
  await s.admin.put('/api/admin/ai/key', { provider: 'gemini', key: 'AIza-gemini-test-2222' });
  await aiSettings({ provider: 'openai' });
  interceptProviders(() => openaiOk);
  let r = await staff.post('/api/ai/run', { feature: 'board.polish', input: { kind: 'notice', text: '회의 안내' } });
  assert.equal(r.status, 200);
  assert.equal(providerCalls[0].body.model, 'gpt-6-luna');
  await aiSettings({ provider: 'gemini' });
  interceptProviders(() => geminiOk);
  r = await staff.post('/api/ai/run', { feature: 'board.polish', input: { kind: 'notice', text: '회의 안내' } });
  assert.equal(r.status, 200);
  assert.ok(providerCalls[0].url.includes('gemini-3.5-flash-lite'));
});

test('키를 지우면 데모 모드로 대신 응답하고 이유를 알려 준다', async () => {
  await aiSettings({ provider: 'anthropic' });
  await s.admin.del('/api/admin/ai/key/anthropic');
  interceptProviders(() => anthropicOk);
  const r = await staff.post('/api/ai/run', { feature: 'board.polish', input: { kind: 'notice', text: '회의 안내' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.demo, true);
  assert.match(r.data.notice, /키가 없거나/);
  assert.equal(providerCalls.length, 0);
  const st = await staff.get('/api/ai/status');
  assert.equal(st.data.demo, true);
  assert.equal(st.data.budget.usedKrw, undefined, '직원에게는 금액을 보여 주지 않음');
});

test('AI 사용량 요약(관리 화면)', async () => {
  const r = await s.admin.get('/api/admin/usage');
  assert.equal(r.status, 200);
  assert.ok(r.data.total.calls >= 5);
  assert.ok(r.data.byFeature.some((f) => f.feature === 'board.polish'));
  assert.ok(r.data.recent.length > 0);
  assert.ok(!JSON.stringify(r.data).includes('리콜 전화'), '사용 기록에 글 내용은 없음');
});

test('잘못된 설정값은 저장하지 않는다', async () => {
  const cur = (await s.admin.get('/api/admin/ai')).data.settings;
  assert.equal((await s.admin.put('/api/admin/ai', { ...cur, provider: 'evil' })).status, 400);
  assert.equal((await s.admin.put('/api/admin/ai', { ...cur, monthlyBudgetKrw: -5 })).status, 400);
  assert.equal((await s.admin.put('/api/admin/ai/key', { provider: 'openai', key: '한글 키 입니다 정말로' })).status, 400);
});
