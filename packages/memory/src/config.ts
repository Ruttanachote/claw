import fs from "fs";
import path from "path";
import os from "os";
import TOML from "@iarna/toml";
import type { ClawConfig, Result } from "./types.js";
import { ok, err } from "./types.js";

const DEFAULT_CONFIG: ClawConfig = {
  llm: {
    provider: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    api_key: "",
    model: "anthropic/claude-sonnet-4-6",
    max_tokens: 4096,
  },
  agent: {
    orchestrator_model: "anthropic/claude-sonnet-4-6",
    sub_agent_model: "anthropic/claude-haiku-4-5-20251001",
    max_iterations: 20,
  },
  browser: {
    headless: true,
    executable_path: "",
  },
  memory: {
    db_path: "./claw.db",
    max_context_messages: 50,
  },
  skills: {
    paths: ["./skills/built-in", "./skills/user", "./skills/community"],
  },
  logging: {
    dir: "~/.claw/logs",
    level: "info",
  },
};

// Singleton — loaded once per process
let _config: ClawConfig | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mergeDeep(base: any, override: any): any {
  // Arrays are replaced wholesale — never deep-merged
  if (Array.isArray(override)) return override;
  if (Array.isArray(base))     return override ?? base;

  if (
    typeof base !== "object" || base === null ||
    typeof override !== "object" || override === null
  ) {
    return override ?? base;
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const result = { ...base };
  for (const key of Object.keys(override)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
    result[key] = mergeDeep(base[key], override[key]);
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return result;
}

function resolvePath(p: string, base: string): string {
  if (path.isAbsolute(p)) return p;
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(base, p);
}

/** Locations searched in priority order (first found wins):
 *  1. Explicit path passed by caller
 *  2. ~/.claw/config.toml  (standard user config location)
 *  3. process.cwd()/claw.config.toml  (dev / alongside binary fallback)
 */
function findConfigPath(explicit?: string): string | null {
  // Build candidate list: explicit first (if given), then standard fallbacks.
  // We always try ALL candidates so the app works even if userData path is missing.
  const candidates: string[] = [];
  if (explicit) candidates.push(path.resolve(explicit));
  candidates.push(
    path.join(os.homedir(), ".claw", "config.toml"),
    path.resolve(process.cwd(), "claw.config.toml"),
  );
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export function loadConfig(configPath?: string): Result<ClawConfig> {
  const resolvedPath = findConfigPath(configPath);

  if (!resolvedPath) {
    _config = structuredClone(DEFAULT_CONFIG);
    return ok(_config);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, "utf-8");
  } catch (e) {
    return err(`Failed to read config file: ${String(e)}`);
  }

  let parsed: TOML.JsonMap;
  try {
    parsed = TOML.parse(raw);
  } catch (e) {
    return err(`Failed to parse claw.config.toml: ${String(e)}`);
  }

  const baseDir = path.dirname(resolvedPath);

  // Merge parsed TOML over defaults (unknown shape from TOML → cast via mergeDeep)
  const merged = mergeDeep(
    structuredClone(DEFAULT_CONFIG),
    parsed
  ) as ClawConfig;

  // Resolve relative paths against config file location
  merged.memory.db_path = resolvePath(merged.memory.db_path, baseDir);
  merged.skills.paths = merged.skills.paths.map((p) => resolvePath(p, baseDir));

  _config = merged;
  return ok(_config);
}

export function getConfig(): ClawConfig {
  if (!_config) {
    loadConfig();
  }
  return _config ?? structuredClone(DEFAULT_CONFIG);
}

/** Returns the path where the active config was/will be loaded from.
 *  Used by the UI "Open Config File" button. */
export function getConfigPath(): string {
  return (
    findConfigPath() ??
    path.join(os.homedir(), ".claw", "config.toml")
  );
}
