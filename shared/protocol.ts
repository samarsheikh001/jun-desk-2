// Shared by the Worker, the dashboard and the widget. Plain TypeScript with no Worker,
// DOM or Node APIs, so every tsconfig can include this file.

import type { NotificationPayload } from "./notifications.ts";

export type ConversationStatus = "open" | "pending" | "snoozed" | "resolved";
export type AuthorType = "visitor" | "agent" | "ai" | "system";
/** Who is answering right now: the AI agent, or a human after handoff/takeover. */
export type Handling = "ai" | "human";
/** W-12: the visitor's thumbs up or down at the end of a conversation. */
export type CsatRating = "good" | "bad";

export interface Source {
  title: string;
  url: string | null;
}

export interface MessageMeta {
  /** Knowledge the AI answer cites, in citation order ([1] = sources[0]). */
  sources?: Source[];
  /** Questions the visitor might ask next, under an AI answer (tapping one sends it). */
  followUps?: string[];
  /** Why the AI handed off (on handoff system messages). */
  handoffReason?: string;
  /** Agent config version that wrote an AI answer (AI-18). */
  configVersion?: number;
  /** I-10: the automatic "we're away" reply. */
  away?: boolean;
  /** I-05: user ids @mentioned in an internal note. */
  mentions?: string[];
  /** S-08: on the internal "Issue created" note. */
  issue?: ConversationIssue;
}

export type IssueProvider = "github" | "linear";

/** S-08: an issue an agent filed from a conversation (agents only). */
export interface ConversationIssue {
  id: string;
  provider: IssueProvider;
  /** GitHub "owner/name", or the Linear team key. */
  target: string;
  /** Linear issue id; GitHub issue number as text. */
  externalId: string;
  /** For display: "owner/name#123" or "ENG-42". */
  key: string;
  url: string;
  title: string;
  createdBy: string | null;
  createdAt: number;
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
  /** I-07: agents only; always [] for visitors. */
  tags: string[];
  /** A-02: the AI's topic label, agents only; always null for visitors. */
  topic: { id: string; name: string } | null;
  /**
   * W-12: the latest rating (null if never rated), and whether it was given since the conversation
   * was last resolved (always false while it isn't resolved). The widget asks while a resolved
   * conversation isn't `ratedThisRound`.
   */
  csat: { rating: CsatRating | null; ratedThisRound: boolean };
}

/** Messages a client sends on a conversation socket. */
export type ClientEvent =
  /** `context`: the visitor's debug snapshot from the loader (visitors only; see shared/debug.ts). */
  /** `internal`: an agent's note (I-05), never shown to the visitor or the AI. */
  | { type: "send"; clientMsgId: string; body: string; attachments?: Attachment[]; context?: unknown; internal?: boolean }
  | { type: "typing"; typing: boolean }
  | { type: "read"; seq: number }
  /** Visitor asks for a person (W-07). */
  | { type: "handoff" };

/** One tool call as the visitor sees it (`ai_step`): a label and whether it's still running. */
export interface AiStep {
  id: string;
  label: string;
  state: "running" | "done";
}

/** Messages the conversation socket sends. */
export type ConversationEvent =
  | { type: "messages"; messages: Message[] } // backlog after `?since=` on connect
  | { type: "message"; message: Message }
  | { type: "typing"; authorType: "visitor" | "agent"; name: string | null; typing: boolean }
  | { type: "read"; by: "visitor" | "agent"; seq: number }
  | { type: "conversation"; conversation: ConversationSummary }
  /** The AI is working on a reply ("thinking") or streaming one; text accumulates per streamId. */
  | { type: "ai_status"; state: "thinking" | "idle" }
  /**
   * `replace`: `text` is the whole reply so far (sent to late joiners), not an increment.
   * Citations arrive resolved; `sources`, when present, is every source cited so far.
   */
  | { type: "ai_delta"; streamId: string; text: string; replace?: boolean; sources?: Source[] }
  /**
   * Visitors and agents: the AI is using a tool for the reply with clientMsgId `turn` (`ai:<seq>`).
   * Visitor-safe by construction: `label` is the tool's admin-written `status:` (or a generic one) and
   * `id` is an opaque per-turn counter, never the tool's name, inputs, output, URL or errors. A failed
   * call still ends `done`. Ephemeral: not stored, so history shows no steps.
   */
  | { type: "ai_step"; turn: string; step: AiStep }
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
  /** Approximate [lat, lng] from Cloudflare's IP geolocation, rounded to 1 decimal (~10 km): the Visitors globe. */
  location: [number, number] | null;
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
  | { type: "visitor_left"; sessionId: string }
  /** I-05: someone was @mentioned in a note; each dashboard checks whether it's them. */
  | { type: "mention"; conversationId: string; userIds: string[]; by: string; preview: string }
  /**
   * I-14: sent only to the recipient's own sockets. `toast`: one of their desk tabs is focused, so
   * no push was sent and the visible tab handles it in-app. `system`: no focused tab; a hidden tab
   * shows a system notification (a push of the same event, same tag and id, replaces it silently).
   */
  | { type: "notify"; notification: NotificationPayload; mode: "toast" | "system" };

/** Dashboard → hub: whether this tab is visible and focused (I-14: no push while you're looking). */
export type HubClientEvent = { type: "focus"; focused: boolean };

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
/** K-02: knowledge files (PDF, DOCX, Markdown, text): per-file size and per-workspace count. */
export const MAX_KB_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_KB_FILES = 200;
export const KB_FILE_EXTENSIONS = [".pdf", ".docx", ".md", ".markdown", ".txt"];
/** W-12: the optional comment with a rating. */
export const MAX_CSAT_COMMENT = 1000;

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
