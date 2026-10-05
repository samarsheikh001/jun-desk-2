import { Hono } from "hono";
import { isIssue, type DebugContext, type DebugEvent } from "../../shared/debug.ts";
import type { AiAction, ConversationStatus } from "../../shared/protocol.ts";
import { requireUser } from "../auth/session.ts";
import type { ConversationRef, Participant } from "../conversation.ts";
import { loadMessages, loadSummary, SUMMARY_SELECT, toSummary, type SummaryRow } from "../lib/conversations.ts";
import { connectConversation, connectHub, notifyConversationChanged, sendMessage } from "../lib/realtime.ts";
import { object, readJson } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv } from "../types.ts";
import { storeUpload } from "./files.ts";

const STATUSES: ConversationStatus[] = ["open", "pending", "snoozed", "resolved"];

async function requireMember(c: AppContext, workspaceId: string): Promise<void> {
  const row = await c.env.DB.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
}

/** Resolves a conversation the signed-in agent can access. */
async function requireConversation(c: AppContext, conversationId: string): Promise<ConversationRef> {
  const row = await c.env.DB.prepare(
    `SELECT c.workspace_id FROM conversations c JOIN members m ON m.workspace_id = c.workspace_id AND m.user_id = ?
     WHERE c.id = ?`,
  )
    .bind(c.get("user").id, conversationId)
    .first<{ workspace_id: string }>();
  if (!row) throw new HttpError(404, "not_found", "Conversation not found.");
  return { conversationId, workspaceId: row.workspace_id };
}

const agent = (c: AppContext): Participant => ({ role: "agent", userId: c.get("user").id, name: c.get("user").name });

export const conversations = new Hono<AppEnv>();
conversations.use("/workspaces/:id/inbox", requireUser);
conversations.use("/workspaces/:id/conversations", requireUser);
conversations.use("/workspaces/:id/files", requireUser);
conversations.use("/workspaces/:id/ws", requireUser);
conversations.use("/conversations/*", requireUser);

conversations.get("/workspaces/:id/inbox", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  const inbox = await c.env.DB.prepare("SELECT id, name, widget_key AS widgetKey, settings FROM inboxes WHERE workspace_id = ? ORDER BY created_at LIMIT 1")
    .bind(workspaceId)
    .first<{ id: string; name: string; widgetKey: string; settings: string }>();
  return c.json({ inbox: inbox && { ...inbox, settings: JSON.parse(inbox.settings) as Record<string, unknown> } });
});

// Widget settings (owners/admins): currently just proactive help.
conversations.patch("/workspaces/:id/inbox", async (c) => {
  const workspaceId = c.req.param("id");
  const role = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first<{ role: string }>();
  if (!role) throw new HttpError(404, "not_found", "Workspace not found.");
  if (role.role === "agent") throw new HttpError(403, "forbidden", "Only owners and admins can change this.");
  const body = await readJson(c.req);
  const inbox = await c.env.DB.prepare("SELECT id, settings FROM inboxes WHERE workspace_id = ? ORDER BY created_at LIMIT 1").bind(workspaceId).first<{ id: string; settings: string }>();
  if (!inbox) throw new HttpError(404, "not_found", "No widget inbox.");
  const settings = JSON.parse(inbox.settings) as Record<string, unknown>;
  if (typeof body.proactive === "boolean") settings.proactive = body.proactive;
  await c.env.DB.prepare("UPDATE inboxes SET settings = ? WHERE id = ?").bind(JSON.stringify(settings), inbox.id).run();
  return c.json({ settings });
});

conversations.get("/workspaces/:id/conversations", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  const status = c.req.query("status") ?? "open";
  const assignee = c.req.query("assignee"); // "me" | "unassigned" | undefined
  if (status !== "all" && !STATUSES.includes(status as ConversationStatus)) throw new HttpError(400, "invalid_field", "Unknown status.");

  const where = ["c.workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (status !== "all") {
    where.push("c.status = ?");
    params.push(status);
  }
  if (assignee === "me") {
    where.push("c.assignee_id = ?");
    params.push(c.get("user").id);
  } else if (assignee === "unassigned") {
    where.push("c.assignee_id IS NULL");
  }
  const rows = await c.env.DB.prepare(`${SUMMARY_SELECT} WHERE ${where.join(" AND ")} ORDER BY c.last_message_at DESC LIMIT 100`)
    .bind(...params)
    .all<SummaryRow>();
  return c.json({ conversations: rows.results.map(toSummary) });
});

