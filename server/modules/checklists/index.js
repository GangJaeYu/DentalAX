/*
 * 이 파일이 하는 일: [A. 데스크] 오픈·마감 체크리스트의 서버 기능입니다.
 *
 *   - 템플릿: "오픈 체크", "마감 체크", "주간 점검"처럼 반복해서 쓰는 점검표. 실장 이상만 만들고 고칩니다.
 *     · 시점(timing): open 오픈 / close 마감 / weekly 주간 / custom 기타
 *     · 요일(weekdays): 어느 요일에 하는 점검인지 (예: 주간 점검은 금요일만)
 *     · 항목(items): 순서가 있는 체크 항목. 도움말(hint)과 필수 여부(required)를 가짐
 *   - 날짜별 수행 기록(run): 날짜 하나 × 템플릿 하나 = 기록 하나. 처음 체크할 때(또는 오늘 화면을 열 때) 만들어집니다.
 *     · 체크하면 "누가, 언제" 했는지 남고, 항목별 짧은 메모(예: "소독제 부족")를 붙일 수 있습니다.
 *     · 필수 항목을 모두 체크하면 완료 도장(누가/언제)이 찍힙니다.
 *     · 기록에는 그날의 항목 내용이 복사돼 남으므로, 나중에 템플릿을 고쳐도 지난 기록은 바뀌지 않습니다.
 *   - 환자 정보는 다루지 않습니다. (메모 칸도 "업무 메모" 용도이며 짧게 제한)
 *
 * API (/api/checklists/...)
 *   GET    /day?date=YYYY-MM-DD        그날 해야 할 체크리스트와 체크 상태 (오늘이면 기록을 자동으로 만듦)
 *   POST   /mark                       체크/체크 해제/메모 { templateId, date, itemId | checkId, checked?, note? }
 *   GET    /history?days=30            최근 N일 템플릿별 완료율 + 최근 메모
 *   GET    /templates                  템플릿 목록(항목 포함)
 *   POST   /templates                  템플릿 만들기 (실장 이상)
 *   PATCH  /templates/:id              템플릿 고치기 (실장 이상)
 *   DELETE /templates/:id              템플릿 삭제 — 수행 기록도 함께 삭제 (실장 이상)
 *   POST   /templates/:id/items        항목 추가 { items: [{ text, hint, required }] } (실장 이상)
 *   PUT    /templates/:id/order        항목 순서 바꾸기 { itemIds: [...] } (실장 이상)
 *   PATCH  /items/:id                  항목 고치기 (실장 이상)
 *   DELETE /items/:id                  항목 삭제 (실장 이상)
 */
const { all, get, run, tx } = require('../../core/db');
const { v, idParam } = require('../../core/validate');
const { notFound, badRequest, HttpError } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { hasRole, requireRole } = require('../../core/auth');
const time = require('../../core/time');
const { aiFeatures } = require('./ai');
const { seed, starter } = require('./seed');

const TIMINGS = ['open', 'close', 'weekly', 'custom'];
const TIMING_LABEL = { open: '오픈', close: '마감', weekly: '주간', custom: '기타' };
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
/** 직원이 지난 날짜 기록을 고칠 수 있는 기간(일). 실장 이상은 제한 없음 */
const STAFF_BACKDATE_DAYS = 7;

