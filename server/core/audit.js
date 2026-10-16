/*
 * 이 파일이 하는 일: "누가, 언제, 무엇을 했는지" 활동 기록(감사 로그)을 남깁니다.
 * 관리 → 활동 기록 화면에서 볼 수 있습니다. 환자 정보는 애초에 없으므로 기록에도 남지 않습니다.
 *
 * 사용 예) audit(req, 'create', 'inv_item', 12, '품목 추가: 니트릴 장갑 M');
 */
const { run } = require('./db');

/** 요청한 사람의 IP 주소 (IPv6 형태 ::ffff:192.168.0.5 → 192.168.0.5) */
function clientIp(req) {
  const ip = (req && (req.socket?.remoteAddress || req.ip)) || '';
  return ip.replace(/^::ffff:/, '');
}

/**
 * @param {object|null} req  Express 요청 (로그인한 사용자 정보가 req.user에 있음). 서버 자동 작업이면 null
 * @param {string} action    create / update / delete / login / ... 같은 동작 이름
 * @param {string} entity    대상 종류 (표 이름과 비슷하게)
 * @param {number|string|null} entityId 대상 번호
 * @param {string} summary   사람이 읽을 한 줄 설명
 */
function audit(req, action, entity, entityId, summary) {
  const user = req && req.user;
  try {
    run(
      `INSERT INTO audit_logs (at, user_id, user_name, action, entity, entity_id, summary, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      new Date().toISOString(),
      user ? user.id : null,
      user ? user.name : req && req.auditName ? req.auditName : '시스템',
      action,
      entity,
      entityId == null ? null : String(entityId),
      String(summary || '').slice(0, 500),
      req ? clientIp(req) : null
    );
  } catch (e) {
    // 기록 실패가 본 작업을 막지 않도록 서버 창에만 알림
    console.error('[활동 기록 실패]', e.message);
  }
}

module.exports = { audit, clientIp };
