// A-01: core metrics. Pure (Intl only): the Worker fetches one row of facts per conversation,
// the CSAT ratings and per-teammate reply counts for the period, and this turns them into the
// report the dashboard shows. Days are calendar days in the viewer's time zone (DST-safe).

export const METRIC_PERIODS = [7, 30, 90] as const;
export type MetricPeriod = (typeof METRIC_PERIODS)[number];
/** Most conversations a report reads; beyond this it covers the newest ones and says so. */
export const MAX_METRIC_CONVERSATIONS = 20_000;

/** One conversation started in the period, as aggregated in SQL. Times are epoch ms. */
export interface ConversationFacts {
  id: string;
  createdAt: number;
  resolved: boolean;
  /** First message from the visitor (null for a conversation without one). */
  firstVisitorAt: number | null;
  /** First public AI answer. */
  firstAiAt: number | null;
  /** First public agent reply at or after the first visitor message (internal notes don't count). */
  firstAgentAt: number | null;
  firstAgentId: string | null;
  /** Reason on the first public handoff message, or null if it was never handed off. */
  handoffReason: string | null;
}

export interface RatingRow {
  conversationId: string;
  rating: "good" | "bad";
  comment: string | null;
  createdAt: number;
}

/** Public agent replies sent in the period, per author (aggregated in SQL). */
export interface ReplyRow {
  userId: string;
  replies: number;
  conversations: number;
}

export interface MetricsInput {
  now: number;
  days: MetricPeriod;
  timezone: string;
  conversations: ConversationFacts[];
  ratings: RatingRow[];
  replies: ReplyRow[];
  members: { userId: string; name: string }[];
  /** The conversation rows were capped at MAX_METRIC_CONVERSATIONS. */
  truncated: boolean;
}

export interface DurationStat {
  count: number;
  median: number | null;
  p90: number | null;
}

export interface DayPoint {
  /** "2026-10-05", in the report's time zone. */
  day: string;
  conversations: number;
  aiResolved: number;
}

export interface MetricsReport {
  days: MetricPeriod;
  timezone: string;
  since: number;
  until: number;
  truncated: boolean;
  conversations: { total: number; resolved: number; series: DayPoint[] };
  ai: {
    /** Conversations the AI answered, or that were handed off from the AI. */
    conversations: number;
    /** …that the AI handled alone: no handoff and no public agent reply. */
    resolved: number;
    handedOff: number;
    resolutionRate: number | null;
    handoffRate: number | null;
    firstResponse: DurationStat;
    reasons: { reason: string; count: number }[];
  };
  team: { answered: number; firstResponse: DurationStat };
  csat: { good: number; bad: number; score: number | null; badComments: { conversationId: string; comment: string; createdAt: number }[] };
  teammates: { userId: string; name: string; replies: number; conversations: number; firstResponse: DurationStat }[];
}

