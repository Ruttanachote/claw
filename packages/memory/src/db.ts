import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { Result } from "./types.js";
import { ok, err } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("memory:db");

export type Db = Database.Database;

let _db: Db | null = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT    PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT    PRIMARY KEY,
  session_id  TEXT    NOT NULL,
  role        TEXT    NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id
  ON messages (session_id, created_at);

CREATE TABLE IF NOT EXISTS cron_jobs (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  expression  TEXT    NOT NULL,
  skill_name  TEXT    NOT NULL,
  inputs      TEXT    NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run    INTEGER
);

CREATE TABLE IF NOT EXISTS memories (
  key         TEXT    PRIMARY KEY,
  value       TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id          TEXT    PRIMARY KEY,
  session_id  TEXT    NOT NULL,
  tool_name   TEXT    NOT NULL,
  called_at   INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session
  ON tool_calls (session_id, called_at);
`;

export function initDb(dbPath: string): Result<Db> {
  if (_db) return ok(_db);

  try {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });

    const db = new Database(dbPath);
    db.exec(SCHEMA);

    _db = db;
    log.info("Database initialised", { path: dbPath });
    return ok(db);
  } catch (e) {
    const msg = `Failed to initialise database at "${dbPath}": ${String(e)}`;
    log.error(msg);
    return err(msg);
  }
}

export function getDb(): Result<Db> {
  if (!_db) return err("Database not initialised — call initDb() first");
  return ok(_db);
}

export function closeDb(): Result<void> {
  if (!_db) return ok(undefined);
  try {
    _db.close();
    _db = null;
    log.info("Database closed");
    return ok(undefined);
  } catch (e) {
    return err(`Failed to close database: ${String(e)}`);
  }
}
