/*
 * 이 파일이 하는 일: 데이터베이스(SQLite 파일 하나)를 열고, 조회·저장을 쉽게 하는 도우미를 제공합니다.
 *
 * - 데이터는 data/dentalax.db 파일 하나에 모두 들어갑니다. (백업 = 이 파일 복사)
 * - Node.js에 들어 있는 SQLite(node:sqlite)를 쓰므로 따로 설치할 프로그램이 없습니다.
 * - SQL에 값을 넣을 때는 항상 ? 자리표시자를 씁니다. 사용자가 입력한 글자를 SQL 문장에 직접 이어 붙이지 않으므로
 *   "SQL 인젝션" 공격(입력값으로 DB 명령을 몰래 실행시키는 공격)이 통하지 않습니다.
 *
 * 사용 예)
 *   const { all, get, run, tx } = require('./db');
 *   const items = all('SELECT * FROM inv_items WHERE category = ?', '소모품');
 *   const one   = get('SELECT * FROM users WHERE id = ?', 3);
 *   const info  = run('INSERT INTO posts (title) VALUES (?)', '공지');  // info.lastInsertRowid
 *   tx(() => { run(...); run(...); });   // 둘 다 성공하거나 둘 다 취소
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let conn = null; // 현재 열려 있는 DB 연결
let dbFile = null; // 현재 DB 파일 경로
let stmtCache = new Map(); // 같은 SQL을 반복해서 준비하지 않도록 보관

/** DB 파일을 엽니다. 파일이 없으면 새로 만듭니다. ':memory:'를 주면 메모리 DB(테스트용) */
function open(file) {
  if (conn) close();
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  conn = new DatabaseSync(file);
  dbFile = file;
  stmtCache = new Map();
  // foreign_keys: 연결된 기록이 있으면 함부로 지우지 못하게 함
  // journal_mode=DELETE: 서버가 꺼져 있을 때 .db 파일 하나만 복사해도 완전한 백업이 되게 함
  // busy_timeout: 잠깐 바쁠 때 바로 실패하지 않고 5초까지 기다림
  conn.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
  `);
  return conn;
}

function close() {
  if (conn) {
    try {
      conn.close();
    } catch {
      /* 이미 닫혔으면 무시 */
    }
  }
  conn = null;
  stmtCache = new Map();
}

function db() {
  if (!conn) throw new Error('DB가 열려 있지 않습니다.');
  return conn;
}

function currentFile() {
  return dbFile;
}

/** SQLite가 받을 수 있는 값으로 바꿉니다 (undefined → null, true/false → 1/0, 객체 → JSON 글자) */
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

const nameCache = new Map();
/** SQL 안에 쓰인 :이름 목록 (SQL에 없는 이름을 넘기면 SQLite가 오류를 내므로 걸러 내기 위함) */
function namesIn(sql) {
  let set = nameCache.get(sql);
  if (!set) {
    set = new Set();
    // 따옴표 안의 글자는 건너뛰고 :name / @name / $name 을 찾음
    const stripped = sql.replace(/'(?:[^']|'')*'/g, "''");
    for (const m of stripped.matchAll(/[:@$]([A-Za-z_][A-Za-z0-9_]*)/g)) set.add(m[1]);
    nameCache.set(sql, set);
  }
  return set;
}

function normParams(params, sql) {
  // 이름 붙은 값 하나(객체)로 넘긴 경우: { name: '...', qty: 3 } → SQL의 :name, :qty
  // SQL에 없는 이름은 무시하고, SQL에 있는데 빠진 이름은 null 로 들어갑니다.
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0]) && !(params[0] instanceof Uint8Array)) {
    const names = namesIn(sql);
    const out = {};
    for (const [k, v] of Object.entries(params[0])) if (names.has(k)) out[k] = norm(v);
    return [out];
  }
  // 배열로 넘긴 경우도 허용
  if (params.length === 1 && Array.isArray(params[0])) return params[0].map(norm);
  return params.map(norm);
}

function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db().prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

/** 여러 줄 조회 → 배열 */
function all(sql, ...params) {
  return prep(sql).all(...normParams(params, sql));
}

/** 한 줄 조회 → 객체 또는 undefined */
function get(sql, ...params) {
  return prep(sql).get(...normParams(params, sql));
}

/** 저장/수정/삭제 → { changes, lastInsertRowid } */
function run(sql, ...params) {
  const r = prep(sql).run(...normParams(params, sql));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

/** 여러 SQL 문장을 한 번에 실행 (값 없이, 표 만들기 등에 사용) */
function exec(sql) {
  db().exec(sql);
}

let txDepth = 0;
/**
 * 묶음 처리(트랜잭션): fn 안의 저장 작업이 모두 성공해야 반영되고, 하나라도 실패하면 전부 취소됩니다.
 * 예) 입고 기록 + 재고 수량 변경은 반드시 함께 되어야 하므로 묶어서 처리합니다.
 */
function tx(fn) {
  if (txDepth > 0) return fn(); // 이미 묶음 안이면 그대로 실행
  db().exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const result = fn();
    db().exec('COMMIT');
    return result;
  } catch (e) {
    try {
      db().exec('ROLLBACK');
    } catch {
      /* 무시 */
    }
    throw e;
  } finally {
    txDepth--;
  }
}

/**
 * 표 구조 변경(마이그레이션)을 순서대로 적용합니다.
 * 이미 적용한 것은 _migrations 표에 기록되어 있어 다시 실행하지 않습니다.
 * 나중에 기능을 추가할 때는 기존 항목을 고치지 말고 새 항목(id)을 뒤에 추가하세요.
 * @param {{id:string, up:string}[]} migrations
 */
function migrate(migrations) {
  exec(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const done = new Set(all('SELECT id FROM _migrations').map((r) => r.id));
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    tx(() => {
      exec(m.up);
      run('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)', m.id, new Date().toISOString());
    });
  }
}

/** 조건이 여러 개인 목록 조회에서 WHERE 절을 안전하게 조립하는 도우미 */
function where(conds) {
  const parts = [];
  const params = [];
  for (const [sql, ...vals] of conds) {
    if (sql) {
      parts.push(sql);
      params.push(...vals);
    }
  }
  return { sql: parts.length ? 'WHERE ' + parts.join(' AND ') : '', params };
}

module.exports = { open, close, db, currentFile, all, get, run, exec, tx, migrate, where };
