import { ipcMain, shell } from "electron";
import type { BrowserWindow } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// ── Config template written on first "Open Config" ────────────
const CONFIG_TEMPLATE = `# IKAI Configuration
# Place this file at: ~/.claw/config.toml
# Docs: https://github.com/your-org/ikai

[llm]
provider    = "openrouter"
base_url    = "https://openrouter.ai/api/v1"
api_key     = "sk-or-YOUR_KEY_HERE"
model       = "anthropic/claude-sonnet-4-6"
max_tokens  = 4096

[agent]
max_iterations = 20

[memory]
db_path = "~/.claw/ikai.db"

[skills]
paths = ["~/.claw/skills"]

[logging]
level = "info"
`;
import {
  getConfig,
  getConfigPath,
  createLogger,
  setLogSink,
  getLogEntries,
  listMemories,
  getMemory,
  setMemory,
  deleteMemory,
  getAgentStats,
} from "@claw/memory";
import type { LogEntry } from "@claw/memory";
import {
  handleCommand,
  abortCurrentRun,
  listRecentSessions,
  newSession,
  removeSession,
} from "@claw/gateway";
import { execShellCommand, SHELL_BIN } from "@claw/agent";
import {
  listCronJobs,
  setCronJobEnabled,
  deleteCronJob as dbDeleteCronJob,
} from "@claw/memory";
import { loadSkills } from "@claw/skill-runner";
import { sendProgress } from "./window.js";

const log = createLogger("main:ipc");

export function registerIpcHandlers(win: BrowserWindow): void {

  // ── Live log streaming ─────────────────────────────────────
  setLogSink((entry: LogEntry) => {
    if (!win.isDestroyed()) {
      win.webContents.send("log:entry", entry);
    }
  });

  // ── agent:run ─────────────────────────────────────────────
  ipcMain.handle(
    "agent:run",
    async (_e, { input, sessionId }: { input: string; sessionId: string }) => {
      log.info("IPC agent:run", { sessionId, inputLen: input.length });
      return handleCommand({
        input,
        sessionId,
        onProgress: (step, message) => sendProgress(win, step, message),
        onToken:    (token)         => win.webContents.send("agent:token", token),
      });
    }
  );

  // ── agent:abort ───────────────────────────────────────────
  ipcMain.handle("agent:abort", () => { abortCurrentRun(); return { ok: true }; });

  // ── session:new / list / delete ───────────────────────────
  ipcMain.handle("session:new",    () => newSession());
  ipcMain.handle("session:list",   () => listRecentSessions(50));
  ipcMain.handle("session:delete", (_e, id: string) => removeSession(id));

  // ── session:messages ──────────────────────────────────────
  ipcMain.handle("session:messages", (_e, sessionId: string) => {
    const { listMessages } = require("@claw/memory") as typeof import("@claw/memory");
    return listMessages(sessionId);
  });

  // ── cron:* ────────────────────────────────────────────────
  ipcMain.handle("cron:list",   () => listCronJobs());
  ipcMain.handle("cron:toggle", (_e, { id, enabled }: { id: string; enabled: boolean }) =>
    setCronJobEnabled(id, enabled)
  );
  ipcMain.handle("cron:delete", (_e, id: string) => dbDeleteCronJob(id));

  // ── memory:* (long-term KV) ───────────────────────────────
  ipcMain.handle("memory:list",   () => listMemories());
  ipcMain.handle("memory:get",    (_e, key: string)            => getMemory(key));
  ipcMain.handle("memory:set",    (_e, { key, value }: { key: string; value: string }) =>
    setMemory(key, value)
  );
  ipcMain.handle("memory:delete", (_e, key: string) => deleteMemory(key));

  // ── analytics:stats ───────────────────────────────────────
  ipcMain.handle("analytics:stats", () => getAgentStats());

  // ── skills:list ───────────────────────────────────────────
  ipcMain.handle("skills:list", () => {
    const cfg = getConfig();
    return loadSkills(cfg.skills.paths);
  });

  // ── logs:history ──────────────────────────────────────────
  ipcMain.handle("logs:history", () => ({ ok: true, data: getLogEntries() }));

  // ── shell:exec (terminal panel direct commands — streams chunks) ───
  ipcMain.handle(
    "shell:exec",
    async (_e, { command, cwd, execId }: { command: string; cwd?: string; execId?: string }) => {
      log.info("IPC shell:exec", { command: command.slice(0, 80) });
      return execShellCommand(command, cwd, (chunk) => {
        if (!win.isDestroyed() && execId) {
          win.webContents.send("shell:chunk", { id: execId, chunk });
        }
      });
    }
  );

  // ── shell:info (terminal panel metadata) ──────────────────
  ipcMain.handle("shell:info", () => ({
    ok: true,
    data: { shell: SHELL_BIN, cwd: os.homedir() },
  }));

  // ── config:open / config:get ──────────────────────────────
  ipcMain.handle("config:open", () => {
    const cfg = getConfig();
    const configPath = getConfigPath();
    // If file doesn't exist yet, create a template so the user can edit it
    if (!fs.existsSync(configPath)) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, CONFIG_TEMPLATE, "utf8");
    }
    void shell.openPath(configPath);
    return { ok: true, data: { model: cfg.llm.model, provider: cfg.llm.provider } };
  });

  ipcMain.handle("config:get", () => {
    const cfg = getConfig();
    const configFilePath = getConfigPath();
    const configExists   = fs.existsSync(configFilePath);
    return {
      ok: true,
      data: {
        model:        cfg.llm.model,
        provider:     cfg.llm.provider,
        baseUrl:      cfg.llm.base_url,
        maxTokens:    cfg.llm.max_tokens,
        maxIter:      cfg.agent.max_iterations,
        skillsPaths:  cfg.skills.paths,
        dbPath:       cfg.memory.db_path,
        maxContext:   cfg.memory.max_context_messages,
        logLevel:     cfg.logging.level,
        configPath:   configFilePath,
        configExists,
        homeDir:      os.homedir(),
      },
    };
  });

  log.info("IPC handlers registered");
}

export function unregisterIpcHandlers(): void {
  setLogSink(null);
  [
    "agent:run", "agent:abort",
    "session:new", "session:list", "session:delete", "session:messages",
    "cron:list", "cron:toggle", "cron:delete",
    "memory:list", "memory:get", "memory:set", "memory:delete",
    "analytics:stats", "skills:list", "logs:history",
    "config:open", "config:get",
    "shell:exec", "shell:info",
  ].forEach((ch) => ipcMain.removeHandler(ch));
}
