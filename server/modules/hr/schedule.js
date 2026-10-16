/*
 * 이 파일이 하는 일: [근무표] 서버 기능입니다. (근무 유형, 공휴일·휴진 요일 설정, 월간 근무표 입력·복사)
 *
 * API (/api/hr/...)
 *   GET    /settings                 휴진 요일 설정 보기            PUT /settings (실장 이상)
 *   GET    /shift-types              근무 유형 목록                 POST/PATCH/DELETE (실장 이상)
 *   GET    /holidays?year=2026       공휴일 목록                    POST /holidays, DELETE /holidays/:id (실장 이상)
 *   POST   /holidays/fixed           그해 날짜 고정 공휴일 8개 한 번에 넣기 (실장 이상)
 *   GET    /schedule?month=2026-10   한 달 근무표 (직원, 날짜, 근무, 승인된 휴가 표시)
 *   PUT    /schedule/entry           칸 하나 입력/지우기 (실장 이상)
 *   POST   /schedule/bulk            여러 칸 한 번에 (실장 이상)
 *   POST   /schedule/copy            패턴 복사: 전월 같은 요일 / 한 주 패턴 반복 (실장 이상)
 */
const { all, get, run, tx } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, badRequest } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { requireRole } = require('../../core/auth');
const { getSetting, setSetting } = require('../../core/settings');
const time = require('../../core/time');
const lib = require('./lib');
const { FIXED_HOLIDAYS } = require('./migrations');

const timeRule = (label) =>
  v.string({ optional: true, max: 5, label, pattern: /^([01]\d|2[0-3]):[0-5]\d$/, patternMessage: '시각은 09:30 처럼 입력해 주세요.' });
