/*
 * 이 파일이 하는 일: 로그인한 뒤 보이는 전체 틀(왼쪽 메뉴, 위쪽 막대)과 화면 전환을 담당합니다.
 *
 *  - 주소(#/...)가 바뀌면 routes.js 의 연결표를 보고 pages/ 폴더의 화면 파일을 불러와 보여 줍니다.
 *  - 화면 파일에서 오류가 나도 앱 전체가 멈추지 않고 그 화면에만 오류 안내가 뜹니다.
 *  - 단축키: Ctrl+K(빠른 이동), [ (메뉴 접기)
 */
import { html, useState, useEffect, useRef, cx, useErrorBoundary } from './lib.js';
import { useRoute, navigate } from './router.js';
import { NAV, findRoute, allRoutes } from './routes.js';
import { sessionStore, useStore, can, themeStore, setTheme, toast } from './store.js';
import { api } from './api.js';
import { Icon, IconButton, Avatar, Loading, ErrorState, EmptyState, LinkButton, Modal, AiStatus, ConfirmHost, ToastHost } from './ui/index.js';
import { useClinic } from './clinic.js';

const pageCache = new Map();

function loadPage(name) {
  if (!pageCache.has(name)) {
    pageCache.set(
      name,
      import(`./pages/${name}.js`).catch((e) => {
        pageCache.delete(name);
        throw e;
      })
    );
  }
  return pageCache.get(name);
}

/** 화면 하나에서 난 오류를 잡아 그 자리에만 안내를 보여 줌 */
function PageBoundary({ children, resetKey }) {
  const [error, reset] = useErrorBoundary((e) => console.error('[화면 오류]', e));
  useEffect(() => {
    if (error) reset();
  }, [resetKey]);
  if (error) return html`<${ErrorState} error=${{ message: '화면을 그리는 중 문제가 생겼습니다. 새로고침(F5)해 보세요. 계속되면 관리자에게 알려 주세요.' }} onRetry=${() => location.reload()} />`;
  return children;
}

function RoutedPage({ route }) {
  const def = findRoute(route.parts);
  const [state, setState] = useState({ name: null, Comp: null, error: null });
  const pageName = def ? def.page : null;

  useEffect(() => {
    if (!pageName) return;
    let alive = true;
    setState((s) => (s.name === pageName ? s : { name: pageName, Comp: null, error: null }));
    loadPage(pageName)
      .then((mod) => alive && setState({ name: pageName, Comp: mod.default, error: null }))
      .catch((error) => alive && setState({ name: pageName, Comp: null, error }));
    return () => {
      alive = false;
    };
  }, [pageName]);

  if (!def) {
    return html`<${EmptyState} icon="circle-help" title="없는 화면입니다" desc="주소가 바뀌었거나 잘못 입력되었습니다." action=${html`<${LinkButton} href="#/" icon="house">대시보드로</${LinkButton}>`} />`;
  }
  if (def.role && !can(def.role)) {
    return html`<${EmptyState} icon="lock" title="이 화면을 볼 권한이 없습니다" desc="원장님이나 실장님께 권한을 요청해 주세요." action=${html`<${LinkButton} href="#/" icon="house">대시보드로</${LinkButton}>`} />`;
  }
  if (state.error) return html`<${ErrorState} error=${{ message: '화면 파일을 불러오지 못했습니다. 서버가 켜져 있는지 확인하고 새로고침해 주세요.' }} onRetry=${() => location.reload()} />`;
  if (!state.Comp || state.name !== pageName) return html`<${Loading} />`;
  const Comp = state.Comp;
  return html`<${PageBoundary} resetKey=${route.path}><${Comp} route=${route} /></${PageBoundary}>`;
}

/** 빠른 이동 창 (Ctrl+K) */
function Palette({ open, onClose }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const items = allRoutes()
    .filter((r) => !r.role || can(r.role))
    .filter((r) => {
      if (!q.trim()) return true;
      const hay = `${r.label} ${r.keywords || ''} ${r.path}`.toLowerCase();
      return q
        .toLowerCase()
        .split(/\s+/)
        .every((w) => hay.includes(w));
    });
  useEffect(() => setSel(0), [q]);
  const go = (r) => {
    onClose();
    navigate('#/' + r.path);
  };
  if (!open) return null;
  return html`<${Modal} open=${open} title="빠른 이동" onClose=${onClose} size="palette">
    <input
      class="input"
      placeholder="화면 이름을 입력하세요 (예: 재고, 연차, 멸균)"
      value=${q}
      onInput=${(e) => setQ(e.target.value)}
      aria-label="화면 검색"
      onKeyDown=${(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSel((s) => Math.min(items.length - 1, s + 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSel((s) => Math.max(0, s - 1));
        } else if (e.key === 'Enter' && items[sel]) go(items[sel]);
      }}
    />
    <div class="palette-list mt-2" role="listbox">
      ${items.length === 0 ? html`<div class="muted small" style=${{ padding: '12px' }}>찾는 화면이 없습니다.</div>` : null}
      ${items.map(
        (r, i) => html`<button type="button" class="palette-item" role="option" aria-selected=${i === sel ? 'true' : 'false'} onMouseEnter=${() => setSel(i)} onClick=${() => go(r)}>
          <${Icon} name=${r.icon} size=${16} /><span>${r.label}</span>
        </button>`
      )}
    </div>
  </${Modal}>`;
}

