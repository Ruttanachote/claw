// Shared types exported by @claw/memory

// ── Result monad ─────────────────────────────────────────────
export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data };
}

export function err(error: string): Err {
  return { ok: false, error };
}

// ── Domain models ────────────────────────────────────────────
export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export type MessageRole = "user" | "assistant" | "tool";

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: number;
}

export interface Memory {
  key: string;
  value: string;
  updatedAt: number;
}

export interface CronJob {
  id: string;
  name: string;
  expression: string;
  skillName: string;
  inputs: Record<string, unknown>;
  enabled: boolean;
  lastRun: number | null;
}

// ── Config ───────────────────────────────────────────────────
export interface ClawConfig {
  llm: {
    provider: string;
    base_url: string;
    api_key: string;
    model: string;
    max_tokens: number;
  };
  agent: {
    orchestrator_model: string;
    sub_agent_model: string;
    max_iterations: number;
  };
  browser: {
    headless: boolean;
    executable_path: string;
  };
  memory: {
    db_path: string;
    max_context_messages: number;
  };
  skills: {
    paths: string[];
  };
  logging: {
    dir: string;
    level: "debug" | "info" | "warn" | "error";
  };
}
