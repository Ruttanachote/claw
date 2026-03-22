import type { SkillDefinition, SkillCall, Result } from "./types.js";
import { ok } from "./types.js";
import { validateInputs } from "./matcher.js";

/**
 * Resolve a skill call:
 *  1. Validate inputs
 *  2. Substitute {variable} placeholders in the steps text
 *
 * Substitution rules:
 *  - {url}        → value of input named "url"
 *  - {query}      → value of "query"
 *  - {input_name} → value of any declared input
 *  - Unrecognised placeholders are left unchanged
 */
export function resolveSkillCall(
  skill: SkillDefinition,
  rawInputs: Record<string, unknown>
): Result<SkillCall> {
  const validationResult = validateInputs(skill, rawInputs);
  if (!validationResult.ok) return validationResult;

  const inputs = validationResult.data;
  const resolvedSteps = substituteVars(skill.steps, inputs);

  return ok({ skill, inputs, resolvedSteps });
}

/**
 * Substitute {key} placeholders in a template string.
 * Only substitutes keys that exist in the values map.
 */
export function substituteVars(
  template: string,
  values: Record<string, string | number | boolean>
): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const val = values[key];
    return val !== undefined ? String(val) : `{${key}}`;
  });
}

/**
 * Build a compact summary of a skill suitable for inclusion in an LLM
 * system prompt (agent uses this to describe available tools).
 */
export function skillToPromptEntry(skill: SkillDefinition): string {
  const inputList =
    skill.inputs.length > 0
      ? "\n  Inputs: " +
        skill.inputs
          .map(
            (i) =>
              `${i.name} (${i.type}${i.required ? ", required" : ", optional"})`
          )
          .join(", ")
      : "";

  const triggerList = skill.trigger.join(", ");

  return (
    `• ${skill.name} — ${skill.description}` +
    `\n  Triggers: ${triggerList}` +
    inputList
  );
}

/** Build a full skills catalogue string for the orchestrator system prompt. */
export function buildSkillsCatalogue(skills: SkillDefinition[]): string {
  if (skills.length === 0) return "(no skills loaded)";
  return skills.map(skillToPromptEntry).join("\n\n");
}
