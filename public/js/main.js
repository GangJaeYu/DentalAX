/*
 * 이 파일이 하는 일: 앱을 시작합니다.
 *   1) 서버에 지금 상태를 물어봄 (첫 설정이 필요한지, 로그인되어 있는지)
 *   2) 상태에 따라 첫 설정 / 로그인 / 비밀번호 변경 / 본 화면(Shell) 중 하나를 보여 줌
 *   3) 사용 중 로그인이 만료되면 자동으로 로그인 화면으로 돌아감
 */
import { html, render, useEffect } from './lib.js';
import { api, setCsrf, setUnauthorizedHandler } from './api.js';
import { sessionStore, useStore, toast } from './store.js';
import { Shell } from './shell.js';
import { SetupPage, LoginPage, ForcePasswordPage } from './pages/auth.js';
import { ConfirmHost, ToastHost, ErrorState } from './ui/index.js';
import { refreshClinic } from './clinic.js';
import { refreshAiStatus } from './ui/ai.js';

async function loadStatus() {
  const s = await api.get('/auth/status');
  setCsrf(s.csrfToken);
  sessionStore.set({ user: s.user, clinicName: s.clinicName, setupRequired: s.setupRequired, ready: true, error: null });
}

setUnauthorizedHandler((message) => {
  if (sessionStore.get().user) {
    sessionStore.set((s) => ({ ...s, user: null, expiredMessage: message }));
  }
});

function App() {
  const s = useStore(sessionStore);
  useEffect(() => {
    if (s.user) {
      refreshClinic();
      refreshAiStatus();
    }
  }, [s.user && s.user.id]);

  let body;
  if (s.error) body = html`<div class="auth-page"><div class="auth-card"><${ErrorState} error=${s.error} onRetry=${() => location.reload()} /></div></div>`;
  else if (!s.ready) body = html`<div class="loading-block boot"><span class="spinner"></span> 불러오는 중…</div>`;
  else if (s.setupRequired) body = html`<${SetupPage} />`;
  else if (!s.user) body = html`<${LoginPage} message=${s.expiredMessage} />`;
  else if (s.user.mustChangePassword) body = html`<${ForcePasswordPage} user=${s.user} />`;
  else body = html`<${Shell} />`;

  return html`${body}<${ConfirmHost} /><${ToastHost} />`;
}

render(html`<${App} />`, document.getElementById('app'));

loadStatus().catch((error) => {
  sessionStore.set((s) => ({ ...s, ready: true, error }));
  toast.error(error.message);
});