const migrations = [
  {
    id: 'checklists_001',
    up: `
      CREATE TABLE checklist_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        timing TEXT NOT NULL DEFAULT 'custom' CHECK (timing IN ('open','close','weekly','custom')),
        weekdays TEXT NOT NULL DEFAULT '1,2,3,4,5,6',   -- 하는 요일 (0=일 ~ 6=토), 쉼표로 구분
        description TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,              -- 0이면 사용 중지 (기록은 남김)
        start_date TEXT NOT NULL,                       -- 이 날부터 기록·완료율 계산에 포함
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE checklist_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        hint TEXT NOT NULL DEFAULT '',
        required INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_checklist_items_tpl ON checklist_items(template_id, sort_order);
      CREATE TABLE checklist_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
        run_date TEXT NOT NULL,
        completed_at TEXT,
        completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        completed_by_name TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (template_id, run_date)
      );
      CREATE INDEX idx_checklist_runs_date ON checklist_runs(run_date);
      -- 그날 기록의 항목 한 줄 (항목 내용을 복사해 둠 → 템플릿을 고쳐도 지난 기록은 그대로)
      CREATE TABLE checklist_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES checklist_runs(id) ON DELETE CASCADE,
        item_id INTEGER REFERENCES checklist_items(id) ON DELETE SET NULL,
        text TEXT NOT NULL,
        hint TEXT NOT NULL DEFAULT '',
        required INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        checked_at TEXT,
        checked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        checked_by_name TEXT,
        note TEXT NOT NULL DEFAULT '',
        note_by_name TEXT
      );
      CREATE INDEX idx_checklist_checks_run ON checklist_checks(run_id);
    `,
  },
];

// ---------- 작은 도우미 ----------
function parseWeekdays(s) {
  return String(s || '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
}

/** [1,2,3,4,5,6] → '월~토', [5] → '금', [1,3,5] → '월·수·금' */
function weekdaysLabel(days) {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 7) return '매일';
  if (!d.length) return '요일 없음';
  const consecutive = d.length >= 3 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  if (consecutive) return `${WEEK[d[0]]}~${WEEK[d[d.length - 1]]}`;
  return d.map((x) => WEEK[x]).join('·');
}

/** 그 날짜가 이 템플릿을 하는 날인지 (요일 + 시작일 + 사용 중) */
function appliesOn(t, date) {
  return !!t.active && t.start_date <= date && parseWeekdays(t.weekdays).includes(time.weekday(date));
}

function templateView(t, items) {
  const days = parseWeekdays(t.weekdays);
  return {
    id: t.id,
    name: t.name,
    timing: t.timing,
    timingLabel: TIMING_LABEL[t.timing],
    weekdays: days,
    weekdaysLabel: weekdaysLabel(days),
    description: t.description,
    sortOrder: t.sort_order,
    active: !!t.active,
    startDate: t.start_date,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    items: items
      ? items.map((i) => ({ id: i.id, text: i.text, hint: i.hint, required: !!i.required, sortOrder: i.sort_order }))
      : undefined,
  };
}

function itemsOf(templateId) {
  return all('SELECT * FROM checklist_items WHERE template_id = ? ORDER BY sort_order, id', templateId);
}

function getTemplate(id) {
  const t = get('SELECT * FROM checklist_templates WHERE id = ?', id);
  if (!t) throw notFound('체크리스트');
  return t;
}

// ---------- 수행 기록(run) ----------
/**
 * 기록의 항목 줄을 지금 템플릿 항목과 맞춥니다. (오늘·미래 기록만. 지난 기록은 그날 모습 그대로 둠)
 *   - 새로 생긴 항목 → 줄 추가
 *   - 삭제된 항목 → 아직 체크 안 한 줄만 지움 (체크한 기록은 남김)
 *   - 고친 항목 → 글·도움말·필수 여부·순서 반영
 */
function syncRun(runRow, templateId) {
  const items = itemsOf(templateId);
  const rows = all('SELECT * FROM checklist_checks WHERE run_id = ?', runRow.id);
  const byItem = new Map(rows.filter((r) => r.item_id).map((r) => [r.item_id, r]));
  const itemIds = new Set(items.map((i) => i.id));
  for (const it of items) {
    const r = byItem.get(it.id);
    if (!r) {
      run(
        'INSERT INTO checklist_checks (run_id, item_id, text, hint, required, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
        runRow.id,
        it.id,
        it.text,
        it.hint,
        it.required,
        it.sort_order
      );
    } else if (r.text !== it.text || r.hint !== it.hint || r.required !== it.required || r.sort_order !== it.sort_order) {
      run('UPDATE checklist_checks SET text = ?, hint = ?, required = ?, sort_order = ? WHERE id = ?', it.text, it.hint, it.required, it.sort_order, r.id);
    }
  }
  for (const r of rows) {
    if ((!r.item_id || !itemIds.has(r.item_id)) && !r.checked_at && !r.note) run('DELETE FROM checklist_checks WHERE id = ?', r.id);
  }
}

