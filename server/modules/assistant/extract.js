/*
 * 이 파일이 하는 일: 올린 파일에서 글자만 뽑아냅니다. (원내 AI 도우미에 문서를 등록할 때 사용)
 *
 *   .txt .md .csv  → 그대로 (UTF-8, 아니면 한국어 EUC-KR로 다시 읽기)
 *   .docx (워드)    → 파일 안의 word/document.xml 에서 글자만 꺼냄 (추가 프로그램 없이 Node 기본 기능으로 압축 해제)
 *   .pdf .hwp 등    → 지원하지 않음 → "글자를 복사해 붙여넣기" 안내
 *
 * docx는 사실 zip 압축 파일입니다. zip의 "목차(중앙 디렉터리)"를 읽어 원하는 파일을 찾고 압축을 풉니다.
 */
const zlib = require('node:zlib');
const { badRequest } = require('../../core/errors');

/** zip 파일 안에서 특정 이름의 파일 내용을 꺼냄 */
function readZipEntry(buf, wanted) {
  // 맨 뒤쪽에서 "중앙 디렉터리 끝" 표시(0x06054b50)를 찾음
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw badRequest('워드(docx) 파일 형식이 올바르지 않습니다.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === wanted) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 50 * 1024 * 1024 });
      throw badRequest('지원하지 않는 압축 방식의 워드 파일입니다.');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** docx → 글자 (문단마다 줄바꿈, 제목 스타일은 # 로 표시) */
function docxToText(buf) {
  const xml = readZipEntry(buf, 'word/document.xml');
  if (!xml) throw badRequest('워드 파일에서 본문을 찾지 못했습니다.');
  const s = xml.toString('utf8');
  const paras = s.split(/<\/w:p>/);
  const lines = [];
  for (const p of paras) {
    const texts = [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((m) => (m[1] !== undefined ? decodeXmlEntities(m[1]) : m[0] === '<w:tab/>' ? '\t' : '\n'));
    const line = texts.join('').trim();
    if (!line) {
      lines.push('');
      continue;
    }
    const heading = p.match(/<w:pStyle w:val="(?:Heading|제목)\s?(\d)"/i);
    lines.push(heading ? `${'#'.repeat(Math.min(3, Number(heading[1]) || 1))} ${line}` : line);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}

/**
 * 파일 이름과 내용으로 글자 추출
 * @param {string} filename
 * @param {Buffer} buf
 */
function extractText(filename, buf) {
  const ext = String(filename).toLowerCase().split('.').pop();
  if (['txt', 'md', 'markdown', 'csv', 'text'].includes(ext)) return decodeText(buf);
  if (ext === 'docx') return docxToText(buf);
  if (ext === 'pdf') throw badRequest('PDF는 아직 직접 읽지 못합니다. PDF를 열어 내용을 복사한 뒤 [붙여넣기]로 등록해 주세요.');
  if (ext === 'hwp' || ext === 'hwpx') throw badRequest('한글(HWP) 파일은 직접 읽지 못합니다. 한글에서 "다른 이름으로 저장 → 워드(docx)"로 저장하거나 내용을 복사해 붙여넣어 주세요.');
  throw badRequest('txt, md, csv, docx 파일만 등록할 수 있습니다. 다른 형식은 내용을 복사해 붙여넣어 주세요.');
}

module.exports = { extractText, docxToText, readZipEntry };
