/*
 * 이 파일이 하는 일: [D. 인사·근무] 모듈의 DB 표를 만듭니다. (근무표, 공휴일, 연차·휴가, 교육 이수, 온보딩)
 *
 *  ※ 개인정보 원칙: 직원 정보는 core 의 users 표(이름·직종·입사일 등)만 참조합니다.
 *    휴가 "사유"는 짧은 선택 입력(최대 60자)이며, 병명 같은 자세한 의료 정보는 적지 않도록 화면에서 안내합니다.
 *
 *  기본값으로 함께 넣는 것 (데모 데이터가 아니라 실제로 쓰는 기본 설정)
 *   - 근무 유형 5가지 (종일/오전/오후/야간/휴무)
 *   - 2026~2027년 날짜가 고정된 공휴일 8개씩 (설날·추석·대체공휴일·선거일은 해마다 달라 사용자가 직접 추가)
 *   - 치과에서 흔히 챙기는 교육 항목 8개 (주기가 확실하지 않은 것은 "주기 확인 필요" 표시)
 *   이미 배포된 마이그레이션은 고치지 말고 새 id(hr_002 …)를 뒤에 추가하세요.
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

/** 날짜가 고정된 공휴일 (음력·대체공휴일 제외) */
const FIXED_HOLIDAYS = [
  ['01-01', '신정'],
  ['03-01', '삼일절'],
  ['05-05', '어린이날'],
  ['06-06', '현충일'],
  ['08-15', '광복절'],
  ['10-03', '개천절'],
  ['10-09', '한글날'],
  ['12-25', '성탄절'],
];

const DEFAULT_SHIFTS = [
  // code(칸에 보이는 짧은 글자), name, start, end, hours, color, is_off, sort
  ['종일', '종일 근무', '09:30', '18:30', 8, '#2f6fed', 0, 1],
  ['오전', '오전 근무', '09:30', '14:00', 4.5, '#0ea5e9', 0, 2],
  ['오후', '오후 근무', '14:00', '18:30', 4.5, '#14b8a6', 0, 3],
  ['야간', '야간진료', '11:30', '20:00', 7.5, '#8b5cf6', 0, 4],
  ['휴무', '휴무', null, null, 0, '#94a3b8', 1, 5],
];

const DEFAULT_TRAININGS = [
  // name, category, cycle_months, needs_check, required_for, description, legal_note, sort
  ['개인정보보호 교육', '법정 의무', 12, 1, 'all', '개인정보를 다루는 직원 대상 교육 (온라인 무료 과정 이용 가능)', '개인정보 보호법상 개인정보취급자 교육 — 법정 주기·방법은 확인 필요', 1],
  ['직장 내 성희롱 예방교육', '법정 의무', 12, 0, 'all', '전 직원 대상, 연 1회 이상', '남녀고용평등법 — 사업주 포함 전 직원 연 1회 이상', 2],
  ['장애인 인식개선 교육', '법정 의무', 12, 0, 'all', '전 직원 대상, 연 1회 이상', '장애인고용촉진법 — 연 1회 이상', 3],
  ['산업안전보건교육', '법정 의무', null, 1, 'all', '업종·규모에 따라 대상과 시간이 다릅니다', '산업안전보건법 — 의료기관 적용 범위·주기는 확인 필요', 4],
  ['방사선 관계 종사자 안전교육', '법정 의무', null, 1, '원장,치과위생사', '진단용 방사선 발생장치 관련 안전관리 교육', '의료법·진단용 방사선 안전관리 규칙 — 대상자·주기는 확인 필요', 5],
  ['감염관리 교육', '법정 의무', 12, 1, 'all', '손위생, 기구 멸균, 개인보호구 등', '의료기관 감염관리 관련 — 치과의원 적용 기준·주기는 확인 필요', 6],
  ['소방 안전교육', '법정 의무', null, 1, 'all', '소화기 사용법, 대피 경로', '소방 관련 법령 — 건물·규모에 따라 다름, 확인 필요', 7],
  ['퇴직연금 교육', '법정 의무', 12, 0, 'all', '퇴직연금 제도를 도입한 사업장만 해당', '근로자퇴직급여 보장법 — 퇴직연금 도입 사업장 연 1회 이상 (해당 사업장)', 8],
];

const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);

