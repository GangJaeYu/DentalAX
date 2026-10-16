/*
 * 이 파일이 하는 일: 엑셀에서 열 수 있는 CSV 파일을 만들고(내보내기), 읽습니다(가져오기).
 *
 *  - 내보낼 때 맨 앞에 BOM(보이지 않는 표시)을 붙여야 한국어가 엑셀에서 깨지지 않습니다.
 *  - 가져올 때는 따옴표("), 쉼표가 들어간 칸, 줄바꿈이 들어간 칸을 모두 처리합니다.
 *  - 엑셀에서 "=SUM(...)" 같은 수식으로 시작하는 칸은 위험할 수 있어(CSV 인젝션) 앞에 ' 를 붙여 글자로 만듭니다.
 */

const BOM = '﻿';

function escapeCell(val) {
  if (val === null || val === undefined) return '';
  let s = String(val);
  // 수식으로 해석될 수 있는 칸 무력화
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * @param {{key:string,label:string}[]} columns 열 정의
 * @param {object[]} rows
 */
function toCsv(columns, rows) {
  const lines = [columns.map((c) => escapeCell(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => escapeCell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

/** CSV 글 → 2차원 배열 */
function parseCsv(text) {
  let s = String(text || '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // 완전히 빈 줄 제거
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * CSV 글 → 객체 목록. 첫 줄(머리글)의 이름을 aliases 로 칸 이름에 연결합니다.
 * @param {string} text
 * @param {Record<string,string[]>} aliases 예) { name: ['품목명','이름','name'], qty: ['수량'] }
 */
function parseCsvObjects(text, aliases) {
  const rows = parseCsv(text);
  if (!rows.length) return { rows: [], headers: [], missing: Object.keys(aliases) };
  const headers = rows[0].map((h) => h.trim().replace(/^'/, ''));
  const map = {};
  for (const [key, names] of Object.entries(aliases)) {
    const idx = headers.findIndex((h) => names.some((n) => n.toLowerCase() === h.toLowerCase()));
    if (idx >= 0) map[key] = idx;
  }
  const out = rows.slice(1).map((r) => {
    const o = {};
    for (const [key, idx] of Object.entries(map)) o[key] = (r[idx] ?? '').trim().replace(/^'(?=[=+\-@])/, '');
    return o;
  });
  return { rows: out, headers, mapped: Object.keys(map), missing: Object.keys(aliases).filter((k) => !(k in map)) };
}

function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(csv);
}

module.exports = { toCsv, parseCsv, parseCsvObjects, sendCsv, escapeCell };
