import { Hono } from "hono";
import { SOCKET_PROTOCOL, type Attachment } from "../../shared/protocol.ts";
import type { ConversationRef, Participant } from "../conversation.ts";
import { loadMessages, loadSummary, SUMMARY_SELECT, toSummary, type SummaryRow } from "../lib/conversations.ts";
import { createVisitor, findVisitor, identify } from "../lib/contacts.ts";
import { newId, sha256 } from "../lib/crypto.ts";
import { IdentityError, verifyIdentityToken } from "../lib/identity.ts";
import { connectConversation, connectVisitorLive, notifyConversationChanged, offeredProtocols, sendMessage } from "../lib/realtime.ts";
import { readJson } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv } from "../types.ts";
import { generateText } from "ai";
import { sanitizeContext, type DebugEvent } from "../../shared/debug.ts";
import { cleanNudge, GENERIC_NUDGE, nudgeCacheKey, nudgeFacts, nudgePrompt } from "../ai/nudge.ts";
import { createModel, loadAiSettings } from "../ai/providers.ts";
import { storeUpload } from "./files.ts";

// Public API used by the widget frame. Visitors are anonymous contacts identified by a
// random token their browser keeps (sent as `X-Visitor-Token`, or as the second
// WebSocket subprotocol so it never appears in a URL).

interface WidgetInbox {
  inboxId: string;
  workspaceId: string;
  workspaceName: string;
  settings: Record<string, unknown>;
  identitySecret: string | null;
}

async function widgetInbox(c: AppContext): Promise<WidgetInbox> {
  const row = await c.env.DB.prepare(
    `SELECT i.id AS inboxId, i.workspace_id AS workspaceId, w.name AS workspaceName, i.settings, i.identity_secret AS identitySecret
     FROM inboxes i JOIN workspaces w ON w.id = i.workspace_id WHERE i.widget_key = ?`,
  )
    .bind(c.req.param("key"))
    .first<{ inboxId: string; workspaceId: string; workspaceName: string; settings: string; identitySecret: string | null }>();
  if (!row) throw new HttpError(404, "unknown_widget", "Unknown widget key.");
  return { ...row, settings: JSON.parse(row.settings) as Record<string, unknown> };
}

async function visitor(c: AppContext, inbox: WidgetInbox, token = c.req.header("x-visitor-token")): Promise<{ contactId: string }> {
  if (!token) throw new HttpError(401, "no_visitor", "Missing visitor token.");
  const found = await findVisitor(c.env.DB, inbox.workspaceId, token);
  if (!found) throw new HttpError(401, "unknown_visitor", "Unknown visitor.");
  return { contactId: found.contactId };
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
    // Debug snapshot from the loader (P1); sanitized by the Conversation object.
    context: body.context,
  };
}

export const widget = new Hono<AppEnv>();

widget.get("/widget/:key/config", async (c) => {
  const inbox = await widgetInbox(c);
  return c.json({
    workspaceName: inbox.workspaceName,
    greeting: inbox.settings.greeting ?? "Hi! How can we help?",
    // P-01: offer help when the page has an error (on unless turned off).
    proactive: inbox.settings.proactive !== false,
    /** Whether new chats are answered by the AI first (the widget shows its typing dots right away). */
    ai: (await loadAiSettings(c.env, inbox.workspaceId)).enabled,
  });
});

// S-11 / P-01: the loader saw something break and asks what to offer. The AI phrases it from
// the masked failure ("Looks like the usage chart didn't load. Want a hand?"); the generic line
// when the AI is off, over its cap or slow. Called cross-origin from customers' sites.
const NUDGE_CACHE_S = 24 * 60 * 60;
const NUDGE_TIMEOUT_MS = 2500;

