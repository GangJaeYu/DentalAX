# 개발 규칙 (CONVENTIONS)

> 모듈을 새로 만들거나 고칠 때 지키는 공통 규칙입니다. 사람이든 Claude Code든 이 문서를 먼저 읽고 작업하세요.
> **본보기 모듈은 "공지·인수인계"**입니다: 서버 `server/modules/board/index.js`, 화면 `public/js/pages/board.js`, 테스트 `tests/board.test.js`.

## 0. 절대 원칙
1. **환자 정보를 저장하지 않는다.** 환자 이름·연락처·주민번호·차트번호·진료/의료 정보를 담는 표, 칸, 입력란을 만들지 않는다.
   (예: 멸균 기록에 "환자명" 칸 금지, 리뷰 원문·AI 질문 같은 자유 입력 글은 DB에 저장하지 않음)
2. 직원 정보는 최소한(이름·직종·권한·입사일)만. 직원 연락처·주민번호·주소 칸 금지.
3. 모든 파일 맨 위에 **"이 파일이 하는 일"을 한국어로** 적는다. 주요 함수와 복잡한 부분에는 비개발자도 따라갈 수 있는 쉬운 한국어 주석.
4. 화면에 보이는 모든 글자와 오류 안내는 **쉬운 한국어**.
5. SQL에는 항상 `?` 또는 `:이름` 자리표시자를 쓴다. 사용자 입력을 SQL 문자열에 이어 붙이지 않는다(정렬 기준 등은 허용 목록에서 고른다).
6. 화면에서 HTML 문자열을 `innerHTML`로 넣지 않는다. 글은 htm 템플릿(자동 이스케이프)이나 `Markdown` 컴포넌트로만 표시한다.
7. 테스트를 통과시키려고 테스트를 약하게 고치지 않는다.

## 1. 서버 모듈 구조
`server/modules/<이름>/index.js` 하나가 모듈 하나. 파일이 길어지면 같은 폴더에 `routes.js`, `ai.js`, `seed.js` 등으로 나눠도 된다.

```js
module.exports = {
  name: 'inventory',          // API 주소: /api/inventory/...
  migrations: [{ id: 'inventory_001', up: `CREATE TABLE ...` }], // id는 '<모듈>_001' 형식, 이미 배포된 것은 고치지 말고 새 id 추가
  register(router) {},        // router에는 이미 로그인 필수가 걸려 있음. 권한은 requireRole('manager') 등으로 추가
  aiFeatures: [],             // AI 기능 (아래 4절)
  seed(ctx) {},               // 데모 데이터. ctx = { users: { admin, manager, hyg1, hyg2, hyg3, nurse, desk }, today, staffIds }
  starter(ctx) {},            // (선택) 실사용 기본 서식: 데모 없이 첫 설정할 때와 초기화 직후에 실행. ctx.users 에는 admin 만 있음
  resetTables: ['자식표', '부모표'], // "초기화" 때 지울 표 (지우는 순서: 참조하는 표 먼저)
  dashboard(user) {},         // 대시보드 조각 (아래 3절)
};
```

### 공통 도구 (server/core)
| 파일 | 쓰는 법 |
|---|---|
| `db.js` | `all(sql, ...값)`, `get(...)`, `run(...)` → `{changes, lastInsertRowid}`, `tx(() => {...})` 묶음 처리, `where([[조건 && 'a = :a'], ...])`. 이름 붙은 값 객체를 넘기면 SQL에 없는 이름은 자동으로 무시됨. true/false는 1/0으로 저장됨 |
| `validate.js` | `v.object({ name: v.string({min:1,max:100,label:'품목명'}), qty: v.int({min:0}), date: v.date({optional:true}) }).parse(req.body)` → 잘못되면 400 + 한국어 안내. 수정용은 `.partial().parse()`. `idParam(req.params.id)` |
| `errors.js` | `throw notFound('품목')`, `throw forbidden()`, `throw badRequest('안내 문장')`, `new HttpError(409, '...')` |
| `audit.js` | 저장·수정·삭제마다 `audit(req, 'create'|'update'|'delete'|..., '표이름', id, '사람이 읽을 한 줄')` |
| `auth.js` | `requireRole('manager')` 미들웨어, `hasRole(req.user, 'manager')` |
| `time.js` | `today()`, `addDays(s,n)`, `addMonths(s,n)`, `diffDays(a,b)`, `thisMonth()`, `daysInMonth(ym)`, `nowIso()`, `isValidDate()`, `weekday()` |
| `csv.js` | `toCsv(columns, rows)` (엑셀용 BOM 포함), `parseCsvObjects(text, aliases)`, `sendCsv(res, '파일명.csv', csv)` |
| `settings.js` | `getSetting('clinic')` 병원 정보 |

