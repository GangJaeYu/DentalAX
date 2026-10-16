/*
 * 이 파일이 하는 일: 오류를 "쉬운 한국어 안내"로 바꿔 화면에 돌려주는 규칙을 모아 둡니다.
 *
 * 서버 코드 어디서든 `throw new HttpError(400, '이름을 입력해 주세요')` 처럼 던지면,
 * 맨 끝의 errorHandler가 받아서 { error: { code, message } } 형태로 화면에 보냅니다.
 */

class HttpError extends Error {
  /**
   * @param {number} status HTTP 상태 코드 (400 잘못된 입력, 401 로그인 필요, 403 권한 없음, 404 없음, 409 충돌)
   * @param {string} message 사용자에게 보여 줄 한국어 문장
   * @param {object} [extra] 화면에 함께 보낼 추가 정보 (예: 어떤 칸이 잘못됐는지)
   */
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const notFound = (what = '항목') => new HttpError(404, `${what}을(를) 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.`);
const forbidden = () => new HttpError(403, '이 작업을 할 권한이 없습니다. 원장님이나 실장님께 요청해 주세요.');
const badRequest = (msg, extra) => new HttpError(400, msg, extra);

/** Express 맨 끝에 붙는 오류 처리기 */
function errorHandler(err, req, res, _next) {
  // 요청 본문(JSON)이 깨졌거나 너무 큰 경우
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 400, message: '보낸 내용의 형식이 올바르지 않습니다.' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 413, message: '보낸 내용(파일)이 너무 큽니다.' } });
  }
  // 입력 검사 함수를 직접 불러 쓴 곳에서 난 검사 오류도 400 으로 안내
  if (err && err.name === 'ValidationError') {
    return res.status(400).json({ error: { code: 400, message: err.message, field: err.field } });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.status, message: err.message, ...(err.extra || {}) } });
  }
  // DB 제약 조건 위반 (같은 아이디 중복 등)
  if (err && typeof err.message === 'string' && err.message.includes('UNIQUE constraint failed')) {
    return res.status(409).json({ error: { code: 409, message: '이미 같은 값이 등록되어 있습니다.' } });
  }
  if (err && typeof err.message === 'string' && err.message.includes('FOREIGN KEY constraint failed')) {
    return res.status(409).json({ error: { code: 409, message: '다른 기록에서 사용 중이라 처리할 수 없습니다.' } });
  }
  // 예상하지 못한 오류: 자세한 내용은 서버 창에만 남기고, 화면에는 일반 안내만 보냄 (내부 정보 노출 방지)
  console.error('[오류]', req.method, req.originalUrl, err);
  return res.status(500).json({ error: { code: 500, message: '처리 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.' } });
}

module.exports = { HttpError, notFound, forbidden, badRequest, errorHandler };
