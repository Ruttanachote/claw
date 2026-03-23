import {
  getSkillByName, resolveSkillCall,
} from "@claw/skill-runner";
import type { SkillDefinition } from "@claw/skill-runner";
import { upsertCronJob, getMemory, setMemory, recordToolCall } from "@claw/memory";
import type { ClawConfig } from "@claw/memory";
import { createLogger } from "@claw/memory";
import type { LLMToolCall, Result, PanelBrowser } from "./types.js";
import { ok, err } from "./types.js";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";

const execFileAsync = promisify(execFile);

const log = createLogger("agent:tools");

export interface LLMConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  subAgentModel?: string;
}

export interface ToolContext {
  skills: SkillDefinition[];
  sessionId: string;
  llmConfig: LLMConfig;
  panelBrowser?: PanelBrowser;
}

// ── Dispatch a single tool call ───────────────────────────────
export async function dispatchToolCall(
  toolCall: LLMToolCall,
  ctx: ToolContext,
  onChunk?: (chunk: string) => void,   // optional streaming callback for shell
): Promise<Result<string>> {
  const { name, arguments: argsStr } = toolCall.function;

  let args: Record<string, unknown>;
  try {
    args = (argsStr && argsStr.trim()) ? JSON.parse(argsStr) as Record<string, unknown> : {};
  } catch {
    return err(`Tool "${name}" received invalid JSON arguments: ${argsStr}`);
  }

  log.info("Tool dispatch →", { tool: name, args });

  // Record tool call for analytics
  recordToolCall(ctx.sessionId, name);

  switch (name) {
    case "browser_agent":
      return dispatchBrowserAgent(args, ctx);
    case "run_skill":
      return dispatchRunSkill(args, ctx);
    case "schedule_cron":
      return dispatchScheduleCron(args);
    case "shell":
      return dispatchShell(args, onChunk);
    case "read_file":
      return dispatchReadFile(args);
    case "write_file":
      return dispatchWriteFile(args);
    case "list_dir":
      return dispatchListDir(args);
    case "memory_read":
      return dispatchMemoryRead(args);
    case "memory_write":
      return dispatchMemoryWrite(args);
    default:
      return err(`Unknown tool: "${name}"`);
  }
}

