import { DurableObject } from "cloudflare:workers";
import {
  MAX_ATTACHMENTS,
  MAX_MESSAGE_LENGTH,
  SOCKET_PROTOCOL,
  type Attachment,
  type ClientEvent,
  type ConversationEvent,
  type ConversationSummary,
  type Message,
} from "../shared/protocol.ts";
import { loadMessages, loadSummary, MESSAGE_SELECT, preview, toMessage, type MessageRow } from "./lib/conversations.ts";
import { newId } from "./lib/crypto.ts";

/** Who is on the other end of a socket or RPC call. The Worker authenticates before forwarding. */
export type Participant =
  | { role: "agent"; userId: string; name: string }
  | { role: "visitor"; contactId: string };

export interface ConversationRef {
  conversationId: string;
  workspaceId: string;
}

export interface SendInput {
  clientMsgId: string;
  body: string;
  attachments?: Attachment[] | undefined;
}

export type SendResult = { ok: true; message: Message } | { ok: false; code: string; message: string };

export class SendError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Headers the Worker sets when forwarding an authenticated socket upgrade. */
export const FORWARD_HEADERS = {
  conversationId: "x-jun-conversation-id",
  workspaceId: "x-jun-workspace-id",
  participant: "x-jun-participant",
} as const;

/**
 * One instance per conversation (D-11): holds the live sockets of the visitor and any
 * agents viewing it, assigns message order, writes through to D1 (the source of truth),
 * and relays typing and read receipts. Sockets hibernate, so idle chats cost ~nothing.
 */
