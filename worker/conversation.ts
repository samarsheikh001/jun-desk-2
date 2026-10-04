import { DurableObject } from "cloudflare:workers";
import type { LlmProvider } from "@jun/llm";
import {
  MAX_ATTACHMENTS,
  MAX_MESSAGE_LENGTH,
  SOCKET_PROTOCOL,
  type Attachment,
  type AuthorType,
  type ClientEvent,
  type ConversationEvent,
  type Handling,
  type Message,
  type MessageMeta,
} from "../shared/protocol.ts";
import {
  asksForHuman,
  briefPrompt,
  HANDOFF_MESSAGES,
  MAX_AI_TURNS,
  parseReply,
  resolveCitations,
  searchQuery,
  streamVisible,
  systemPrompt,
  toChatMessages,
} from "./ai/agent.ts";
import { AiUnavailableError, createProvider, loadAiSettings } from "./ai/providers.ts";
import { searchKnowledge } from "./ai/search.ts";
import { describeEvents, isIssue, sanitizeContext, type DebugContext } from "../shared/debug.ts";
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
  /** Visitor's debug snapshot from the loader; sanitized before storing. */
  context?: unknown;
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

interface NewMessage {
  authorType: AuthorType;
  authorId: string | null;
  authorName: string | null;
  body: string;
  attachments?: Attachment[];
  clientMsgId: string;
  internal?: boolean;
  meta?: MessageMeta;
}

/**
 * One instance per conversation (D-11): holds the live sockets of the visitor and any
 * agents viewing it, assigns message order, writes through to D1 (the source of truth),
 * relays typing and read receipts, and runs the AI agent's turns. Sockets hibernate, so
 * idle chats cost ~nothing.
 */
export class Conversation extends DurableObject<Env> {
  #ref: ConversationRef | undefined;
  #seqLoaded: Promise<void> | undefined;
  /** The AI reply being streamed right now, so late joiners can catch up. */
  #streaming: { streamId: string; text: string } | undefined;
  #thinking = false;

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

  // ---------- sockets ----------

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

    // Catch the client up on anything after the last message it has (agents also see internal notes).
    const since = Number(new URL(request.url).searchParams.get("since") ?? 0) || 0;
    const messages = await loadMessages(this.env.DB, ref.conversationId, { since, includeInternal: participant.role === "agent" });
    this.#send(server, { type: "messages", messages });
    if (this.#thinking) this.#send(server, { type: "ai_status", state: "thinking" });
    if (this.#streaming) this.#send(server, { type: "ai_delta", ...this.#streaming, replace: true });

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
      this.#broadcast({ type: "typing", authorType, name, typing: Boolean(event.typing) }, { except: ws });
    } else if (event.type === "read") {
      await this.#markRead(ref, participant, Number(event.seq));
    } else if (event.type === "handoff" && participant.role === "visitor") {
      await this.#handoff(ref, "The customer asked for a person.", HANDOFF_MESSAGES.default);
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const participant = ws.deserializeAttachment() as Participant | null;
    // Clear any typing indicator the closed socket left behind.
    if (participant) {
      this.#broadcast({ type: "typing", authorType: participant.role, name: participant.role === "agent" ? participant.name : null, typing: false }, { except: ws });
    }
  }

  // ---------- RPC from the Worker ----------

  /** Adds a message. Returns a result because error details don't survive RPC. */
  async send(refIn: ConversationRef, participant: Participant, input: SendInput): Promise<SendResult> {
    try {
      return { ok: true, message: await this.#addMessage(refIn, participant, input) };
    } catch (error) {
      if (error instanceof SendError) return { ok: false, code: error.code, message: error.message };
      throw error;
    }
  }

  /** After a status/assignment/handling change: update open threads, and let the AI pick up if handed back. */
  async conversationChanged(refIn: ConversationRef): Promise<void> {
    const ref = this.#bind(refIn);
    await this.#publish(ref);
    await this.ctx.storage.setAlarm(Date.now());
  }

  // ---------- messages ----------

  /** A message from a participant. Idempotent per clientMsgId. */
  async #addMessage(refIn: ConversationRef, participant: Participant, input: SendInput): Promise<Message> {
    const ref = this.#bind(refIn);
    const body = typeof input.body === "string" ? input.body.trim() : "";
    const attachments = await this.#checkAttachments(ref, participant, input.attachments ?? []);
    if (!body && attachments.length === 0) throw new SendError("empty", "Message is empty.");
    if (body.length > MAX_MESSAGE_LENGTH) throw new SendError("too_long", `Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`);
    if (typeof input.clientMsgId !== "string" || !input.clientMsgId || input.clientMsgId.length > 100) {
      throw new SendError("bad_client_msg_id", "clientMsgId is required.");
    }

    // An agent writing in an AI-handled conversation takes it over (I-04).
    if (participant.role === "agent") {
      const took = await this.env.DB.prepare("UPDATE conversations SET handling = 'human' WHERE id = ? AND handling = 'ai'").bind(ref.conversationId).run();
      if (took.meta.changes > 0) {
        await this.#insert(ref, {
          authorType: "system",
          authorId: null,
          authorName: null,
          body: `${participant.name} took over from the AI.`,
          clientMsgId: `takeover:${input.clientMsgId}`,
          internal: true,
        });
      }
    }

