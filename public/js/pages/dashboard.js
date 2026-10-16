/*
 * 이 파일이 하는 일: 첫 화면(대시보드) — 오늘 할 일, 재고 경고, 다가오는 점검·법정 일정, 공지, 오늘 근무자를 한눈에.
 * 데이터는 /api/dashboard 한 번으로 받아옵니다. (각 모듈이 보탠 요약을 서버가 모아 줌)
 */
import { html, fmtDate, fmtRelative, fmtMoney, todayStr } from '../lib.js';
import { session, can } from '../store.js';
import { PageHeader, Card, Icon, Badge, Button, LinkButton, useApi, Loading, ErrorState, EmptyState, Progress, Stat, DdayBadge, Avatar, Callout } from '../ui/index.js';

const LEVEL_ICON = { danger: 'circle-alert', warn: 'triangle-alert', info: 'info', ok: 'circle-check' };
const LEVEL_COLOR = { danger: 'red', warn: 'amber', info: 'blue', ok: 'green' };

function greet() {
  const h = new Date().getHours();
  if (h < 11) return '좋은 아침입니다';
  if (h < 14) return '안녕하세요';
  if (h < 18) return '오후도 힘내세요';
  return '오늘도 수고하셨습니다';
}

function TodoList({ todos }) {
  if (!todos.length) return html`<${EmptyState} compact icon="circle-check" title="오늘 할 일을 모두 마쳤습니다" desc="새로 생기는 일은 여기에 모입니다." />`;
  return html`<div class="list">
    ${todos.map(
      (t) => html`<a class="list-item" href=${t.href || '#/'} key=${t.id}>
        <div class=${`icon-box ${LEVEL_COLOR[t.level] || 'blue'}`}><${Icon} name=${t.icon || LEVEL_ICON[t.level] || 'circle-dot'} size=${16} /></div>
        <div class="grow">
          <div class="list-title ellipsis">${t.title}</div>
          ${t.detail ? html`<div class="list-meta">${t.detail}</div>` : null}
          ${t.progress ? html`<div class="row mt-1"><div class="grow"><${Progress} value=${t.progress.done} max=${t.progress.total} color=${t.progress.done >= t.progress.total ? 'green' : ''} /></div><span class="small muted num">${t.progress.done}/${t.progress.total}</span></div>` : null}
        </div>
        <${Icon} name="chevron-right" size=${16} class="muted" />
      </a>`
    )}
  </div>`;
}

function AlertList({ alerts }) {
  if (!alerts.length) return html`<${EmptyState} compact icon="package" title="재고 경고가 없습니다" desc="적정 재고 미만이거나 유효기간이 다가오면 알려 드립니다." />`;
  return html`<div class="list">
    ${alerts.slice(0, 8).map(
      (a) => html`<a class="list-item" href=${a.href || '#/inventory'} key=${a.id}>
        <span class=${`dot ${LEVEL_COLOR[a.level] || 'amber'}`}></span>
        <div class="grow">
          <div class="list-title ellipsis">${a.title}</div>
          ${a.detail ? html`<div class="list-meta">${a.detail}</div>` : null}
        </div>
        ${a.badge ? html`<${Badge} color=${LEVEL_COLOR[a.level] || 'amber'}>${a.badge}</${Badge}>` : null}
      </a>`
    )}
    ${alerts.length > 8 ? html`<a class="list-item small muted" href="#/inventory?tab=alerts">외 ${alerts.length - 8}건 더 보기</a>` : null}
  </div>`;
}

function UpcomingList({ upcoming }) {
  if (!upcoming.length) return html`<${EmptyState} compact icon="calendar-check" title="30일 안에 예정된 점검·일정이 없습니다" />`;
  return html`<div class="list">
    ${upcoming.slice(0, 8).map(
      (u) => html`<a class="list-item" href=${u.href || '#/'} key=${u.id}>
        <div class="icon-box"><${Icon} name=${u.icon || 'calendar-clock'} size=${16} /></div>
        <div class="grow">
          <div class="list-title ellipsis">${u.title}</div>
          <div class="list-meta">${fmtDate(u.date)}${u.detail ? ' · ' + u.detail : ''}</div>
        </div>
        <${DdayBadge} days=${u.dday} />
      </a>`
    )}
  </div>`;
}

function NoticeList({ notices }) {
  if (!notices.length) return html`<${EmptyState} compact icon="megaphone" title="최근 공지가 없습니다" action=${html`<${LinkButton} href="#/board" size="sm">공지 보드로</${LinkButton}>`} />`;
  return html`<div class="list">
    ${notices.map(
      (n) => html`<a class="list-item" href=${n.href} key=${n.id}>
        ${n.unread ? html`<span class="dot blue" title="안 읽음"></span>` : html`<span class="dot" style=${{ opacity: 0.25 }}></span>`}
        <div class="grow">
          <div class="row" style=${{ gap: '6px' }}>
            ${n.pinned ? html`<${Icon} name="pin" size=${13} class="muted" />` : null}
            <span class=${`list-title ellipsis ${n.unread ? 'strong' : ''}`}>${n.title}</span>
            ${n.importance === 'urgent' ? html`<${Badge} color="red">긴급</${Badge}>` : n.importance === 'important' ? html`<${Badge} color="amber">중요</${Badge}>` : null}
          </div>
          <div class="list-meta">${n.kindLabel} · ${n.author} · ${fmtRelative(n.createdAt)}</div>
        </div>
      </a>`
    )}
  </div>`;
}

