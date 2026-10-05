import { DurableObject } from "cloudflare:workers";
import { ChatGPTAuth, type ChatGPTCredentials, type CredentialStore } from "@jun/llm";
import { pickAssignee } from "../shared/inbox.ts";
import { SOCKET_PROTOCOL, type HubEvent, type LiveClientEvent, type LiveServerEvent, type LiveVisitor, type PresenceEntry } from "../shared/protocol.ts";
import { upsertIdentified } from "./lib/contacts.ts";
import { IdentityError, verifyIdentityToken } from "./lib/identity.ts";

export const HUB_USER_HEADER = "x-jun-user";
export const HUB_VISITOR_HEADER = "x-jun-visitor";

/** What the Worker tells the hub about a visitor's live connection (after checking the widget key). */
export interface VisitorConnect {
  sessionId: string;
  inboxId: string;
  country: string | null;
  city: string | null;
  userAgent: string;
}

/** Stored on each visitor socket (survives hibernation; must stay under 2 KB). */
interface VisitorAttachment {
  kind: "visitor";
  inboxId: string;
  visitor: LiveVisitor;
  /** Epoch ms; with the last ping, how we tell a live socket from a dead one. */
  connectedAt?: number;
}

type AgentAttachment = PresenceEntry & { kind?: "agent"; connectedAt?: number };

/**
 * The loader and the dashboard ping every 30 s (answered automatically, even while this object
 * hibernates). A socket with no ping for this long is gone: a tab closed without a close frame,
 * or a connection cut by a deploy. Without this, ghosts stay "live" forever.
 */
const STALE_MS = 75_000;
const SWEEP_MS = 60_000;

const clip = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

/**
 * One instance per workspace. Agents' dashboards keep a socket open here to get inbox
 * updates (from Conversation objects) and to see which teammates are online. The widget
 * loader on customers' sites keeps a socket here too (V-01 live visitors, V-07 invites).
 * It also owns dev-only ChatGPT token refresh: refresh tokens rotate, so exactly one place
 * may refresh them.
 */
export class WorkspaceHub extends DurableObject<Env> {
  #chatgpt: ChatGPTAuth | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();

    const visitorHeader = request.headers.get(HUB_VISITOR_HEADER);
    if (visitorHeader) {
      const info = JSON.parse(visitorHeader) as VisitorConnect;
      const now = Date.now();
      const attachment: VisitorAttachment = {
        kind: "visitor",
        inboxId: info.inboxId,
        visitor: {
          sessionId: info.sessionId,
          contact: null,
          page: { url: "", title: "" },
          referrer: null,
          pages: 0,
          startedAt: now,
          country: info.country,
          city: info.city,
          userAgent: info.userAgent.slice(0, 200),
          language: null,
          timezone: null,
          inChat: false,
        },
      };
      this.ctx.acceptWebSocket(server, ["visitor", `s:${info.sessionId}`]);
      server.serializeAttachment({ ...attachment, connectedAt: now } satisfies VisitorAttachment);
      await this.#scheduleSweep();
      // Announced to agents on its first page event, which carries the page. The loader offers
      // no subprotocol; echo ours if a client offers it (clients reject a missing echo).
      const offered = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
      return new Response(null, { status: 101, webSocket: client, ...(offered.includes(SOCKET_PROTOCOL) ? { headers: { "Sec-WebSocket-Protocol": SOCKET_PROTOCOL } } : {}) });
    }

