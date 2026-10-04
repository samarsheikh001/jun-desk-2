import { DurableObject } from "cloudflare:workers";

/**
 * One instance per conversation: live state (sockets, typing, presence, the AI loop),
 * writing through to D1, which stays the source of truth (D-11).
 *
 * Stub in M0 so the Deploy button provisions the namespace; implemented in M1.
 */
export class Conversation extends DurableObject<Env> {
  override async fetch(): Promise<Response> {
    return new Response("Not implemented yet", { status: 501 });
  }
}
