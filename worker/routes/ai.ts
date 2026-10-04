import { chatgptOAuth as oauth, tokensFromResponse, type ChatGPTCredentials } from "@jun/llm";
import { Hono } from "hono";
import { deleteSource, DEFAULT_MAX_PAGES, indexSnippet, startSync } from "../ai/knowledge.ts";
import { DEFAULT_MODELS, devChatGPTAllowed, loadAiSettings, type ProviderId } from "../ai/providers.ts";
import { searchKnowledge } from "../ai/search.ts";
import { requireUser } from "../auth/session.ts";
import { newId } from "../lib/crypto.ts";
import { readJson, text } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv, type Role } from "../types.ts";

async function memberRole(c: AppContext, workspaceId: string): Promise<Role> {
  const row = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first<{ role: Role }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  return row.role;
}

async function requireAdmin(c: AppContext, workspaceId: string): Promise<void> {
  if ((await memberRole(c, workspaceId)) === "agent") throw new HttpError(403, "forbidden", "Only owners and admins can change this.");
}

const PROVIDERS: ProviderId[] = ["openai", "workers-ai", "chatgpt"];

export const ai = new Hono<AppEnv>();
ai.use("/workspaces/:id/ai", requireUser);
ai.use("/workspaces/:id/ai/*", requireUser);
ai.use("/workspaces/:id/knowledge", requireUser);
ai.use("/workspaces/:id/knowledge/*", requireUser);

// ---------- AI settings (T-10, AI-07, B-03) ----------

ai.get("/workspaces/:id/ai", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const settings = await loadAiSettings(c.env, workspaceId);
  const month = new Date().toISOString().slice(0, 7);
  const usage = await c.env.DB.prepare("SELECT replies, input_tokens AS inputTokens, output_tokens AS outputTokens FROM ai_usage WHERE workspace_id = ? AND month = ?")
    .bind(workspaceId, month)
    .first();
  const chatgpt = await c.env.DB.prepare("SELECT credentials FROM dev_chatgpt WHERE workspace_id = ?").bind(workspaceId).first<{ credentials: string }>();
  const creds = chatgpt ? (JSON.parse(chatgpt.credentials) as ChatGPTCredentials) : undefined;
  return c.json({
    settings,
    defaults: DEFAULT_MODELS,
    openaiKeyConfigured: Boolean((c.env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY),
    devChatgpt: {
      available: devChatGPTAllowed(c.env, new URL(c.req.url).hostname),
      connected: Boolean(creds?.tokens),
      email: creds?.tokens?.email ?? null,
    },
    usage: { month, replies: 0, inputTokens: 0, outputTokens: 0, ...(usage ?? {}) },
  });
});

ai.put("/workspaces/:id/ai", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  const provider = String(body.provider ?? "workers-ai") as ProviderId;
  if (!PROVIDERS.includes(provider)) throw new HttpError(400, "invalid_field", "Unknown provider.");
  const cap = Number(body.monthlyReplyCap ?? 2000);
  if (!Number.isInteger(cap) || cap < 0 || cap > 1_000_000) throw new HttpError(400, "invalid_field", "Monthly cap must be a whole number.");
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim().slice(0, 100) : null;
  const instructions = typeof body.instructions === "string" ? body.instructions.slice(0, 4000) : "";

  await c.env.DB.prepare(
    `INSERT INTO ai_settings (workspace_id, enabled, provider, model, instructions, monthly_reply_cap, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET enabled = excluded.enabled, provider = excluded.provider, model = excluded.model,
       instructions = excluded.instructions, monthly_reply_cap = excluded.monthly_reply_cap, updated_at = excluded.updated_at`,
  )
    .bind(workspaceId, body.enabled ? 1 : 0, provider, model, instructions, cap, Date.now())
    .run();
  return c.json({ settings: await loadAiSettings(c.env, workspaceId) });
});

// ---------- dev-only Sign in with ChatGPT (D-10) ----------