export class Conversation extends DurableObject<Env> {
  #ref: ConversationRef | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ref = ctx.storage.kv.get<ConversationRef>("ref");
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  #bind(ref: ConversationRef): ConversationRef {
    if (!this.#ref) {
      this.#ref = ref;
      this.ctx.storage.kv.put("ref", ref);
    }
    return this.#ref;
  }

  #seqLoaded: Promise<void> | undefined;

  /**
   * Next message number. The increment itself is synchronous storage, so concurrent sends
   * can't get the same seq; the one-time load from D1 is shared by all callers.
   */
  async #nextSeq(conversationId: string): Promise<number> {
    if (this.ctx.storage.kv.get<number>("seq") === undefined) {
      this.#seqLoaded ??= (async () => {
        const row = await this.env.DB.prepare("SELECT last_seq FROM conversations WHERE id = ?").bind(conversationId).first<{ last_seq: number }>();
        if (this.ctx.storage.kv.get<number>("seq") === undefined) this.ctx.storage.kv.put("seq", row?.last_seq ?? 0);
      })();
      await this.#seqLoaded;
    }
    const seq = (this.ctx.storage.kv.get<number>("seq") ?? 0) + 1;
    this.ctx.storage.kv.put("seq", seq);
    return seq;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const ref = this.#bind({
      conversationId: request.headers.get(FORWARD_HEADERS.conversationId)!,
      workspaceId: request.headers.get(FORWARD_HEADERS.workspaceId)!,
    });
    const participant = JSON.parse(request.headers.get(FORWARD_HEADERS.participant)!) as Participant;

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [participant.role]);
    server.serializeAttachment(participant);

    // Catch the client up on anything after the last message it has.
    const since = Number(new URL(request.url).searchParams.get("since") ?? 0) || 0;
    this.#send(server, { type: "messages", messages: await loadMessages(this.env.DB, ref.conversationId, since) });

    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": SOCKET_PROTOCOL } });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const participant = ws.deserializeAttachment() as Participant;
    let event: ClientEvent;
    try {
      event = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as ClientEvent;
    } catch {
      return this.#send(ws, { type: "error", code: "bad_json", message: "Expected JSON." });
    }
    const ref = this.#ref;
    if (!ref) return;

    if (event.type === "send") {
      try {
        const message = await this.#addMessage(ref, participant, event);
        // The sender always gets its message back (also on duplicate retries) as the ack.
        this.#send(ws, { type: "message", message });
      } catch (error) {
        const code = error instanceof SendError ? error.code : "send_failed";
        this.#send(ws, { type: "error", code, message: (error as Error).message, clientMsgId: event.clientMsgId });
      }
    } else if (event.type === "typing") {
      const authorType = participant.role;
      const name = participant.role === "agent" ? participant.name : null;
      this.#broadcast({ type: "typing", authorType, name, typing: Boolean(event.typing) }, ws);
    } else if (event.type === "read") {
      await this.#markRead(ref, participant, Number(event.seq));
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const participant = ws.deserializeAttachment() as Participant | null;
    // Clear any typing indicator the closed socket left behind.
    if (participant) {
      this.#broadcast({ type: "typing", authorType: participant.role, name: participant.role === "agent" ? participant.name : null, typing: false }, ws);
    }
  }

  /** RPC from the Worker: adds a message. Returns a result because error details don't survive RPC. */
  async send(refIn: ConversationRef, participant: Participant, input: SendInput): Promise<SendResult> {
    try {
      return { ok: true, message: await this.#addMessage(refIn, participant, input) };
    } catch (error) {
      if (error instanceof SendError) return { ok: false, code: error.code, message: error.message };
      throw error;
    }
  }

  /** Adds a message. Idempotent per clientMsgId. */
  async #addMessage(refIn: ConversationRef, participant: Participant, input: SendInput): Promise<Message> {
    const ref = this.#bind(refIn);
    const body = typeof input.body === "string" ? input.body.trim() : "";
    const attachments = await this.#checkAttachments(ref, participant, input.attachments ?? []);
    if (!body && attachments.length === 0) throw new SendError("empty", "Message is empty.");
    if (body.length > MAX_MESSAGE_LENGTH) throw new SendError("too_long", `Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`);
    if (typeof input.clientMsgId !== "string" || !input.clientMsgId || input.clientMsgId.length > 100) {
      throw new SendError("bad_client_msg_id", "clientMsgId is required.");
    }

    const db = this.env.DB;
    const findExisting = async () => {
      const row = await db
        .prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.client_msg_id = ?`)
        .bind(ref.conversationId, input.clientMsgId)
        .first<MessageRow>();
      return row ? toMessage(row) : null;
    };
    const existing = await findExisting();
    if (existing) return existing;

    const seq = await this.#nextSeq(ref.conversationId);
    const now = Date.now();
    const authorType = participant.role;
    const authorId = participant.role === "agent" ? participant.userId : participant.contactId;
    const id = newId("msg");

    try {
      await db.batch([
      db.prepare(
        `INSERT INTO messages (id, conversation_id, seq, author_type, author_id, body, attachments, client_msg_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, ref.conversationId, seq, authorType, authorId, body, JSON.stringify(attachments), input.clientMsgId, now),
      db.prepare(
        `UPDATE conversations SET
           last_seq = MAX(last_seq, ?1), last_message_at = ?2, last_message_preview = ?3, last_message_author = ?4, updated_at = ?2,
           -- A visitor writing again reopens a resolved/snoozed conversation.
           status = CASE WHEN ?4 = 'visitor' AND status IN ('resolved', 'snoozed') THEN 'open' ELSE status END,
           -- Senders have read everything up to their own message.
           agent_read_seq = CASE WHEN ?4 = 'agent' THEN MAX(agent_read_seq, ?1) ELSE agent_read_seq END,
           visitor_read_seq = CASE WHEN ?4 = 'visitor' THEN MAX(visitor_read_seq, ?1) ELSE visitor_read_seq END
         WHERE id = ?5`,
      ).bind(seq, now, preview(body, attachments), authorType, ref.conversationId),
      ...(participant.role === "visitor"
        ? [db.prepare("UPDATE contacts SET last_seen_at = ? WHERE id = ?").bind(now, participant.contactId)]
        : []),
    ]);
    } catch (error) {
      // A concurrent retry with the same clientMsgId won the race: return its message.
      const raced = await findExisting();
      if (raced) return raced;
      throw error;
    }

    const message: Message = {
      id,
      seq,
      authorType,
      authorId,
      authorName: participant.role === "agent" ? participant.name : null,
      body,
      attachments,
      clientMsgId: input.clientMsgId,
      createdAt: now,
    };
    this.#broadcast({ type: "message", message });
    this.ctx.waitUntil(this.#publish(ref));
    return message;
  }

  /** Called by the Worker after a status/assignment change so open threads update live. */
  async conversationChanged(refIn: ConversationRef): Promise<void> {
    await this.#publish(this.#bind(refIn));
  }

  async #markRead(ref: ConversationRef, participant: Participant, seq: number): Promise<void> {
    if (!Number.isInteger(seq) || seq < 1) return;
    const column = participant.role === "agent" ? "agent_read_seq" : "visitor_read_seq";
    const result = await this.env.DB.prepare(`UPDATE conversations SET ${column} = ? WHERE id = ? AND ${column} < ? AND last_seq >= ?`)
      .bind(seq, ref.conversationId, seq, seq)
      .run();
    if (result.meta.changes === 0) return; // not newer than what's recorded
    this.#broadcast({ type: "read", by: participant.role, seq });
    if (participant.role === "agent") this.ctx.waitUntil(this.#publish(ref)); // unread badges in inbox lists
  }

  async #checkAttachments(ref: ConversationRef, participant: Participant, attachments: Attachment[]): Promise<Attachment[]> {
    if (!Array.isArray(attachments) || attachments.length === 0) return [];
    if (attachments.length > MAX_ATTACHMENTS) throw new SendError("too_many_files", `At most ${MAX_ATTACHMENTS} files per message.`);
    const uploader = participant.role === "agent" ? `user:${participant.userId}` : `contact:${participant.contactId}`;
    const keys = attachments.map((a) => String(a?.key ?? ""));
    const rows = await this.env.DB.prepare(
      `SELECT key, name, type, size FROM files WHERE workspace_id = ? AND uploaded_by = ? AND key IN (${keys.map(() => "?").join(",")})`,
    )
      .bind(ref.workspaceId, uploader, ...keys)
      .all<Attachment>();
    // Use the stored metadata, not what the client claims.
    const byKey = new Map(rows.results.map((r) => [r.key, r]));
    return keys.map((key) => {
      const file = byKey.get(key);
      if (!file) throw new SendError("unknown_file", "An attachment wasn't found. Upload it again.");
      return { key: file.key, name: file.name, type: file.type, size: file.size };
    });
  }

  async #publish(ref: ConversationRef): Promise<void> {
    const conversation = await loadSummary(this.env.DB, ref.conversationId);
    if (!conversation) return;
    this.#broadcast({ type: "conversation", conversation });
    await this.env.WORKSPACE_HUB.getByName(ref.workspaceId).publish({ type: "conversation", conversation } satisfies { type: "conversation"; conversation: ConversationSummary });
  }

  #send(ws: WebSocket, event: ConversationEvent): void {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      // socket already closed
    }
  }

  #broadcast(event: ConversationEvent, except?: WebSocket): void {
    const data = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(data);
      } catch {
        // closing
      }
    }
  }
}