// ── browser_agent tool ────────────────────────────────────────
/** Find the browser-use Python script. Checks ~/.claw/browser-agent/ then dev path. */
function findBrowserAgentScript(): string {
  const candidates = [
    path.join(os.homedir(), ".claw", "browser-agent", "agent.py"),
    path.join(process.cwd(), "packages", "browser-agent", "agent.py"),
    path.join(path.dirname(process.argv[1] ?? ""), "..", "..", "packages", "browser-agent", "agent.py"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0]!;
}

async function dispatchBrowserAgent(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<Result<string>> {
  const task      = String(args["task"] ?? "").trim();
  const maxSteps  = Number(args["max_steps"] ?? 20);

  if (!task) return err('browser_agent: "task" is required');

  const scriptPath = findBrowserAgentScript();
  if (!fs.existsSync(scriptPath)) {
    return err(
      `browser-use sub-agent not installed.\n` +
      `Run the following to set it up:\n` +
      `  pip install browser-use langchain-openai playwright\n` +
      `  playwright install chromium\n` +
      `  mkdir -p ~/.claw/browser-agent\n` +
      `  cp packages/browser-agent/agent.py ~/.claw/browser-agent/`
    );
  }

  // Use venv python if available (avoids externally-managed-environment restrictions)
  const home = process.env.HOME ?? "~";
  const python = (() => {
    if (process.platform === "win32") return "python";
    const { execSync } = require("child_process") as typeof import("child_process");
    const candidates = [
      `${home}/.claw/browser-agent/venv/bin/python`,
      "/opt/homebrew/bin/python3.12",
      "/usr/local/bin/python3.12",
      "python3.12",
      "python3",
    ];
    for (const bin of candidates) {
      try { execSync(`${bin} --version`, { stdio: "ignore" }); return bin; } catch {}
    }
    return "python3";
  })();
  const payload = JSON.stringify({ task, max_steps: maxSteps });

  // ── Show the panel first so user sees something immediately ──
  ctx.panelBrowser?.show();

  // ── Get CDP URL so browser-use can control the visible panel ─
  const cdpUrl = await ctx.panelBrowser?.getCdpUrl() ?? null;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    IKAI_API_KEY:         ctx.llmConfig.apiKey,
    IKAI_BASE_URL:        ctx.llmConfig.baseUrl ?? "",
    IKAI_MODEL:           ctx.llmConfig.model,
    IKAI_SUB_AGENT_MODEL: ctx.llmConfig.subAgentModel ?? ctx.llmConfig.model,
    ...(cdpUrl ? { BROWSER_AGENT_CDP_URL: cdpUrl } : {}),
  };

  log.info("browser_agent: starting sub-agent", {
    task: task.slice(0, 100),
    scriptPath,
    cdpConnected: !!cdpUrl,
  });

  try {
    const { stdout, stderr } = await execFileAsync(python, [scriptPath, payload], {
      env,
      timeout: 180_000,   // 3 min — browser tasks can be slow
    });

    if (stderr?.trim()) {
      log.warn("browser_agent stderr", { stderr: stderr.slice(0, 500) });
    }

    const output = stdout.trim();
    if (!output) return err("browser_agent returned no output");

    try {
      const parsed = JSON.parse(output) as { result?: string; error?: string };
      if (parsed.error) return err(`browser_agent: ${parsed.error}`);
      return ok(stripBase64(parsed.result ?? output));
    } catch {
      return ok(stripBase64(output));
    }
  } catch (e: unknown) {
    const ex = e as { stderr?: string; stdout?: string; message?: string; code?: string };
    if (ex.code === "ETIMEDOUT") return err("browser_agent: timed out after 3 minutes");
    // stdout may contain JSON error from agent.py; stderr has Python tracebacks
    const fromStdout = (() => {
      try {
        const p = JSON.parse(ex.stdout?.trim() ?? "") as { error?: string };
        return p.error ?? null;
      } catch { return null; }
    })();
    const detail = fromStdout || ex.stderr?.trim() || ex.stdout?.trim() || ex.message || String(e);
    return err(`browser_agent failed: ${detail}`);
  }
}

// ── Strip base64 blobs from any text before sending to LLM ───
function stripBase64(text: string): string {
  return text.replace(
    /"base64"\s*:\s*"[A-Za-z0-9+/=\r\n]{50,}"/g,
    '"base64":"[stripped]"'
  );
}

// ── run_skill tool ────────────────────────────────────────────
async function dispatchRunSkill(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<Result<string>> {
  const skillName = String(args["skill_name"] ?? "");
  if (!skillName) return err('run_skill: "skill_name" is required');

  // Parse inputs JSON
  let inputs: Record<string, unknown> = {};
  const rawInputs = args["inputs"];
  if (typeof rawInputs === "string") {
    try {
      inputs = JSON.parse(rawInputs) as Record<string, unknown>;
    } catch {
      return err(`run_skill: "inputs" is not valid JSON: ${rawInputs}`);
    }
  } else if (typeof rawInputs === "object" && rawInputs !== null) {
    inputs = rawInputs as Record<string, unknown>;
  }

  // Look up skill
  const skillResult = getSkillByName(skillName, ctx.skills);
  if (!skillResult.ok) return skillResult;
  if (!skillResult.data) {
    return err(
      `run_skill: skill "${skillName}" not found. Available: ${ctx.skills.map((s) => s.name).join(", ")}`
    );
  }

  const skill = skillResult.data;

  // Validate + resolve inputs
  const callResult = resolveSkillCall(skill, inputs);
  if (!callResult.ok) return callResult;

  log.info("Running skill", { name: skillName, inputs });

  // For browser skills: route through browser_agent
  if (skill.tools.includes("browser")) {
    return dispatchBrowserAgent(
      { task: callResult.data.resolvedSteps, max_steps: 30 },
      ctx
    );
  }

  // For non-browser skills: return resolved steps as the result
  return ok(`Skill "${skillName}" resolved steps:\n${callResult.data.resolvedSteps}`);
}

// ── schedule_cron tool ────────────────────────────────────────
async function dispatchScheduleCron(
  args: Record<string, unknown>
): Promise<Result<string>> {
  const name       = String(args["name"]       ?? "");
  const expression = String(args["expression"] ?? "");
  const skillName  = String(args["skill_name"] ?? "");
  const inputsRaw  = String(args["inputs"]     ?? "{}");

  if (!name)       return err('schedule_cron: "name" is required');
  if (!expression) return err('schedule_cron: "expression" is required');
  if (!skillName)  return err('schedule_cron: "skill_name" is required');

  let inputs: Record<string, unknown> = {};
  try {
    inputs = JSON.parse(inputsRaw) as Record<string, unknown>;
  } catch {
    return err(`schedule_cron: "inputs" is not valid JSON: ${inputsRaw}`);
  }

  const result = upsertCronJob({ name, expression, skillName, inputs });
  if (!result.ok) return result;

  return ok(
    `Scheduled "${name}" (${skillName}) to run at "${expression}" (cron). Job ID: ${result.data.id}`
  );
}

// ── shell tool ────────────────────────────────────────────────
// Shell executable and its "run this command" flag, per platform.
//   Windows → powershell.exe -NonInteractive -NoProfile -Command <cmd>
//             Supports ls/cat/pwd aliases, full scripting, UTF-8 output
//   macOS/Linux → /bin/sh -c <cmd>
//             POSIX-compatible, universal
const SHELL_CFG = process.platform === "win32"
  ? { exe: "powershell.exe", flags: ["-NonInteractive", "-NoProfile", "-Command"] }
  : { exe: "/bin/sh",        flags: ["-c"] };

// Export so loop.ts can pass the shell name into the system prompt
export const SHELL_BIN = SHELL_CFG.exe;

async function dispatchShell(
  args: Record<string, unknown>,
  onChunk?: (chunk: string) => void,
): Promise<Result<string>> {
  const command = String(args["command"] ?? "").trim();
  if (!command) return err('shell: "command" is required');

  const cwd     = String(args["cwd"] ?? os.homedir());
  const timeout = Math.min(Number(args["timeout_ms"] ?? 30000), 120000);

  log.info("Shell exec", { exe: SHELL_CFG.exe, cwd, command: command.slice(0, 120) });

  // ── Streaming path (spawn) — used when caller wants real-time chunks ──
  if (onChunk) {
    return new Promise<Result<string>>((resolve) => {
      const proc = spawn(SHELL_CFG.exe, [...SHELL_CFG.flags, command], {
        cwd, env: { ...process.env },
      });

      let accumulated = "";
      let timedOut    = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        resolve(err(`shell: timed out after ${timeout}ms`));
      }, timeout);

      proc.stdout.on("data", (chunk: Buffer) => {
        const str = chunk.toString();
        accumulated += str;
        onChunk(str);
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        const str = chunk.toString();
        accumulated += str;
        onChunk(str);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        const out = accumulated.trim() || "(no output)";
        if (code === 0 || code === null) resolve(ok(out));
        else resolve(err(`shell failed — exit code: ${String(code)}\n${out}`));
      });
      proc.on("error", (e: Error) => {
        clearTimeout(timer);
        if (!timedOut) resolve(err(`shell failed — ${e.message}`));
      });
    });
  }

  // ── Non-streaming path (execFile) — fallback without chunk callback ──
  try {
    const { stdout, stderr } = await execFileAsync(
      SHELL_CFG.exe,
      [...SHELL_CFG.flags, command],
      { cwd, timeout, maxBuffer: 1024 * 1024, env: { ...process.env } }
    );
    const out  = (stdout as string).trim();
    const err_ = (stderr as string).trim();
    return ok([out, err_ ? `STDERR:\n${err_}` : ""].filter(Boolean).join("\n") || "(no output)");
  } catch (e) {
    const ex = e as { stdout?: string; stderr?: string; message?: string; code?: number };
    const detail = [
      ex.code !== undefined ? `exit code: ${String(ex.code)}` : null,
      (ex.stdout as string | undefined)?.trim() || null,
      (ex.stderr as string | undefined)?.trim() || null,
      ex.message || null,
    ].filter(Boolean).join("\n");
    return err(`shell failed — ${detail || String(e)}`);
  }
}

