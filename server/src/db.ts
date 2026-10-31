import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

export const DATA_DIR = path.resolve(process.env.BATON_DATA_DIR ?? 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(path.join(DATA_DIR, 'baton.db'))

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin','agent')),
  active INTEGER NOT NULL DEFAULT 1,
  color TEXT NOT NULL DEFAULT '#0E7C66',
  style_notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deactivated_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Each WhatsApp Business number linked by QR code (multi-device "linked device").
CREATE TABLE IF NOT EXISTS numbers (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  demo INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Company contact book: one row per customer, shared by every number and teammate.
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  wa_name TEXT,
  notes TEXT NOT NULL DEFAULT '',
  owner_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  number_id INTEGER NOT NULL REFERENCES numbers(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  jid TEXT NOT NULL,
  assignee_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  unread INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER NOT NULL DEFAULT 0,
  last_preview TEXT NOT NULL DEFAULT '',
  UNIQUE (number_id, jid)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  wa_id TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  sender_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  media_path TEXT,
  media_mime TEXT,
  ts INTEGER NOT NULL,
  ai_assisted INTEGER NOT NULL DEFAULT 0,
  UNIQUE (conversation_id, wa_id)
);
CREATE INDEX IF NOT EXISTS messages_conv_ts ON messages (conversation_id, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
  body, content='messages', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;

-- Handoffs, assignments, internal notes: the audit trail of who did what.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  target_user_id INTEGER REFERENCES users(id),
  ts INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  conversation_id INTEGER REFERENCES conversations(id),
  user_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'open' CHECK (stage IN ('open','won','lost')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  closed_at INTEGER
);
`)

type Row = Record<string, any>

export function all<T = Row>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[]
}

export function get<T = Row>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined
}

export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params)
}

// ---------- Migrations for databases created by earlier versions ----------

function columns(table: string) {
  return all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)
}

// WhatsApp hides many customers' phone numbers behind a LID (an opaque "linked ID").
// A contact keeps its LID here; until the real number is known, phone holds the LID digits.
if (!columns('contacts').includes('lid')) {
  db.exec('ALTER TABLE contacts ADD COLUMN lid TEXT')
  db.exec("UPDATE contacts SET lid = phone WHERE id IN (SELECT contact_id FROM conversations WHERE jid LIKE '%@lid')")
}
// The name saved in the WhatsApp Business phone's own contact list.
if (!columns('contacts').includes('saved_name')) db.exec('ALTER TABLE contacts ADD COLUMN saved_name TEXT')
if (!columns('numbers').includes('contacts_synced_at')) db.exec('ALTER TABLE numbers ADD COLUMN contacts_synced_at INTEGER')
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS contacts_lid ON contacts (lid);
CREATE TABLE IF NOT EXISTS lid_map (lid TEXT PRIMARY KEY, pn TEXT NOT NULL);
-- Names from the linked phones' contact lists, keyed by phone number or LID digits.
-- Kept separately so a name that syncs before the customer's first chat is not lost.
CREATE TABLE IF NOT EXISTS phonebook (key TEXT PRIMARY KEY, name TEXT NOT NULL);
`)

// How a number is connected: 'wa_web' (QR linked device), 'wa_cloud' (official WhatsApp
// Cloud API) or 'instagram' (Instagram Messaging API). config holds the API credentials.
if (!columns('numbers').includes('channel')) db.exec("ALTER TABLE numbers ADD COLUMN channel TEXT NOT NULL DEFAULT 'wa_web'")
if (!columns('numbers').includes('config')) db.exec("ALTER TABLE numbers ADD COLUMN config TEXT NOT NULL DEFAULT '{}'")
// What the AI does when a customer writes: 'off', 'suggest' (draft for a teammate) or 'auto' (reply directly).
if (!columns('numbers').includes('reply_mode')) db.exec("ALTER TABLE numbers ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'off'")
// A teammate took over (or the AI handed off): no more automatic replies until resumed or closed.
if (!columns('conversations').includes('ai_paused')) db.exec('ALTER TABLE conversations ADD COLUMN ai_paused INTEGER NOT NULL DEFAULT 0')
// The AI's suggested reply waiting for a teammate (reply mode 'suggest').
if (!columns('conversations').includes('ai_suggestion')) db.exec('ALTER TABLE conversations ADD COLUMN ai_suggestion TEXT')
// The AI handed this conversation to the team and no teammate has replied yet ("待人工" queue).
if (!columns('conversations').includes('needs_human')) db.exec('ALTER TABLE conversations ADD COLUMN needs_human INTEGER NOT NULL DEFAULT 0')
// When the team was last alerted that this customer is waiting for a reply.
if (!columns('conversations').includes('human_alert_at')) db.exec('ALTER TABLE conversations ADD COLUMN human_alert_at INTEGER')
// Teammate's own WhatsApp number, for "customer waiting" alerts.
if (!columns('users').includes('phone')) db.exec("ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ''")
// Text of a voice message (Gemini transcription).
if (!columns('messages').includes('transcript')) db.exec('ALTER TABLE messages ADD COLUMN transcript TEXT')
// Sent by the AI on its own, with no teammate reviewing it.
if (!columns('messages').includes('ai_auto')) db.exec('ALTER TABLE messages ADD COLUMN ai_auto INTEGER NOT NULL DEFAULT 0')
db.exec(`
-- What the AI is allowed to say: FAQ answers, company policies, class information.
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'policy' CHECK (category IN ('faq','policy','class','other')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- FAQ only: comma-separated words that trigger this exact answer without calling the AI.
  keywords TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Trial classes: booked by the customer (noted by the AI) or entered by a teammate.
-- A follow-up message goes out a set time after the class starts.
CREATE TABLE IF NOT EXISTS trials (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  conversation_id INTEGER REFERENCES conversations(id),
  class_at INTEGER NOT NULL,
  class_name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('ai','staff')),
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled')),
  followup_status TEXT NOT NULL DEFAULT 'pending' CHECK (followup_status IN ('pending','sent','failed','skipped')),
  followup_error TEXT,
  followup_at INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS trials_due ON trials (status, followup_status, class_at);

-- Staff shortcuts: typing "/價錢" in the composer inserts the saved text.
CREATE TABLE IF NOT EXISTS quick_replies (
  id INTEGER PRIMARY KEY,
  shortcut TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL
);

-- Customer labels for broadcasts, e.g. "會員", "產前".
CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (contact_id, tag)
);

-- Broadcasts: one message to a group of customers, sent one by one.
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  number_id INTEGER REFERENCES numbers(id),
  -- {"segment": "all", "tags": ["會員"]}
  audience TEXT NOT NULL DEFAULT '{}',
  message TEXT NOT NULL DEFAULT '',
  wa_template_name TEXT NOT NULL DEFAULT '',
  wa_template_language TEXT NOT NULL DEFAULT 'zh_HK',
  wa_template_params TEXT NOT NULL DEFAULT '',
  -- What the AI should know while the promotion runs, so it can answer replies.
  ai_note TEXT NOT NULL DEFAULT '',
  ai_until INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent')),
  scheduled_at INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at INTEGER
);
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  error TEXT,
  wa_id TEXT,
  sent_at INTEGER,
  delivered_at INTEGER,
  read_at INTEGER,
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS campaign_recipients_wa ON campaign_recipients (wa_id);

-- Instagram: a comment containing a keyword gets an automatic private reply (DM).
CREATE TABLE IF NOT EXISTS ig_rules (
  id INTEGER PRIMARY KEY,
  number_id INTEGER REFERENCES numbers(id),
  keywords TEXT NOT NULL,
  reply TEXT NOT NULL,
  public_reply TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS ig_comments (
  comment_id TEXT PRIMARY KEY,
  number_id INTEGER REFERENCES numbers(id),
  rule_id INTEGER REFERENCES ig_rules(id) ON DELETE SET NULL,
  from_id TEXT,
  username TEXT,
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ignored' CHECK (status IN ('ignored','sent','failed')),
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Instructors who receive a monthly payslip. name must match the name in the Vibefam report.
CREATE TABLE IF NOT EXISTS instructors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- One upload of a month's payroll report, and the message for each instructor in it.
CREATE TABLE IF NOT EXISTS payroll_runs (
  id INTEGER PRIMARY KEY,
  month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent')),
  scheduled_at INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at INTEGER
);
CREATE TABLE IF NOT EXISTS payroll_items (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  instructor_name TEXT NOT NULL,
  -- Values for the template placeholders, as JSON.
  fields TEXT NOT NULL DEFAULT '{}',
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  error TEXT,
  sent_at INTEGER
);
`)

export function getSetting(key: string, fallback = ''): string {
  return get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? fallback
}

export function setSetting(key: string, value: string) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value)
}

