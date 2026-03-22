import OpenAI from "openai";
import type { ClawConfig } from "@claw/memory";
import type { LLMMessage, LLMAssistantMessage, ToolDefinition, Result } from "./types.js";
import { ok, err } from "./types.js";
import { createLogger } from "@claw/memory";

const log = createLogger("agent:llm");

// Lazily initialised — avoids reading config at import time
let _client: OpenAI | null = null;
let _config: ClawConfig["llm"] | null = null;

export function initLLM(llmConfig: ClawConfig["llm"]): void {
  _config = llmConfig;
  _client = new OpenAI({
    apiKey: llmConfig.api_key,
    baseURL: llmConfig.base_url,
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/claw-agent/claw",
      "X-Title": "Claw Agent",
    },
  });
  log.info("LLM client initialised", { model: llmConfig.model, provider: llmConfig.provider });
}

function getClient(): Result<{ client: OpenAI; config: ClawConfig["llm"] }> {
  if (!_client || !_config) {
    return err("LLM not initialised — call initLLM() first");
  }
  return ok({ client: _client, config: _config });
}

export interface CallLLMOptions {
  model?: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  /** If provided, tokens are streamed via this callback and the result is assembled at the end */
  onToken?: (token: string) => void;
  /** AbortSignal to cancel mid-stream */
  signal?: AbortSignal;
}

export type LLMResponse = Result<LLMAssistantMessage>;

export async function callLLM(options: CallLLMOptions): Promise<LLMResponse> {
  const clientResult = getClient();
  if (!clientResult.ok) return clientResult;
  const { client, config } = clientResult.data;

  const model      = options.model    ?? config.model;
  const maxTokens  = options.maxTokens ?? config.max_tokens;
  const streaming  = !!options.onToken;

  log.debug("callLLM →", {
    model,
    messages: options.messages.length,
    tools: options.tools?.length ?? 0,
    streaming,
  });

  // ── Shared base params ───────────────────────────────────────
  const baseParams = {
    model,
    messages: options.messages as OpenAI.Chat.ChatCompletionMessageParam[],
    max_tokens: maxTokens,
    ...(options.tools && options.tools.length > 0
      ? { tools: options.tools as OpenAI.Chat.ChatCompletionTool[], tool_choice: "auto" as const }
      : {}),
  };

  // ── Streaming path ───────────────────────────────────────────
  if (streaming) {
    try {
      const stream = await client.chat.completions.create(
        { ...baseParams, stream: true },
        { signal: options.signal }
      );

      let contentAccum = "";
      // tool_call accumulators keyed by index
      const toolCallMap = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        if (options.signal?.aborted) {
          return err("Aborted");
        }
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Accumulate content tokens
        if (delta.content) {
          contentAccum += delta.content;
          options.onToken!(delta.content);
        }

        // Accumulate tool_call deltas
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, { id: tc.id ?? "", name: "", args: "" });
            }
            const entry = toolCallMap.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
          }
        }
      }

      const assistantMsg: LLMAssistantMessage = {
        role: "assistant",
        content: contentAccum || null,
      };

      if (toolCallMap.size > 0) {
        assistantMsg.tool_calls = Array.from(toolCallMap.entries())
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.args },
          }));
      }

      log.debug("callLLM (stream) ←", { toolCalls: assistantMsg.tool_calls?.length ?? 0 });
      return ok(assistantMsg);
    } catch (e) {
      if (options.signal?.aborted) return err("Aborted");
      const detail = (e as any)?.error ?? (e as any)?.message ?? String(e);
      const msg = `LLM streaming failed: ${String(e)} | detail: ${JSON.stringify(detail)}`;
      log.error(msg, { status: (e as any)?.status, error: (e as any)?.error });
      return err(msg);
    }
  }

  // ── Non-streaming path ───────────────────────────────────────
  try {
    const completion = await client.chat.completions.create(
      { ...baseParams, stream: false } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      { signal: options.signal }
    );

    const choice = completion.choices[0];
    if (!choice) return err("LLM returned no choices");

    const msg = choice.message;

    const assistantMsg: LLMAssistantMessage = {
      role: "assistant",
      content: msg.content,
    };

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      assistantMsg.tool_calls = msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
    }

    log.debug("callLLM ←", {
      finish_reason: choice.finish_reason,
      promptTokens: completion.usage?.prompt_tokens,
      completionTokens: completion.usage?.completion_tokens,
    });

    return ok(assistantMsg);
  } catch (e) {
    if (options.signal?.aborted) return err("Aborted");
    const msg = `LLM call failed: ${String(e)}`;
    log.error(msg);
    return err(msg);
  }
}
