/*
 * 이 파일이 하는 일: 자동 테스트에서 공통으로 쓰는 도우미입니다.
 *
 *  - startServer(): 임시 폴더에 새 DB를 만들고 서버를 빈 포트로 띄웁니다. (실제 data 폴더는 건드리지 않음)
 *  - Client: 쿠키(로그인 상태)와 CSRF 토큰을 기억하는 간단한 브라우저 흉내
 *  - setupAdmin(): 첫 설정(관리자 계정 만들기)까지 한 번에
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function startServer({ demo = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentalax-test-'));
  process.env.DENTALAX_DATA_DIR = dataDir;
  process.env.DENTALAX_OPEN_BROWSER = 'false';
  const cfg = require('../server/core/config');
  cfg.reloadConfig();
  require('../server/core/secrets').resetMasterKeyCache();
  require('../server/core/security').resetRateLimits();
  const { init, createApp } = require('../server/app');
  init(path.join(dataDir, 'dentalax.db'));
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = {
    base,
    dataDir,
    server,
    async close() {
      await new Promise((r) => server.close(r));
      require('../server/core/db').close();
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* 윈도우에서 파일 잠금이 남아 있으면 무시 */
      }
    },
  };
  if (demo) {
    const admin = new Client(base);
    await admin.setupAdmin({ demo: true });
    ctx.admin = admin;
  }
  return ctx;
}

class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
    this.csrf = null;
  }

  async req(method, url, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    let payload;
    if (body instanceof Buffer) {
      payload = body;
      headers['content-type'] = headers['content-type'] || 'application/octet-stream';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(this.base + url, { method, headers, body: payload, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = setCookie.match(/dx_session=([^;]*)/);
      if (m) this.cookie = m[1] ? `dx_session=${m[1]}` : '';
    }
    const ct = res.headers.get('content-type') || '';
    let data;
    if (ct.includes('application/json')) data = await res.json();
    else if (ct.includes('text/') ) data = await res.text();
    else data = Buffer.from(await res.arrayBuffer());
    if (data && data.csrfToken) this.csrf = data.csrfToken;
    return { status: res.status, data, headers: res.headers };
  }

  get(url) {
    return this.req('GET', url);
  }
  post(url, body = {}) {
    return this.req('POST', url, body);
  }
  put(url, body = {}) {
    return this.req('PUT', url, body);
  }
  patch(url, body = {}) {
    return this.req('PATCH', url, body);
  }
  del(url) {
    return this.req('DELETE', url);
  }

  async setupAdmin({ demo = false, username = 'admin', password = 'Admin1234!' } = {}) {
    const r = await this.post('/api/auth/setup', { clinicName: '테스트치과', name: '김원장', username, password, demo });
    if (r.status !== 200) throw new Error('setup failed: ' + JSON.stringify(r.data));
    return r;
  }

  async login(username, password) {
    return this.post('/api/auth/login', { username, password });
  }
}

/** 관리자 클라이언트로 역할별 사용자를 만들고 로그인한 클라이언트를 돌려줌 (비밀번호 변경까지 완료) */
async function makeUser(admin, { name, role, username, jobTitle = '치과위생사' }) {
  const temp = 'Temp1234!';
  const r = await admin.post('/api/admin/users', { name, role, username, password: temp, jobTitle });
  if (r.status !== 201) throw new Error('makeUser failed: ' + JSON.stringify(r.data));
  const c = new Client(admin.base);
  const l = await c.login(username, temp);
  if (l.status !== 200) throw new Error('login failed: ' + JSON.stringify(l.data));
  const p = await c.post('/api/auth/password', { current: temp, next: 'Newpass123!' });
  if (p.status !== 200) throw new Error('pw change failed: ' + JSON.stringify(p.data));
  return { client: c, id: r.data.id };
}

module.exports = { startServer, Client, makeUser };
