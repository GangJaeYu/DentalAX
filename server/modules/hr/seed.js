/*
 * 이 파일이 하는 일: [D. 인사·근무] 데모(시연)용 예시 데이터를 넣습니다. 날짜는 모두 오늘(ctx.today) 기준 상대값입니다.
 *
 *   - 근무표: 이번 달 + 다음 달, 원장 포함 전 직원
 *       평일 종일 / 목요일 야간진료 2명씩 교대(원장은 매주) / 토요일 오전 두 조 격주 교대(쉬는 조는 휴무) / 일요일 휴진
 *   - 연차·휴가: 이번 달·다음 달 승인 몇 건, 승인 대기 2건, 반려·취소 각 1건, 부여 일수 직접 수정 1건
 *   - 교육 이수: 유효한 기록, 30일 안에 만료되는 기록 1건, 이미 만료된 기록 1건, 미이수 몇 칸
 *   - 온보딩: 치과위생사·데스크 템플릿, 입사 45일째인 오민지 님의 진행 중 온보딩(일부 완료)
 * 환자 정보는 예시로도 넣지 않습니다.
 */
const { all, get, run } = require('../../core/db');
const time = require('../../core/time');
const lib = require('./lib');
const { DEFAULT_SHIFTS, DEFAULT_TRAININGS } = require('./migrations');
const { saveEntry } = require('./schedule');

/** 기본 근무 유형·교육 항목이 지워졌다면 다시 넣기 (데모 데이터가 이를 참조하므로) */
function ensureDefaults() {
  const now = time.nowIso();
  for (const [code, name, st, en, hours, color, off, sort] of DEFAULT_SHIFTS) {
    if (!get('SELECT id FROM shift_types WHERE code = ? AND archived = 0', code)) {
      run('INSERT INTO shift_types (code, name, start_time, end_time, hours, color, is_off, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', code, name, st, en, hours, color, off, sort, now, now);
    }
  }
  for (const [name, cat, cycle, check, req, desc, note, sort] of DEFAULT_TRAININGS) {
    if (!get('SELECT id FROM trainings WHERE name = ?', name)) {
      run('INSERT INTO trainings (name, category, cycle_months, needs_check, required_for, description, legal_note, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', name, cat, cycle, check, req, desc, note, sort, now, now);
    }
  }
}

