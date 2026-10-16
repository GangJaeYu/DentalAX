/*
 * 이 파일이 하는 일: 웹 보안 장치들을 모아 둡니다.
 *
 *  1) lanOnly       — 원내(사설) 네트워크에서 온 접속만 허용
 *  2) hostCheck     — 이상한 도메인 이름으로 들어온 요청 차단 (DNS 리바인딩 공격 대비)
 *  3) securityHeaders — 브라우저에 "이 페이지는 이렇게만 동작하라"는 보안 규칙을 알려 줌 (XSS·클릭재킹 대비)
 *  4) csrfProtect   — 다른 사이트가 몰래 우리 서버로 요청을 보내는 것(CSRF) 차단
 *  5) rateLimit     — 짧은 시간에 너무 많은 시도(비밀번호 무차별 대입 등) 차단
 */
const net = require('node:net');
const cfg = require('./config');
const { HttpError } = require('./errors');

// ---------- 1) 원내 네트워크 전용 ----------
function isPrivateIp(ipRaw) {
  if (!ipRaw) return false;
  let ip = String(ipRaw).replace(/^::ffff:/, '');
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 이 PC 자신
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (가장 흔한 공유기 주소)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // 자동 할당 주소
    if (a === 100 && b >= 64 && b <= 127) return true; // 통신사 공유 주소(CGNAT)
    return false;
  }
  if (net.isIPv6(ip)) {
    ip = ip.toLowerCase();
    if (ip === '::1') return true;
    if (ip.startsWith('fe80:')) return true; // 링크 로컬
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // 사설 IPv6
    return false;
  }
  return false;
}

function lanOnly(req, res, next) {
  if (cfg.config.allowExternal) return next();
  if (isPrivateIp(req.socket.remoteAddress)) return next();
  res.status(403).type('text/plain; charset=utf-8').send('원내 네트워크에서만 접속할 수 있습니다.');
}

// ---------- 2) Host 이름 검사 ----------
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  let host = String(hostHeader).toLowerCase();
  // [::1]:3800 같은 IPv6 형태
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'));
  else host = host.replace(/:\d+$/, '');
  if (net.isIP(host)) return true; // 192.168.0.10 같은 IP 주소
  if (host === 'localhost') return true;
  if (!host.includes('.')) return true; // DESKTOP-ABC 같은 PC 이름
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return true;
  const extra = cfg.config.allowedHosts || [];
  return extra.map((h) => String(h).toLowerCase()).includes(host);
}

function hostCheck(req, res, next) {
  if (cfg.config.allowExternal) return next();
  if (hostAllowed(req.headers.host)) return next();
  res.status(403).type('text/plain; charset=utf-8').send('허용되지 않은 접속 주소입니다. 서버 PC의 IP 주소로 접속해 주세요.');
}

// ---------- 3) 보안 헤더 ----------
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  // (Cross-Origin-Opener-Policy 는 HTTPS에서만 동작하고 원내 HTTP 주소에선 브라우저 경고만 남겨서 넣지 않음)
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

// ---------- 4) CSRF 방어 ----------
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function csrfProtect(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  // (a) 보낸 곳(Origin)이 있으면 우리 서버 주소와 같아야 함
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      /* 잘못된 값 */
    }
    if (originHost !== req.headers.host) return next(new HttpError(403, '다른 사이트에서 보낸 요청은 처리하지 않습니다.'));
  }
  // (b) 파일 올리기(복원) 외에는 JSON 형식만 받음 — 일반 웹 폼으로는 JSON을 보낼 수 없어 CSRF가 어려워짐
  const ct = String(req.headers['content-type'] || '');
  const isRaw = ct.startsWith('application/octet-stream');
  if (!ct.startsWith('application/json') && !isRaw && req.headers['content-length'] !== '0' && req.headers['content-length'] !== undefined) {
    return next(new HttpError(415, '지원하지 않는 요청 형식입니다.'));
  }
  // (c) 로그인한 상태라면 화면이 받은 CSRF 토큰을 머리글에 실어 보내야 함
  if (req.session) {
    const sent = req.headers['x-csrf-token'];
    if (!sent || sent !== req.session.csrf_token) {
      return next(new HttpError(403, '보안 확인에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.'));
    }
  }
  next();
}

// ---------- 5) 시도 횟수 제한 ----------
const buckets = new Map();

/**
 * key별로 windowMs 동안 limit 번까지만 허용합니다.
 * @returns {boolean} true면 허용, false면 초과
 */
function hit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
  }
  b.count++;
  // 메모리가 계속 커지지 않게 가끔 정리
  if (buckets.size > 5000) {
    for (const [k, val] of buckets) if (now - val.start > windowMs) buckets.delete(k);
  }
  return b.count <= limit;
}

function resetRateLimits() {
  buckets.clear();
}

/** Express 미들웨어 형태: 같은 IP에서 windowMs 동안 limit 번 초과 시 429 */
function rateLimit(name, limit, windowMs, message) {
  return (req, res, next) => {
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!hit(`${name}:${ip}`, limit, windowMs)) {
      return next(new HttpError(429, message || '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'));
    }
    next();
  };
}

module.exports = { isPrivateIp, hostAllowed, lanOnly, hostCheck, securityHeaders, csrfProtect, rateLimit, hit, resetRateLimits, CSP };