ai.post("/workspaces/:id/ai/chatgpt/start", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const url = new URL(c.req.url);
  if (!devChatGPTAllowed(c.env, url.hostname)) {
    throw new HttpError(403, "dev_only", "Sign in with ChatGPT is for local development only (JUN_DEV_CHATGPT=1 on localhost).");
  }

  // OpenAI's open-source flow requires a 127.0.0.1 loopback redirect; only the port may vary.
  const redirectUri = `http://127.0.0.1:${url.port || "80"}${oauth.CALLBACK_PATH}`;
  const row = await c.env.DB.prepare("SELECT credentials FROM dev_chatgpt WHERE workspace_id = ?").bind(workspaceId).first<{ credentials: string }>();
  let creds = row ? (JSON.parse(row.credentials) as ChatGPTCredentials) : undefined;
  if (!creds) {
    // The host id must be saved before the first sign-in.
    creds = { hostId: oauth.newHostId() };
    await c.env.DB.prepare("INSERT INTO dev_chatgpt (workspace_id, credentials) VALUES (?, ?)").bind(workspaceId, JSON.stringify(creds)).run();
  }

  const state = oauth.randomToken();
  const nonce = oauth.randomToken();
  const codeVerifier = oauth.randomToken(48);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM dev_chatgpt_states WHERE expires_at < ?").bind(Date.now()),
    c.env.DB.prepare(
      "INSERT INTO dev_chatgpt_states (state, workspace_id, code_verifier, nonce, redirect_uri, return_to, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(state, workspaceId, codeVerifier, nonce, redirectUri, `${url.origin}/settings`, Date.now() + 10 * 60 * 1000),
  ]);
  return c.json({
    url: oauth.buildAuthorizeUrl({
      clientId: creds.clientId,
      hostId: creds.hostId,
      redirectUri,
      state,
      nonce,
      codeChallenge: await oauth.pkceChallenge(codeVerifier),
      idTokenHint: creds.tokens?.idToken,
    }),
  });
});

ai.delete("/workspaces/:id/ai/chatgpt", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const row = await c.env.DB.prepare("SELECT credentials FROM dev_chatgpt WHERE workspace_id = ?").bind(workspaceId).first<{ credentials: string }>();
  if (row) {
    const creds = JSON.parse(row.credentials) as ChatGPTCredentials;
    if (creds.clientId && creds.tokens) await oauth.revokeToken({ clientId: creds.clientId, token: creds.tokens.refreshToken }).catch(() => {});
    // Keep the host and client ids for the next sign-in, as the docs ask.
    await c.env.DB.prepare("UPDATE dev_chatgpt SET credentials = ? WHERE workspace_id = ?")
      .bind(JSON.stringify({ hostId: creds.hostId, clientId: creds.clientId }), workspaceId)
      .run();
  }
  await c.env.WORKSPACE_HUB.getByName(workspaceId).resetChatGPT();
  return c.json({ ok: true });
});

