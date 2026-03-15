import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ragDbPath } from "./config.mjs";

fs.mkdirSync(path.dirname(ragDbPath), { recursive: true });
try {
  fs.chmodSync(path.dirname(ragDbPath), 0o700);
} catch {}

const db = new Database(ragDbPath);
try {
  fs.chmodSync(ragDbPath, 0o600);
} catch {}
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS lark_accounts (
    id TEXT PRIMARY KEY,
    open_id TEXT UNIQUE,
    user_id TEXT,
    union_id TEXT,
    tenant_key TEXT,
    name TEXT,
    email TEXT,
    scope TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lark_tokens (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_type TEXT,
    scope TEXT,
    expires_at INTEGER,
    refresh_expires_at INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES lark_accounts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_lark_tokens_account_id ON lark_tokens(account_id);
  CREATE INDEX IF NOT EXISTS idx_lark_tokens_updated_at ON lark_tokens(updated_at DESC);

  CREATE TABLE IF NOT EXISTS lark_sources (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    external_key TEXT NOT NULL,
    external_id TEXT,
    title TEXT,
    url TEXT,
    parent_external_key TEXT,
    parent_path TEXT,
    updated_at_remote TEXT,
    acl_json TEXT,
    meta_json TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    last_synced_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id, external_key),
    FOREIGN KEY (account_id) REFERENCES lark_accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS lark_documents (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    source_id TEXT,
    source_type TEXT NOT NULL,
    external_key TEXT NOT NULL,
    external_id TEXT,
    file_token TEXT,
    node_id TEXT,
    document_id TEXT,
    space_id TEXT,
    title TEXT,
    url TEXT,
    parent_path TEXT,
    revision TEXT,
    updated_at_remote TEXT,
    content_hash TEXT,
    raw_text TEXT,
    inactive_reason TEXT,
    acl_json TEXT,
    meta_json TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    synced_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id, external_key),
    FOREIGN KEY (account_id) REFERENCES lark_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (source_id) REFERENCES lark_sources(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_lark_documents_account_id ON lark_documents(account_id, active);
  CREATE INDEX IF NOT EXISTS idx_lark_documents_updated_remote ON lark_documents(updated_at_remote);

  CREATE TABLE IF NOT EXISTS lark_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    title TEXT,
    url TEXT,
    external_key TEXT,
    parent_path TEXT,
    updated_at TEXT,
    content TEXT NOT NULL,
    content_norm TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    chunk_hash TEXT NOT NULL,
    acl_json TEXT,
    meta_json TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at_local TEXT NOT NULL,
    FOREIGN KEY (document_id) REFERENCES lark_documents(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES lark_accounts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_lark_chunks_document_id ON lark_chunks(document_id, chunk_index);
  CREATE INDEX IF NOT EXISTS idx_lark_chunks_account_id ON lark_chunks(account_id, active);

  CREATE TABLE IF NOT EXISTS lark_chunk_embeddings (
    chunk_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    embedding_json TEXT NOT NULL,
    model TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (chunk_id) REFERENCES lark_chunks(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES lark_accounts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_lark_chunk_embeddings_account_id
  ON lark_chunk_embeddings(account_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS lark_chunks_fts USING fts5(
    chunk_id UNINDEXED,
    account_id UNINDEXED,
    title,
    content,
    parent_path,
    url,
    tokenize = 'unicode61'
  );

  CREATE TABLE IF NOT EXISTS sync_jobs (
    id TEXT PRIMARY KEY,
    account_id TEXT,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    cursor_json TEXT,
    summary_json TEXT,
    error_text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES lark_accounts(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS meeting_documents (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    project_key TEXT NOT NULL,
    project_name TEXT,
    meeting_type TEXT NOT NULL,
    document_id TEXT NOT NULL,
    title TEXT,
    chat_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id, project_key, meeting_type),
    FOREIGN KEY (account_id) REFERENCES lark_accounts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_meeting_documents_lookup
  ON meeting_documents(account_id, project_key, meeting_type);

  CREATE TABLE IF NOT EXISTS weekly_todo_tracker (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    project_key TEXT NOT NULL,
    meeting_type TEXT NOT NULL DEFAULT 'weekly',
    normalized_key TEXT NOT NULL,
    title TEXT NOT NULL,
    owner TEXT,
    objective TEXT,
    kr TEXT,
    status TEXT NOT NULL,
    source_date TEXT,
    source_meeting_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id, project_key, meeting_type, normalized_key),
    FOREIGN KEY (account_id) REFERENCES lark_accounts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_weekly_todo_tracker_lookup
  ON weekly_todo_tracker(account_id, project_key, status);
`);

export default db;
