/*
 * 이 파일이 하는 일: AI 설정의 기본값(공급자, 등급별 모델, 가격표, 예산, 환율)을 정합니다.
 *
 * ※ 모델 이름과 가격은 2026-10-16에 각 회사 공식 가격 페이지에서 확인한 값입니다. (출처는 docs/COST.md)
 *   가격은 자주 바뀌므로 관리 → AI 설정 화면에서 언제든 고칠 수 있습니다. 여기 값은 "처음 설치했을 때"만 쓰입니다.
 *
 * 등급(tier)
 *   fast  : 짧고 간단한 일 (분류, 짧은 문구, 체크리스트 초안) → 저렴한 소형 모델
 *   smart : 긴 글·요약·근거 기반 답변 (문서 작성, 회의록, AI 도우미) → 중간급 모델
 */

const PRICE_CHECKED = '2026-10-16';

// 가격: 1백만(1M) 토큰당 미국 달러(USD). input=보내는 글, output=받는 글, cached=캐시된 입력
const DEFAULT_PRICES = [
  { provider: 'anthropic', model: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', input: 0.1, output: 0.5, cached: 0.01 },
  { provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', input: 2, output: 10, cached: 0.1 },
  { provider: 'anthropic', model: 'claude-opus-5-5', label: 'Claude Opus 5.5', input: 4, output: 20, cached: 0.2 },
  { provider: 'openai', model: 'gpt-6-luna', label: 'GPT-6 Luna', input: 0.1, output: 0.5, cached: 0.01 },
  { provider: 'openai', model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', input: 2, output: 10, cached: 0.1 },
  { provider: 'openai', model: 'gpt-6-astra', label: 'GPT-6 Astra', input: 10, output: 50, cached: 1 },
  { provider: 'gemini', model: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', input: 0.3, output: 2.5, cached: 0.03 },
  // Gemini 3.8 Flash는 2027-01-01부터 입력 1.50 / 출력 7.50으로 인상 예정(공식 공지)
  { provider: 'gemini', model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', input: 0.75, output: 3.75, cached: 0.075 },
  // Gemini 4 Argon은 2026-12-01부터 입력 4.00 / 출력 20.00으로 인상 예정(공식 공지)
  { provider: 'gemini', model: 'gemini-4-argon', label: 'Gemini 4 Argon', input: 2, output: 10, cached: 0.1 },
];

const PROVIDERS = {
  demo: { label: '데모 모드 (키 없이 예시 응답)', needsKey: false },
  anthropic: { label: 'Anthropic Claude', needsKey: true, keyUrl: 'https://platform.claude.com/settings/keys' },
  openai: { label: 'OpenAI', needsKey: true, keyUrl: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'Google Gemini', needsKey: true, keyUrl: 'https://aistudio.google.com/apikey' },
};

function defaultAiSettings() {
  return {
    provider: 'demo',
    models: {
      anthropic: { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' },
      openai: { fast: 'gpt-6-luna', smart: 'gpt-6.1-sol' },
      gemini: { fast: 'gemini-3.5-flash-lite', smart: 'gemini-3.8-flash' },
    },
    // OpenAI 호환 서버(사내 AI 서버 등)를 쓸 때만 바꿉니다. 비워 두면 OpenAI 공식 주소.
    openaiBaseUrl: '',
    // OpenAI 추론(reasoning) 모델의 생각 정도. low가 비용과 속도에 유리합니다.
    openaiReasoningEffort: 'low',
    featureTiers: {}, // 기능별 등급 변경값 { 'docs.write': 'smart', ... } (비어 있으면 기능 기본값)
    monthlyBudgetKrw: 30000, // 월 예산(원). 0이면 한도 없음
    budgetAction: 'block', // block: 초과 시 차단 / warn: 경고만
    warnRatio: 0.8, // 예산의 80%부터 경고
    exchangeRate: 1400, // 1달러 = 몇 원 (2026-10-15 종가 약 1,345원에 여유를 둔 값)
    piiMode: 'mask', // mask: 가리고 보냄(주민번호·카드번호는 항상 차단) / block: 하나라도 감지되면 차단
    timeoutSec: 60,
    prices: DEFAULT_PRICES,
    pricesCheckedAt: PRICE_CHECKED,
  };
}

module.exports = { defaultAiSettings, DEFAULT_PRICES, PROVIDERS, PRICE_CHECKED };
