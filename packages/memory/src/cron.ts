import { v4 as uuidv4 } from "uuid";
import type { CronJob, Result } from "./types.js";
import { ok, err } from "./types.js";
import { getDb } from "./db.js";
import { createLogger } from "./logger.js";

const log = createLogger("memory:cron");

interface CronJobRow {
  id: string;
  name: string;
  expression: string;
  skill_name: string;
  inputs: string;   // JSON
  enabled: number;  // 0 | 1
  last_run: number | null;
}

function rowToJob(row: CronJobRow): CronJob {
  let inputs: Record<string, unknown> = {};
  try {
    inputs = JSON.parse(row.inputs) as Record<string, unknown>;
  } catch {
    // malformed JSON — default to empty
  }
  return {
    id: row.id,
    name: row.name,
    expression: row.expression,
    skillName: row.skill_name,
    inputs,
    enabled: row.enabled === 1,
    lastRun: row.last_run ?? null,
  };
}

export function listCronJobs(): Result<CronJob[]> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  try {
    const rows = db
      .prepare("SELECT * FROM cron_jobs ORDER BY name ASC")
      .all() as CronJobRow[];
    return ok(rows.map(rowToJob));
  } catch (e) {
    return err(`listCronJobs failed: ${String(e)}`);
  }
}

export function getCronJob(id: string): Result<CronJob | null> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  try {
    const row = db
      .prepare("SELECT * FROM cron_jobs WHERE id = ?")
      .get(id) as CronJobRow | undefined;
    return ok(row ? rowToJob(row) : null);
  } catch (e) {
    return err(`getCronJob failed: ${String(e)}`);
  }
}

export interface UpsertCronJobInput {
  id?: string;
  name: string;
  expression: string;
  skillName: string;
  inputs?: Record<string, unknown>;
  enabled?: boolean;
}

export function upsertCronJob(input: UpsertCronJobInput): Result<CronJob> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  const id = input.id ?? uuidv4();
  const enabled = input.enabled !== false ? 1 : 0;
  const inputs = JSON.stringify(input.inputs ?? {});

  try {
    db.prepare(
      `INSERT INTO cron_jobs (id, name, expression, skill_name, inputs, enabled)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET
         expression = excluded.expression,
         skill_name = excluded.skill_name,
         inputs     = excluded.inputs,
         enabled    = excluded.enabled`
    ).run(id, input.name, input.expression, input.skillName, inputs, enabled);

    // After ON CONFLICT(name) DO UPDATE the row retains its original id.
    // Look up by name (which is unique) so we always get the canonical row.
    const row = db
      .prepare("SELECT * FROM cron_jobs WHERE name = ?")
      .get(input.name) as CronJobRow | undefined;
    if (!row) return err("upsertCronJob: row missing after insert");

    log.info("Cron job upserted", { name: input.name, expression: input.expression });
    return ok(rowToJob(row));
  } catch (e) {
    return err(`upsertCronJob failed: ${String(e)}`);
  }
}

export function deleteCronJob(id: string): Result<void> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  try {
    db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
    log.info("Cron job deleted", { id });
    return ok(undefined);
  } catch (e) {
    return err(`deleteCronJob failed: ${String(e)}`);
  }
}

export function setCronJobEnabled(id: string, enabled: boolean): Result<void> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  try {
    db.prepare("UPDATE cron_jobs SET enabled = ? WHERE id = ?").run(
      enabled ? 1 : 0,
      id
    );
    return ok(undefined);
  } catch (e) {
    return err(`setCronJobEnabled failed: ${String(e)}`);
  }
}

export function stampCronJobRun(id: string): Result<void> {
  const dbResult = getDb();
  if (!dbResult.ok) return dbResult;
  const db = dbResult.data;

  try {
    db.prepare("UPDATE cron_jobs SET last_run = ? WHERE id = ?").run(
      Date.now(),
      id
    );
    return ok(undefined);
  } catch (e) {
    return err(`stampCronJobRun failed: ${String(e)}`);
  }
}
