/*
 * 이 파일이 하는 일: [F. 지출] 카드 내역·CSV를 읽어 지출 목록으로 바꾸고, 가맹점 이름을 보고 분류를 추천하는 규칙입니다.
 *
 *   - 날짜·금액은 카드사마다 모양이 달라서 여러 형식을 받아 줍니다.
 *       날짜: 2026-10-01, 2026.10.01, 2026/10/01, 20261001, 26.10.01, 10/01(올해로 봄), "2026-10-01 14:22"(시각은 버림)
 *       금액: 12,000 / ₩12,000 / 12000원 / -5,000 / (5,000) ← 괄호·마이너스는 취소·환불(음수)
 *   - 엑셀에서 복사해 붙여넣은 글(칸이 탭으로 나뉨)도 받아 줍니다.
 *   - 분류 추천: 분류마다 적어 둔 "키워드"가 가맹점·적요에 들어 있으면 그 분류로 추천합니다. (가장 긴 키워드가 이김)
 */
const { parseCsv, parseCsvObjects, escapeCell } = require('../../core/csv');
const time = require('../../core/time');

const PAYMENT_METHODS = ['카드', '계좌이체', '현금', '자동이체', '기타'];

// CSV 머리글(첫 줄)에 올 수 있는 이름들
const ALIASES = {
  date: ['날짜', '일자', '거래일', '거래일자', '거래일시', '이용일', '이용일자', '이용일시', '승인일', '승인일자', '승인일시', '사용일', '사용일자', '결제일', '지출일', 'date'],
  payee: ['가맹점', '가맹점명', '이용가맹점', '이용하신 가맹점', '이용처', '사용처', '상호', '거래처', '지급처', '받는 분', '받는분', '적요', '내용', 'payee', 'merchant'],
  description: ['내역', '설명', '적요', '비고', '메모', 'description', 'memo'],
  amount: ['금액', '이용금액', '승인금액', '결제금액', '사용금액', '출금액', '출금', '지출', '지출금액', '합계', 'amount'],
  category: ['분류', '카테고리', '지출 분류', 'category'],
  paymentMethod: ['결제수단', '결제 수단', '결제방법', '결제 방법', '지불방법', 'payment'],
};

/** 여러 형식의 날짜 글자 → 'YYYY-MM-DD' (못 읽으면 null) */
function parseDateLoose(raw, today = time.today()) {
  const s = String(raw || '').trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?.*$/, '').replace(/[년월]\s*/g, '-').replace(/일$/, '').trim();
  let y;
  let m;
  let d;
  let mt;
  if ((mt = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?$/))) [, y, m, d] = mt;
  else if ((mt = s.match(/^(\d{4})(\d{2})(\d{2})$/))) [, y, m, d] = mt;
  else if ((mt = s.match(/^(\d{2})[-./](\d{1,2})[-./](\d{1,2})\.?$/))) {
    [, y, m, d] = mt;
    y = `20${y}`;
  } else if ((mt = s.match(/^(\d{1,2})[-./](\d{1,2})\.?$/))) {
    // 연도가 없으면 올해로 보되, 그 날짜가 오늘보다 미래면 작년으로 봄 (연말에 지난 1월 내역을 넣는 경우 등)
    [, m, d] = mt;
    y = today.slice(0, 4);
    const guess = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (guess > today) y = String(Number(y) - 1);
  } else return null;
  const out = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return time.isValidDate(out) ? out : null;
}

/** 금액 글자 → 원 단위 정수 (못 읽으면 null). 괄호나 마이너스는 음수(취소·환불) */
function parseAmountLoose(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[₩원,\s]/g, '').replace(/^KRW/i, '');
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Number(s));
  return neg ? -n : n;
}

/** 엑셀에서 복사한 글(탭으로 나뉨)이면 CSV로 바꿔 줌 */
function normalizeText(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const first = s.split(/\r?\n/).find((l) => l.trim()) || '';
  const tabs = (first.match(/\t/g) || []).length;
  const commas = (first.match(/,/g) || []).length;
  if (tabs > 0 && tabs >= commas) {
    return {
      format: 'tsv',
      csv: s
        .split(/\r?\n/)
        .map((line) => line.split('\t').map((c) => escapeCell(c.trim())).join(','))
        .join('\n'),
    };
  }
  return { format: 'csv', csv: s };
}

