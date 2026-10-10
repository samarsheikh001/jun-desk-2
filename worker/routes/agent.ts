import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { parseConfig, type ConfigFiles } from "../ai/config.ts";
import { ConfigConflictError, listVersions, loadConfigFiles, saveConfig } from "../ai/config-store.ts";
import { DEFAULT_REPLAY_SAMPLE, MAX_REPLAY_SAMPLE, runEval, type EvalEvent } from "../ai/eval.ts";
import { AiUnavailableError, createModel, loadAiSettings } from "../ai/providers.ts";
import { getSessionUser, requireUser } from "../auth/session.ts";
import { newId, randomToken, sha256 } from "../lib/crypto.ts";
import { readJson, text } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv, type Role } from "../types.ts";

// Agent config as code (AI-18) and `jun eval` (AI-19). The `jun` CLI calls these with a
// personal API token (Authorization: Bearer jun_…); the dashboard with its session cookie.

const TOKEN_PREFIX = "jun_";

/** Session cookie, or an API token for this workspace (tokens never work across workspaces). */
const requireUserOrToken = createMiddleware<AppEnv & { Variables: { tokenWorkspace: string | null } }>(async (c, next) => {
  const auth = c.req.header("authorization");
  if (auth?.startsWith(`Bearer ${TOKEN_PREFIX}`)) {
    const hash = await sha256(auth.slice("Bearer ".length).trim());
    const row = await c.env.DB.prepare(
      `SELECT t.id, t.workspace_id, u.id AS user_id, u.name, u.email FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    )
      .bind(hash)
      .first<{ id: string; workspace_id: string; user_id: string; name: string; email: string | null }>();
    if (!row) throw new HttpError(401, "bad_token", "This API token isn't valid. Create a new one in Settings → API tokens.");
    const workspaceId = c.req.param("id");
    if (workspaceId && workspaceId !== row.workspace_id) throw new HttpError(403, "wrong_workspace", "This API token belongs to another workspace.");
    c.set("user", { id: row.user_id, name: row.name, email: row.email });
    c.set("tokenWorkspace", row.workspace_id);
    c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(Date.now(), row.id).run());
    return next();
  }
  const user = await getSessionUser(c as unknown as AppContext);
  if (!user) throw new HttpError(401, "unauthenticated", "Sign in first.");
  c.set("user", user);
  c.set("tokenWorkspace", null);
  await next();
});

async function memberRole(c: AppContext, workspaceId: string): Promise<Role> {
  const row = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first<{ role: Role }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  return row.role;
}

async function requireAdmin(c: AppContext, workspaceId: string): Promise<void> {
  if ((await memberRole(c, workspaceId)) === "agent") throw new HttpError(403, "forbidden", "Only owners and admins can change the agent.");
}

function readFiles(body: Record<string, unknown>): ConfigFiles {
  const files = body.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new HttpError(400, "invalid_field", "files must be an object of path → text.");
  const out: ConfigFiles = {};
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== "string") throw new HttpError(400, "invalid_field", `${path}: file content must be text.`);
    out[path.replace(/\\/g, "/")] = content;
  }
  return out;
}

function summary(files: ConfigFiles) {
  const { config, issues } = parseConfig(files);
  return {
    issues,
    summary: {
      skills: config.skills.map((s) => s.name),
      tools: config.tools.map((t) => t.name),
      widgets: config.widgets.map((w) => w.name),
      evals: config.evals.length,
      maxReplies: config.maxReplies,
      handoffTopics: config.handoffTopics,
    },
  };
}

export const agent = new Hono<AppEnv>();
agent.use("/workspaces/:id/agent", requireUserOrToken);
agent.use("/workspaces/:id/agent/*", requireUserOrToken);
agent.use("/cli/whoami", requireUserOrToken);
agent.use("/workspaces/:id/tokens", requireUser);
agent.use("/workspaces/:id/tokens/*", requireUser);

/** `jun login` checks its token here. */
agent.get("/cli/whoami", async (c) => {
  const workspaceId = (c as unknown as { get(k: "tokenWorkspace"): string | null }).get("tokenWorkspace");
  if (!workspaceId) throw new HttpError(400, "token_required", "Use an API token.");
  const ws = await c.env.DB.prepare("SELECT id, name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ id: string; name: string }>();
  return c.json({ user: c.get("user"), workspace: ws, role: await memberRole(c, workspaceId) });
});

agent.get("/workspaces/:id/agent", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const v = c.req.query("version");
  const stored = await loadConfigFiles(c.env, workspaceId, v ? Number(v) : undefined);
  if (v && stored.version === null) throw new HttpError(404, "not_found", `No version ${v}.`);
  return c.json({ version: stored.version, files: stored.files, ...summary(stored.files), versions: await listVersions(c.env, workspaceId) });
});

agent.post("/workspaces/:id/agent/validate", async (c) => {
  await memberRole(c, c.req.param("id"));
  return c.json(summary(readFiles(await readJson(c.req))));
});

agent.put("/workspaces/:id/agent", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  const files = readFiles(body);
  const base = body.base === null || body.base === undefined ? null : Number(body.base);
  const tokenWorkspace = (c as unknown as { get(k: "tokenWorkspace"): string | null }).get("tokenWorkspace");
  try {
    const result = await saveConfig(c.env, workspaceId, {
      files,
      base,
      force: body.force === true,
      message: text(body, "message", { max: 500, optional: true }),
      source: tokenWorkspace ? "cli" : "dashboard",
      userId: c.get("user").id,
    });
    if (result.version === null) return c.json({ error: { code: "invalid_config", message: "The config has errors.", issues: result.issues } }, 400);
    return c.json({ version: result.version, ...summary(files) });
  } catch (error) {
    if (error instanceof ConfigConflictError) return c.json({ error: { code: "conflict", message: error.message, current: error.current } }, 409);
    throw error;
  }
});

// AI-19: streams NDJSON EvalEvents. Body: { files, sample?, mockTools?, cases?, replay? }.
agent.post("/workspaces/:id/agent/eval", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const body = await readJson(c.req);
  const files = readFiles(body);
  const parsed = parseConfig(files);
  if (parsed.issues.length) return c.json({ error: { code: "invalid_config", message: "Fix the config errors first.", issues: parsed.issues } }, 400);
  const sample = Math.min(Math.max(Number(body.sample ?? DEFAULT_REPLAY_SAMPLE) || 0, 0), MAX_REPLAY_SAMPLE);

  const [settings, liveFiles, workspace] = await Promise.all([
    loadAiSettings(c.env, workspaceId),
    loadConfigFiles(c.env, workspaceId),
    c.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ name: string }>(),
  ]);
  let model, judgeModel;
  try {
    model = createModel(c.env, workspaceId, settings, "answer");
    judgeModel = createModel(c.env, workspaceId, settings, "judge");
  } catch (error) {
    if (error instanceof AiUnavailableError) throw new HttpError(400, "ai_unavailable", error.message);
    throw error;
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const emit = (event: EvalEvent) => void writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).catch(() => {});
  c.executionCtx.waitUntil(
    runEval(
      {
        env: c.env,
        workspaceId,
        workspaceName: workspace?.name ?? "this company",
        model,
        judgeModel,
        live: parseConfig(liveFiles.files, liveFiles.version).config,
        candidate: parsed.config,
        sample,
        mockTools: body.mockTools === true,
      },
      emit,
      { cases: body.cases !== false, replay: body.replay !== false && sample > 0 },
    )
      .catch((error: unknown) => emit({ type: "error", scope: "eval", message: (error as Error).message }))
      .finally(() => writer.close().catch(() => {})),
  );
  return new Response(readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
});

// ---------- API tokens for the CLI ----------

agent.get("/workspaces/:id/tokens", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const rows = await c.env.DB.prepare(
    "SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_tokens WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC",
  )
    .bind(workspaceId, c.get("user").id)
    .all();
  return c.json({ tokens: rows.results });
});

agent.post("/workspaces/:id/tokens", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const name = text(await readJson(c.req), "name", { max: 80 });
  const token = `${TOKEN_PREFIX}${randomToken(24)}`;
  const id = newId("tok");
  await c.env.DB.prepare("INSERT INTO api_tokens (id, workspace_id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, workspaceId, c.get("user").id, name, await sha256(token), Date.now())
    .run();
  // The only time the token is shown.
  return c.json({ id, name, token });
});

agent.delete("/workspaces/:id/tokens/:tokenId", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  await c.env.DB.prepare("DELETE FROM api_tokens WHERE id = ? AND workspace_id = ? AND user_id = ?").bind(c.req.param("tokenId"), workspaceId, c.get("user").id).run();
  return c.json({ ok: true });
});

