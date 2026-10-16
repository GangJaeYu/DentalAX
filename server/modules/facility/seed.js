/*
 * 이 파일이 하는 일: [E. 시설·법정] 데모(시연)용 예시 데이터를 넣습니다.
 *
 *   - 장비 11대 (유니트체어 3, 멸균기 2, 방사선 2, 컴프레서, 석션, 구강스캐너, 핸드피스) + 점검·수리 이력
 *   - 최근 30 근무일의 멸균 기록 (하루 2~4회, 2주 전 CI 불합격 1건과 재멸균, 매주 목요일 BI 시험)
 *   - 법정 일정 17개 (일부는 기한 지남, 일부는 30일 이내, 대부분은 그 뒤)
 * 날짜는 모두 "오늘" 기준 상대값이라 언제 실행해도 자연스럽습니다. 환자 정보는 넣지 않습니다.
 */
const { run } = require('../../core/db');
const time = require('../../core/time');

/** 매번 같은 결과가 나오는 간단한 난수 (데모 데이터가 실행할 때마다 달라지지 않게) */
function makeRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function iso(date, hour, minute = 0) {
  const d = time.parseDate(date);
  d.setHours(hour, minute);
  return d.toISOString();
}

function seedEquipment(ctx) {
  const { today, users } = ctx;
  const ago = (n) => time.addDays(today, -n);
  const list = [
    { key: 'chair1', name: '유니트체어 1번', category: '유니트체어', model: '하늘 U-700', serial: 'U7-21-0141', location: '진료실 1', cycle: 180, last: 120, install: 1500, warranty: -400, as: '한빛덴탈 장비AS 02-555-0141' },
    { key: 'chair2', name: '유니트체어 2번', category: '유니트체어', model: '하늘 U-700', serial: 'U7-21-0142', location: '진료실 2', cycle: 180, last: 170, install: 1500, warranty: -400, as: '한빛덴탈 장비AS 02-555-0141', status: '점검 필요', memo: '석션 흡입력이 약하다는 보고 있음. 필터 청소 후에도 같으면 AS 요청.' },
    { key: 'chair3', name: '유니트체어 3번', category: '유니트체어', model: '하늘 U-900', serial: 'U9-24-0033', location: '진료실 3', cycle: 180, last: 60, install: 600, warranty: 130, as: '한빛덴탈 장비AS 02-555-0141' },
    { key: 'ster1', name: '고압증기멸균기 1호기', category: '멸균기', model: '클린스팀 B23', serial: 'CSB-22-1187', location: '멸균실', cycle: 180, last: 165, install: 1300, warranty: -200, as: '미소메디칼 02-555-0177', memo: 'B타입(진공). 매일 첫 회차에 보위딕 시험.' },
    { key: 'ster2', name: '고압증기멸균기 2호기', category: '멸균기', model: '클린스팀 S18', serial: 'CSS-24-0412', location: '멸균실', cycle: 180, last: 40, install: 520, warranty: 210, as: '미소메디칼 02-555-0177', memo: '보조 멸균기. 급한 핸드피스·소량 멸균용.' },
    { key: 'pano', name: '파노라마 방사선 촬영장치', category: '방사선 장비', model: '하늘레이 PX-3D', serial: 'PX3-20-0098', location: '촬영실', cycle: 365, last: 300, install: 2100, warranty: -1000, as: '하늘레이 서비스센터 1588-0123' },
    { key: 'intra', name: '구내 방사선 촬영장치', category: '방사선 장비', model: '하늘레이 IX-70', serial: 'IX7-20-0310', location: '진료실 2', cycle: 365, last: 350, install: 2100, warranty: -1000, as: '하늘레이 서비스센터 1588-0123' },
    { key: 'comp', name: '공기 압축기(컴프레서)', category: '컴프레서', model: '사일런트에어 SA-30', serial: 'SA30-19-221', location: '기계실', cycle: 90, last: 97, install: 2400, warranty: -1500, as: '바른설비 010-5550-0199', memo: '오일리스. 매일 마감 때 물빼기(드레인).' },
    { key: 'suction', name: '석션 모터', category: '석션', model: '파워석션 PS-2', serial: 'PS2-21-077', location: '기계실', cycle: 90, last: 30, install: 1600, warranty: -900, as: '바른설비 010-5550-0199' },
    { key: 'scanner', name: '구강스캐너', category: '구강스캐너', model: '스캔에이스 i5', serial: 'SAI5-25-1020', location: '상담실', cycle: 365, last: 200, install: 280, warranty: 450, as: '스캔에이스 고객지원 1588-0456' },
    { key: 'handpiece', name: '핸드피스 세트(고속·저속)', category: '핸드피스', model: '혼합 12개', serial: '', location: '진료실 공용', cycle: 30, last: 20, install: 900, warranty: null, as: '한빛덴탈 02-555-0141', memo: '주 1회 오일 주입·회전 소음 점검.' },
  ];
  const ids = {};
  const now = new Date().toISOString();
  for (const e of list) {
    const info = run(
      `INSERT INTO equipment (name, category, model, serial_no, location, as_contact, install_date, warranty_until, inspection_cycle_days, last_inspected, status, memo, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      e.name,
      e.category,
      e.model,
      e.serial || null,
      e.location,
      e.as,
      ago(e.install),
      e.warranty === null ? null : time.addDays(today, e.warranty),
      e.cycle,
      ago(e.last),
      e.status || '정상',
      e.memo || null,
      now,
      now
    );
    ids[e.key] = info.lastInsertRowid;
  }
  // 점검·수리 이력
  const logs = [
    ['chair1', 120, '정기 점검', '유니트체어 정기 점검: 수관 필터 교체, 타구 배수 점검, 의자 유압 정상', 0, '한빛덴탈', '김기사', users.manager],
    ['chair1', 300, '정기 점검', '정기 점검: 조명 밝기·라이트 암 고정 상태 정상', 0, '한빛덴탈', '김기사', users.manager],
    ['chair2', 170, '정기 점검', '정기 점검: 이상 없음', 0, '한빛덴탈', '김기사', users.manager],
    ['chair2', 1, '기타', '석션 흡입력 약함 → 석션 필터 청소. 증상 계속되면 AS 요청 예정', 0, '', '최유나', users.hyg2],
    ['chair3', 60, '정기 점검', '정기 점검: 핸드피스 호스 연결부 누수 없음', 0, '한빛덴탈', '김기사', users.manager],
    ['ster1', 165, '정기 점검', '멸균기 정기 점검: 챔버 청소, 도어 개스킷 상태 양호, 온도 센서 확인', 120000, '미소메디칼', '박기사', users.manager],
    ['ster1', 14, '부품 교체', '2주 전 CI 불합격 후 점검 요청 → 도어 개스킷 교체, 시운전 정상', 85000, '미소메디칼', '박기사', users.manager],
    ['ster2', 40, '정기 점검', '정기 점검: 이상 없음, 급수 필터 교체', 60000, '미소메디칼', '박기사', users.manager],
    ['pano', 300, '정기 점검', '자체 점검: 촬영 화질·회전 동작 정상', 0, '하늘레이', '이엔지니어', users.manager],
    ['pano', 700, '법정 검사', '진단용 방사선 발생장치 정기검사 적합', 250000, '검사기관(가상)', '', users.admin],
    ['intra', 350, '정기 점검', '자체 점검: 노출 타이머 정상', 0, '하늘레이', '이엔지니어', users.manager],
    ['comp', 97, '정기 점검', '정기 점검: 탱크 드레인, 에어필터 청소', 50000, '바른설비', '정기사', users.manager],
    ['comp', 200, '부품 교체', '흡입 필터·체크밸브 교체', 180000, '바른설비', '정기사', users.manager],
    ['suction', 30, '정기 점검', '석션 모터 점검: 분리기 청소, 흡입압 정상', 40000, '바른설비', '정기사', users.manager],
    ['scanner', 200, '정기 점검', '소프트웨어 업데이트, 캘리브레이션 완료', 0, '스캔에이스', '원격 지원', users.manager],
    ['scanner', 90, '수리', '스캔 팁 히터 불량 → 무상 교체(보증 기간)', 0, '스캔에이스', '서비스센터', users.manager],
    ['handpiece', 20, '정기 점검', '핸드피스 12개 오일 주입·회전 소음 점검, 고속 1개 베어링 소음 → 수리 의뢰', 0, '', '이서연', users.hyg1],
    ['handpiece', 50, '수리', '고속 핸드피스 카트리지 교체 1개', 95000, '한빛덴탈', '', users.manager],
  ];
  for (const [key, daysAgo, type, desc, cost, vendor, by, uid] of logs) {
    const date = ago(daysAgo);
    run(
      `INSERT INTO equipment_logs (equipment_id, date, type, description, cost, vendor_name, performed_by, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ids[key],
      date,
      type,
      desc,
      cost || null,
      vendor || null,
      by || null,
      uid || null,
      iso(date, 17, 30)
    );
  }
  return ids;
}

function seedSterilization(ctx, ids) {
  const { today, users } = ctx;
  const rand = makeRand(20261016);
  const operators = [users.hyg1, users.hyg2, users.hyg3, users.nurse].filter(Boolean);
  const loads = [
    '기구 파우치 25개',
    '기구 파우치 18개 + 핸드피스 6개',
    '기본 기구 세트 12개',
    '스케일러 팁 파우치 20개',
    '외과 기구 세트 2개 + 파우치 10개',
    '보철 기구 파우치 15개',
    '핸드피스 8개',
    '임플란트 수술 키트 1세트 + 파우치 8개',
  ];
  const programValues = {
    일반: { t: 134, p: 210, m: 15 },
    파우치: { t: 134, p: 210, m: 18 },
    고속: { t: 134, p: 208, m: 7 },
  };
  // 최근 30 근무일 (일요일 휴진). 오늘은 오전 기록 2건만
  const days = [];
  for (let i = 0; days.length < 31 && i < 60; i++) {
    const d = time.addDays(today, -i);
    if (time.weekday(d) === 0) continue;
    days.push(d);
  }
  // 2주 전(가장 가까운 근무일)에 CI 불합격 1건
  let failDay = time.addDays(today, -14);
  if (time.weekday(failDay) === 0) failDay = time.addDays(failDay, -1);
  // 가장 최근 목요일 BI는 아직 배양 중(대기)으로 — 오늘·어제·그제 안이면
  const recentThursday = days.find((d) => time.weekday(d) === 4);
  const biPendingDay = recentThursday && time.diffDays(recentThursday, today) <= 2 ? recentThursday : null;

  const insert = (o) =>
    run(
      `INSERT INTO sterilization_logs (date, sterilizer_id, cycle_no, program, temperature, pressure, duration_min, ci_result, bi_result, bowie_dick,
         load_desc, operator_id, note, resolved_at, resolved_by, action_note, created_by, created_at, updated_at)
       VALUES (:date, :sid, :cycle, :program, :t, :p, :m, :ci, :bi, :bd, :load, :op, :note, :resolvedAt, :resolvedBy, :actionNote, :op, :at, :at)`,
      o
    );

  for (const date of days) {
    const isToday = date === today;
    const sat = time.weekday(date) === 6;
    const thu = time.weekday(date) === 4;
    // 1호기: 평일 3~4회, 토요일 2회, 오늘은 오전 2회
    const n1 = isToday ? 2 : sat ? 2 : 3 + (rand() < 0.45 ? 1 : 0);
    for (let c = 1; c <= n1; c++) {
      const program = c === 1 ? '파우치' : rand() < 0.6 ? '파우치' : '일반';
      const pv = programValues[program];
      const op = operators[Math.floor(rand() * operators.length)];
      const o = {
        date,
        sid: ids.ster1,
        cycle: c,
        program,
        t: Math.round((pv.t + rand() * 0.6) * 10) / 10,
        p: pv.p + Math.round(rand() * 8) - 3,
        m: pv.m,
        ci: 'pass',
        bi: c === 1 && thu ? (date === biPendingDay ? 'pending' : 'pass') : 'na',
        bd: c === 1 ? 'pass' : 'na',
        load: loads[Math.floor(rand() * loads.length)],
        op,
        note: c === 1 && thu ? '주간 BI 시험 포함' : null,
        resolvedAt: null,
        resolvedBy: null,
        actionNote: null,
        at: iso(date, 9 + c * 2, Math.floor(rand() * 50)),
      };
      if (date === failDay && c === 2) {
        o.ci = 'fail';
        o.note = 'CI 변색 불충분 — 해당 묶음 사용 보류';
        o.resolvedAt = iso(date, 14, 20);
        o.resolvedBy = users.manager;
        o.actionNote = '해당 파우치 묶음 사용 보류 후 3회차에 재멸균, 재멸균 CI 합격 확인. 멸균기 점검 요청(도어 개스킷 교체).';
      }
      if (date === failDay && c === 3) {
        o.program = '파우치';
        o.note = '2회차 CI 불합격 묶음 재멸균 → 합격';
      }
      insert(o);
    }
    // 2호기: 평일에 1~2회 (고속·일반), 토요일·오늘은 없음
    if (!sat && !isToday) {
      const n2 = rand() < 0.35 ? 2 : 1;
      for (let c = 1; c <= n2; c++) {
        const program = rand() < 0.5 ? '고속' : '일반';
        const pv = programValues[program];
        insert({
          date,
          sid: ids.ster2,
          cycle: c,
          program,
          t: Math.round((pv.t + rand() * 0.6) * 10) / 10,
          p: pv.p + Math.round(rand() * 8) - 3,
          m: pv.m,
          ci: 'pass',
          bi: c === 1 && thu ? (date === biPendingDay ? 'pending' : 'pass') : 'na',
          bd: 'na',
          load: program === '고속' ? '핸드피스 6개' : '기구 파우치 12개',
          op: operators[Math.floor(rand() * operators.length)],
          note: c === 1 && thu ? '주간 BI 시험 포함' : null,
          resolvedAt: null,
          resolvedBy: null,
          actionNote: null,
          at: iso(date, 13 + c * 2, Math.floor(rand() * 50)),
        });
      }
    }
  }
}

function seedCompliance(ctx, { starter = false } = {}) {
  const { today, users } = ctx;
  // dueIn: 오늘부터 다음 일정까지 남은 날 (음수 = 이미 지남). 주기가 있으면 마지막 완료일 = 다음 일정 - 주기
  const C1 = '관할 보건소·관련 기관에 주기와 대상 여부를 확인해 주세요.';
  const list = [
    ['진단용 방사선 발생장치 정기검사', '방사선', '진단용 방사선 발생장치의 안전관리에 관한 규칙', 36, 0, 0, 200, users.admin, '검사기관에 미리 예약. 검사 성적서는 서식 보관함에 보관.'],
    ['개인 피폭선량계(TLD) 판독·교체', '방사선', '진단용 방사선 안전관리 규칙 (피폭선량 측정)', 3, 0, 0, 12, users.manager, '분기마다 판독기관에서 새 선량계가 오면 교체하고 지난 것은 반송.'],
    ['방사선 관계 종사자 안전교육', '방사선', '진단용 방사선 안전관리 규칙 (교육)', null, 1, 0, null, users.manager, `신규 종사자는 업무 시작 전 이수. 정기 주기는 ${C1}`, 300],
    ['방사선 관계 종사자 건강진단', '방사선', '진단용 방사선 안전관리 규칙 (건강진단)', null, 1, 0, null, users.manager, `채용 전·정기 건강진단 주기를 확인해 주세요. ${C1}`, 330],
    ['의료인 면허 신고', '면허·신고', '의료법 (면허 신고)', 36, 0, 0, 400, users.admin, '원장·치과위생사 등 면허 보유자 각자. 보수교육 이수 후 신고.'],
    ['소방시설 자체점검', '소방·안전', '소방시설 설치 및 관리에 관한 법률', 12, 1, 0, 45, users.manager, `건물 관리사무소 점검 일정과 겹치는지 확인. ${C1}`],
    ['소방안전교육', '소방·안전', '화재예방법 등 (대상 여부 확인)', null, 1, 0, null, users.manager, `대상 여부·주기는 ${C1}`, 200],
    ['개인정보보호 교육', '개인정보', '개인정보 보호법', 12, 1, 0, 150, users.manager, '전 직원 대상. 온라인 교육 이수증 보관.'],
    ['개인정보 처리방침·CCTV 안내 점검', '개인정보', '개인정보 보호법 (처리방침 공개·영상정보처리기기 안내)', 12, 1, 0, -5, users.manager, '대기실 CCTV 안내판, 홈페이지 처리방침 최신 여부 확인.'],
    ['감염관리 자체 점검', '감염관리', '의료법 (감염관리) · 원내 기준', 6, 1, 0, 20, users.manager, '진료실 소독제 개봉일, 멸균물 보관, 손위생 점검표 활용.'],
    ['의료폐기물 위탁처리 계약 갱신', '의료폐기물', '폐기물관리법 (의료폐기물 위탁처리)', 12, 1, 0, 75, users.manager, '계약서 사본 서식 보관함에 보관.'],
    ['의료폐기물 보관기간 준수 점검', '의료폐기물', '폐기물관리법 (보관기간)', 1, 1, 0, -10, users.nurse, '전용 용기 보관 기간·밀폐 상태·수거 일지 확인.'],
    ['직장 내 성희롱 예방교육', '노무·교육', '남녀고용평등과 일·가정 양립 지원에 관한 법률', 12, 0, 0, 95, users.manager, '연 1회 전 직원. 교육 자료·참석 명단 보관.'],
    ['장애인 인식개선 교육', '노무·교육', '장애인고용촉진 및 직업재활법', 12, 0, 0, 95, users.manager, '연 1회 전 직원.'],
    ['전기 안전점검', '시설', '전기안전관리법 (대상·주기 확인)', null, 1, 0, null, users.manager, `건물 단위로 하는 경우가 많습니다. ${C1}`, 250],
    ['치과 수관(워터라인) 소독 점검', '감염관리', '원내 자체 기준', 1, 0, 1, 5, users.hyg1, '수관 소독제 주입, 유니트체어별 배수·냄새 확인.'],
    ['구급약품·응급키트 점검', '기타', '원내 자체 기준', 1, 0, 1, 25, users.nurse, '응급약품 유효기간, 산소통 잔량, 자동심장충격기(AED) 배터리 확인.'],
  ];
  const now = new Date().toISOString();
  for (const [name, category, basis, cycle, needsCheck, internal, dueIn0, owner0, notes, lastAgo0] of list) {
    // 실사용 시작용(starter)은 날짜·담당자를 비워 두고, 병원이 마지막 완료일을 직접 넣게 함
    const dueIn = starter ? null : dueIn0;
    const owner = starter ? null : owner0;
    const lastAgo = starter ? null : lastAgo0;
    const nextDue = dueIn === null ? null : time.addDays(today, dueIn);
    const lastDone = cycle && nextDue ? time.addMonths(nextDue, -cycle) : lastAgo ? time.addDays(today, -lastAgo) : null;
    const info = run(
      `INSERT INTO compliance_tasks (name, category, legal_basis, cycle_months, needs_check, internal, last_done, next_due, owner_id, notes, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      name,
      category,
      basis,
      cycle,
      needsCheck,
      internal,
      lastDone,
      nextDue,
      owner || null,
      notes,
      now,
      now
    );
    // 완료 이력: 마지막 완료 1건 + (주기가 짧은 항목은) 그 전 1건
    if (lastDone) {
      const prevDone = cycle ? time.addMonths(lastDone, -cycle) : null;
      if (prevDone && cycle <= 12) {
        run(
          'INSERT INTO compliance_logs (task_id, done_date, note, user_id, prev_last_done, prev_next_due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          info.lastInsertRowid,
          prevDone,
          '완료',
          owner || null,
          null,
          prevDone,
          iso(prevDone, 17)
        );
      }
      run(
        'INSERT INTO compliance_logs (task_id, done_date, note, user_id, prev_last_done, prev_next_due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        info.lastInsertRowid,
        lastDone,
        internal ? '점검 완료, 이상 없음' : '완료 (증빙 서류 보관)',
        owner || null,
        prevDone,
        lastDone,
        iso(lastDone, 17)
      );
    }
  }
}

function seed(ctx) {
  const ids = seedEquipment(ctx);
  seedSterilization(ctx, ids);
  seedCompliance(ctx);
}

/** 실제 사용 시작(데모 없이 첫 설정·초기화 후)에 넣는 기본 서식: 법정 일정 항목 (날짜 없음) */
function starter(ctx) {
  seedCompliance(ctx, { starter: true });
}

module.exports = { seed, starter };
