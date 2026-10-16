# 진행 기록 (PROGRESS)

> 작업이 중간에 끊겨도 이 파일만 읽으면 이어서 할 수 있도록 기록합니다. 최신 내용이 위에 있습니다.

## 현재 상태 (2026-10-16) — 완성
- 모든 단계(0~5) 완료. 필수(MVP) 전부 + 확장 대부분 구현 (docs/PLAN.md 8절 "구현 현황")
- 검증: `npm test` 175개 통과 · `npm run test:e2e` 28단계 통과(원내 IP + http 조건) · `npm audit` 0건 · 스크린샷 34장 점검(라이트/다크/태블릿) · 깨끗한 폴더에서 install.bat → start.bat → 첫 설정 재현 완료
- 개발 규칙: docs/CONVENTIONS.md / 결정 이유: docs/DECISIONS.md(D-01~D-23)

## 사용 흐름 안내서·시연 영상 (추가 작업)
- `docs/walkthrough/README.md`: 처음 설정 → 17개 장(모듈별 핵심 작업, 관리, 직원 계정)의 캡처 56장 + 설명 (GitHub에서 바로 보기)
- `docs/walkthrough/dentalax-demo.webm`: 약 3분 13초, 28.9MB(50MB 이하), 1280×800, 자막·마우스 위치 표시
- 다시 만들기: `npm run walkthrough`(캡처·안내서), `npm run walkthrough:video`(영상, Playwright ffmpeg 필요)
- 캡처·영상에는 이 PC의 폴더 경로·원내 IP가 찍히지 않도록 화면 글자를 일반 값으로 바꿔 표시(tests/e2e/lib.js MASK_PRIVATE). 병원·직원·업체는 모두 가상

## 이어서 작업할 때
1. `docs/CONVENTIONS.md` 를 먼저 읽기 (모듈 구조, 공통 부품, AI 기능 정의 방법, 테스트 방법)
2. 고친 뒤: `npm test` → `npm run test:e2e` → 필요하면 `npm run screenshots` 로 화면 확인
3. 화면 하나만 빠르게 볼 때: `node tests/e2e/pagecheck.js --port 3950 --out <폴더> --pages "inventory,orders"`

## 모듈 현황
| 모듈 | 서버 | 화면 | 테스트 |
|---|---|---|---|
| 공지·인수인계 (본보기) | modules/board | pages/board.js | board (8) |
| 오픈·마감 체크 | modules/checklists | pages/checklists.js | checklists |
| 소통 도우미 | modules/comms (rules.js: 의료광고 주의 표현 검사) | pages/comms.js | comms (두 파일 합계 26) |
| 재고·발주·거래처 | modules/inventory | pages/inventory, orders, vendors | inventory (19) |
| 문서·회의록·서식 | modules/documents | pages/documents, minutes, forms | documents (13) |
| 근무표·연차·교육·온보딩 | modules/hr | pages/schedule, leave, training, onboarding | hr (17) |
| 장비·멸균·법정 일정 | modules/facility | pages/equipment, sterilization, compliance | facility |
| 지출 | modules/expenses | pages/expenses.js | expenses (두 파일 합계 20) |
| 원내 AI 도우미 | modules/assistant (extract.js, search.js) | pages/assistant.js | assistant (8) |
| 관리 | modules/admin | pages/admin.js | admin (8), backup (7), auth (12), security (8) |
| AI 공통 | server/ai (providers, pii, service, defaults) | ui/ai.js | ai (16), pii (13) |

## 단계별 기록

### 5단계 최종 검증 — 완료
- 통합 중 발견·수정: 병원 이름이 개인정보로 오인되던 필터("병원 이름:"), 검사 오류가 500으로 나가던 문제(→400), 같은 초에 만든 백업이 정리 단계에서 지워지던 버그, 원내 IP 접속 시 COOP 헤더 경고, 재고 수량 입력칸 이중 테두리, 번호 목록 시작 번호, `npm test` 경로
- 실사용 기본 서식 추가(D-19): 데모 없이 시작해도 법정 일정·체크리스트·문자 템플릿·온보딩 템플릿이 들어감
- 개인정보 점검: 실제 DB 44개 표의 모든 칸 확인 — 환자 관련 칸 없음
- AI 기능 13종이 COST.md 표와 일치하는지 확인

### 2~4단계 기능 모듈·AI 마무리 — 완료
- 하위 에이전트 5개 병렬(데스크, 재고, 서류, 인사, 시설·지출) + 직접(G 도우미, 관리, AI 공통)
- AI: 공급자 3종 + 데모, 개인정보 필터(주민·카드 차단, 나머지 가림), 비용 기록, 예산 차단/경고, 가짜 서버로 요청 형식 테스트
- 실행 스크립트: start.bat / install.bat / stop.bat / reset-password.bat
- 문서: README, LLM_GUIDE, COST(규모별 비용), SECURITY, CONVENTIONS

### 1단계 기반 — 완료
- Express 5 + node:sqlite, 로그인·세션·CSRF·보안 헤더·원내 IP 제한·Host 검사, 디자인 시스템(라이트/다크), 공통 부품, 셸(Ctrl+K)

### 0단계 계획 — 완료
- docs/PLAN.md, docs/DECISIONS.md, PROGRESS.md

## 알려진 한계 (다음 개선 후보)
- PDF·한글(HWP) 파일은 AI 도우미가 직접 읽지 못함(복사·붙여넣기 또는 docx 변환 안내)
- 원내 통신은 HTTP(원내망 전제). 원외 접속이 필요하면 VPN 권장
- 개인정보 필터는 규칙 기반이라 100%가 아님 → 입력 금지 안내·교육 병행
- 음력 공휴일·대체공휴일은 병원이 직접 추가
- 회의록 할 일 체크는 목록 순서로 구분(동시에 고치면 어긋날 수 있음)
