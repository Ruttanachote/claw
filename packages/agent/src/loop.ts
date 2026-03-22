import { readContext, writeMessage, ensureSession, getConfig } from "@claw/memory";
import { loadSkills } from "@claw/skill-runner";
import { createLogger } from "@claw/memory";
import type {
  AgentInput,
  AgentResult,
  LoopState,
  LLMMessage,
  LLMToolResultMessage,
} from "./types.js";
import { ok, err } from "./types.js";
import { callLLM } from "./llm.js";
import { buildSystemPrompt, buildToolDefinitions } from "./prompt.js";
import { dispatchToolCall, buildToolContext } from "./tools.js";
import os from "os";

const log = createLogger("agent:loop");

// ── Main entry point ──────────────────────────────────────────
export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const config = getConfig();

  // ── 1. Ensure session ────────────────────────────────────────
  const sessResult = ensureSession(input.sessionId);
  if (!sessResult.ok) return sessResult;
  const sessionId = sessResult.data.id;

  const onProgress   = input.onProgress ?? ((_step: string, _msg: string) => undefined);
  const onToken      = input.onToken;
  const abortSignal  = input.abortSignal;

  onProgress("init", "Loading skills and context…");
  log.info("runAgent start", { sessionId });

  // ── 2. Load skills ────────────────────────────────────────────
  const skillsResult = loadSkills(config.skills.paths);
  if (!skillsResult.ok) return skillsResult;
  const skills = skillsResult.data;

  // ── 3. Load memory context ────────────────────────────────────
  const contextResult = readContext(sessionId, config.memory.max_context_messages);
  if (!contextResult.ok) return contextResult;

  // ── 4. Build initial LLM messages ────────────────────────────
  // Inject real environment so LLM uses correct absolute paths and shell
  const envCtx = {
    homeDir:  os.homedir(),
    platform: process.platform,
    username: os.userInfo().username,
    shellBin: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
  };

  const state: LoopState = {
    sessionId,
    messages: [
      { role: "system", content: buildSystemPrompt(skills, envCtx) },
      // Inject prior conversation turns (tool messages need tool_call_id — use placeholder)
      ...contextResult.data.flatMap((m): LLMMessage[] => {
        // Skip tool messages from history — they require matching tool_use IDs
        // which are not preserved in storage, and Anthropic rejects orphaned tool_result blocks.
        if (m.role === "tool") return [];
        if (m.role === "assistant") {
          return [{ role: "assistant", content: m.content }];
        }
        return [{ role: "user", content: m.content }];
      }),
      // Append new user message
      { role: "user", content: input.userMessage },
    ],
    toolsUsed: [],
    iterations: 0,
    onProgress,
  };

  // Save user message to memory
  writeMessage({ sessionId, role: "user", content: input.userMessage });

  const toolDefs   = buildToolDefinitions();
  const toolCtx    = buildToolContext(skills, config, sessionId);
  const maxIter    = config.agent.max_iterations;

  // ── 5. Orchestrator loop ──────────────────────────────────────
  let toolCallSeq = 0;   // unique ID per tool call within this run

  while (state.iterations < maxIter) {
    // Check abort before each iteration
    if (abortSignal?.aborted) {
      return err("Aborted");
    }

    state.iterations++;
    onProgress("thinking", `Thinking… (iteration ${state.iterations}/${maxIter})`);
    log.debug("loop iteration", { n: state.iterations });

    // ── LLM call — stream only on iterations that likely produce final answer ──
    // We always pass onToken; callLLM will stream tokens.
    // If tool_calls come back, any streamed tokens are discarded (tool response).
    const llmResult = await callLLM({
      model: config.agent.orchestrator_model,
      messages: state.messages,
      tools: toolDefs,
      maxTokens: config.llm.max_tokens,
      ...(onToken    !== undefined ? { onToken }          : {}),
      ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
    });

    if (!llmResult.ok) return llmResult;
    const assistantMsg = llmResult.data;

    // Append assistant turn to running conversation
    state.messages.push(assistantMsg);

    // ── No tool calls → final answer ────────────────────────────
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      const answer = assistantMsg.content ?? "(no response)";
      log.info("Agent finished", {
        iterations: state.iterations,
        toolsUsed: state.toolsUsed,
      });

      // Save assistant answer to memory
      writeMessage({ sessionId, role: "assistant", content: answer });

      return ok({
        sessionId,
        answer,
        toolsUsed: state.toolsUsed,
        iterations: state.iterations,
      });
    }

    // ── Tool calls → dispatch each ───────────────────────────────
    const toolResults: LLMToolResultMessage[] = [];

    for (const toolCall of assistantMsg.tool_calls) {
      const toolName = toolCall.function.name;
      const toolId   = `t${++toolCallSeq}`;
      log.info("Dispatching tool", { tool: toolName, callId: toolCall.id });

      if (!state.toolsUsed.includes(toolName)) {
        state.toolsUsed.push(toolName);
      }

      // Build a preview string shown in the terminal UI
      let argsPreview = "";
      try {
        const parsedArgs = JSON.parse(toolCall.function.arguments ?? "{}") as Record<string, unknown>;
        if (toolName === "shell") {
          // Show the full shell command
          argsPreview = String(parsedArgs["command"] ?? "").slice(0, 200);
        } else if (toolName === "read_file" || toolName === "write_file" || toolName === "list_dir") {
          argsPreview = String(parsedArgs["path"] ?? "").slice(0, 150);
        } else if (toolName === "memory_read" || toolName === "memory_write") {
          argsPreview = String(parsedArgs["key"] ?? "").slice(0, 80);
        } else if (toolName === "browser") {
          argsPreview = String(parsedArgs["url"] ?? parsedArgs["action"] ?? "").slice(0, 150);
        } else {
          // Generic: first string value
          const firstVal = Object.values(parsedArgs).find(v => typeof v === "string" && v.length > 0);
          argsPreview = String(firstVal ?? "").slice(0, 100);
        }
      } catch { /* ignore */ }

      onProgress("tool_start", JSON.stringify({ id: toolId, name: toolName, preview: argsPreview }));

      // Stream shell stdout/stderr chunks in real-time via progress events
      const onChunk = (chunk: string) => {
        onProgress("tool_chunk", JSON.stringify({ id: toolId, chunk }));
      };

      const dispatchResult = await dispatchToolCall(toolCall, toolCtx, onChunk);

      const resultContent = dispatchResult.ok
        ? dispatchResult.data
        : `ERROR: ${dispatchResult.error}`;

      onProgress("tool_end", JSON.stringify({
        id:     toolId,
        name:   toolName,
        ok:     dispatchResult.ok,
        output: resultContent.slice(0, 800),
      }));

      // Save tool interaction to memory
      writeMessage({
        sessionId,
        role: "tool",
        content: `[${toolName}] ${resultContent.slice(0, 500)}`,
      });

      toolResults.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: resultContent,
      });
    }

    // Append all tool results before next iteration
    state.messages.push(...toolResults);
  }

  // ── Max iterations reached ────────────────────────────────────
  const answer =
    "I reached the maximum number of steps without completing the task. " +
    "Please try rephrasing your request or breaking it into smaller parts.";

  writeMessage({ sessionId, role: "assistant", content: answer });

  return ok({
    sessionId,
    answer,
    toolsUsed: state.toolsUsed,
    iterations: state.iterations,
  });
}
