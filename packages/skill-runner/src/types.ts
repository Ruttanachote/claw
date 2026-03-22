// ── Result monad (local copy — no cross-package import at scaffold level) ────
export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data };
}
export function err(error: string): Err {
  return { ok: false, error };
}

// ── Skill definition ─────────────────────────────────────────────────────────
export interface SkillInput {
  name: string;
  type: "string" | "number" | "boolean" | "url";
  required: boolean;
  description?: string;
}

export interface SkillDefinition {
  /** Unique machine-readable name, e.g. "browser-screenshot" */
  name: string;
  version: string;
  /** Keywords that activate this skill from natural language */
  trigger: string[];
  description: string;
  inputs: SkillInput[];
  /** Tool names this skill requires, e.g. ["browser"] */
  tools: string[];
  /** Raw markdown body (the ## Steps section) */
  steps: string;
  /** Absolute path of the .md source file */
  filePath: string;
}

// ── Resolved skill call (inputs filled in) ───────────────────────────────────
export interface SkillCall {
  skill: SkillDefinition;
  /** Resolved input values after validation */
  inputs: Record<string, string | number | boolean>;
  /** Steps with {variables} substituted */
  resolvedSteps: string;
}
