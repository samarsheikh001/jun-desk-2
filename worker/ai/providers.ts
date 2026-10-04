import { ChatGPTProvider, LlmError, OpenAIProvider, parseSse, type GenerateRequest, type LlmProvider, type StreamEvent } from "@jun/llm";

export type ProviderId = "openai" | "workers-ai" | "chatgpt";

export interface AiSettings {
  enabled: boolean;
  provider: ProviderId;
  model: string | null;
  instructions: string;
  monthlyReplyCap: number;
}

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  openai: "gpt-6.1-sol",
  "workers-ai": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  chatgpt: "gpt-6.1-sol",
};

export async function loadAiSettings(env: Env, workspaceId: string): Promise<AiSettings> {
  const row = await env.DB.prepare("SELECT enabled, provider, model, instructions, monthly_reply_cap FROM ai_settings WHERE workspace_id = ?")
    .bind(workspaceId)
    .first<{ enabled: number; provider: ProviderId; model: string | null; instructions: string; monthly_reply_cap: number }>();
  return {
    enabled: row?.enabled === 1,
    provider: row?.provider ?? "workers-ai",
    model: row?.model ?? null,
    instructions: row?.instructions ?? "",
    monthlyReplyCap: row?.monthly_reply_cap ?? 2000,
  };
}

/**
 * "Sign in with ChatGPT" is development-only (D-10): OpenAI allows plan usage for
 * open-source apps running locally. It's off unless JUN_DEV_CHATGPT=1 and the request
 * comes to a loopback host.
 */
export function devChatGPTAllowed(env: Env, hostname?: string): boolean {
  const enabled = (env as unknown as { JUN_DEV_CHATGPT?: string }).JUN_DEV_CHATGPT === "1";
  return enabled && (hostname === undefined || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]");
}

/** Workers AI chat models, streaming (SSE). Works with no API key: the zero-setup default. */
export class WorkersAIProvider implements LlmProvider {
  readonly id = "workers-ai";
  readonly #ai: Ai;
  readonly #model: string;

  constructor(ai: Ai, model: string) {
    this.#ai = ai;
    this.#model = model;
  }

  async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
    const messages = [
      ...(request.instructions ? [{ role: "system", content: request.instructions }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ];
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = (await this.#ai.run(this.#model as never, { messages, stream: true, max_tokens: 1200 } as never)) as ReadableStream<Uint8Array>;
    } catch (error) {
      throw new LlmError(`Workers AI: ${(error as Error).message}`, { code: "unavailable", retryable: true });
    }
    let text = "";
    let usage: unknown;
    for await (const message of parseSse(stream)) {
      if (message.data === "[DONE]") break;
      let payload: { response?: string | number; usage?: unknown; choices?: { delta?: { content?: string | number | null }; text?: string }[] };
      try {
        payload = JSON.parse(message.data);
      } catch {
        continue;
      }
      // Older models stream {response}; OpenAI-compatible ones stream chat-completion chunks.
      // Tokens can arrive as JSON numbers (a "0" token is the number 0), so stringify, don't truthy-check.
      const raw = payload.response ?? payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.text;
      const delta = raw == null ? "" : String(raw);
      if (payload.usage) usage = payload.usage;
      if (delta) {
        text += delta;
        yield { type: "text-delta", text: delta };
      }
    }
    yield { type: "done", text, ...(usage ? { usage } : {}) };
  }
}

export class AiUnavailableError extends Error {}

export function createProvider(env: Env, workspaceId: string, settings: AiSettings): LlmProvider {
  const model = settings.model || DEFAULT_MODELS[settings.provider];
  if (settings.provider === "workers-ai") return new WorkersAIProvider(env.AI, model);
  if (settings.provider === "openai") {
    const apiKey = (env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY;
    if (!apiKey) throw new AiUnavailableError("OPENAI_API_KEY isn't set. Add it as a Worker secret.");
    const baseUrl = (env as unknown as { OPENAI_BASE_URL?: string }).OPENAI_BASE_URL;
    return new OpenAIProvider({ apiKey, model, ...(baseUrl ? { baseUrl } : {}) });
  }
  if (!devChatGPTAllowed(env)) throw new AiUnavailableError("Sign in with ChatGPT is development-only (set JUN_DEV_CHATGPT=1 locally).");
  // Token refresh happens in the workspace's hub object, so rotation is never raced.
  const hub = env.WORKSPACE_HUB.getByName(workspaceId);
  return new ChatGPTProvider({ getAccessToken: (options) => hub.chatgptAccessToken(workspaceId, Boolean(options?.forceRefresh)) }, { model });
}
