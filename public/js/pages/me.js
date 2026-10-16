/*
 * 이 파일이 하는 일: [내 정보] 화면 — 내 계정 정보 확인과 비밀번호 변경
 */
import { html } from '../lib.js';
import { api } from '../api.js';
import { session, toast } from '../store.js';
import { PageHeader, Card, Field, Input, Button, useForm, Badge } from '../ui/index.js';

export default function MePage() {
  const u = session.user;
  const f = useForm({ current: '', next: '', next2: '' });
  const save = f.submit(async (v) => {
    if (v.next !== v.next2) {
      f.setErrors({ next2: '새 비밀번호가 서로 다릅니다.' });
      return;
    }
    await api.post('/auth/password', { current: v.current, next: v.next });
    toast.success('비밀번호를 바꿨습니다. 다른 기기의 로그인은 끊어졌습니다.');
    f.reset();
  });
  return html`<div class="content narrow" style=${{ padding: 0 }}>
    <${PageHeader} title="내 정보" desc="계정 정보와 비밀번호를 관리합니다." />
    <div class="stack lg">
      <${Card} title="계정">
        <div class="form-grid">
          <div><div class="label">이름</div><div class="mt-1">${u.name}</div></div>
          <div><div class="label">아이디</div><div class="mt-1">${u.username}</div></div>
          <div><div class="label">권한</div><div class="mt-1"><${Badge} color="blue">${u.roleLabel}</${Badge}></div></div>
          <div><div class="label">직종</div><div class="mt-1">${u.jobTitle || '-'}</div></div>
        </div>
      </${Card}>
      <${Card} title="비밀번호 바꾸기">
        <form class="stack" onSubmit=${save} style=${{ maxWidth: '380px' }}>
          <${Field} label="현재 비밀번호" error=${f.errors.current}><${Input} type="password" ...${f.bind('current')} autocomplete="current-password" /></${Field}>
          <${Field} label="새 비밀번호" error=${f.errors.next} hint="8자 이상, 영문·숫자·기호 중 2가지 이상"><${Input} type="password" ...${f.bind('next')} autocomplete="new-password" /></${Field}>
          <${Field} label="새 비밀번호 확인" error=${f.errors.next2}><${Input} type="password" ...${f.bind('next2')} autocomplete="new-password" /></${Field}>
          <div><${Button} type="submit" variant="primary" loading=${f.busy}>비밀번호 바꾸기</${Button}></div>
        </form>
      </${Card}>
    </div>
  </div>`;
}
