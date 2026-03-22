import {
  navigate, snapshot, click, typeText, screenshot,
  launchBrowser,
} from "@claw/browser";
import type { BrowserConfig } from "@claw/browser";
import {
  getSkillByName, resolveSkillCall,
} from "@claw/skill-runner";
import type { SkillDefinition } from "@claw/skill-runner";
import { upsertCronJob, getMemory, setMemory, recordToolCall } from "@claw/memory";
import type { ClawConfig } from "@claw/memory";
import { createLogger } from "@claw/memory";
import type { LLMToolCall, Result } from "./types.js";
import { ok, err } from "./types.js";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";

const execFileAsync = promisify(execFile);

const log = createLogger("agent:tools");

export interface ToolContext {
  skills: SkillDefinition[];
  browserConfig: BrowserConfig;
  sessionId: string;
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
    args = JSON.parse(argsStr) as Record<string, unknown>;
  } catch {
    return err(`Tool "${name}" received invalid JSON arguments: ${argsStr}`);
  }

  log.info("Tool dispatch →", { tool: name, args });

  // Record tool call for analytics
  recordToolCall(ctx.sessionId, name);

  switch (name) {
    case "browser":
      return dispatchBrowser(args, ctx.browserConfig);
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

// ── browser tool ──────────────────────────────────────────────
async function dispatchBrowser(
  args: Record<string, unknown>,
  config: BrowserConfig
): Promise<Result<string>> {
  const action = String(args["action"] ?? "");

  // Ensure browser is running
  const launchResult = await launchBrowser(config);
  if (!launchResult.ok) return launchResult;

  switch (action) {
    case "navigate": {
      const url = String(args["url"] ?? "");
      if (!url) return err('browser: action="navigate" requires "url"');
      const result = await navigate(url);
      if (!result.ok) return result;
      return ok(`Navigated to: ${result.data.url}\nTitle: ${result.data.title}`);
    }

    case "snapshot": {
      const result = await snapshot();
      if (!result.ok) return result;
      const { url, title, elements, textContent } = result.data;
      const elemSummary = elements
        .slice(0, 30)
        .map((el) => {
          const href = el.href ? ` href="${el.href}"` : "";
          return `  <${el.tag}${href}>${el.text}</${el.tag}>`;
        })
        .join("\n");
      return ok(
        `URL: ${url}\nTitle: ${title}\n\nElements:\n${elemSummary}\n\nPage text:\n${textContent.slice(0, 1500)}`
      );
    }

    case "click": {
      const selector = String(args["selector"] ?? "");
      if (!selector) return err('browser: action="click" requires "selector"');
      const result = await click(selector);
      if (!result.ok) return result;
      return ok(`Clicked: ${selector}`);
    }

    case "type": {
      const selector = String(args["selector"] ?? "");
      const text = String(args["text"] ?? "");
      if (!selector) return err('browser: action="type" requires "selector"');
      if (!text) return err('browser: action="type" requires "text"');
      const result = await typeText(selector, text);
      if (!result.ok) return result;
      return ok(`Typed into ${selector}: "${text}"`);
    }

    case "screenshot": {
      const fullPage = String(args["full_page"] ?? "true") !== "false";
      const result = await screenshot({ fullPage });
      if (!result.ok) return result;
      const { title, url, base64 } = result.data;
      // Return metadata + short base64 preview — full data available to caller
      return ok(
        JSON.stringify({
          title,
          url,
          mimeType: "image/png",
          base64Length: base64.length,
          // Include full base64 so agent can pass it to the answer
          base64,
        })
      );
    }

    default:
      return err(
        `browser: unknown action "${action}". Valid: navigate, snapshot, click, type, screenshot`
      );
  }
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

  // Execute skill steps via browser (skills that need browser)
  if (skill.tools.includes("browser")) {
    return executeBrowserSkill(callResult.data.resolvedSteps, inputs, ctx.browserConfig);
  }

  // For non-browser skills: return resolved steps as the result
  // (future: other tool types will be dispatched here)
  return ok(`Skill "${skillName}" resolved steps:\n${callResult.data.resolvedSteps}`);
}

async function executeBrowserSkill(
  steps: string,
  inputs: Record<string, unknown>,
  browserConfig: BrowserConfig
): Promise<Result<string>> {
  // Parse numbered steps and execute sequentially
  const lines = steps.split("\n").filter((l) => /^\d+\./.test(l.trim()));

  const launchResult = await launchBrowser(browserConfig);
  if (!launchResult.ok) return launchResult;

  const results: string[] = [];

  for (const line of lines) {
    const step = line.replace(/^\d+\.\s*/, "").trim().toLowerCase();

    if (step.startsWith("navigate to") || step.includes("navigate to")) {
      const url = extractUrl(line) ?? String(inputs["url"] ?? "");
      if (url) {
        const r = await navigate(url);
        if (r.ok) results.push(`Navigated to: ${r.data.title}`);
        else return r;
      }
    } else if (step.includes("screenshot") || step.includes("capture")) {
      const r = await screenshot({ fullPage: true });
      if (r.ok) {
        results.push(
          JSON.stringify({ title: r.data.title, url: r.data.url, base64: r.data.base64 })
        );
      } else return r;
    } else if (step.includes("snapshot") || step.includes("extract")) {
      const r = await snapshot();
      if (r.ok) results.push(`Snapshot: ${r.data.title} — ${r.data.elements.length} elements`);
      else return r;
    }
    // Other steps are informational / wait steps — skip
  }

  return ok(results.join("\n") || "Skill executed (no output)");
}

function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0] : null;
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
  sessionId: string
): ToolContext {
  const browserConfig: BrowserConfig = {
    headless: config.browser.headless,
    executablePath: config.browser.executable_path,
  };
  return { skills, browserConfig, sessionId };
}
