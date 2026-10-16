/*
 * 이 파일이 하는 일: 첫 화면(대시보드)에 보여 줄 요약을 모읍니다.
 *
 * 각 모듈의 dashboard(user) 함수가 돌려준 조각을 하나로 합칩니다.
 *   todos    : 오늘 할 일 (체크리스트 진행률, 승인 대기 연차, 기한 지난 일정 …)
 *   alerts   : 재고 부족·유효기간 같은 경고
 *   upcoming : 다가오는 점검·법정 일정
 *   notices  : 공지
 *   today    : 오늘 근무자/휴무자 등 그날 정보
 *   stats    : 숫자 카드
 * 한 모듈에서 오류가 나도 나머지 대시보드는 보이도록 모듈별로 따로 감쌉니다.
 */
const ai = require('../../ai/service');
const time = require('../../core/time');

function register(r) {
  r.get('/', (req, res) => {
    const modules = require('../index');
    const out = { date: time.today(), todos: [], alerts: [], upcoming: [], notices: [], today: {}, stats: [], errors: [] };
    for (const m of modules) {
      if (!m.dashboard) continue;
      try {
        const part = m.dashboard(req.user) || {};
        for (const k of ['todos', 'alerts', 'upcoming', 'notices', 'stats']) if (part[k]) out[k].push(...part[k]);
        if (part.today) Object.assign(out.today, part.today);
      } catch (e) {
        console.error(`[대시보드] ${m.name} 요약 실패:`, e);
        out.errors.push(m.name);
      }
    }
    out.upcoming.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    out.alerts.sort((a, b) => (a.level === 'danger' ? 0 : 1) - (b.level === 'danger' ? 0 : 1));
    if (req.user.level >= 2) {
      const b = ai.budgetStatus();
      out.ai = { usedKrw: b.usedKrw, limitKrw: b.limitKrw, ratio: b.ratio, warn: b.warn, over: b.over };
    }
    res.json(out);
  });
}

module.exports = { name: 'dashboard', migrations: [], register };