function UserMenu({ user }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* 이미 로그아웃되었어도 괜찮음 */
    }
    sessionStore.set((s) => ({ ...s, user: null }));
    navigate('#/');
  };
  return html`<div class="menu-wrap" ref=${ref}>
    <button type="button" class="btn btn-ghost" onClick=${() => setOpen(!open)} aria-haspopup="menu" aria-expanded=${open ? 'true' : 'false'}>
      <${Avatar} name=${user.name} size="sm" color="var(--accent)" />
      <span class="desktop-only">${user.name}</span>
      <${Icon} name="chevron-down" size=${14} />
    </button>
    ${open
      ? html`<div class="menu" role="menu">
          <div class="menu-label">${user.name} · ${user.roleLabel}${user.jobTitle ? ' · ' + user.jobTitle : ''}</div>
          <a class="menu-item" href="#/me" onClick=${() => setOpen(false)}><${Icon} name="key-round" size=${15} />내 정보·비밀번호</a>
          <div class="menu-sep"></div>
          <button type="button" class="menu-item danger" onClick=${logout}><${Icon} name="log-out" size=${15} />로그아웃</button>
        </div>`
      : null}
  </div>`;
}

export function Shell() {
  const route = useRoute();
  const { user } = useStore(sessionStore);
  const theme = useStore(themeStore);
  const clinic = useClinic();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('dx-nav') === 'collapsed';
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const def = findRoute(route.parts);
  const first = route.parts[0] || '';

  useEffect(() => setMobileOpen(false), [route.path]);
  useEffect(() => {
    try {
      localStorage.setItem('dx-nav', collapsed ? 'collapsed' : 'open');
    } catch {
      /* 무시 */
    }
  }, [collapsed]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    // 화면이 바뀌면 맨 위로
    window.scrollTo(0, 0);
    const main = document.getElementById('main');
    main && main.focus({ preventScroll: true });
  }, [route.path]);

  return html`<div class=${cx('app', collapsed && 'collapsed', mobileOpen && 'mobile-open')}>
    <a class="skip-link" href="#main" onClick=${(e) => {
      e.preventDefault();
      document.getElementById('main').focus();
    }}>본문으로 건너뛰기</a>
    <aside class="sidebar" aria-label="주 메뉴">
      <div class="sidebar-brand">
        <div class="brand-mark" aria-hidden="true">D</div>
        <div class="brand-text">
          <div class="brand-name ellipsis">${clinic?.name || 'DentalAX'}</div>
          <div class="brand-sub">원내 업무 도우미</div>
        </div>
      </div>
      <nav class="nav">
        ${NAV.map((g) => {
          const items = g.items.filter((it) => !it.role || can(it.role));
          if (!items.length) return null;
          return html`<div class="nav-group">
            ${g.title ? html`<div class="nav-group-title">${g.title}</div>` : null}
            ${items.map(
              (it) => html`<a
                href=${'#/' + it.path}
                class=${cx('nav-item', first === it.path && 'active')}
                aria-current=${first === it.path ? 'page' : undefined}
                title=${collapsed ? it.label : undefined}
              >
                <${Icon} name=${it.icon} size=${17} />
                <span class="nav-label">${it.label}</span>
              </a>`
            )}
          </div>`;
        })}
      </nav>
      <div class="sidebar-foot">
        <button type="button" class="nav-item btn-ghost desktop-only" style=${{ width: '100%', border: 0, background: 'none', cursor: 'pointer' }} onClick=${() => setCollapsed(!collapsed)} aria-label=${collapsed ? '메뉴 펼치기' : '메뉴 접기'}>
          <${Icon} name=${collapsed ? 'panel-left-open' : 'panel-left-close'} size=${17} />
          <span class="nav-label sidebar-foot-text">메뉴 접기</span>
        </button>
      </div>
    </aside>
    <div class="sidebar-scrim" onClick=${() => setMobileOpen(false)}></div>
    <div class="main">
      <header class="topbar">
        <${IconButton} icon="menu" label="메뉴 열기" class="mobile-only" onClick=${() => setMobileOpen(true)} />
        <div class="topbar-title ellipsis">${def ? def.label : ''}</div>
        <div class="grow"></div>
        <${AiStatus} />
        <button type="button" class="btn btn-ghost desktop-only" onClick=${() => setPalette(true)} aria-label="빠른 이동 (Ctrl+K)">
          <${Icon} name="search" size=${15} /><span class="muted">빠른 이동</span><span class="kbd">Ctrl K</span>
        </button>
        <${IconButton} icon="search" label="빠른 이동" class="mobile-only" onClick=${() => setPalette(true)} />
        <${IconButton} icon=${theme === 'dark' ? 'sun' : 'moon'} label=${theme === 'dark' ? '밝은 화면' : '어두운 화면'} onClick=${() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
        <${UserMenu} user=${user} />
      </header>
      <main id="main" class="content" tabindex="-1">
        <${RoutedPage} route=${route} />
      </main>
    </div>
    ${palette ? html`<${Palette} open=${true} onClose=${() => setPalette(false)} />` : null}
  </div>`;
}

export { ConfirmHost, ToastHost, toast };
