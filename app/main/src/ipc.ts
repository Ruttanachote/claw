import { ipcMain, shell, webContents } from "electron";
import type { BrowserWindow } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as http from "http";

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

// ── Panel webview registry + PanelBrowser ────────────────────
let _panelWebviewId: number | null = null;
let _mainWin: BrowserWindow | null = null;

/** Fetch all CDP targets exposed on port 9222 */
async function fetchCdpTargets(): Promise<Array<{ type: string; url: string; webSocketDebuggerUrl: string }>> {
  return new Promise((resolve) => {
    http.get("http://127.0.0.1:9222/json", (res) => {
      let raw = "";
      res.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
      res.on("end", () => {
        try { resolve(JSON.parse(raw) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>); }
        catch { resolve([]); }
      });
    }).on("error", () => resolve([]));
  });
}

function getPanelWC() {
  if (_panelWebviewId === null) return null;
  const wc = webContents.fromId(_panelWebviewId);
  return wc && !wc.isDestroyed() ? wc : null;
}

async function capturePanel() {
  const wc = getPanelWC();
  if (!wc) return { ok: false as const, error: "Browser panel not available" };
  try {
    const image = await wc.capturePage();
    return {
      ok: true as const,
      data: { base64: image.toPNG().toString("base64"), url: wc.getURL(), mimeType: "image/png" },
    };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

// PanelBrowser — controls the visible webview from main process
export const panelBrowser = {
  isAvailable: () => getPanelWC() !== null,

  async navigate(url: string) {
    const wc = getPanelWC();
    if (!wc) return { ok: false as const, error: "Browser panel not available" };
    // Tell renderer to show the pane + update URL bar
    _mainWin?.webContents.send("browser:panel-show", url);
    try {
      await wc.loadURL(url);
      return { ok: true as const, data: { url: wc.getURL(), title: wc.getTitle() } };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  },

  async screenshot() {
    const wc = getPanelWC();
    if (wc) _mainWin?.webContents.send("browser:panel-show", wc.getURL());
    return capturePanel();
  },

  async snapshot() {
    const wc = getPanelWC();
    if (!wc) return { ok: false as const, error: "Browser panel not available" };
    _mainWin?.webContents.send("browser:panel-show", wc.getURL());
    try {
      const raw = await wc.executeJavaScript(`JSON.stringify({
        url: location.href,
        title: document.title,
        textContent: (document.body?.innerText || '').slice(0, 3000),
        elements: Array.from(document.querySelectorAll('a,button,input,select,textarea,h1,h2,h3,h4'))
          .slice(0, 40)
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().slice(0, 100),
            href: el.getAttribute('href') || '',
            type: el.getAttribute('type') || '',
            id: el.id || '',
            className: (el.className || '').toString().slice(0, 60)
          }))
      })`);
      return { ok: true as const, data: JSON.parse(raw as string) };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  },

  async click(selector: string) {
    const wc = getPanelWC();
    if (!wc) return { ok: false as const, error: "Browser panel not available" };
    _mainWin?.webContents.send("browser:panel-show", wc.getURL());
    try {
      await wc.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if(el){ el.click(); return true; } return false; })()`
      );
      return { ok: true as const, data: `Clicked: ${selector}` };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  },

  async type(selector: string, text: string) {
    const wc = getPanelWC();
    if (!wc) return { ok: false as const, error: "Browser panel not available" };
    _mainWin?.webContents.send("browser:panel-show", wc.getURL());
    try {
      await wc.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if(el){ el.focus(); el.value=${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; } return false; })()`
      );
      return { ok: true as const, data: `Typed into ${selector}` };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  },

  async executeJs(code: string) {
    const wc = getPanelWC();
    if (!wc) return { ok: false as const, error: "Browser panel not available" };
    _mainWin?.webContents.send("browser:panel-show", wc.getURL());
    try {
      const result = await wc.executeJavaScript(code);
      const resultStr = result === undefined ? "undefined" :
        typeof result === "object" ? JSON.stringify(result) : String(result);
      return { ok: true as const, data: resultStr };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  },

  // ── Show the panel (used by browser_agent before delegating) ─
  show() {
    const wc = getPanelWC();
    _mainWin?.webContents.send("browser:panel-show", wc?.getURL() ?? "");
  },

  // ── Get the CDP WebSocket URL of this webview ─────────────────
  // Queries localhost:9222/json and finds the target matching the current URL.
  async getCdpUrl(): Promise<string | null> {
    const wc = getPanelWC();
    if (!wc) return null;
    const panelUrl = wc.getURL();
    if (!panelUrl || panelUrl === "about:blank") return null;
    try {
      const targets = await fetchCdpTargets();
      const target = targets.find(t => t.type === "page" && t.url === panelUrl);
      return target?.webSocketDebuggerUrl ?? null;
    } catch {
      return null;
    }
  },
};

export function registerIpcHandlers(win: BrowserWindow): void {
  _mainWin = win;

  // ── Live log streaming ─────────────────────────────────────
  setLogSink((entry: LogEntry) => {
    if (!win.isDestroyed()) {
      win.webContents.send("log:entry", entry);
    }
  });

  // ── browser:register-panel (renderer tells us the webview ID) ──
  ipcMain.handle("browser:register-panel", (_e, id: number) => {
    _panelWebviewId = id;
    log.info("Panel webview registered", { webContentsId: id });
    return { ok: true };
  });

  // ── agent:run ─────────────────────────────────────────────
  ipcMain.handle(
    "agent:run",
    async (_e, { input, sessionId }: { input: string; sessionId: string }) => {
      log.info("IPC agent:run", { sessionId, inputLen: input.length });
      return handleCommand({
        input,
        sessionId,
        onProgress:   (step, message) => sendProgress(win, step, message),
        onToken:      (token)         => win.webContents.send("agent:token", token),
        capturePanel,
        panelBrowser,
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

  // ── shell:openExternal (open URLs / files in system browser or Finder) ──
  ipcMain.handle("shell:openExternal", (_e, url: string) => {
    // Local paths (Unix, home-relative, Windows) → openPath (works for files & folders)
    if (/^\/|^~\/|^[A-Za-z]:[/\\]/.test(url)) {
      const expanded = url.startsWith("~/")
        ? path.join(os.homedir(), url.slice(2))
        : url;
      void shell.openPath(expanded);
    } else {
      void shell.openExternal(url);
    }
    return { ok: true };
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
    "shell:exec", "shell:info", "shell:openExternal", "browser:register-panel",
  ].forEach((ch) => ipcMain.removeHandler(ch));
}
