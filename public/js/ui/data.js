/*
 * 이 파일이 하는 일: 서버에서 데이터를 불러오는 useApi 와, 목록을 표로 보여 주는 DataTable, 쪽 넘김(Pagination) 입니다.
 *
 *   const { data, loading, error, reload } = useApi('/inventory/items?q=' + q);
 *   html`<${DataTable} columns=${cols} rows=${data?.rows} loading=${loading} error=${error} onRetry=${reload}
 *          empty=${{ title: '등록된 품목이 없습니다', desc: '오른쪽 위 [품목 추가]를 눌러 시작하세요.' }} />`
 */
import { html, cx, useState, useEffect, useCallback, useRef } from '../lib.js';
import { api } from '../api.js';
import { Loading, ErrorState, EmptyState, Button } from './core.js';

/**
 * 주소(url)가 바뀔 때마다 서버에서 다시 불러옵니다. url이 null이면 불러오지 않습니다.
 * reload() 로 언제든 새로 불러올 수 있고, 다시 불러오는 동안에도 이전 데이터는 그대로 보입니다.
 */
export function useApi(url) {
  const [state, setState] = useState({ data: null, loading: !!url, error: null });
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!url) return;
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api.get(url);
      if (my === seq.current) setState({ data, loading: false, error: null });
    } catch (error) {
      if (my === seq.current) setState((s) => ({ ...s, loading: false, error }));
    }
  }, [url]);
  useEffect(() => {
    load();
  }, [load]);
  const setData = (fn) => setState((s) => ({ ...s, data: typeof fn === 'function' ? fn(s.data) : fn }));
  return { ...state, reload: load, setData };
}

/**
 * 표
 * columns: [{ key, label, render?(row), align?: 'right'|'center', width?, class? }]
 */
export function DataTable({ columns, rows, loading, error, onRetry, empty, onRowClick, rowKey = 'id', rowClass, compact, caption }) {
  if (error && !rows) return html`<${ErrorState} error=${error} onRetry=${onRetry} />`;
  if (loading && !rows) return html`<${Loading} rows=${5} />`;
  if (!rows || rows.length === 0) {
    return html`<${EmptyState} icon=${empty?.icon || 'archive'} title=${empty?.title || '아직 내용이 없습니다'} desc=${empty?.desc} action=${empty?.action} />`;
  }
  return html`<div class="table-wrap">
    <table class=${cx('table', compact && 'table-compact')}>
      ${caption ? html`<caption class="sr-only">${caption}</caption>` : null}
      <thead>
        <tr>
          ${columns.map((c) => html`<th scope="col" class=${cx(c.align, c.class)} style=${c.width ? { width: c.width } : null}>${c.label}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (r) => html`<tr
            key=${r[rowKey]}
            class=${cx(onRowClick && 'clickable', rowClass && rowClass(r))}
            onClick=${onRowClick ? () => onRowClick(r) : undefined}
            tabindex=${onRowClick ? 0 : undefined}
            onKeyDown=${onRowClick ? (e) => e.key === 'Enter' && onRowClick(r) : undefined}
          >
            ${columns.map((c) => html`<td class=${cx(c.align, c.class)}>${c.render ? c.render(r) : r[c.key] ?? ''}</td>`)}
          </tr>`
        )}
      </tbody>
    </table>
  </div>`;
}

export function Pagination({ page, size, total, onChange }) {
  const pages = Math.max(1, Math.ceil((total || 0) / size));
  if (pages <= 1) return null;
  return html`<div class="row between" style=${{ padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
    <span class="small muted">총 ${total.toLocaleString('ko-KR')}건 · ${page}/${pages}쪽</span>
    <div class="row">
      <${Button} size="sm" icon="chevron-left" disabled=${page <= 1} onClick=${() => onChange(page - 1)}>이전</${Button}>
      <${Button} size="sm" iconRight="chevron-right" disabled=${page >= pages} onClick=${() => onChange(page + 1)}>다음</${Button}>
    </div>
  </div>`;
}
