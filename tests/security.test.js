/*
 * 이 파일이 하는 일: 보안 장치 자동 테스트 (보안 헤더, 원내 IP 판별, Host 검사, 경로 조작, 오류 정보 숨김, 로그인 시도 제한)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client } = require('./helpers');
const security = require('../server/core/security');

let s;
before(async () => {
  s = await startServer();
});
after(async () => s && s.close());

test('보안 헤더가 붙는다', async () => {
  const r = await fetch(s.base + '/');
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!/unsafe-eval/.test(csp));
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('x-powered-by'), null);
  const api = await fetch(s.base + '/api/auth/status');
  assert.equal(api.headers.get('cache-control'), 'no-store');
});

test('사설(원내) IP만 허용 대상으로 판별한다', () => {
  for (const ip of ['127.0.0.1', '::1', '192.168.0.10', '10.1.2.3', '172.16.0.5', '172.31.255.1', '::ffff:192.168.1.7', 'fe80::1', 'fd00::5']) {
    assert.equal(security.isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '203.0.113.5', '::ffff:8.8.4.4', '2001:4860::8888', '']) {
    assert.equal(security.isPrivateIp(ip), false, ip);
  }
});

test('Host 이름 검사: IP·PC 이름은 허용, 외부 도메인은 거부 (DNS 리바인딩 대비)', async () => {
  for (const h of ['192.168.0.5:3800', 'localhost:3800', 'DESKTOP-ABC:3800', 'clinic-pc.local', '[::1]:3800']) assert.equal(security.hostAllowed(h), true, h);
  for (const h of ['evil.com', 'attacker.example.org:3800', '']) assert.equal(security.hostAllowed(h), false, h);
  // fetch는 Host 머리글을 바꿀 수 없어 http 모듈로 직접 보냄
  const http = require('node:http');
  const status = await new Promise((resolve, reject) => {
    const u = new URL(s.base);
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/auth/status', headers: { host: 'evil.com' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('없는 API는 JSON 404, 경로 조작으로 서버 파일을 읽을 수 없다', async () => {
  const r = await fetch(s.base + '/api/nope');
  assert.equal(r.status, 404);
  assert.match((await r.json()).error.message, /없는/);
  for (const p of ['/../server/app.js', '/%2e%2e/server/app.js', '/..%2fserver%2fapp.js', '/../data/dentalax.db', '/.env']) {
    const x = await fetch(s.base + p);
    assert.notEqual(x.status, 200, p);
  }
});

test('예상 못한 오류는 내부 정보 없이 일반 안내만 보낸다', async () => {
  const { errorHandler } = require('../server/core/errors');
  let status;
  let body;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  const origError = console.error;
  console.error = () => {};
  try {
    errorHandler(new Error('SQLITE secret path C:/data/x.db'), { method: 'GET', originalUrl: '/x' }, res, () => {});
  } finally {
    console.error = origError;
  }
  assert.equal(status, 500);
  assert.ok(!JSON.stringify(body).includes('SQLITE'));
  assert.match(body.error.message, /잠시 후/);
  const c = new Client(s.base);
  await c.setupAdmin();
});

test('깨진 JSON은 400으로 안내한다', async () => {
  const c = new Client(s.base);
  await c.login('admin', 'Admin1234!');
  const res = await fetch(s.base + '/api/board/posts', {
    method: 'POST',
    headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': 'application/json' },
    body: '{"kind": "notice", ',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(!JSON.stringify(body).includes('at '), '스택 정보 노출 없음');
});

test('같은 IP에서 로그인 시도가 너무 많으면 잠시 막는다', async () => {
  security.resetRateLimits();
  const c = new Client(s.base);
  let last;
  for (let i = 0; i < 31; i++) last = await c.login('nobody', 'whatever1');
  assert.equal(last.status, 429);
  security.resetRateLimits();
});

test('입력 검증: 너무 긴 값, 잘못된 날짜는 거부한다', async () => {
  const c = new Client(s.base);
  await c.login('admin', 'Admin1234!');
  assert.equal((await c.post('/api/board/posts', { kind: 'notice', title: 'x'.repeat(500) })).status, 400);
  assert.equal((await c.post('/api/board/posts', { kind: 'handover', title: 'ok', dueDate: '2026-13-45' })).status, 400);
  assert.equal((await c.post('/api/board/posts', { kind: 'hacker', title: 'ok' })).status, 400);
});
