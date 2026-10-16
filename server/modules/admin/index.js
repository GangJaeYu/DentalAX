/*
 * 이 파일이 하는 일: "관리" 메뉴의 서버 기능입니다.
 *   사용자·권한, 병원 정보, AI 설정(공급자·키·모델·가격·예산), AI 사용량, 백업·복원, 활동 기록, 초기화, 시스템 정보
 *
 * 권한: 대부분 원장·관리자(admin) 전용. AI 사용량 보기는 실장(manager) 이상. 직원 목록(people)과 병원 정보 보기는 모두.
 */
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { all, get, run, tx, where } = require('../../core/db');
const auth = require('../../core/auth');
const { v, idParam } = require('../../core/validate');
const { HttpError, badRequest, notFound } = require('../../core/errors');
const { audit } = require('../../core/audit');
const { getSetting, setSetting, patchSetting } = require('../../core/settings');
const backup = require('../../core/backup');
const csv = require('../../core/csv');
const secrets = require('../../core/secrets');
const ai = require('../../ai/service');
const { PROVIDERS, defaultAiSettings } = require('../../ai/defaults');
const db = require('../../core/db');
const cfg = require('../../core/config');

const ROLES = ['admin', 'manager', 'staff'];
const JOBS = ['원장', '실장', '치과위생사', '간호조무사', '치과기공사', '코디네이터', '기타'];
const COLORS = ['#6366f1', '#0ea5e9', '#14b8a6', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#ef4444', '#64748b', '#84cc16'];

const usernameRule = v.string({
  min: 3,
  max: 30,
  label: '아이디',
  optional: true,
  pattern: /^[a-zA-Z0-9._-]+$/,
  patternMessage: '영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 쓸 수 있습니다.',
});

function userRow(u) {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    hasLogin: !!u.password_hash,
    role: u.role,
    roleLabel: auth.ROLE_LABEL[u.role],
    jobTitle: u.job_title,
    hireDate: u.hire_date,
    status: u.status,
    color: u.color,
    locked: !!(u.locked_until && Date.parse(u.locked_until) > Date.now()),
    mustChangePassword: !!u.must_change_password,
    lastLoginAt: u.last_login_at,
    isDemo: !!u.is_demo,
  };
}

/** 마지막 남은 관리자를 지우거나 강등하지 못하게 */
function ensureNotLastAdmin(userId) {
  const n = get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND password_hash IS NOT NULL AND id != ?", userId).n;
  if (n === 0) throw badRequest('로그인할 수 있는 관리자가 최소 1명은 있어야 합니다.');
}

/** AI 설정을 화면으로 보낼 때: 키 자체는 빼고 "저장됨/끝 4자리"만 */
function aiSettingsView() {
  const s = ai.getAiSettings();
  const st = secrets.secretStatus();
  const keys = {};
  for (const p of Object.keys(PROVIDERS)) {
    if (p === 'demo') continue;
    const k = st[`ai_key_${p}`];
    keys[p] = k ? { saved: true, hint: k.hint, readable: k.readable, updatedAt: k.updatedAt } : { saved: false };
  }
  const features = ai.listFeatures().map((f) => ({
    key: f.key,
    label: f.label,
    group: f.group,
    defaultTier: f.tier,
    tier: ai.tierFor(f, s),
  }));
  return { settings: s, keys, providers: PROVIDERS, features, budget: ai.budgetStatus(s) };
}

const userCreateSchema = v.object({
  name: v.string({ min: 1, max: 30, label: '이름' }),
  role: v.enum(ROLES, { label: '권한', default: 'staff', optional: true }),
  jobTitle: v.enum(JOBS, { label: '직종', default: '기타', optional: true }),
  hireDate: v.date({ label: '입사일', optional: true }),
  color: v.string({ max: 20, optional: true }),
  username: usernameRule,
  password: v.string({ max: 128, optional: true, trim: false, label: '임시 비밀번호' }),
});

