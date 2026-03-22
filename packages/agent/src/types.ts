import type { Message } from "@claw/memory";

// ── Result monad ─────────────────────────────────────────────
export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;

export function ok<T>(data: T): Ok<T> { return { ok: true, data }; }
export function err(error: string): Err { return { ok: false, error }; }

// ── Agent public API ──────────────────────────────────────────
export interface AgentInput {
  sessionId: string;
  userMessage: string;
  /** Called on each loop iteration so caller can stream progress to UI */
  onProgress?: (step: string, message: string) => void;
  /** Called for each streaming token from the LLM (final answer only) */
  onToken?: (token: string) => void;
  /** Signal to abort the agent loop mid-run */
  abortSignal?: AbortSignal;
}

export interface AgentOutput {
  sessionId: string;
  answer: string;
  toolsUsed: string[];
  iterations: number;
}

export type AgentResult = Result<AgentOutput>;

// ── Internal loop state ───────────────────────────────────────
export interface LoopState {
  sessionId: string;
  messages: LLMMessage[];       // running conversation sent to LLM
  toolsUsed: string[];
  iterations: number;
  onProgress: (step: string, msg: string) => void;
}

// ── LLM message shapes (OpenAI-compatible) ────────────────────
export interface LLMSystemMessage {
  role: "system";
  content: string;
}

export interface LLMUserMessage {
  role: "user";
  content: string;
}

export interface LLMAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: LLMToolCall[];
}

export interface LLMToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type LLMMessage =
  | LLMSystemMessage
  | LLMUserMessage
  | LLMAssistantMessage
  | LLMToolResultMessage;

// ── Tool calling ──────────────────────────────────────────────
export interface LLMToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

// Re-export Message for gateway use
export type { Message };
