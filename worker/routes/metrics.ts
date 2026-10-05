import { Hono } from "hono";
import { validTimezone } from "../../shared/hours.ts";
import { computeMetrics, MAX_METRIC_CONVERSATIONS, parsePeriod, periodDays, type ConversationFacts, type RatingRow, type ReplyRow } from "../../shared/metrics.ts";
import { requireUser } from "../auth/session.ts";
import { HttpError, type AppEnv } from "../types.ts";

// A-01: core metrics for the last 7, 30 or 90 days. SQL aggregates one row per conversation
// (and per teammate); shared/metrics.ts does the counting, medians and day buckets.

export const metrics = new Hono<AppEnv>();
metrics.use("/workspaces/:id/metrics", requireUser);

// The first message of each kind per conversation, via the (conversation_id, seq) index.
// Internal notes and system messages are never replies; an agent's invite (V-07) comes before
// the visitor's first message, so agent replies count from that message on.
const CONVERSATION_FACTS = `
  SELECT x.*,
    (SELECT a.created_at FROM messages a WHERE a.conversation_id = x.id AND a.author_type = 'agent' AND a.internal = 0 AND a.created_at >= x.firstVisitorAt ORDER BY a.seq LIMIT 1) AS firstAgentAt,
    (SELECT a.author_id FROM messages a WHERE a.conversation_id = x.id AND a.author_type = 'agent' AND a.internal = 0 AND a.created_at >= x.firstVisitorAt ORDER BY a.seq LIMIT 1) AS firstAgentId
  FROM (
    SELECT c.id, c.created_at AS createdAt, c.status = 'resolved' AS resolved,
      (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.author_type = 'visitor') AS firstVisitorAt,
      (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.author_type = 'ai' AND m.internal = 0) AS firstAiAt,
      -- The visitor-facing handoff notice (the internal brief carries the same reason).
      (SELECT json_extract(m.meta, '$.handoffReason') FROM messages m
        WHERE m.conversation_id = c.id AND m.author_type = 'system' AND m.internal = 0 AND json_extract(m.meta, '$.handoffReason') IS NOT NULL
        ORDER BY m.seq LIMIT 1) AS handoffReason
    FROM conversations c
    WHERE c.workspace_id = ?1 AND c.created_at >= ?2 AND c.created_at < ?3
    ORDER BY c.created_at DESC LIMIT ?4
  ) x`;

metrics.get("/workspaces/:id/metrics", async (c) => {
  const workspaceId = c.req.param("id");
  const member = await c.env.DB.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first();
  if (!member) throw new HttpError(404, "not_found", "Workspace not found.");

  const days = parsePeriod(c.req.query("days") ?? "7");
  if (!days) throw new HttpError(400, "invalid_field", "days must be 7, 30 or 90.");
  const timezone = c.req.query("tz") || "UTC";
  if (!validTimezone(timezone)) throw new HttpError(400, "invalid_field", "Unknown time zone.");

  const now = Date.now();
  const { since, until } = periodDays(now, days, timezone);
  const db = c.env.DB;
  const [conversations, ratings, replies, members] = await db.batch([
    db.prepare(CONVERSATION_FACTS).bind(workspaceId, since, until, MAX_METRIC_CONVERSATIONS + 1),
    db.prepare(
      `SELECT conversation_id AS conversationId, rating, CASE WHEN rating = 'bad' THEN comment END AS comment, created_at AS createdAt
       FROM csat_ratings WHERE workspace_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
    ).bind(workspaceId, since, until, MAX_METRIC_CONVERSATIONS),
    db.prepare(
      `SELECT m.author_id AS userId, COUNT(*) AS replies, COUNT(DISTINCT m.conversation_id) AS conversations
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.workspace_id = ? AND m.author_type = 'agent' AND m.internal = 0 AND m.author_id IS NOT NULL AND m.created_at >= ? AND m.created_at < ?
       GROUP BY m.author_id`,
    ).bind(workspaceId, since, until),
    db.prepare("SELECT u.id AS userId, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?").bind(workspaceId),
  ]);

  const rows = (conversations!.results as unknown as (Omit<ConversationFacts, "resolved"> & { resolved: number })[]).map((r) => ({ ...r, resolved: r.resolved === 1 }));
  const truncated = rows.length > MAX_METRIC_CONVERSATIONS;
  return c.json({
    report: computeMetrics({
      now,
      days,
      timezone,
      conversations: truncated ? rows.slice(0, MAX_METRIC_CONVERSATIONS) : rows,
      ratings: ratings!.results as unknown as RatingRow[],
      replies: replies!.results as unknown as ReplyRow[],
      members: members!.results as unknown as { userId: string; name: string }[],
      truncated,
    }),
  });
});
