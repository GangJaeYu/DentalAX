/*
 * 이 파일이 하는 일: 화면에서 보낸 입력값이 올바른지 검사합니다. (입력값 검증)
 *
 * 왜 필요한가: 화면에서 막아도 누군가 직접 요청을 조작해 보낼 수 있으므로, 서버에서 한 번 더 확인해야 안전합니다.
 *
 * 사용 예)
 *   const schema = v.object({
 *     name: v.string({ min: 1, max: 100, label: '품목명' }),
 *     qty:  v.number({ min: 0, int: true, label: '수량' }),
 *     memo: v.string({ max: 500, optional: true }),
 *   });
 *   const data = schema.parse(req.body);   // 잘못되면 400 오류와 한국어 안내를 자동으로 보냄
 */
const { badRequest } = require('./errors');
const time = require('./time');

class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

function fail(label, msg, field) {
  throw new ValidationError(`${label ? label + ': ' : ''}${msg}`, field);
}

/** 공통: 빈 값 처리 (optional이면 기본값 또는 null) */
function emptyCheck(val, opts, field) {
  if (val === undefined || val === null || val === '') {
    if (opts.optional) return { empty: true, value: opts.default !== undefined ? opts.default : null };
    fail(opts.label || field, '꼭 입력해 주세요.', field);
  }
  return { empty: false };
}

const v = {
  string(opts = {}) {
    return (val, field) => {
      if (typeof val === 'string') val = opts.trim === false ? val : val.trim();
      const e = emptyCheck(val, opts, field);
      if (e.empty) return e.value;
      if (typeof val !== 'string') val = String(val);
      // 화면에 보이지 않는 제어 문자 제거 (줄바꿈·탭은 유지)
      val = val.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
      if (opts.min && val.length < opts.min) fail(opts.label || field, `${opts.min}자 이상 입력해 주세요.`, field);
      const max = opts.max ?? 5000;
      if (val.length > max) fail(opts.label || field, `${max}자 이하로 입력해 주세요.`, field);
      if (opts.pattern && !opts.pattern.test(val)) fail(opts.label || field, opts.patternMessage || '형식이 올바르지 않습니다.', field);
      return val;
    };
  },
  number(opts = {}) {
    return (val, field) => {
      const e = emptyCheck(val, opts, field);
      if (e.empty) return e.value;
      const n = typeof val === 'number' ? val : Number(String(val).replace(/,/g, ''));
      if (!Number.isFinite(n)) fail(opts.label || field, '숫자로 입력해 주세요.', field);
      if (opts.int && !Number.isInteger(n)) fail(opts.label || field, '정수로 입력해 주세요.', field);
      if (opts.min !== undefined && n < opts.min) fail(opts.label || field, `${opts.min} 이상이어야 합니다.`, field);
      if (opts.max !== undefined && n > opts.max) fail(opts.label || field, `${opts.max} 이하여야 합니다.`, field);
      return n;
    };
  },
  int(opts = {}) {
    return v.number({ ...opts, int: true });
  },
  bool(opts = {}) {
    return (val) => {
      if (val === undefined || val === null || val === '') return opts.default ?? false;
      return val === true || val === 1 || val === '1' || val === 'true';
    };
  },
  date(opts = {}) {
    return (val, field) => {
      const e = emptyCheck(val, opts, field);
      if (e.empty) return e.value;
      if (!time.isValidDate(val)) fail(opts.label || field, '날짜 형식(YYYY-MM-DD)이 올바르지 않습니다.', field);
      return val;
    };
  },
  month(opts = {}) {
    return (val, field) => {
      const e = emptyCheck(val, opts, field);
      if (e.empty) return e.value;
      if (typeof val !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(val)) fail(opts.label || field, '월 형식(YYYY-MM)이 올바르지 않습니다.', field);
      return val;
    };
  },
  enum(values, opts = {}) {
    return (val, field) => {
      const e = emptyCheck(val, opts, field);
      if (e.empty) return e.value;
      if (!values.includes(val)) fail(opts.label || field, '허용되지 않는 값입니다.', field);
      return val;
    };
  },
  array(itemFn, opts = {}) {
    return (val, field) => {
      if (val === undefined || val === null) {
        if (opts.optional) return opts.default ?? [];
        fail(opts.label || field, '목록이 필요합니다.', field);
      }
      if (!Array.isArray(val)) fail(opts.label || field, '목록 형식이 아닙니다.', field);
      if (opts.max !== undefined && val.length > opts.max) fail(opts.label || field, `최대 ${opts.max}개까지 가능합니다.`, field);
      if (opts.min !== undefined && val.length < opts.min) fail(opts.label || field, `최소 ${opts.min}개가 필요합니다.`, field);
      return val.map((x, i) => itemFn(x, `${field}[${i}]`));
    };
  },
  object(shape, opts = {}) {
    const fn = (val, field) => {
      if (val === undefined || val === null) {
        if (opts.optional) return null;
        val = {};
      }
      if (typeof val !== 'object' || Array.isArray(val)) fail(opts.label || field, '형식이 올바르지 않습니다.', field);
      const out = {};
      for (const [k, check] of Object.entries(shape)) {
        // 일부만 고치는 요청(partial)에서는 보내지 않은 칸은 건너뜀
        if (opts.partial && !(k in val)) continue;
        out[k] = check(val[k], field ? `${field}.${k}` : k);
      }
      return out;
    };
    /** 검사하고, 실패하면 400 오류(한국어 안내)를 던집니다 */
    fn.parse = (val) => {
      try {
        return fn(val, '');
      } catch (e) {
        if (e instanceof ValidationError) throw badRequest(e.message, { field: e.field });
        throw e;
      }
    };
    /** 보낸 칸만 검사 (수정용) */
    fn.partial = () => v.object(shape, { ...opts, partial: true });
    return fn;
  },
  /** id 같은 양의 정수 */
  id(opts = {}) {
    return v.int({ min: 1, ...opts });
  },
};

/** 주소의 :id 같은 값을 숫자로 바꾸고 검사 */
function idParam(val) {
  const n = Number(val);
  if (!Number.isInteger(n) || n < 1) throw badRequest('잘못된 주소입니다.');
  return n;
}

module.exports = { v, idParam, ValidationError };
