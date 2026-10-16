/*
 * 이 파일이 하는 일: [E1. 장비·점검] 장비 목록과 점검·수리 이력 API 입니다.
 *
 *   - 장비마다 "점검 주기(일)"와 "마지막 점검일"을 두고, 다음 점검일 = 마지막 점검일 + 주기 로 계산합니다.
 *   - "정기 점검"·"법정 검사" 기록을 남기면 마지막 점검일이 자동으로 바뀝니다.
 *   - 수리 기록 등을 남길 때 장비 상태(정상/점검 필요/수리 중/사용 중지)를 함께 바꿀 수 있습니다.
 *   - 장비 등록·수정은 실장 이상, 점검 기록 추가는 누구나 할 수 있습니다.
 *
 * API (/api/facility/...)
 *   GET    /equipment                  목록 (status, category, q, archived=1) + 개수 요약
 *   GET    /equipment/:id              상세 + 이력
 *   POST   /equipment                  등록 (실장 이상)
 *   PATCH  /equipment/:id              수정·보관 (실장 이상)
 *   DELETE /equipment/:id              삭제 (실장 이상, 멸균 기록이 있는 멸균기는 보관만 가능)
 *   POST   /equipment/:id/logs         점검·수리 기록 추가 (누구나)
 *   DELETE /equipment/logs/:logId      기록 삭제 (작성자 또는 실장 이상)
 */
const { all, get, run, tx, where } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, forbidden, HttpError } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { requireRole, hasRole } = require('../../core/auth');
const time = require('../../core/time');
const C = require('./common');

const equipmentSchema = v.object({
  name: v.string({ min: 1, max: 80, label: '장비 이름' }),
  category: v.enum(C.EQUIP_CATEGORIES, { label: '분류' }),
  model: v.string({ max: 80, optional: true, label: '모델명' }),
  serialNo: v.string({ max: 80, optional: true, label: '일련번호' }),
  location: v.string({ max: 60, optional: true, label: '위치' }),
  vendorId: v.id({ optional: true, label: '거래처' }),
  asContact: v.string({ max: 120, optional: true, label: 'AS 연락처' }),
  installDate: v.date({ optional: true, label: '설치일' }),
  warrantyUntil: v.date({ optional: true, label: '보증 만료일' }),
  inspectionCycleDays: v.int({ min: 1, max: 3650, optional: true, label: '점검 주기(일)' }),
  lastInspected: v.date({ optional: true, label: '마지막 점검일' }),
  status: v.enum(C.EQUIP_STATUS, { optional: true, default: '정상', label: '상태' }),
  memo: v.string({ max: 2000, optional: true, label: '메모' }),
});

const logSchema = v.object({
  date: v.date({ label: '날짜' }),
  type: v.enum(C.LOG_TYPES, { label: '종류' }),
  description: v.string({ min: 1, max: 1000, label: '내용' }),
  cost: v.int({ min: 0, max: 1000000000, optional: true, label: '비용' }),
  vendorName: v.string({ max: 80, optional: true, label: '업체' }),
  performedBy: v.string({ max: 60, optional: true, label: '작업자' }),
  setStatus: v.enum(C.EQUIP_STATUS, { optional: true, label: '기록 후 상태' }),
});

/** 다음 점검일 계산: 마지막 점검일(없으면 설치일) + 점검 주기 */
function nextDue(e) {
  const base = e.last_inspected || e.install_date;
  if (!base || !e.inspection_cycle_days) return null;
  return time.addDays(base, e.inspection_cycle_days);
}

