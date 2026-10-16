/*
 * 이 파일이 하는 일: [E. 시설·법정 관리] 모듈의 입구입니다. 표 만들기(마이그레이션), API 등록, 대시보드 요약을 모읍니다.
 *
 *   기능별 실제 코드는 같은 폴더의 파일에 나뉘어 있습니다.
 *     equipment.js      장비 목록 + 점검·수리 이력 (화면: #/equipment)
 *     sterilization.js  멸균기 기록 — 환자 정보 없음 (화면: #/sterilization)
 *     compliance.js     법정 정기 일정 (화면: #/compliance)
 *     seed.js           데모 데이터
 *     common.js         공통 값 목록·도우미
 */
const time = require('../../core/time');
const C = require('./common');
const equipment = require('./equipment');
const sterilization = require('./sterilization');
const compliance = require('./compliance');
const { seed, starter } = require('./seed');

const migrations = [
  {
    id: 'facility_001',
    // 거래처(vendors) 표가 있을 때만 연결을 겁니다. (표를 만드는 순간에 확인하려고 getter 사용)
    get up() {
      return `
      CREATE TABLE equipment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '기타',
        model TEXT,
        serial_no TEXT,
        location TEXT,
        vendor_id INTEGER${C.vendorRef()},
        as_contact TEXT,                         -- 업체 AS 연락처 (업체 전화번호 등)
        install_date TEXT,
        warranty_until TEXT,
        inspection_cycle_days INTEGER,           -- 점검 주기(일)
        last_inspected TEXT,                     -- 마지막 점검일 → 다음 점검일 = 이 날 + 주기
        status TEXT NOT NULL DEFAULT '정상' CHECK (status IN ('정상','점검 필요','수리 중','사용 중지')),
        memo TEXT,
        active INTEGER NOT NULL DEFAULT 1,       -- 0 = 보관(더 쓰지 않는 장비)
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE equipment_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('정기 점검','수리','부품 교체','법정 검사','기타')),
        description TEXT NOT NULL DEFAULT '',
        cost INTEGER,
        vendor_name TEXT,
        performed_by TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_equipment_logs ON equipment_logs(equipment_id, date);

      -- 멸균 기록: 환자 정보 칸 없음. 적재물은 "기구 파우치 25개" 처럼 물건만 적음
      CREATE TABLE sterilization_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        sterilizer_id INTEGER NOT NULL REFERENCES equipment(id),
        cycle_no INTEGER NOT NULL,               -- 그날 그 멸균기의 몇 번째 회차
        program TEXT NOT NULL DEFAULT '일반' CHECK (program IN ('일반','파우치','고속','기타')),
        temperature REAL,                        -- ℃
        pressure REAL,                           -- kPa (게이지 압력)
        duration_min INTEGER,                    -- 멸균 시간(분)
        ci_result TEXT NOT NULL DEFAULT 'pass' CHECK (ci_result IN ('pass','fail','na')),             -- 화학적 지시계
        bi_result TEXT NOT NULL DEFAULT 'na' CHECK (bi_result IN ('pass','fail','pending','na')),     -- 생물학적 지시계
        bowie_dick TEXT NOT NULL DEFAULT 'na' CHECK (bowie_dick IN ('pass','fail','na')),             -- 보위딕(진공) 시험
        load_desc TEXT,
        operator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        note TEXT,
        resolved_at TEXT,                        -- 실패 기록에 조치를 남긴 시각 (남기면 경고 해제)
        resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action_note TEXT,                        -- 조치 내용 (재멸균, 장비 점검, 사용 보류 등)
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_ster_date ON sterilization_logs(date, sterilizer_id, cycle_no);

      CREATE TABLE compliance_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '기타',
        legal_basis TEXT,
        cycle_months INTEGER,                    -- 비어 있으면 수시·일회성
        needs_check INTEGER NOT NULL DEFAULT 0,  -- 1 = "주기 확인 필요"
        internal INTEGER NOT NULL DEFAULT 0,     -- 1 = 법정 의무가 아닌 원내 자체 기준
        last_done TEXT,
        next_due TEXT,
        owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        notes TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE compliance_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES compliance_tasks(id) ON DELETE CASCADE,
        done_date TEXT NOT NULL,
        note TEXT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        prev_last_done TEXT,                     -- 완료 취소 때 되돌릴 이전 값
        prev_next_due TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_compliance_logs ON compliance_logs(task_id, done_date);
    `;
    },
  },
];

