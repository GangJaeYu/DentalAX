/*
 * 이 파일이 하는 일: 모든 모듈이 함께 쓰는 기본 표(사용자, 세션, 설정, 활동 기록, AI 사용량, 비밀값)를 정의합니다.
 * 각 업무 모듈의 표는 server/modules/<모듈>/index.js 의 migrations 에 있습니다.
 *
 * ※ 개인정보 원칙: 환자 이름·연락처·주민번호·차트번호·진료 정보를 담는 표나 칸은 어디에도 만들지 않습니다.
 *   직원 정보도 업무에 꼭 필요한 최소한(이름, 역할, 직종, 입사일)만 저장합니다.
 */
module.exports = [
  {
    id: 'core_001',
    up: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        username TEXT UNIQUE COLLATE NOCASE,      -- 로그인 아이디 (로그인하지 않는 직원은 비어 있음)
        password_hash TEXT,                       -- scrypt 해시 (원래 비밀번호는 저장하지 않음)
        role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','manager','staff')),
        job_title TEXT NOT NULL DEFAULT '기타',    -- 원장/실장/치과위생사/간호조무사/기타
        hire_date TEXT,                           -- 입사일 (연차 계산용)
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
        color TEXT,                               -- 근무표 표시 색
        must_change_password INTEGER NOT NULL DEFAULT 0,
        failed_logins INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        last_login_at TEXT,
        is_demo INTEGER NOT NULL DEFAULT 0,       -- 데모용 가상 직원 표시 (초기화 때 삭제)
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,                      -- 세션 토큰의 해시값
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        user_id INTEGER,
        user_name TEXT,
        action TEXT NOT NULL,
        entity TEXT,
        entity_id TEXT,
        summary TEXT,
        ip TEXT
      );
      CREATE INDEX idx_audit_at ON audit_logs(at);
      CREATE TABLE ai_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        user_id INTEGER,
        user_name TEXT,
        feature TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        cost_krw REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL,                     -- ok / error / blocked_pii / blocked_budget / demo
        pii_types TEXT,                           -- 감지된 개인정보 종류 (내용은 저장하지 않음)
        duration_ms INTEGER,
        error TEXT
      );
      CREATE INDEX idx_ai_usage_at ON ai_usage(at);
      CREATE TABLE secrets (
        name TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        hint TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
];
