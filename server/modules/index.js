/*
 * 이 파일이 하는 일: 서비스에 들어 있는 업무 모듈 목록입니다.
 *
 * 모듈 하나 = server/modules/<이름>/index.js 하나. 각 모듈은 아래 모양을 내보냅니다. (자세한 규칙: docs/CONVENTIONS.md)
 *   {
 *     name: 'inventory',              // API 주소 앞부분 → /api/inventory/...
 *     migrations: [{ id, up }],       // 이 모듈이 쓰는 DB 표
 *     register(router) {},            // API 등록 (router에는 이미 "로그인 필수"가 걸려 있음)
 *     aiFeatures: [],                 // 이 모듈의 AI 기능 (server/ai/service.js 설명 참고)
 *     seed(ctx) {},                   // 데모용 예시 데이터 넣기
 *     starter(ctx) {},                // (선택) 실사용 시작 때 넣는 기본 서식 (예: 법정 일정 기본 항목)
 *     resetTables: ['표1', '표2'],     // 초기화할 때 지울 표 (지우는 순서대로)
 *     dashboard(user) {}              // 대시보드에 보탤 요약 { todos, alerts, upcoming, notices, stats }
 *   }
 *
 * 순서가 중요합니다: 다른 모듈의 표를 참조하는 모듈(예: 지출 → 거래처)은 뒤에 둡니다.
 * 새 모듈을 만들면 NAMES 에 이름을 추가하세요.
 */
const NAMES = ['board', 'checklists', 'comms', 'inventory', 'documents', 'hr', 'facility', 'expenses', 'assistant', 'admin', 'ai', 'dashboard'];

const modules = [];
for (const name of NAMES) {
  try {
    modules.push(require(`./${name}`));
  } catch (e) {
    // 한 모듈 파일에 문제가 있어도 나머지 기능은 쓸 수 있게 서버는 계속 켭니다. (문제는 서버 창에 크게 표시)
    console.error(`\n[오류] '${name}' 모듈을 불러오지 못했습니다. 이 기능은 꺼진 상태로 실행합니다.\n`, e);
    modules.failed = [...(modules.failed || []), name];
  }
}

module.exports = modules;
