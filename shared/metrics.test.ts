import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDays,
  computeMetrics,
  dayKey,
  durationStat,
  formatDuration,
  handoffReasonLabel,
  parsePeriod,
  periodDays,
  startOfDay,
  type ConversationFacts,
  type MetricsInput,
} from "./metrics.ts";

const S = 1000;
const MIN = 60 * S;
// Monday 5 Oct 2026, 12:00 UTC.
const NOW = Date.parse("2026-10-05T12:00:00Z");

let n = 0;
function conv(at: number, facts: Partial<ConversationFacts> = {}): ConversationFacts {
  return { id: `cv_${++n}`, createdAt: at, resolved: false, firstVisitorAt: at, firstAiAt: null, firstAgentAt: null, firstAgentId: null, handoffReason: null, ...facts };
}
const input = (over: Partial<MetricsInput>): MetricsInput => ({
  now: NOW,
  days: 7,
  timezone: "UTC",
  conversations: [],
  ratings: [],
  replies: [],
  members: [],
  truncated: false,
  ...over,
});

test("periods: only 7, 30 and 90 days", () => {
  assert.equal(parsePeriod("7"), 7);
  assert.equal(parsePeriod("90"), 90);
  for (const bad of ["14", "", null, undefined, "7.0", " 7", "abc", "-7"]) assert.equal(parsePeriod(bad), null, String(bad));
});

