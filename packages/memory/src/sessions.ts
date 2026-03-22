import { v4 as uuidv4 } from "uuid";
import type { Session, Result } from "./types.js";
import { ok, err } from "./types.js";
import { getDb } from "./db.js";
import { createLogger } from "./logger.js";

const log = createLogger("memory:sessions");

interface SessionRow {
  id: string;
  created_at: number;
  updated_at: number;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSession(): Result<Session> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  const now = Date.now();
  const session: Session = {
    id: uuidv4(),
    createdAt: now,
    updatedAt: now,
  };

  try {
    db.prepare(
      "INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)"
    ).run(session.id, session.createdAt, session.updatedAt);

    log.debug("Session created", { id: session.id });
    return ok(session);
  } catch (e) {
    return err(`createSession failed: ${String(e)}`);
  }
}

export function getSession(id: string): Result<Session | null> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  try {
    const row = db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;

    return ok(row ? rowToSession(row) : null);
  } catch (e) {
    return err(`getSession failed: ${String(e)}`);
  }
}

export function touchSession(id: string): Result<void> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  try {
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      Date.now(),
      id
    );
    return ok(undefined);
  } catch (e) {
    return err(`touchSession failed: ${String(e)}`);
  }
}

export function listSessions(limit = 20): Result<Session[]> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  try {
    const rows = db
      .prepare(
        "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?"
      )
      .all(limit) as SessionRow[];

    return ok(rows.map(rowToSession));
  } catch (e) {
    return err(`listSessions failed: ${String(e)}`);
  }
}

export function deleteSession(id: string): Result<void> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  try {
    // CASCADE deletes messages too (FK constraint)
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    log.debug("Session deleted", { id });
    return ok(undefined);
  } catch (e) {
    return err(`deleteSession failed: ${String(e)}`);
  }
}

/** Get or create a session by id. Useful when sessionId arrives from renderer. */
export function ensureSession(id?: string): Result<Session> {
  if (!id) return createSession();

  const getResult = getSession(id);
  if (!getResult.ok) return getResult;

  if (getResult.data) {
    touchSession(id);
    return ok(getResult.data);
  }

  // Session id provided but doesn't exist — create it with that id
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  const now = Date.now();
  try {
    db.prepare(
      "INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)"
    ).run(id, now, now);
    return ok({ id, createdAt: now, updatedAt: now });
  } catch (e) {
    return err(`ensureSession failed: ${String(e)}`);
  }
}
