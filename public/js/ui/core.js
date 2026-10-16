/*
 * 이 파일이 하는 일: 여러 화면에서 반복해서 쓰는 기본 부품(버튼, 배지, 카드, 빈 화면, 로딩, 탭 등)입니다.
 * 모양은 css/app.css 의 클래스를 따르므로, 여기 부품만 쓰면 화면들이 자연스럽게 같은 디자인이 됩니다.
 */
import { html, cx, useState, useEffect, useRef, initials } from '../lib.js';
import { Icon } from './icons.js';

/**
 * 버튼. variant: primary | secondary(기본) | ghost | danger | soft | ai
 *   html`<${Button} variant="primary" icon="plus" onClick=${...}>추가</${Button}>`
 */
export function Button({ variant = 'secondary', size, icon, iconRight, loading, block, class: cls, children, type = 'button', ...rest }) {
  const v = variant === 'secondary' ? '' : `btn-${variant}`;
  return html`<button
    type=${type}
    class=${cx('btn', v, size && `btn-${size}`, block && 'btn-block', !children && 'btn-icon', cls)}
    disabled=${rest.disabled || loading}
    aria-busy=${loading ? 'true' : undefined}
    ...${rest}
  >
    ${loading ? html`<span class="spinner"></span>` : icon ? html`<${Icon} name=${icon} size=${size === 'sm' ? 14 : 16} />` : null}
    ${children}
    ${iconRight && !loading ? html`<${Icon} name=${iconRight} size=${14} />` : null}
  </button>`;
}

/** 아이콘만 있는 버튼 (label은 화면 낭독기용 설명, 마우스를 올리면 보임) */
export function IconButton({ icon, label, size, variant = 'ghost', ...rest }) {
  return html`<${Button} variant=${variant} size=${size} icon=${icon} aria-label=${label} title=${label} ...${rest} />`;
}

/** 링크처럼 생긴 버튼 대신, 주소 이동용 버튼 모양 링크 */
export function LinkButton({ href, variant = 'secondary', size, icon, children, ...rest }) {
  const v = variant === 'secondary' ? '' : `btn-${variant}`;
  return html`<a href=${href} class=${cx('btn', v, size && `btn-${size}`)} ...${rest}>
    ${icon ? html`<${Icon} name=${icon} size=${size === 'sm' ? 14 : 16} />` : null}${children}
  </a>`;
}

/** 배지. color: gray(기본) | blue | green | amber | red | purple */
export function Badge({ color, children, dot, class: cls, title }) {
  return html`<span class=${cx('badge', color, cls)} title=${title}>${dot ? html`<span class=${cx('dot', color)}></span>` : null}${children}</span>`;
}

export function Card({ title, sub, actions, children, class: cls, bodyClass, flush, footer, icon, id }) {
  return html`<section class=${cx('card', cls)} id=${id} aria-label=${typeof title === 'string' ? title : undefined}>
    ${title || actions
      ? html`<div class="card-header">
          <div class="card-title">${icon ? html`<${Icon} name=${icon} size=${16} />` : null}${title}${sub ? html`<span class="card-sub">${sub}</span>` : null}</div>
          ${actions ? html`<div class="row">${actions}</div>` : null}
        </div>`
      : null}
    <div class=${cx('card-body', flush && 'flush', bodyClass)}>${children}</div>
    ${footer ? html`<div class="card-footer">${footer}</div>` : null}
  </section>`;
}

/** 화면 맨 위 제목 줄 */
export function PageHeader({ title, desc, actions, children }) {
  useEffect(() => {
    if (typeof title === 'string') document.title = `${title} · DentalAX`;
  }, [title]);
  return html`<header class="page-header">
    <div class="grow">
      <h1 class="page-title">${title}</h1>
      ${desc ? html`<p class="page-desc">${desc}</p>` : null}
      ${children}
    </div>
    ${actions ? html`<div class="page-actions">${actions}</div>` : null}
  </header>`;
}

/** 빈 화면: 아직 데이터가 없을 때 무엇을 하면 되는지 알려 줌 */
export function EmptyState({ icon = 'inbox', title, desc, action, compact }) {
  return html`<div class=${cx('empty', compact && 'compact')}>
    <div class="icon-box"><${Icon} name=${icon === 'inbox' ? 'archive' : icon} size=${20} /></div>
    <div class="empty-title">${title}</div>
    ${desc ? html`<div class="empty-desc">${desc}</div>` : null}
    ${action ? html`<div class="mt-2">${action}</div>` : null}
  </div>`;
}

/** 로딩 표시 (rows를 주면 표 모양 뼈대) */
export function Loading({ label = '불러오는 중…', rows }) {
  if (rows) {
    return html`<div class="stack" style=${{ padding: '16px 18px' }} aria-busy="true" aria-label=${label}>
      ${Array.from({ length: rows }).map((_, i) => html`<div class="skeleton" style=${{ width: `${90 - ((i * 13) % 35)}%` }}></div>`)}
    </div>`;
  }
  return html`<div class="loading-block" role="status"><span class="spinner"></span>${label}</div>`;
}