/** 그날 기록을 찾고, 없으면 만듭니다 (항목 줄도 함께) */
function ensureRun(templateId, date) {
  let r = get('SELECT * FROM checklist_runs WHERE template_id = ? AND run_date = ?', templateId, date);
  if (!r) {
    const info = run('INSERT INTO checklist_runs (template_id, run_date, created_at) VALUES (?, ?, ?)', templateId, date, time.nowIso());
    r = get('SELECT * FROM checklist_runs WHERE id = ?', info.lastInsertRowid);
    syncRun(r, templateId);
  } else if (date >= time.today()) {
    syncRun(r, templateId);
  }
  return r;
}

/**
 * 완료 여부 계산: 필수 항목을 모두 체크하면 완료.
 * (필수 항목이 하나도 없는 점검표라면 모든 항목을 체크해야 완료)
 * 막 완료됐으면 마지막으로 체크한 사람·시각을 완료 도장으로 남기고, 다시 미완료가 되면 도장을 지웁니다.
 */
function progressOf(rows) {
  const req = rows.filter((r) => r.required);
  const target = req.length ? req : rows;
  const done = rows.filter((r) => r.checked_at).length;
  const reqDone = target.filter((r) => r.checked_at).length;
  return { done, total: rows.length, reqDone, reqTotal: target.length, complete: target.length > 0 && reqDone === target.length };
}

function updateCompletion(runId, user) {
  const r = get('SELECT * FROM checklist_runs WHERE id = ?', runId);
  const rows = all('SELECT * FROM checklist_checks WHERE run_id = ?', runId);
  const p = progressOf(rows);
  if (p.complete && !r.completed_at) {
    run('UPDATE checklist_runs SET completed_at = ?, completed_by = ?, completed_by_name = ? WHERE id = ?', time.nowIso(), user.id, user.name, runId);
  } else if (!p.complete && r.completed_at) {
    run('UPDATE checklist_runs SET completed_at = NULL, completed_by = NULL, completed_by_name = NULL WHERE id = ?', runId);
  }
}

/** 이 사람이 그 날짜 기록을 고칠 수 있는지 */
function canEditDate(user, date) {
  if (date > time.today()) return false;
  if (hasRole(user, 'manager')) return true;
  return time.diffDays(date, time.today()) <= STAFF_BACKDATE_DAYS;
}

/** 화면용: 템플릿 하나의 그날 상태 (기록이 없으면 지금 항목으로 빈 체크표를 보여 줌) */
function dayCard(t, date, user) {
  const r = get('SELECT * FROM checklist_runs WHERE template_id = ? AND run_date = ?', t.id, date);
  let rows;
  if (r) {
    rows = all('SELECT * FROM checklist_checks WHERE run_id = ? ORDER BY sort_order, id', r.id);
  } else {
    rows = itemsOf(t.id).map((i) => ({ id: null, item_id: i.id, text: i.text, hint: i.hint, required: i.required, sort_order: i.sort_order, note: '' }));
  }
  const p = progressOf(rows);
  const editable = canEditDate(user, date);
  const isManager = hasRole(user, 'manager');
  return {
    ...templateView(t),
    runId: r ? r.id : null,
    completedAt: r ? r.completed_at : null,
    completedByName: r ? r.completed_by_name : null,
    progress: { done: p.done, total: p.total, reqDone: p.reqDone, reqTotal: p.reqTotal },
    complete: p.complete,
    editable,
    items: rows.map((c) => ({
      key: c.id ? `c${c.id}` : `i${c.item_id}`,
      checkId: c.id,
      itemId: c.item_id,
      text: c.text,
      hint: c.hint,
      required: !!c.required,
      checked: !!c.checked_at,
      checkedAt: c.checked_at || null,
      checkedById: c.checked_by || null,
      checkedByName: c.checked_by_name || null,
      note: c.note || '',
      noteByName: c.note_by_name || null,
      removed: !!c.id && !c.item_id, // 템플릿에서 지워진 항목 (기록만 남음)
      canUncheck: editable && !!c.checked_at && (isManager || c.checked_by === user.id),
    })),
  };
}

