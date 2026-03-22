import type { Memory, Result } from "./types.js";
import { ok, err } from "./types.js";
import { getDb } from "./db.js";

interface MemoryRow {
  key: string;
  value: string;
  updated_at: number;
}

function rowToMemory(row: MemoryRow): Memory {
  return { key: row.key, value: row.value, updatedAt: row.updated_at };
}

export function getMemory(key: string): Result<Memory | null> {
  const dbR = getDb();
  if (!dbR.ok) return dbR;
  try {
    const row = dbR.data.prepare("SELECT * FROM memories WHERE key = ?").get(key) as MemoryRow | undefined;
    return ok(row ? rowToMemory(row) : null);
  } catch (e) { return err(`getMemory failed: ${String(e)}`); }
}

export function setMemory(key: string, value: string): Result<Memory> {
  const dbR = getDb();
  if (!dbR.ok) return dbR;
  const updatedAt = Date.now();
  try {
    dbR.data.prepare(
      `INSERT INTO memories (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value, updatedAt);
    return ok({ key, value, updatedAt });
  } catch (e) { return err(`setMemory failed: ${String(e)}`); }
}

export function deleteMemory(key: string): Result<void> {
  const dbR = getDb();
  if (!dbR.ok) return dbR;
  try {
    dbR.data.prepare("DELETE FROM memories WHERE key = ?").run(key);
    return ok(undefined);
  } catch (e) { return err(`deleteMemory failed: ${String(e)}`); }
}

export function listMemories(): Result<Memory[]> {
  const dbR = getDb();
  if (!dbR.ok) return dbR;
  try {
    const rows = dbR.data.prepare(
      "SELECT * FROM memories ORDER BY updated_at DESC"
    ).all() as MemoryRow[];
    return ok(rows.map(rowToMemory));
  } catch (e) { return err(`listMemories failed: ${String(e)}`); }
}

// ── Analytics helpers ─────────────────────────────────────────

export interface AgentStats {
  totalSessions: number;
  totalMessages: number;
  totalToolCalls: number;
  topTools: Array<{ name: string; count: number }>;
}

export function recordToolCall(sessionId: string, toolName: string): Result<void> {
  const dbR = getDb();
  if (!dbR.ok) return dbR;
  try {
    const id = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    dbR.data.prepare(
      "INSERT INTO tool_calls (id, session_id, tool_name, called_at) VALUES (?, ?, ?, ?)"
    ).run(id, sessionId, toolName, Date.now());
    return ok(undefined);
  } catch (e) { return err(`recordToolCall failed: ${String(e)}`); }
}

export function getAgentStats(): Result<AgentStats> {
  const dbR = getDb();
  if (!dbR.ok) return dbR;
  try {
    const db = dbR.data;
    const totalSessions  = (db.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number }).n;
    const totalMessages  = (db.prepare("SELECT COUNT(*) as n FROM messages").get() as { n: number }).n;
    const totalToolCalls = (db.prepare("SELECT COUNT(*) as n FROM tool_calls").get() as { n: number }).n;
    const topTools = db.prepare(
      "SELECT tool_name as name, COUNT(*) as count FROM tool_calls GROUP BY tool_name ORDER BY count DESC LIMIT 10"
    ).all() as Array<{ name: string; count: number }>;
    return ok({ totalSessions, totalMessages, totalToolCalls, topTools });
  } catch (e) { return err(`getAgentStats failed: ${String(e)}`); }
}
