// @claw/agent — public API
// ONLY package that calls LLM. Uses OpenAI-compatible client for OpenRouter.
// Depends on @claw/memory, @claw/skill-runner, @claw/browser at runtime.

export type {
  Ok,
  Err,
  Result,
  AgentInput,
  AgentOutput,
  AgentResult,
  LLMMessage,
  LLMToolCall,
  Message,
} from "./types.js";

export { ok, err } from "./types.js";

// LLM client — init once at startup from config
export { initLLM } from "./llm.js";

// Main agent entry point
export { runAgent } from "./loop.js";

// Direct shell execution (for terminal panel)
export { execShellCommand, SHELL_BIN } from "./tools.js";
