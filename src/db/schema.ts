export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_events_ready_idx
  ON webhook_events(status, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_transaction_id TEXT NOT NULL,
  source_leg_id TEXT,
  account_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  local_month TEXT NOT NULL,
  description TEXT NOT NULL,
  merchant TEXT NOT NULL,
  merchant_key TEXT NOT NULL,
  mcc INTEGER,
  amount_minor INTEGER NOT NULL,
  amount_exponent INTEGER NOT NULL DEFAULT 2,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  category TEXT,
  category_confidence REAL,
  category_source TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL,
  analysis_json TEXT,
  analyzed_at TEXT,
  notified_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS transactions_day_idx ON transactions(local_date, occurred_at);
CREATE INDEX IF NOT EXISTS transactions_month_idx ON transactions(local_month, category, currency);
CREATE INDEX IF NOT EXISTS transactions_merchant_idx ON transactions(merchant_key, occurred_at);
CREATE INDEX IF NOT EXISTS transactions_source_id_idx ON transactions(source, source_transaction_id);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  aggregate_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(kind, aggregate_key)
);

CREATE INDEX IF NOT EXISTS outbox_ready_idx ON outbox(status, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS calendar_events (
  local_date TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS category_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_key TEXT,
  mcc INTEGER,
  category TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  UNIQUE(merchant_key, mcc)
);
`;
