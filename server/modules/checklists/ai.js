/*
 * 이 파일이 하는 일: 체크리스트 모듈의 AI 기능입니다.
 *   checklists.suggest — "소아 환자가 많은 치과의 마감 체크"처럼 짧게 설명하면 체크 항목 8~15개를 추천합니다.
 *   결과는 [{ text, hint }] 목록(JSON)이라 화면에서 골라서 바로 템플릿에 넣을 수 있습니다.
 */
const { v } = require('../../core/validate');
const { extractJson } = require('../../ai/service');

// 데모(키 없음) 모드에서 쓰는 현실적인 치과 체크 항목 묶음
const BANK = {
  open: [
    ['컴프레서·석션 전원 켜기', '작동음과 압력 게이지 확인'],
    ['유니트체어 수관 플러싱 2분', '진료 시작 전 모든 핸드피스 라인 물 빼기'],
    ['멸균기 예열 및 전날 BI 결과 확인', '결과는 멸균기 기록에 입력'],
    ['진료실 표면 소독', '체어·라이트 손잡이·트레이 테이블'],
    ['오늘 예약 현황 확인', '첫 예약 시간과 준비할 기구 확인'],
    ['전화 자동응답 해제', ''],
    ['대기실 정리·환기', '잡지·안내문 정리, 창문 10분 열기'],
    ['손 소독제·종이컵·휴지 보충', ''],
    ['X-ray 장비 전원 및 센서 확인', ''],
    ['멸균 기구 세트 수량 확인', '부족하면 바로 멸균 돌리기'],
  ],
  close: [
    ['사용한 기구 세척·멸균기 가동', '마지막 회차 시작 시각 기록'],
    ['석션 라인 세척액 흡입', '체어마다 물 1컵 + 세척액'],
    ['유니트체어 표면 소독 후 커버 교체', ''],
    ['의료폐기물 밀봉·보관 장소로 이동', '보관 용기 뚜껑 닫기'],
    ['컴프레서·석션 전원 끄기', '물 빼기(드레인) 확인'],
    ['냉장 보관 재료 문 닫힘·온도 확인', ''],
    ['내일 예약 확인 및 준비물 메모', '인수인계 보드에 남기기'],
    ['전화 자동응답 설정', ''],
    ['현금·카드 단말기 마감 정산', ''],
    ['창문·출입문 잠금, 조명·에어컨 끄기', '마지막 퇴근자 확인'],
  ],
  weekly: [
    ['유니트체어 수관 소독', '소독제 희석 비율 확인'],
    ['석션 트랩(필터) 청소', '장갑·보안경 착용'],
    ['응급키트·비상약 유효기간 확인', '산소통 압력 포함'],
    ['자동심장충격기(AED) 상태 표시 확인', ''],
    ['소독제·멸균 파우치 재고 확인', '부족하면 재고 메뉴에서 출고·발주'],
    ['멸균기 챔버·개스킷 청소', ''],
    ['냉장고 내부 정리 및 유효기간 지난 재료 분리', ''],
    ['소화기 압력 게이지 확인', '초록색 범위인지'],
    ['대기실 장난감·잡지 소독 및 교체', ''],
    ['공기청정기 필터 상태 확인', ''],
  ],
  kids: [
    ['소아용 체어 쿠션·베개 소독', ''],
    ['대기실 놀이 공간 장난감 소독', '입에 닿는 장난감은 따로 세척'],
    ['소아용 칭찬 스티커·보상품 보충', ''],
    ['소아용 러버댐·소형 기구 세트 확인', ''],
  ],
  surgery: [
    ['수술 기구 세트 멸균 상태 확인', '멸균 날짜·지시계 색 변화 확인'],
    ['수술실 바닥·벽면 소독', ''],
    ['수술용 멸균 드레이프·가운 재고 확인', ''],
  ],
  infection: [
    ['진료실 손잡이·스위치 소독', ''],
    ['개인보호구(마스크·장갑·보안경) 재고 확인', ''],
    ['멸균 파우치 보관함 문 닫힘 확인', ''],
  ],
};

/**
 * 두 항목이 거의 같은 말인지 (글자 두 개씩 묶어 겹치는 비율로 판단)
 * 예) '의료폐기물 밀봉 후 보관 장소로 이동' ≈ '의료폐기물 밀봉·보관 장소로 이동'
 */
function similar(a, b) {
  const norm = (s) => String(s || '').replace(/[^가-힣A-Za-z0-9]/g, '');
  const grams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const gx = grams(x);
  const gy = grams(y);
  let same = 0;
  for (const g of gx) if (gy.has(g)) same++;
  return (2 * same) / (gx.size + gy.size) >= 0.6;
}