widget.post("/widget/:key/nudge", async (c) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  const inbox = await widgetInbox(c).catch(() => null);
  if (!inbox || inbox.settings.proactive === false) return c.json({ show: false }, 200, cors);
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await c.req.text()) as Record<string, unknown>;
  } catch {
    return c.json({ show: false }, 200, cors);
  }
  // Masked again here, whatever the loader sent.
  const context = sanitizeContext({ page: raw.page, events: raw.event ? [raw.event] : [] });
  const event: DebugEvent | undefined = context?.events[0];
  if (!context || !event) return c.json({ show: true, text: GENERIC_NUDGE }, 200, cors);

  const settings = await loadAiSettings(c.env, inbox.workspaceId);
  const month = new Date().toISOString().slice(0, 7);
  const usage = await c.env.DB.prepare("SELECT replies FROM ai_usage WHERE workspace_id = ? AND month = ?").bind(inbox.workspaceId, month).first<{ replies: number }>();
  if (!settings.enabled || (usage?.replies ?? 0) >= settings.monthlyReplyCap) return c.json({ show: true, text: GENERIC_NUDGE }, 200, cors);

  // The same failure on the same page gets the same line: one model call per day, not per visitor.
  const cacheUrl = `https://nudge.jun-desk.internal/${await sha256(nudgeCacheKey(inbox.workspaceId, event, context.page))}`;
  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
  const cached = await cache?.match(cacheUrl);
  if (cached) return c.json({ show: true, text: await cached.text() }, 200, cors);

  let text = GENERIC_NUDGE;
  try {
    const model = createModel(c.env, inbox.workspaceId, settings);
    const result = await generateText({
      model: model.model,
      ...model.prompt(nudgePrompt(inbox.workspaceName)),
      messages: [{ role: "user", content: nudgeFacts(event, context.page) }],
      maxOutputTokens: 60,
      temperature: 0.2,
      abortSignal: AbortSignal.timeout(NUDGE_TIMEOUT_MS),
    });
    text = cleanNudge(result.text) ?? GENERIC_NUDGE;
    c.executionCtx.waitUntil(
      Promise.all([
        cache?.put(cacheUrl, new Response(text, { headers: { "Cache-Control": `max-age=${NUDGE_CACHE_S}` } })),
        // Tokens count toward usage; nudges aren't replies, so they don't use up the reply cap.
        c.env.DB.prepare(
          `INSERT INTO ai_usage (workspace_id, month, replies, input_tokens, output_tokens) VALUES (?1, ?2, 0, ?3, ?4)
           ON CONFLICT (workspace_id, month) DO UPDATE SET input_tokens = input_tokens + ?3, output_tokens = output_tokens + ?4`,
        )
          .bind(inbox.workspaceId, month, result.totalUsage.inputTokens ?? 0, result.totalUsage.outputTokens ?? 0)
          .run(),
      ]),
    );
  } catch (error) {
    console.warn("nudge text failed, using the generic line:", (error as Error).message);
  }
  return c.json({ show: true, text }, 200, cors);
});

widget.post("/widget/:key/visitor", async (c) => {
  const inbox = await widgetInbox(c);
  return c.json(await createVisitor(c.env.DB, inbox.workspaceId));
});

// V-03/V-04: the host page's signed-in user, proven by a JWT from the host app's backend.
// Returns the browser's visitor token for that user (it may change; the frame stores it).
widget.post("/widget/:key/identify", async (c) => {
  const inbox = await widgetInbox(c);
  if (!inbox.identitySecret) throw new HttpError(400, "identity_not_configured", "Identity verification isn't set up for this desk (Settings → Install).");
  const body = await readJson(c.req);
  if (typeof body.userToken !== "string") throw new HttpError(400, "invalid_field", "userToken is required.");
  let identity;
  try {
    identity = await verifyIdentityToken(body.userToken, inbox.identitySecret);
  } catch (error) {
    if (error instanceof IdentityError) throw new HttpError(401, "bad_identity", error.message);
    throw error;
  }
  const result = await identify(c.env.DB, inbox.workspaceId, identity, c.req.header("x-visitor-token") ?? null);
  // Merged conversations now belong to the user: refresh them in agents' inboxes.
  c.executionCtx.waitUntil(Promise.all(result.movedConversations.map((id) => notifyConversationChanged(c.env, { conversationId: id, workspaceId: inbox.workspaceId }))));
  return c.json({ token: result.token, contactId: result.contactId });
});

