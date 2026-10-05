// End-to-end test of A-01 metrics. Other suites share the workspace, so this reads the report,
// plays a known scenario (a team reply after a short wait, a "Talk to a person" handoff, one
// real AI answer, a 👎 with a comment) and checks the report moved by exactly that. Run last.

import assert from "node:assert/strict";
import { AI_PROVIDER, Client, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

const AI_TIMEOUT = 90_000;
const owner = new Client();
const run = Date.now().toString(36);
let workspaceId = "";
let widgetKey = "";
let ownerId = "";
let aiSettings: Record<string, unknown> = {};

const report = async (days = 7) => {
  const res = await owner.call(`/workspaces/${workspaceId}/metrics?days=${days}&tz=Europe/Berlin`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.report;
};
const setAi = (enabled: boolean) =>
  owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { ...aiSettings, enabled, provider: AI_PROVIDER, model: null, monthlyReplyCap: 1_000_000 } });

/** A new visitor and their first message; returns what's needed to keep chatting. */
async function startChat(body: string) {
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const res = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body }, headers: { "X-Visitor-Token": token } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { visitor, token, id: res.json.conversation.id as string, handling: res.json.conversation.handling as string };
}
const reply = (id: string, body: string) => owner.call(`/conversations/${id}/messages`, { body: { clientMsgId: crypto.randomUUID(), body } });

let before: any;
let answered = "";
let handedOff = "";
let aiChat = "";
let aiHandedOff = false;

