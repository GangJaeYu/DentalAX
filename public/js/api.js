/*
 * 이 파일이 하는 일: 화면이 서버와 이야기할 때 쓰는 통로입니다.
 *
 *   const items = await api.get('/inventory/items');
 *   await api.post('/board/posts', { title: '...' });
 *
 *  - 로그인 후 받은 CSRF 토큰(보안 확인용 값)을 모든 요청에 자동으로 붙입니다.
 *  - 서버가 보낸 오류는 ApiError로 바꿔 던지고, error.message 에는 이미 쉬운 한국어 안내가 들어 있습니다.
 *  - 로그인이 만료되면(401) 앱 전체에 알려 로그인 화면으로 돌아가게 합니다.
 */

let csrfToken = null;
let onUnauthorized = null;

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

export function setCsrf(token) {
  csrfToken = token;
}

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(method, url, body, opts = {}) {
  const headers = { Accept: 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    headers['Content-Type'] = 'application/octet-stream';
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('/api' + url, { method, headers, body: payload, credentials: 'same-origin', signal: opts.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('서버에 연결할 수 없습니다. 서버 PC가 켜져 있는지, 같은 와이파이(네트워크)에 연결되어 있는지 확인해 주세요.', 0);
  }
  if (opts.raw) {
    if (!res.ok) {
      let msg = '파일을 받지 못했습니다.';
      try {
        msg = (await res.json()).error.message;
      } catch {
        /* 무시 */
      }
      throw new ApiError(msg, res.status);
    }
    return res;
  }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = data && data.error ? data.error : {};
    const message = err.message || `요청을 처리하지 못했습니다. (${res.status})`;
    if (res.status === 401 && onUnauthorized && !url.startsWith('/auth/login')) onUnauthorized(message);
    throw new ApiError(message, res.status, err);
  }
  return data;
}

export const api = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body = {}, opts) => request('POST', url, body, opts),
  put: (url, body = {}, opts) => request('PUT', url, body, opts),
  patch: (url, body = {}, opts) => request('PATCH', url, body, opts),
  del: (url, opts) => request('DELETE', url, undefined, opts),
  /** 파일 그대로 올리기 (백업 복원 등) */
  upload: (url, blob) => request('POST', url, blob),

  /** 파일 내려받기 (CSV, 백업 등): 서버 응답을 파일로 저장 */
  async download(url, fallbackName = 'download') {
    const res = await request('GET', url, undefined, { raw: true });
    const cd = res.headers.get('content-disposition') || '';
    let name = fallbackName;
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    if (m) {
      try {
        name = decodeURIComponent(m[1]);
      } catch {
        name = m[1];
      }
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  },
};

/** 파일을 base64 글자로 읽기 (서식 보관함 업로드용) */
export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
    r.readAsDataURL(file);
  });
}

/** 파일을 글자로 읽기 (CSV 가져오기용). 한국어 엑셀 CSV(EUC-KR)도 자동 판별 */
export async function readFileAsText(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('euc-kr').decode(bytes);
  }
}
