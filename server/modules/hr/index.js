/*
 * 이 파일이 하는 일: [D. 인사·근무] 모듈을 하나로 묶습니다. (API 주소: /api/hr/...)
 *
 *   근무표      schedule.js    근무 유형, 공휴일·휴진 요일, 월간 근무표 (모두 보기, 실장 이상 편집)
 *   연차·휴가   leave.js       신청·승인, 일수 자동 계산, 부여/사용/잔여 (승인은 실장 이상)
 *   교육 이수   training.js    교육 항목, 이수 기록, 직원 × 교육 현황표 (모두 보기, 실장 이상 편집)
 *   온보딩      onboarding.js  템플릿 → 직원별 진행 체크, AI 항목 초안(hr.onboarding)
 *   공통 계산   lib.js         휴가 일수·연차 부여 계산, 공휴일 확인
 *   DB 표       migrations.js  /  데모 데이터 seed.js  /  대시보드 요약 dashboard.js
 *
 * 직원 정보는 core 의 users 표(이름·직종·입사일·색)만 씁니다. 직원 연락처·주소·주민번호는 다루지 않습니다.
 */
const { migrations } = require('./migrations');
const schedule = require('./schedule');
const leave = require('./leave');
const training = require('./training');
const onboarding = require('./onboarding');
const { seed, starter } = require('./seed');
const { dashboard } = require('./dashboard');

function register(r) {
  schedule.register(r);
  leave.register(r);
  training.register(r);
  onboarding.register(r);
}

module.exports = {
  name: 'hr',
  migrations,
  register,
  aiFeatures: onboarding.aiFeatures,
  seed,
  starter,
  dashboard,
  // 초기화 때 지울 표 (참조하는 표 먼저). 근무 유형·공휴일·교육 항목은 실제로 쓰는 기본 설정이라 남깁니다.
  resetTables: [
    'onboarding_checks',
    'onboarding_runs',
    'onboarding_template_items',
    'onboarding_templates',
    'training_records',
    'leave_grants',
    'leave_requests',
    'schedule_entries',
  ],
};
