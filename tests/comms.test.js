/*
 * 이 파일이 하는 일: [소통 도우미] 모듈 자동 테스트
 *  - 데모 데이터(스크립트 5개, 문자 템플릿 7개), 스크립트·템플릿 저장/수정/삭제, 검색·분류 필터, 권한(남의 글 수정 불가)
 *  - 리뷰 답글 "주의 표현 검사" 규칙(순수 함수 + API), 문자 바이트 계산·변수 채우기
 *  - AI 3종(전화 스크립트·리뷰 답글·안내 문자) 데모 모드, 리뷰 원문이 DB에 남지 않는지
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeUser } = require('./helpers');
const { checkReply, smsBytes, smsKind, fillVars, listVars } = require('../server/modules/comms/rules');

let s;
let staff;
let staff2;
before(async () => {
  s = await startServer({ demo: true });
  staff = (await makeUser(s.admin, { name: '데스크직원', role: 'staff', username: 'cmstaff' })).client;
  staff2 = (await makeUser(s.admin, { name: '다른직원', role: 'staff', username: 'cmstaff2' })).client;
});
after(async () => s && s.close());

// ---------- 순수 함수 ----------
test('주의 표현 검사: 과장·효과 보장·비교·진료 언급을 찾는다', () => {
  const r = checkReply('저희 치과는 지역 최고의 실력으로 임플란트를 100% 무통으로 해 드립니다. 다른 치과보다 저렴합니다. 치료받으신 부분은 완치될 거예요.');
  const kinds = new Set(r.warnings.map((w) => w.kind));
  for (const k of ['과장 표현', '효과 보장', '비교', '진료 정보 언급']) assert.ok(kinds.has(k), `${k} 감지`);
  const phrases = r.warnings.map((w) => w.phrase).join('|');
  for (const p of ['최고', '임플란트', '100%', '무통', '완치', '치료받으신']) assert.ok(phrases.includes(p), `${p} 감지: ${phrases}`);
  assert.equal(r.ok, false);
  assert.ok(r.counts.danger >= 5);
  // 위치 정보가 맞는지
  const w = r.warnings.find((x) => x.phrase === '100%');
  assert.equal('저희 치과는 지역 최고의 실력으로 임플란트를 100% 무통으로 해 드립니다.'.indexOf('100%'), w.index);
});

test('주의 표현 검사: 무난한 답글은 통과', () => {
  const r = checkReply('소중한 의견 남겨 주셔서 감사합니다. 말씀해 주신 부분은 직원들과 함께 공유하고 더 신경 쓰겠습니다. 앞으로도 정성을 다하겠습니다.');
  assert.equal(r.ok, true, JSON.stringify(r.warnings));
  assert.equal(checkReply('').ok, true);
});

test('주의 표현 검사: 환자 여부·후기 보상·연락처', () => {
  const r = checkReply('내원해 주셔서 감사합니다. 리뷰 작성 시 할인해 드려요. 010-1234-5678로 연락 주세요.');
  const kinds = r.warnings.map((w) => w.kind);
  assert.ok(kinds.includes('진료 정보 언급'));
  assert.ok(kinds.includes('환자 유인'));
  assert.ok(kinds.includes('개인정보'));
});

test('문자 바이트: 한글 2바이트, 영문·숫자 1바이트, 90/2000 기준', () => {
  assert.equal(smsBytes('가나다'), 6);
  assert.equal(smsBytes('abc 123'), 7);
  assert.equal(smsBytes('[하늘] 안녕\n'), 12, '기호·띄어쓰기·줄바꿈은 1바이트');
  assert.equal(smsKind(90).kind, 'SMS');
  assert.equal(smsKind(91).kind, 'LMS');
  assert.equal(smsKind(2000).kind, 'LMS');
  assert.equal(smsKind(2001).over, true);
});

test('변수 채우기와 목록', () => {
  assert.equal(fillVars('{이름}님 {날짜} {시간} {없는값}', { 이름: '홍길동', 날짜: '10월 17일', 시간: '오후 2시' }), '홍길동님 10월 17일 오후 2시 {없는값}');
  assert.deepEqual(listVars('{이름} {날짜} {이름}'), ['이름', '날짜']);
});

// ---------- API ----------
test('데모 데이터: 스크립트와 문자 템플릿', async () => {
  const sc = await s.admin.get('/api/comms/scripts');
  assert.equal(sc.status, 200);
  assert.ok(sc.data.total >= 4);
  assert.ok(sc.data.rows.some((x) => x.category === '주차·오시는 길' && x.body.includes('주차')));
  const tp = await s.admin.get('/api/comms/templates');
  assert.ok(tp.data.total >= 5);
  for (const t of ['휴진 안내', '예약 전날 안내', '스케일링 보험 안내 (일반)', '주차 안내', '진료 후 일반 안내']) {
    assert.ok(tp.data.rows.some((x) => x.title === t), `${t} 있음`);
  }
  const day = tp.data.rows.find((x) => x.title === '예약 전날 안내');
  assert.ok(day.vars.includes('이름'));
  const meta = await staff.get('/api/comms/meta');
  assert.equal(day.bytes, smsBytes(fillVars(day.body, meta.data.sample)), '바이트는 예시 값으로 채운 기준');
  assert.equal(day.smsKind, 'SMS');
  assert.ok(meta.data.scriptCategories.includes('불만 응대'));
  assert.ok(meta.data.sample.병원명);
});

test('스크립트 저장 → 검색·분류 필터 → 수정 → 삭제', async () => {
  const c = await staff.post('/api/comms/scripts', { title: '야간진료 문의', category: '진료시간', body: '"목요일은 20시까지 진료합니다."' });
  assert.equal(c.status, 201);
  assert.equal(c.data.authorName, '데스크직원');
  const q = await staff.get(`/api/comms/scripts?q=${encodeURIComponent('야간')}`);
  assert.ok(q.data.rows.some((x) => x.id === c.data.id));
  const cat = await staff.get(`/api/comms/scripts?category=${encodeURIComponent('불만 응대')}`);
  assert.ok(cat.data.rows.every((x) => x.category === '불만 응대'));
  assert.ok(cat.data.counts['진료시간'] >= 2, '분류별 개수');
  const u = await staff.patch(`/api/comms/scripts/${c.data.id}`, { title: '야간진료 안내' });
  assert.equal(u.data.title, '야간진료 안내');
  assert.equal((await staff.del(`/api/comms/scripts/${c.data.id}`)).status, 200);
  assert.equal((await staff.patch(`/api/comms/scripts/${c.data.id}`, { title: 'x' })).status, 404);
});

test('권한: 다른 직원의 글은 고칠 수 없고, 실장 이상은 가능', async () => {
  const c = await staff.post('/api/comms/templates', { title: '내 템플릿', category: '기타', body: '[{병원명}] 안내' });
  assert.equal(c.status, 201);
  assert.equal(c.data.canEdit, true);
  assert.equal((await staff2.patch(`/api/comms/templates/${c.data.id}`, { title: 'x' })).status, 403);
  assert.equal((await staff2.del(`/api/comms/templates/${c.data.id}`)).status, 403);
  const list = await staff2.get('/api/comms/templates');
  assert.equal(list.data.rows.find((x) => x.id === c.data.id).canEdit, false);
  assert.equal((await s.admin.patch(`/api/comms/templates/${c.data.id}`, { body: '[{병원명}] 바뀐 안내' })).status, 200);
  assert.equal((await s.admin.del(`/api/comms/templates/${c.data.id}`)).status, 200);
});

test('입력 검증: 제목·분류·길이', async () => {
  const a = await staff.post('/api/comms/scripts', { title: '', body: 'x' });
  assert.equal(a.status, 400);
  assert.match(a.data.error.message, /제목/);
  const b = await staff.post('/api/comms/templates', { title: 'x', category: '없는 분류', body: 'x' });
  assert.equal(b.status, 400);
  const c = await staff.post('/api/comms/templates', { title: 'x', body: 'ㄱ'.repeat(2001) });
  assert.equal(c.status, 400);
  const d = await staff.get(`/api/comms/templates?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(d.status, 200);
  assert.equal(d.data.total, 0);
});

test('주의 표현 검사 API (저장하지 않음)', async () => {
  const r = await staff.post('/api/comms/check-reply', { text: '최고의 치과에서 완벽하게 치료해 드립니다.' });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, false);
  assert.ok(r.data.warnings.some((w) => w.phrase.includes('최고')));
});

test('AI 전화 스크립트(데모): 병원 정보를 넣은 인사→안내→마무리', async () => {
  const r = await staff.post('/api/ai/run', { feature: 'comms.script', input: { situation: '주차·오시는 길', notes: '엘리베이터 위치도 알려 주기' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.demo, true);
  assert.equal(r.data.pii.findings.length, 0, '병원 정보가 개인정보로 잘못 가려지지 않음');
  const { title, body } = r.data.data;
  assert.ok(title);
  for (const h of ['인사', '안내', '마무리', '예상 질문']) assert.ok(body.includes(h), `${h} 포함`);
  const clinic = (await staff.get('/api/comms/meta')).data.clinic;
  assert.ok(body.includes(clinic.name), '병원 이름');
  assert.ok(body.includes(clinic.parking.slice(0, 10)), '등록된 주차 안내');
  assert.ok(body.includes('주차'), '주차 정보');
  const cost = await staff.post('/api/ai/run', { feature: 'comms.script', input: { situation: '비용 일반 문의' } });
  assert.ok(cost.data.text.includes('진료 후 상담'), '금액은 진료 후 상담으로 안내');
  assert.ok(!/\d+만\s?원|\d{2,3},\d{3}원/.test(cost.data.text), '개별 금액을 말하지 않음');
});

test('AI 리뷰 답글(데모): 2~3안, 주의 표현 없음, 리뷰 원문은 저장 안 됨', async () => {
  const review = '임플란트 수술 받았는데 대기가 너무 길었어요. 설명은 친절했어요. UNIQUE_REVIEW_TEXT_123';
  const r = await staff.post('/api/ai/run', { feature: 'comms.review', input: { review, rating: 2, tone: '정중' } });
  assert.equal(r.status, 200);
  const replies = r.data.data.replies;
  assert.ok(replies.length >= 2 && replies.length <= 3);
  for (const rep of replies) {
    assert.ok(rep.text.length > 10);
    assert.ok(!/임플란트|수술/.test(rep.text), '진료 내용을 언급하지 않음');
    assert.equal(rep.check.counts.danger, 0, `위험 표현 없음: ${rep.text}`);
  }
  assert.ok(replies.some((x) => x.text.includes('02-555-0123')), '불만 리뷰엔 대표번호 안내');
  const good = await staff.post('/api/ai/run', { feature: 'comms.review', input: { review: '친절하고 깨끗해요', rating: 5, tone: '간결' } });
  assert.equal(good.data.data.replies[0].label, '짧고 간결', '고른 말투가 먼저');
  // 리뷰 원문은 어떤 표에도 남지 않음 (AI 사용 기록에도 글 내용은 저장하지 않음)
  const db = require('../server/core/db');
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
  for (const t of tables) {
    const cols = db.all(`PRAGMA table_info("${t}")`).filter((c) => /TEXT/i.test(c.type) || !c.type);
    for (const c of cols) {
      const hit = db.get(`SELECT COUNT(*) AS n FROM "${t}" WHERE "${c.name}" LIKE ?`, '%UNIQUE_REVIEW_TEXT_123%');
      assert.equal(hit.n, 0, `${t}.${c.name}에 리뷰 원문이 저장됨`);
    }
  }
  const bad = await staff.post('/api/ai/run', { feature: 'comms.review', input: { review: '좋아요', rating: 7 } });
  assert.equal(bad.status, 400);
});

test('AI 안내 문자(데모): 변수 포함, 단문 옵션은 90바이트 이하', async () => {
  const r = await staff.post('/api/ai/run', { feature: 'comms.message', input: { purpose: '다음 주 수요일 휴진 안내' } });
  assert.equal(r.status, 200);
  assert.ok(r.data.data.body.includes('{병원명}'));
  assert.equal(r.data.pii.findings.length, 0, '병원 정보가 개인정보로 잘못 가려지지 않음');
  assert.ok(r.data.data.title.includes('휴진'));
  const sample = (await staff.get('/api/comms/meta')).data.sample;
  for (const purpose of ['내일 예약 안내', '휴진 안내', '주차 안내', '진료 후 연락 안내', '아무 목적']) {
    const sh = await staff.post('/api/ai/run', { feature: 'comms.message', input: { purpose, short: true } });
    const filled = fillVars(sh.data.data.body, sample);
    assert.ok(smsBytes(filled) <= 90, `${purpose}: ${smsBytes(filled)}바이트 — ${filled}`);
  }
  // 기존 문구 줄이기
  const long = '[{병원명}] 안녕하세요. 이번 달 마지막 주 토요일은 내부 교육으로 오전 진료만 합니다. 이용에 참고 부탁드립니다. 감사합니다.';
  const shorten = await staff.post('/api/ai/run', { feature: 'comms.message', input: { text: long, short: true } });
  assert.ok(smsBytes(fillVars(shorten.data.data.body, sample)) <= 90);
  const none = await staff.post('/api/ai/run', { feature: 'comms.message', input: { purpose: '', text: '' } });
  assert.equal(none.status, 400);
});