- 권한: admin(원장·관리자) > manager(실장) > staff(직원). `req.user = { id, name, role, level, ... }`
- 응답은 JSON. 목록은 `{ rows, total, page, size }` 또는 배열. 날짜는 'YYYY-MM-DD', 시각은 ISO 문자열. 금액은 원 단위 정수.
- 표·칸 이름은 snake_case, 화면으로 보내는 JSON은 camelCase로 바꿔서(`toView()` 함수) 보낸다.
- 시각 칸 `created_at`, `updated_at` 은 `time.nowIso()`.
- 삭제가 다른 기록에 영향을 주면 `ON DELETE CASCADE` 또는 `SET NULL`을 정하고, 위험한 삭제는 "보관(비활성)"으로 대체한다.

## 2. 화면(페이지) 구조
`public/js/pages/<이름>.js` 가 `export default function Page({ route })` 를 내보낸다. 주소는 `public/js/routes.js` 에 이미 등록되어 있다.
- `route.parts` : `#/inventory/items/12` → `['inventory','items','12']`, `route.query` : `?tab=moves` → `{tab:'moves'}`
- 하위 화면 이동은 `navigate('#/...')`, 탭·검색어처럼 같은 화면 안의 상태는 `setQuery({ tab: 'x' })` (새로고침해도 유지됨)
- 불러오기: `import { html, useState, ... , fmtDate, fmtMoney } from '../lib.js'`, `import { api } from '../api.js'`, `import { ... } from '../ui/index.js'`, `import { can, toast, confirmDialog, session } from '../store.js'`

### 공통 부품 (public/js/ui) — 새로 만들지 말고 이것을 쓴다
`PageHeader`, `Card`(title, sub, actions, flush, footer), `Button`(variant: primary/ghost/danger/danger-solid/soft/ai, size:'sm', icon, loading), `IconButton`, `LinkButton`, `Badge`(color: blue/green/amber/red/purple), `Tabs`, `Seg`, `Stat`, `Menu`(… 메뉴), `Callout`(info/warn/danger/success), `Progress`, `Avatar`, `DdayBadge`,
`Field`(label, required, hint, error) + `Input`/`Textarea`/`Select`/`Checkbox`/`FormGrid`/`SearchInput`, `useForm`,
`Modal`(open, title, onClose, footer, size: sm/lg/xl), `confirmDialog({title, message, danger, typeToConfirm})`, `toast.success/error/warn`,
`useApi(url)` → `{data, loading, error, reload, setData}`, `DataTable`(columns, rows, loading, error, empty, onRowClick), `Pagination`,
`EmptyState`, `Loading`, `ErrorState`, `Markdown`, `Icon`(이름 목록: `public/js/ui/icons-data.js`),
AI: `PiiBanner`, `useAI('기능키')`, `AiResult`, `AiButton`, 인쇄: `PrintDoc`, `printNow()`.

### 화면 규칙
- 모든 목록 화면에 **빈 화면(EmptyState + 다음 행동 버튼), 로딩(Loading), 오류(ErrorState + 다시 시도)** 를 둔다.
- 저장·삭제 후 `toast.success('…했습니다.')`. 실패는 `toast.error(e.message)` (서버가 이미 한국어로 보냄).
- 삭제는 `confirmDialog({ danger: true })` 로 한 번 묻는다.
- 권한이 없는 버튼은 숨긴다(`can('manager')`). 서버에서도 반드시 막는다.
- 클릭 수를 줄인다: 자주 하는 일(입고·출고, 체크 등)은 목록에서 바로 할 수 있게.
- 색·크기는 `app.css` 변수와 클래스만 쓴다. 모듈 전용 스타일은 `public/css/mod-<영역>.css` (desk/inventory/docs/hr/facility/assistant)에만 추가한다.
- 인라인 `style=${{...}}`(객체)는 써도 되지만, HTML 문자열 안의 `style="..."` 속성은 보안 정책(CSP) 때문에 쓰지 않는다.
- 표는 `DataTable` 또는 `<div class="table-wrap"><table class="table">`. 태블릿에서 가로 스크롤이 되도록.
- 키보드: 버튼은 `<button>`, 이동은 `<a href>`. 아이콘만 있는 버튼엔 `label`(IconButton).
- 인쇄 화면: `PrintDoc` 안에 내용을 넣고, 버튼 영역에는 `class="no-print"`.