conversations.get("/workspaces/:id/ws", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  return connectHub(c.env, c.req.raw, workspaceId, { userId: c.get("user").id, name: c.get("user").name });
});

conversations.post("/workspaces/:id/files", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  return c.json({ attachment: await storeUpload(c, workspaceId, `user:${c.get("user").id}`) });
});

conversations.get("/conversations/:cid", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  const [conversation, messages] = await Promise.all([loadSummary(c.env.DB, ref.conversationId), loadMessages(c.env.DB, ref.conversationId, { includeInternal: true })]);
  return c.json({ conversation, messages });
});

// Debug context (S-03): the latest snapshot's environment plus every captured event,
// merged across snapshots (each message sends the loader's whole recent buffer).
conversations.get("/conversations/:cid/context", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  const rows = await c.env.DB.prepare("SELECT context FROM debug_snapshots WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 20")
    .bind(ref.conversationId)
    .all<{ context: string }>();
  if (rows.results.length === 0) return c.json({ context: null, events: [], issueCount: 0 });
  const snapshots = rows.results.map((r) => JSON.parse(r.context) as DebugContext);
  const seen = new Set<string>();
  const events: DebugEvent[] = [];
  for (const snapshot of snapshots) {
    for (const e of snapshot.events) {
      const key = `${e.t}|${e.kind}|${e.url ?? ""}|${e.message ?? ""}|${e.status ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(e);
    }
  }
  events.sort((a, b) => b.t - a.t);
  const { events: _latestEvents, ...latest } = snapshots[0]!;
  return c.json({ context: latest, events: events.slice(0, 100), issueCount: events.filter(isIssue).length });
});

// AI-11: tool calls the AI made in this conversation, newest last.
conversations.get("/conversations/:cid/actions", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  const rows = await c.env.DB.prepare(
    `SELECT id, message_seq, config_version, tool, input, output, status, http_status, duration_ms, created_at
     FROM ai_actions WHERE conversation_id = ? ORDER BY created_at LIMIT 200`,
  )
    .bind(ref.conversationId)
    .all<{ id: string; message_seq: number; config_version: number | null; tool: string; input: string; output: string | null; status: "ok" | "error"; http_status: number | null; duration_ms: number; created_at: number }>();
  const actions: AiAction[] = rows.results.map((r) => ({
    id: r.id,
    messageSeq: r.message_seq,
    configVersion: r.config_version,
    tool: r.tool,
    input: JSON.parse(r.input) as Record<string, unknown>,
    output: r.output,
    status: r.status,
    httpStatus: r.http_status,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  }));
  return c.json({ actions });
});

conversations.patch("/conversations/:cid", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  const body = await readJson(c.req);
  const sets: string[] = [];
  const params: unknown[] = [];

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status as ConversationStatus)) throw new HttpError(400, "invalid_field", "Unknown status.");
    sets.push("status = ?");
    params.push(body.status);
  }
  if (body.assigneeId !== undefined) {
    if (body.assigneeId !== null) {
      const member = await c.env.DB.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND user_id = ?").bind(ref.workspaceId, String(body.assigneeId)).first();
      if (!member) throw new HttpError(400, "invalid_field", "Assignee must be a member of this workspace.");
    }
    sets.push("assignee_id = ?");
    params.push(body.assigneeId);
  }
  if (body.handling !== undefined) {
    // "Hand back to AI" (or take over without replying).
    if (body.handling !== "ai" && body.handling !== "human") throw new HttpError(400, "invalid_field", "handling must be ai or human.");
    sets.push("handling = ?");
    params.push(body.handling);
  }
  if (sets.length === 0) throw new HttpError(400, "invalid_body", "Nothing to change.");

  await c.env.DB.prepare(`UPDATE conversations SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...params, Date.now(), ref.conversationId)
    .run();
  await notifyConversationChanged(c.env, ref);
  return c.json({ conversation: await loadSummary(c.env.DB, ref.conversationId) });
});

// HTTP fallback for sending; the dashboard normally sends over the socket.
conversations.post("/conversations/:cid/messages", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  const body = await readJson(c.req);
  const message = await sendMessage(c.env, ref, agent(c), {
    clientMsgId: String(body.clientMsgId ?? crypto.randomUUID()),
    body: String(body.body ?? ""),
    attachments: Array.isArray(body.attachments) ? object(body, "attachments") : [],
  });
  return c.json({ message });
});

conversations.get("/conversations/:cid/ws", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  return connectConversation(c.env, c.req.raw, ref, agent(c));
});
