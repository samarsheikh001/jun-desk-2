import type { Attachment, AuthorType, ConversationStatus, ConversationSummary, Handling, Message, MessageMeta } from "../../shared/protocol.ts";

export const SUMMARY_SELECT = `
  SELECT c.id, c.status, c.handling, c.assignee_id, c.last_seq, c.last_message_at, c.last_message_preview,
         c.last_message_author, c.agent_read_seq, c.visitor_read_seq, c.created_at, c.debug_issue_count,
         ct.id AS contact_id, ct.name AS contact_name, ct.email AS contact_email, ct.verified_at AS contact_verified_at
  FROM conversations c JOIN contacts ct ON ct.id = c.contact_id`;

export interface SummaryRow {
  id: string;
  status: ConversationStatus;
  handling: Handling;
  assignee_id: string | null;
  last_seq: number;
  last_message_at: number;
  last_message_preview: string | null;
  last_message_author: AuthorType | null;
  agent_read_seq: number;
  visitor_read_seq: number;
  created_at: number;
  debug_issue_count: number;
  contact_id: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_verified_at: number | null;
}

export function toSummary(row: SummaryRow): ConversationSummary {
  return {
    id: row.id,
    status: row.status,
    handling: row.handling,
    assigneeId: row.assignee_id,
    contact: { id: row.contact_id, name: row.contact_name, email: row.contact_email, verified: row.contact_verified_at !== null },
    lastSeq: row.last_seq,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    lastMessageAuthor: row.last_message_author,
    agentReadSeq: row.agent_read_seq,
    visitorReadSeq: row.visitor_read_seq,
    createdAt: row.created_at,
    debugIssueCount: row.debug_issue_count,
  };
}

export async function loadSummary(db: D1Database, conversationId: string): Promise<ConversationSummary | null> {
  const row = await db.prepare(`${SUMMARY_SELECT} WHERE c.id = ?`).bind(conversationId).first<SummaryRow>();
  return row ? toSummary(row) : null;
}

export const MESSAGE_SELECT = `
  SELECT m.id, m.seq, m.author_type, m.author_id, u.name AS author_name, m.body, m.attachments,
         m.client_msg_id, m.created_at, m.internal, m.meta
  FROM messages m LEFT JOIN users u ON m.author_type = 'agent' AND u.id = m.author_id`;

export interface MessageRow {
  id: string;
  seq: number;
  author_type: AuthorType;
  author_id: string | null;
  author_name: string | null;
  body: string;
  attachments: string;
  client_msg_id: string;
  created_at: number;
  internal: number;
  meta: string;
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    seq: row.seq,
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    attachments: JSON.parse(row.attachments) as Attachment[],
    clientMsgId: row.client_msg_id,
    createdAt: row.created_at,
    internal: row.internal === 1,
    meta: JSON.parse(row.meta) as MessageMeta,
  };
}

/**
 * Messages with seq > `since`, oldest first, at most `limit` (the most recent ones).
 * Internal messages (agent-only notes) are included only when `includeInternal`.
 */
export async function loadMessages(
  db: D1Database,
  conversationId: string,
  options: { since?: number; limit?: number; includeInternal: boolean },
): Promise<Message[]> {
  const internal = options.includeInternal ? "" : "AND m.internal = 0";
  const rows = await db
    .prepare(`SELECT * FROM (${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.seq > ? ${internal} ORDER BY m.seq DESC LIMIT ?) ORDER BY seq`)
    .bind(conversationId, options.since ?? 0, options.limit ?? 200)
    .all<MessageRow>();
  return rows.results.map(toMessage);
}

/** Short one-line preview for inbox lists. */
export function preview(body: string, attachments: Attachment[]): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text;
  if (attachments.length) return attachments.length === 1 ? `📎 ${attachments[0]!.name}` : `📎 ${attachments.length} files`;
  return "";
}
