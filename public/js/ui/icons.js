/*
 * 이 파일이 하는 일: 아이콘을 그리는 컴포넌트입니다.
 *   html`<${Icon} name="package" size=${16} />`
 * 아이콘 모양 데이터는 icons-data.js 에 있습니다.
 */
import { h } from '../lib.js';
import { ICONS } from './icons-data.js';

export function Icon({ name, size = 16, stroke = 2, class: cls = '', title }) {
  const nodes = ICONS[name] || ICONS['circle-help'];
  return h(
    'svg',
    {
      class: `icon ${cls}`,
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': stroke,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': title ? undefined : 'true',
      role: title ? 'img' : undefined,
    },
    title ? h('title', null, title) : null,
    ...nodes.map(([tag, attrs]) => h(tag, attrs))
  );
}