const aiSettingsSchema = v.object({
  provider: v.enum(Object.keys(PROVIDERS), { label: 'AI 공급자' }),
  models: v.object({
    anthropic: v.object({ fast: v.string({ min: 1, max: 80 }), smart: v.string({ min: 1, max: 80 }) }),
    openai: v.object({ fast: v.string({ min: 1, max: 80 }), smart: v.string({ min: 1, max: 80 }) }),
    gemini: v.object({ fast: v.string({ min: 1, max: 80 }), smart: v.string({ min: 1, max: 80 }) }),
  }),
  openaiBaseUrl: v.string({
    max: 200,
    optional: true,
    default: '',
    pattern: /^https?:\/\/[^\s]+$/,
    patternMessage: 'http:// 또는 https:// 로 시작하는 주소를 입력해 주세요.',
  }),
  openaiReasoningEffort: v.enum(['none', 'minimal', 'low', 'medium', 'high'], { optional: true, default: 'low' }),
  featureTiers: v.object({}, { optional: true }),
  monthlyBudgetKrw: v.int({ min: 0, max: 100000000, label: '월 예산' }),
  budgetAction: v.enum(['block', 'warn'], { label: '예산 초과 시 동작' }),
  warnRatio: v.number({ min: 0.1, max: 1, optional: true, default: 0.8 }),
  exchangeRate: v.number({ min: 100, max: 10000, label: '환율' }),
  piiMode: v.enum(['mask', 'block'], { label: '개인정보 필터 방식' }),
  timeoutSec: v.int({ min: 10, max: 300, label: '응답 대기 시간' }),
  prices: v.array(
    v.object({
      provider: v.enum(['anthropic', 'openai', 'gemini'], { label: '공급자' }),
      model: v.string({ min: 1, max: 80, label: '모델 이름' }),
      label: v.string({ max: 80, optional: true, default: '' }),
      input: v.number({ min: 0, max: 1000, label: '입력 단가' }),
      output: v.number({ min: 0, max: 1000, label: '출력 단가' }),
      cached: v.number({ min: 0, max: 1000, optional: true, default: 0 }),
    }),
    { max: 100, label: '가격표' }
  ),
  pricesCheckedAt: v.string({ max: 20, optional: true, default: '' }),
});

const clinicSchema = v.object({
  name: v.string({ min: 1, max: 60, label: '병원 이름' }),
  phone: v.string({ max: 30, optional: true, default: '' }),
  address: v.string({ max: 200, optional: true, default: '' }),
  hours: v.string({ max: 500, optional: true, default: '' }),
  parking: v.string({ max: 500, optional: true, default: '' }),
  directions: v.string({ max: 500, optional: true, default: '' }),
  insuranceNote: v.string({ max: 1000, optional: true, default: '' }),
  extra: v.string({ max: 2000, optional: true, default: '' }),
  representative: v.string({ max: 30, optional: true, default: '' }),
  email: v.string({ max: 100, optional: true, default: '' }),
});