function toView(e) {
  const due = nextDue(e);
  return {
    id: e.id,
    name: e.name,
    category: e.category,
    model: e.model,
    serialNo: e.serial_no,
    location: e.location,
    vendorId: e.vendor_id,
    vendorName: e.vendor_name || null,
    asContact: e.as_contact,
    installDate: e.install_date,
    warrantyUntil: e.warranty_until,
    warrantyActive: e.warranty_until ? e.warranty_until >= time.today() : null,
    inspectionCycleDays: e.inspection_cycle_days,
    lastInspected: e.last_inspected,
    nextDue: due,
    dday: due ? time.diffDays(time.today(), due) : null,
    status: e.status,
    memo: e.memo,
    active: !!e.active,
    logCount: e.log_count ?? undefined,
    lastLogDate: e.last_log_date ?? undefined,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
}

function logView(l, user) {
  return {
    id: l.id,
    equipmentId: l.equipment_id,
    date: l.date,
    type: l.type,
    description: l.description,
    cost: l.cost,
    vendorName: l.vendor_name,
    performedBy: l.performed_by,
    createdBy: l.created_by,
    createdByName: l.created_by_name || null,
    createdAt: l.created_at,
    canDelete: !!user && (l.created_by === user.id || hasRole(user, 'manager')),
  };
}

function selectSql() {
  const vj = C.vendorJoin('e');
  return `SELECT e.*, ${vj.select},
      (SELECT COUNT(*) FROM equipment_logs l WHERE l.equipment_id = e.id) AS log_count,
      (SELECT MAX(date) FROM equipment_logs l WHERE l.equipment_id = e.id) AS last_log_date
    FROM equipment e ${vj.join}`;
}

function loadOne(id) {
  const e = get(`${selectSql()} WHERE e.id = ?`, id);
  if (!e) throw notFound('장비');
  return e;
}

function register(r) {
  const managerUp = requireRole('manager');

  r.get('/equipment', (req, res) => {
    const q = req.query;
    const category = C.EQUIP_CATEGORIES.includes(q.category) ? q.category : null;
    const w = where([
      [q.archived === '1' ? 'e.active = 0' : 'e.active = 1'],
      [category && 'e.category = :category'],
      [q.q && '(e.name LIKE :q OR e.model LIKE :q OR e.location LIKE :q OR e.serial_no LIKE :q)'],
    ]);
    const rows = all(`${selectSql()} ${w.sql} ORDER BY e.category, e.name`, { category, q: q.q ? `%${q.q}%` : null }).map(toView);
    // 개수 요약은 상태 필터를 적용하기 전 기준
    const counts = {
      total: rows.length,
      overdue: rows.filter((e) => e.dday !== null && e.dday < 0 && e.status !== '사용 중지').length,
      soon: rows.filter((e) => e.dday !== null && e.dday >= 0 && e.dday <= 30 && e.status !== '사용 중지').length,
      attention: rows.filter((e) => e.status === '점검 필요' || e.status === '수리 중').length,
      stopped: rows.filter((e) => e.status === '사용 중지').length,
    };
    let list = rows;
    if (q.status === 'due') list = rows.filter((e) => e.dday !== null && e.dday <= 30 && e.status !== '사용 중지');
    else if (q.status === 'attention') list = rows.filter((e) => e.status === '점검 필요' || e.status === '수리 중');
    else if (C.EQUIP_STATUS.includes(q.status)) list = rows.filter((e) => e.status === q.status);
    // 정렬: 점검이 급한 순 (기한 지남 → 임박 → 나머지)
    list.sort((a, b) => (a.dday ?? 99999) - (b.dday ?? 99999) || a.name.localeCompare(b.name, 'ko'));
    res.json({ rows: list, counts, vendorsAvailable: C.tableExists('vendors') });
  });

  r.get('/equipment/:id', (req, res) => {
    const id = idParam(req.params.id);
    const e = loadOne(id);
    const logs = all(
      `SELECT l.*, u.name AS created_by_name FROM equipment_logs l LEFT JOIN users u ON u.id = l.created_by
       WHERE l.equipment_id = ? ORDER BY l.date DESC, l.id DESC`,
      id
    );
    const sterCount = get('SELECT COUNT(*) AS n FROM sterilization_logs WHERE sterilizer_id = ?', id).n;
    const totalCost = logs.reduce((s, l) => s + (l.cost || 0), 0);
    res.json({
      ...toView(e),
      logs: logs.map((l) => logView(l, req.user)),
      totalCost,
      sterilizationCount: sterCount,
      canEdit: hasRole(req.user, 'manager'),
    });
  });

  r.post('/equipment', managerUp, (req, res) => {
    const d = equipmentSchema.parse(req.body);
    C.checkVendor(d.vendorId);
    const now = time.nowIso();
    const info = run(
      `INSERT INTO equipment (name, category, model, serial_no, location, vendor_id, as_contact, install_date, warranty_until,
         inspection_cycle_days, last_inspected, status, memo, active, created_at, updated_at)
       VALUES (:name, :category, :model, :serialNo, :location, :vendorId, :asContact, :installDate, :warrantyUntil,
         :inspectionCycleDays, :lastInspected, :status, :memo, 1, :now, :now)`,
      { ...d, now }
    );
    audit(req, 'create', 'equipment', info.lastInsertRowid, `장비 등록: ${d.name}`);
    res.status(201).json(toView(loadOne(info.lastInsertRowid)));
  });

  r.patch('/equipment/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const e = loadOne(id);
    const d = equipmentSchema.partial().parse(req.body);
    if ('vendorId' in d) C.checkVendor(d.vendorId);
    const active = req.body.active === undefined ? e.active : v.bool()(req.body.active) ? 1 : 0;
    // 보낸 칸만 바꾸고 나머지는 그대로 둠
    const pick = (key, col) => (key in d ? d[key] : e[col]);
    run(
      `UPDATE equipment SET name = ?, category = ?, model = ?, serial_no = ?, location = ?, vendor_id = ?, as_contact = ?,
         install_date = ?, warranty_until = ?, inspection_cycle_days = ?, last_inspected = ?, status = ?, memo = ?, active = ?, updated_at = ?
       WHERE id = ?`,
      pick('name', 'name'),
      pick('category', 'category'),
      pick('model', 'model'),
      pick('serialNo', 'serial_no'),
      pick('location', 'location'),
      pick('vendorId', 'vendor_id'),
      pick('asContact', 'as_contact'),
      pick('installDate', 'install_date'),
      pick('warrantyUntil', 'warranty_until'),
      pick('inspectionCycleDays', 'inspection_cycle_days'),
      pick('lastInspected', 'last_inspected'),
      d.status || e.status,
      pick('memo', 'memo'),
      active,
      time.nowIso(),
      id
    );
    const note = active !== e.active ? (active ? ' (보관 해제)' : ' (보관)') : '';
    audit(req, 'update', 'equipment', id, `장비 수정: ${d.name || e.name}${note}`);
    res.json(toView(loadOne(id)));
  });

  r.delete('/equipment/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const e = loadOne(id);
    // 멸균 기록은 법적으로 보관해야 할 수 있으므로, 기록이 남아 있는 멸균기는 지우지 않고 보관하도록 안내
    const ster = get('SELECT COUNT(*) AS n FROM sterilization_logs WHERE sterilizer_id = ?', id).n;
    if (ster > 0) {
      throw new HttpError(409, `이 멸균기에는 멸균 기록 ${ster}건이 연결되어 있어 삭제할 수 없습니다. 더 쓰지 않는 장비라면 [보관]을 눌러 주세요.`);
    }
    run('DELETE FROM equipment WHERE id = ?', id);
    audit(req, 'delete', 'equipment', id, `장비 삭제: ${e.name}`);
    res.json({ ok: true });
  });

  r.post('/equipment/:id/logs', (req, res) => {
    const id = idParam(req.params.id);
    const e = loadOne(id);
    const d = logSchema.parse(req.body);
    const now = time.nowIso();
    const logId = tx(() => {
      const info = run(
        `INSERT INTO equipment_logs (equipment_id, date, type, description, cost, vendor_name, performed_by, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        d.date,
        d.type,
        d.description,
        d.cost,
        d.vendorName,
        d.performedBy,
        req.user.id,
        now
      );
      // 정기 점검·법정 검사 기록이면 마지막 점검일을 새로 고침 (예전 날짜를 늦게 입력한 경우엔 되돌리지 않음)
      if (C.INSPECTION_TYPES.includes(d.type) && (!e.last_inspected || d.date > e.last_inspected)) {
        run('UPDATE equipment SET last_inspected = ?, updated_at = ? WHERE id = ?', d.date, now, id);
      }
      if (d.setStatus && d.setStatus !== e.status) {
        run('UPDATE equipment SET status = ?, updated_at = ? WHERE id = ?', d.setStatus, now, id);
      }
      return info.lastInsertRowid;
    });
    audit(req, 'create', 'equipment_logs', logId, `장비 기록 추가: ${e.name} · ${d.type}${d.setStatus && d.setStatus !== e.status ? ` (상태 → ${d.setStatus})` : ''}`);
    res.status(201).json({ id: logId, equipment: toView(loadOne(id)) });
  });

  r.delete('/equipment/logs/:logId', (req, res) => {
    const logId = idParam(req.params.logId);
    const l = get('SELECT * FROM equipment_logs WHERE id = ?', logId);
    if (!l) throw notFound('기록');
    if (l.created_by !== req.user.id && !hasRole(req.user, 'manager')) throw forbidden();
    const e = loadOne(l.equipment_id);
    tx(() => {
      run('DELETE FROM equipment_logs WHERE id = ?', logId);
      // 지운 기록이 마지막 점검일의 근거였다면, 남은 점검 기록 중 가장 최근 날짜로 되돌림
      if (C.INSPECTION_TYPES.includes(l.type) && e.last_inspected === l.date) {
        const prev = get(
          `SELECT MAX(date) AS d FROM equipment_logs WHERE equipment_id = ? AND type IN ('정기 점검', '법정 검사')`,
          l.equipment_id
        ).d;
        if (prev) run('UPDATE equipment SET last_inspected = ?, updated_at = ? WHERE id = ?', prev, time.nowIso(), l.equipment_id);
      }
    });
    audit(req, 'delete', 'equipment_logs', logId, `장비 기록 삭제: ${e.name} · ${l.type} (${l.date})`);
    res.json({ ok: true, equipment: toView(loadOne(l.equipment_id)) });
  });
}

/** 대시보드용: 30일 안에 점검해야 하거나 이미 지난 장비 */
function dueSoon() {
  return all(`SELECT * FROM equipment WHERE active = 1 AND status != '사용 중지'`)
    .map(toView)
    .filter((e) => e.dday !== null && e.dday <= 30);
}

module.exports = { register, toView, nextDue, dueSoon };
