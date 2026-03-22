import type { AgentOutput } from "@claw/agent";

// ── Result monad ─────────────────────────────────────────────
export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;

export function ok<T>(data: T): Ok<T> { return { ok: true, data }; }
export function err(error: string): Err { return { ok: false, error }; }

// ── Gateway public API ────────────────────────────────────────

/** Inbound command from app/main via IPC */
export interface GatewayCommand {
  input: string;
  sessionId: string;
  /** app/main wires this to win.webContents.send('agent:progress', …) */
  onProgress?: (step: string, message: string) => void;
  /** app/main wires this to win.webContents.send('agent:token', …) */
  onToken?: (token: string) => void;
}

export type GatewayResult = Result<AgentOutput>;

/** Gateway lifecycle state */
export type GatewayStatus = "stopped" | "starting" | "ready" | "error";

export interface GatewayState {
  status: GatewayStatus;
  error?: string;
}

// Re-export agent output for convenience
export type { AgentOutput };
