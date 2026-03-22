import { v4 as uuidv4 } from "uuid";
import type { Message, MessageRole, Result } from "./types.js";
import { ok, err } from "./types.js";
import { getDb } from "./db.js";
import { createLogger } from "./logger.js";

const log = createLogger("memory:messages");

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: number;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as MessageRole,
    content: row.content,
    createdAt: row.created_at,
  };
}

export interface WriteMessageInput {
  sessionId: string;
  role: MessageRole;
  content: string;
}

export function writeMessage(input: WriteMessageInput): Result<Message> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  const message: Message = {
    id: uuidv4(),
    sessionId: input.sessionId,
    role: input.role,
    content: input.content,
    createdAt: Date.now(),
  };

  try {
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      message.id,
      message.sessionId,
      message.role,
      message.content,
      message.createdAt
    );

    log.debug("Message written", { id: message.id, role: message.role });
    return ok(message);
  } catch (e) {
    return err(`writeMessage failed: ${String(e)}`);
  }
}

/**
 * Read the last N messages for a session (oldest first).
 * Used to build LLM context window.
 */
export function readContext(sessionId: string, limit: number): Result<Message[]> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  try {
    // Get the latest `limit` rows, then reverse to chronological order
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT rowid AS _seq, * FROM messages
           WHERE session_id = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?
         ) ORDER BY created_at ASC, _seq ASC`
      )
      .all(sessionId, limit) as MessageRow[];

    return ok(rows.map(rowToMessage));
  } catch (e) {
    return err(`readContext failed: ${String(e)}`);
  }
}

export function listMessages(sessionId: string): Result<Message[]> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  try {
    const rows = db
      .prepare(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC"
      )
      .all(sessionId) as MessageRow[];

    return ok(rows.map(rowToMessage));
  } catch (e) {
    return err(`listMessages failed: ${String(e)}`);
  }
}

export function deleteMessages(sessionId: string): Result<void> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  try {
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    return ok(undefined);
  } catch (e) {
    return err(`deleteMessages failed: ${String(e)}`);
  }
}

/**
 * Convenience: write user + assistant turn in a single transaction.
 */
export function writeExchange(
  sessionId: string,
  userContent: string,
  assistantContent: string
): Result<{ user: Message; assistant: Message }> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  const userMsg: Message = {
    id: uuidv4(),
    sessionId,
    role: "user",
    content: userContent,
    createdAt: Date.now(),
  };
  const assistantMsg: Message = {
    id: uuidv4(),
    sessionId,
    role: "assistant",
    content: assistantContent,
    createdAt: Date.now() + 1, // ensure ordering
  };

  try {
    const insert = db.prepare(
      "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    const tx = db.transaction(() => {
      insert.run(userMsg.id, sessionId, userMsg.role, userMsg.content, userMsg.createdAt);
      insert.run(assistantMsg.id, sessionId, assistantMsg.role, assistantMsg.content, assistantMsg.createdAt);
    });
    tx();
    log.debug("Exchange written", { sessionId });
    return ok({ user: userMsg, assistant: assistantMsg });
  } catch (e) {
    return err(`writeExchange failed: ${String(e)}`);
  }
}
