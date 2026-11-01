// Database layer: local SQLite standing in for the blueprint's MariaDB 11.4
// (same role: the only datastore, bound to localhost). Schema maps 1:1 to the
// 34-table inventory in blueprint Appendix A.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'revenue_ops.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
-- ===== Identity & platform =====
CREATE TABLE IF NOT EXISTS app_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL, role TEXT NOT NULL, mfa_enabled INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS app_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS feature_flag (key TEXT PRIMARY KEY, enabled INTEGER DEFAULT 0, purpose TEXT, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT NOT NULL,
  entity_type TEXT, entity_id TEXT, before_hash TEXT, after_hash TEXT,
  ip TEXT, trace_id TEXT, occurred_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS notification (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, event TEXT, message TEXT,
  read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS export_job (
  id INTEGER PRIMARY KEY AUTOINCREMENT, requested_by TEXT, kind TEXT, status TEXT,
  row_count INTEGER, path TEXT, requested_at TEXT DEFAULT (datetime('now')));

-- ===== CRM core =====
CREATE TABLE IF NOT EXISTS company (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, domain TEXT UNIQUE,
  industry TEXT, employee_band TEXT, revenue_band TEXT, city TEXT, state TEXT,
  segment TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS contact (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER REFERENCES company(id),
  full_name TEXT NOT NULL, role TEXT, seniority TEXT,
  email_hash TEXT UNIQUE, phone_hash TEXT, status TEXT DEFAULT 'ACTIVE',
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS lead (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER REFERENCES contact(id),
  company_id INTEGER REFERENCES company(id), source TEXT NOT NULL, service TEXT,
  score INTEGER DEFAULT 0, score_breakdown TEXT, tier TEXT DEFAULT 'D',
  status TEXT DEFAULT 'NEW', owner_id INTEGER REFERENCES app_user(id),
  consent_id INTEGER, first_touch_at TEXT, next_step_at TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS deal (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER REFERENCES company(id),
  lead_id INTEGER REFERENCES lead(id), name TEXT NOT NULL, service TEXT,
  amount TEXT, stage TEXT DEFAULT 'CAPTURED', probability REAL DEFAULT 0.1,
  expected_close TEXT, owner_id INTEGER REFERENCES app_user(id), created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS deal_stage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, deal_id INTEGER REFERENCES deal(id),
  from_stage TEXT, to_stage TEXT, changed_by TEXT, changed_at TEXT DEFAULT (datetime('now')), note TEXT);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, subject TEXT, body TEXT, direction TEXT,
  due_at TEXT, completed_at TEXT, owner_id INTEGER REFERENCES app_user(id),
  entity_type TEXT, entity_id INTEGER, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS task (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, description TEXT, due_at TEXT,
  priority TEXT DEFAULT 'MEDIUM', status TEXT DEFAULT 'OPEN', owner_id INTEGER REFERENCES app_user(id),
  rule_id INTEGER, entity_type TEXT, entity_id INTEGER, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS note (
  id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, owner_id INTEGER, entity_type TEXT, entity_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')));

-- ===== Capture =====
CREATE TABLE IF NOT EXISTS capture_request (
  id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT, validation TEXT, trace_id TEXT,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS consent_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER REFERENCES contact(id),
  purpose TEXT, notice_text TEXT, policy_version TEXT, lawful_basis TEXT, source TEXT,
  ip TEXT, user_agent TEXT, granted_at TEXT DEFAULT (datetime('now')), withdrawn_at TEXT);
CREATE TABLE IF NOT EXISTS suppression (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email_hash TEXT UNIQUE, reason TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS lead_source_touch (
  id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER REFERENCES lead(id),
  source TEXT, utm TEXT, referrer TEXT, landing_page TEXT, occurred_at TEXT DEFAULT (datetime('now')));

-- ===== Engagement =====
CREATE TABLE IF NOT EXISTS email_template (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name TEXT, audience TEXT,
  subject TEXT, body_outline TEXT, cta TEXT, version INTEGER DEFAULT 1, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS sequence (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name TEXT, audience TEXT,
  steps INTEGER, duration_days INTEGER, primary_cta TEXT, exit_criteria TEXT, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS sequence_step (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sequence_id INTEGER REFERENCES sequence(id),
  step_no INTEGER, delay_days INTEGER, template_id INTEGER REFERENCES email_template(id));
CREATE TABLE IF NOT EXISTS enrollment (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER REFERENCES contact(id),
  sequence_id INTEGER REFERENCES sequence(id), current_step INTEGER DEFAULT 0,
  next_send_at TEXT, status TEXT DEFAULT 'ACTIVE', started_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS email_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT, enrollment_id INTEGER REFERENCES enrollment(id),
  contact_id INTEGER REFERENCES contact(id), template_code TEXT, from_address TEXT,
  subject TEXT, body_text TEXT, status TEXT DEFAULT 'QUEUED', scheduled_at TEXT,
  sent_at TEXT, message_id TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS email_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER REFERENCES email_message(id),
  type TEXT, detail TEXT, occurred_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS mailbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT UNIQUE, sending_domain TEXT,
  daily_cap INTEGER DEFAULT 30, warmup INTEGER DEFAULT 10, status TEXT DEFAULT 'WARMING');

-- ===== Scheduling =====
CREATE TABLE IF NOT EXISTS availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT, rep_id INTEGER REFERENCES app_user(id),
  day_of_week INTEGER, start_time TEXT, end_time TEXT, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS meeting_slot (
  id INTEGER PRIMARY KEY AUTOINCREMENT, rep_id INTEGER REFERENCES app_user(id),
  starts_at_utc TEXT, ends_at_utc TEXT, status TEXT DEFAULT 'OPEN');
CREATE TABLE IF NOT EXISTS meeting (
  id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER REFERENCES lead(id),
  rep_id INTEGER REFERENCES app_user(id), type TEXT, start_at_utc TEXT NOT NULL,
  end_at_utc TEXT, timezone TEXT DEFAULT 'Asia/Kolkata', status TEXT DEFAULT 'ACTIVE',
  location TEXT, join_url TEXT, booked_via TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_slot ON meeting(rep_id, start_at_utc) WHERE status='ACTIVE';
CREATE TABLE IF NOT EXISTS meeting_invite (
  id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER REFERENCES meeting(id),
  contact_id INTEGER, ics_sent_at TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS reminder_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER REFERENCES meeting(id),
  kind TEXT, channel TEXT, sent_at TEXT DEFAULT (datetime('now')), status TEXT);
CREATE TABLE IF NOT EXISTS meeting_outcome (
  id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER REFERENCES meeting(id) UNIQUE,
  outcome TEXT, notes TEXT, next_step TEXT, recorded_at TEXT DEFAULT (datetime('now')));

-- ===== Workflow =====
CREATE TABLE IF NOT EXISTS workflow_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, trigger TEXT, condition_json TEXT,
  action TEXT, delay_minutes INTEGER DEFAULT 0, owner TEXT, stop_condition TEXT,
  active INTEGER DEFAULT 1, version INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS workflow_execution (
  id INTEGER PRIMARY KEY AUTOINCREMENT, rule_id INTEGER REFERENCES workflow_rule(id),
  entity_type TEXT, entity_id INTEGER, status TEXT, payload TEXT, executed_at TEXT DEFAULT (datetime('now')));

-- ===== Analytics / governance =====
CREATE TABLE IF NOT EXISTS report_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT, report_key TEXT, period TEXT, payload TEXT,
  generated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS data_subject_request (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER, kind TEXT, status TEXT DEFAULT 'OPEN',
  sla TEXT, created_at TEXT DEFAULT (datetime('now')));
`;

db.exec(SCHEMA);

function hashEmail(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}
function traceId() { return crypto.randomUUID(); }

// Append-only, hash-chained audit log (blueprint: actor mandatory on every write).
let lastHash = db.prepare("SELECT after_hash FROM audit_log ORDER BY id DESC LIMIT 1").get();
function audit(actor, action, entityType, entityId, beforeHash) {
  const afterHash = crypto.createHash('sha256')
    .update(String(lastHash || '') + actor + action + entityType + entityId + Date.now())
    .digest('hex');
  db.prepare(`INSERT INTO audit_log (actor, action, entity_type, entity_id, before_hash, after_hash, trace_id)
              VALUES (?,?,?,?,?,?,?)`)
    .run(actor, action, entityType, entityId != null ? String(entityId) : null, beforeHash || null, afterHash, traceId());
  lastHash = afterHash;
}

function notify(userId, event, message) {
  db.prepare('INSERT INTO notification (user_id, event, message) VALUES (?,?,?)').run(userId, event, message);
}

module.exports = { db, audit, notify, hashEmail, traceId, DB_PATH };
