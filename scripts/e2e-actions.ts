// End-to-end test of AI-21 page actions (D-40) against a running dev server, with real AI
// (E2E_AI_PROVIDER, default ChatGPT). Run after e2e-auth and e2e-ai (the AI is on by then).
//
// The widget sends the page's WebMCP tools with each message; the model may propose one; the
// visitor confirms, the page runs it and reports back; the card closes; agents get an audit row.
// Model answers vary, so the checks are about behaviour: the right action with the right input,
// no action when none was asked for, a `human` action handing off.

import assert from "node:assert/strict";
import { AI_PROVIDER, BASE, Client, cookieHeader, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

// Knowledge search embeds the question through the remote Workers AI binding, which can take a while in local dev.
const AI_TIMEOUT = 300_000;
const agent = new Client();
let workspaceId = "";
let widgetKey = "";

/** What a pricing page would register: a WebMCP tool plus Jun extras. */
const pageActions = [
  {
    id: "upgrade_plan",
    name: "upgrade_plan",
    description: "Upgrade this account to a bigger plan",
    inputSchema: { type: "object", properties: { plan: { type: "string", enum: ["starter", "growth"], description: "The plan to move to" } }, required: ["plan"] },
    annotations: { consequentialHint: true },
    context: { currentPlan: "free" },
  },
  {
    id: "export_csv",
    name: "export_csv",
    description: "Download this month's usage as a CSV file",
    inputSchema: { type: "object", properties: {} },
    risk: "auto",
  },
  {
    id: "delete_account",
    name: "delete_account",
    description: "Delete this account and all its data",
    risk: "human",
  },
];

await step("owner signs in; the AI is on (ChatGPT login, or E2E_AI_PROVIDER)", async () => {
  assert.equal((await agent.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await agent.call("/me")).json.memberships[0].workspaceId;
  widgetKey = (await agent.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  const res = await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: true, provider: AI_PROVIDER, instructions: "Be brief.", monthlyReplyCap: 100 } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
});

/** Starts a widget conversation whose first message carries the page's actions. */
async function startChat(question: string, actions: unknown = pageActions) {
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const res = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: question, actions }, headers: { "X-Visitor-Token": token } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const conversationId = res.json.conversation.id as string;
  const socket = new TestSocket(`/api/widget/${widgetKey}/conversations/${conversationId}/ws?since=1`, { protocols: [token] });
  await socket.opened;
  return { conversationId, socket, visitor, token };
}

async function nextMessage(socket: TestSocket, match: (m: any) => boolean, timeoutMs = AI_TIMEOUT): Promise<any> {
  const event = await socket.next((e) => (e.type === "message" && match(e.message)) || (e.type === "messages" && e.messages.some(match)), timeoutMs);
  return event.type === "message" ? event.message : event.messages.find(match);
}

const handling = async (conversationId: string) => (await agent.call(`/conversations/${conversationId}`)).json.conversation.handling as string;

await step("asked to upgrade, the AI proposes the page's upgrade action with the plan filled in", async () => {
  const { conversationId, socket } = await startChat("Please upgrade my account to the growth plan.");
  const reply = await nextMessage(socket, (m) => m.authorType === "ai" || m.authorType === "system");
  console.log(`    AI: ${reply.body.replace(/\s+/g, " ").slice(0, 120)} → ${JSON.stringify(reply.meta.action && { name: reply.meta.action.name, input: reply.meta.action.input, missing: reply.meta.action.missing })}`);
  assert.equal(reply.authorType, "ai", `expected an AI reply, got ${reply.authorType}: ${reply.body}`);
  const action = reply.meta.action;
  assert.ok(action, "the reply should propose a page action");
  assert.equal(action.name, "upgrade_plan");
  assert.equal(action.status, "pending");
  assert.equal(action.risk, "confirm");
  assert.ok(reply.meta.followUps === undefined, "no follow-ups under a card");
  if (action.missing.includes("plan")) {
    // The model left the plan out: the visitor's answer fills it (checked server-side).
    socket.send({ type: "action_input", runId: action.runId, input: { plan: "Growth" } });
    const updated = await nextMessage(socket, (m) => m.meta.action?.runId === action.runId && m.meta.action.missing.length === 0, 10_000);
    assert.equal(updated.meta.action.input.plan, "growth");
  } else {
    assert.equal(action.input.plan, "growth");
  }

  // The visitor confirms, the page runs it and reports back: the card shows Done, with Undo.
  socket.send({ type: "action_result", runId: action.runId, status: "ok", result: "Upgraded to Growth", canUndo: true });
  const done = await nextMessage(socket, (m) => m.meta.action?.runId === action.runId && m.meta.action.status === "ok", 10_000);
  assert.equal(done.meta.action.result, "Upgraded to Growth");
  assert.equal(done.meta.action.canUndo, true);
  assert.equal(done.seq, reply.seq, "the same message, updated in place");

  // A second result for the same run changes nothing.
  socket.send({ type: "action_result", runId: action.runId, status: "error", result: "again" });
  await socket.none((e) => e.type === "message" && e.message.meta.action?.status === "error", 500);

  // Agents see the run in the audit log (AI-11), never visitors.
  const actions = (await agent.call(`/conversations/${conversationId}/actions`)).json.actions as { tool: string; status: string; output: string }[];
  const run = actions.find((a) => a.tool === "page:upgrade_plan");
  assert.ok(run, JSON.stringify(actions));
  assert.equal(run.status, "ok");
  assert.match(run.output, /Upgraded to Growth/);

  // Undo closes the loop.
  socket.send({ type: "action_result", runId: action.runId, status: "undone" });
  const undone = await nextMessage(socket, (m) => m.meta.action?.runId === action.runId && m.meta.action.status === "undone", 10_000);
  assert.equal(undone.meta.action.canUndo, false);
  const after = (await agent.call(`/conversations/${conversationId}/actions`)).json.actions as { tool: string }[];
  assert.ok(after.some((a) => a.tool === "undo:upgrade_plan"), JSON.stringify(after.map((a) => a.tool)));
  assert.equal(await handling(conversationId), "ai");
  socket.close();
});

await step("the next turn knows what the action did", async () => {
  const { socket, visitor, token, conversationId } = await startChat("Export my usage as a CSV please.");
  const reply = await nextMessage(socket, (m) => m.authorType === "ai" || m.authorType === "system");
  assert.equal(reply.authorType, "ai", reply.body);
  assert.equal(reply.meta.action?.name, "export_csv", JSON.stringify(reply.meta));
  assert.equal(reply.meta.action.risk, "auto");
  socket.send({ type: "action_result", runId: reply.meta.action.runId, status: "ok", result: "usage-2026-10.csv (18 rows)" });
  await nextMessage(socket, (m) => m.meta.action?.runId === reply.meta.action.runId && m.meta.action.status === "ok", 10_000);
  const res = await visitor.call(`/widget/${widgetKey}/conversations/${conversationId}/messages`, {
    body: { clientMsgId: crypto.randomUUID(), body: "How many rows did that export have?", actions: pageActions },
    headers: { "X-Visitor-Token": token },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const answer = await nextMessage(socket, (m) => m.authorType === "ai" && m.seq > reply.seq);
  console.log(`    AI: ${answer.body.replace(/\s+/g, " ").slice(0, 120)}`);
  assert.match(answer.body, /18/);
  socket.close();
});

await step("a plain question about plans gets an answer, not an action", async () => {
  const { socket } = await startChat("Hi! What's the difference between the starter and growth plans?");
  const reply = await nextMessage(socket, (m) => m.authorType === "ai" || m.authorType === "system");
  console.log(`    AI: ${reply.body.replace(/\s+/g, " ").slice(0, 120)}`);
  assert.equal(reply.meta.action, undefined, `no action should be proposed: ${JSON.stringify(reply.meta.action)}`);
  socket.close();
});

await step("an action marked human hands off to the team instead of running", async () => {
  const { conversationId, socket } = await startChat("Please delete my account and all my data right now.");
  const reply = await nextMessage(socket, (m) => m.authorType === "system" || (m.authorType === "ai" && m.meta.action));
  assert.equal(reply.authorType, "system", `expected a handoff, got: ${reply.body}`);
  assert.equal(await handling(conversationId), "human");
  socket.close();
});

await step("junk in the actions list is ignored, and a list that isn't one is too", async () => {
  const { socket } = await startChat("Please upgrade my account to the growth plan.", [{ nope: 1 }, "x", null, { name: "upgrade_plan" }]);
  const reply = await nextMessage(socket, (m) => m.authorType === "ai" || m.authorType === "system");
  assert.equal(reply.meta.action, undefined, "nothing to propose");
  socket.close();
  const { socket: s2 } = await startChat("Hello there", "not a list");
  const r2 = await nextMessage(s2, (m) => m.authorType === "ai" || m.authorType === "system");
  assert.equal(r2.meta.action, undefined);
  s2.close();
});

summary();