/**
 * 글 → 지출 후보 목록. 머리글이 있으면 이름으로 칸을 찾고,
 * 머리글이 없으면(첫 줄부터 날짜) "날짜, 가맹점, 금액" 순서로 봅니다.
 */
function parseExpenseText(text, today = time.today()) {
  const { format, csv } = normalizeText(text);
  const raw = parseCsv(csv);
  if (!raw.length) return { format, rows: [], headers: [], missing: ['date', 'payee', 'amount'], headerless: false };
  let objects;
  let headers;
  let missing;
  let headerless = false;
  const parsed = parseCsvObjects(csv, ALIASES);
  if (parsed.missing.includes('date') || parsed.missing.includes('amount')) {
    // 머리글이 없거나 알아볼 수 없음 → 첫 칸이 날짜처럼 보이면 순서대로 읽기
    if (parseDateLoose(raw[0][0], today)) {
      headerless = true;
      headers = [];
      objects = raw.map((r) => {
        // 금액은 숫자로 읽히는 칸 중 마지막 칸, 가맹점은 날짜·금액이 아닌 첫 칸
        let amountIdx = -1;
        for (let i = r.length - 1; i >= 1; i--) if (parseAmountLoose(r[i]) !== null) { amountIdx = i; break; }
        const payeeIdx = r.findIndex((c, i) => i > 0 && i !== amountIdx && c.trim() !== '');
        return { date: r[0], payee: payeeIdx >= 0 ? r[payeeIdx] : '', amount: amountIdx >= 0 ? r[amountIdx] : '' };
      });
      missing = [];
    } else {
      return { format, rows: [], headers: parsed.headers, missing: parsed.missing, headerless: false };
    }
  } else {
    objects = parsed.rows;
    headers = parsed.headers;
    missing = parsed.missing;
  }
  const rows = objects.map((o, i) => {
    const date = parseDateLoose(o.date, today);
    const amount = parseAmountLoose(o.amount);
    let payee = (o.payee || '').trim().slice(0, 100);
    let description = (o.description || '').trim().slice(0, 200);
    if (!payee && description) {
      payee = description.slice(0, 100);
      description = '';
    }
    if (description === payee) description = '';
    const errors = [];
    if (!date) errors.push('날짜를 읽을 수 없음');
    if (amount === null) errors.push('금액을 읽을 수 없음');
    else if (amount === 0) errors.push('금액이 0원');
    if (!payee) errors.push('가맹점(적요)이 비어 있음');
    const method = PAYMENT_METHODS.find((m) => m === (o.paymentMethod || '').trim()) || '카드';
    return {
      line: i + (headerless ? 1 : 2), // 원본 파일의 몇 번째 줄인지 (머리글 포함)
      date,
      rawDate: o.date || '',
      payee,
      description,
      amount,
      rawAmount: o.amount || '',
      paymentMethod: method,
      categoryName: (o.category || '').trim() || null,
      error: errors.join(', ') || null,
    };
  });
  return { format, rows, headers, missing, headerless };
}

/** 분류의 키워드 글자 "덴탈, 메디칼" → ['덴탈','메디칼'] */
function splitKeywords(s) {
  return String(s || '')
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter((k) => k.length >= 1);
}

/**
 * 키워드 규칙으로 분류 추천. categories: [{ id, name, keywords }]
 * 가맹점·적요에 키워드가 들어 있으면 그 분류. 여러 개 맞으면 가장 긴 키워드(더 구체적인 것)가 이김.
 */
function suggestCategory(text, categories) {
  const hay = String(text || '').toLowerCase();
  if (!hay.trim()) return null;
  let best = null;
  for (const c of categories) {
    for (const k of splitKeywords(c.keywords)) {
      if (hay.includes(k.toLowerCase()) && (!best || k.length > best.len)) best = { id: c.id, name: c.name, len: k.length, keyword: k };
    }
  }
  return best ? { id: best.id, name: best.name, keyword: best.keyword } : null;
}

module.exports = { PAYMENT_METHODS, ALIASES, parseDateLoose, parseAmountLoose, parseExpenseText, suggestCategory, splitKeywords };
