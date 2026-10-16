/*
 * 이 파일이 하는 일: 여러 화면이 함께 쓰는 상태(로그인한 사람, 병원 이름, 알림 메시지, 확인 창)를 보관합니다.
 *
 *   import { session, toast, confirmDialog } from '../store.js';
 *   session.user            → 지금 로그인한 사람 { id, name, role, ... }
 *   toast.success('저장했습니다');
 *   if (await confirmDialog({ title: '삭제할까요?', danger: true })) { ... }
 */
import { useEffect, useState } from './lib.js';

/** 아주 작은 "구독 가능한 값" — 값이 바뀌면 구독한 화면이 다시 그려짐 */
export function createStore(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? next(value) : next;
      subs.forEach((fn) => fn(value));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** 화면 컴포넌트 안에서 store 값을 쓰기: const user = useStore(sessionStore).user */
export function useStore(store) {
  const [v, setV] = useState(store.get());
  useEffect(() => {
    const unsub = store.subscribe(setV);
    // 구독하기 전에 값이 바뀌었을 수 있으니 한 번 맞춰 줌
    setV(store.get());
    return unsub;
  }, [store]);
  return v;
}

// ---------- 로그인 정보 ----------
export const sessionStore = createStore({ user: null, clinicName: '', setupRequired: false, ready: false });

export const session = {
  get user() {
    return sessionStore.get().user;
  },
  get clinicName() {
    return sessionStore.get().clinicName;
  },
};

const LEVEL = { staff: 1, manager: 2, admin: 3 };
/** 권한 확인: can('manager') → 실장 이상이면 true */
export function can(role, user = session.user) {
  return !!user && (LEVEL[user.role] || 0) >= LEVEL[role];
}

// ---------- 알림 메시지(토스트) ----------
export const toastStore = createStore([]);
let toastId = 0;
function pushToast(kind, message, ms = 3500) {
  const id = ++toastId;
  toastStore.set((list) => [...list, { id, kind, message }].slice(-4));
  setTimeout(() => toastStore.set((list) => list.filter((t) => t.id !== id)), ms);
}
export const toast = {
  success: (m) => pushToast('success', m),
  error: (m) => pushToast('error', m, 6000),
  warn: (m) => pushToast('warn', m, 6000),
  info: (m) => pushToast('info', m),
};

// ---------- 확인 창 ----------
export const confirmStore = createStore(null);
/**
 * 확인 창을 띄우고 사용자가 고른 결과(true/false)를 돌려줍니다.
 * @param {{title:string, message?:string, confirmText?:string, danger?:boolean, typeToConfirm?:string}} opts
 */
export function confirmDialog(opts) {
  return new Promise((resolve) => {
    confirmStore.set({ ...opts, resolve });
  });
}

// ---------- 화면 모드(라이트/다크) ----------
export const themeStore = createStore(document.documentElement.getAttribute('data-theme') || 'light');
export function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem('dx-theme', t);
  } catch {
    /* 저장이 막혀 있어도 동작은 함 */
  }
  themeStore.set(t);
}
