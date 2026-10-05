import { createOpenAI } from "@ai-sdk/openai";
import { OPENAI_API_BASE } from "@jun/llm";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { dedupedAi } from "./workers-ai.ts";

type ProviderOptions = Record<string, Record<string, string | number | boolean | null>>;

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
  // Fast, follows the rules and calls tools well (scripts/bench-models.ts, 2026-10-05).
  "workers-ai": "@cf/mistralai/mistral-small-3.1-24b-instruct",
  // The plan's small, fast model (`jun models` lists what the plan offers; user's pick, 2026-10-05).
  chatgpt: "gpt-5.6-luna",
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

/** Sign in with ChatGPT (D-27) spends the signed-in owner's plan; this private desk always offers it. */
export function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export class AiUnavailableError extends Error {}

/** A chat model plus how this provider wants the system prompt delivered. */
export interface AgentModel {
  provider: ProviderId;
  modelId: string;
  model: LanguageModel;
  /** Call options carrying `system` (ChatGPT plan usage rejects system messages, so it goes in `instructions`). */
  prompt(system: string): { system?: string; providerOptions?: ProviderOptions };
}

export function createModel(env: Env, workspaceId: string, settings: AiSettings): AgentModel {
  const modelId = settings.model || DEFAULT_MODELS[settings.provider];
  const plain = (model: LanguageModel): AgentModel => ({ provider: settings.provider, modelId, model, prompt: (system) => ({ system }) });

  if (settings.provider === "workers-ai") {
    // dedupedAi: see workers-ai.ts (Workers AI streams text and tool calls twice).
    return plain(createWorkersAI({ binding: dedupedAi(env.AI) })(modelId));
  }
  if (settings.provider === "openai") {
    const apiKey = (env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY;
    if (!apiKey) throw new AiUnavailableError("OPENAI_API_KEY isn't set. Add it as a Worker secret.");
    const baseURL = (env as unknown as { OPENAI_BASE_URL?: string }).OPENAI_BASE_URL;
    return {
      ...plain(createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })(modelId)),
      prompt: (system) => ({ system, providerOptions: { openai: { store: false } } }),
    };
  }
  // Token refresh happens in the workspace's hub object, so rotation is never raced.
  const hub = env.WORKSPACE_HUB.getByName(workspaceId);
  const chatgptFetch: typeof fetch = async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const token = await hub.chatgptAccessToken(workspaceId, attempt > 0);
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      const response = await fetch(input, { ...init, headers });
      // A plain 401 may just be a stale access token: refresh once and retry.
      if (response.status !== 401 || attempt > 0) return response;
    }
  };
  const openai = createOpenAI({ apiKey: "chatgpt-plan", baseURL: OPENAI_API_BASE, fetch: chatgptFetch });
  return {
    provider: "chatgpt",
    modelId,
    model: openai(modelId),
    prompt: (system) => ({ providerOptions: { openai: { instructions: system, store: false } } }),
  };
}