await step("owner signs in; the report validates its period and who's asking", async () => {
  assert.equal((await owner.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  const me = (await owner.call("/me")).json;
  workspaceId = me.memberships[0].workspaceId;
  ownerId = me.user.id;
  widgetKey = (await owner.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  aiSettings = (await owner.call(`/workspaces/${workspaceId}/ai`)).json.settings;

  for (const bad of ["5", "abc", "7.5", ""]) {
    assert.equal((await owner.call(`/workspaces/${workspaceId}/metrics?days=${bad}`)).status, 400, `days=${bad}`);
  }
  assert.equal((await owner.call(`/workspaces/${workspaceId}/metrics?days=7&tz=Mars/Olympus`)).status, 400);
  assert.equal((await new Client().call(`/workspaces/${workspaceId}/metrics?days=7`)).status, 401);
  assert.equal((await owner.call(`/workspaces/ws_nope/metrics?days=7`)).status, 404);

  const r = (await owner.call(`/workspaces/${workspaceId}/metrics`)).json.report;
  assert.equal(r.days, 7, "7 days by default");
  assert.equal(r.timezone, "UTC");
  for (const days of [30, 90]) assert.equal((await report(days)).conversations.series.length, days);
  before = await report();
  assert.equal(before.conversations.series.length, 7);
  assert.equal(before.timezone, "Europe/Berlin");
  // Earlier suites left data: the numbers add up.
  assert.equal(before.conversations.series.reduce((s: number, d: { conversations: number }) => s + d.conversations, 0), before.conversations.total);
  assert.ok(before.conversations.total > 0);
  assert.equal(before.ai.resolved + before.ai.handedOff <= before.ai.conversations, true);
});

await step("scenario: the team answers one chat after a short wait and resolves it", async () => {
  assert.equal((await setAi(false)).status, 200);
  const chat = await startChat(`Where do I find my API key? (${run})`);
  assert.equal(chat.handling, "human");
  answered = chat.id;
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await reply(answered, "Settings → API.")).status, 200);
  // An internal note isn't a reply.
  await owner.call(`/conversations/${answered}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "FYI docs are outdated", internal: true } });
  assert.equal((await owner.call(`/conversations/${answered}`, { method: "PATCH", body: { status: "resolved" } })).json.conversation.status, "resolved");

  const rated = await chat.visitor.call(`/widget/${widgetKey}/conversations/${answered}/rating`, {
    body: { rating: "bad", comment: `Too slow ${run}` },
    headers: { "X-Visitor-Token": chat.token },
  });
  assert.equal(rated.status, 200, JSON.stringify(rated.json));
});

await step("scenario: a visitor asks for a person in an AI chat (no AI turn)", async () => {
  const chat = await startChat(`I need to change my billing email (${run})`);
  handedOff = chat.id;
  // As in e2e-inbox: a team reply first, then back to the AI, so the AI has nothing to answer.
  await reply(handedOff, "Let me check.");
  assert.equal((await owner.call(`/conversations/${handedOff}`, { method: "PATCH", body: { handling: "ai" } })).json.conversation.handling, "ai");
  const socket = new TestSocket(`/api/widget/${widgetKey}/conversations/${handedOff}/ws?since=100000`, { protocols: [chat.token] });
  await socket.opened;
  socket.send({ type: "handoff" });
  const notice = await socket.next((e) => e.type === "message" && e.message.authorType === "system", 10_000);
  assert.equal(notice.message.meta.handoffReason, "The customer asked for a person.");
  socket.close();
});

await step("scenario: the AI answers one chat (real AI (E2E_AI_PROVIDER, default ChatGPT))", async () => {
  assert.equal((await setAi(true)).status, 200);
  try {
    const chat = await startChat("Hi! What can you help me with?");
    aiChat = chat.id;
    assert.equal(chat.handling, "ai");
    const socket = new TestSocket(`/api/widget/${widgetKey}/conversations/${aiChat}/ws?since=0`, { protocols: [chat.token] });
    await socket.opened;
    const match = (m: any) => m.authorType === "ai" || (m.authorType === "system" && m.meta?.handoffReason);
    const event = await socket.next((e) => (e.type === "message" && match(e.message)) || (e.type === "messages" && e.messages.some(match)), AI_TIMEOUT);
    const first = event.type === "message" ? event.message : event.messages.find(match);
    // A model may hand off instead of answering, or flag a bug after its answer: wait for the turn to settle.
    await new Promise((r) => setTimeout(r, 1500));
    const messages = (await owner.call(`/conversations/${aiChat}`)).json.messages as { authorType: string; internal: boolean; meta: { handoffReason?: string } }[];
    aiHandedOff = messages.some((m) => m.authorType === "system" && !m.internal && m.meta.handoffReason);
    assert.ok(first.authorType === "ai" || aiHandedOff);
    socket.close();
  } finally {
    await owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: aiSettings });
  }
});

await step("the report moved by exactly the scenario", async () => {
  const after = await report();
  const d = (path: (r: any) => number) => path(after) - path(before);
  assert.equal(d((r) => r.conversations.total), 3);
  assert.equal(d((r) => r.conversations.resolved), 1);
  assert.equal(after.conversations.series.at(-1).conversations - before.conversations.series.at(-1).conversations, 3, "today, in Berlin");
  // The handoff chat and the AI chat are the AI's; the team's chat isn't.
  assert.equal(d((r) => r.ai.conversations), 2);
  assert.equal(d((r) => r.ai.handedOff), aiHandedOff ? 2 : 1);
  assert.equal(d((r) => r.ai.resolved), aiHandedOff ? 0 : 1);
  assert.equal(d((r) => r.team.answered), 2, "two chats got a team reply after the visitor wrote");
  assert.ok(after.team.firstResponse.median > 0 && after.team.firstResponse.p90 >= after.team.firstResponse.median);
  if (!aiHandedOff) assert.ok(after.ai.firstResponse.median > 0, JSON.stringify(after.ai.firstResponse));

  const reason = (r: any) => r.ai.reasons.find((x: { reason: string }) => x.reason === "The customer asked for a person")?.count ?? 0;
  assert.ok(reason(after) >= 1);
  assert.ok(after.ai.reasons.length <= 5);

  assert.equal(d((r) => r.csat.bad), 1);
  assert.equal(after.csat.badComments[0].conversationId, answered, "the newest bad comment comes first");
  assert.equal(after.csat.badComments[0].comment, `Too slow ${run}`);
  assert.equal(after.csat.score, after.csat.good / (after.csat.good + after.csat.bad));

  const me = (r: any) => r.teammates.find((t: { userId: string }) => t.userId === ownerId);
  assert.equal(me(after).replies - me(before).replies, 2, "notes aren't replies");
  assert.equal(me(after).conversations - me(before).conversations, 2);
  assert.ok(me(after).firstResponse.median > 0);
});

await step("the conversation the team answered shows a first response of at least the wait", async () => {
  const thread = (await owner.call(`/conversations/${answered}`)).json.messages as { authorType: string; internal: boolean; createdAt: number }[];
  const asked = thread.find((m) => m.authorType === "visitor")!.createdAt;
  const replied = thread.find((m) => m.authorType === "agent" && !m.internal)!.createdAt;
  assert.ok(replied - asked >= 1400, `${replied - asked}ms`);
  // Longer periods include everything shorter ones do.
  const [week, month, quarter] = [await report(7), await report(30), await report(90)];
  assert.ok(month.conversations.total >= week.conversations.total && quarter.conversations.total >= month.conversations.total);
});

summary();
