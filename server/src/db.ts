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

/** Display name: Baton edit, then phone contact list, then the customer's own WhatsApp name, then number. */
export const CONTACT_NAME_SQL =
  "COALESCE(ct.name, ct.saved_name, ct.wa_name, CASE WHEN ct.phone = ct.lid THEN NULL ELSE ct.phone END, '未知號碼')"
/** The real phone number, or NULL while WhatsApp still hides it behind a LID. */
export const CONTACT_PHONE_SQL = 'CASE WHEN ct.phone = ct.lid THEN NULL ELSE ct.phone END'

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
