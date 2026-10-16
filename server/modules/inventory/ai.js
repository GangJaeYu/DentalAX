/*
 * 이 파일이 하는 일: 재고·구매 모듈의 AI 기능 2가지입니다.
 *
 *   inventory.parseInvoice  : 거래명세서(납품서) 글을 붙여 넣으면 품목·규격·수량·단가를 뽑아 JSON으로 돌려줌
 *                             → 화면에서 기존 품목과 짝을 맞춘 뒤 한 번에 입고
 *   inventory.vendorMessage : 발주서 내용을 보고 거래처에 보낼 주문 메시지(카톡/문자/이메일)를 써 줌 (실장 이상)
 *
 * API 키가 없을 때(데모 모드)도 끝까지 써 볼 수 있도록, demo()가 입력을 실제로 읽어 그럴듯한 결과를 만듭니다.
 *   - 거래명세서: 줄마다 끝쪽의 숫자(수량·단가·금액)를 찾아 규칙으로 해석
 *   - 발주 메시지: 발주서 품목으로 정해진 틀의 문장을 만듦
 */
const { get } = require('../../core/db');
const { v } = require('../../core/validate');
const { forbidden, notFound } = require('../../core/errors');
const { hasRole } = require('../../core/auth');
const { extractJson } = require('../../ai/service');
const time = require('../../core/time');
const views = require('./views');
const { fmtQty } = require('./stock');