function activeTemplates() {
  return all('SELECT * FROM checklist_templates WHERE active = 1 ORDER BY sort_order, id');
}

// ---------- 입력 검사 ----------
const weekdaysSchema = v.array(v.int({ min: 0, max: 6, label: '요일' }), { min: 1, max: 7, label: '요일' });
const templateSchema = v.object({
  name: v.string({ min: 1, max: 60, label: '이름' }),
  timing: v.enum(TIMINGS, { label: '시점' }),
  weekdays: weekdaysSchema,
  description: v.string({ max: 300, optional: true, default: '', label: '설명' }),
  active: v.bool({ default: true }),
  sortOrder: v.int({ min: 0, max: 999, optional: true, default: null, label: '순서' }),
});
const itemSchema = v.object({
  text: v.string({ min: 1, max: 120, label: '항목' }),
  hint: v.string({ max: 200, optional: true, default: '', label: '도움말' }),
  required: v.bool({ default: true }),
});
const itemsBody = v.object({ items: v.array(itemSchema, { min: 1, max: 40, label: '항목' }) });
const markSchema = v.object({
  templateId: v.id({ label: '체크리스트' }),
  date: v.date({ label: '날짜' }),
  itemId: v.id({ optional: true, label: '항목' }),
  checkId: v.id({ optional: true, label: '항목' }),
  checked: (val) => (val === undefined || val === null ? undefined : v.bool()(val)),
  // 보내지 않으면 undefined(그대로 둠), 빈 글자면 메모 지우기
  note: (val, field) => (val === undefined ? undefined : v.string({ max: 100, optional: true, default: '', label: '메모' })(val, field)),
});