/** `days` from a query string, or null if it isn't one of the periods. */
export function parsePeriod(raw: string | null | undefined): MetricPeriod | null {
  const n = Number(raw);
  return (METRIC_PERIODS as readonly number[]).includes(n) && String(n) === raw ? (n as MetricPeriod) : null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsAt(t: number, timezone: string): Record<string, number> {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formatters.set(timezone, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(t))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

/** The calendar day of `t` in `timezone`, as "YYYY-MM-DD". */
export function dayKey(t: number, timezone: string): string {
  const p = partsAt(t, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** "2026-10-05" plus n days (calendar arithmetic, no time zone involved). */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Local time minus UTC at `t`, in ms. */
function offsetAt(t: number, timezone: string): number {
  const p = partsAt(t, timezone);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(t / 1000) * 1000;
}

/** When the day `key` starts in `timezone` (epoch ms). Two passes so a DST change that day is right. */
export function startOfDay(key: string, timezone: string): number {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  const guess = utc - offsetAt(utc, timezone);
  return utc - offsetAt(guess, timezone);
}

/** The period: today and the days before it, `days` calendar days in all. */
export function periodDays(now: number, days: number, timezone: string): { keys: string[]; since: number; until: number } {
  const today = dayKey(now, timezone);
  const keys = Array.from({ length: days }, (_, i) => addDays(today, i - days + 1));
  return { keys, since: startOfDay(keys[0]!, timezone), until: startOfDay(addDays(today, 1), timezone) };
}

/** Median (mean of the middle two for an even count) and p90 (nearest rank) of durations. */
export function durationStat(values: number[]): DurationStat {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { count: 0, median: null, p90: null };
  const median = n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  return { count: n, median, p90: sorted[Math.ceil(0.9 * n) - 1]! };
}

/**
 * Groups handoff reasons that differ only in details: "AI error: <message>" and "Bug flagged by
 * the AI: <what broke>" become one line each, as does the reply cap's number.
 */
export function handoffReasonLabel(reason: string): string {
  const text = reason.trim().replace(/\s+/g, " ");
  const prefix = /^(Bug flagged by the AI|AI error|AI unavailable):/i.exec(text);
  if (prefix) return prefix[1]!;
  if (/^Monthly AI reply cap \(\d+\) reached/i.test(text)) return "Monthly AI reply cap reached";
  const label = text.replace(/\.$/, "");
  return label.length > 120 ? `${label.slice(0, 119)}…` : label || "No reason given";
}

/** "45s", "3m", "1h 20m", "2d 4h". */
export function formatDuration(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const rate = (part: number, whole: number) => (whole ? part / whole : null);

export function computeMetrics(input: MetricsInput): MetricsReport {
  const { keys, since, until } = periodDays(input.now, input.days, input.timezone);
  // Day boundaries once, then a binary search per row: no Intl call per conversation.
  const starts = [...keys.map((k) => startOfDay(k, input.timezone)), until];
  const dayIndex = (t: number): number => {
    if (t < since || t >= until) return -1;
    let lo = 0;
    let hi = keys.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const series: DayPoint[] = keys.map((day) => ({ day, conversations: 0, aiResolved: 0 }));
  let total = 0;
  let resolved = 0;
  let aiConversations = 0;
  let aiResolved = 0;
  let handedOff = 0;
  const aiTimes: number[] = [];
  const teamTimes: number[] = [];
  const byAgent = new Map<string, number[]>();
  const reasons = new Map<string, { reason: string; count: number }>();

  for (const c of input.conversations) {
    const i = dayIndex(c.createdAt);
    if (i === -1) continue;
    total++;
    series[i]!.conversations++;
    if (c.resolved) resolved++;

    // A handoff only happens from the AI, so a handed-off conversation was the AI's even if it
    // never got to answer (the visitor asked for a person first, or its first reply was a handoff).
    const handed = c.handoffReason !== null;
    if (c.firstAiAt !== null || handed) {
      aiConversations++;
      if (handed) {
        handedOff++;
        const label = handoffReasonLabel(c.handoffReason!);
        const key = label.toLowerCase();
        const entry = reasons.get(key) ?? { reason: label, count: 0 };
        entry.count++;
        reasons.set(key, entry);
      } else if (c.firstAgentAt === null) {
        aiResolved++;
        series[i]!.aiResolved++;
      }
    }
    if (c.firstVisitorAt !== null && c.firstAiAt !== null && c.firstAiAt >= c.firstVisitorAt) aiTimes.push(c.firstAiAt - c.firstVisitorAt);
    if (c.firstVisitorAt !== null && c.firstAgentAt !== null && c.firstAgentAt >= c.firstVisitorAt) {
      const ms = c.firstAgentAt - c.firstVisitorAt;
      teamTimes.push(ms);
      if (c.firstAgentId) {
        const list = byAgent.get(c.firstAgentId) ?? [];
        list.push(ms);
        byAgent.set(c.firstAgentId, list);
      }
    }
  }

  let good = 0;
  let bad = 0;
  const badComments: MetricsReport["csat"]["badComments"] = [];
  for (const r of [...input.ratings].sort((a, b) => b.createdAt - a.createdAt)) {
    if (dayIndex(r.createdAt) === -1) continue;
    if (r.rating === "good") good++;
    else {
      bad++;
      const comment = r.comment?.trim();
      if (comment && badComments.length < 5) badComments.push({ conversationId: r.conversationId, comment, createdAt: r.createdAt });
    }
  }

  // Every member, plus anyone who replied and has since left the team.
  const replies = new Map(input.replies.map((r) => [r.userId, r]));
  const names = new Map(input.members.map((m) => [m.userId, m.name]));
  const ids = new Set([...names.keys(), ...replies.keys(), ...byAgent.keys()]);
  const teammates = [...ids]
    .map((userId) => ({
      userId,
      name: names.get(userId) ?? "Former teammate",
      replies: replies.get(userId)?.replies ?? 0,
      conversations: replies.get(userId)?.conversations ?? 0,
      firstResponse: durationStat(byAgent.get(userId) ?? []),
    }))
    .sort((a, b) => b.replies - a.replies || a.name.localeCompare(b.name));

  return {
    days: input.days,
    timezone: input.timezone,
    since,
    until,
    truncated: input.truncated,
    conversations: { total, resolved, series },
    ai: {
      conversations: aiConversations,
      resolved: aiResolved,
      handedOff,
      resolutionRate: rate(aiResolved, aiConversations),
      handoffRate: rate(handedOff, aiConversations),
      firstResponse: durationStat(aiTimes),
      reasons: [...reasons.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 5),
    },
    team: { answered: teamTimes.length, firstResponse: durationStat(teamTimes) },
    csat: { good, bad, score: rate(good, good + bad), badComments },
    teammates,
  };
}
