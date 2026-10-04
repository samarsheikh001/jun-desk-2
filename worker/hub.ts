import { DurableObject } from "cloudflare:workers";
import { ChatGPTAuth, type ChatGPTCredentials, type CredentialStore } from "@jun/llm";
import { SOCKET_PROTOCOL, type HubEvent, type PresenceEntry } from "../shared/protocol.ts";

export const HUB_USER_HEADER = "x-jun-user";

/**
 * One instance per workspace. Agents' dashboards keep a socket open here to get inbox
 * updates (from Conversation objects) and to see which teammates are online. It also
 * owns dev-only ChatGPT token refresh: refresh tokens rotate, so exactly one place may
 * refresh them.
 */
export class WorkspaceHub extends DurableObject<Env> {
  #chatgpt: ChatGPTAuth | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const user = JSON.parse(request.headers.get(HUB_USER_HEADER)!) as PresenceEntry;
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(user);
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

  /** RPC: fan an event out to every connected agent. */
  async publish(event: HubEvent): Promise<void> {
    this.#broadcast(JSON.stringify(event));
  }

  override async webSocketMessage(): Promise<void> {
    // Agents don't send anything here besides pings, which are auto-answered.
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.#broadcastPresence(ws);
  }

  #broadcastPresence(closing?: WebSocket): void {
    const online = new Map<string, PresenceEntry>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing || ws.readyState !== WebSocket.OPEN) continue;
      const user = ws.deserializeAttachment() as PresenceEntry | null;
      if (user) online.set(user.userId, user);
    }
    this.#broadcast(JSON.stringify({ type: "presence", online: [...online.values()] } satisfies HubEvent), closing);
  }

  #broadcast(data: string, except?: WebSocket): void {
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
