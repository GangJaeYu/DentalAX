/*
 * 이 파일이 하는 일: [B. 재고·구매] 모듈이 쓰는 DB 표(테이블)를 만듭니다. (마이그레이션)
 *
 *   vendors               거래처 (재료상·기공소·장비업체…) — 지출·시설 모듈도 이 표를 참조합니다.
 *   inv_items             재고 품목 (현재 수량, 적정 재고, 최근 단가 …)
 *   inv_lots              로트(묶음)별 남은 수량과 유효기간 — 출고할 때 유효기간이 빠른 것부터 차감
 *   inv_moves             입고·출고·실사 조정 기록 (누가, 언제, 얼마나)
 *   inv_prices            단가 기록 (입고할 때 단가가 바뀌면 자동으로 쌓임)
 *   purchase_orders       발주서 (작성 중 → 발주함 → 입고 완료 / 취소)
 *   purchase_order_items  발주서에 들어간 품목 줄
 *
 * 주의: 이미 배포된 마이그레이션(inventory_001)은 고치지 말고, 바꿀 것이 생기면 inventory_002 처럼 새로 추가합니다.
 * 환자 정보 칸은 만들지 않습니다.
 */
const migrations = [
  {
    id: 'inventory_001',
    up: `
      CREATE TABLE vendors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '재료상',
        contact_name TEXT,                 -- 업체 담당자 (업무 연락처라 저장 가능)
        phone TEXT,
        email TEXT,
        order_method TEXT NOT NULL DEFAULT '전화',
        website TEXT,
        payment_terms TEXT,                -- 결제 조건 (예: 월말 마감 익월 10일 이체)
        memo TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_vendors_active ON vendors(active, name);

      CREATE TABLE inv_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '소모품',
        unit TEXT NOT NULL DEFAULT '개',
        spec TEXT,
        vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
        min_qty REAL NOT NULL DEFAULT 0,       -- 적정 재고(최소). 이 수량 이하이면 "부족"
        reorder_qty REAL NOT NULL DEFAULT 0,   -- 한 번에 주문할 수량 (0이면 자동 계산)
        location TEXT,
        current_qty REAL NOT NULL DEFAULT 0,
        track_expiry INTEGER NOT NULL DEFAULT 0,
        last_unit_price INTEGER,
        memo TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_inv_items_active ON inv_items(active, category, name);
      CREATE INDEX idx_inv_items_vendor ON inv_items(vendor_id);

      CREATE TABLE inv_lots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES inv_items(id) ON DELETE CASCADE,
        lot_no TEXT,
        expiry_date TEXT,
        qty_remaining REAL NOT NULL DEFAULT 0,
        received_at TEXT NOT NULL
      );
      CREATE INDEX idx_inv_lots_item ON inv_lots(item_id, qty_remaining);
      CREATE INDEX idx_inv_lots_expiry ON inv_lots(expiry_date);

      CREATE TABLE purchase_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        po_no TEXT NOT NULL UNIQUE,
        vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','received','cancelled')),
        order_date TEXT,
        expected_date TEXT,
        received_date TEXT,
        note TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_po_status ON purchase_orders(status, created_at);
      CREATE INDEX idx_po_vendor ON purchase_orders(vendor_id);

      CREATE TABLE purchase_order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        item_id INTEGER NOT NULL REFERENCES inv_items(id),
        qty REAL NOT NULL,
        unit_price INTEGER,
        received_qty REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_poi_po ON purchase_order_items(po_id);
      CREATE INDEX idx_poi_item ON purchase_order_items(item_id);

      CREATE TABLE inv_moves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES inv_items(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('in','out','adjust')),
        qty REAL NOT NULL,                     -- 늘어난 양은 +, 줄어든 양은 - (입고 +, 출고 -, 조정 ±)
        balance_after REAL,                    -- 이 기록 직후의 재고
        unit_price INTEGER,
        lot_id INTEGER REFERENCES inv_lots(id) ON DELETE SET NULL,
        lot_no TEXT,                           -- 화면 표시용 로트 번호 (여러 로트에서 차감했으면 요약 글)
        expiry_date TEXT,
        lots_json TEXT,                        -- 어떤 로트에서 얼마나 빠졌는지 (기록 취소할 때 되돌리기용)
        vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
        po_id INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
        note TEXT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        move_date TEXT NOT NULL,               -- 'YYYY-MM-DD' (원내 PC 날짜 기준, 기간 검색용)
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_inv_moves_item ON inv_moves(item_id, id);
      CREATE INDEX idx_inv_moves_date ON inv_moves(move_date, type);

      CREATE TABLE inv_prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES inv_items(id) ON DELETE CASCADE,
        vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
        unit_price INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,             -- 'YYYY-MM-DD'
        source TEXT NOT NULL DEFAULT '입고' CHECK (source IN ('입고','수동'))
      );
      CREATE INDEX idx_inv_prices_item ON inv_prices(item_id, recorded_at);
    `,
  },
];

module.exports = { migrations };
