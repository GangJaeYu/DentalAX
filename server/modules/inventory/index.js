/*
 * 이 파일이 하는 일: [B. 재고·구매] 모듈의 입구입니다. 같은 폴더의 파일들을 모아 서버에 알려 줍니다.
 *
 *   schema.js          DB 표 만들기 (거래처·품목·로트·입출고·단가·발주서)
 *   stock.js           재고 계산의 핵심 (입고, 출고 선입선출, 실사 조정, 경고)
 *   views.js           DB 줄 → 화면용 모양 바꾸기
 *   routes-items.js    품목·입출고·경고·단가·CSV API
 *   routes-orders.js   발주서 API (자동 발주, 발주 → 입고)
 *   routes-vendors.js  거래처 API
 *   csvimport.js       CSV 가져오기(미리보기·확정)·내보내기
 *   ai.js              AI: 거래명세서 인식, 거래처 발주 메시지
 *   dashboard.js       대시보드 요약 (부족·유효기간 경고, 발주 할 일)
 *   seed.js            데모 데이터
 *
 * API 주소는 모두 /api/inventory/... 입니다. (자세한 목록은 routes-*.js 맨 위 설명)
 * 권한: 보기·입고·출고는 누구나 / 품목 편집·실사 조정·CSV 가져오기·거래처 편집·발주서는 실장 이상
 */
const { migrations } = require('./schema');
const items = require('./routes-items');
const ordersRoutes = require('./routes-orders');
const vendors = require('./routes-vendors');
const { aiFeatures } = require('./ai');
const { dashboard } = require('./dashboard');
const { seed } = require('./seed');

function register(router) {
  items.register(router);
  ordersRoutes.register(router);
  vendors.register(router);
}

module.exports = {
  name: 'inventory',
  migrations,
  register,
  aiFeatures,
  seed,
  dashboard,
  // 초기화할 때 지우는 순서: 다른 표를 참조하는 표부터
  resetTables: ['inv_moves', 'inv_prices', 'inv_lots', 'purchase_order_items', 'purchase_orders', 'inv_items', 'vendors'],
};