/** GET /auth/callback on 127.0.0.1 (outside /api): finishes the dev ChatGPT sign-in. */
export async function handleChatGPTCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const page = (title: string, body: string, status = 400) =>
    new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h1>${title}</h1><p>${body}</p>`, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  if (!devChatGPTAllowed(env, url.hostname)) return page("Not available", "Sign in with ChatGPT is for local development only.", 404);

  const stateRow = await env.DB.prepare("DELETE FROM dev_chatgpt_states WHERE state = ? AND expires_at > ? RETURNING workspace_id, code_verifier, nonce, redirect_uri, return_to")
    .bind(url.searchParams.get("state") ?? "", Date.now())
    .first<{ workspace_id: string; code_verifier: string; nonce: string; redirect_uri: string; return_to: string }>();
  if (!stateRow) return page("Sign-in expired", "This sign-in link is old or was already used. Start again from Settings.");
  const error = url.searchParams.get("error");
  if (error) return page("Sign-in failed", `${error} ${url.searchParams.get("error_description") ?? ""}`.replace(/</g, "&lt;"));

  const row = await env.DB.prepare("SELECT credentials FROM dev_chatgpt WHERE workspace_id = ?").bind(stateRow.workspace_id).first<{ credentials: string }>();
  const existing = row ? (JSON.parse(row.credentials) as ChatGPTCredentials) : undefined;
  const clientId = url.searchParams.get("client_id") ?? existing?.clientId;
  const code = url.searchParams.get("code");
  if (!existing || !clientId || clientId === oauth.REGISTRATION_CLIENT_ID || !code) return page("Sign-in failed", "The callback was missing the code or client id.");

  try {
    const response = await oauth.exchangeCode({ clientId, code, codeVerifier: stateRow.code_verifier, redirectUri: stateRow.redirect_uri });
    if (!response.id_token) throw new Error("No id_token in the token response.");
    await oauth.verifyIdToken(response.id_token, { clientId, nonce: stateRow.nonce });
    const creds: ChatGPTCredentials = { hostId: existing.hostId, clientId, tokens: tokensFromResponse(response) };
    await env.DB.batch([
      env.DB.prepare("UPDATE dev_chatgpt SET credentials = ? WHERE workspace_id = ?").bind(JSON.stringify(creds), stateRow.workspace_id),
      env.DB.prepare(
        `INSERT INTO ai_settings (workspace_id, enabled, provider, updated_at) VALUES (?, 1, 'chatgpt', ?)
         ON CONFLICT (workspace_id) DO UPDATE SET provider = 'chatgpt', updated_at = excluded.updated_at`,
      ).bind(stateRow.workspace_id, Date.now()),
    ]);
    await env.WORKSPACE_HUB.getByName(stateRow.workspace_id).resetChatGPT();
  } catch (e) {
    return page("Sign-in failed", String((e as Error).message).replace(/</g, "&lt;"));
  }
  return Response.redirect(`${stateRow.return_to}?chatgpt=connected`, 302);
}

// ---------- knowledge base (K-01, K-03, K-04 lite) ----------

ai.get("/workspaces/:id/knowledge", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const rows = await c.env.DB.prepare(
    `SELECT id, kind, url, title, status, page_count AS pageCount, pending_jobs AS pendingJobs, error, last_synced_at AS lastSyncedAt, created_at AS createdAt,
            (SELECT COUNT(*) FROM kb_chunks k WHERE k.source_id = s.id) AS chunkCount
     FROM kb_sources s WHERE workspace_id = ? ORDER BY created_at DESC`,
  )
    .bind(workspaceId)
    .all();
  return c.json({ sources: rows.results });
});

ai.post("/workspaces/:id/knowledge/websites", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  let url: URL;
  try {
    url = new URL(text(body, "url", { max: 2000 }));
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
  } catch {
    throw new HttpError(400, "invalid_field", "Enter a full URL, like https://docs.example.com.");
  }
  const maxPages = Math.min(Math.max(Number(body.maxPages ?? DEFAULT_MAX_PAGES) || DEFAULT_MAX_PAGES, 1), 2000);
  const id = newId("src");
  await c.env.DB.prepare("INSERT INTO kb_sources (id, workspace_id, kind, url, title, settings, created_at) VALUES (?, ?, 'website', ?, ?, ?, ?)")
    .bind(id, workspaceId, url.toString(), url.host + (url.pathname === "/" ? "" : url.pathname), JSON.stringify({ maxPages }), Date.now())
    .run();
  await startSync(c.env, id);
  return c.json({ id });
});

ai.post("/workspaces/:id/knowledge/snippets", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  const id = newId("src");
  await c.env.DB.prepare("INSERT INTO kb_sources (id, workspace_id, kind, title, body, created_at) VALUES (?, ?, 'snippet', ?, ?, ?)")
    .bind(id, workspaceId, text(body, "title", { max: 200 }), text(body, "body", { max: 20_000 }), Date.now())
    .run();
  await indexSnippet(c.env, id);
  return c.json({ id });
});

ai.post("/workspaces/:id/knowledge/:sourceId/sync", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const source = await c.env.DB.prepare("SELECT kind FROM kb_sources WHERE id = ? AND workspace_id = ?").bind(c.req.param("sourceId"), workspaceId).first<{ kind: string }>();
  if (!source) throw new HttpError(404, "not_found", "Source not found.");
  if (source.kind === "website") await startSync(c.env, c.req.param("sourceId"));
  else await indexSnippet(c.env, c.req.param("sourceId"));
  return c.json({ ok: true });
});

ai.delete("/workspaces/:id/knowledge/:sourceId", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  await deleteSource(c.env, workspaceId, c.req.param("sourceId"));
  return c.json({ ok: true });
});

// "Test a question": see exactly what the AI would get as sources.
ai.post("/workspaces/:id/knowledge/search", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const body = await readJson(c.req);
  return c.json({ hits: await searchKnowledge(c.env, workspaceId, text(body, "query", { max: 1000 })) });
});
