import type { Message } from "@claw/memory";

// ── Result monad ─────────────────────────────────────────────
export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;

export function ok<T>(data: T): Ok<T> { return { ok: true, data }; }
export function err(error: string): Err { return { ok: false, error }; }

// ── Agent public API ──────────────────────────────────────────
export interface PanelCapture {
  base64: string;
  url: string;
  mimeType: string;
}

type R<T> = Promise<{ ok: true; data: T } | { ok: false; error: string }>;

/** Controls the visible webview panel inside the Electron app */
export interface PanelBrowser {
  isAvailable: () => boolean;
  navigate:    (url: string)                    => R<{ url: string; title: string }>;
  screenshot:  ()                               => R<PanelCapture>;
  snapshot:    ()                               => R<{ url: string; title: string; elements: unknown[]; textContent: string }>;
  click:       (selector: string)               => R<string>;
  type:        (selector: string, text: string) => R<string>;
  executeJs:   (code: string)                   => R<string>;
  /** Open/reveal the panel without navigating */
  show:        () => void;
  /** CDP WebSocket URL of the panel webview — ws://127.0.0.1:9222/devtools/page/... */
  getCdpUrl:   () => Promise<string | null>;
}

export interface AgentInput {
  sessionId: string;
  userMessage: string;
  /** Called on each loop iteration so caller can stream progress to UI */
  onProgress?: (step: string, message: string) => void;
  /** Called for each streaming token from the LLM (final answer only) */
  onToken?: (token: string) => void;
  /** Signal to abort the agent loop mid-run */
  abortSignal?: AbortSignal;
  /** Capture the browser panel webview inside the app */
  capturePanel?: () => Promise<{ ok: true; data: PanelCapture } | { ok: false; error: string }>;
  /** Full control of the visible browser panel webview */
  panelBrowser?: PanelBrowser;
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