## 3. 대시보드 조각 (`dashboard(user)` 반환값)
```js
{
  todos:    [{ id, module, title, detail?, href, level?: 'info'|'warn'|'danger', icon?, progress?: { done, total } }],
  alerts:   [{ id, module, title, detail?, href, level: 'warn'|'danger', badge? }],      // 재고·유효기간 등 경고
  upcoming: [{ id, module, title, date: 'YYYY-MM-DD', dday: 숫자(남은 일수, 지나면 음수), detail?, href, icon? }], // 30일 이내
  notices:  [...],                                                                       // 공지 모듈만 사용
  today:    { working: [{ name, shift, color }], off: [{ name, reason }] },              // 근무 모듈만 사용
  stats:    [{ key, label, value, unit?, hint?, href?, icon?, color?: 'danger'|'warning' }],
}
```
가볍게 계산할 것(쿼리 몇 개). 권한에 따라 다르게 줄 수 있다(예: 지출 합계는 manager 이상만).

## 4. AI 기능
각 모듈의 `aiFeatures` 배열에 정의한다. 실행·개인정보 필터·예산·비용 기록은 `server/ai/service.js` 가 알아서 한다.
```js
{
  key: 'inventory.parseInvoice',   // '<모듈>.<기능>'
  label: '거래명세서 → 입고 품목 인식', // 관리 화면에 보일 이름
  group: '재고·구매',
  tier: 'fast',                    // fast(짧고 간단) | smart(긴 문서·요약·근거 답변)
  maxTokens: 1200,
  timeoutSec: 90,                  // (선택) 긴 문서만
  input: v.object({ text: v.string({ min: 2, max: 6000, label: '내용' }) }),
  async build(input, ctx) {        // ctx = { clinic, user, today, baseSystem }
    return { prompt: '...' };      // system을 생략하면 공통 원칙(baseSystem)이 붙음. 직접 줄 땐 ctx.baseSystem + '\n\n' + 추가 지시
  },
  demo(input, ctx) { return '키가 없을 때 보여 줄 그럴듯한 예시 응답 (입력을 반영해서)'; },
  parse(text) { return extractJson(text); }, // (선택) 구조화 결과가 필요할 때. require('../../ai/service').extractJson
}
```
- 화면: `const ai = useAI('inventory.parseInvoice'); await ai.run({ text })` → `ai.result = { text, data, demo, pii, notice, usage }`. 결과는 `<${AiResult} ai=${ai} onApply=${...} />`.
- AI 입력칸 바로 위에는 반드시 `<${PiiBanner} />`.
- `demo()`는 키 없이도 기능 흐름을 끝까지 시연할 수 있게, 입력을 반영한 현실적인 예시를 돌려준다. `parse`가 있다면 demo 결과도 parse 가능한 형식이어야 한다(예: JSON 코드블록).
- 프롬프트에 의료광고 규정(효과 보장·과장·비교 금지)과 "모르면 확인 필요" 원칙이 이미 공통으로 들어간다. 기능별 지시만 추가한다.

## 5. 테스트
- `tests/<모듈>.test.js`, Node 내장 `node:test` + `node:assert/strict`. `tests/helpers.js` 의 `startServer({ demo: true })`, `Client`, `makeUser(admin, { name, role, username })` 사용.
- 최소: 목록/추가/수정/삭제, 권한(직원이 실장 전용 API 호출 시 403), 입력 검증(400), 핵심 계산 로직(예: 재고 차감, 연차 잔여, 다음 점검일), 데모 데이터가 들어가는지, AI 기능이 데모 모드로 동작하는지.
- 실행: `node --disable-warning=ExperimentalWarning --test tests/<모듈>.test.js` / 전체: `npm test`
- 각 테스트 파일은 `before`에서 서버를 띄우고 `after`에서 `close()`.

## 6. 데모 데이터
- 가상의 "하늘치과의원" 기준, 현실적인 품목명·업체명(가상)·금액. 실제 회사·사람 이름을 쓰지 않는다(가상 업체명 예: "한빛덴탈", "미소메디칼").
- 날짜는 `ctx.today` 기준 상대값(며칠 전/후)으로 만들어 언제 실행해도 자연스럽게.
- 대시보드가 비어 보이지 않도록 경고·예정 항목이 몇 개 생기게 한다.
