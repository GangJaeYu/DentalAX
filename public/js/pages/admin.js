/*
 * 이 파일이 하는 일: [H. 관리] 화면 — 병원 정보, 사용자·권한, AI 설정, AI 사용량, 백업·복원, 활동 기록, 시스템·초기화
 *
 *   #/admin/clinic   병원 정보 (AI 문구·인쇄 머리글에 쓰임)
 *   #/admin/users    사용자·권한
 *   #/admin/ai       AI 설정 (공급자, API 키, 모델, 기능별 등급, 예산, 가격표)
 *   #/admin/usage    AI 사용량·비용 (실장도 볼 수 있음)
 *   #/admin/backup   백업·복원
 *   #/admin/audit    활동 기록
 *   #/admin/system   접속 주소, 보안 설정, 데모 데이터 초기화
 */
import { html, useState, useEffect, fmtDateTime, fmtNumber, fmtMoney, fmtBytes, fmtDate, toQuery, todayStr, cx } from '../lib.js';
import { api } from '../api.js';
import { navigate, setQuery } from '../router.js';
import { can, toast, confirmDialog, session, sessionStore } from '../store.js';
import { refreshClinic } from '../clinic.js';
import {
  PageHeader, Card, Button, Badge, Icon, Tabs, Seg, Modal, Field, Input, Textarea, Select, Checkbox, FormGrid,
  useApi, useForm, Loading, ErrorState, EmptyState, DataTable, Pagination, Menu, Callout, Stat, Avatar, refreshAiStatus,
} from '../ui/index.js';

const TABS = [
  { value: 'clinic', label: '병원 정보', icon: 'building-2', role: 'admin' },
  { value: 'users', label: '사용자·권한', icon: 'users', role: 'admin' },
  { value: 'ai', label: 'AI 설정', icon: 'sparkles', role: 'admin' },
  { value: 'usage', label: 'AI 사용량', icon: 'chart-column', role: 'manager' },
  { value: 'backup', label: '백업·복원', icon: 'database', role: 'admin' },
  { value: 'audit', label: '활동 기록', icon: 'history', role: 'admin' },
  { value: 'system', label: '시스템·초기화', icon: 'monitor', role: 'admin' },
];

// =============== 병원 정보 ===============
function ClinicTab() {
  const { data, loading, error, reload } = useApi('/admin/clinic');
  if (error) return html`<${ErrorState} error=${error} onRetry=${reload} />`;
  if (loading || !data) return html`<${Loading} />`;
  return html`<${ClinicForm} initial=${data} />`;
}

function ClinicForm({ initial }) {
  const f = useForm(initial);
  const save = f.submit(async (v) => {
    await api.put('/admin/clinic', v);
    await refreshClinic();
    sessionStore.set((s) => ({ ...s, clinicName: v.name }));
    toast.success('병원 정보를 저장했습니다.');
  });
  return html`<${Card} title="병원 기본 정보" sub="전화 응대 스크립트·안내문 AI와 인쇄 머리글에 쓰입니다." footer=${html`<${Button} variant="primary" loading=${f.busy} onClick=${save}>저장</${Button}>`}>
    <${FormGrid}>
      <${Field} label="병원 이름" required error=${f.errors.name}><${Input} ...${f.bind('name')} /></${Field}>
      <${Field} label="대표자(원장) 이름"><${Input} ...${f.bind('representative')} /></${Field}>
      <${Field} label="대표 전화" hint="병원 대표번호는 개인정보 필터에서 제외됩니다."><${Input} ...${f.bind('phone')} placeholder="02-000-0000" /></${Field}>
      <${Field} label="대표 이메일"><${Input} ...${f.bind('email')} /></${Field}>
      <${Field} label="주소" full><${Input} ...${f.bind('address')} /></${Field}>
      <${Field} label="진료 시간" full><${Textarea} rows=${3} ...${f.bind('hours')} /></${Field}>
      <${Field} label="주차 안내" full><${Textarea} rows=${2} ...${f.bind('parking')} /></${Field}>
      <${Field} label="오시는 길" full><${Textarea} rows=${2} ...${f.bind('directions')} /></${Field}>
      <${Field} label="보험 일반 안내" full hint="개별 환자 정보가 아닌 일반 안내만 적어 주세요."><${Textarea} rows=${3} ...${f.bind('insuranceNote')} /></${Field}>
      <${Field} label="기타 안내 (AI 참고용)" full hint="예: 예약 변경은 하루 전까지, 소아 진료 가능 여부 등"><${Textarea} rows=${3} ...${f.bind('extra')} /></${Field}>
    </${FormGrid}>
  </${Card}>`;
}

// =============== 사용자·권한 ===============
function randomPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  let s = '';
  const arr = new Uint32Array(8);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 5; i++) s += chars[arr[i] % chars.length];
  for (let i = 5; i < 8; i++) s += digits[arr[i] % digits.length];
  return s[0].toUpperCase() + s.slice(1) + '!';
}