    const message = await this.#insert(ref, {
      authorType: participant.role,
      authorId: participant.role === "agent" ? participant.userId : participant.contactId,
      authorName: participant.role === "agent" ? participant.name : null,
      body,
      attachments,
      clientMsgId: input.clientMsgId,
    });

    if (participant.role === "visitor" && input.context !== undefined) await this.#storeContext(ref, message.seq, input.context);

    // The AI answers visitor messages in AI-handled conversations, from an alarm so the
    // sender isn't kept waiting (and so it's retried if the object restarts).
    if (participant.role === "visitor") await this.ctx.storage.setAlarm(Date.now());
    return message;
  }

  /** Stores the visitor's browser snapshot (re-sanitized: never trust the client) for agents and the AI. */
  async #storeContext(ref: ConversationRef, seq: number, raw: unknown): Promise<void> {
    const context = sanitizeContext(raw);
    if (!context) return;
    const json = JSON.stringify(context);
    if (json.length > 64_000) return;
    await this.env.DB.batch([
      this.env.DB.prepare("INSERT INTO debug_snapshots (id, conversation_id, workspace_id, message_seq, context, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
        newId("dbg"),
        ref.conversationId,
        ref.workspaceId,
        seq,
        json,
        Date.now(),
      ),
      this.env.DB.prepare("UPDATE conversations SET debug_issue_count = ? WHERE id = ?").bind(context.events.filter(isIssue).length, ref.conversationId),
    ]);
    this.ctx.waitUntil(this.#publish(ref));
  }

  /** Stores a message (idempotent per clientMsgId), broadcasts it and updates inbox lists. */
  async #insert(ref: ConversationRef, input: NewMessage): Promise<Message> {
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
    const id = newId("msg");
    const attachments = input.attachments ?? [];
    const internal = input.internal ?? false;
    const meta = input.meta ?? {};

    const statements = [
      db.prepare(
        `INSERT INTO messages (id, conversation_id, seq, author_type, author_id, body, attachments, client_msg_id, created_at, internal, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, ref.conversationId, seq, input.authorType, input.authorId, input.body, JSON.stringify(attachments), input.clientMsgId, now, internal ? 1 : 0, JSON.stringify(meta)),
    ];
    if (!internal) {
      statements.push(
        db.prepare(
          `UPDATE conversations SET
             last_seq = MAX(last_seq, ?1), last_message_at = ?2, last_message_preview = ?3, last_message_author = ?4, updated_at = ?2,
             -- A visitor writing again reopens a resolved/snoozed conversation.
             status = CASE WHEN ?4 = 'visitor' AND status IN ('resolved', 'snoozed') THEN 'open' ELSE status END,
             -- Senders have read everything up to their own message.
             agent_read_seq = CASE WHEN ?4 = 'agent' THEN MAX(agent_read_seq, ?1) ELSE agent_read_seq END,
             visitor_read_seq = CASE WHEN ?4 = 'visitor' THEN MAX(visitor_read_seq, ?1) ELSE visitor_read_seq END
           WHERE id = ?5`,
        ).bind(seq, now, preview(input.body, attachments), input.authorType, ref.conversationId),
      );
      if (input.authorType === "visitor" && input.authorId) {
        statements.push(db.prepare("UPDATE contacts SET last_seen_at = ? WHERE id = ?").bind(now, input.authorId));
      }
    } else {
      statements.push(db.prepare("UPDATE conversations SET last_seq = MAX(last_seq, ?), updated_at = ? WHERE id = ?").bind(seq, now, ref.conversationId));
    }

    try {
      await db.batch(statements);
    } catch (error) {
      // A concurrent retry with the same clientMsgId won the race: return its message.
      const raced = await findExisting();
      if (raced) return raced;
      throw error;
    }

    const message: Message = {
      id,
      seq,
      authorType: input.authorType,
      authorId: input.authorId,
      authorName: input.authorName,
      body: input.body,
      attachments,
      clientMsgId: input.clientMsgId,
      createdAt: now,
      internal,
      meta,
    };
    this.#broadcast({ type: "message", message }, { agentsOnly: internal });
    this.ctx.waitUntil(this.#publish(ref));
    return message;
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

  // ---------- the AI agent ----------

  override async alarm(): Promise<void> {
    const ref = this.#ref;
    if (!ref) return;
    // Keep answering while the newest public message is an unanswered visitor message.
    for (let i = 0; i < 3; i++) {
      const answered = await this.#aiTurn(ref);
      if (!answered) return;
    }
  }

  async #handling(ref: ConversationRef): Promise<Handling | null> {
    const row = await this.env.DB.prepare("SELECT handling FROM conversations WHERE id = ?").bind(ref.conversationId).first<{ handling: Handling }>();
    return row?.handling ?? null;
  }

  /** One AI turn. Returns true if it replied (so the caller checks for newer messages). */
  async #aiTurn(ref: ConversationRef): Promise<boolean> {
    const month = new Date().toISOString().slice(0, 7);
    // Independent lookups in parallel: every round trip here delays the first word.
    const [handling, history, settings, usage] = await Promise.all([
      this.#handling(ref),
      loadMessages(this.env.DB, ref.conversationId, { includeInternal: false, limit: 40 }),
      loadAiSettings(this.env, ref.workspaceId),
      this.env.DB.prepare("SELECT replies FROM ai_usage WHERE workspace_id = ? AND month = ?").bind(ref.workspaceId, month).first<{ replies: number }>(),
    ]);
    if (handling !== "ai") return false;
    const last = history.at(-1);
    if (!last || last.authorType !== "visitor") return false;

    if (!settings.enabled) {
      await this.#handoff(ref, "AI replies are turned off.", HANDOFF_MESSAGES.default);
      return false;
    }
    if (asksForHuman(last.body)) {
      await this.#handoff(ref, "The customer asked for a person.", HANDOFF_MESSAGES.default);
      return false;
    }
    if (history.filter((m) => m.authorType === "ai").length >= MAX_AI_TURNS) {
      await this.#handoff(ref, `The AI has answered ${MAX_AI_TURNS} times without resolving it.`, HANDOFF_MESSAGES.default);
      return false;
    }
    if ((usage?.replies ?? 0) >= settings.monthlyReplyCap) {
      // B-03: never go silent; hand to a human instead.
      await this.#handoff(ref, `Monthly AI reply cap (${settings.monthlyReplyCap}) reached.`, HANDOFF_MESSAGES.limit);
      return false;
    }

    this.#thinking = true;
    this.#broadcast({ type: "ai_status", state: "thinking" });
    try {
      let provider: LlmProvider;
      try {
        provider = createProvider(this.env, ref.workspaceId, settings);
      } catch (error) {
        if (error instanceof AiUnavailableError) {
          await this.#handoff(ref, `AI unavailable: ${error.message}`, HANDOFF_MESSAGES.error);
          return false;
        }
        throw error;
      }

      const [workspace, hits, technical] = await Promise.all([
        this.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(ref.workspaceId).first<{ name: string }>(),
        searchKnowledge(this.env, ref.workspaceId, searchQuery(history)),
        this.#technicalContext(ref),
      ]);
      const instructions = systemPrompt({ workspaceName: workspace?.name ?? "this company", instructions: settings.instructions, hits, technical });

      // Stream what the visitor may see: nothing that could be a HANDOFF line, never an ESCALATE line.
      const streamId = newId("str");
      let text = "";
      let shown = "";
      let usageInfo: unknown;
      for await (const event of provider.stream({ instructions, messages: toChatMessages(history) })) {
        if (event.type === "done") {
          usageInfo = event.usage;
          break;
        }
        text += event.text;
        const visible = streamVisible(text);
        if (visible.length === 0 || visible === shown) continue;
        if (shown && visible.startsWith(shown)) {
          this.#broadcast({ type: "ai_delta", streamId, text: visible.slice(shown.length) });
        } else {
          this.#broadcast({ type: "ai_delta", streamId, text: visible, replace: true });
        }
        shown = visible;
        this.#streaming = { streamId, text: visible };
      }
      await this.#recordUsage(ref.workspaceId, month, usageInfo);

      // A teammate may have taken over while we were writing: drop the answer.
      if ((await this.#handling(ref)) !== "ai") return false;

      const outcome = parseReply(text);
      if (outcome.kind === "handoff") {
        await this.#handoff(ref, outcome.reason, HANDOFF_MESSAGES.default, provider, history, technical);
        return false;
      }
      const { text: body, sources } = resolveCitations(outcome.text, hits);
      const answer = await this.#insert(ref, {
        authorType: "ai",
        authorId: null,
        authorName: null,
        body,
        clientMsgId: `ai:${last.seq}`, // one answer per visitor message, even if this turn is retried
        meta: sources.length ? { sources } : {},
      });
      this.#streaming = undefined;
      this.#thinking = false;
      this.#broadcast({ type: "ai_status", state: "idle" });
      if (outcome.escalate) {
        // P1: the AI explained what broke; now the team gets it with the technical details.
        await this.#handoff(ref, `Bug flagged by the AI: ${outcome.escalate}`, HANDOFF_MESSAGES.escalated, provider, [...history, answer], technical);
        return false;
      }
      return true;
    } catch (error) {
      console.error("AI turn failed:", error);
      await this.#handoff(ref, `AI error: ${(error as Error).message}`.slice(0, 300), HANDOFF_MESSAGES.error);
      return false;
    } finally {
      this.#thinking = false;
      this.#streaming = undefined;
      this.#broadcast({ type: "ai_status", state: "idle" });
    }
  }

  /** Hands an AI conversation to the team: tells the visitor, and leaves agents a brief (AI-04). */
  /** The visitor's latest browser snapshot as prompt lines (P1). */
  async #technicalContext(ref: ConversationRef): Promise<string[]> {
    const row = await this.env.DB.prepare("SELECT context FROM debug_snapshots WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(ref.conversationId)
      .first<{ context: string }>();
    if (!row) return [];
    const context = JSON.parse(row.context) as DebugContext;
    return [`Page: ${context.page.url}${context.page.title ? ` ("${context.page.title}")` : ""}`, ...describeEvents(context).slice(-25)];
  }

  async #handoff(ref: ConversationRef, reason: string, visitorText: string, provider?: LlmProvider, history?: Message[], technical: string[] = []): Promise<void> {
    const changed = await this.env.DB.prepare("UPDATE conversations SET handling = 'human', status = 'open' WHERE id = ? AND handling = 'ai'")
      .bind(ref.conversationId)
      .run();
    if (changed.meta.changes === 0) return;
    const key = newId("handoff");
    await this.#insert(ref, { authorType: "system", authorId: null, authorName: null, body: visitorText, clientMsgId: `${key}:visitor`, meta: { handoffReason: reason } });

    let brief = "";
    if (provider && history) {
      try {
        const transcript =
          history.map((m) => `${m.authorType === "visitor" ? "Customer" : m.authorType === "ai" ? "AI" : "Agent"}: ${m.body}`).join("\n") +
          (technical.length ? `\n\nTechnical context from the customer's browser:\n${technical.join("\n")}` : "");
        let out = "";
        const work = (async () => {
          for await (const e of provider.stream({ instructions: briefPrompt(), messages: [{ role: "user", content: transcript.slice(-6000) }] })) {
            if (e.type === "text-delta") out += e.text;
          }
        })();
        await Promise.race([work, new Promise((resolve) => setTimeout(resolve, 20_000))]);
        brief = out.trim();
      } catch (error) {
        console.error("handoff brief failed:", error);
      }
    }
    await this.#insert(ref, {
      authorType: "system",
      authorId: null,
      authorName: null,
      body: `Handed off to the team. Reason: ${reason}${brief ? `\n\n${brief}` : ""}`,
      clientMsgId: `${key}:brief`,
      internal: true,
      meta: { handoffReason: reason },
    });
  }

  async #recordUsage(workspaceId: string, month: string, usage: unknown): Promise<void> {
    const u = (usage ?? {}) as { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    await this.env.DB.prepare(
      `INSERT INTO ai_usage (workspace_id, month, replies, input_tokens, output_tokens) VALUES (?1, ?2, 1, ?3, ?4)
       ON CONFLICT (workspace_id, month) DO UPDATE SET replies = replies + 1, input_tokens = input_tokens + ?3, output_tokens = output_tokens + ?4`,
    )
      .bind(workspaceId, month, u.input_tokens ?? u.prompt_tokens ?? 0, u.output_tokens ?? u.completion_tokens ?? 0)
      .run();
  }

  // ---------- fan-out ----------

  async #publish(ref: ConversationRef): Promise<void> {
    const conversation = await loadSummary(this.env.DB, ref.conversationId);
    if (!conversation) return;
    this.#broadcast({ type: "conversation", conversation });
    await this.env.WORKSPACE_HUB.getByName(ref.workspaceId).publish({ type: "conversation", conversation });
  }

  #send(ws: WebSocket, event: ConversationEvent): void {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      // socket already closed
    }
  }

  #broadcast(event: ConversationEvent, options: { except?: WebSocket; agentsOnly?: boolean } = {}): void {
    const data = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets(options.agentsOnly ? "agent" : undefined)) {
      if (ws === options.except || ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(data);
      } catch {
        // closing
      }
    }
  }
}
