/*
 * 이 파일이 하는 일: 주소창의 #/... 부분을 보고 어떤 화면을 보여 줄지 정합니다. (화면 이동)
 *
 *   #/inventory/items/12?tab=moves  →  { path: '/inventory/items/12', parts: ['inventory','items','12'], query: { tab: 'moves' } }
 *
 *   navigate('#/board/3')         다른 화면으로 이동
 *   setQuery({ tab: 'moves' })    지금 화면에서 ?뒤 값만 바꾸기 (뒤로 가기 기록을 남기지 않음)
 */
import { useEffect, useState, parseQuery, toQuery } from './lib.js';

export function currentRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [p, qs] = raw.split('?');
  const path = p.startsWith('/') ? p : '/' + p;
  return { path, parts: path.split('/').filter(Boolean), query: parseQuery(qs) };
}

export function navigate(href) {
  const h = href.startsWith('#') ? href : '#' + href;
  if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = h;
}

export function setQuery(patch) {
  const r = currentRoute();
  const next = { ...r.query, ...patch };
  history.replaceState(null, '', '#' + r.path + toQuery(next));
  window.dispatchEvent(new Event('dx-query'));
}

/** 화면 컴포넌트에서 지금 주소 정보를 쓰기 */
export function useRoute() {
  const [r, setR] = useState(currentRoute());
  useEffect(() => {
    const on = () => setR(currentRoute());
    window.addEventListener('hashchange', on);
    window.addEventListener('dx-query', on);
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener('dx-query', on);
    };
  }, []);
  return r;
}