// ---------------- 거래명세서 해석 (데모용 규칙) ----------------
// 수량 뒤에 붙는 단위 ("100매"·"2g"처럼 규격에 쓰이는 단위는 넣지 않음)
const UNIT_WORDS = '개|ea|박스|box|bx|통|팩|pk|봉|권|롤|병|세트|set|줄|케이스|cs|앰플|타|족|켤레';
const UNIT_RE = new RegExp(`^(${UNIT_WORDS})\\.?$`, 'i');
const NUM_RE = /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?원?$/;
const NUM_UNIT_RE = new RegExp(`^(\\d+(?:\\.\\d+)?)(${UNIT_WORDS})$`, 'i');
// 품목이 아닌 줄(합계·사업자 정보·머리글 등)
const SKIP_RE = /(합\s*계|총\s*액|총\s*계|소\s*계|부가세|부가가치세|세\s*액|공급\s*가\s*액|입금|계좌|사업자|등록\s*번호|대\s*표|전\s*화|tel|fax|팩스|주\s*소|일\s*자|날\s*짜|거래\s*명세|명세서|귀\s*하|품\s*명|페이지|인수자|공급받는|공급자|담당자|청구|미수|잔액|전잔|인\s*수)/i;
// 이름 끝쪽에 붙은 규격처럼 보이는 글자 (100매, 2g, 90x230mm, 1.8mL, #15-40 …)
const SPEC_TOKEN_RE = /^(\d+(\.\d+)?\s*(매|개입|ml|g|kg|mm|cm|m|l|ea|입|정|매입|ml\/ea)|\d+x\d+(mm|cm)?|#\d+(-\d+)?|\d+%)$/i;

const toNum = (s) => Number(String(s).replace(/[,원]/g, ''));

const isNumTok = (t) => NUM_RE.test(t) || UNIT_RE.test(t) || NUM_UNIT_RE.test(t);
const isNumCol = (c) => c.split(/\s+/).every(isNumTok);

/**
 * 끝쪽 숫자 덩어리에서 수량·단가를 고릅니다.
 *  ① 숫자 3개가 "수량 × 단가 = 금액"으로 맞으면 그대로
 *  ② "10박스"·"10 박스"처럼 단위가 붙은 숫자는 수량, 그다음 숫자는 단가
 *  ③ 숫자 2개면 작은 쪽이 수량(1000 이하), 큰 쪽이 단가
 * @returns {{qty:number|null, unitPrice:number|null, extra:string[]}} extra: 수량 앞에 남은 글자(규격으로 보냄)
 */
function pickQtyPrice(tail) {
  const nums = [];
  tail.forEach((t, idx) => {
    if (NUM_RE.test(t)) nums.push({ n: toNum(t), idx });
  });
  const before = (idx) => tail.slice(0, idx).filter((t) => !NUM_RE.test(t) && !UNIT_RE.test(t));
  if (nums.length >= 3) {
    const [a, b, c] = nums.slice(-3);
    if (Math.abs(a.n * b.n - c.n) <= Math.max(1, c.n * 0.02)) return { qty: a.n, unitPrice: b.n, extra: before(a.idx) };
  }
  const qu = tail.findIndex((t) => NUM_UNIT_RE.test(t));
  if (qu >= 0) {
    const after = nums.filter((x) => x.idx > qu);
    return { qty: Number(tail[qu].match(NUM_UNIT_RE)[1]), unitPrice: after.length ? after[0].n : null, extra: before(qu) };
  }
  const unitAfter = nums.find((x) => tail[x.idx + 1] && UNIT_RE.test(tail[x.idx + 1]));
  if (unitAfter) {
    const after = nums.filter((x) => x.idx > unitAfter.idx);
    return { qty: unitAfter.n, unitPrice: after.length ? after[0].n : null, extra: [] };
  }
  if (nums.length >= 2) {
    const [a, b] = nums.map((x) => x.n);
    if (a <= 1000 && b >= a) return { qty: a, unitPrice: b, extra: [] };
    if (b <= 1000) return { qty: b, unitPrice: a, extra: [] };
    return { qty: 1, unitPrice: a, extra: [] };
  }
  if (nums.length === 1) return nums[0].n <= 1000 ? { qty: nums[0].n, unitPrice: null, extra: [] } : { qty: 1, unitPrice: nums[0].n, extra: [] };
  return { qty: null, unitPrice: null, extra: [] };
}

/** 거래명세서 한 줄 → { name, spec, qty, unitPrice } 또는 null(품목 줄이 아님) */
function parseInvoiceLine(raw) {
  const src = String(raw || '').trim();
  if (!src || !/\d/.test(src) || SKIP_RE.test(src)) return null;
  let nameText;
  let specText = null;
  let tail;
  // ① 탭·'|'·두 칸 이상 띄어쓰기로 칸이 나뉜 표 모양이면 칸 단위로 읽기 (품명 칸, 규격 칸, 숫자 칸)
  let cols = src.split(/\t|\||\s{2,}/).map((x) => x.trim()).filter(Boolean);
  if (cols.length >= 3) {
    if (/^\d{1,3}[.)]?$/.test(cols[0])) cols = cols.slice(1); // 순번 칸
    const ni = cols.findIndex((c) => !isNumCol(c));
    if (ni < 0) return null;
    nameText = cols[ni].replace(/^(\d{1,3}[.)]|[-*•·])\s+/, '');
    let rest = cols.slice(ni + 1);
    const lead = [];
    if (rest.length && !isNumCol(rest[0])) {
      // 규격 칸 끝에 숫자가 한 칸 띄어 붙어 있으면(예: "50앰플 2") 숫자 쪽으로 넘김
      const st = rest[0].split(/\s+/);
      while (st.length > 1 && isNumTok(st[st.length - 1])) lead.unshift(st.pop());
      specText = st.join(' ');
      rest = rest.slice(1);
    }
    tail = [...lead, ...rest.filter(isNumCol).join(' ').split(/\s+/).filter(Boolean)];
  } else {
    // ② 한 칸씩 띄어 쓴 줄: 뒤에서부터 숫자·단위 덩어리를 모음
    const line = src.replace(/\s+/g, ' ').replace(/^(\d{1,3}[.)]|[-*•·])\s+/, '');
    let tokens = line.split(' ');
    if (tokens.length > 1 && /^\d{1,3}$/.test(tokens[0]) && !NUM_RE.test(tokens[1] || '')) tokens = tokens.slice(1); // "1 니트릴…" 순번
    let i = tokens.length - 1;
    tail = [];
    while (i >= 0 && isNumTok(tokens[i])) tail.unshift(tokens[i--]);
    nameText = tokens.slice(0, i + 1).join(' ');
  }
  if (!nameText || !tail.some((t) => /\d/.test(t))) return null;
  const { qty, unitPrice, extra } = pickQtyPrice(tail);
  if (!(qty > 0)) return null;

  // 이름과 규격 나누기: 괄호 안 → 규격, 이름 끝의 "100매" 같은 글자 → 규격
  const specs = specText ? [specText] : [];
  let name = nameText.replace(/[(\[]([^)\]]+)[)\]]/g, (_, x) => {
    specs.push(x.trim());
    return ' ';
  });
  const nt = name.split(' ').filter(Boolean);
  const trailingSpec = [];
  while (nt.length > 1 && SPEC_TOKEN_RE.test(nt[nt.length - 1])) trailingSpec.unshift(nt.pop());
  specs.push(...trailingSpec, ...extra);
  name = nt.join(' ').replace(/[,/]+$/, '').trim();
  if (!name) return null;
  return { name: name.slice(0, 100), spec: specs.join(' ').slice(0, 100) || null, qty, unitPrice: unitPrice === null ? null : Math.round(unitPrice) };
}