function register(r) {
  const adminOnly = auth.requireRole('admin');
  const managerUp = auth.requireRole('manager');

  // ---------- 모두: 직원 목록(담당자 선택용), 병원 정보 ----------
  r.get('/people', (req, res) => {
    res.json(all("SELECT id, name, role, job_title AS jobTitle, color, hire_date AS hireDate FROM users WHERE status = 'active' ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, id"));
  });

  r.get('/clinic', (req, res) => res.json(getSetting('clinic')));

  r.put('/clinic', adminOnly, (req, res) => {
    const data = clinicSchema.parse(req.body);
    setSetting('clinic', { ...getSetting('clinic'), ...data });
    audit(req, 'update', 'settings', 'clinic', '병원 기본 정보 수정');
    res.json(getSetting('clinic'));
  });

  // ---------- 사용자·권한 ----------
  r.get('/users', adminOnly, (req, res) => {
    const rows = all("SELECT * FROM users ORDER BY status = 'inactive', CASE role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, id");
    res.json({ users: rows.map(userRow), roles: ROLES.map((r) => ({ value: r, label: auth.ROLE_LABEL[r] })), jobs: JOBS, colors: COLORS });
  });

  r.post('/users', adminOnly, (req, res) => {
    const d = userCreateSchema.parse(req.body);
    if (d.username && !d.password) throw badRequest('로그인 아이디를 만들려면 임시 비밀번호도 입력해 주세요.', { field: 'password' });
    if (d.password) {
      if (!d.username) throw badRequest('비밀번호를 쓰려면 아이디도 입력해 주세요.', { field: 'username' });
      const rule = auth.checkPasswordRule(d.password);
      if (rule) throw badRequest(rule, { field: 'password' });
    }
    const now = new Date().toISOString();
    const count = get('SELECT COUNT(*) AS n FROM users').n;
    const info = run(
      `INSERT INTO users (name, username, password_hash, role, job_title, hire_date, status, color, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      d.name,
      d.username || null,
      d.password ? auth.hashPassword(d.password) : null,
      d.role || 'staff',
      d.jobTitle || '기타',
      d.hireDate,
      d.color || COLORS[count % COLORS.length],
      d.password ? 1 : 0,
      now,
      now
    );
    audit(req, 'create', 'users', info.lastInsertRowid, `사용자 추가: ${d.name} (${auth.ROLE_LABEL[d.role || 'staff']}${d.username ? ', 로그인 ' + d.username : ''})`);
    res.status(201).json(userRow(get('SELECT * FROM users WHERE id = ?', info.lastInsertRowid)));
  });

  r.patch('/users/:id', adminOnly, (req, res) => {
    const id = idParam(req.params.id);
    const u = get('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw notFound('사용자');
    const d = userCreateSchema.partial().parse(req.body);
    const status = req.body.status === undefined ? u.status : v.enum(['active', 'inactive'])(req.body.status, 'status');
    if ((d.role && d.role !== 'admin' && u.role === 'admin') || (status === 'inactive' && u.role === 'admin')) ensureNotLastAdmin(id);
    if (id === req.user.id && status === 'inactive') throw badRequest('자기 자신은 비활성화할 수 없습니다.');
    // 아이디를 새로 만들 때는 비밀번호도 함께
    let passwordHash = u.password_hash;
    let mustChange = u.must_change_password;
    if (d.password) {
      const rule = auth.checkPasswordRule(d.password);
      if (rule) throw badRequest(rule, { field: 'password' });
      passwordHash = auth.hashPassword(d.password);
      mustChange = 1;
    }
    const username = 'username' in d ? d.username || null : u.username;
    if (username && !passwordHash) throw badRequest('로그인 아이디를 만들려면 임시 비밀번호도 입력해 주세요.', { field: 'password' });
    if (!username) passwordHash = null;
    run(
      `UPDATE users SET name = ?, username = ?, password_hash = ?, role = ?, job_title = ?, hire_date = ?, color = ?, status = ?,
         must_change_password = ?, updated_at = ? WHERE id = ?`,
      d.name ?? u.name,
      username,
      passwordHash,
      d.role ?? u.role,
      d.jobTitle ?? u.job_title,
      'hireDate' in d ? d.hireDate : u.hire_date,
      d.color ?? u.color,
      status,
      mustChange,
      new Date().toISOString(),
      id
    );
    // 권한이 바뀌거나 비활성화/로그인 해제되면 기존 로그인을 끊음
    if (status === 'inactive' || (d.role && d.role !== u.role) || !passwordHash || d.password) auth.revokeUserSessions(id);
    audit(req, 'update', 'users', id, `사용자 수정: ${d.name ?? u.name}${status !== u.status ? (status === 'inactive' ? ' (비활성화)' : ' (활성화)') : ''}`);
    res.json(userRow(get('SELECT * FROM users WHERE id = ?', id)));
  });

  r.post('/users/:id/reset-password', adminOnly, (req, res) => {
    const id = idParam(req.params.id);
    const u = get('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw notFound('사용자');
    if (!u.username) throw badRequest('로그인 아이디가 없는 직원입니다. 먼저 아이디를 만들어 주세요.');
    const pw = v.string({ min: 8, max: 128, trim: false, label: '임시 비밀번호' })(req.body.password, 'password');
    const rule = auth.checkPasswordRule(pw);
    if (rule) throw badRequest(rule, { field: 'password' });
    run(
      'UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
      auth.hashPassword(pw),
      new Date().toISOString(),
      id
    );
    auth.revokeUserSessions(id);
    audit(req, 'reset_password', 'users', id, `비밀번호 초기화: ${u.name}`);
    res.json({ ok: true });
  });

  r.post('/users/:id/unlock', adminOnly, (req, res) => {
    const id = idParam(req.params.id);
    run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', id);
    audit(req, 'unlock', 'users', id, '로그인 잠금 해제');
    res.json({ ok: true });
  });

  // ---------- 보안 설정 (자동 로그아웃 시간) ----------
  r.get('/security', adminOnly, (req, res) => res.json(getSetting('security')));
  r.put('/security', adminOnly, (req, res) => {
    const d = v
      .object({
        idleMinutes: v.int({ min: 10, max: 1440, label: '자동 로그아웃(분)' }),
        absoluteHours: v.int({ min: 1, max: 72, label: '최대 로그인 유지(시간)' }),
      })
      .parse(req.body);
    setSetting('security', d);
    audit(req, 'update', 'settings', 'security', `보안 설정 수정: 미사용 ${d.idleMinutes}분 / 최대 ${d.absoluteHours}시간`);
    res.json(d);
  });

  // ---------- AI 설정 ----------
  r.get('/ai', adminOnly, (req, res) => res.json(aiSettingsView()));

  r.put('/ai', adminOnly, (req, res) => {
    const d = aiSettingsSchema.parse(req.body);
    // 기능별 등급은 'fast' / 'smart' 만 허용
    const tiers = {};
    const known = new Set(ai.listFeatures().map((f) => f.key));
    for (const [k, t] of Object.entries(req.body.featureTiers || {})) {
      if (known.has(k) && (t === 'fast' || t === 'smart')) tiers[k] = t;
    }
    d.featureTiers = tiers;
    ai.saveAiSettings(d);
    audit(req, 'update', 'settings', 'ai', `AI 설정 수정: 공급자 ${d.provider}, 월 예산 ${d.monthlyBudgetKrw.toLocaleString('ko-KR')}원, ${d.budgetAction === 'block' ? '초과 시 차단' : '초과 시 경고'}`);
    res.json(aiSettingsView());
  });

  r.post('/ai/reset-prices', adminOnly, (req, res) => {
    const s = ai.getAiSettings();
    const def = defaultAiSettings();
    s.prices = def.prices;
    s.pricesCheckedAt = def.pricesCheckedAt;
    ai.saveAiSettings(s);
    audit(req, 'update', 'settings', 'ai', 'AI 가격표를 기본값으로 되돌림');
    res.json(aiSettingsView());
  });

  r.put('/ai/key', adminOnly, (req, res) => {
    const d = v
      .object({
        provider: v.enum(['anthropic', 'openai', 'gemini'], { label: '공급자' }),
        key: v.string({ min: 10, max: 400, label: 'API 키', pattern: /^[\x21-\x7e]+$/, patternMessage: '키에 공백이나 한글이 들어 있습니다. 복사한 키를 다시 확인해 주세요.' }),
      })
      .parse(req.body);
    secrets.setSecret(`ai_key_${d.provider}`, d.key);
    audit(req, 'update', 'secrets', d.provider, `${PROVIDERS[d.provider].label} API 키 저장 (끝 4자리 ${d.key.slice(-4)})`);
    res.json(aiSettingsView());
  });

  r.delete('/ai/key/:provider', adminOnly, (req, res) => {
    const p = v.enum(['anthropic', 'openai', 'gemini'])(req.params.provider, 'provider');
    secrets.deleteSecret(`ai_key_${p}`);
    audit(req, 'delete', 'secrets', p, `${PROVIDERS[p].label} API 키 삭제`);
    res.json(aiSettingsView());
  });

  r.post('/ai/test', adminOnly, async (req, res) => {
    const p = v.enum(['anthropic', 'openai', 'gemini'], { label: '공급자' })(req.body.provider, 'provider');
    const result = await ai.testConnection(p, req);
    audit(req, 'ai_test', 'settings', p, `AI 연결 테스트 성공 (${result.model})`);
    res.json(result);
  });

  // ---------- AI 사용량 ----------
  r.get('/usage', managerUp, (req, res) => {
    const month = req.query.month ? v.month()(req.query.month, 'month') : undefined;
    res.json(ai.usageSummary(month));
  });

  // ---------- 백업·복원 ----------
  r.get('/backups', adminOnly, (req, res) => {
    res.json({ backups: backup.listBackups(), settings: getSetting('backup'), dir: backup.backupDir() });
  });

  r.post('/backups', adminOnly, (req, res) => {
    const b = backup.createBackup('manual');
    audit(req, 'backup', 'backup', b.name, `수동 백업: ${b.name}`);
    res.status(201).json(b);
  });

  r.put('/backups/settings', adminOnly, (req, res) => {
    const d = v
      .object({
        keep: v.int({ min: 3, max: 365, label: '보관 개수' }),
        hour: v.int({ min: 0, max: 23, label: '시' }),
        minute: v.int({ min: 0, max: 59, label: '분' }),
      })
      .parse(req.body);
    setSetting('backup', d);
    audit(req, 'update', 'settings', 'backup', `백업 설정: 매일 ${d.hour}:${String(d.minute).padStart(2, '0')} 이후, ${d.keep}개 보관`);
    res.json(d);
  });

  r.get('/backups/:name/download', adminOnly, (req, res) => {
    const file = backup.resolveBackup(req.params.name);
    audit(req, 'download', 'backup', req.params.name, `백업 내려받기: ${req.params.name}`);
    res.download(file, req.params.name);
  });

  r.post('/backups/:name/restore', adminOnly, (req, res) => {
    const name = req.params.name;
    backup.resolveBackup(name);
    const result = backup.restoreBackup(name);
    // 복원된 DB에 활동 기록을 남김 (복원 전 DB는 '복원 전' 백업으로 보관됨)
    audit(req, 'restore', 'backup', name, `백업 복원: ${name} (복원 전 상태는 ${result.preRestoreBackup})`);
    res.json({ ok: true, ...result });
  });

  // 다른 PC에서 가져온 백업 파일(.db)을 올려서 복원
  r.post('/backups/upload', adminOnly, express.raw({ type: 'application/octet-stream', limit: '500mb' }), (req, res) => {
    const result = backup.restoreFromUpload(req.body);
    audit(req, 'restore', 'backup', result.uploadedAs, `올린 백업 파일로 복원 (복원 전 상태는 ${result.preRestoreBackup})`);
    res.json({ ok: true, ...result });
  });

  // ---------- 활동 기록 ----------
  function auditQuery(q) {
    const conds = [];
    if (q.q) conds.push(['(summary LIKE ? OR user_name LIKE ? OR action LIKE ?)', `%${q.q}%`, `%${q.q}%`, `%${q.q}%`]);
    if (q.user) conds.push(['user_id = ?', Number(q.user)]);
    if (q.action) conds.push(['action = ?', String(q.action)]);
    if (q.from) conds.push(['at >= ?', new Date(String(q.from) + 'T00:00:00').toISOString()]);
    if (q.to) conds.push(['at < ?', new Date(new Date(String(q.to) + 'T00:00:00').getTime() + 86400000).toISOString()]);
    return where(conds);
  }

  r.get('/audit', adminOnly, (req, res) => {
    const w = auditQuery(req.query);
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = 50;
    const total = get(`SELECT COUNT(*) AS n FROM audit_logs ${w.sql}`, ...w.params).n;
    const rows = all(`SELECT * FROM audit_logs ${w.sql} ORDER BY id DESC LIMIT ? OFFSET ?`, ...w.params, size, (page - 1) * size);
    const actions = all('SELECT DISTINCT action FROM audit_logs ORDER BY action').map((r) => r.action);
    res.json({ rows, total, page, size, actions });
  });

  r.get('/audit.csv', adminOnly, (req, res) => {
    const w = auditQuery(req.query);
    const rows = all(`SELECT * FROM audit_logs ${w.sql} ORDER BY id DESC LIMIT 50000`, ...w.params);
    const out = csv.toCsv(
      [
        { key: 'at', label: '시각', value: (r) => new Date(r.at).toLocaleString('ko-KR') },
        { key: 'user_name', label: '사용자' },
        { key: 'action', label: '동작' },
        { key: 'entity', label: '대상' },
        { key: 'entity_id', label: '대상번호' },
        { key: 'summary', label: '내용' },
        { key: 'ip', label: 'IP' },
      ],
      rows
    );
    audit(req, 'export', 'audit_logs', null, `활동 기록 내보내기 (${rows.length}건)`);
    csv.sendCsv(res, `활동기록_${new Date().toISOString().slice(0, 10)}.csv`, out);
  });

  // ---------- 초기화 / 데모 데이터 ----------
  r.post('/reset', adminOnly, (req, res) => {
    if (req.body.confirm !== '초기화') throw badRequest('확인 문구로 "초기화"를 정확히 입력해 주세요.');
    const b = backup.createBackup('manual');
    require('../../seed').resetBusinessData();
    audit(req, 'reset', 'all', null, `업무 데이터 전체 초기화 (초기화 전 백업: ${b.name})`);
    res.json({ ok: true, backup: b.name });
  });

  r.post('/seed-demo', adminOnly, (req, res) => {
    // 기본 서식과 겹치지 않도록 업무 데이터를 비운 뒤(직전 상태는 백업) 데모 데이터를 넣음
    const b = backup.createBackup('manual');
    const seed = require('../../seed');
    seed.resetBusinessData({ starter: false });
    seed.seedDemo();
    audit(req, 'seed', 'demo', null, `데모 예시 데이터 넣기 (넣기 전 백업: ${b.name})`);
    res.json({ ok: true, backup: b.name });
  });

  // ---------- 시스템 정보 ----------
  r.get('/system', adminOnly, (req, res) => {
    const file = db.currentFile();
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* 메모리 DB 등 */
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(cfg.ROOT, 'package.json'), 'utf8'));
    res.json({
      version: pkg.version,
      node: process.version,
      dbFile: file,
      dbSize: size,
      port: cfg.config.port,
      addresses: require('../../index').lanAddresses().map((ip) => `http://${ip}:${cfg.config.port}`),
      allowExternal: cfg.config.allowExternal,
      hasDemoData: require('../../seed').hasDemoData(),
      uptimeSec: Math.round(process.uptime()),
      counts: {
        users: get('SELECT COUNT(*) AS n FROM users').n,
        auditLogs: get('SELECT COUNT(*) AS n FROM audit_logs').n,
        aiCalls: get('SELECT COUNT(*) AS n FROM ai_usage').n,
      },
    });
  });
}

module.exports = { name: 'admin', migrations: [], register, JOBS, ROLES };
