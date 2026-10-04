import { Hono } from "hono";
import type { ConversationStatus } from "../../shared/protocol.ts";
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
  const inbox = await c.env.DB.prepare("SELECT id, name, widget_key AS widgetKey FROM inboxes WHERE workspace_id = ? ORDER BY created_at LIMIT 1")
    .bind(workspaceId)
    .first();
  return c.json({ inbox });
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
