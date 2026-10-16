/*
 * 이 파일이 하는 일: 팝업 창(모달), 확인 창, 화면 구석의 알림 메시지(토스트)입니다.
 *
 *   html`<${Modal} open=${open} title="품목 추가" onClose=${() => setOpen(false)}
 *          footer=${html`<${Button} variant="primary" onClick=${save}>저장</${Button}>`}>
 *          ...내용...
 *        </${Modal}>`
 *
 *  - Esc 키 또는 바깥(어두운 부분) 클릭으로 닫힙니다.
 *  - 열리면 첫 입력칸에 자동으로 커서가 가고, Tab 키가 창 밖으로 나가지 않습니다(키보드 사용자 배려).
 */
import { html, cx, useEffect, useRef, useState } from '../lib.js';
import { useStore, toastStore, confirmStore } from '../store.js';
import { Icon } from './icons.js';
import { Button, IconButton } from './core.js';
import { Input } from './form.js';

export function Modal({ open, title, onClose, children, footer, size, busy, printKeep, labelledBy }) {
  const ref = useRef();
  const lastFocus = useRef(null);

  useEffect(() => {
    if (!open) return;
    lastFocus.current = document.activeElement;
    const el = ref.current;
    // 첫 입력칸(없으면 창 자체)에 초점.
    // 단, 사용자가 이미 창 안의 다른 칸을 눌러 입력 중이면 초점을 빼앗지 않음 (빠르게 입력하면 글자가 엉뚱한 칸에 들어가던 문제 방지)
    setTimeout(() => {
      if (!el || el.contains(document.activeElement)) return;
      const first = el.querySelector('input:not([type=hidden]):not([disabled]), textarea, select, [data-autofocus]');
      (first || el).focus();
    }, 30);
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose && onClose();
      }
      if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      lastFocus.current && lastFocus.current.focus && lastFocus.current.focus();
    };
  }, [open]);

  if (!open) return null;
  return html`<div
    class=${cx('modal-backdrop', printKeep && 'print-keep')}
    onMouseDown=${(e) => {
      if (e.target === e.currentTarget && !busy) onClose && onClose();
    }}
  >
    <div class=${cx('modal', size)} role="dialog" aria-modal="true" aria-label=${typeof title === 'string' ? title : undefined} aria-labelledby=${labelledBy} tabindex="-1" ref=${ref}>
      <div class="modal-header">
        <h2 class="modal-title">${title}</h2>
        <${IconButton} icon="x" label="닫기" onClick=${onClose} disabled=${busy} />
      </div>
      <div class="modal-body">${children}</div>
      ${footer ? html`<div class="modal-footer">${footer}</div>` : null}
    </div>
  </div>`;
}

/** 앱에 한 번만 두는 확인 창 (store.js 의 confirmDialog 로 띄움) */
export function ConfirmHost() {
  const c = useStore(confirmStore);
  const [typed, setTyped] = useState('');
  useEffect(() => setTyped(''), [c]);
  if (!c) return null;
  const close = (result) => {
    c.resolve(result);
    confirmStore.set(null);
  };
  const needType = c.typeToConfirm;
  const ok = !needType || typed.trim() === needType;
  return html`<${Modal}
    open=${true}
    size="sm"
    title=${c.title}
    onClose=${() => close(false)}
    footer=${html`
      <${Button} onClick=${() => close(false)}>${c.cancelText || '취소'}</${Button}>
      <${Button} variant=${c.danger ? 'danger-solid' : 'primary'} disabled=${!ok} onClick=${() => close(true)} data-autofocus>${c.confirmText || '확인'}</${Button}>
    `}
  >
    ${c.message ? html`<p class="text-2 pre">${c.message}</p>` : null}
    ${needType
      ? html`<div class="field mt-3">
          <label class="label">확인을 위해 <strong>${needType}</strong> 를 입력하세요</label>
          <${Input} value=${typed} onInput=${(e) => setTyped(e.target.value)} />
        </div>`
      : null}
  </${Modal}>`;
}

/** 앱에 한 번만 두는 알림 메시지 표시 영역 */
export function ToastHost() {
  const list = useStore(toastStore);
  const icons = { success: 'circle-check', error: 'circle-alert', warn: 'triangle-alert', info: 'info' };
  return html`<div class="toasts" role="status" aria-live="polite">
    ${list.map((t) => html`<div class=${cx('toast', t.kind)} key=${t.id}><${Icon} name=${icons[t.kind]} size=${16} /><div class="grow pre">${t.message}</div></div>`)}
  </div>`;
}
