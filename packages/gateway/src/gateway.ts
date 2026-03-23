import {
  loadConfig,
  initDb,
  initLogger,
  closeDb,
  listSessions,
  ensureSession,
  deleteSession,
  createLogger,
} from "@claw/memory";
import type { Session } from "@claw/memory";
import { initLLM, runAgent } from "@claw/agent";
import type {
  GatewayCommand,
  GatewayResult,
  GatewayState,
  Result,
} from "./types.js";
import { ok, err } from "./types.js";

const log = createLogger("gateway");

// ── Singleton state ───────────────────────────────────────────
const state: GatewayState = { status: "stopped" };

// ── Abort controller for the current run ─────────────────────
let _currentAbort: AbortController | null = null;

export function abortCurrentRun(): void {
  _currentAbort?.abort();
  _currentAbort = null;
}

// ── Init ──────────────────────────────────────────────────────
/**
 * initGateway() must be called once at app startup (app/main).
 * It:
 *  1. Loads claw.config.toml
 *  2. Starts the logger
 *  3. Initialises SQLite DB
 *  4. Initialises the LLM client
 */
export async function initGateway(configPath?: string): Promise<Result<void>> {
  if (state.status === "ready") return ok(undefined);
  state.status = "starting";

  // 1. Config
  const cfgResult = loadConfig(configPath);
  if (!cfgResult.ok) {
    state.status = "error";
    state.error = cfgResult.error;
    return cfgResult;
  }
  const config = cfgResult.data;

  // 2. Logger
  initLogger(config.logging.dir, config.logging.level);
  log.info("Gateway starting…", { version: "0.1.0" });

  // 3. Database
  const dbResult = initDb(config.memory.db_path);
  if (!dbResult.ok) {
    state.status = "error";
    state.error = dbResult.error;
    log.error("DB init failed", { error: dbResult.error });
    return dbResult;
  }

  // 4. LLM client
  try {
    initLLM(config.llm);
  } catch (e) {
    const msg = `LLM init failed: ${String(e)}`;
    state.status = "error";
    state.error = msg;
    log.error(msg);
    return err(msg);
  }

  state.status = "ready";
  log.info("Gateway ready", {
    db: config.memory.db_path,
    model: config.llm.model,
  });
  return ok(undefined);
}

// ── Shutdown ──────────────────────────────────────────────────
export async function shutdownGateway(): Promise<Result<void>> {
  log.info("Gateway shutting down…");
  const result = closeDb();
  state.status = "stopped";
  return result;
}

// ── Handle a command ──────────────────────────────────────────
/**
 * handleCommand is the single entry point called by app/main ipcMain handlers.
 * It is intentionally synchronous-feeling from the caller's side — returns
 * a Promise<GatewayResult> that resolves when the agent is done.
 */
export async function handleCommand(
  cmd: GatewayCommand
): Promise<GatewayResult> {
  if (state.status !== "ready") {
    return err(
      `Gateway is not ready (status: ${state.status}). ` +
        "Call initGateway() first."
    );
  }

  if (!cmd.input.trim()) {
    return err("Empty input — nothing to do.");
  }

  log.info("handleCommand", {
    sessionId: cmd.sessionId,
    inputLength: cmd.input.length,
  });

  _currentAbort = new AbortController();

  const agentInput = {
    sessionId:    cmd.sessionId,
    userMessage:  cmd.input,
    abortSignal:  _currentAbort.signal,
    ...(cmd.onProgress    ? { onProgress: cmd.onProgress }       : {}),
    ...(cmd.onToken       ? { onToken: cmd.onToken }             : {}),
    ...(cmd.capturePanel  ? { capturePanel: cmd.capturePanel }   : {}),
    ...(cmd.panelBrowser  ? { panelBrowser: cmd.panelBrowser }   : {}),
  };

  const result = await runAgent(agentInput);
  _currentAbort = null;

  if (!result.ok) {
    log.error("Agent error", { error: result.error, sessionId: cmd.sessionId });
  } else {
    log.info("Agent done", {
      sessionId: cmd.sessionId,
      iterations: result.data.iterations,
      toolsUsed: result.data.toolsUsed,
    });
  }

  return result;
}

// ── Gateway status ────────────────────────────────────────────
export function getGatewayStatus(): GatewayState {
  return { ...state };
}

// ── Session helpers (used by IPC handlers in app/main) ────────
export function listRecentSessions(limit = 20): Result<Session[]> {
  return listSessions(limit);
}

export function newSession(): Result<Session> {
  return ensureSession();
}

export function removeSession(id: string): Result<void> {
  return deleteSession(id);
}