function seed(ctx) {
  const { users, today } = ctx;
  ensureDefaults();
  const shift = {};
  for (const s of all('SELECT id, code FROM shift_types WHERE archived = 0')) shift[s.code] = s.id;
  const hireOf = {};
  for (const u of all('SELECT id, hire_date FROM users')) hireOf[u.id] = u.hire_date;

  // ---------- 근무표 ----------
  const thisMonth = today.slice(0, 7);
  const first = `${thisMonth}-01`;
  const last = time.addDays(time.addMonths(first, 2), -1);
  const closed = lib.closedWeekdays();
  const hol = lib.holidayMap(first, last);
  const rotation = [users.hyg1, users.hyg2, users.hyg3, users.nurse]; // 목요일 야간 교대
  const satA = [users.hyg1, users.hyg3, users.desk]; // 토요일 오전 A조
  const satB = [users.manager, users.hyg2, users.nurse]; // 토요일 오전 B조
  const everyone = [users.admin, users.manager, users.hyg1, users.hyg2, users.hyg3, users.nurse, users.desk].filter(Boolean);
  for (const d of lib.dateRange(first, last)) {
    if (!lib.isClinicOpen(d, closed, hol)) continue;
    const wd = time.weekday(d);
    const week = Math.floor(time.diffDays('2024-01-01', d) / 7); // 2024-01-01 = 월요일 (교대 순번 계산용)
    for (const uid of everyone) {
      if (hireOf[uid] && d < hireOf[uid]) continue; // 입사 전 날짜는 비움
      let code = '종일';
      if (wd === 4) {
        const night = [rotation[(week * 2) % 4], rotation[(week * 2 + 1) % 4]];
        if (uid === users.admin || night.includes(uid)) code = '야간';
      } else if (wd === 6) {
        const group = week % 2 === 0 ? satA : satB;
        code = uid === users.admin || group.includes(uid) ? '오전' : '휴무';
      }
      saveEntry(uid, d, shift[code], null, users.admin);
    }
  }

  // ---------- 연차·휴가 ----------
  /** d 이후(포함) 첫 평일 진료일 */
  const weekdayFrom = (d) => {
    let x = d;
    for (let i = 0; i < 30; i++) {
      const wd = time.weekday(x);
      if (wd >= 1 && wd <= 5 && lib.isClinicOpen(x, lib.closedWeekdays(), lib.holidayMap(x, x))) return x;
      x = time.addDays(x, 1);
    }
    return d;
  };
  /** 시작일부터 진료일 n일째 되는 날 */
  const plusOpenDays = (d, n) => {
    let x = d;
    let left = n - 1;
    while (left > 0) {
      x = weekdayFrom(time.addDays(x, 1));
      left--;
    }
    return x;
  };
  const nowIso = time.nowIso();
  const addLeave = (userId, type, start, end, status, reason, extra = {}) => {
    const c = lib.countLeaveDays(type, start, end);
    if (c.days <= 0) return null;
    return run(
      `INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status, requested_by, decided_by, decided_at, decision_note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      type,
      start,
      c.endDate,
      c.days,
      reason,
      status,
      userId,
      status === 'approved' || status === 'rejected' ? users.manager : null,
      status === 'approved' || status === 'rejected' ? nowIso : null,
      extra.note || null,
      nowIso,
      nowIso
    ).lastInsertRowid;
  };
  const todayOff = weekdayFrom(today);
  addLeave(users.hyg2, '연차', todayOff, todayOff, 'approved', '개인 사유');
  const past = weekdayFrom(time.addDays(today, -12));
  addLeave(users.hyg1, '연차', past, plusOpenDays(past, 2), 'approved', '가족 행사');
  addLeave(users.hyg2, '연차', weekdayFrom(time.addDays(today, -60)), plusOpenDays(weekdayFrom(time.addDays(today, -60)), 3), 'approved', '여행');
  addLeave(users.hyg2, '병가', weekdayFrom(time.addDays(today, -30)), weekdayFrom(time.addDays(today, -30)), 'approved', '개인 사유');
  const soonDay = weekdayFrom(time.addDays(today, 8));
  addLeave(users.nurse, '오후 반차', soonDay, soonDay, 'approved', '개인 사유');
  const nextMonth = weekdayFrom(time.addDays(time.addMonths(first, 1), 6));
  addLeave(users.manager, '연차', nextMonth, plusOpenDays(nextMonth, 2), 'approved', '개인 사유');
  // 승인 대기 2건 (한 건은 한소희 님 반차와 같은 날 → 겹침 안내 예시)
  addLeave(users.hyg3, '연차', soonDay, soonDay, 'pending', '개인 사유');
  const deskDay = weekdayFrom(time.addDays(today, 13));
  addLeave(users.desk, '오전 반차', deskDay, deskDay, 'pending', '관공서 방문');
  // 반려·취소 예시
  addLeave(users.hyg1, '연차', soonDay, soonDay, 'rejected', '개인 사유', { note: '같은 날 휴가자가 있어 다른 날로 조정 부탁드립니다.' });
  const cancelled = weekdayFrom(time.addDays(today, -20));
  addLeave(users.nurse, '연차', cancelled, cancelled, 'cancelled', '개인 사유');
  // 부여 일수 직접 수정 예시 (실장: 근속 포상 1일)
  const mp = lib.leavePeriod(hireOf[users.manager], today);
  if (mp) {
    const base = lib.computedGrant(hireOf[users.manager], today);
    run('INSERT OR REPLACE INTO leave_grants (user_id, year, days, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)', users.manager, mp.year, base + 1, '근속 포상 1일 추가', users.admin, nowIso);
  }

  // ---------- 교육 이수 ----------
  const tid = {};
  for (const t of all('SELECT id, name FROM trainings')) tid[t.name] = t.id;
  const rec = (name, uids, daysAgo, hours, provider, memo) => {
    for (const uid of uids.filter(Boolean)) {
      run(
        'INSERT INTO training_records (training_id, user_id, completed_date, hours, provider, memo, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        tid[name],
        uid,
        time.addDays(today, -daysAgo),
        hours,
        provider,
        memo || null,
        users.manager,
        nowIso
      );
    }
  };
  const { admin, manager, hyg1, hyg2, hyg3, nurse, desk } = users;
  rec('개인정보보호 교육', [admin, manager, hyg1], 200, 1, '온라인 무료 과정', '수료증 서식 보관함에 보관');
  rec('개인정보보호 교육', [hyg2], 350, 1, '온라인 무료 과정'); // 30일 안에 만료
  rec('개인정보보호 교육', [hyg3], 100, 1, '온라인 무료 과정');
  rec('개인정보보호 교육', [nurse], 380, 1, '온라인 무료 과정'); // 이미 만료
  rec('직장 내 성희롱 예방교육', [admin, manager, hyg1, hyg2, hyg3, nurse], 120, 1, '원내 단체 교육', '점심 회의 시간 활용');
  rec('장애인 인식개선 교육', [admin, manager, hyg1, hyg2, nurse], 120, 1, '원내 단체 교육');
  rec('산업안전보건교육', [manager, hyg1], 300, 2, '외부 위탁 교육');
  rec('방사선 관계 종사자 안전교육', [admin], 500, 3, '외부 위탁 교육');
  rec('방사선 관계 종사자 안전교육', [hyg1, hyg2], 400, 3, '외부 위탁 교육');
  rec('감염관리 교육', [admin, manager, hyg1, hyg2, hyg3, nurse], 60, 2, '원내 단체 교육', '손위생·멸균 흐름 복습');
  rec('감염관리 교육', [desk], 20, 1, '원내 교육 (신규 직원)');
  rec('소방 안전교육', [admin, manager, hyg1, hyg2, nurse], 250, 1, '건물 합동 훈련');
  rec('퇴직연금 교육', [admin, manager, hyg1, hyg2, hyg3, nurse], 90, 1, '퇴직연금 운용사 온라인 교육');

  // ---------- 온보딩 ----------
  const { deskT } = seedOnboardingTemplates(nowIso);
  if (desk) {
    const start = hireOf[desk] || time.addDays(today, -45);
    const runId = run('INSERT INTO onboarding_runs (user_id, template_id, start_date, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', desk, deskT.id, start, 'active', manager, nowIso, nowIso).lastInsertRowid;
    // 첫날 3개 전부, 첫 주 4개 중 3개, 첫 달 3개 중 0개 완료 → 6/10
    const doneIdx = [0, 1, 2, 3, 4, 6];
    doneIdx.forEach((i, k) => {
      const at = time.parseDate(time.addDays(start, i < 3 ? 0 : 2 + k));
      at.setHours(17, 20);
      run('INSERT INTO onboarding_checks (run_id, item_id, done_by, done_at, note) VALUES (?, ?, ?, ?, ?)', runId, deskT.ids[i], i === 1 || i === 6 ? desk : i < 3 ? manager : hyg1, at.toISOString(), null);
    });
  }
}

/** 온보딩 기본 템플릿 2개 (실사용 시작 때도 넣는 '기본 서식') → { 'id 목록' } */
function seedOnboardingTemplates(nowIso) {
  const addTemplate = (name, job, items) => {
    const id = run('INSERT INTO onboarding_templates (name, job_title, created_at, updated_at) VALUES (?, ?, ?, ?)', name, job, nowIso, nowIso).lastInsertRowid;
    const ids = items.map(([title, phase, owner], i) => run('INSERT INTO onboarding_template_items (template_id, title, phase, owner_role, sort) VALUES (?, ?, ?, ?, ?)', id, title, phase, owner, i + 1).lastInsertRowid);
    return { id, ids };
  };
  addTemplate('치과위생사 온보딩', '치과위생사', [
    ['원내 둘러보기 — 진료실·멸균실·비상구·소화기 위치', '첫날', '실장'],
    ['근무 시간·휴게·근무표 보는 법 안내', '첫날', '실장'],
    ['DentalAX 계정 받고 첫 비밀번호 바꾸기', '첫날', '본인'],
    ['손위생·개인보호구 착용 기준 확인', '첫날', '담당 선배'],
    ['유니트체어 기본 조작·수관 물 관리', '첫날', '담당 선배'],
    ['기구 세척 → 포장 → 멸균 → 보관 흐름 실습', '첫 주', '담당 선배'],
    ['멸균기 점검 기록 작성법 익히기', '첫 주', '담당 선배'],
    ['진료 전 준비·진료 후 정리 체크리스트', '첫 주', '담당 선배'],
    ['방사선 촬영 장비 사용법·안전 수칙 확인', '첫 주', '원장'],
    ['재료·소모품 위치와 출고 기록 방법', '첫 주', '실장'],
    ['법정 의무교육 이수 (개인정보보호·성희롱 예방 등)', '첫 달', '본인'],
    ['1개월 적응 면담', '첫 달', '원장'],
  ]);
  const deskT = addTemplate('데스크·코디네이터 온보딩', '코디네이터', [
    ['병원 기본 정보(진료시간·주차·오시는 길) 숙지', '첫날', '실장'],
    ['DentalAX 계정 받고 첫 비밀번호 바꾸기', '첫날', '본인'],
    ['개인정보 처리 원칙 — 화면 잠금·서류 보관·통화 시 주의', '첫날', '실장'],
    ['전화 응대 기본 스크립트 연습 (소통 도우미)', '첫 주', '담당 선배'],
    ['접수·수납 흐름 참관', '첫 주', '담당 선배'],
    ['예약 변경·취소 응대 연습', '첫 주', '담당 선배'],
    ['오픈·마감 체크리스트 직접 수행', '첫 주', '본인'],
    ['리뷰·문의 응대 원칙(의료광고 주의) 익히기', '첫 달', '실장'],
    ['법정 의무교육 이수 (개인정보보호·성희롱 예방 등)', '첫 달', '본인'],
    ['1개월 적응 면담', '첫 달', '원장'],
  ]);
  return { deskT };
}

/** 실제 사용 시작(데모 없이 첫 설정·초기화 후)에 넣는 기본 서식: 온보딩 템플릿 */
function starter() {
  seedOnboardingTemplates(new Date().toISOString());
}

module.exports = { seed, ensureDefaults, starter };
