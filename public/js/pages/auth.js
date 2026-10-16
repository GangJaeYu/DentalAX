/*
 * 이 파일이 하는 일: 로그인 전 화면 3가지
 *   SetupPage          : 처음 설치했을 때 관리자(원장) 계정과 병원 이름을 정하는 화면
 *   LoginPage          : 로그인 화면
 *   ForcePasswordPage  : 임시 비밀번호로 처음 로그인한 직원이 비밀번호를 바꾸는 화면
 */
import { html, useState } from '../lib.js';
import { api, setCsrf } from '../api.js';
import { sessionStore, toast } from '../store.js';
import { Button, Field, Input, Checkbox, Callout, useForm } from '../ui/index.js';

function Brand() {
  return html`<div class="auth-brand">
    <div class="brand-mark" aria-hidden="true">D</div>
    <div>
      <div class="brand-name">DentalAX</div>
      <div class="brand-sub">치과 원내 업무 도우미</div>
    </div>
  </div>`;
}

/** 비밀번호 규칙 안내 (입력하는 동안 바로 확인) */
function PasswordRule({ pw }) {
  const long = pw.length >= 8;
  const kinds = [/[a-zA-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length;
  return html`<div class="small ${long && kinds >= 2 ? 'success-text' : 'muted'}">
    <span>${long ? '✓' : '·'} 8자 이상</span>${'  '}<span style=${{ marginLeft: '10px' }}>${kinds >= 2 ? '✓' : '·'} 영문·숫자·기호 중 2가지 이상</span>
  </div>`;
}

export function SetupPage() {
  const f = useForm({ clinicName: '', name: '', username: '', password: '', password2: '', demo: true });
  const save = f.submit(async (v) => {
    if (v.password !== v.password2) {
      f.setErrors({ password2: '비밀번호가 서로 다릅니다.' });
      return;
    }
    const r = await api.post('/auth/setup', { clinicName: v.clinicName, name: v.name, username: v.username, password: v.password, demo: v.demo });
    setCsrf(r.csrfToken);
    toast.success('설정이 끝났습니다. 환영합니다!');
    sessionStore.set((s) => ({ ...s, user: r.user, setupRequired: false, clinicName: v.clinicName }));
  });
  return html`<div class="auth-page">
    <form class="auth-card wide" onSubmit=${save}>
      <${Brand} />
      <h1 class="auth-title">처음 설정</h1>
      <p class="auth-desc">이 서버의 관리자(원장님) 계정을 만듭니다. 관리자는 직원 계정 추가, AI 설정, 백업을 관리합니다.</p>
      <div class="stack">
        <${Field} label="병원 이름" required error=${f.errors.clinicName}>
          <${Input} ...${f.bind('clinicName')} placeholder="예: 하늘치과의원" autocomplete="organization" />
        </${Field}>
        <${Field} label="관리자 이름" required error=${f.errors.name}>
          <${Input} ...${f.bind('name')} placeholder="예: 김하늘" autocomplete="name" />
        </${Field}>
        <${Field} label="로그인 아이디" required error=${f.errors.username} hint="영문·숫자 3자 이상 (예: drkim)">
          <${Input} ...${f.bind('username')} autocomplete="username" autocapitalize="off" spellcheck="false" />
        </${Field}>
        <${Field} label="비밀번호" required error=${f.errors.password}>
          <${Input} type="password" ...${f.bind('password')} autocomplete="new-password" />
        </${Field}>
        <${PasswordRule} pw=${f.values.password} />
        <${Field} label="비밀번호 확인" required error=${f.errors.password2}>
          <${Input} type="password" ...${f.bind('password2')} autocomplete="new-password" />
        </${Field}>
        <${Checkbox} label="데모 예시 데이터 넣기 (가상의 치과 데이터로 둘러보기 — 나중에 관리 → 초기화에서 지울 수 있음)" ...${f.bind('demo', { type: 'checkbox' })} />
        <${Callout} kind="info">비밀번호를 잊으면 되찾을 수 없습니다. 안전한 곳에 따로 적어 두세요.</${Callout}>
        <${Button} type="submit" variant="primary" size="lg" block loading=${f.busy}>설정 완료하고 시작하기</${Button}>
      </div>
    </form>
  </div>`;
}

export function LoginPage({ message }) {
  const f = useForm({ username: '', password: '' });
  const [err, setErr] = useState(message || '');
  const save = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      const r = await api.post('/auth/login', f.values);
      setCsrf(r.csrfToken);
      sessionStore.set((s) => ({ ...s, user: r.user, expiredMessage: '' }));
    } catch (error) {
      setErr(error.message);
    }
  };
  const clinicName = sessionStore.get().clinicName;
  return html`<div class="auth-page">
    <form class="auth-card" onSubmit=${save}>
      <${Brand} />
      <h1 class="auth-title">${clinicName || '로그인'}</h1>
      <p class="auth-desc">아이디와 비밀번호를 입력해 주세요.</p>
      <div class="stack">
        ${err ? html`<${Callout} kind="danger">${err}</${Callout}>` : null}
        <${Field} label="아이디">
          <${Input} ...${f.bind('username')} autocomplete="username" autocapitalize="off" spellcheck="false" />
        </${Field}>
        <${Field} label="비밀번호">
          <${Input} type="password" ...${f.bind('password')} autocomplete="current-password" />
        </${Field}>
        <${Button} type="submit" variant="primary" size="lg" block>로그인</${Button}>
        <p class="small muted">비밀번호를 잊었다면 원장님(관리자)께 초기화를 요청하세요.</p>
      </div>
    </form>
  </div>`;
}

export function ForcePasswordPage({ user }) {
  const f = useForm({ current: '', next: '', next2: '' });
  const save = f.submit(async (v) => {
    if (v.next !== v.next2) {
      f.setErrors({ next2: '새 비밀번호가 서로 다릅니다.' });
      return;
    }
    await api.post('/auth/password', { current: v.current, next: v.next });
    toast.success('비밀번호를 바꿨습니다.');
    sessionStore.set((s) => ({ ...s, user: { ...user, mustChangePassword: false } }));
  });
  return html`<div class="auth-page">
    <form class="auth-card" onSubmit=${save}>
      <${Brand} />
      <h1 class="auth-title">비밀번호 바꾸기</h1>
      <p class="auth-desc">${user.name}님, 처음 로그인하셨습니다. 임시 비밀번호를 본인만 아는 비밀번호로 바꿔 주세요.</p>
      <div class="stack">
        <${Field} label="임시(현재) 비밀번호" error=${f.errors.current}>
          <${Input} type="password" ...${f.bind('current')} autocomplete="current-password" />
        </${Field}>
        <${Field} label="새 비밀번호" error=${f.errors.next}>
          <${Input} type="password" ...${f.bind('next')} autocomplete="new-password" />
        </${Field}>
        <${PasswordRule} pw=${f.values.next} />
        <${Field} label="새 비밀번호 확인" error=${f.errors.next2}>
          <${Input} type="password" ...${f.bind('next2')} autocomplete="new-password" />
        </${Field}>
        <${Button} type="submit" variant="primary" size="lg" block loading=${f.busy}>바꾸고 시작하기</${Button}>
        <${Button} variant="ghost" block onClick=${async () => {
          await api.post('/auth/logout').catch(() => {});
          sessionStore.set((s) => ({ ...s, user: null }));
        }}>로그아웃</${Button}>
      </div>
    </form>
  </div>`;
}
