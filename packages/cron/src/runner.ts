import { getSkillByName, resolveSkillCall } from "@claw/skill-runner";
import type { SkillDefinition } from "@claw/skill-runner";
import {
  stampCronJobRun,
  createLogger,
} from "@claw/memory";
import type { CronJob, Result } from "./types.js";
import { ok, err } from "./types.js";

const log = createLogger("cron:runner");

/**
 * Execute the skill attached to a cron job.
 * Called on each cron tick.
 *
 * Returns Result<string> — the skill output summary.
 * Never throws.
 */
export async function runCronJob(
  job: CronJob,
  skills: SkillDefinition[]
): Promise<Result<string>> {
  log.info("Cron tick", { name: job.name, skill: job.skillName });

  // ── 1. Find skill ─────────────────────────────────────────────
  const skillResult = getSkillByName(job.skillName, skills);
  if (!skillResult.ok) return skillResult;

  if (!skillResult.data) {
    const msg = `Cron job "${job.name}": skill "${job.skillName}" not found`;
    log.warn(msg);
    return err(msg);
  }

  const skill = skillResult.data;

  // ── 2. Resolve inputs ─────────────────────────────────────────
  const callResult = resolveSkillCall(skill, job.inputs);
  if (!callResult.ok) {
    log.warn("Input validation failed", { job: job.name, error: callResult.error });
    return callResult;
  }

  // ── 3. Stamp last_run in DB (before execution so partial runs are recorded) ─
  const stampResult = stampCronJobRun(job.id);
  if (!stampResult.ok) {
    log.warn("stampCronJobRun failed", { error: stampResult.error });
    // Non-fatal — continue
  }

  // ── 4. Execute ────────────────────────────────────────────────
  // For now: log resolved steps and return.
  // In step 10+, this will dispatch to the agent tool runner for browser skills.
  const { resolvedSteps } = callResult.data;

  log.info("Cron job executed", {
    name: job.name,
    skill: job.skillName,
    steps: resolvedSteps.split("\n").length,
  });

  return ok(
    `[cron:${job.name}] Skill "${job.skillName}" completed.\n${resolvedSteps}`
  );
}
