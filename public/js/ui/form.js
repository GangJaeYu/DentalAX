/*
 * 이 파일이 하는 일: 입력 양식 부품(입력칸, 선택칸, 체크박스)과 양식 상태를 관리하는 useForm 입니다.
 *
 * 사용 예)
 *   const f = useForm({ title: '', qty: 0 });
 *   html`<${Field} label="제목" required error=${f.errors.title}>
 *          <${Input} ...${f.bind('title')} />
 *        </${Field}>`
 *   const save = f.submit(async (values) => { await api.post('/x', values); });
 *   서버가 "제목: 꼭 입력해 주세요" 처럼 칸 이름(field)과 함께 오류를 보내면 해당 칸 아래에 자동으로 표시됩니다.
 */
import { html, h, cx, useState, useRef, useCallback } from '../lib.js';
import { toast } from '../store.js';

let fieldSeq = 0;

/** 라벨 + 입력칸 + 도움말/오류를 묶는 틀. 안쪽 입력칸에 id를 자동 연결 (접근성) */
export function Field({ label, required, hint, error, children, class: cls, full }) {
  const idRef = useRef(null);
  if (!idRef.current) idRef.current = `f${++fieldSeq}`;
  const id = idRef.current;
  // 첫 번째 자식 입력칸에 id·설명 연결
  const kids = Array.isArray(children) ? children : [children];
  const linked = kids.map((k, i) =>
    i === 0 && k && k.props && k.type && !k.props.id
      ? h(k.type, { ...k.props, id, 'aria-invalid': error ? 'true' : undefined, 'aria-describedby': error || hint ? `${id}-d` : undefined })
      : k
  );
  return html`<div class=${cx('field', full && 'full', cls)}>
    ${label ? html`<label class="label" for=${id}>${label}${required ? html`<span class="req" aria-hidden="true">*</span>` : null}</label>` : null}
    ${linked}
    ${error ? html`<div class="field-error" id=${`${id}-d`} role="alert">${error}</div>` : hint ? html`<div class="hint" id=${`${id}-d`}>${hint}</div>` : null}
  </div>`;
}

export function Input({ class: cls, size, ...rest }) {
  return html`<input class=${cx('input', size === 'sm' && 'input-sm', cls)} ...${rest} />`;
}

export function Textarea({ class: cls, rows = 4, ...rest }) {
  return html`<textarea class=${cx('textarea', cls)} rows=${rows} ...${rest}></textarea>`;
}

/**
 * 선택칸. options: [{ value, label }] 또는 ['a','b']
 */
export function Select({ options = [], placeholder, class: cls, size, ...rest }) {
  return html`<select class=${cx('select', size === 'sm' && 'input-sm', cls)} ...${rest}>
    ${placeholder !== undefined ? html`<option value="">${placeholder}</option>` : null}
    ${options.map((o) => {
      const opt = typeof o === 'object' ? o : { value: o, label: o };
      return html`<option value=${opt.value}>${opt.label}</option>`;
    })}
  </select>`;
}

export function Checkbox({ label, checked, onChange, disabled, class: cls, ...rest }) {
  return html`<label class=${cx('check', cls)}>
    <input type="checkbox" checked=${!!checked} disabled=${disabled} onChange=${(e) => onChange && onChange(e.target.checked)} ...${rest} />
    <span>${label}</span>
  </label>`;
}

export function FormGrid({ children, class: cls }) {
  return html`<div class=${cx('form-grid', cls)}>${children}</div>`;
}

/** 검색창 */
export function SearchInput({ value, onInput, placeholder = '검색', class: cls, ...rest }) {
  return html`<div class=${cx('input-group', cls)}>
    <svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    <input class="input" type="search" value=${value} placeholder=${placeholder} aria-label=${placeholder} onInput=${(e) => onInput(e.target.value)} ...${rest} />
  </div>`;
}

/**
 * 양식 상태 관리
 * @param {object} initial 처음 값
 */
export function useForm(initial) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const set = useCallback((key, val) => {
    setValues((v) => ({ ...v, [key]: val }));
    setErrors((e) => (e[key] ? { ...e, [key]: null } : e));
  }, []);

  /** 입력칸에 값과 변경 함수를 한 번에 연결: ...${f.bind('title')} */
  const bind = (key, opts = {}) => {
    const val = values[key];
    if (opts.type === 'checkbox') return { checked: !!val, onChange: (c) => set(key, c) };
    return {
      value: val === null || val === undefined ? '' : val,
      onInput: (e) => set(key, opts.number ? (e.target.value === '' ? '' : e.target.value) : e.target.value),
      name: key,
    };
  };

  /** 저장 버튼에 연결할 함수를 만듦. 서버 오류는 칸 아래 또는 알림으로 표시 */
  const submit = (fn) => async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrors({});
    try {
      return await fn(values);
    } catch (err) {
      const field = err && err.data && err.data.field;
      if (field) {
        const key = String(field).split('.')[0].replace(/\[\d+\]$/, '');
        setErrors({ [key]: err.message.replace(/^[^:]+:\s*/, '') });
        toast.error(err.message);
      } else {
        toast.error(err.message || '저장하지 못했습니다.');
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  return { values, setValues, set, bind, errors, setErrors, busy, submit, reset: () => setValues(initial) };
}
