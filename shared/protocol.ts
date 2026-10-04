// Shared by the Worker, the dashboard and the widget. Plain TypeScript with no Worker,
// DOM or Node APIs, so every tsconfig can include this file.

export type ConversationStatus = "open" | "pending" | "snoozed" | "resolved";
export type AuthorType = "visitor" | "agent" | "ai" | "system";

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
}

export interface ConversationSummary {
  id: string;
  status: ConversationStatus;
  assigneeId: string | null;
  contact: { id: string; name: string | null; email: string | null };
  lastSeq: number;
  lastMessageAt: number;
  lastMessagePreview: string | null;
  lastMessageAuthor: AuthorType | null;
  agentReadSeq: number;
  visitorReadSeq: number;
  createdAt: number;
}

/** Messages a client sends on a conversation socket. */
export type ClientEvent =
  | { type: "send"; clientMsgId: string; body: string; attachments?: Attachment[] }
  | { type: "typing"; typing: boolean }
  | { type: "read"; seq: number };

/** Messages the conversation socket sends. */
export type ConversationEvent =
  | { type: "messages"; messages: Message[] } // backlog after `?since=` on connect
  | { type: "message"; message: Message }
  | { type: "typing"; authorType: "visitor" | "agent"; name: string | null; typing: boolean }
  | { type: "read"; by: "visitor" | "agent"; seq: number }
  | { type: "conversation"; conversation: ConversationSummary }
  | { type: "error"; code: string; message: string; clientMsgId?: string };

export interface PresenceEntry {
  userId: string;
  name: string;
}

/** Messages the workspace hub socket sends to agents. */
export type HubEvent =
  | { type: "conversation"; conversation: ConversationSummary }
  | { type: "presence"; online: PresenceEntry[] };

/** WebSocket subprotocol. Visitors send their token as a second subprotocol value. */
export const SOCKET_PROTOCOL = "jun";

export const MAX_MESSAGE_LENGTH = 10_000;
export const MAX_ATTACHMENTS = 10;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
