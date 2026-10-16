/*
 * 이 파일이 하는 일: [E. 시설·법정] 모듈 안의 여러 파일(장비·멸균·법정 일정)이 함께 쓰는 작은 도우미와 정해진 값 목록입니다.
 */
const { get } = require('../../core/db');
const { badRequest } = require('../../core/errors');
const pii = require('../../ai/pii');

// ---------- 정해진 값 목록 (화면 선택칸과 서버 검사에 똑같이 씀) ----------
const EQUIP_CATEGORIES = ['유니트체어', '멸균기', '방사선 장비', '컴프레서', '석션', '핸드피스', '구강스캐너', '기타'];
const EQUIP_STATUS = ['정상', '점검 필요', '수리 중', '사용 중지'];
const LOG_TYPES = ['정기 점검', '수리', '부품 교체', '법정 검사', '기타'];
// 점검일(마지막 점검일)을 새로 고치는 기록 종류
const INSPECTION_TYPES = ['정기 점검', '법정 검사'];

const PROGRAMS = ['일반', '파우치', '고속', '기타'];
const CI_RESULTS = ['pass', 'fail', 'na'];
const BI_RESULTS = ['pass', 'fail', 'pending', 'na'];
const BD_RESULTS = ['pass', 'fail', 'na'];

const COMPLIANCE_CATEGORIES = ['방사선', '감염관리', '소방·안전', '개인정보', '의료폐기물', '노무·교육', '면허·신고', '시설', '기타'];

/** 이 DB에 해당 표가 있는지 (거래처 표는 재고 모듈이 만들기 때문에, 없을 때도 안전하게 동작하려고 확인) */
function tableExists(name) {
  try {
    return !!get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?", name);
  } catch {
    return false;
  }
}

/**
 * 표를 만들 때 거래처(vendors) 표가 이미 있으면 "거래처가 지워지면 비움" 연결을 걸고, 없으면 그냥 숫자 칸으로 둡니다.
 * (거래처 표가 없는 상태에서 연결을 걸면 저장할 때마다 오류가 나기 때문)
 */
function vendorRef() {
  return tableExists('vendors') ? ' REFERENCES vendors(id) ON DELETE SET NULL' : '';
}

/** 거래처 이름을 함께 불러오는 SQL 조각. 거래처 표가 없으면 이름은 비워 둠 */
function vendorJoin(alias, col = 'vendor_id') {
  if (tableExists('vendors')) return { select: 'vd.name AS vendor_name', join: `LEFT JOIN vendors vd ON vd.id = ${alias}.${col}` };
  return { select: 'NULL AS vendor_name', join: '' };
}

/** 거래처 번호가 실제로 있는지 확인 (없는 번호면 400) */
function checkVendor(id) {
  if (id === null || id === undefined) return null;
  if (!tableExists('vendors') || !get('SELECT id FROM vendors WHERE id = ?', id)) throw badRequest('거래처: 선택한 거래처를 찾을 수 없습니다.', { field: 'vendorId' });
  return id;
}

/**
 * 환자 정보가 들어가면 안 되는 칸(멸균 기록의 적재물·메모 등)을 검사합니다.
 * 전화번호·주민번호·차트번호·"OOO 환자" 같은 내용이 보이면 저장하지 않고 안내합니다.
 */
function rejectPatientInfo(text, label, field) {
  if (!text) return;
  const r = pii.scanText(text, {});
  if (r.findings.length) {
    const kinds = r.findings.map((f) => f.label).join(', ');
    throw badRequest(`${label}: 환자 정보로 보이는 내용(${kinds})이 있습니다. 이 기록에는 환자 정보를 적지 않습니다. (예: "기구 파우치 25개")`, { field });
  }
}

module.exports = {
  EQUIP_CATEGORIES,
  EQUIP_STATUS,
  LOG_TYPES,
  INSPECTION_TYPES,
  PROGRAMS,
  CI_RESULTS,
  BI_RESULTS,
  BD_RESULTS,
  COMPLIANCE_CATEGORIES,
  tableExists,
  vendorRef,
  vendorJoin,
  checkVendor,
  rejectPatientInfo,
};