// ── read_file tool ────────────────────────────────────────────
async function dispatchReadFile(args: Record<string, unknown>): Promise<Result<string>> {
  const filePath = String(args["path"] ?? "").trim();
  if (!filePath) return err('read_file: "path" is required');

  // Expand ~ to home directory
  const expanded = filePath.startsWith("~")
    ? path.join(os.homedir(), filePath.slice(1))
    : filePath;
  // Resolve relative paths against home dir, not app cwd
  const resolved = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(os.homedir(), expanded);
  const maxBytes = Math.min(Number(args["max_bytes"] ?? 32768), 131072); // default 32KB, max 128KB

  log.info("Read file", { path: resolved });

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return err(`read_file: "${resolved}" is not a file`);
    const buf = Buffer.alloc(maxBytes);
    const fd  = fs.openSync(resolved, "r");
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
    const content = buf.slice(0, bytesRead).toString("utf8");
    const truncated = bytesRead === maxBytes && stat.size > maxBytes;
    return ok(truncated ? content + `\n\n[...truncated — ${stat.size} bytes total]` : content);
  } catch (e) {
    return err(`read_file: ${String(e)}`);
  }
}

// ── write_file tool ───────────────────────────────────────────
async function dispatchWriteFile(args: Record<string, unknown>): Promise<Result<string>> {
  const filePath = String(args["path"] ?? "").trim();
  const content  = String(args["content"] ?? "");
  if (!filePath) return err('write_file: "path" is required');

  const expanded = filePath.startsWith("~")
    ? path.join(os.homedir(), filePath.slice(1))
    : filePath;
  const resolved = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(os.homedir(), expanded);
  log.info("Write file", { path: resolved, bytes: content.length });

  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    return ok(`Written ${content.length} bytes to ${resolved}`);
  } catch (e) {
    return err(`write_file: ${String(e)}`);
  }
}