function register(r) {
  const managerOnly = requireRole('manager');

  // 그날의 체크리스트
  r.get('/day', (req, res) => {
    const today = time.today();
    const date = req.query.date && time.isValidDate(req.query.date) ? req.query.date : today;
    const list = activeTemplates();
    const cards = [];
    const notApplicable = [];
    tx(() => {
      for (const t of list) {
        if (!appliesOn(t, date)) {
          // 해당 요일이 아니어도 그날 기록이 이미 있으면 보여 줌
          const has = get('SELECT id FROM checklist_runs WHERE template_id = ? AND run_date = ?', t.id, date);
          if (!has) {
            notApplicable.push({ id: t.id, name: t.name, weekdaysLabel: weekdaysLabel(parseWeekdays(t.weekdays)) });
            continue;
          }
        }
        // 오늘 화면을 열면 기록을 바로 만들어 둠 (기록 탭의 완료율에 오늘도 들어가게)
        if (date === today) ensureRun(t.id, date);
        else {
          const ex = get('SELECT * FROM checklist_runs WHERE template_id = ? AND run_date = ?', t.id, date);
          if (ex && date > today) syncRun(ex, t.id);
        }
        cards.push(dayCard(t, date, req.user));
      }
    });
    res.json({
      date,
      today,
      weekday: time.weekday(date),
      isFuture: date > today,
      editable: canEditDate(req.user, date),
      templates: cards,
      notApplicable,
      templateCount: get('SELECT COUNT(*) AS n FROM checklist_templates').n,
    });
  });

  // 체크 / 체크 해제 / 메모
  r.post('/mark', (req, res) => {
    const d = markSchema.parse(req.body);
    if (!d.itemId && !d.checkId) throw badRequest('어떤 항목인지 알 수 없습니다.');
    if (d.checked === undefined && d.note === undefined) throw badRequest('바꿀 내용이 없습니다.');
    const t = getTemplate(d.templateId);
    if (d.date > time.today()) throw badRequest('미래 날짜는 미리 체크할 수 없습니다.');
    if (!canEditDate(req.user, d.date)) {
      throw new HttpError(403, `직원은 최근 ${STAFF_BACKDATE_DAYS}일 이내 기록만 고칠 수 있습니다. 실장님께 요청해 주세요.`);
    }
    const summary = tx(() => {
      const runRow = ensureRun(t.id, d.date);
      let row;
      if (d.checkId) row = get('SELECT * FROM checklist_checks WHERE id = ? AND run_id = ?', d.checkId, runRow.id);
      else row = get('SELECT * FROM checklist_checks WHERE item_id = ? AND run_id = ?', d.itemId, runRow.id);
      if (!row) throw notFound('체크 항목');
      const now = time.nowIso();
      let what = '';
      if (d.checked === true && !row.checked_at) {
        run('UPDATE checklist_checks SET checked_at = ?, checked_by = ?, checked_by_name = ? WHERE id = ?', now, req.user.id, req.user.name, row.id);
        what = '체크';
      } else if (d.checked === false && row.checked_at) {
        // 체크 해제는 체크한 본인 또는 실장 이상만
        if (row.checked_by !== req.user.id && !hasRole(req.user, 'manager')) {
          throw new HttpError(403, `${row.checked_by_name || '다른 직원'}님이 체크한 항목입니다. 본인이나 실장님만 해제할 수 있습니다.`);
        }
        run('UPDATE checklist_checks SET checked_at = NULL, checked_by = NULL, checked_by_name = NULL WHERE id = ?', row.id);
        what = '체크 해제';
      }
      if (d.note !== undefined && d.note !== row.note) {
        run('UPDATE checklist_checks SET note = ?, note_by_name = ? WHERE id = ?', d.note || '', d.note ? req.user.name : null, row.id);
        what = what ? `${what}·메모` : '메모';
      }
      updateCompletion(runRow.id, req.user);
      return what ? `${t.name} ${d.date} · ${row.text} (${what})` : '';
    });
    if (summary) audit(req, 'update', 'checklist_checks', d.templateId, summary.slice(0, 300));
    res.json(dayCard(t, d.date, req.user));
  });

  // 최근 N일 완료율
  r.get('/history', (req, res) => {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    const to = time.today();
    const from = time.addDays(to, -(days - 1));
    const dates = [];
    for (let i = 0; i < days; i++) dates.push(time.addDays(from, i));
    const templates = all('SELECT * FROM checklist_templates ORDER BY active DESC, sort_order, id');
    const runs = all('SELECT * FROM checklist_runs WHERE run_date BETWEEN ? AND ?', from, to);
    const counts = all(
      `SELECT c.run_id, COUNT(*) AS total, SUM(c.checked_at IS NOT NULL) AS done
       FROM checklist_checks c JOIN checklist_runs r ON r.id = c.run_id
       WHERE r.run_date BETWEEN ? AND ? GROUP BY c.run_id`,
      from,
      to
    );
    const countMap = new Map(counts.map((c) => [c.run_id, c]));
    const runMap = new Map(runs.map((x) => [`${x.template_id}|${x.run_date}`, x]));
    const out = templates.map((t) => {
      let applicable = 0;
      let completed = 0;
      const cells = dates.map((date) => {
        const rr = runMap.get(`${t.id}|${date}`);
        const isDay = (t.active || rr) && t.start_date <= date && parseWeekdays(t.weekdays).includes(time.weekday(date));
        const c = rr ? countMap.get(rr.id) : null;
        const cell = { date, applicable: !!(isDay || rr), done: c ? c.done : 0, total: c ? c.total : 0, complete: !!(rr && rr.completed_at), hasRun: !!rr };
        // 오늘은 아직 진행 중일 수 있으므로 완료했을 때만 완료율에 넣음
        if (cell.applicable && (date < to || cell.complete)) {
          applicable++;
          if (cell.complete) completed++;
        }
        return cell;
      });
      return {
        id: t.id,
        name: t.name,
        timing: t.timing,
        timingLabel: TIMING_LABEL[t.timing],
        active: !!t.active,
        weekdaysLabel: weekdaysLabel(parseWeekdays(t.weekdays)),
        cells,
        applicableDays: applicable,
        completedDays: completed,
        rate: applicable ? Math.round((completed / applicable) * 100) : null,
      };
    });
    const notes = all(
      `SELECT r.run_date AS date, t.name AS templateName, c.text AS itemText, c.note, c.note_by_name AS byName
       FROM checklist_checks c JOIN checklist_runs r ON r.id = c.run_id JOIN checklist_templates t ON t.id = r.template_id
       WHERE c.note != '' AND r.run_date BETWEEN ? AND ? ORDER BY r.run_date DESC, c.id DESC LIMIT 12`,
      from,
      to
    );
    res.json({ from, to, days: dates, templates: out, notes });
  });

  // ----- 템플릿 관리 -----
  r.get('/templates', (req, res) => {
    const rows = all('SELECT * FROM checklist_templates ORDER BY active DESC, sort_order, id');
    res.json({ rows: rows.map((t) => templateView(t, itemsOf(t.id))) });
  });

  r.post('/templates', managerOnly, (req, res) => {
    const d = templateSchema.parse(req.body);
    const extra = req.body && Array.isArray(req.body.items) ? itemsBody.parse({ items: req.body.items }).items : [];
    const now = time.nowIso();
    const id = tx(() => {
      const order = d.sortOrder ?? (get('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM checklist_templates').n);
      const info = run(
        `INSERT INTO checklist_templates (name, timing, weekdays, description, sort_order, active, start_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        d.name,
        d.timing,
        [...new Set(d.weekdays)].sort().join(','),
        d.description,
        order,
        d.active,
        time.today(),
        now,
        now
      );
      extra.forEach((it, i) => {
        run('INSERT INTO checklist_items (template_id, text, hint, required, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)', info.lastInsertRowid, it.text, it.hint, it.required, i + 1, now);
      });
      return info.lastInsertRowid;
    });
    audit(req, 'create', 'checklist_templates', id, `체크리스트 만들기: ${d.name}`);
    res.status(201).json(templateView(getTemplate(id), itemsOf(id)));
  });

  r.patch('/templates/:id', managerOnly, (req, res) => {
    const id = idParam(req.params.id);
    const t = getTemplate(id);
    const d = templateSchema.partial().parse(req.body);
    run(
      `UPDATE checklist_templates SET name = ?, timing = ?, weekdays = ?, description = ?, active = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
      d.name ?? t.name,
      d.timing ?? t.timing,
      d.weekdays ? [...new Set(d.weekdays)].sort().join(',') : t.weekdays,
      d.description ?? t.description,
      'active' in d ? d.active : t.active,
      d.sortOrder ?? t.sort_order,
      time.nowIso(),
      id
    );
    const changedActive = 'active' in d && !!d.active !== !!t.active;
    audit(req, 'update', 'checklist_templates', id, `체크리스트 수정: ${d.name ?? t.name}${changedActive ? (d.active ? ' (다시 사용)' : ' (사용 중지)') : ''}`);
    res.json(templateView(getTemplate(id), itemsOf(id)));
  });

  r.delete('/templates/:id', managerOnly, (req, res) => {
    const id = idParam(req.params.id);
    const t = getTemplate(id);
    run('DELETE FROM checklist_templates WHERE id = ?', id);
    audit(req, 'delete', 'checklist_templates', id, `체크리스트 삭제: ${t.name} (수행 기록 포함)`);
    res.json({ ok: true });
  });

  r.post('/templates/:id/items', managerOnly, (req, res) => {
    const id = idParam(req.params.id);
    const t = getTemplate(id);
    const { items } = itemsBody.parse(req.body);
    const now = time.nowIso();
    tx(() => {
      let order = get('SELECT COALESCE(MAX(sort_order), 0) AS n FROM checklist_items WHERE template_id = ?', id).n;
      for (const it of items) {
        run('INSERT INTO checklist_items (template_id, text, hint, required, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, it.text, it.hint, it.required, ++order, now);
      }
      run('UPDATE checklist_templates SET updated_at = ? WHERE id = ?', now, id);
    });
    audit(req, 'create', 'checklist_items', id, `${t.name}에 항목 ${items.length}개 추가: ${items.map((i) => i.text).join(', ')}`.slice(0, 300));
    res.status(201).json(templateView(getTemplate(id), itemsOf(id)));
  });

  r.put('/templates/:id/order', managerOnly, (req, res) => {
    const id = idParam(req.params.id);
    const t = getTemplate(id);
    const { itemIds } = v.object({ itemIds: v.array(v.id(), { min: 1, max: 200, label: '항목 순서' }) }).parse(req.body);
    const own = new Set(itemsOf(id).map((i) => i.id));
    if (itemIds.length !== own.size || !itemIds.every((x) => own.has(x))) throw badRequest('항목 목록이 맞지 않습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.');
    tx(() => itemIds.forEach((itemId, i) => run('UPDATE checklist_items SET sort_order = ? WHERE id = ?', i + 1, itemId)));
    audit(req, 'update', 'checklist_items', id, `${t.name} 항목 순서 변경`);
    res.json(templateView(t, itemsOf(id)));
  });

  r.patch('/items/:id', managerOnly, (req, res) => {
    const id = idParam(req.params.id);
    const it = get('SELECT * FROM checklist_items WHERE id = ?', id);
    if (!it) throw notFound('항목');
    const d = itemSchema.partial().parse(req.body);
    run('UPDATE checklist_items SET text = ?, hint = ?, required = ? WHERE id = ?', d.text ?? it.text, d.hint ?? it.hint, 'required' in d ? d.required : it.required, id);
    audit(req, 'update', 'checklist_items', id, `체크 항목 수정: ${d.text ?? it.text}`);
    res.json(templateView(getTemplate(it.template_id), itemsOf(it.template_id)));
  });

  r.delete('/items/:id', managerOnly, (req, res) => {
    const id = idParam(req.params.id);
    const it = get('SELECT * FROM checklist_items WHERE id = ?', id);
    if (!it) throw notFound('항목');
    run('DELETE FROM checklist_items WHERE id = ?', id);
    audit(req, 'delete', 'checklist_items', id, `체크 항목 삭제: ${it.text}`);
    res.json(templateView(getTemplate(it.template_id), itemsOf(it.template_id)));
  });
}

// ---------- 대시보드: 오늘 해야 할 체크리스트와 진행률 ----------
function dashboard() {
  const today = time.today();
  const todos = [];
  for (const t of activeTemplates()) {
    if (!appliesOn(t, today)) continue;
    const r = get('SELECT * FROM checklist_runs WHERE template_id = ? AND run_date = ?', t.id, today);
    let p;
    if (r) p = progressOf(all('SELECT required, checked_at FROM checklist_checks WHERE run_id = ?', r.id));
    else {
      const items = all('SELECT required FROM checklist_items WHERE template_id = ?', t.id);
      p = progressOf(items.map((i) => ({ required: i.required, checked_at: null })));
    }
    if (!p.total) continue;
    const doneAt = r && r.completed_at ? new Date(r.completed_at) : null;
    todos.push({
      id: `checklist-${t.id}`,
      module: 'checklists',
      title: t.name,
      detail: p.complete
        ? `완료 · ${r.completed_by_name || ''} ${time.pad(doneAt.getHours())}:${time.pad(doneAt.getMinutes())}`.trim()
        : p.done
          ? `진행 중 · 필수 ${p.reqTotal - p.reqDone}개 남음`
          : '아직 시작 전',
      href: '#/checklists',
      level: p.complete ? 'info' : 'warn',
      icon: 'list-checks',
      progress: { done: p.done, total: p.total },
    });
  }
  return { todos };
}

module.exports = {
  name: 'checklists',
  migrations,
  register,
  aiFeatures,
  seed,
  starter,
  dashboard,
  resetTables: ['checklist_checks', 'checklist_runs', 'checklist_items', 'checklist_templates'],
  // 테스트에서 쓰려고 내보냄
  _internal: { weekdaysLabel, progressOf, appliesOn },
};