function parseInvoiceText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(parseInvoiceLine)
    .filter(Boolean)
    .slice(0, 100);
}

/** AI(또는 데모)가 돌려준 JSON을 화면이 쓰기 좋은 모양으로 다듬기 */
function normalizeLines(data) {
  const arr = Array.isArray(data) ? data : data && (data.lines || data.items);
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => {
      const qty = Number(String(x.qty ?? x.quantity ?? '').replace(/,/g, ''));
      const price = x.unitPrice ?? x.unit_price ?? x.price;
      const p = price === null || price === undefined || price === '' ? null : Math.round(Number(String(price).replace(/[,원]/g, '')));
      return {
        name: String(x.name || x.item || '').trim().slice(0, 100),
        spec: x.spec ? String(x.spec).trim().slice(0, 100) : null,
        qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
        unitPrice: Number.isFinite(p) && p >= 0 ? p : null,
      };
    })
    .filter((x) => x.name);
}

// ---------------- 발주 메시지 ----------------
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
function fmtKDate(s) {
  if (!s) return '';
  const d = time.parseDate(s);
  return `${d.getMonth() + 1}월 ${d.getDate()}일(${WEEK[d.getDay()]})`;
}

/** 발주서와 품목·거래처 정보를 불러옴 (실장 이상만) */
function loadPo(poId, user) {
  if (!hasRole(user, 'manager')) throw forbidden();
  const po = views.getPoView(poId);
  if (!po) throw notFound('발주서');
  const lines = views.poLines(poId);
  const vendor = po.vendorId ? get('SELECT * FROM vendors WHERE id = ?', po.vendorId) : null;
  return { po, lines, vendor };
}

const STYLE_LABEL = { kakao: '카카오톡', sms: '문자', email: '이메일' };

function itemLine(l, i) {
  return `${i + 1}. ${l.itemName}${l.spec ? ` (${l.spec})` : ''} — ${fmtQty(l.qty)}${l.unit}`;
}

/** 데모용 발주 메시지 (정해진 틀) */
function demoMessage({ po, lines, vendor }, clinic, style, extra) {
  const clinicName = clinic?.name || '저희 치과';
  const to = vendor ? `${vendor.name}${vendor.contact_name ? ` ${vendor.contact_name}님` : ''}` : '담당자님';
  const due = po.expectedDate ? fmtKDate(po.expectedDate) : null;
  const items = lines.map(itemLine);
  const extraLine = extra ? [extra.trim()] : [];
  if (style === 'sms') {
    return [
      `[${clinicName}] ${to}, 주문 부탁드립니다.`,
      ...lines.map((l) => `- ${l.itemName}${l.spec ? ` ${l.spec}` : ''} ${fmtQty(l.qty)}${l.unit}`),
      due ? `${due}까지 받을 수 있을까요?` : '가능한 납품일 알려 주세요.',
      ...extraLine,
      '감사합니다.',
    ].join('\n');
  }
  if (style === 'email') {
    return [
      `제목: [${clinicName}] 발주 요청드립니다 (${po.poNo})`,
      '',
      `${to} 안녕하세요.`,
      `${clinicName}입니다. 아래 품목 주문을 요청드립니다.`,
      '',
      `발주번호: ${po.poNo}`,
      ...items,
      '',
      due ? `납품 희망일: ${due}` : '납품 가능일을 회신 부탁드립니다.',
      ...extraLine,
      '재고나 단가 변동이 있으면 미리 알려 주시면 감사하겠습니다.',
      '',
      '감사합니다.',
      `${clinicName} 드림${clinic?.phone ? ` (${clinic.phone})` : ''}`,
    ].join('\n');
  }
  return [
    `안녕하세요, ${to}! ${clinicName}입니다 😊`,
    '아래 품목 주문 부탁드립니다.',
    '',
    ...items,
    '',
    due ? `${due}까지 받을 수 있으면 좋겠습니다.` : '가능한 납품일 알려 주세요.',
    ...extraLine,
    '확인 부탁드립니다. 감사합니다!',
  ].join('\n');
}

