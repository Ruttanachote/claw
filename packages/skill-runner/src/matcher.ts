import type { SkillDefinition, Result } from "./types.js";
import { ok, err } from "./types.js";

/**
 * Match a user query against loaded skills.
 *
 * Strategy (in order):
 *  1. Exact name match  — "browser-screenshot"
 *  2. Trigger keyword   — any trigger word appears in query (case-insensitive)
 *  3. Fuzzy name match  — query contains skill name as substring
 *
 * Returns the first (highest-priority) match, or null if nothing found.
 */
export function matchSkill(
  query: string,
  skills: SkillDefinition[]
): Result<SkillDefinition | null> {
  if (skills.length === 0) return ok(null);

  const q = query.toLowerCase().trim();

  // 1. Exact name
  for (const skill of skills) {
    if (skill.name.toLowerCase() === q) return ok(skill);
  }

  // 2. Trigger keyword anywhere in the query
  for (const skill of skills) {
    for (const trigger of skill.trigger) {
      const t = trigger.toLowerCase();
      // Match whole word boundary so "snap" doesn't match "snapshot"
      const regex = new RegExp(`\\b${escapeRegex(t)}\\b`, "i");
      if (regex.test(query)) return ok(skill);
    }
  }

  // 3. Skill name as substring
  for (const skill of skills) {
    if (q.includes(skill.name.toLowerCase())) return ok(skill);
  }

  return ok(null);
}

/** Return all skills whose triggers overlap with the query (for multi-skill plans). */
export function matchAllSkills(
  query: string,
  skills: SkillDefinition[]
): Result<SkillDefinition[]> {
  const q = query.toLowerCase();
  const matches: SkillDefinition[] = [];
  const seen = new Set<string>();

  for (const skill of skills) {
    if (seen.has(skill.name)) continue;
    // Check name + all triggers
    const terms = [skill.name, ...skill.trigger].map((t) => t.toLowerCase());
    const hit = terms.some((t) => {
      const regex = new RegExp(`\\b${escapeRegex(t)}\\b`, "i");
      return regex.test(q);
    });
    if (hit) {
      matches.push(skill);
      seen.add(skill.name);
    }
  }

  return ok(matches);
}

/** Find skill by exact name (used by agent tool dispatch). */
export function getSkillByName(
  name: string,
  skills: SkillDefinition[]
): Result<SkillDefinition | null> {
  const found = skills.find(
    (s) => s.name.toLowerCase() === name.toLowerCase()
  );
  return ok(found ?? null);
}

/** Validate that all required inputs are present. */
export function validateInputs(
  skill: SkillDefinition,
  provided: Record<string, unknown>
): Result<Record<string, string | number | boolean>> {
  const resolved: Record<string, string | number | boolean> = {};
  const missing: string[] = [];

  for (const inputDef of skill.inputs) {
    const val = provided[inputDef.name];

    if (val === undefined || val === null || val === "") {
      if (inputDef.required) {
        missing.push(inputDef.name);
      }
      continue;
    }

    // Coerce types
    switch (inputDef.type) {
      case "number":
        resolved[inputDef.name] = Number(val);
        break;
      case "boolean":
        resolved[inputDef.name] =
          val === true || val === "true" || val === "1";
        break;
      default:
        resolved[inputDef.name] = String(val);
    }
  }

  if (missing.length > 0) {
    return err(
      `Skill "${skill.name}" is missing required inputs: ${missing.join(", ")}`
    );
  }

  return ok(resolved);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
