/*
 * 이 파일이 하는 일: AI가 쓴 글(마크다운: # 제목, - 목록, **굵게**, 표)을 보기 좋은 화면으로 바꿉니다.
 *
 * 보안: 글을 HTML로 바꿔 innerHTML에 넣지 않고, 한 조각씩 안전한 화면 요소로 만듭니다.
 *       그래서 글 안에 <script> 같은 것이 섞여 있어도 그냥 글자로 보일 뿐 실행되지 않습니다. (XSS 방지)
 *   html`<${Markdown} text=${result.text} />`
 */
import { h } from '../lib.js';

/** 한 줄 안의 **굵게**, `코드` 처리 */
function inline(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(h('strong', null, tok.slice(2, -2)));
    else out.push(h('code', null, tok.slice(1, -1)));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function isTableSep(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}
function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** 마크다운 글 → 화면 요소 목록 */
export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // 제목
    const hm = line.match(/^(#{1,4})\s+(.*)$/);
    if (hm) {
      const level = Math.min(4, hm[1].length + 1); // # → h2 (페이지 제목과 겹치지 않게)
      blocks.push(h(`h${level}`, { key: key++ }, inline(hm[2])));
      i++;
      continue;
    }
    // 구분선
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(h('hr', { key: key++ }));
      i++;
      continue;
    }
    // 표
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        body.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        h(
          'div',
          { key: key++, class: 'table-wrap' },
          h('table', null, h('thead', null, h('tr', null, head.map((c, j) => h('th', { key: j }, inline(c))))), h('tbody', null, body.map((r, ri) => h('tr', { key: ri }, r.map((c, j) => h('td', { key: j }, inline(c)))))))
        )
      );
      continue;
    }
    // 인용
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push(h('blockquote', { key: key++ }, inline(buf.join(' '))));
      continue;
    }
    // 목록 (-, *, •, 1.)
    const listRe = /^\s*([-*•]|\d+[.)])\s+(.*)$/;
    if (listRe.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      // 번호 목록이 중간에 끊겼다 이어지면(예: 3. 부터) 그 번호부터 시작
      const startNo = ordered ? Number(line.match(/^\s*(\d+)/)[1]) : 1;
      const items = [];
      while (i < lines.length && listRe.test(lines[i])) {
        const txt = lines[i].match(listRe)[2];
        const cb = txt.match(/^\[( |x|X)\]\s*(.*)$/);
        items.push(cb ? h('li', { key: items.length }, (cb[1] === ' ' ? '☐ ' : '☑ '), inline(cb[2])) : h('li', { key: items.length }, inline(txt)));
        i++;
        // 목록 항목 아래 들여쓴 이어지는 줄
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !listRe.test(lines[i])) {
          items[items.length - 1] = h('li', { key: items.length - 1 }, items[items.length - 1].props.children, ' ', inline(lines[i].trim()));
          i++;
        }
      }
      blocks.push(h(ordered ? 'ol' : 'ul', { key: key++, start: ordered && startNo !== 1 ? startNo : undefined }, items));
      continue;
    }
    // 문단 (빈 줄이 나올 때까지)
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s/.test(lines[i]) && !listRe.test(lines[i]) && !/^\s*>/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    const parts = [];
    buf.forEach((b, j) => {
      if (j) parts.push(h('br', { key: `br${j}` }));
      parts.push(...inline(b));
    });
    blocks.push(h('p', { key: key++ }, parts));
  }
  return blocks;
}

export function Markdown({ text, class: cls }) {
  return h('div', { class: `prose ${cls || ''}` }, renderMarkdown(text));
}

/** 마크다운 기호를 빼고 순수 글자만 (문자 메시지 복사용) */
export function stripMarkdown(src) {
  return String(src || '')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}