const colorRule = v.string({ optional: true, max: 7, label: '색', pattern: /^#[0-9a-fA-F]{6}$/, patternMessage: '색 형식이 올바르지 않습니다.' });

const shiftSchema = v.object({
  code: v.string({ min: 1, max: 4, label: '짧은 이름' }),
  name: v.string({ min: 1, max: 30, label: '이름' }),
  startTime: timeRule('시작 시각'),
  endTime: timeRule('끝 시각'),
  hours: v.number({ min: 0, max: 24, label: '근무 시간', optional: true, default: 0 }),
  color: colorRule,
  isOff: v.bool(),
  sort: v.int({ min: 0, max: 999, optional: true, default: 0 }),
});

function shiftView(s) {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    startTime: s.start_time,
    endTime: s.end_time,
    hours: s.hours,
    color: s.color,
    isOff: !!s.is_off,
    sort: s.sort,
    archived: !!s.archived,
  };
}

function listShiftTypes(includeArchived) {
  return all(`SELECT * FROM shift_types ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY archived, sort, id`).map(shiftView);
}

/** 한 칸 저장 (shiftTypeId 가 없으면 지움). 묶음 처리 안에서 여러 번 부를 수 있게 따로 뺐습니다. */
function saveEntry(userId, date, shiftTypeId, note, byUserId) {
  if (!shiftTypeId) return run('DELETE FROM schedule_entries WHERE user_id = ? AND date = ?', userId, date).changes;
  return run(
    `INSERT INTO schedule_entries (user_id, date, shift_type_id, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET shift_type_id = excluded.shift_type_id, note = excluded.note,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    userId,
    date,
    shiftTypeId,
    note || null,
    byUserId,
    time.nowIso()
  ).changes;
}

/** 한 달 근무표 데이터 만들기 */
function monthSchedule(month) {
  const first = `${month}-01`;
  const last = `${month}-${String(time.daysInMonth(month)).padStart(2, '0')}`;
  const closed = lib.closedWeekdays();
  const hol = lib.holidayMap(first, last);
  const days = lib.dateRange(first, last).map((d) => ({
    date: d,
    day: Number(d.slice(8)),
    weekday: time.weekday(d),
    weekdayLabel: lib.WEEK[time.weekday(d)],
    holiday: hol[d] || null,
    closed: closed.includes(time.weekday(d)),
  }));
  const staff = lib.activeStaff();
  const entries = {};
  for (const e of all('SELECT user_id, date, shift_type_id, note FROM schedule_entries WHERE date BETWEEN ? AND ?', first, last)) {
    (entries[e.user_id] ||= {})[e.date] = { shiftTypeId: e.shift_type_id, note: e.note };
  }
  // 승인된 휴가(+ 승인 대기)를 칸에 겹쳐 보여 주기 위한 정보 (사유는 보내지 않음)
  const leaves = {};
  const rows = all(
    `SELECT id, user_id, type, start_date, end_date, status FROM leave_requests
     WHERE status IN ('approved','pending') AND start_date <= ? AND end_date >= ?`,
    last,
    first
  );
  for (const l of rows) {
    for (const d of lib.dateRange(l.start_date < first ? first : l.start_date, l.end_date > last ? last : l.end_date)) {
      const cur = (leaves[l.user_id] ||= {})[d];
      // 같은 날 승인된 휴가가 있으면 그것을 우선
      if (!cur || (cur.status === 'pending' && l.status === 'approved')) {
        leaves[l.user_id][d] = { id: l.id, type: l.type, status: l.status, half: lib.HALF_TYPES.includes(l.type) };
      }
    }
  }
  return { month, today: time.today(), days, staff, entries, leaves, shiftTypes: listShiftTypes(true), closedWeekdays: closed };
}

/** 'YYYY-MM' 의 n번째 요일(예: 셋째 목요일) 날짜. 없으면(다섯째) 그달 마지막 같은 요일 */
function nthWeekdayOf(month, weekday, nth) {
  const days = time.daysInMonth(month);
  const list = [];
  for (let d = 1; d <= days; d++) {
    const s = `${month}-${String(d).padStart(2, '0')}`;
    if (time.weekday(s) === weekday) list.push(s);
  }
  return list[Math.min(nth, list.length) - 1];
}

function register(r) {
  const managerUp = requireRole('manager');

  // ---------- 휴진 요일 설정 ----------
  r.get('/settings', (req, res) => res.json({ closedWeekdays: lib.closedWeekdays() }));

  r.put('/settings', managerUp, (req, res) => {
    const d = v.object({ closedWeekdays: v.array(v.int({ min: 0, max: 6, label: '요일' }), { max: 7, label: '휴진 요일' }) }).parse(req.body);
    const closedWeekdays = [...new Set(d.closedWeekdays)].sort();
    setSetting('hr', { ...(getSetting('hr') || {}), closedWeekdays });
    audit(req, 'update', 'settings', 'hr', `정기 휴진 요일: ${closedWeekdays.map((n) => lib.WEEK[n]).join(', ') || '없음'}`);
    res.json({ closedWeekdays });
  });

  // ---------- 근무 유형 ----------
  r.get('/shift-types', (req, res) => res.json(listShiftTypes(req.query.all === '1')));

  r.post('/shift-types', managerUp, (req, res) => {
    const d = shiftSchema.parse(req.body);
    const now = time.nowIso();
    const info = run(
      `INSERT INTO shift_types (code, name, start_time, end_time, hours, color, is_off, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.code,
      d.name,
      d.startTime,
      d.endTime,
      d.isOff ? 0 : d.hours || 0,
      d.color || '#2f6fed',
      d.isOff,
      d.sort || (get('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM shift_types').n),
      now,
      now
    );
    audit(req, 'create', 'shift_types', info.lastInsertRowid, `근무 유형 추가: ${d.name}`);
    res.status(201).json(shiftView(get('SELECT * FROM shift_types WHERE id = ?', info.lastInsertRowid)));
  });

  r.patch('/shift-types/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const s = get('SELECT * FROM shift_types WHERE id = ?', id);
    if (!s) throw notFound('근무 유형');
    const d = shiftSchema.partial().parse(req.body);
    const archived = req.body.archived === undefined ? s.archived : v.bool()(req.body.archived) ? 1 : 0;
    const isOff = 'isOff' in d ? (d.isOff ? 1 : 0) : s.is_off;
    run(
      `UPDATE shift_types SET code = ?, name = ?, start_time = ?, end_time = ?, hours = ?, color = ?, is_off = ?, sort = ?, archived = ?, updated_at = ? WHERE id = ?`,
      d.code ?? s.code,
      d.name ?? s.name,
      'startTime' in d ? d.startTime : s.start_time,
      'endTime' in d ? d.endTime : s.end_time,
      isOff ? 0 : d.hours ?? s.hours,
      d.color ?? s.color,
      isOff,
      d.sort ?? s.sort,
      archived,
      time.nowIso(),
      id
    );
    audit(req, 'update', 'shift_types', id, `근무 유형 수정: ${d.name ?? s.name}`);
    res.json(shiftView(get('SELECT * FROM shift_types WHERE id = ?', id)));
  });

  // 이미 근무표에 쓰인 유형은 지우면 지난 근무표가 사라지므로 "숨김(보관)"으로 바꿉니다.
  r.delete('/shift-types/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const s = get('SELECT * FROM shift_types WHERE id = ?', id);
    if (!s) throw notFound('근무 유형');
    const used = get('SELECT COUNT(*) AS n FROM schedule_entries WHERE shift_type_id = ?', id).n;
    if (used > 0) {
      run('UPDATE shift_types SET archived = 1, updated_at = ? WHERE id = ?', time.nowIso(), id);
      audit(req, 'update', 'shift_types', id, `근무 유형 숨김(근무표에서 ${used}칸 사용 중): ${s.name}`);
      return res.json({ ok: true, archived: true, used });
    }
    run('DELETE FROM shift_types WHERE id = ?', id);
    audit(req, 'delete', 'shift_types', id, `근무 유형 삭제: ${s.name}`);
    res.json({ ok: true, archived: false });
  });

  // ---------- 공휴일 ----------
  r.get('/holidays', (req, res) => {
    const year = Number(req.query.year) || Number(time.today().slice(0, 4));
    const rows = all('SELECT id, date, name FROM holidays WHERE date BETWEEN ? AND ? ORDER BY date', `${year}-01-01`, `${year}-12-31`);
    res.json({ year, rows: rows.map((h) => ({ ...h, weekdayLabel: lib.WEEK[time.weekday(h.date)] })) });
  });

  r.post('/holidays', managerUp, (req, res) => {
    const d = v.object({ date: v.date({ label: '날짜' }), name: v.string({ min: 1, max: 30, label: '이름' }) }).parse(req.body);
    if (get('SELECT id FROM holidays WHERE date = ?', d.date)) throw badRequest('이 날짜에는 이미 공휴일이 등록되어 있습니다.', { field: 'date' });
    const info = run('INSERT INTO holidays (date, name, created_at) VALUES (?, ?, ?)', d.date, d.name, time.nowIso());
    audit(req, 'create', 'holidays', info.lastInsertRowid, `공휴일 추가: ${d.date} ${d.name}`);
    res.status(201).json({ id: info.lastInsertRowid, ...d });
  });

  r.post('/holidays/fixed', managerUp, (req, res) => {
    const { year } = v.object({ year: v.int({ min: 2000, max: 2100, label: '연도' }) }).parse(req.body);
    let added = 0;
    tx(() => {
      for (const [md, name] of FIXED_HOLIDAYS) {
        added += run('INSERT OR IGNORE INTO holidays (date, name, created_at) VALUES (?, ?, ?)', `${year}-${md}`, name, time.nowIso()).changes;
      }
    });
    audit(req, 'create', 'holidays', year, `${year}년 고정 공휴일 ${added}개 추가`);
    res.json({ ok: true, added });
  });

  r.delete('/holidays/:id', managerUp, (req, res) => {
    const id = idParam(req.params.id);
    const h = get('SELECT * FROM holidays WHERE id = ?', id);
    if (!h) throw notFound('공휴일');
    run('DELETE FROM holidays WHERE id = ?', id);
    audit(req, 'delete', 'holidays', id, `공휴일 삭제: ${h.date} ${h.name}`);
    res.json({ ok: true });
  });

  // ---------- 월간 근무표 ----------
  r.get('/schedule', (req, res) => {
    const month = lib.monthParam(req.query.month);
    res.json(monthSchedule(month));
  });

  const entrySchema = v.object({
    userId: v.id({ label: '직원' }),
    date: v.date({ label: '날짜' }),
    shiftTypeId: v.id({ optional: true, label: '근무 유형' }),
    note: v.string({ max: 60, optional: true, label: '메모' }),
  });

  /** 입력값 확인: 재직 중인 직원과 있는 근무 유형인지 */
  function checkEntry(d, shiftIds) {
    if (!lib.activeUser(d.userId)) throw badRequest('재직 중인 직원이 아닙니다.', { field: 'userId' });
    if (d.shiftTypeId && !shiftIds.has(d.shiftTypeId)) throw badRequest('없는 근무 유형입니다.', { field: 'shiftTypeId' });
  }
  const shiftIdSet = () => new Set(all('SELECT id FROM shift_types').map((s) => s.id));

  r.put('/schedule/entry', managerUp, (req, res) => {
    const d = entrySchema.parse(req.body);
    checkEntry(d, shiftIdSet());
    saveEntry(d.userId, d.date, d.shiftTypeId, d.note, req.user.id);
    const e = get('SELECT shift_type_id, note FROM schedule_entries WHERE user_id = ? AND date = ?', d.userId, d.date);
    // 칸 하나하나는 자주 바뀌므로 활동 기록은 남기지 않습니다(묶음 작업만 기록).
    res.json({ userId: d.userId, date: d.date, entry: e ? { shiftTypeId: e.shift_type_id, note: e.note } : null });
  });

  r.post('/schedule/bulk', managerUp, (req, res) => {
    const d = v.object({ entries: v.array(entrySchema, { min: 1, max: 1000, label: '근무 칸' }) }).parse(req.body);
    const ids = shiftIdSet();
    const users = new Set();
    let changed = 0;
    tx(() => {
      for (const e of d.entries) {
        if (!users.has(e.userId)) {
          checkEntry(e, ids);
          users.add(e.userId);
        } else if (e.shiftTypeId && !ids.has(e.shiftTypeId)) throw badRequest('없는 근무 유형입니다.');
        changed += saveEntry(e.userId, e.date, e.shiftTypeId, e.note, req.user.id);
      }
    });
    audit(req, 'update', 'schedule_entries', null, `근무표 ${d.entries.length}칸 한 번에 입력`);
    res.json({ ok: true, changed });
  });

  /**
   * 패턴 복사
   *  - mode 'prevMonth' : 전월의 "같은 주차·같은 요일" 근무를 이번 달에 복사 (예: 9월 셋째 목요일 → 10월 셋째 목요일)
   *  - mode 'week'      : weekStart 부터 7일간의 근무를 그 다음 주들에 반복 (untilEnd=false 면 바로 다음 1주만)
   *  - 공휴일은 건너뛰고, overwrite 가 아니면 이미 입력된 칸은 그대로 둡니다.
   */
  r.post('/schedule/copy', managerUp, (req, res) => {
    const d = v
      .object({
        month: v.month({ label: '월' }),
        mode: v.enum(['prevMonth', 'week'], { label: '복사 방식' }),
        weekStart: v.date({ optional: true, label: '기준 주' }),
        untilEnd: v.bool({ default: true }),
        overwrite: v.bool(),
      })
      .parse(req.body);
    if (d.mode === 'week' && !d.weekStart) throw badRequest('복사할 기준 주를 골라 주세요.', { field: 'weekStart' });
    const first = `${d.month}-01`;
    const last = `${d.month}-${String(time.daysInMonth(d.month)).padStart(2, '0')}`;
    const hol = lib.holidayMap(first, last);
    const staff = lib.activeStaff();
    // 원본 날짜 → 대상 날짜 짝 만들기
    const pairs = [];
    if (d.mode === 'prevMonth') {
      const prev = time.addMonthsYm(d.month, -1);
      for (const t of lib.dateRange(first, last)) {
        const nth = Math.ceil(Number(t.slice(8)) / 7);
        pairs.push([nthWeekdayOf(prev, time.weekday(t), nth), t]);
      }
    } else {
      const srcEnd = time.addDays(d.weekStart, 6);
      const limit = d.untilEnd ? last : time.addDays(srcEnd, 7);
      const from = time.addDays(srcEnd, 1) > first ? time.addDays(srcEnd, 1) : first;
      for (const t of lib.dateRange(from, limit < last ? limit : last)) {
        pairs.push([time.addDays(d.weekStart, time.diffDays(d.weekStart, t) % 7), t]);
      }
    }
    const srcDates = [...new Set(pairs.map((p) => p[0]))];
    const src = {};
    if (srcDates.length) {
      const minD = srcDates.reduce((a, b) => (a < b ? a : b));
      const maxD = srcDates.reduce((a, b) => (a > b ? a : b));
      for (const e of all('SELECT user_id, date, shift_type_id FROM schedule_entries WHERE date BETWEEN ? AND ?', minD, maxD)) src[`${e.user_id}|${e.date}`] = e.shift_type_id;
    }
    const existing = new Set(all('SELECT user_id, date FROM schedule_entries WHERE date BETWEEN ? AND ?', first, last).map((e) => `${e.user_id}|${e.date}`));
    let changed = 0;
    let skippedHoliday = 0;
    tx(() => {
      for (const [s, t] of pairs) {
        if (hol[t]) {
          skippedHoliday++;
          continue;
        }
        for (const u of staff) {
          const shift = src[`${u.id}|${s}`];
          if (!shift) continue;
          if (!d.overwrite && existing.has(`${u.id}|${t}`)) continue;
          changed += saveEntry(u.id, t, shift, null, req.user.id);
        }
      }
    });
    const label = d.mode === 'prevMonth' ? '전월 같은 요일 패턴' : `${d.weekStart} 주 패턴`;
    audit(req, 'update', 'schedule_entries', d.month, `근무표 복사(${label} → ${d.month}): ${changed}칸`);
    res.json({ ok: true, changed, skippedHoliday });
  });
}

module.exports = { register, monthSchedule, saveEntry, listShiftTypes };
