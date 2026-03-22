import fs from "fs";
import path from "path";
import matter from "gray-matter";
import type { SkillDefinition, SkillInput, Result } from "./types.js";
import { ok, err } from "./types.js";

// ── Frontmatter shape as parsed by gray-matter ───────────────────────────────
interface RawFrontmatter {
  name?: unknown;
  version?: unknown;
  trigger?: unknown;
  description?: unknown;
  inputs?: unknown;
  tools?: unknown;
}

interface RawInput {
  name?: unknown;
  type?: unknown;
  required?: unknown;
  description?: unknown;
}

function parseInput(raw: unknown): SkillInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as RawInput;

  const name = typeof r.name === "string" ? r.name.trim() : null;
  if (!name) return null;

  const type = (["string", "number", "boolean", "url"] as const).includes(
    r.type as "string"
  )
    ? (r.type as SkillInput["type"])
    : "string";

  const input: SkillInput = {
    name,
    type,
    required: r.required !== false,
  };
  if (typeof r.description === "string") {
    input.description = r.description;
  }
  return input;
}

function parseFrontmatter(
  fm: RawFrontmatter,
  filePath: string
): Result<Omit<SkillDefinition, "steps" | "filePath">> {
  const name = typeof fm.name === "string" ? fm.name.trim() : "";
  if (!name) {
    return err(`Skill file "${filePath}" is missing a "name" field`);
  }

  const version =
    typeof fm.version === "string" ? fm.version.trim() : "0.0.0";

  // trigger: string | string[]
  let trigger: string[] = [];
  if (typeof fm.trigger === "string") {
    trigger = [fm.trigger];
  } else if (Array.isArray(fm.trigger)) {
    trigger = fm.trigger.filter((t): t is string => typeof t === "string");
  }
  if (trigger.length === 0) {
    trigger = [name]; // fallback: skill name itself is a trigger
  }

  const description =
    typeof fm.description === "string" ? fm.description.trim() : "";

  const inputs: SkillInput[] = Array.isArray(fm.inputs)
    ? fm.inputs.flatMap((i) => {
        const parsed = parseInput(i);
        return parsed ? [parsed] : [];
      })
    : [];

  const tools: string[] = Array.isArray(fm.tools)
    ? fm.tools.filter((t): t is string => typeof t === "string")
    : [];

  return ok({ name, version, trigger, description, inputs, tools });
}

// ── Parse a single .md file ──────────────────────────────────────────────────
export function parseSkillFile(filePath: string): Result<SkillDefinition> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    return err(`Cannot read skill file "${filePath}": ${String(e)}`);
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (e) {
    return err(`Cannot parse frontmatter in "${filePath}": ${String(e)}`);
  }

  const fmResult = parseFrontmatter(
    parsed.data as RawFrontmatter,
    filePath
  );
  if (!fmResult.ok) return fmResult;

  return ok({
    ...fmResult.data,
    steps: parsed.content.trim(),
    filePath: path.resolve(filePath),
  });
}

// ── Load all skills from a directory ────────────────────────────────────────
export function loadSkillsFromDir(dir: string): Result<SkillDefinition[]> {
  if (!fs.existsSync(dir)) {
    // Missing dirs are silently skipped (user/ community/ may be empty)
    return ok([]);
  }

  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return err(`Cannot read skills directory "${dir}": ${String(e)}`);
  }

  const skills: SkillDefinition[] = [];
  const errors: string[] = [];

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const fullPath = path.join(dir, file);
    const result = parseSkillFile(fullPath);
    if (result.ok) {
      skills.push(result.data);
    } else {
      errors.push(result.error);
    }
  }

  // Non-fatal: log bad files but still return good ones
  if (errors.length > 0) {
    process.stderr.write(
      `[skill-runner] Skipped ${errors.length} invalid skill(s):\n` +
        errors.map((e) => `  • ${e}`).join("\n") +
        "\n"
    );
  }

  return ok(skills);
}

// ── Load skills from multiple directories ────────────────────────────────────
export function loadSkills(dirs: string[]): Result<SkillDefinition[]> {
  const all: SkillDefinition[] = [];
  const seen = new Set<string>(); // deduplicate by name (first-wins)

  for (const dir of dirs) {
    const result = loadSkillsFromDir(dir);
    if (!result.ok) return result; // hard error (permissions etc.)

    for (const skill of result.data) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        all.push(skill);
      }
    }
  }

  return ok(all);
}
