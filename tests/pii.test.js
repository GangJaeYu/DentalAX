/*
 * 이 파일이 하는 일: 개인정보 필터(AI로 보내기 전 검사) 자동 테스트
 *  - 찾아야 할 것은 찾고(가리거나 차단), 업무 글(날짜·금액·수량·대표번호)은 건드리지 않는지 확인
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pii = require('../server/ai/pii');

function types(text, opts) {
  return pii.scanText(text, opts).findings.map((f) => f.type).sort();
}

test('주민등록번호는 항상 차단한다 (하이픈 유무, 뒷자리 가림 포함)', () => {
  for (const t of ['주민번호 900101-1234567 입니다', '9001011234567', '850315 - 2345678', '010203-3******']) {
    const r = pii.scanText(t);
    assert.ok(r.findings.some((f) => f.type === 'rrn'), t);
    assert.equal(r.blocked, true, t);
    assert.ok(!r.text.match(/\d{6}\s?-?\s?\d{7}/), '가려짐');
  }
});

test('날짜처럼 생기지 않은 13자리 숫자는 주민번호로 보지 않는다', () => {
  assert.ok(!types('주문번호 991399-1234567').includes('rrn'));
});

test('카드번호(Luhn 검사 통과 또는 4-4-4-4)는 차단한다', () => {
  assert.ok(pii.scanText('카드 4111 1111 1111 1111 결제').blocked);
  assert.ok(pii.scanText('카드 5555-5555-5555-4444').blocked);
  assert.ok(pii.scanText('번호 1234-5678-9012-3456').blocked); // 4-4-4-4 형태
});

test('전화번호는 가리고 보낸다 (휴대폰·일반전화·국제형식)', () => {
  for (const t of ['010-1234-5678', '01012345678', '011 234 5678', '02-555-1234', '031)123-4567', '+82 10-1234-5678', '070-1234-5678']) {
    const r = pii.scanText(`연락처 ${t} 로 전화`);
    assert.deepEqual(r.findings.map((f) => f.type), ['phone'], t);
    assert.equal(r.blocked, false);
    assert.match(r.text, /\[전화번호\]/);
  }
});

test('병원 대표번호(허용 목록)와 1588 대표번호는 가리지 않는다', () => {
  const r = pii.scanText('문의는 02-555-0123 또는 1588-1234 로', { allow: ['02-555-0123'] });
  assert.equal(r.findings.length, 0);
  assert.match(r.text, /02-555-0123/);
});

test('이메일·계좌번호·운전면허·여권·차트번호를 찾는다', () => {
  assert.deepEqual(types('메일 kim.dent@example.com 로'), ['email']);
  assert.deepEqual(types('계좌 110-123-456789 로 입금'), ['account']);
  assert.deepEqual(types('입금 계좌는 국민 12345678901234 입니다'), ['account']);
  assert.deepEqual(types('면허 11-12-345678-90'), ['license']);
  assert.deepEqual(types('여권 M12345678'), ['passport']);
  assert.deepEqual(types('차트번호: 20231'), ['chart']);
  assert.deepEqual(types('환자번호 A-0012'), ['chart']);
});

test('환자 이름 표기를 찾는다', () => {
  assert.ok(types('홍길동 환자에게 리콜 전화').includes('name'));
  assert.ok(types('김민수님 예약 변경').includes('name'));
  assert.ok(types('환자명: 이서연').includes('name'));
  assert.ok(types('성함 : 박지성').includes('name'));
});

test('병원·업체·파일 "이름:" 표기는 사람 이름으로 보지 않는다', () => {
  for (const t of ['병원 이름: 하늘치과의원', '병원이름: 하늘치과', '업체 이름: 한빛덴탈', '파일 이름: 연차신청서', '품목 이름 : 니트릴장갑']) {
    assert.ok(!types(t).includes('name'), t);
  }
  assert.ok(types('이름: 홍길동').includes('name'));
  assert.ok(types('보호자: 김영희').includes('name'));
});

test('업무 표현은 이름으로 오인하지 않는다', () => {
  for (const t of ['원장님께 보고', '고객님 안내', '선생님들 회의', '실장님 확인', '신규 환자 응대', '어머님께 설명', '보호자분 대기', '기사님 배송', '이번 환자분들']) {
    assert.ok(!types(t).includes('name'), t);
  }
});

test('날짜·시간·금액·수량·재고 코드는 건드리지 않는다', () => {
  const text = '2026-10-16 14:30 회의, 니트릴 장갑 10박스 단가 12,500원, 총 1,250,000원, 로트 L2309, 3번 체어';
  const r = pii.scanText(text);
  assert.equal(r.findings.length, 0, JSON.stringify(r.findings));
  assert.equal(r.text, text);
});

test('"모두 차단" 모드에서는 무엇이든 감지되면 차단한다', () => {
  const r = pii.scanText('010-1234-5678', { mode: 'block' });
  assert.equal(r.blocked, true);
  assert.deepEqual(r.blockedTypes, ['phone']);
});

test('여러 글을 한 번에 검사하고 안내 문장을 만든다', () => {
  const r = pii.scanMany(['010-1111-2222', '메일 a@b.co', '보통 글'], {});
  assert.equal(r.texts[2], '보통 글');
  assert.equal(r.findings.length, 2);
  assert.match(pii.describe(r.findings, r.blocked), /가리고 보냈습니다/);
  assert.match(pii.describe([{ label: '주민등록번호', count: 1 }], true), /보내지 않았습니다/);
});

test('Luhn 계산', () => {
  assert.equal(pii.luhnOk('4111111111111111'), true);
  assert.equal(pii.luhnOk('4111111111111112'), false);
});
