/*
 * 이 파일이 하는 일: 데모(시연)용 예시 데이터를 넣고, "초기화" 때 업무 데이터를 지웁니다.
 *
 *  - 가상의 "하늘치과의원"과 가상 직원으로 예시 데이터를 만듭니다. 환자 데이터는 예시로도 넣지 않습니다.
 *  - 데모 직원은 로그인 계정이 없는 "명부용" 직원입니다(근무표·연차 예시용). is_demo=1 로 표시해 초기화 때 지웁니다.
 *  - 실제 로그인 계정(첫 설정에서 만든 관리자 등)과 설정(병원 정보, AI 키)은 초기화해도 남습니다.
 */
const { get, run, tx } = require('./core/db');
const { patchSetting, getSetting } = require('./core/settings');
const time = require('./core/time');

const DEMO_STAFF = [
  { key: 'manager', name: '박지민', role: 'manager', job: '실장', hire: -1460, color: '#6366f1' },
  { key: 'hyg1', name: '이서연', role: 'staff', job: '치과위생사', hire: -1100, color: '#0ea5e9' },
  { key: 'hyg2', name: '최유나', role: 'staff', job: '치과위생사', hire: -620, color: '#14b8a6' },
  { key: 'hyg3', name: '정다은', role: 'staff', job: '치과위생사', hire: -150, color: '#22c55e' },
  { key: 'nurse', name: '한소희', role: 'staff', job: '간호조무사', hire: -900, color: '#f59e0b' },
  { key: 'desk', name: '오민지', role: 'staff', job: '기타', hire: -45, color: '#ec4899' },
];

function modules() {
  // 순환 참조를 피하려고 필요할 때 불러옴
  return require('./modules');
}

/** 데모 데이터 넣기 */
function seedDemo() {
  const today = time.today();
  tx(() => {
    // 병원 정보가 비어 있으면 가상 병원 정보로 채움
    const clinic = getSetting('clinic');
    patchSetting('clinic', {
      name: clinic.name || '하늘치과의원',
      phone: clinic.phone || '02-555-0123',
      address: clinic.address || '서울특별시 가상구 하늘로 123, 하늘빌딩 3층',
      parking: clinic.parking || '건물 지하 1~2층 주차장 이용 가능 (진료 시 2시간 무료, 데스크에서 주차 등록)',
      directions: clinic.directions || '하늘역 2번 출구에서 도보 3분, 1층에 하늘약국이 있는 건물',
      insuranceNote:
        clinic.insuranceNote ||
        '스케일링은 만 19세 이상 연 1회 건강보험 적용(본인부담 있음). 치료별 보험 적용 여부와 금액은 진료 후 상담 시 정확히 안내드립니다.',
      representative: clinic.representative || '김하늘',
    });

    const now = new Date().toISOString();
    const users = {};
    const admin = get("SELECT id FROM users WHERE role = 'admin' AND password_hash IS NOT NULL ORDER BY id LIMIT 1");
    users.admin = admin ? admin.id : null;
    for (const s of DEMO_STAFF) {
      const exists = get('SELECT id FROM users WHERE name = ? AND is_demo = 1', s.name);
      if (exists) {
        users[s.key] = exists.id;
        continue;
      }
      const info = run(
        `INSERT INTO users (name, role, job_title, hire_date, status, color, is_demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, 1, ?, ?)`,
        s.name,
        s.role,
        s.job,
        time.addDays(today, s.hire),
        s.color,
        now,
        now
      );
      users[s.key] = info.lastInsertRowid;
    }
    if (!users.admin) users.admin = users.manager;
    const ctx = { users, today, staffIds: Object.values(users).filter(Boolean) };
    for (const m of modules()) {
      if (m.seed) m.seed(ctx);
    }
  });
}

/**
 * 실제 사용을 시작할 때 넣는 "기본 서식" (데모 데이터가 아님)
 *  - 법정 일정 기본 항목(날짜 비움), 오픈·마감·주간 체크리스트 템플릿, 전화 응대 스크립트·문자 템플릿, 온보딩 템플릿
 *  - 데모 없이 첫 설정을 했을 때와, 관리 → 초기화 직후에 넣습니다. (데모 데이터에는 이미 들어 있음)
 */
function seedStarter() {
  const admin = get("SELECT id FROM users WHERE role = 'admin' AND password_hash IS NOT NULL ORDER BY id LIMIT 1");
  const ctx = { users: { admin: admin ? admin.id : null }, today: time.today(), staffIds: admin ? [admin.id] : [] };
  tx(() => {
    for (const m of modules()) if (m.starter) m.starter(ctx);
  });
}

/** 업무 데이터 모두 지우기 (사용자 계정·설정·활동 기록·AI 사용 기록은 유지) 후 기본 서식 다시 넣기 */
function resetBusinessData({ starter = true } = {}) {
  tx(() => {
    const mods = [...modules()].reverse();
    for (const m of mods) {
      for (const t of m.resetTables || []) run(`DELETE FROM ${t}`);
    }
    // 데모 직원 삭제 (참조하던 기록은 위에서 이미 지움)
    run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE is_demo = 1)');
    run('DELETE FROM users WHERE is_demo = 1');
    if (starter) seedStarter();
  });
}

/** 데모 데이터가 들어 있는지 */
function hasDemoData() {
  return get('SELECT COUNT(*) AS n FROM users WHERE is_demo = 1').n > 0;
}

module.exports = { seedDemo, seedStarter, resetBusinessData, hasDemoData, DEMO_STAFF };
