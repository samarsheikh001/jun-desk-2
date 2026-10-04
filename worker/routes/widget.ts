import { Hono } from "hono";
import { SOCKET_PROTOCOL, type Attachment } from "../../shared/protocol.ts";
import type { ConversationRef, Participant } from "../conversation.ts";
import { loadMessages, loadSummary, SUMMARY_SELECT, toSummary, type SummaryRow } from "../lib/conversations.ts";
import { newId, randomToken, sha256 } from "../lib/crypto.ts";
import { connectConversation, offeredProtocols, sendMessage } from "../lib/realtime.ts";
import { readJson } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv } from "../types.ts";
import { storeUpload } from "./files.ts";

// Public API used by the widget frame. Visitors are anonymous contacts identified by a
// random token their browser keeps (sent as `X-Visitor-Token`, or as the second
// WebSocket subprotocol so it never appears in a URL).

interface WidgetInbox {
  inboxId: string;
  workspaceId: string;
  workspaceName: string;
  settings: Record<string, unknown>;
}

async function widgetInbox(c: AppContext): Promise<WidgetInbox> {
  const row = await c.env.DB.prepare(
    `SELECT i.id AS inboxId, i.workspace_id AS workspaceId, w.name AS workspaceName, i.settings
     FROM inboxes i JOIN workspaces w ON w.id = i.workspace_id WHERE i.widget_key = ?`,
  )
    .bind(c.req.param("key"))
    .first<{ inboxId: string; workspaceId: string; workspaceName: string; settings: string }>();
  if (!row) throw new HttpError(404, "unknown_widget", "Unknown widget key.");
  return { ...row, settings: JSON.parse(row.settings) as Record<string, unknown> };
}

async function visitor(c: AppContext, inbox: WidgetInbox, token = c.req.header("x-visitor-token")): Promise<{ contactId: string }> {
  if (!token) throw new HttpError(401, "no_visitor", "Missing visitor token.");
  const row = await c.env.DB.prepare("SELECT id FROM contacts WHERE visitor_token_hash = ? AND workspace_id = ?")
    .bind(await sha256(token), inbox.workspaceId)
    .first<{ id: string }>();
  if (!row) throw new HttpError(401, "unknown_visitor", "Unknown visitor.");
  return { contactId: row.id };
}

async function visitorConversation(c: AppContext, inbox: WidgetInbox, contactId: string): Promise<ConversationRef> {
  const conversationId = c.req.param("cid")!;
  const row = await c.env.DB.prepare("SELECT 1 FROM conversations WHERE id = ? AND contact_id = ? AND inbox_id = ?")
    .bind(conversationId, contactId, inbox.inboxId)
    .first();
  if (!row) throw new HttpError(404, "not_found", "Conversation not found.");
  return { conversationId, workspaceId: inbox.workspaceId };
}

function sendInput(body: Record<string, unknown>) {
  return {
    clientMsgId: String(body.clientMsgId ?? ""),
    body: typeof body.body === "string" ? body.body : "",
    attachments: Array.isArray(body.attachments) ? (body.attachments as Attachment[]) : [],
  };
}

export const widget = new Hono<AppEnv>();

widget.get("/widget/:key/config", async (c) => {
  const inbox = await widgetInbox(c);
  return c.json({ workspaceName: inbox.workspaceName, greeting: inbox.settings.greeting ?? "Hi! How can we help?" });
});

widget.post("/widget/:key/visitor", async (c) => {
  const inbox = await widgetInbox(c);
  const token = randomToken();
  const contactId = newId("ct");
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO contacts (id, workspace_id, visitor_token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
    .bind(contactId, inbox.workspaceId, await sha256(token), now, now)
    .run();
  return c.json({ token, contactId });
});

widget.get("/widget/:key/conversations", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  const rows = await c.env.DB.prepare(`${SUMMARY_SELECT} WHERE c.contact_id = ? AND c.inbox_id = ? ORDER BY c.last_message_at DESC LIMIT 50`)
    .bind(contactId, inbox.inboxId)
    .all<SummaryRow>();
  return c.json({ conversations: rows.results.map(toSummary) });
});

// Starts a conversation with its first message.
widget.post("/widget/:key/conversations", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  const input = sendInput(await readJson(c.req));
  if (!input.body.trim() && input.attachments.length === 0) throw new HttpError(400, "empty", "Message is empty.");

  const now = Date.now();
  const ref: ConversationRef = { conversationId: newId("cv"), workspaceId: inbox.workspaceId };
  await c.env.DB.prepare(
    `INSERT INTO conversations (id, workspace_id, inbox_id, contact_id, last_message_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(ref.conversationId, inbox.workspaceId, inbox.inboxId, contactId, now, now, now)
    .run();
  const participant: Participant = { role: "visitor", contactId };
  let message;
  try {
    message = await sendMessage(c.env, ref, participant, input);
  } catch (error) {
    // Don't leave an empty conversation behind if the first message was rejected.
    await c.env.DB.prepare("DELETE FROM conversations WHERE id = ? AND last_seq = 0").bind(ref.conversationId).run();
    throw error;
  }
  return c.json({ conversation: await loadSummary(c.env.DB, ref.conversationId), message });
});

widget.get("/widget/:key/conversations/:cid", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  const ref = await visitorConversation(c, inbox, contactId);
  const [conversation, messages] = await Promise.all([loadSummary(c.env.DB, ref.conversationId), loadMessages(c.env.DB, ref.conversationId)]);
  return c.json({ conversation, messages });
});

widget.post("/widget/:key/conversations/:cid/messages", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  const ref = await visitorConversation(c, inbox, contactId);
  const message = await sendMessage(c.env, ref, { role: "visitor", contactId }, sendInput(await readJson(c.req)));
  return c.json({ message });
});

widget.get("/widget/:key/conversations/:cid/ws", async (c) => {
  const inbox = await widgetInbox(c);
  // Browsers can't set headers on WebSockets, so the token rides as a subprotocol.
  const token = offeredProtocols(c.req.raw).find((p) => p !== SOCKET_PROTOCOL);
  const { contactId } = await visitor(c, inbox, token);
  const ref = await visitorConversation(c, inbox, contactId);
  return connectConversation(c.env, c.req.raw, ref, { role: "visitor", contactId });
});

widget.post("/widget/:key/files", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  return c.json({ attachment: await storeUpload(c, inbox.workspaceId, `contact:${contactId}`) });
});