test("days are calendar days in the time zone, DST included", () => {
  assert.equal(dayKey(Date.parse("2026-10-05T23:30:00Z"), "UTC"), "2026-10-05");
  assert.equal(dayKey(Date.parse("2026-10-05T23:30:00Z"), "Europe/Berlin"), "2026-10-06");
  assert.equal(dayKey(Date.parse("2026-10-05T02:00:00Z"), "America/New_York"), "2026-10-04");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(startOfDay("2026-10-05", "America/New_York"), Date.parse("2026-10-05T04:00:00Z")); // EDT
  // Clocks go back in Berlin on 25 Oct 2026: that day starts at UTC+2, the next at UTC+1.
  assert.equal(startOfDay("2026-10-25", "Europe/Berlin"), Date.parse("2026-10-24T22:00:00Z"));
  assert.equal(startOfDay("2026-10-26", "Europe/Berlin"), Date.parse("2026-10-25T23:00:00Z"));
  assert.equal(startOfDay("2026-10-05", "Asia/Kolkata"), Date.parse("2026-10-04T18:30:00Z"));

  const p = periodDays(NOW, 7, "UTC");
  assert.deepEqual(p.keys, ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
  assert.equal(p.since, Date.parse("2026-09-29T00:00:00Z"));
  assert.equal(p.until, Date.parse("2026-10-06T00:00:00Z"));
  assert.equal(periodDays(NOW, 90, "UTC").keys.length, 90);
});

test("conversations: counted per day of the period, outside it ignored", () => {
  const r = computeMetrics(
    input({
      conversations: [
        conv(NOW),
        conv(NOW - 2 * 60 * MIN),
        conv(Date.parse("2026-09-29T00:00:00Z"), { resolved: true }), // first second of the period
        conv(Date.parse("2026-09-28T23:59:59Z")), // the day before
        conv(Date.parse("2026-10-06T00:00:00Z")), // tomorrow (clock skew)
      ],
    }),
  );
  assert.equal(r.conversations.total, 3);
  assert.equal(r.conversations.resolved, 1);
  assert.equal(r.conversations.series.length, 7);
  assert.equal(r.conversations.series[0]!.conversations, 1);
  assert.equal(r.conversations.series[6]!.conversations, 2);
  assert.equal(r.conversations.series.reduce((sum, d) => sum + d.conversations, 0), r.conversations.total);

  // The same instant falls on another day in another zone: 23:30 UTC Sunday is Monday in Berlin.
  const late = conv(Date.parse("2026-10-04T23:30:00Z"));
  assert.equal(computeMetrics(input({ conversations: [late] })).conversations.series[5]!.conversations, 1);
  assert.equal(computeMetrics(input({ conversations: [late], timezone: "Europe/Berlin" })).conversations.series[6]!.conversations, 1);
});

test("empty period: zero counts, no rates or medians", () => {
  const r = computeMetrics(input({}));
  assert.equal(r.conversations.total, 0);
  assert.equal(r.ai.resolutionRate, null);
  assert.equal(r.ai.handoffRate, null);
  assert.deepEqual(r.ai.firstResponse, { count: 0, median: null, p90: null });
  assert.deepEqual(r.team.firstResponse, { count: 0, median: null, p90: null });
  assert.equal(r.csat.score, null);
  assert.deepEqual(r.teammates, []);
});

test("AI resolution and handoff: the AI's conversations, and which it handled alone", () => {
  const t = NOW - 60 * MIN;
  const r = computeMetrics(
    input({
      conversations: [
        conv(t, { firstAiAt: t + 3 * S }), // AI alone
        conv(t, { firstAiAt: t + 5 * S }), // AI alone
        conv(t, { firstAiAt: t + 4 * S, handoffReason: "The customer asked for a person." }),
        conv(t, { handoffReason: "The customer asked for a person." }), // asked before the AI answered
        conv(t, { firstAiAt: t + 2 * S, firstAgentAt: t + MIN, firstAgentId: "u1" }), // an agent took over
        conv(t, { firstAgentAt: t + 2 * MIN, firstAgentId: "u1" }), // AI off: the team's from the start
        conv(t), // nobody answered yet
      ],
    }),
  );
  assert.equal(r.ai.conversations, 5);
  assert.equal(r.ai.resolved, 2);
  assert.equal(r.ai.handedOff, 2);
  assert.equal(r.ai.resolutionRate, 2 / 5);
  assert.equal(r.ai.handoffRate, 2 / 5);
  assert.deepEqual(r.ai.firstResponse, { count: 4, median: 3.5 * S, p90: 5 * S });
  assert.equal(r.conversations.series[6]!.aiResolved, 2);
});

test("handoff reasons: grouped, top five", () => {
  assert.equal(handoffReasonLabel("AI error: fetch failed (502)"), "AI error");
  assert.equal(handoffReasonLabel("Bug flagged by the AI: POST /api/billing returns 500"), "Bug flagged by the AI");
  assert.equal(handoffReasonLabel("Monthly AI reply cap (2000) reached."), "Monthly AI reply cap reached");
  assert.equal(handoffReasonLabel("  The customer asked   for a person. "), "The customer asked for a person");
  assert.equal(handoffReasonLabel(""), "No reason given");
  assert.equal(handoffReasonLabel("x".repeat(200)).length, 120);

  const reasons = ["Refund request", "refund request.", "Refund request", "AI error: a", "AI error: b", "Wants to cancel", "Angry", "Data deletion", "Zebra"];
  const r = computeMetrics(input({ conversations: reasons.map((reason) => conv(NOW, { handoffReason: reason })) }));
  assert.deepEqual(r.ai.reasons, [
    { reason: "Refund request", count: 3 },
    { reason: "AI error", count: 2 },
    { reason: "Angry", count: 1 },
    { reason: "Data deletion", count: 1 },
    { reason: "Wants to cancel", count: 1 },
  ]);
  assert.equal(r.ai.handedOff, 9);
});

test("first response: first visitor message to first public agent reply", () => {
  const t = NOW - 60 * MIN;
  const r = computeMetrics(
    input({
      conversations: [
        conv(t, { firstAgentAt: t + 30 * S, firstAgentId: "u1" }),
        conv(t, { firstAgentAt: t + 2 * MIN, firstAgentId: "u2" }),
        conv(t, { firstAgentAt: t + 10 * MIN, firstAgentId: "u1" }),
        conv(t, { firstVisitorAt: null, firstAgentAt: t, firstAgentId: "u1" }), // no visitor message: no time
        conv(t, { firstVisitorAt: t + MIN, firstAgentAt: t, firstAgentId: "u1" }), // reply before the question: ignored
      ],
    }),
  );
  assert.equal(r.team.answered, 3);
  assert.deepEqual(r.team.firstResponse, { count: 3, median: 2 * MIN, p90: 10 * MIN });
  assert.equal(durationStat([5, 1, 3, 2]).median, 2.5);
  assert.equal(durationStat(Array.from({ length: 10 }, (_, i) => i + 1)).p90, 9);
  assert.equal(durationStat([7]).p90, 7);
  assert.equal(durationStat([Number.NaN, -1]).count, 0);
});

test("CSAT: ratings given in the period, score, latest bad comments", () => {
  const ratings = [
    { conversationId: "c1", rating: "good" as const, comment: "Great", createdAt: NOW - 5 * MIN },
    { conversationId: "c2", rating: "bad" as const, comment: "  Slow  ", createdAt: NOW - 4 * MIN },
    { conversationId: "c3", rating: "bad" as const, comment: null, createdAt: NOW - 3 * MIN },
    { conversationId: "c4", rating: "good" as const, comment: null, createdAt: NOW - 30 * 24 * 60 * MIN }, // too old
    ...Array.from({ length: 6 }, (_, i) => ({ conversationId: `b${i}`, rating: "bad" as const, comment: `bad ${i}`, createdAt: NOW - 60 * MIN - i * MIN })),
  ];
  const r = computeMetrics(input({ ratings }));
  assert.equal(r.csat.good, 1);
  assert.equal(r.csat.bad, 8);
  assert.equal(r.csat.score, 1 / 9);
  assert.deepEqual(
    r.csat.badComments.map((c) => [c.conversationId, c.comment]),
    [["c2", "Slow"], ["b0", "bad 0"], ["b1", "bad 1"], ["b2", "bad 2"], ["b3", "bad 3"]],
    "newest first, only with a comment, at most five",
  );
});

test("teammates: replies, conversations, and their first responses", () => {
  const t = NOW - 60 * MIN;
  const r = computeMetrics(
    input({
      members: [
        { userId: "u1", name: "Ann" },
        { userId: "u2", name: "Bo" },
        { userId: "u3", name: "Cy" },
      ],
      replies: [
        { userId: "u2", replies: 9, conversations: 4 },
        { userId: "u1", replies: 3, conversations: 2 },
        { userId: "gone", replies: 1, conversations: 1 },
      ],
      conversations: [
        conv(t, { firstAgentAt: t + MIN, firstAgentId: "u1" }),
        conv(t, { firstAgentAt: t + 3 * MIN, firstAgentId: "u1" }),
        conv(t, { firstAgentAt: t + 20 * S, firstAgentId: "u2" }),
      ],
    }),
  );
  assert.deepEqual(
    r.teammates.map((m) => [m.name, m.replies, m.conversations, m.firstResponse.median]),
    [["Bo", 9, 4, 20 * S], ["Ann", 3, 2, 2 * MIN], ["Former teammate", 1, 1, null], ["Cy", 0, 0, null]],
  );
});

test("the cap is passed through", () => {
  assert.equal(computeMetrics(input({ truncated: true })).truncated, true);
});

test("durations read like a person wrote them", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45 * S), "45s");
  assert.equal(formatDuration(59.6 * S), "1m");
  assert.equal(formatDuration(3 * MIN + 10 * S), "3m");
  assert.equal(formatDuration(59 * MIN + 40 * S), "1h");
  assert.equal(formatDuration(80 * MIN), "1h 20m");
  assert.equal(formatDuration(2 * 24 * 60 * MIN + 4 * 60 * MIN), "2d 4h");
  assert.equal(formatDuration(3 * 24 * 60 * MIN), "3d");
  assert.equal(formatDuration(-5), "0s");
});
