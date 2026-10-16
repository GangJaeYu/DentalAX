# 유지보수·수정 안내 (DEVELOPMENT)

> 나중에 기능을 고치거나 Claude Code에 수정을 요청할 때 보는 문서입니다. 처음으로 → [README](../README.md)

## 1. 폴더 지도 — "이 기능을 고치려면 이 파일"

```
DentalAX/
├─ start.bat / stop.bat / install.bat   켜기 / 끄기 / 처음 설치
├─ reset-password.bat                   비밀번호를 잊었을 때 (서버 PC에서 실행)
├─ config.example.json                  포트 등 설정 예시 (config.json 으로 복사해서 사용)
├─ data/                                ★ 데이터 (DB, 백업, 암호화 열쇠) — 지우면 안 됨
├─ server/                              서버(뒤쪽) 코드
│  ├─ index.js                          서버 시작, 접속 주소 안내
│  ├─ app.js                            요청 처리 순서(보안 → 로그인 → 기능)
│  ├─ seed.js                           데모 데이터 넣기 / 초기화
│  ├─ core/                             공통: DB(db.js), 로그인(auth.js), 보안(security.js), 백업(backup.js), 입력 검사(validate.js) …
│  ├─ ai/                               AI: 공급자 연결(providers.js), 개인정보 필터(pii.js), 비용·예산(service.js), 기본 가격(defaults.js)
│  └─ modules/                          기능별 서버 코드 (표 구조, API, AI 지시문, 데모 데이터)
│     ├─ board/        공지·인수인계        ├─ checklists/   오픈·마감 체크
│     ├─ comms/        소통 도우미          ├─ inventory/    재고·발주·거래처
│     ├─ documents/    문서·회의록·서식     ├─ hr/           근무표·연차·교육·온보딩
│     ├─ facility/     장비·멸균·법정 일정   ├─ expenses/     지출
│     ├─ assistant/    원내 AI 도우미       ├─ admin/        관리(사용자·AI 설정·백업·활동 기록)
│     └─ dashboard/    대시보드 모으기
├─ public/                              화면(앞쪽) 코드 — 고치고 브라우저 새로고침하면 바로 반영
│  ├─ css/app.css                       색·글꼴·버튼 등 디자인 전체 규칙 (mod-*.css 는 기능별 추가 디자인)
│  ├─ js/routes.js                      왼쪽 메뉴 목록
│  ├─ js/pages/                         화면별 파일 (board.js = 공지 화면, inventory.js = 재고 화면 …)
│  └─ js/ui/                            공통 부품 (버튼, 표, 팝업, AI 결과 상자 …)
├─ tests/                               자동 테스트 (npm test), tests/e2e 브라우저 테스트
└─ docs/                                문서: PLAN(설계), DECISIONS(결정 이유), CONVENTIONS(개발 규칙), SECURITY, COST, LLM_GUIDE
```

예시
- 재고 화면 글자를 바꾸고 싶다 → `public/js/pages/inventory.js`
- AI 공지 다듬기 말투를 바꾸고 싶다 → `server/modules/board/index.js` 의 `aiFeatures`
- 법정 일정 기본 항목을 바꾸고 싶다 → `server/modules/facility/` (또는 화면에서 직접 수정)
- 개인정보 감지 규칙을 더하고 싶다 → `server/ai/pii.js`
- 색상을 바꾸고 싶다 → `public/css/app.css` 맨 위의 `--accent` 등

---

## 2. Claude Code로 수정을 요청하는 요령

1. DentalAX 폴더에서 Claude Code를 열고, 먼저 **"docs/CONVENTIONS.md 와 PROGRESS.md 를 읽고 시작해 줘"** 라고 말합니다.
2. **무엇을, 어디서, 어떻게** 를 구체적으로:
   - 좋은 예: "재고 화면(#/inventory)의 품목 표에 '보관 위치' 열을 추가해 줘. 실장 이상만 수정 가능하게."
   - 아쉬운 예: "재고 좀 좋게 해 줘."
3. **화면 캡처**를 함께 주면 정확해집니다.
4. 끝나면 **"npm test 로 전체 테스트를 돌리고, 바뀐 화면을 직접 확인해 줘"** 라고 요청합니다.
5. 큰 변경 전에는 **관리 → 백업·복원 → [지금 백업]** 을 먼저 해 두세요.
6. 원칙을 함께 알려 주세요: "환자 정보는 저장하지 않는다", "쉬운 한국어 주석", "기존 디자인 부품(public/js/ui) 사용".

---

## 3. 개발 명령 모음

- 실행: `npm start` · 테스트: `npm test` · 브라우저 E2E: `npm run test:e2e` · 스크린샷: `npm run screenshots` · 사용 흐름 안내서: `npm run walkthrough` · 시연 영상: `npm run walkthrough:video` · 취약점 점검: `npm run audit`
- 영상 녹화에는 Playwright용 ffmpeg가 필요합니다(프로젝트 안에 설치): `PLAYWRIGHT_BROWSERS_PATH=0 node node_modules/playwright-core/cli.js install ffmpeg`
- 기술: Node.js 24 + Express 5 + 내장 SQLite(`node:sqlite`), 화면은 빌드 없는 Preact + htm. 결정 이유: [DECISIONS.md](DECISIONS.md)
- 라이선스 고지: Pretendard(OFL, `public/fonts`), Preact(MIT)·htm(Apache-2.0)(`public/vendor`), Lucide 아이콘(ISC, `public/js/ui`)
- 개발 규칙(모듈 구조·공통 부품·AI 기능 정의·테스트 방법): [CONVENTIONS.md](CONVENTIONS.md)
- 설계와 결정 이유: [PLAN.md](PLAN.md), [DECISIONS.md](DECISIONS.md) · 진행 기록: [PROGRESS.md](../PROGRESS.md)
