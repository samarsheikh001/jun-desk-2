import { DurableObject } from "cloudflare:workers";
import { SOCKET_PROTOCOL, type HubEvent, type PresenceEntry } from "../shared/protocol.ts";

export const HUB_USER_HEADER = "x-jun-user";

/**
 * One instance per workspace. Agents' dashboards keep a socket open here to get inbox
 * updates (from Conversation objects) and to see which teammates are online.
 */
export class WorkspaceHub extends DurableObject<Env> {
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