// V-01: the loader's live connection (page views, identity) to the workspace hub. Unlike the
// frame's sockets this comes from the customer's site, so any origin may connect; it can only
// report itself and receive invites addressed to its own session.
widget.get("/widget/:key/live", async (c) => {
  const inbox = await widgetInbox(c);
  const sessionId = c.req.query("s") ?? "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) throw new HttpError(400, "invalid_field", "Bad session id.");
  const cf = (c.req.raw as Request & { cf?: { country?: string; city?: string } }).cf;
  return connectVisitorLive(c.env, c.req.raw, inbox.workspaceId, {
    sessionId,
    inboxId: inbox.inboxId,
    country: cf?.country ?? null,
    city: cf?.city ?? null,
    userAgent: (c.req.header("user-agent") ?? "").slice(0, 300),
  });
});

widget.get("/widget/:key/conversations", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  const rows = await c.env.DB.prepare(`${SUMMARY_SELECT} WHERE c.contact_id = ? AND c.inbox_id = ? ORDER BY c.last_message_at DESC LIMIT 50`)
    .bind(contactId, inbox.inboxId)
    .all<SummaryRow>();
  return c.json({ conversations: rows.results.map(toSummary) });
});

// Starts a conversation with its first message. With `inviteId` (V-07), the agent's invite
// becomes the first message and the conversation goes to that agent instead of the AI.
widget.post("/widget/:key/conversations", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  const body = await readJson(c.req);
  const input = sendInput(body);
  if (!input.body.trim() && input.attachments.length === 0) throw new HttpError(400, "empty", "Message is empty.");
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 64) : null;

  const now = Date.now();
  let invite: { id: string; user_id: string; name: string; body: string } | null = null;
  if (typeof body.inviteId === "string") {
    invite = await c.env.DB.prepare(
      `SELECT v.id, v.user_id, u.name, v.body FROM visitor_invites v JOIN users u ON u.id = v.user_id
       WHERE v.id = ? AND v.workspace_id = ? AND v.used_at IS NULL AND v.expires_at > ? AND (? IS NULL OR v.session_id = ?)`,
    )
      .bind(body.inviteId, inbox.workspaceId, now, sessionId, sessionId)
      .first();
    // A stale or foreign invite just starts a normal conversation.
    if (invite) {
      const claimed = await c.env.DB.prepare("UPDATE visitor_invites SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now, invite.id).run();
      if (claimed.meta.changes === 0) invite = null;
    }
  }

  const ref: ConversationRef = { conversationId: newId("cv"), workspaceId: inbox.workspaceId };
  // The AI answers first when it's enabled; otherwise (or after an agent's invite) the team does.
  const handling = !invite && (await loadAiSettings(c.env, inbox.workspaceId)).enabled ? "ai" : "human";
  await c.env.DB.prepare(
    `INSERT INTO conversations (id, workspace_id, inbox_id, contact_id, handling, assignee_id, last_message_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(ref.conversationId, inbox.workspaceId, inbox.inboxId, contactId, handling, invite?.user_id ?? null, now, now, now)
    .run();
  const participant: Participant = { role: "visitor", contactId };
  let message;
  try {
    if (invite) {
      await sendMessage(c.env, ref, { role: "agent", userId: invite.user_id, name: invite.name }, { clientMsgId: `invite:${invite.id}`, body: invite.body, attachments: [] });
    }
    message = await sendMessage(c.env, ref, participant, input);
  } catch (error) {
    // Don't leave an empty conversation behind if the first message was rejected.
    await c.env.DB.prepare("DELETE FROM conversations WHERE id = ? AND last_seq = 0").bind(ref.conversationId).run();
    throw error;
  }
  // The visitor list shows who is in a chat.
  if (sessionId) c.executionCtx.waitUntil(c.env.WORKSPACE_HUB.getByName(inbox.workspaceId).linkSession(sessionId, contactId));
  return c.json({ conversation: await loadSummary(c.env.DB, ref.conversationId), message });
});

widget.get("/widget/:key/conversations/:cid", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  const ref = await visitorConversation(c, inbox, contactId);
  const [conversation, messages] = await Promise.all([loadSummary(c.env.DB, ref.conversationId), loadMessages(c.env.DB, ref.conversationId, { includeInternal: false })]);
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
