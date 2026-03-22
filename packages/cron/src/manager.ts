import cron from "node-cron";
import {
  listCronJobs,
  setCronJobEnabled,
  upsertCronJob as dbUpsertCronJob,
  getConfig,
  createLogger,
} from "@claw/memory";
import { loadSkills } from "@claw/skill-runner";
import type { SkillDefinition } from "@claw/skill-runner";
import { runCronJob } from "./runner.js";
import type { CronJob, CronManager, JobHandle, Result } from "./types.js";
import { ok, err } from "./types.js";

const log = createLogger("cron:manager");

// ── Running job registry ──────────────────────────────────────
const _handles = new Map<string, JobHandle & { task: cron.ScheduledTask }>();

// ── Validate a cron expression ────────────────────────────────
function validateExpression(expression: string): Result<void> {
  if (!cron.validate(expression)) {
    return err(`Invalid cron expression: "${expression}"`);
  }
  return ok(undefined);
}

// ── Schedule one job ──────────────────────────────────────────
function scheduleJob(
  job: CronJob,
  skills: SkillDefinition[]
): Result<JobHandle> {
  const validResult = validateExpression(job.expression);
  if (!validResult.ok) return validResult;

  // Stop existing handle if present (for upsert)
  const existing = _handles.get(job.id);
  if (existing) {
    existing.task.stop();
    _handles.delete(job.id);
    log.debug("Stopped existing job for upsert", { id: job.id });
  }

  const task = cron.schedule(
    job.expression,
    async () => {
      const result = await runCronJob(job, skills);
      if (!result.ok) {
        log.error("Cron job failed", { name: job.name, error: result.error });
      }
    },
    {
      scheduled: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  );

  const handle: JobHandle & { task: cron.ScheduledTask } = {
    jobId: job.id,
    name: job.name,
    expression: job.expression,
    stop: () => {
      task.stop();
      _handles.delete(job.id);
      log.info("Job stopped", { name: job.name });
    },
    task,
  };

  _handles.set(job.id, handle);
  log.info("Job scheduled", { name: job.name, expression: job.expression });

  return ok(handle);
}

// ── CronManager factory ───────────────────────────────────────
export function createCronManager(): CronManager {
  return {
    // ── start ────────────────────────────────────────────────────
    async start(): Promise<Result<void>> {
      log.info("CronManager starting…");
      const config = getConfig();

      // Load skills so runner can execute them
      const skillsResult = loadSkills(config.skills.paths);
      if (!skillsResult.ok) return skillsResult;
      const skills = skillsResult.data;

      // Load all enabled jobs from DB
      const jobsResult = listCronJobs();
      if (!jobsResult.ok) return jobsResult;

      const enabledJobs = jobsResult.data.filter((j) => j.enabled);
      log.info(`Scheduling ${enabledJobs.length} job(s)`, {
        total: jobsResult.data.length,
      });

      for (const job of enabledJobs) {
        const result = scheduleJob(job, skills);
        if (!result.ok) {
          log.warn("Failed to schedule job", {
            name: job.name,
            error: result.error,
          });
          // Non-fatal: skip bad jobs, continue with others
        }
      }

      return ok(undefined);
    },

    // ── stop ─────────────────────────────────────────────────────
    async stop(): Promise<Result<void>> {
      log.info("CronManager stopping…", { jobs: _handles.size });
      for (const handle of _handles.values()) {
        handle.task.stop();
      }
      _handles.clear();
      return ok(undefined);
    },

    // ── upsertJob ─────────────────────────────────────────────────
    upsertJob(job: CronJob): Result<void> {
      // Persist to DB
      const dbResult = dbUpsertCronJob({
        id: job.id,
        name: job.name,
        expression: job.expression,
        skillName: job.skillName,
        inputs: job.inputs,
        enabled: job.enabled,
      });
      if (!dbResult.ok) return dbResult;

      if (!job.enabled) {
        // Stop if running
        const existing = _handles.get(job.id);
        if (existing) {
          existing.task.stop();
          _handles.delete(job.id);
          log.info("Job disabled + stopped", { name: job.name });
        }
        return ok(undefined);
      }

      // Reschedule with fresh skills
      const config = getConfig();
      const skillsResult = loadSkills(config.skills.paths);
      if (!skillsResult.ok) return skillsResult;

      const result = scheduleJob(job, skillsResult.data);
      if (!result.ok) return result;

      return ok(undefined);
    },

    // ── removeJob ─────────────────────────────────────────────────
    removeJob(id: string): Result<void> {
      const handle = _handles.get(id);
      if (handle) {
        handle.task.stop();
        _handles.delete(id);
        log.info("Job removed", { id });
      }
      // Disable in DB (we don't hard-delete so history is preserved)
      return setCronJobEnabled(id, false);
    },

    // ── listRunning ───────────────────────────────────────────────
    listRunning(): JobHandle[] {
      return Array.from(_handles.values()).map(({ jobId, name, expression, stop }) => ({
        jobId,
        name,
        expression,
        stop,
      }));
    },
  };
}
