/*
 * 이 파일이 하는 일: 왼쪽 메뉴 목록과 "주소 → 화면 파일" 연결표입니다.
 *
 * 새 화면을 추가하려면:
 *   1) public/js/pages/새화면.js 파일을 만들고 (export default function Page({ route }) {...})
 *   2) 아래 NAV 의 알맞은 묶음에 한 줄 추가하세요.
 *      { path: 'orders', label: '발주서', icon: 'shopping-cart', page: 'orders', role: 'manager' }
 *      path  : 주소 (#/orders)
 *      page  : pages 폴더 안의 파일 이름 (확장자 .js 제외)
 *      role  : 이 역할 이상만 메뉴가 보임 (staff / manager / admin). 생략하면 모두.
 *      keywords: 빠른 이동(Ctrl+K)에서 찾을 때 쓰는 다른 이름들
 */
export const NAV = [
  {
    title: null,
    items: [{ path: '', label: '대시보드', icon: 'layout-dashboard', page: 'dashboard', keywords: '홈 첫화면 오늘' }],
  },
  {
    title: '데스크',
    items: [
      { path: 'board', label: '공지·인수인계', icon: 'megaphone', page: 'board', keywords: '공지사항 인계 전달' },
      { path: 'checklists', label: '오픈·마감 체크', icon: 'list-checks', page: 'checklists', keywords: '체크리스트 오픈 마감 점검' },
      { path: 'comms', label: '소통 도우미', icon: 'message-square-text', page: 'comms', keywords: '전화 응대 스크립트 리뷰 답글 문자 안내문 템플릿' },
    ],
  },
  {
    title: '재고·구매',
    items: [
      { path: 'inventory', label: '재고', icon: 'package', page: 'inventory', keywords: '재료 소모품 입고 출고 유효기간' },
      { path: 'orders', label: '발주서', icon: 'shopping-cart', page: 'orders', role: 'manager', keywords: '주문 구매 발주' },
      { path: 'vendors', label: '거래처', icon: 'truck', page: 'vendors', keywords: '업체 공급처 기공소' },
    ],
  },
  {
    title: '행정·서류',
    items: [
      { path: 'documents', label: 'AI 문서 작성', icon: 'file-text', page: 'documents', keywords: '공문 안내문 규정 매뉴얼 문서함' },
      { path: 'minutes', label: '회의록', icon: 'notebook-pen', page: 'minutes', keywords: '회의 요약 할일' },
      { path: 'forms', label: '서식 보관함', icon: 'folder-open', page: 'forms', keywords: '양식 파일 서류' },
    ],
  },
  {
    title: '인사·근무',
    items: [
      { path: 'schedule', label: '근무표', icon: 'calendar-days', page: 'schedule', keywords: '스케줄 근무 시프트' },
      { path: 'leave', label: '연차·휴가', icon: 'calendar-check', page: 'leave', keywords: '휴가 연차 반차 승인' },
      { path: 'training', label: '교육 이수', icon: 'graduation-cap', page: 'training', keywords: '법정 의무 교육' },
      { path: 'onboarding', label: '온보딩', icon: 'user-plus', page: 'onboarding', keywords: '신규 직원 입사' },
    ],
  },
  {
    title: '시설·법정',
    items: [
      { path: 'equipment', label: '장비·점검', icon: 'wrench', page: 'equipment', keywords: '유지보수 수리 AS 장비' },
      { path: 'sterilization', label: '멸균기 기록', icon: 'thermometer', page: 'sterilization', keywords: '오토클레이브 멸균 BI CI' },
      { path: 'compliance', label: '법정 일정', icon: 'shield-check', page: 'compliance', keywords: '방사선 소방 감염 의무 점검 교육' },
    ],
  },
  {
    title: '운영',
    items: [
      { path: 'expenses', label: '지출·월별 요약', icon: 'wallet', page: 'expenses', role: 'manager', keywords: '비용 지출 경비 카드' },
      { path: 'assistant', label: '원내 AI 도우미', icon: 'bot', page: 'assistant', keywords: '질문 매뉴얼 규정 검색' },
    ],
  },
  {
    title: '관리',
    items: [
      { path: 'admin', label: '관리', icon: 'settings', page: 'admin', role: 'manager', keywords: '사용자 권한 AI 설정 백업 복원 활동기록 사용량 초기화' },
    ],
  },
];

// 메뉴에는 없지만 주소로 열 수 있는 화면
export const HIDDEN = [{ path: 'me', label: '내 정보', icon: 'user', page: 'me' }];

export function allRoutes() {
  return [...NAV.flatMap((g) => g.items), ...HIDDEN];
}

/** 주소 첫 부분으로 화면 찾기 */
export function findRoute(parts) {
  const first = parts[0] || '';
  return allRoutes().find((r) => r.path === first) || null;
}