/**
 * Instagram, Facebook Messenger and Threads customers have no phone number; their contact row
 * is keyed by "ig:<id>", "fb:<id>" or "th:<username>".
 */
export const SOCIAL_SQL = "CASE WHEN ct.phone LIKE 'ig:%' THEN 'Instagram' WHEN ct.phone LIKE 'fb:%' THEN 'Facebook' WHEN ct.phone LIKE 'th:%' THEN 'Threads' END"
const NO_PHONE_SQL = `ct.phone = ct.lid OR (${SOCIAL_SQL}) IS NOT NULL`
/** Display name: Baton edit, then phone contact list, then the customer's own WhatsApp/Instagram name, then number. */
export const CONTACT_NAME_SQL =
  `COALESCE(ct.name, ct.saved_name, ct.wa_name, CASE WHEN ${NO_PHONE_SQL} THEN NULL ELSE ct.phone END,
    (${SOCIAL_SQL}) || ' 用戶', '未知號碼')`
/** The real phone number, or NULL while WhatsApp still hides it behind a LID (or for Instagram customers). */
export const CONTACT_PHONE_SQL = `CASE WHEN ${NO_PHONE_SQL} THEN NULL ELSE ct.phone END`

let depth = 0

/** Run fn atomically. Nested calls become savepoints inside the outer transaction. */
export function tx<T>(fn: () => T): T {
  const name = `sp${depth++}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    const result = fn()
    db.exec(`RELEASE ${name}`)
    return result
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`)
    db.exec(`RELEASE ${name}`)
    throw err
  } finally {
    depth--
  }
}
