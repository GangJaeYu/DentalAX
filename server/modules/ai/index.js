/*
 * 이 파일이 하는 일: 화면에서 AI 기능을 부르는 공통 API입니다.
 *
 *   GET  /api/ai/status   지금 AI 상태 (데모 모드인지, 이번 달 예산 사용률)
 *   POST /api/ai/run      { feature: '기능 이름', input: { ... } } → AI 결과
 *
 * 실제 처리(개인정보 필터, 예산, 공급자 호출, 비용 기록)는 server/ai/service.js 에서 합니다.
 */
const ai = require('../../ai/service');
const { getSecret } = require('../../core/secrets');
const { PROVIDERS } = require('../../ai/defaults');
const { HttpError } = require('../../core/errors');
const security = require('../../core/security');

function register(r) {
  r.get('/status', (req, res) => {
    const s = ai.getAiSettings();
    const hasKey = s.provider !== 'demo' && !!getSecret(`ai_key_${s.provider}`);
    const b = ai.budgetStatus(s);
    res.json({
      provider: s.provider,
      providerLabel: PROVIDERS[s.provider]?.label,
      demo: s.provider === 'demo' || !hasKey,
      budget: { warn: b.warn, over: b.over, ratio: b.ratio, action: b.action, ...(req.user.level >= 2 ? { usedKrw: b.usedKrw, limitKrw: b.limitKrw } : {}) },
      piiMode: s.piiMode,
    });
  });

  r.post('/run', (req, res, next) => {
    // 한 사람이 1분에 30번 넘게 부르지 못하게 (실수로 반복 클릭, 비용 폭주 방지)
    if (!security.hit(`ai:${req.user.id}`, 30, 60000)) {
      return next(new HttpError(429, 'AI 요청이 너무 잦습니다. 1분 뒤에 다시 시도해 주세요.'));
    }
    const feature = String(req.body.feature || '');
    ai.runFeature(feature, req.body.input, req)
      .then((result) => res.json(result))
      .catch(next);
  });
}

module.exports = { name: 'ai', migrations: [], register };