/** 오류 표시 + 다시 시도 버튼 */
export function ErrorState({ error, onRetry, compact }) {
  const msg = (error && error.message) || String(error || '문제가 생겼습니다.');
  return html`<div class=${cx('empty', compact && 'compact')} role="alert">
    <div class="icon-box red"><${Icon} name="circle-alert" size=${20} /></div>
    <div class="empty-title">불러오지 못했습니다</div>
    <div class="empty-desc">${msg}</div>
    ${onRetry ? html`<div class="mt-2"><${Button} icon="refresh-cw" onClick=${onRetry}>다시 시도</${Button}></div>` : null}
  </div>`;
}

/** 안내 상자. kind: info | warn | danger | success */
export function Callout({ kind = 'info', icon, title, children, class: cls }) {
  const ic = icon || { info: 'info', warn: 'triangle-alert', danger: 'circle-alert', success: 'circle-check' }[kind];
  return html`<div class=${cx('callout', kind, cls)} role=${kind === 'danger' ? 'alert' : undefined}>
    <${Icon} name=${ic} size=${16} />
    <div class="grow">${title ? html`<strong>${title}</strong> ` : null}${children}</div>
  </div>`;
}

export function Progress({ value = 0, max = 100, color, label }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return html`<div class=${cx('progress', color)} role="progressbar" aria-valuenow=${Math.round(pct)} aria-valuemin="0" aria-valuemax="100" aria-label=${label}>
    <span style=${{ width: pct + '%' }}></span>
  </div>`;
}

export function Avatar({ name, color, size }) {
  return html`<span class=${cx('avatar', size)} style=${{ background: color || 'var(--text-3)' }} aria-hidden="true">${initials(name)}</span>`;
}

/**
 * 탭. items: [{ value, label, count? }]
 *   html`<${Tabs} items=${[...]} value=${tab} onChange=${setTab} />`
 */
export function Tabs({ items, value, onChange }) {
  return html`<div class="tabs" role="tablist">
    ${items.map(
      (it) => html`<button
        type="button"
        role="tab"
        class="tab"
        aria-selected=${value === it.value ? 'true' : 'false'}
        onClick=${() => onChange(it.value)}
      >
        ${it.icon ? html`<${Icon} name=${it.icon} size=${15} />` : null}${it.label}
        ${it.count ? html`<${Badge} color=${it.countColor || 'gray'} class="count">${it.count}</${Badge}>` : null}
      </button>`
    )}
  </div>`;
}

/** 여러 개 중 하나 고르는 작은 버튼 묶음 */
export function Seg({ items, value, onChange, label }) {
  return html`<div class="seg" role="group" aria-label=${label}>
    ${items.map(
      (it) => html`<button type="button" aria-pressed=${value === it.value ? 'true' : 'false'} onClick=${() => onChange(it.value)}>${it.label}</button>`
    )}
  </div>`;
}

/** 숫자 카드 */
export function Stat({ label, value, unit, hint, icon, href, color }) {
  const inner = html`
    <div class="stat-label">${icon ? html`<${Icon} name=${icon} size=${14} />` : null}${label}</div>
    <div class=${cx('stat-value', color && `${color}-text`)}>${value}${unit ? html`<span class="stat-unit">${unit}</span>` : null}</div>
    ${hint ? html`<div class="stat-hint">${hint}</div>` : null}`;
  return href ? html`<a class="stat" href=${href}>${inner}</a>` : html`<div class="stat">${inner}</div>`;
}

/**
 * 점 세 개(…) 메뉴.
 *   items: [{ label, icon, onClick, danger, hidden }] / 구분선은 '-'
 */
export function Menu({ items, label = '더 보기', icon = 'ellipsis', buttonVariant = 'ghost', size = 'sm' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const visible = items.filter((it) => it && !it.hidden);
  if (!visible.length) return null;
  return html`<div class="menu-wrap" ref=${ref}>
    <${IconButton} icon=${icon} label=${label} size=${size} variant=${buttonVariant} aria-haspopup="menu" aria-expanded=${open ? 'true' : 'false'} onClick=${(e) => {
      e.stopPropagation();
      setOpen(!open);
    }} />
    ${open
      ? html`<div class="menu" role="menu">
          ${visible.map((it) =>
            it === '-'
              ? html`<div class="menu-sep"></div>`
              : html`<button type="button" role="menuitem" class=${cx('menu-item', it.danger && 'danger')} onClick=${(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  it.onClick && it.onClick();
                }}>
                  ${it.icon ? html`<${Icon} name=${it.icon} size=${15} />` : null}${it.label}
                </button>`
          )}
        </div>`
      : null}
  </div>`;
}

/** D-day 배지 (지남: 빨강, 7일 이내: 주황, 그 외: 회색) */
export function DdayBadge({ days, label }) {
  if (days === null || days === undefined) return null;
  const color = days < 0 ? 'red' : days <= 7 ? 'amber' : 'gray';
  const text = label || (days === 0 ? 'D-day' : days > 0 ? `D-${days}` : `${-days}일 지남`);
  return html`<${Badge} color=${color}>${text}</${Badge}>`;
}