/** 설명 글을 보고 어떤 묶음을 쓸지 고릅니다 */
function pickBank(description, timing) {
  const t = String(description || '');
  let base = timing && BANK[timing] ? timing : null;
  if (!base) {
    if (/마감|퇴근|종료|끝/.test(t)) base = 'close';
    else if (/주간|매주|주 ?1|일주일|정기|점검/.test(t)) base = 'weekly';
    else base = 'open';
  }
  let list = BANK[base].slice();
  if (/소아|어린이|아이|키즈|아동/.test(t)) list = [...BANK.kids.slice(0, base === 'weekly' ? 2 : 3), ...list];
  if (/임플란트|수술|외과/.test(t)) list = [...list.slice(0, 7), ...BANK.surgery, ...list.slice(7)];
  if (/감염|소독|위생/.test(t)) list = [...list, ...BANK.infection];
  // 중복 제거 후 8~15개
  const seen = new Set();
  list = list.filter(([text]) => !seen.has(text) && seen.add(text));
  return list.slice(0, 15);
}

/** AI 응답 → [{ text, hint }] 로 정리 (형식이 조금 달라도 최대한 살림) */
function normalizeItems(data) {
  let arr = data;
  if (data && !Array.isArray(data)) arr = data.items || data.checklist || data.list || [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => (typeof x === 'string' ? { text: x } : x || {}))
    .map((x) => ({ text: String(x.text || x.item || x.title || '').trim().slice(0, 120), hint: String(x.hint || x.note || x.desc || '').trim().slice(0, 200) }))
    .filter((x) => x.text)
    .slice(0, 20);
}

/** JSON이 아닌 "- 항목" 목록으로 답한 경우를 위한 예비 해석 */
function parseLines(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l && l.length <= 120 && !/^```|^\[|^\{/.test(l))
    .map((l) => {
      const [a, ...b] = l.split(/\s+[—–-]\s+|\s*\(\s*/);
      return { text: a.trim(), hint: b.join(' ').replace(/\)$/, '').trim() };
    })
    .slice(0, 20);
}

const aiFeatures = [
  {
    key: 'checklists.suggest',
    label: '체크리스트 항목 추천',
    group: '데스크',
    tier: 'fast',
    maxTokens: 1200,
    input: v.object({
      description: v.string({ min: 2, max: 500, label: '설명' }),
      timing: v.enum(['open', 'close', 'weekly', 'custom'], { optional: true, label: '시점' }),
      existing: v.array(v.string({ max: 120 }), { optional: true, max: 60, label: '이미 있는 항목' }),
    }),
    build(input) {
      const timingText = { open: '진료 시작 전(오픈)', close: '진료 종료 후(마감)', weekly: '주 1회 정기 점검', custom: '' }[input.timing] || '';
      return {
        prompt: [
          '치과 직원이 매일/매주 확인할 체크리스트 항목을 추천해 주세요.',
          timingText ? `점검 시점: ${timingText}` : '',
          `설명: ${input.description}`,
          input.existing && input.existing.length ? `이미 있는 항목(겹치지 않게): ${input.existing.join(' / ')}` : '',
          '',
          '규칙:',
          '- 8~15개. 한 항목은 "무엇을 한다"가 분명한 짧은 문장(25자 이내).',
          '- 감염관리·장비·안전·데스크 업무를 실제 치과 순서대로.',
          '- hint에는 확인 기준이나 요령을 짧게(없으면 빈 글자).',
          '- 환자 개인정보나 개별 진료 내용은 넣지 않습니다.',
          '- 아래 형식의 JSON 코드 블록 하나만 답합니다.',
          '```json',
          '[{"text": "항목", "hint": "도움말"}]',
          '```',
        ]
          .filter((l) => l !== '')
          .join('\n'),
      };
    },
    demo(input) {
      // 이미 있는 항목과 거의 같은 것은 빼고 추천
      const existing = input.existing || [];
      const fresh = ([text]) => !existing.some((e) => similar(e, text));
      const list = pickBank(input.description, input.timing).filter(fresh);
      // 겹치는 것을 빼고 8개가 안 되면 감염관리·안전 항목으로 채움
      for (const extra of [...BANK.infection, ...BANK.weekly]) {
        if (list.length >= 8) break;
        if (fresh(extra) && !list.some(([t]) => similar(t, extra[0]))) list.push(extra);
      }
      const items = list.slice(0, 15).map(([text, hint]) => ({ text, hint }));
      return '```json\n' + JSON.stringify(items, null, 2) + '\n```';
    },
    parse(text) {
      let items = [];
      try {
        items = normalizeItems(extractJson(text));
      } catch {
        items = [];
      }
      if (!items.length) items = parseLines(text);
      return { items };
    },
  },
];

module.exports = { aiFeatures, pickBank, normalizeItems, similar };
