// Shared by the Worker, the dashboard and the widget. Plain TypeScript with no Worker,
// DOM or Node APIs, so every tsconfig can include this file.

export type ConversationStatus = "open" | "pending" | "snoozed" | "resolved";
export type AuthorType = "visitor" | "agent" | "ai" | "system";
/** Who is answering right now: the AI agent, or a human after handoff/takeover. */
export type Handling = "ai" | "human";

export interface Source {
  title: string;
  url: string | null;
}

export interface MessageMeta {
  /** Knowledge the AI answer cites, in citation order ([1] = sources[0]). */
  sources?: Source[];
  /** Why the AI handed off (on handoff system messages). */
  handoffReason?: string;
  /** Agent config version that wrote an AI answer (AI-18). */
  configVersion?: number;
  /** I-10: the automatic "we're away" reply. */
  away?: boolean;
}

export interface Attachment {
  key: string;
  name: string;
  size: number;
  type: string;
}

export interface Message {
  id: string;
  seq: number;
  authorType: AuthorType;
  authorId: string | null;
  /** Display name for agents; null for visitors (the UI knows who the contact is). */
  authorName: string | null;
  body: string;
  attachments: Attachment[];
  clientMsgId: string;
  createdAt: number;
  /** Shown to agents only (handoff briefs, takeover notes). */
  internal: boolean;
  meta: MessageMeta;
}

export interface ConversationSummary {
  id: string;
  status: ConversationStatus;
  handling: Handling;
  assigneeId: string | null;
  contact: { id: string; name: string | null; email: string | null; verified: boolean };
  lastSeq: number;
  lastMessageAt: number;
  lastMessagePreview: string | null;
  lastMessageAuthor: AuthorType | null;
  agentReadSeq: number;
  visitorReadSeq: number;
  createdAt: number;
  /** Errors + failed requests in the visitor's latest browser snapshot (P1). */
  debugIssueCount: number;
}

/** Messages a client sends on a conversation socket. */
export type ClientEvent =
  /** `context`: the visitor's debug snapshot from the loader (visitors only; see shared/debug.ts). */
  | { type: "send"; clientMsgId: string; body: string; attachments?: Attachment[]; context?: unknown }
  | { type: "typing"; typing: boolean }
  | { type: "read"; seq: number }
  /** Visitor asks for a person (W-07). */
  | { type: "handoff" };

/** Messages the conversation socket sends. */
export type ConversationEvent =
  | { type: "messages"; messages: Message[] } // backlog after `?since=` on connect
  | { type: "message"; message: Message }
  | { type: "typing"; authorType: "visitor" | "agent"; name: string | null; typing: boolean }
  | { type: "read"; by: "visitor" | "agent"; seq: number }
  | { type: "conversation"; conversation: ConversationSummary }
  /** The AI is working on a reply ("thinking") or streaming one; text accumulates per streamId. */
  | { type: "ai_status"; state: "thinking" | "idle" }
  /** `replace`: `text` is the whole reply so far (sent to late joiners), not an increment. */
  | { type: "ai_delta"; streamId: string; text: string; replace?: boolean }
  /** Agents only: the AI called a tool (AI-11). Details via GET /api/conversations/:id/actions. */
  | { type: "ai_action"; tool: string; status: "ok" | "error" }
  | { type: "error"; code: string; message: string; clientMsgId?: string };

/** V-01: a visitor on the customer's site right now (from the loader's live connection). */
export interface LiveVisitor {
  sessionId: string;
  /** Known once they identify (verified) or start a chat. */
  contact: { id: string; name: string | null; email: string | null; verified: boolean } | null;
  page: { url: string; title: string };
  referrer: string | null;
  /** Pages viewed this session. */
  pages: number;
  /** When the session started (first page), per the visitor's browser. */
  startedAt: number;
  country: string | null;
  city: string | null;
  userAgent: string;
  language: string | null;
  timezone: string | null;
  inChat: boolean;
}

export interface PresenceEntry {
  userId: string;
  name: string;
}

/** Messages the workspace hub socket sends to agents. */
export type HubEvent =
  | { type: "conversation"; conversation: ConversationSummary }
  | { type: "presence"; online: PresenceEntry[] }
  /** V-01: full list on connect, then one event per change. */
  | { type: "visitors"; visitors: LiveVisitor[] }
  | { type: "visitor"; visitor: LiveVisitor }
  | { type: "visitor_left"; sessionId: string };

/** Loader → hub on the live connection. Short keys: this travels from every page view. */
export type LiveClientEvent =
  | { t: "page"; url: string; title?: string; ref?: string; start?: number; lang?: string; tz?: string }
  | { t: "id"; token: string };

/** Hub → loader. */
export type LiveServerEvent =
  | { t: "invite"; id: string; body: string; from: string }
  | { t: "id"; ok: boolean; error?: string };

/** WebSocket subprotocol. Visitors send their token as a second subprotocol value. */
export const SOCKET_PROTOCOL = "jun";

export const MAX_MESSAGE_LENGTH = 10_000;
export const MAX_ATTACHMENTS = 10;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** AI-11: one tool call the AI made (agents only). */
export interface AiAction {
  id: string;
  messageSeq: number;
  configVersion: number | null;
  tool: string;
  input: Record<string, unknown>;
  output: string | null;
  status: "ok" | "error";
  httpStatus: number | null;
  durationMs: number;
  createdAt: number;
}
