/*
 * 이 파일이 하는 일: 병원 기본 정보(이름, 주소, 전화 등)를 한 번 불러와 여러 화면이 함께 씁니다.
 *   const clinic = useClinic();   // { name, phone, address, hours, ... }
 * 관리 → 병원 정보에서 저장하면 refreshClinic()으로 다시 불러옵니다.
 */
import { useEffect } from './lib.js';
import { api } from './api.js';
import { createStore, useStore } from './store.js';

export const clinicStore = createStore(null);
let loading = false;

export function refreshClinic() {
  loading = true;
  return api
    .get('/admin/clinic')
    .then((c) => clinicStore.set(c))
    .catch(() => {})
    .finally(() => (loading = false));
}

export function useClinic() {
  const c = useStore(clinicStore);
  useEffect(() => {
    if (!c && !loading) refreshClinic();
  }, []);
  return c;
}