function UserEditor({ user, meta, onClose, onSaved }) {
  const f = useForm(
    user
      ? { name: user.name, role: user.role, jobTitle: user.jobTitle, hireDate: user.hireDate || '', color: user.color || '', username: user.username || '', password: '', withLogin: user.hasLogin }
      : { name: '', role: 'staff', jobTitle: '치과위생사', hireDate: '', color: meta.colors[0], username: '', password: randomPassword(), withLogin: true }
  );
  const save = f.submit(async (v) => {
    const body = { name: v.name, role: v.role, jobTitle: v.jobTitle, hireDate: v.hireDate || null, color: v.color };
    if (v.withLogin) {
      body.username = v.username;
      if (v.password) body.password = v.password;
    } else body.username = null;
    const saved = user ? await api.patch(`/admin/users/${user.id}`, body) : await api.post('/admin/users', body);
    toast.success(user ? '저장했습니다.' : `${v.name}님을 추가했습니다.${v.withLogin ? ' 임시 비밀번호를 전달해 주세요.' : ''}`);
    onSaved(saved, v);
  });
  return html`<${Modal}
    open=${true}
    title=${user ? `${user.name} 수정` : '직원 추가'}
    onClose=${onClose}
    busy=${f.busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${f.busy} onClick=${save}>저장</${Button}>`}
  >
    <form class="stack" onSubmit=${save}>
      <${FormGrid}>
        <${Field} label="이름" required error=${f.errors.name}><${Input} ...${f.bind('name')} /></${Field}>
        <${Field} label="직종"><${Select} ...${f.bind('jobTitle')} options=${meta.jobs} /></${Field}>
        <${Field} label="권한" hint="원장·관리자: 전체 / 실장: 업무 관리·승인 / 직원: 기본 업무"><${Select} ...${f.bind('role')} options=${meta.roles} /></${Field}>
        <${Field} label="입사일" hint="연차 자동 계산에 쓰입니다."><${Input} type="date" ...${f.bind('hireDate')} /></${Field}>
        <${Field} label="근무표 색" full>
          <div class="row wrap">
            ${meta.colors.map(
              (c) => html`<button type="button" class="btn btn-icon btn-sm" aria-label=${`색 ${c}`} aria-pressed=${f.values.color === c ? 'true' : 'false'} onClick=${() => f.set('color', c)} style=${{ background: c, borderColor: f.values.color === c ? 'var(--text)' : c, outline: f.values.color === c ? '2px solid var(--text)' : 'none' }}></button>`
            )}
          </div>
        </${Field}>
      </${FormGrid}>
      <hr class="divider" />
      <${Checkbox} label="로그인 계정 만들기 (이 직원이 직접 접속해서 사용)" ...${f.bind('withLogin', { type: 'checkbox' })} />
      ${f.values.withLogin
        ? html`<${FormGrid}>
            <${Field} label="아이디" required error=${f.errors.username}><${Input} ...${f.bind('username')} autocapitalize="off" spellcheck="false" /></${Field}>
            <${Field} label=${user && user.hasLogin ? '새 임시 비밀번호 (바꿀 때만)' : '임시 비밀번호'} error=${f.errors.password} hint="첫 로그인 때 본인이 바꾸게 됩니다.">
              <div class="row"><${Input} ...${f.bind('password')} /><${Button} size="sm" onClick=${() => f.set('password', randomPassword())}>생성</${Button}></div>
            </${Field}>
          </${FormGrid}>`
        : html`<p class="small muted">로그인 계정이 없는 직원은 근무표·연차·교육 기록에만 이름이 나옵니다.</p>`}
    </form>
  </${Modal}>`;
}

function UsersTab() {
  const { data, loading, error, reload } = useApi('/admin/users');
  const [editing, setEditing] = useState(null); // null | 'new' | user
  const [created, setCreated] = useState(null);
  const me = session.user;

  const resetPw = async (u) => {
    const pw = randomPassword();
    if (!(await confirmDialog({ title: `${u.name}님 비밀번호 초기화`, message: `임시 비밀번호를 ${pw} 로 바꿉니다.\n이 직원의 기존 로그인은 모두 끊어지고, 다음 로그인 때 비밀번호를 새로 정하게 됩니다.`, confirmText: '초기화' }))) return;
    try {
      await api.post(`/admin/users/${u.id}/reset-password`, { password: pw });
      setCreated({ name: u.name, username: u.username, password: pw });
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const toggleActive = async (u) => {
    const deactivate = u.status === 'active';
    if (deactivate && !(await confirmDialog({ title: `${u.name}님을 비활성화할까요?`, message: '퇴사 등으로 더 이상 쓰지 않는 계정을 비활성화합니다. 기록은 남고, 로그인은 즉시 막힙니다.', danger: true, confirmText: '비활성화' }))) return;
    try {
      await api.patch(`/admin/users/${u.id}`, { status: deactivate ? 'inactive' : 'active' });
      toast.success(deactivate ? '비활성화했습니다.' : '다시 활성화했습니다.');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const unlock = async (u) => {
    await api.post(`/admin/users/${u.id}/unlock`);
    toast.success('잠금을 풀었습니다.');
    reload();
  };

  return html`
    <${Card}
      title="사용자·권한"
      sub=${data ? `${data.users.filter((u) => u.status === 'active').length}명 사용 중` : ''}
      flush
      actions=${html`<${Button} variant="primary" icon="user-plus" size="sm" onClick=${() => setEditing('new')}>직원 추가</${Button}>`}
    >
      <${DataTable}
        loading=${loading}
        error=${error}
        onRetry=${reload}
        rows=${data && data.users}
        rowClass=${(u) => (u.status === 'inactive' ? 'muted' : '')}
        columns=${[
          { key: 'name', label: '이름', render: (u) => html`<div class="row"><${Avatar} name=${u.name} color=${u.color} size="sm" /><span class="strong">${u.name}</span>${u.id === me.id ? html`<${Badge} color="blue">나</${Badge}>` : null}${u.isDemo ? html`<${Badge}>데모</${Badge}>` : null}</div>` },
          { key: 'jobTitle', label: '직종' },
          { key: 'role', label: '권한', render: (u) => html`<${Badge} color=${u.role === 'admin' ? 'purple' : u.role === 'manager' ? 'blue' : 'gray'}>${u.roleLabel}</${Badge}>` },
          { key: 'username', label: '로그인', render: (u) => (u.hasLogin ? html`<span class="num">${u.username}</span>${u.locked ? html` <${Badge} color="red">잠김</${Badge}>` : ''}${u.mustChangePassword ? html` <${Badge} color="amber">비번 변경 대기</${Badge}>` : ''}` : html`<span class="muted small">계정 없음</span>`) },
          { key: 'hireDate', label: '입사일', render: (u) => (u.hireDate ? fmtDate(u.hireDate, { long: true, weekday: false }) : '') },
          { key: 'lastLoginAt', label: '최근 로그인', render: (u) => html`<span class="small muted">${u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : '-'}</span>` },
          { key: 'status', label: '상태', render: (u) => (u.status === 'active' ? html`<${Badge} color="green" dot>사용</${Badge}>` : html`<${Badge}>비활성</${Badge}>`) },
          {
            key: 'actions',
            label: '',
            class: 'actions',
            render: (u) => html`<${Menu} items=${[
              { label: '수정', icon: 'pencil', onClick: () => setEditing(u) },
              { label: '비밀번호 초기화', icon: 'key-round', onClick: () => resetPw(u), hidden: !u.hasLogin },
              { label: '잠금 해제', icon: 'lock', onClick: () => unlock(u), hidden: !u.locked },
              '-',
              { label: u.status === 'active' ? '비활성화 (퇴사)' : '다시 활성화', icon: 'circle-x', danger: u.status === 'active', onClick: () => toggleActive(u), hidden: u.id === me.id },
            ]} />`,
          },
        ]}
      />
    </${Card}>
    <${Callout} kind="info" class="mt-4">직원 정보는 업무에 꼭 필요한 최소한(이름, 직종, 권한, 입사일)만 저장합니다. 주민번호·연락처·주소는 저장하지 않습니다.</${Callout}>
    ${editing
      ? html`<${UserEditor}
          user=${editing === 'new' ? null : editing}
          meta=${data}
          onClose=${() => setEditing(null)}
          onSaved=${(saved, v) => {
            const isNew = editing === 'new';
            setEditing(null);
            reload();
            if ((isNew || v.password) && v.withLogin && v.password) setCreated({ name: v.name, username: v.username, password: v.password });
          }}
        />`
      : null}
    ${created
      ? html`<${Modal} open=${true} size="sm" title="임시 비밀번호" onClose=${() => setCreated(null)} footer=${html`<${Button} variant="primary" onClick=${() => setCreated(null)}>확인했습니다</${Button}>`}>
          <div class="stack">
            <p>${created.name}님에게 아래 정보를 직접 전달해 주세요. 이 창을 닫으면 다시 볼 수 없습니다.</p>
            <div class="card"><div class="card-body">
              <div class="row between"><span class="muted">아이디</span><strong class="num">${created.username}</strong></div>
              <div class="row between mt-2"><span class="muted">임시 비밀번호</span><strong class="num">${created.password}</strong></div>
            </div></div>
            <p class="small muted">첫 로그인 때 본인만 아는 비밀번호로 바꾸게 됩니다.</p>
          </div>
        </${Modal}>`
      : null}
  `;
}

// =============== AI 설정 ===============
function KeyRow({ p, info, provider, onChanged }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(null);
  const saveKey = async () => {
    setBusy(true);
    try {
      await api.put('/admin/ai/key', { provider: p, key: key.trim() });
      setKey('');
      toast.success('API 키를 저장했습니다. (서버에 암호화되어 저장됨)');
      onChanged();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!(await confirmDialog({ title: `${provider.label} 키를 삭제할까요?`, danger: true, confirmText: '삭제' }))) return;
    await api.del(`/admin/ai/key/${p}`);
    toast.success('키를 삭제했습니다.');
    onChanged();
  };
  const runTest = async () => {
    setTest({ busy: true });
    try {
      const r = await api.post('/admin/ai/test', { provider: p });
      setTest({ ok: true, msg: `연결 성공 (${r.model}, ${(r.durationMs / 1000).toFixed(1)}초) — 답변: "${r.reply}"` });
    } catch (e) {
      setTest({ ok: false, msg: e.message });
    }
  };
  return html`<div class="stack sm" style=${{ padding: '14px 0', borderTop: '1px solid var(--border)' }}>
    <div class="row wrap">
      <strong class="grow">${provider.label}</strong>
      ${info.saved
        ? info.readable
          ? html`<${Badge} color="green" dot>저장됨 ····${info.hint}</${Badge}>`
          : html`<${Badge} color="red" title="다른 PC에서 복원한 경우 등">읽을 수 없음 — 다시 입력하세요</${Badge}>`
        : html`<${Badge}>키 없음</${Badge}>`}
      <a class="small" href=${provider.keyUrl} target="_blank" rel="noopener noreferrer">키 발급 페이지 <${Icon} name="external-link" size=${12} /></a>
    </div>
    <div class="row wrap">
      <${Input} type="password" class="grow" style=${{ maxWidth: '420px' }} value=${key} onInput=${(e) => setKey(e.target.value)} placeholder=${info.saved ? '새 키로 바꾸려면 입력' : 'API 키 붙여넣기'} autocomplete="off" aria-label=${`${provider.label} API 키`} />
      <${Button} size="sm" variant="primary" disabled=${key.trim().length < 10} loading=${busy} onClick=${saveKey}>저장</${Button}>
      ${info.saved ? html`<${Button} size="sm" onClick=${runTest} loading=${test && test.busy}>연결 테스트</${Button}><${Button} size="sm" variant="danger" onClick=${del}>삭제</${Button}>` : null}
    </div>
    ${test && !test.busy ? html`<${Callout} kind=${test.ok ? 'success' : 'danger'}>${test.msg}</${Callout}>` : null}
  </div>`;
}

function AiTab() {
  const { data, loading, error, reload, setData } = useApi('/admin/ai');
  if (error) return html`<${ErrorState} error=${error} onRetry=${reload} />`;
  if (loading && !data) return html`<${Loading} />`;
  return html`<${AiForm} data=${data} reload=${reload} setData=${setData} key=${data.settings.pricesCheckedAt + data.settings.prices.length} />`;
}

function AiForm({ data, reload, setData }) {
  const [s, setS] = useState(data.settings);
  const [busy, setBusy] = useState(false);
  const upd = (patch) => setS((x) => ({ ...x, ...patch }));
  const updModel = (p, tier, val) => setS((x) => ({ ...x, models: { ...x.models, [p]: { ...x.models[p], [tier]: val } } }));
  const updPrice = (i, patch) => setS((x) => ({ ...x, prices: x.prices.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        ...s,
        monthlyBudgetKrw: Number(s.monthlyBudgetKrw) || 0,
        exchangeRate: Number(s.exchangeRate),
        timeoutSec: Number(s.timeoutSec),
        warnRatio: Number(s.warnRatio) || 0.8,
        prices: s.prices.map((p) => ({ ...p, input: Number(p.input), output: Number(p.output), cached: Number(p.cached) || 0 })),
      };
      const r = await api.put('/admin/ai', body);
      setData(r);
      refreshAiStatus();
      toast.success('AI 설정을 저장했습니다.');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const resetPrices = async () => {
    if (!(await confirmDialog({ title: '가격표를 기본값으로 되돌릴까요?', message: `기본값은 ${data.settings.pricesCheckedAt || ''} 기준 공식 가격입니다.` }))) return;
    const r = await api.post('/admin/ai/reset-prices');
    setData(r);
    toast.success('가격표를 되돌렸습니다.');
  };

  const providerKeys = Object.keys(data.providers).filter((p) => p !== 'demo');
  const modelOptions = (p) => s.prices.filter((x) => x.provider === p).map((x) => x.model);
  const b = data.budget;

  return html`<div class="stack lg">
    <${Callout} kind="info" title="API 키는 이 서버에만 암호화되어 저장됩니다.">브라우저(직원 PC)로는 절대 전송되지 않습니다. 키 발급 방법은 docs/LLM_GUIDE.md 를 참고하세요.</${Callout}>

    <${Card} title="AI 공급자" sub="어느 회사의 AI를 쓸지 고릅니다. 키가 없으면 자동으로 데모 모드로 동작합니다.">
      <div class="grid grid-4">
        ${Object.entries(data.providers).map(
          ([p, info]) => html`<button type="button" class=${cx('card interactive')} style=${{ textAlign: 'left', padding: '14px', borderColor: s.provider === p ? 'var(--accent)' : undefined, boxShadow: s.provider === p ? 'var(--focus)' : undefined, background: 'var(--surface)', cursor: 'pointer' }} aria-pressed=${s.provider === p ? 'true' : 'false'} onClick=${() => upd({ provider: p })}>
            <div class="row between"><strong>${info.label}</strong>${s.provider === p ? html`<${Icon} name="circle-check" size=${16} class="success-text" />` : null}</div>
            <div class="small muted mt-1">${p === 'demo' ? '비용 없음 · 예시 응답' : data.keys[p]?.saved ? (data.keys[p].readable ? '키 저장됨' : '키 다시 입력 필요') : '키 필요'}</div>
          </button>`
        )}
      </div>
      ${s.provider !== 'demo' && !data.keys[s.provider]?.readable ? html`<${Callout} kind="warn" class="mt-3">${data.providers[s.provider].label} 키가 없어 지금은 데모 모드로 동작합니다. 아래에서 키를 저장하세요.</${Callout}>` : null}
    </${Card}>

    <${Card} title="API 키">
      ${providerKeys.map((p) => html`<${KeyRow} p=${p} info=${data.keys[p]} provider=${data.providers[p]} onChanged=${reload} />`)}
    </${Card}>

    <${Card} title="예산과 비용" sub=${`이번 달 사용 ${fmtMoney(b.usedKrw)}${b.limitKrw ? ` / 예산 ${fmtMoney(b.limitKrw)}` : ''}`}>
      <${FormGrid}>
        <${Field} label="월 예산 (원)" hint="0이면 한도 없음. 매월 1일에 새로 계산됩니다.">
          <${Input} type="number" min="0" step="1000" value=${s.monthlyBudgetKrw} onInput=${(e) => upd({ monthlyBudgetKrw: e.target.value })} />
        </${Field}>
        <${Field} label="예산을 넘으면">
          <${Seg} value=${s.budgetAction} onChange=${(v) => upd({ budgetAction: v })} items=${[{ value: 'block', label: 'AI 사용 차단' }, { value: 'warn', label: '경고만 표시' }]} />
        </${Field}>
        <${Field} label="환율 (1달러 = 원)" hint="비용 계산용. 가격은 달러로 매겨집니다.">
          <${Input} type="number" min="100" step="1" value=${s.exchangeRate} onInput=${(e) => upd({ exchangeRate: e.target.value })} />
        </${Field}>
        <${Field} label="응답 대기 시간 (초)" hint="이 시간이 지나면 중단하고 안내합니다.">
          <${Input} type="number" min="10" max="300" value=${s.timeoutSec} onInput=${(e) => upd({ timeoutSec: e.target.value })} />
        </${Field}>
        <${Field} label="개인정보가 감지되면" full hint="주민등록번호·카드번호는 어느 쪽이든 항상 차단합니다.">
          <${Seg} value=${s.piiMode} onChange=${(v) => upd({ piiMode: v })} items=${[{ value: 'mask', label: '가리고 보내기 (권장)' }, { value: 'block', label: '모두 차단' }]} />
        </${Field}>
      </${FormGrid}>
    </${Card}>

    <${Card} title="모델" sub="빠른 모델: 짧은 문구·분류 / 상위 모델: 긴 문서·요약·근거 답변">
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>공급자</th><th>빠른 모델 (fast)</th><th>상위 모델 (smart)</th></tr></thead>
          <tbody>
            ${providerKeys.map(
              (p) => html`<tr>
                <td class="strong">${data.providers[p].label}</td>
                ${['fast', 'smart'].map(
                  (t) => html`<td>
                    <${Input} size="sm" value=${s.models[p][t]} list=${`models-${p}`} onInput=${(e) => updModel(p, t, e.target.value)} aria-label=${`${p} ${t} 모델`} />
                  </td>`
                )}
              </tr>`
            )}
          </tbody>
        </table>
        ${providerKeys.map((p) => html`<datalist id=${`models-${p}`}>${modelOptions(p).map((m) => html`<option value=${m} />`)}</datalist>`)}
      </div>
      ${s.provider === 'openai'
        ? html`<${FormGrid} class="mt-4">
            <${Field} label="OpenAI 생각 정도 (reasoning effort)" hint="low 권장: 빠르고 저렴">
              <${Select} value=${s.openaiReasoningEffort} onChange=${(e) => upd({ openaiReasoningEffort: e.target.value })} options=${['none', 'minimal', 'low', 'medium', 'high']} />
            </${Field}>
            <${Field} label="OpenAI 호환 서버 주소 (선택)" hint="원내 AI 서버 등 OpenAI 호환 API를 쓸 때만. 비워 두면 OpenAI 공식.">
              <${Input} value=${s.openaiBaseUrl} onInput=${(e) => upd({ openaiBaseUrl: e.target.value })} placeholder="http://192.168.0.20:11434/v1" />
            </${Field}>
          </${FormGrid}>`
        : null}
    </${Card}>

    <${Card} title="기능별 모델 등급" sub="간단한 일은 빠른 모델로 두면 비용이 크게 줄어듭니다." flush>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>기능</th><th>분류</th><th>기본</th><th>사용할 등급</th></tr></thead>
        <tbody>
          ${data.features.map(
            (f) => html`<tr>
              <td>${f.label}</td>
              <td class="muted">${f.group}</td>
              <td class="muted small">${f.defaultTier === 'smart' ? '상위' : '빠른'}</td>
              <td>
                <${Seg}
                  value=${s.featureTiers[f.key] || f.defaultTier}
                  onChange=${(v) => upd({ featureTiers: { ...s.featureTiers, [f.key]: v } })}
                  items=${[{ value: 'fast', label: '빠른' }, { value: 'smart', label: '상위' }]}
                />
              </td>
            </tr>`
          )}
        </tbody>
      </table></div>
    </${Card}>

    <${Card}
      title="가격표 (1백만 토큰당 USD)"
      sub=${`기본값 확인일: ${data.settings.pricesCheckedAt || '-'} · 공식 가격이 바뀌면 여기서 고치세요.`}
      flush
      actions=${html`<${Button} size="sm" icon="plus" onClick=${() => upd({ prices: [...s.prices, { provider: 'anthropic', model: '', label: '', input: 0, output: 0, cached: 0 }] })}>행 추가</${Button}><${Button} size="sm" variant="ghost" icon="rotate-ccw" onClick=${resetPrices}>기본값으로</${Button}>`}
    >
      <div class="table-wrap"><table class="table table-compact">
        <thead><tr><th>공급자</th><th>모델 이름 (API)</th><th>입력</th><th>출력</th><th>캐시 입력</th><th></th></tr></thead>
        <tbody>
          ${s.prices.map(
            (r, i) => html`<tr>
              <td><${Select} size="sm" value=${r.provider} onChange=${(e) => updPrice(i, { provider: e.target.value })} options=${providerKeys} /></td>
              <td><${Input} size="sm" value=${r.model} onInput=${(e) => updPrice(i, { model: e.target.value })} /></td>
              <td><${Input} size="sm" type="number" step="0.01" min="0" value=${r.input} onInput=${(e) => updPrice(i, { input: e.target.value })} style=${{ width: '90px' }} /></td>
              <td><${Input} size="sm" type="number" step="0.01" min="0" value=${r.output} onInput=${(e) => updPrice(i, { output: e.target.value })} style=${{ width: '90px' }} /></td>
              <td><${Input} size="sm" type="number" step="0.001" min="0" value=${r.cached} onInput=${(e) => updPrice(i, { cached: e.target.value })} style=${{ width: '90px' }} /></td>
              <td class="actions"><${Button} size="sm" variant="ghost" icon="trash-2" aria-label="행 삭제" onClick=${() => upd({ prices: s.prices.filter((_, j) => j !== i) })} /></td>
            </tr>`
          )}
        </tbody>
      </table></div>
    </${Card}>

    <div class="row end" style=${{ position: 'sticky', bottom: '12px' }}>
      <${Button} variant="primary" size="lg" icon="save" loading=${busy} onClick=${save}>AI 설정 저장</${Button}>
    </div>
  </div>`;
}

// =============== AI 사용량 ===============
const STATUS_LABEL = { ok: ['성공', 'green'], error: ['오류', 'red'], blocked_pii: ['개인정보 차단', 'amber'], blocked_budget: ['예산 차단', 'red'], demo: ['데모', 'gray'] };

function DayBars({ days, month }) {
  const [y, m] = month.split('-').map(Number);
  const n = new Date(y, m, 0).getDate();
  const map = Object.fromEntries(days.map((d) => [d.day, d]));
  const all = Array.from({ length: n }, (_, i) => {
    const day = `${month}-${String(i + 1).padStart(2, '0')}`;
    return { day, calls: map[day]?.calls || 0, costKrw: map[day]?.costKrw || 0 };
  });
  const max = Math.max(1, ...all.map((d) => d.calls));
  return html`<div style=${{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '120px', padding: '8px 0' }} role="img" aria-label="일별 AI 호출 수 막대그래프">
    ${all.map(
      (d) => html`<div title=${`${d.day}: ${d.calls}회, ${fmtMoney(d.costKrw)}`} style=${{ flex: 1, minWidth: '4px', height: `${Math.max(2, (d.calls / max) * 100)}%`, background: d.calls ? 'var(--accent)' : 'var(--surface-active)', borderRadius: '3px 3px 0 0', opacity: d.calls ? 0.85 : 1 }}></div>`
    )}
  </div>
  <div class="row between small muted"><span>1일</span><span>${n}일</span></div>`;
}

function UsageTab({ route }) {
  const month = route.query.month || todayStr().slice(0, 7);
  const { data, loading, error, reload } = useApi(`/admin/usage?month=${month}`);
  if (error) return html`<${ErrorState} error=${error} onRetry=${reload} />`;
  if (loading && !data) return html`<${Loading} />`;
  const t = data.total;
  const b = data.budget;
  return html`<div class="stack lg">
    <div class="row wrap">
      <${Input} type="month" value=${month} onInput=${(e) => e.target.value && setQuery({ month: e.target.value })} style=${{ width: '180px' }} aria-label="월 선택" />
      <span class="muted small">원 단위 비용은 설정한 환율로 계산한 예상값입니다. 실제 청구액은 각 회사 사이트에서 확인하세요.</span>
    </div>
    <div class="stats">
      <${Stat} label="예상 비용" icon="wallet" value=${fmtNumber(Math.round(t.costKrw))} unit="원" hint=${`$${t.costUsd.toFixed(3)}${b.limitKrw && month === todayStr().slice(0, 7) ? ` · 예산의 ${Math.round(b.ratio * 100)}%` : ''}`} color=${b.over ? 'danger' : b.warn ? 'warning' : ''} />
      <${Stat} label="AI 호출" icon="sparkles" value=${fmtNumber(t.calls)} unit="회" hint=${`성공 ${t.ok} · 데모 ${t.demo} · 오류 ${t.errors}`} />
      <${Stat} label="사용 토큰" icon="activity" value=${fmtNumber(t.inputTokens + t.outputTokens)} hint=${`입력 ${fmtNumber(t.inputTokens)} · 출력 ${fmtNumber(t.outputTokens)}`} />
      <${Stat} label="개인정보 차단" icon="shield-check" value=${fmtNumber(t.blockedPii)} unit="회" hint=${`예산 차단 ${t.blockedBudget}회`} />
    </div>
    ${b.limitKrw && month === todayStr().slice(0, 7)
      ? html`<${Card} title="이번 달 예산">
          <div class="row between small"><span>${fmtMoney(b.usedKrw)} 사용</span><span class="muted">예산 ${fmtMoney(b.limitKrw)}</span></div>
          <div class="mt-2"><div class=${cx('progress', b.over ? 'red' : b.warn ? 'amber' : 'green')}><span style=${{ width: Math.min(100, b.ratio * 100) + '%' }}></span></div></div>
        </${Card}>`
      : null}
    <${Card} title="일별 호출 수"><${DayBars} days=${data.byDay} month=${month} /></${Card}>
    <div class="grid grid-2">
      <${Card} title="기능별" flush>
        <${DataTable} rows=${data.byFeature} rowKey="feature" empty=${{ title: '이 달 사용 기록이 없습니다' }} columns=${[
          { key: 'label', label: '기능' },
          { key: 'calls', label: '호출', align: 'right', render: (r) => fmtNumber(r.calls) },
          { key: 'tokens', label: '토큰', align: 'right', render: (r) => fmtNumber(r.tokens) },
          { key: 'costKrw', label: '비용', align: 'right', render: (r) => fmtMoney(r.costKrw) },
        ]} />
      </${Card}>
      <${Card} title="사용자별" flush>
        <${DataTable} rows=${data.byUser} rowKey="user" empty=${{ title: '이 달 사용 기록이 없습니다' }} columns=${[
          { key: 'user', label: '사용자' },
          { key: 'calls', label: '호출', align: 'right', render: (r) => fmtNumber(r.calls) },
          { key: 'costKrw', label: '비용', align: 'right', render: (r) => fmtMoney(r.costKrw) },
        ]} />
      </${Card}>
    </div>
    <${Card} title="최근 호출 50건" sub="글 내용은 저장하지 않고, 기능·토큰·비용만 기록합니다." flush>
      <${DataTable} rows=${data.recent} rowKey="at" compact empty=${{ title: '기록이 없습니다' }} columns=${[
        { key: 'at', label: '시각', render: (r) => html`<span class="num small">${fmtDateTime(r.at)}</span>` },
        { key: 'user', label: '사용자' },
        { key: 'feature', label: '기능' },
        { key: 'model', label: '모델', render: (r) => html`<span class="small muted">${r.model || '-'}</span>` },
        { key: 'tokens', label: '토큰(입/출)', align: 'right', render: (r) => html`<span class="num small">${fmtNumber(r.inputTokens)} / ${fmtNumber(r.outputTokens)}</span>` },
        { key: 'costKrw', label: '비용', align: 'right', render: (r) => html`<span class="num">${r.costKrw ? fmtMoney(r.costKrw) : '-'}</span>` },
        { key: 'status', label: '결과', render: (r) => html`<${Badge} color=${(STATUS_LABEL[r.status] || [])[1]} title=${r.error || r.piiTypes || ''}>${(STATUS_LABEL[r.status] || [r.status])[0]}</${Badge}>` },
      ]} />
    </${Card}>
  </div>`;
}

// =============== 백업·복원 ===============
function BackupTab() {
  const { data, loading, error, reload } = useApi('/admin/backups');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(null);
  useEffect(() => {
    if (data) setSettings(data.settings);
  }, [data]);

  const backupNow = async () => {
    setBusy(true);
    try {
      const b = await api.post('/admin/backups');
      toast.success(`백업했습니다: ${b.name}`);
      reload();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const restore = async (b) => {
    const ok = await confirmDialog({
      title: '이 백업으로 복원할까요?',
      message: `${fmtDateTime(b.createdAt)} (${b.reasonLabel}) 상태로 모든 데이터를 되돌립니다.\n지금 상태는 "복원 전" 백업으로 자동 저장되므로 다시 되돌릴 수 있습니다.\n복원 후에는 다시 로그인해야 할 수 있습니다.`,
      danger: true,
      confirmText: '복원',
      typeToConfirm: '복원',
    });
    if (!ok) return;
    try {
      await api.post(`/admin/backups/${encodeURIComponent(b.name)}/restore`);
      toast.success('복원했습니다. 화면을 새로 불러옵니다.');
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      toast.error(e.message);
    }
  };
  const uploadRestore = async (file) => {
    if (!file) return;
    const ok = await confirmDialog({
      title: `"${file.name}" 파일로 복원할까요?`,
      message: '다른 PC에서 가져온 백업 파일로 모든 데이터를 바꿉니다. 지금 상태는 "복원 전" 백업으로 저장됩니다.\nAPI 키는 PC마다 따로 암호화되므로 복원 후 다시 입력해야 합니다.',
      danger: true,
      confirmText: '복원',
      typeToConfirm: '복원',
    });
    if (!ok) return;
    try {
      await api.upload('/admin/backups/upload', file);
      toast.success('복원했습니다. 화면을 새로 불러옵니다.');
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      toast.error(e.message);
    }
  };
  const saveSettings = async () => {
    try {
      await api.put('/admin/backups/settings', { keep: Number(settings.keep), hour: Number(settings.hour), minute: Number(settings.minute) });
      toast.success('백업 설정을 저장했습니다.');
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (error) return html`<${ErrorState} error=${error} onRetry=${reload} />`;
  if (loading && !data) return html`<${Loading} />`;
  return html`<div class="stack lg">
    <${Callout} kind="info" title="백업 = 파일 하나">
      백업 파일은 서버 PC의 <code>${data.dir}</code> 폴더에 쌓입니다. PC 고장에 대비해 <strong>일주일에 한 번은 USB나 다른 PC로 복사</strong>해 두세요. (아래 목록에서 [내려받기])
    </${Callout}>
    <${Card} title="자동 백업 설정" footer=${html`<${Button} variant="primary" onClick=${saveSettings}>저장</${Button}>`}>
      ${settings
        ? html`<div class="row wrap">
            <span>매일</span>
            <${Input} type="number" min="0" max="23" value=${settings.hour} onInput=${(e) => setSettings({ ...settings, hour: e.target.value })} style=${{ width: '80px' }} aria-label="시" /><span>시</span>
            <${Input} type="number" min="0" max="59" value=${settings.minute} onInput=${(e) => setSettings({ ...settings, minute: e.target.value })} style=${{ width: '80px' }} aria-label="분" /><span>분 이후 하루 한 번,</span>
            <${Input} type="number" min="3" max="365" value=${settings.keep} onInput=${(e) => setSettings({ ...settings, keep: e.target.value })} style=${{ width: '80px' }} aria-label="보관 개수" /><span>개 보관</span>
          </div>
          <p class="small muted mt-2">서버 PC가 켜져 있는 동안 정해진 시각이 지나면 자동으로 백업합니다. PC를 늦게 켜도 켜진 뒤에 백업합니다.</p>`
        : null}
    </${Card}>
    <${Card}
      title="백업 목록"
      sub=${`${data.backups.length}개`}
      flush
      actions=${html`
        <label class="btn btn-sm"><${Icon} name="upload" size=${14} />파일로 복원<input type="file" accept=".db" class="sr-only" onChange=${(e) => {
          uploadRestore(e.target.files[0]);
          e.target.value = '';
        }} /></label>
        <${Button} size="sm" variant="primary" icon="database" loading=${busy} onClick=${backupNow}>지금 백업</${Button}>
      `}
    >
      <${DataTable}
        rows=${data.backups}
        rowKey="name"
        empty=${{ icon: 'database', title: '아직 백업이 없습니다', desc: '[지금 백업]을 누르거나 자동 백업 시각을 기다리세요.' }}
        columns=${[
          { key: 'createdAt', label: '만든 시각', render: (b) => html`<span class="num">${fmtDateTime(b.createdAt)}</span>` },
          { key: 'reasonLabel', label: '종류', render: (b) => html`<${Badge} color=${b.reason === 'auto' ? 'blue' : b.reason === 'prerestore' ? 'amber' : 'gray'}>${b.reasonLabel}</${Badge}>` },
          { key: 'size', label: '크기', align: 'right', render: (b) => fmtBytes(b.size) },
          { key: 'name', label: '파일 이름', render: (b) => html`<span class="small muted num">${b.name}</span>` },
          {
            key: 'a',
            label: '',
            class: 'actions',
            render: (b) => html`<div class="row end">
              <${Button} size="sm" icon="download" onClick=${() => api.download(`/admin/backups/${encodeURIComponent(b.name)}/download`, b.name).catch((e) => toast.error(e.message))}>내려받기</${Button}>
              <${Button} size="sm" variant="danger" icon="rotate-ccw" onClick=${() => restore(b)}>복원</${Button}>
            </div>`,
          },
        ]}
      />
    </${Card}>
  </div>`;
}

// =============== 활동 기록 ===============
const ACTION_LABEL = {
  login: '로그인', logout: '로그아웃', login_fail: '로그인 실패', create: '추가', update: '수정', delete: '삭제', setup: '첫 설정',
  backup: '백업', restore: '복원', reset: '초기화', seed: '데모 데이터', export: '내보내기', import: '가져오기', download: '내려받기',
  password_change: '비밀번호 변경', reset_password: '비밀번호 초기화', unlock: '잠금 해제', ai_test: 'AI 연결 테스트', approve: '승인', reject: '반려',
};

function AuditTab({ route }) {
  const q = route.query;
  const [search, setSearch] = useState(q.q || '');
  const params = { q: q.q, from: q.from, to: q.to, action: q.action, page: q.page };
  const { data, loading, error, reload } = useApi(`/admin/audit${toQuery(params)}`);
  useEffect(() => {
    const t = setTimeout(() => (q.q || '') !== search && setQuery({ q: search, page: '' }), 300);
    return () => clearTimeout(t);
  }, [search]);
  return html`<${Card}
    title="활동 기록"
    sub="누가 언제 무엇을 했는지 자동으로 남습니다."
    flush
    actions=${html`<${Button} size="sm" icon="download" onClick=${() => api.download(`/admin/audit.csv${toQuery({ q: q.q, from: q.from, to: q.to, action: q.action })}`, 'audit.csv').catch((e) => toast.error(e.message))}>CSV 내보내기</${Button}>`}
  >
    <div class="row wrap" style=${{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
      <${Input} type="search" value=${search} onInput=${(e) => setSearch(e.target.value)} placeholder="내용·사용자 검색" style=${{ maxWidth: '240px' }} aria-label="검색" />
      <${Select} value=${q.action || ''} onChange=${(e) => setQuery({ action: e.target.value, page: '' })} placeholder="모든 동작" options=${(data?.actions || []).map((a) => ({ value: a, label: ACTION_LABEL[a] || a }))} style=${{ width: '150px' }} aria-label="동작" />
      <${Input} type="date" value=${q.from || ''} onInput=${(e) => setQuery({ from: e.target.value, page: '' })} style=${{ width: '160px' }} aria-label="시작일" />
      <span class="muted">~</span>
      <${Input} type="date" value=${q.to || ''} onInput=${(e) => setQuery({ to: e.target.value, page: '' })} style=${{ width: '160px' }} aria-label="종료일" />
    </div>
    <${DataTable}
      rows=${data?.rows}
      loading=${loading}
      error=${error}
      onRetry=${reload}
      compact
      empty=${{ icon: 'history', title: '기록이 없습니다' }}
      columns=${[
        { key: 'at', label: '시각', render: (r) => html`<span class="num small nowrap">${fmtDateTime(r.at)}</span>` },
        { key: 'user_name', label: '사용자', render: (r) => r.user_name || '-' },
        { key: 'action', label: '동작', render: (r) => html`<${Badge} color=${r.action === 'delete' || r.action === 'login_fail' || r.action === 'reset' ? 'red' : r.action === 'create' ? 'green' : 'gray'}>${ACTION_LABEL[r.action] || r.action}</${Badge}>` },
        { key: 'summary', label: '내용' },
        { key: 'ip', label: 'IP', render: (r) => html`<span class="small muted num">${r.ip || ''}</span>` },
      ]}
    />
    ${data ? html`<${Pagination} page=${data.page} size=${data.size} total=${data.total} onChange=${(p) => setQuery({ page: p })} />` : null}
  </${Card}>`;
}

// =============== 시스템·초기화 ===============
function SystemTab() {
  const { data, loading, error, reload } = useApi('/admin/system');
  const sec = useApi('/admin/security');
  const [secVals, setSecVals] = useState(null);
  useEffect(() => sec.data && setSecVals(sec.data), [sec.data]);

  const reset = async () => {
    const ok = await confirmDialog({
      title: '업무 데이터를 모두 지울까요?',
      message: '공지, 체크리스트, 재고, 거래처, 문서, 근무표, 연차, 장비, 멸균 기록, 지출, AI 도우미 문서 등 모든 업무 데이터와 데모 직원을 지웁니다.\n로그인 계정, 병원 정보, AI 설정·키, 활동 기록은 남습니다.\n지우기 직전 상태는 자동으로 백업됩니다.',
      danger: true,
      confirmText: '모두 지우기',
      typeToConfirm: '초기화',
    });
    if (!ok) return;
    try {
      const r = await api.post('/admin/reset', { confirm: '초기화' });
      toast.success(`초기화했습니다. (지우기 전 백업: ${r.backup})`);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const seed = async () => {
    if (!(await confirmDialog({ title: '데모 예시 데이터를 넣을까요?', message: '지금 업무 데이터를 비우고(직전 상태는 자동 백업) 가상의 직원과 예시 데이터를 넣습니다. 실제 사용 중이라면 넣지 마세요.' }))) return;
    try {
      await api.post('/admin/seed-demo');
      toast.success('데모 데이터를 넣었습니다.');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const saveSec = async () => {
    try {
      await api.put('/admin/security', { idleMinutes: Number(secVals.idleMinutes), absoluteHours: Number(secVals.absoluteHours) });
      toast.success('저장했습니다.');
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (error) return html`<${ErrorState} error=${error} onRetry=${reload} />`;
  if (loading && !data) return html`<${Loading} />`;
  return html`<div class="stack lg">
    <${Card} title="직원 PC·태블릿 접속 주소" icon="monitor">
      <div class="stack sm">
        ${data.addresses.length
          ? data.addresses.map((a) => html`<div class="row"><code class="num" style=${{ fontSize: '15px' }}>${a}</code></div>`)
          : html`<p class="muted">네트워크 주소를 찾지 못했습니다. 서버 PC가 공유기에 연결되어 있는지 확인하세요.</p>`}
        <p class="small muted">같은 와이파이(공유기)에 연결된 기기의 브라우저 주소창에 위 주소를 입력하세요. 북마크(즐겨찾기)해 두면 편합니다.</p>
        ${data.allowExternal ? html`<${Callout} kind="danger">외부 접속 허용이 켜져 있습니다. 원내 전용으로 쓰려면 config.json 의 allowExternal 을 false로 바꾸세요.</${Callout}>` : html`<${Callout} kind="success">원내 네트워크에서만 접속할 수 있게 설정되어 있습니다.</${Callout}>`}
      </div>
    </${Card}>
    <${Card} title="자동 로그아웃" footer=${html`<${Button} variant="primary" onClick=${saveSec}>저장</${Button}>`}>
      ${secVals
        ? html`<div class="row wrap">
            <span>사용하지 않은 지</span><${Input} type="number" min="10" max="1440" value=${secVals.idleMinutes} onInput=${(e) => setSecVals({ ...secVals, idleMinutes: e.target.value })} style=${{ width: '90px' }} aria-label="분" /><span>분이 지나면 로그아웃,</span>
            <span>로그인 후 최대</span><${Input} type="number" min="1" max="72" value=${secVals.absoluteHours} onInput=${(e) => setSecVals({ ...secVals, absoluteHours: e.target.value })} style=${{ width: '80px' }} aria-label="시간" /><span>시간 유지</span>
          </div>`
        : html`<${Loading} />`}
    </${Card}>
    <${Card} title="시스템 정보">
      <div class="form-grid">
        <div><div class="label">버전</div><div class="mt-1">DentalAX ${data.version} · Node.js ${data.node}</div></div>
        <div><div class="label">데이터 파일</div><div class="mt-1 small num">${data.dbFile} (${fmtBytes(data.dbSize)})</div></div>
        <div><div class="label">사용자 / 활동 기록 / AI 호출</div><div class="mt-1">${fmtNumber(data.counts.users)}명 / ${fmtNumber(data.counts.auditLogs)}건 / ${fmtNumber(data.counts.aiCalls)}회</div></div>
        <div><div class="label">서버 켜진 시간</div><div class="mt-1">${Math.floor(data.uptimeSec / 3600)}시간 ${Math.floor((data.uptimeSec % 3600) / 60)}분</div></div>
      </div>
    </${Card}>
    <${Card} title="데모 데이터 초기화" icon="triangle-alert">
      <div class="stack">
        <p>${data.hasDemoData ? html`지금 <strong>데모(가상) 데이터</strong>가 들어 있습니다. 실제로 쓰기 전에 지워 주세요.` : '실제 사용을 시작했다면 이 버튼은 누르지 마세요.'}</p>
        <div class="row wrap">
          <${Button} variant="danger-solid" icon="trash-2" onClick=${reset}>업무 데이터 모두 지우기</${Button}>
          ${!data.hasDemoData ? html`<${Button} variant="ghost" onClick=${seed}>데모 데이터 다시 넣기</${Button}>` : null}
        </div>
      </div>
    </${Card}>
    <${Callout} kind="info">이 서비스는 업무 보조 도구이며 법률 자문을 대신하지 않습니다. 개인정보보호법·의료법(의료광고 등) 관련 판단은 전문가와 상의하세요.</${Callout}>
  </div>`;
}

export default function AdminPage({ route }) {
  const tabs = TABS.filter((t) => can(t.role));
  const tab = route.parts[1] && tabs.some((t) => t.value === route.parts[1]) ? route.parts[1] : tabs[0].value;
  const Comp = { clinic: ClinicTab, users: UsersTab, ai: AiTab, usage: UsageTab, backup: BackupTab, audit: AuditTab, system: SystemTab }[tab];
  return html`
    <${PageHeader} title="관리" desc=${can('admin') ? '사용자, AI, 백업 등 서비스 전체 설정' : 'AI 사용량과 비용을 확인합니다.'} />
    <${Tabs} items=${tabs} value=${tab} onChange=${(t) => navigate(`#/admin/${t}`)} />
    <${Comp} route=${route} key=${tab} />
  `;
}