const aiFeatures = [
  {
    key: 'inventory.parseInvoice',
    label: '거래명세서 → 입고 품목 인식',
    group: '재고·구매',
    tier: 'fast',
    maxTokens: 1500,
    input: v.object({ text: v.string({ min: 2, max: 6000, label: '거래명세서 내용' }) }),
    build(input) {
      return {
        prompt: [
          '아래는 치과 거래처의 거래명세서(납품서)를 복사해 붙인 글입니다. 품목 줄만 골라 JSON 배열로 바꿔 주세요.',
          '형식(코드블록 하나만, 다른 설명 없이):',
          '```json',
          '[{"name": "품목 이름", "spec": "규격(없으면 null)", "qty": 수량숫자, "unitPrice": 단가숫자(원) 또는 null}]',
          '```',
          '규칙:',
          '- 합계·부가세·공급가액·사업자번호·주소·전화 같은 줄은 빼세요.',
          '- 숫자에서 쉼표와 "원"을 빼고 숫자만 쓰세요.',
          '- 단가가 없고 금액만 있으면 금액 ÷ 수량으로 단가를 계산하세요.',
          '- 글에 없는 품목이나 숫자는 지어내지 말고, 알아볼 수 없는 줄은 빼세요.',
          '',
          '[거래명세서]',
          input.text,
        ].join('\n'),
      };
    },
    demo(input) {
      const lines = parseInvoiceText(input.text);
      return [
        lines.length ? `거래명세서에서 품목 ${lines.length}개를 찾았습니다.` : '품목 줄을 찾지 못했습니다. 품목·수량·단가가 한 줄에 함께 있는지 확인해 주세요.',
        '',
        '```json',
        JSON.stringify(lines, null, 2),
        '```',
        '',
        '(데모 모드 예시입니다. AI 키를 넣으면 실제 AI가 더 다양한 양식을 읽습니다.)',
      ].join('\n');
    },
    parse(text) {
      return { lines: normalizeLines(extractJson(text)) };
    },
  },
  {
    key: 'inventory.vendorMessage',
    label: '거래처 발주 메시지 작성',
    group: '재고·구매',
    tier: 'fast',
    maxTokens: 900,
    input: v.object({
      poId: v.id({ label: '발주서' }),
      style: v.enum(['kakao', 'sms', 'email'], { optional: true, default: 'kakao', label: '메시지 종류' }),
      extra: v.string({ max: 500, optional: true, label: '추가로 전할 말' }),
    }),
    build(input, ctx) {
      const { po, lines, vendor } = loadPo(input.poId, ctx.user);
      const style = STYLE_LABEL[input.style];
      return {
        prompt: [
          `치과에서 거래처에 보낼 주문 ${style} 메시지를 써 주세요.`,
          `- 보내는 곳: ${ctx.clinic?.name || '치과'}`,
          `- 받는 곳: ${vendor ? vendor.name : '(거래처 미정)'}${vendor?.contact_name ? ` / 담당 ${vendor.contact_name}` : ''}`,
          `- 발주번호: ${po.poNo}`,
          po.expectedDate ? `- 납품 희망일: ${fmtKDate(po.expectedDate)}` : '- 납품 희망일: 정하지 않음 (가능한 날짜를 물어보기)',
          '- 품목:',
          ...lines.map(itemLine),
          input.extra ? `- 추가로 전할 말: ${input.extra}` : '',
          '',
          input.style === 'email'
            ? '형식: 첫 줄 "제목: …", 빈 줄 다음 본문. 정중한 업무 이메일.'
            : input.style === 'sms'
              ? '형식: 문자 메시지. 짧고 간결하게(10줄 이내), 이모지 없이.'
              : '형식: 카카오톡 메시지. 친근하지만 예의 바르게, 품목은 번호 목록으로.',
          '품목 이름·수량·단위는 위와 똑같이 쓰고, 금액은 넣지 마세요. 메시지 본문만 쓰세요.',
        ]
          .filter((x) => x !== '')
          .join('\n'),
      };
    },
    demo(input, ctx) {
      const data = loadPo(input.poId, ctx.user);
      return demoMessage(data, ctx.clinic, input.style, input.extra);
    },
  },
];

module.exports = { aiFeatures, parseInvoiceLine, parseInvoiceText, normalizeLines };