function defaultRowsSql() {
  const shifts = DEFAULT_SHIFTS.map(
    ([code, name, st, en, hours, color, off, sort]) =>
      `INSERT INTO shift_types (code, name, start_time, end_time, hours, color, is_off, sort, created_at, updated_at)
       VALUES (${q(code)}, ${q(name)}, ${q(st)}, ${q(en)}, ${hours}, ${q(color)}, ${off}, ${sort}, ${NOW}, ${NOW});`
  );
  const hol = [];
  for (const y of [2026, 2027]) {
    for (const [md, name] of FIXED_HOLIDAYS) hol.push(`INSERT INTO holidays (date, name, created_at) VALUES ('${y}-${md}', ${q(name)}, ${NOW});`);
  }
  const tr = DEFAULT_TRAININGS.map(
    ([name, cat, cycle, check, req, desc, note, sort]) =>
      `INSERT INTO trainings (name, category, cycle_months, needs_check, required_for, description, legal_note, sort, created_at, updated_at)
       VALUES (${q(name)}, ${q(cat)}, ${cycle === null ? 'NULL' : cycle}, ${check}, ${q(req)}, ${q(desc)}, ${q(note)}, ${sort}, ${NOW}, ${NOW});`
  );
  return [...shifts, ...hol, ...tr].join('\n');
}

const migrations = [
  {
    id: 'hr_001',
    up: `
      -- 근무 유형 (종일, 오전, 오후, 야간, 휴무 …)
      CREATE TABLE shift_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,                       -- 근무표 칸에 보이는 짧은 이름 (예: 종일)
        name TEXT NOT NULL,                       -- 전체 이름 (예: 종일 근무)
        start_time TEXT,                          -- 'HH:MM'
        end_time TEXT,
        hours REAL NOT NULL DEFAULT 0,            -- 근무 시간 (합계 계산용)
        color TEXT NOT NULL DEFAULT '#2f6fed',
        is_off INTEGER NOT NULL DEFAULT 0,        -- 1이면 쉬는 날(휴무)로 셈
        sort INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,      -- 지난 근무표에서 쓰인 유형은 지우지 않고 숨김
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      -- 근무표 칸 하나 = 직원 한 명의 하루
      CREATE TABLE schedule_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        shift_type_id INTEGER NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
        note TEXT,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, date)
      );
      CREATE INDEX idx_schedule_date ON schedule_entries(date);
      -- 공휴일 (실장 이상이 추가·삭제)
      CREATE TABLE holidays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      -- 연차·휴가 신청
      CREATE TABLE leave_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('연차','오전 반차','오후 반차','병가','경조사','공가','기타')),
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        days REAL NOT NULL,                       -- 서버가 계산 (휴진일·공휴일 제외, 반차 0.5)
        reason TEXT,                              -- 짧은 선택 입력 (예: 개인 사유). 의료 정보는 적지 않음
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        decided_at TEXT,
        decision_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_leave_dates ON leave_requests(start_date, end_date);
      CREATE INDEX idx_leave_user ON leave_requests(user_id, status);
      -- 연차 부여 일수 직접 수정 (입사일 기준 기간이 시작한 해 = year)
      CREATE TABLE leave_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        year INTEGER NOT NULL,
        days REAL NOT NULL,
        note TEXT,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, year)
      );
      -- 교육 항목
      CREATE TABLE trainings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '법정 의무' CHECK (category IN ('법정 의무','직무','기타')),
        cycle_months INTEGER,                     -- 몇 개월마다 다시 받는지 (비어 있으면 주기 없음/모름)
        needs_check INTEGER NOT NULL DEFAULT 0,   -- 1이면 "주기 확인 필요" 표시
        required_for TEXT NOT NULL DEFAULT 'all', -- 'all' 또는 직종 이름(쉼표로 여러 개)
        description TEXT,
        legal_note TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE training_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        completed_date TEXT NOT NULL,
        hours REAL,
        provider TEXT,                            -- 교육 기관
        memo TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_training_records ON training_records(training_id, user_id, completed_date);
      -- 온보딩 템플릿과 항목
      CREATE TABLE onboarding_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        job_title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE onboarding_template_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL REFERENCES onboarding_templates(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT '첫날' CHECK (phase IN ('첫날','첫 주','첫 달')),
        owner_role TEXT,                          -- 누가 챙기는지 (원장/실장/담당 선배/본인)
        sort INTEGER NOT NULL DEFAULT 0
      );
      -- 직원별 온보딩 진행
      CREATE TABLE onboarding_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        template_id INTEGER NOT NULL REFERENCES onboarding_templates(id),
        start_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','cancelled')),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE onboarding_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES onboarding_runs(id) ON DELETE CASCADE,
        item_id INTEGER NOT NULL REFERENCES onboarding_template_items(id) ON DELETE CASCADE,
        done_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        done_at TEXT NOT NULL,
        note TEXT,
        UNIQUE (run_id, item_id)
      );
      ${defaultRowsSql()}
    `,
  },
];

module.exports = { migrations, FIXED_HOLIDAYS, DEFAULT_SHIFTS, DEFAULT_TRAININGS };