function TodayStaff({ today }) {
  const working = today.working || [];
  const off = today.off || [];
  if (!working.length && !off.length) return html`<${EmptyState} compact icon="calendar-days" title="오늘 근무표가 비어 있습니다" action=${html`<${LinkButton} href="#/schedule" size="sm">근무표 열기</${LinkButton}>`} />`;
  return html`<div class="stack sm">
    ${working.length
      ? html`<div class="small strong text-2">근무 (${working.length}명)</div>
          <div class="row wrap">${working.map((w) => html`<span class="badge" title=${w.shift}><span class="dot" style=${{ background: w.color || 'var(--accent)' }}></span>${w.name}<span class="muted">${w.shift}</span></span>`)}</div>`
      : null}
    ${off.length
      ? html`<div class="small strong text-2 mt-2">휴무·휴가 (${off.length}명)</div>
          <div class="row wrap">${off.map((w) => html`<${Badge} color="amber">${w.name} · ${w.reason}</${Badge}>`)}</div>`
      : null}
  </div>`;
}

export default function DashboardPage() {
  const { data, loading, error, reload } = useApi('/dashboard');
  const user = session.user;

  if (error && !data) return html`<${ErrorState} error=${error} onRetry=${reload} />`;
  if (loading && !data) return html`<${Loading} />`;

  const stats = [...data.stats];
  if (data.ai && can('manager')) {
    stats.push({
      key: 'ai',
      label: '이번 달 AI 비용',
      value: fmtMoney(data.ai.usedKrw).replace('원', ''),
      unit: '원',
      hint: data.ai.limitKrw ? `예산 ${fmtMoney(data.ai.limitKrw)}의 ${Math.round(data.ai.ratio * 100)}%` : '예산 한도 없음',
      href: '#/admin/usage',
      icon: 'sparkles',
      color: data.ai.over ? 'danger' : data.ai.warn ? 'warning' : '',
    });
  }

  return html`
    <${PageHeader}
      title=${`${greet()}, ${user.name}님`}
      desc=${`${fmtDate(data.date || todayStr(), { long: true })} · 오늘 챙길 일을 모아 두었습니다.`}
      actions=${html`
        <${Button} icon="refresh-cw" variant="ghost" onClick=${reload} loading=${loading} aria-label="새로고침">새로고침</${Button}>
        <${LinkButton} href="#/board" icon="plus" variant="primary">공지·인수인계 쓰기</${LinkButton}>
      `}
    />
    ${data.errors && data.errors.length ? html`<${Callout} kind="warn" class="mt-0">일부 요약(${data.errors.join(', ')})을 불러오지 못했습니다.</${Callout}>` : null}
    ${stats.length
      ? html`<div class="stats" style=${{ marginBottom: '16px' }}>
          ${stats.map((s) => html`<${Stat} key=${s.key} label=${s.label} value=${s.value} unit=${s.unit} hint=${s.hint} href=${s.href} icon=${s.icon} color=${s.color} />`)}
        </div>`
      : null}
    <div class="grid dash-grid">
      <div class="stack lg">
        <${Card} title="오늘 할 일" icon="list-checks" sub=${data.todos.length ? `${data.todos.length}건` : ''} flush>
          <${TodoList} todos=${data.todos} />
        </${Card}>
        <${Card} title="공지·인수인계" icon="megaphone" flush actions=${html`<${LinkButton} href="#/board" size="sm" variant="ghost">전체 보기</${LinkButton}>`}>
          <${NoticeList} notices=${data.notices} />
        </${Card}>
      </div>
      <div class="stack lg">
        <${Card} title="재고 경고" icon="package" sub=${data.alerts.length ? `${data.alerts.length}건` : ''} flush actions=${html`<${LinkButton} href="#/inventory" size="sm" variant="ghost">재고로</${LinkButton}>`}>
          <${AlertList} alerts=${data.alerts} />
        </${Card}>
        <${Card} title="다가오는 점검·일정" icon="calendar-clock" flush actions=${html`<${LinkButton} href="#/compliance" size="sm" variant="ghost">법정 일정</${LinkButton}>`}>
          <${UpcomingList} upcoming=${data.upcoming} />
        </${Card}>
        <${Card} title="오늘 근무" icon="users">
          <${TodayStaff} today=${data.today} />
        </${Card}>
      </div>
    </div>
  `;
}