// ── list_dir tool ─────────────────────────────────────────────
async function dispatchListDir(args: Record<string, unknown>): Promise<Result<string>> {
  const dirPath = String(args["path"] ?? "~").trim();
  const expanded = dirPath.startsWith("~")
    ? path.join(os.homedir(), dirPath.slice(1))
    : dirPath;
  const resolved = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(os.homedir(), expanded);

  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const lines = entries.slice(0, 200).map((e) => {
      const type = e.isDirectory() ? "dir " : "file";
      const size = e.isFile()
        ? ` (${fs.statSync(path.join(resolved, e.name)).size}B)`
        : "";
      return `${type}  ${e.name}${size}`;
    });
    if (entries.length > 200) lines.push(`... (${entries.length - 200} more)`);
    return ok(`${resolved}/\n${lines.join("\n")}`);
  } catch (e) {
    return err(`list_dir: ${String(e)}`);
  }
}

// ── memory_read tool ──────────────────────────────────────────
async function dispatchMemoryRead(args: Record<string, unknown>): Promise<Result<string>> {
  const key = String(args["key"] ?? "").trim();
  if (!key) return err('memory_read: "key" is required');

  const result = getMemory(key);
  if (!result.ok) return result;
  if (!result.data) return ok(`(no memory stored for key "${key}")`);
  return ok(result.data.value);
}

// ── memory_write tool ─────────────────────────────────────────
async function dispatchMemoryWrite(args: Record<string, unknown>): Promise<Result<string>> {
  const key   = String(args["key"]   ?? "").trim();
  const value = String(args["value"] ?? "").trim();
  if (!key)   return err('memory_write: "key" is required');
  if (!value) return err('memory_write: "value" is required');

  const result = setMemory(key, value);
  if (!result.ok) return result;
  return ok(`Memory saved: ${key} = ${value}`);
}

// ── Public shell runner (used by terminal panel IPC) ──────────
/** Run a shell command directly — same engine as the agent's shell tool. */
export async function execShellCommand(
  command: string,
  cwd?: string,
  onChunk?: (chunk: string) => void,
): Promise<Result<string>> {
  return dispatchShell({ command, cwd: cwd ?? os.homedir() }, onChunk);
}

// ── Build ToolContext from config ─────────────────────────────
export function buildToolContext(
  skills: SkillDefinition[],
  config: ClawConfig,
  sessionId: string,
  panelBrowser?: PanelBrowser
): ToolContext {
  const llmConfig: LLMConfig = {
    apiKey:        config.llm.api_key,
    model:         config.llm.model,
    baseUrl:       config.llm.base_url,
    subAgentModel: config.agent.sub_agent_model,
  };
  return {
    skills,
    sessionId,
    llmConfig,
    ...(panelBrowser ? { panelBrowser } : {}),
  };
}
