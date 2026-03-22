import type { CronJob } from "@claw/memory";

export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;

export function ok<T>(data: T): Ok<T> { return { ok: true, data }; }
export function err(error: string): Err { return { ok: false, error }; }

// ── Running job handle ─────────────────────────────────────────
export interface JobHandle {
  jobId: string;
  name: string;
  expression: string;
  /** Stop this individual job */
  stop: () => void;
}

// ── Cron manager public interface ─────────────────────────────
export interface CronManager {
  /** Load all enabled jobs from DB and schedule them */
  start: () => Promise<Result<void>>;
  /** Stop all scheduled jobs (does not delete from DB) */
  stop: () => Promise<Result<void>>;
  /** Add or update a job without full restart */
  upsertJob: (job: CronJob) => Result<void>;
  /** Remove and stop a job by id */
  removeJob: (id: string) => Result<void>;
  /** List currently running job handles */
  listRunning: () => JobHandle[];
}

export type { CronJob };
