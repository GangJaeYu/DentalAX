/*
 * 이 파일이 하는 일: [F. 지출] AI 기능 — 카드 내역의 가맹점·적요 목록을 보고 지출 분류를 추천합니다. (expenses.categorize)
 *
 *   - 보내는 것은 가맹점 이름·적요 글자뿐입니다. (금액·날짜·카드번호는 보내지 않음)
 *   - 키가 없을 때(데모 모드)는 분류별 키워드 규칙으로 같은 모양의 결과를 돌려줍니다.
 *   - 지출은 실장 이상만 다루므로, 이 AI 기능도 실장 이상만 쓸 수 있습니다.
 */
const { all } = require('../../core/db');
const { v } = require('../../core/validate');
const { forbidden } = require('../../core/errors');
const { hasRole } = require('../../core/auth');
const { extractJson } = require('../../ai/service');
const { suggestCategory } = require('./rules');

function activeCategories() {
  return all('SELECT id, name, keywords FROM expense_categories WHERE active = 1 ORDER BY sort, id');
}

const aiFeatures = [
  {
    key: 'expenses.categorize',
    label: '카드 내역 → 지출 분류 추천',
    group: '운영 지표',
    tier: 'fast',
    maxTokens: 1500,
    input: v.object({
      items: v.array(v.string({ min: 1, max: 200, label: '내역' }), { min: 1, max: 100, label: '내역 목록' }),
    }),
    build(input, ctx) {
      if (!ctx.user || !hasRole(ctx.user, 'manager')) throw forbidden();
      const cats = activeCategories().map((c) => c.name);
      return {
        prompt: [
          '아래는 치과의원의 카드·계좌 지출 내역(가맹점 이름 또는 적요)입니다. 각 줄을 지출 분류 하나로 나눠 주세요.',
          `사용할 수 있는 분류(이 중에서만 고르기): ${cats.join(', ')}`,
          '참고: 치과 재료상·덴탈·메디칼 업체는 재료비, 기공소는 기공료, 식당·카페는 복리후생, 광고·검색광고는 마케팅·광고, 전기·수도·통신·관리비는 관리비·공과금입니다.',
          '확실하지 않으면 "기타"로 두세요. 설명은 쓰지 말고 JSON만 답하세요.',
          '형식: ```json',
          '[{"index": 0, "category": "재료비"}, {"index": 1, "category": "복리후생"}]',
          '```',
          '',
          '[내역] (번호: 내용)',
          ...input.items.map((t, i) => `${i}: ${t}`),
        ].join('\n'),
      };
    },
    demo(input) {
      const cats = activeCategories();
      const fallback = cats.find((c) => c.name === '기타') || cats[cats.length - 1];
      const out = input.items.map((t, index) => {
        const s = suggestCategory(t, cats);
        return { index, category: s ? s.name : fallback ? fallback.name : '기타' };
      });
      return ['```json', JSON.stringify(out, null, 0), '```', '', '(데모 모드 예시입니다. 분류별 키워드 규칙으로 추천했습니다. AI 키를 넣으면 실제 AI가 내용을 읽고 추천합니다.)'].join('\n');
    },
    parse(text) {
      let data;
      try {
        data = extractJson(text);
      } catch {
        return [];
      }
      if (!Array.isArray(data)) return [];
      return data
        .filter((x) => x && Number.isInteger(Number(x.index)) && typeof x.category === 'string')
        .map((x) => ({ index: Number(x.index), category: x.category.trim() }));
    },
  },
];

module.exports = { aiFeatures };