function register(r) {
  equipment.register(r);
  sterilization.register(r);
  compliance.register(r);
}

// ---------- 대시보드 ----------
function dashboard() {
  const today = time.today();
  const upcoming = [];
  const alerts = [];
  const todos = [];

  for (const e of equipment.dueSoon()) {
    upcoming.push({
      id: `equipment-${e.id}`,
      module: 'facility',
      title: `${e.name} 점검`,
      date: e.nextDue,
      dday: e.dday,
      detail: e.dday < 0 ? `점검일 ${-e.dday}일 지남` : `${e.category} · ${e.location || ''}`.replace(/ · $/, ''),
      href: `#/equipment/${e.id}`,
      icon: 'wrench',
    });
  }

  const tasks = compliance.dueSoon();
  for (const t of tasks) {
    upcoming.push({
      id: `compliance-${t.id}`,
      module: 'facility',
      title: t.name,
      date: t.nextDue,
      dday: t.dday,
      detail: [t.dday < 0 ? '기한 지남' : t.cycleLabel, t.needsCheck ? '주기 확인 필요' : null].filter(Boolean).join(' · '),
      href: `#/compliance/${t.id}`,
      icon: 'shield-check',
    });
  }
  const overdue = tasks.filter((t) => t.dday < 0);
  if (overdue.length) {
    todos.push({
      id: 'compliance-overdue',
      module: 'facility',
      title: `기한 지난 법정 일정 ${overdue.length}건`,
      detail: overdue.slice(0, 2).map((t) => t.name).join(', ') + (overdue.length > 2 ? ' 외' : ''),
      href: '#/compliance?status=overdue',
      level: 'danger',
      icon: 'shield-check',
    });
  }

  const s = sterilization.dashboardInfo(today);
  for (const f of s.failures) {
    const which = [f.ci_result === 'fail' && 'CI', f.bi_result === 'fail' && 'BI', f.bowie_dick === 'fail' && '보위딕'].filter(Boolean).join('·');
    alerts.push({
      id: `ster-fail-${f.id}`,
      module: 'facility',
      title: `멸균 불합격: ${f.sterilizer_name || '멸균기'} ${f.cycle_no}회차 (${which})`,
      detail: f.resolved_at ? `${f.date} · 조치 완료` : `${f.date} · 재멸균·장비 점검·사용 보류 후 조치 내용을 기록해 주세요`,
      href: '#/sterilization',
      level: f.resolved_at ? 'warn' : 'danger',
      badge: f.resolved_at ? '조치됨' : '조치 필요',
    });
  }
  // 평일(월~금)인데 오늘 멸균 기록이 없으면 알림
  const wd = time.weekday(today);
  if (s.hasSterilizer && wd >= 1 && wd <= 5 && s.todayCount === 0) {
    todos.push({ id: 'ster-today', module: 'facility', title: '오늘 멸균 기록이 없습니다', detail: '멸균기를 돌린 뒤 바로 기록해 주세요.', href: '#/sterilization', level: 'info', icon: 'thermometer' });
  }
  if (s.biPending > 0) {
    todos.push({ id: 'ster-bi', module: 'facility', title: `BI 결과 확인 대기 ${s.biPending}건`, detail: '배양이 끝나면 결과를 입력해 주세요.', href: '#/sterilization', level: 'info', icon: 'thermometer' });
  }
  return { upcoming, alerts, todos };
}

module.exports = {
  name: 'facility',
  migrations,
  register,
  aiFeatures: [],
  seed,
  starter,
  resetTables: ['compliance_logs', 'compliance_tasks', 'sterilization_logs', 'equipment_logs', 'equipment'],
  dashboard,
};