    const user = JSON.parse(request.headers.get(HUB_USER_HEADER)!) as PresenceEntry;
    this.ctx.acceptWebSocket(server, ["agent"]);
    server.serializeAttachment({ ...user, kind: "agent", connectedAt: Date.now() } satisfies AgentAttachment);
    await this.#scheduleSweep();
    this.#send(server, { type: "visitors", visitors: this.#visitors() });
    this.#broadcastPresence();
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": SOCKET_PROTOCOL } });
  }

  /** RPC: a valid ChatGPT access token for this workspace (dev only), refreshing if needed. */
  async chatgptAccessToken(workspaceId: string, forceRefresh: boolean): Promise<string> {
    if (!this.#chatgpt) {
      const db = this.env.DB;
      const store: CredentialStore = {
        async load() {
          const row = await db.prepare("SELECT credentials FROM dev_chatgpt WHERE workspace_id = ?").bind(workspaceId).first<{ credentials: string }>();
          return row ? (JSON.parse(row.credentials) as ChatGPTCredentials) : undefined;
        },
        async save(credentials) {
          await db
            .prepare("INSERT INTO dev_chatgpt (workspace_id, credentials) VALUES (?, ?) ON CONFLICT (workspace_id) DO UPDATE SET credentials = excluded.credentials")
            .bind(workspaceId, JSON.stringify(credentials))
            .run();
        },
      };
      this.#chatgpt = new ChatGPTAuth(store);
    }
    return this.#chatgpt.getAccessToken({ forceRefresh });
  }

  /** RPC: forget the cached auth after credentials change. */
  async resetChatGPT(): Promise<void> {
    this.#chatgpt = undefined;
  }

  /**
   * RPC (S-08): an issue-tracker credential pasted in Settings. Kept in this object's storage,
   * not D1, so it's never in database exports, backups or the D1 console.
   */
  async trackerSecret(name: "github" | "linear"): Promise<string | null> {
    return (await this.ctx.storage.get<string>(`tracker-secret:${name}`)) ?? null;
  }

  /** RPC (S-08): save or (null) remove a tracker credential. */
  async setTrackerSecret(name: "github" | "linear", value: string | null): Promise<void> {
    if (value) await this.ctx.storage.put(`tracker-secret:${name}`, value);
    else await this.ctx.storage.delete(`tracker-secret:${name}`);
  }

  /** RPC: fan an event out to every connected agent. */
  async publish(event: HubEvent): Promise<void> {
    this.#broadcast(JSON.stringify(event));
  }

  /** RPC (I-02): teammates with a dashboard open right now. */
  async onlineAgentIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets("agent")) {
      if (!this.#alive(ws)) continue;
      const a = ws.deserializeAttachment() as AgentAttachment | null;
      if (a?.userId) ids.add(a.userId);
    }
    return [...ids];
  }

  /**
   * RPC (I-02): the round-robin turn. Picks from `candidates` (online, with their open-chat
   * counts) and records the turn, all inside this object, so simultaneous handoffs never pick
   * from the same stale order.
   */
  async claimNextAssignee(candidates: { userId: string; open: number }[], capacity: number): Promise<string | null> {
    const times = await this.ctx.storage.get<Record<string, number>>("assignment:last") ?? {};
    const picked = pickAssignee(candidates.map((c) => ({ ...c, lastAssignedAt: times[c.userId] ?? 0 })), capacity);
    if (picked) await this.ctx.storage.put("assignment:last", { ...times, [picked]: Date.now() });
    return picked;
  }

  /**
   * RPC (A-02): may a lazy topic-labelling pass start? True (and recorded) unless one started in
   * the last `minIntervalMs`; checked and set inside this object, so two callers never both win.
   */
  async claimTopicRun(minIntervalMs: number): Promise<boolean> {
    const last = (await this.ctx.storage.get<number>("topics:last-run")) ?? 0;
    const now = Date.now();
    if (now - last < minIntervalMs) return false;
    await this.ctx.storage.put("topics:last-run", now);
    return true;
  }

  /** RPC (W-08): is any teammate's dashboard open? Visitors only ever get this yes/no. */
  async agentsOnline(): Promise<boolean> {
    return this.ctx.getWebSockets("agent").some((ws) => this.#alive(ws));
  }

  /** RPC (V-07): deliver an agent's invite to a live visitor. False if they've left. */
  async invite(sessionId: string, invite: { id: string; body: string; from: string }): Promise<boolean> {
    const sockets = this.ctx.getWebSockets(`s:${sessionId}`);
    for (const ws of sockets) this.#send(ws, { t: "invite", ...invite } satisfies LiveServerEvent);
    return sockets.length > 0;
  }

  /** RPC: a live visitor started a chat; the list shows it (and who they are, if anonymous). */
  async linkSession(sessionId: string, contactId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(`s:${sessionId}`)) {
      const a = ws.deserializeAttachment() as VisitorAttachment;
      a.visitor.inChat = true;
      a.visitor.contact ??= { id: contactId, name: null, email: null, verified: false };
      ws.serializeAttachment(a);
      this.#broadcast(JSON.stringify({ type: "visitor", visitor: a.visitor } satisfies HubEvent));
    }
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    // Agents send nothing besides pings (auto-answered); only visitors talk here.
    const a = ws.deserializeAttachment() as VisitorAttachment | AgentAttachment | null;
    if (!a || a.kind !== "visitor" || typeof raw !== "string" || raw.length > 8000) return;
    let event: LiveClientEvent;
    try {
      event = JSON.parse(raw) as LiveClientEvent;
    } catch {
      return;
    }
    const v = a.visitor;
    if (event.t === "page") {
      v.page = { url: clip(event.url, 300), title: clip(event.title, 120) };
      v.pages++;
      if (v.pages === 1) {
        v.referrer = clip(event.ref, 200) || null;
        if (typeof event.start === "number" && event.start <= Date.now() && event.start > Date.now() - 86_400_000) v.startedAt = event.start;
        v.language = clip(event.lang, 20) || null;
        v.timezone = clip(event.tz, 60) || null;
      }
    } else if (event.t === "id") {
      const result = await this.#identify(a.inboxId, clip(event.token, 4000));
      this.#send(ws, { t: "id", ok: result.ok, ...(result.ok ? {} : { error: result.error }) } satisfies LiveServerEvent);
      if (!result.ok) return;
      v.contact = { ...result.contact, verified: true };
    } else {
      return;
    }
    ws.serializeAttachment(a);
    if (v.pages > 0) this.#broadcast(JSON.stringify({ type: "visitor", visitor: v } satisfies HubEvent));
  }

  async #identify(inboxId: string, token: string): Promise<{ ok: true; contact: { id: string; name: string | null; email: string | null } } | { ok: false; error: string }> {
    const inbox = await this.env.DB.prepare("SELECT workspace_id, identity_secret FROM inboxes WHERE id = ?").bind(inboxId).first<{ workspace_id: string; identity_secret: string | null }>();
    if (!inbox?.identity_secret) return { ok: false, error: "Identity verification isn't set up for this desk." };
    try {
      const identity = await verifyIdentityToken(token, inbox.identity_secret);
      const id = await upsertIdentified(this.env.DB, inbox.workspace_id, identity);
      return { ok: true, contact: { id, name: identity.name, email: identity.email } };
    } catch (error) {
      if (error instanceof IdentityError) return { ok: false, error: error.message };
      throw error;
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** Every minute while anyone is connected: drop sockets that stopped pinging. */
  override async alarm(): Promise<void> {
    let agentGone = false;
    for (const ws of this.ctx.getWebSockets()) {
      if (this.#alive(ws)) continue;
      const a = ws.deserializeAttachment() as VisitorAttachment | AgentAttachment | null;
      try {
        ws.close(1001, "No ping");
      } catch {
        // already closing
      }
      if (a?.kind === "visitor") {
        if (a.visitor.pages > 0) this.#broadcast(JSON.stringify({ type: "visitor_left", sessionId: a.visitor.sessionId } satisfies HubEvent));
      } else {
        agentGone = true;
      }
    }
    if (agentGone) this.#broadcastPresence();
    if (this.ctx.getWebSockets().some((ws) => this.#alive(ws))) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  /** Open, and pinged (or connected) within STALE_MS. Sockets from before connectedAt existed count only once they ping. */
  #alive(ws: WebSocket): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    const connected = (ws.deserializeAttachment() as { connectedAt?: number } | null)?.connectedAt ?? 0;
    return Date.now() - Math.max(pinged, connected) < STALE_MS;
  }

  async #scheduleSweep(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const a = ws.deserializeAttachment() as VisitorAttachment | AgentAttachment | null;
    if (a?.kind === "visitor") {
      if (a.visitor.pages > 0) this.#broadcast(JSON.stringify({ type: "visitor_left", sessionId: a.visitor.sessionId } satisfies HubEvent));
      return;
    }
    this.#broadcastPresence(ws);
  }

  #visitors(): LiveVisitor[] {
    // One row per browser session: a reconnect can briefly overlap the old socket.
    const out = new Map<string, VisitorAttachment>();
    for (const ws of this.ctx.getWebSockets("visitor")) {
      if (!this.#alive(ws)) continue;
      const a = ws.deserializeAttachment() as VisitorAttachment | null;
      if (!a || a.visitor.pages === 0) continue;
      const seen = out.get(a.visitor.sessionId);
      if (!seen || (a.connectedAt ?? 0) > (seen.connectedAt ?? 0)) out.set(a.visitor.sessionId, a);
    }
    return [...out.values()].map((a) => a.visitor);
  }

  #broadcastPresence(closing?: WebSocket): void {
    const online = new Map<string, PresenceEntry>();
    for (const ws of this.ctx.getWebSockets("agent")) {
      if (ws === closing || !this.#alive(ws)) continue;
      const user = ws.deserializeAttachment() as AgentAttachment | null;
      if (user) online.set(user.userId, { userId: user.userId, name: user.name });
    }
    this.#broadcast(JSON.stringify({ type: "presence", online: [...online.values()] } satisfies HubEvent), closing);
  }

  /** To agents only: visitors never see inbox events or other visitors. */
  #broadcast(data: string, except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets("agent")) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(data);
      } catch {
        // closing
      }
    }
  }

  #send(ws: WebSocket, event: HubEvent | LiveServerEvent): void {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      // closing
    }
  }
}

