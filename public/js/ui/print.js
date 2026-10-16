/*
 * 이 파일이 하는 일: 인쇄용 A4 문서 틀(병원 이름 머리글 포함)과 인쇄 실행 함수입니다.
 *
 *   html`<${PrintDoc} title="발주서" meta=${'2026.10.16'}> ...내용... </${PrintDoc}>`
 *   printNow()  → 브라우저 인쇄 창을 엽니다. 인쇄 창에서 "PDF로 저장"을 고르면 PDF 파일이 됩니다.
 *
 * 인쇄할 때는 왼쪽 메뉴·위쪽 막대·버튼(.no-print)이 자동으로 숨겨집니다 (css/app.css 의 @media print).
 */
import { html } from '../lib.js';
import { useClinic } from '../clinic.js';

export function printNow() {
  window.print();
}

/** 모달 안의 내용만 인쇄하고 싶을 때 */
export function printModal() {
  document.body.classList.add('printing-modal');
  const done = () => {
    document.body.classList.remove('printing-modal');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 1500);
}

export function PrintDoc({ title, meta, children, footer = true }) {
  const clinic = useClinic();
  return html`<article class="print-doc paper">
    <header class="paper-head">
      <div>
        <div class="paper-clinic">${clinic?.name || ''}</div>
        <div class="paper-clinic-sub">${[clinic?.address, clinic?.phone].filter(Boolean).join(' · ')}</div>
      </div>
      ${meta ? html`<div class="paper-meta">${meta}</div>` : null}
    </header>
    ${title ? html`<h1 class="paper-title">${title}</h1>` : null}
    <div class="paper-body">${children}</div>
    ${footer
      ? html`<footer class="paper-foot">${clinic?.name || ''}${clinic?.representative ? ` · 대표 ${clinic.representative}` : ''}</footer>`
      : null}
  </article>`;
}
