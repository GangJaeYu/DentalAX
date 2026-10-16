/*
 * 이 파일이 하는 일: [원내 AI 도우미] 자동 테스트
 *  - 한국어 검색(조사가 붙어도 찾는지), 문서 등록(붙여넣기·docx), 권한, 근거 표시, 개인정보 가림
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { startServer, makeUser } = require('./helpers');
const { tokenize, chunkText, buildIndex, search } = require('../server/modules/assistant/search');

let s;
let staff;
before(async () => {
  s = await startServer({ demo: true });
  staff = (await makeUser(s.admin, { name: '도우미직원', role: 'staff', username: 'asst1' })).client;
});
after(async () => s && s.close());

test('바이그램 검색은 조사가 달라도 찾는다', () => {
  assert.deepEqual(tokenize('멸균기는'), ['멸균', '균기', '기는']);
  const idx = buildIndex([
    { title: 'A', heading: '멸균', text: '멸균기를 사용할 때는 하루 한 번 BI 테스트를 합니다.' },
    { title: 'B', heading: '주차', text: '주차는 지하 2층을 이용합니다.' },
  ]);
  const r = search(idx, '멸균기는 어떻게 테스트하나요?');
  assert.equal(r[0].chunk.title, 'A');
  assert.equal(search(idx, '전혀 관계없는 질문').length, 0);
});

test('긴 문서는 제목 기준으로 나뉜다', () => {
  const chunks = chunkText('# 1장\n첫 내용\n\n# 2장\n둘째 내용');
  assert.deepEqual(chunks.map((c) => c.heading), ['1장', '2장']);
});

/** 테스트용 아주 작은 docx(zip) 만들기 */
function makeDocx(xml) {
  const name = Buffer.from('word/document.xml');
  const data = zlib.deflateRawSync(Buffer.from(xml, 'utf8'));
  const raw = Buffer.from(xml, 'utf8');
  const crc = zlib.crc32(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const cdStart = local.length + name.length + data.length;
  const cdSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdStart, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

test('문서 등록: 붙여넣기와 워드(docx) 파일', async () => {
  const paste = await s.admin.post('/api/assistant/docs', { title: '석션 관리 매뉴얼', category: '장비 사용법', text: '# 석션 트랩 청소\n석션 트랩은 매주 금요일 진료 후 장갑을 끼고 분리해 세척합니다.' });
  assert.equal(paste.status, 201);
  assert.ok(paste.data.chars > 10);
  const xml = '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>컴프레서 관리</w:t></w:r></w:p><w:p><w:r><w:t>컴프레서 물빼기는 매일 마감 때 합니다 &amp; 기록합니다.</w:t></w:r></w:p></w:body></w:document>';
  const docx = await s.admin.post('/api/assistant/docs', { title: '컴프레서', filename: '컴프레서.docx', base64: makeDocx(xml).toString('base64') });
  assert.equal(docx.status, 201, JSON.stringify(docx.data));
  const view = await s.admin.get(`/api/assistant/docs/${docx.data.id}`);
  assert.match(view.data.content, /# 컴프레서 관리/);
  assert.match(view.data.content, /매일 마감 때 합니다 & 기록/);
  const found = await staff.get('/api/assistant/search?q=' + encodeURIComponent('컴프레서 물빼기 언제'));
  assert.equal(found.data.results[0].title, '컴프레서');
});

test('PDF·한글 파일은 친절한 안내와 함께 거부한다', async () => {
  const r = await s.admin.post('/api/assistant/docs', { title: 'x', filename: 'a.hwp', base64: Buffer.from('xxxxxxxxxxxx').toString('base64') });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /한글/);
});

test('직원은 문서를 볼 수 있지만 등록·삭제는 못 한다', async () => {
  assert.equal((await staff.get('/api/assistant/docs')).status, 200);
  assert.equal((await staff.post('/api/assistant/docs', { title: 'x', text: '내용이 충분히 깁니다 정말로' })).status, 403);
  const list = (await s.admin.get('/api/assistant/docs')).data.docs;
  assert.equal((await staff.del(`/api/assistant/docs/${list[0].id}`)).status, 403);
});

test('질문하면 근거 문서와 함께 답한다 (데모 모드)', async () => {
  const r = await staff.post('/api/ai/run', { feature: 'assistant.ask', input: { question: '석션 트랩은 언제 청소하나요?' } });
  assert.equal(r.status, 200);
  assert.ok(r.data.sources.length >= 1);
  assert.equal(r.data.sources[0].title, '석션 관리 매뉴얼');
  assert.ok(!('text' in r.data.sources[0]), '응답에는 원문 전체 대신 짧은 미리보기만');
  assert.match(r.data.text, /\[1\]/);
});

test('질문 속 개인정보는 가려지고, 질문은 저장되지 않는다', async () => {
  const r = await staff.post('/api/ai/run', { feature: 'assistant.ask', input: { question: '010-3333-4444 번호 환자 연차?' } });
  assert.equal(r.status, 200);
  assert.ok(r.data.pii.findings.some((f) => f.type === 'phone'));
  const { all } = require('../server/core/db');
  const dump = JSON.stringify(all('SELECT * FROM ai_usage'));
  assert.ok(!dump.includes('3333-4444'));
});

test('참고하지 않기로 바꾼 문서는 검색에서 빠진다', async () => {
  const list = (await s.admin.get('/api/assistant/docs')).data.docs;
  const doc = list.find((d) => d.title === '석션 관리 매뉴얼');
  await s.admin.patch(`/api/assistant/docs/${doc.id}`, { active: false });
  const r = await staff.get('/api/assistant/search?q=' + encodeURIComponent('석션 트랩 청소'));
  assert.ok(!r.data.results.some((x) => x.title === '석션 관리 매뉴얼'));
});
