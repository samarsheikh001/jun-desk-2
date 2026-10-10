// End-to-end test of W-09 widgets (D-43) against a running dev server, with real AI
// (E2E_AI_PROVIDER, default ChatGPT). Run after e2e-auth (the owner exists).
//
// A tool with `widget:` shows its result as a ChatKit card: the card arrives on the tool's step
// while the reply is written and is saved with the answer. The visitor presses the card's button:
// the server checks the action against the card (forged ones and second presses are refused),
// keeps only the card's own fields, marks the card used, and the AI answers the press.
// httpbin.org stands in for the customer's API (it echoes the query back as `args`).

import assert from "node:assert/strict";
import { AI_PROVIDER, Client, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

const AI_TIMEOUT = 300_000;
const agent = new Client();
let workspaceId = "";
let widgetKey = "";

// The plan card: the plan, its status, renewal, seats, a field and a confirm button (ChatKit's .widget v1.0).
const template = [
  '{"type":"Card","size":"sm",',
  '"confirm":{"label":"Cancel renewal","action":{"type":"renewal.cancel","payload":{"plan":{{ (args.plan) | tojson }}}}},',
  '"cancel":{"label":"Keep my plan","action":{"type":"renewal.keep"}},',
  '"children":[',
  '{"type":"Row","children":[{"type":"Title","value":{{ (args.plan ~ " plan") | tojson }},"size":"sm"},{"type":"Spacer"},',
  '{"type":"Badge","label":{{ (args.status) | tojson }},"color":{% if args.status == "active" %}"success"{% else %}"warning"{% endif %}}]},',
  '{"type":"Row","children":[{"type":"Caption","value":"Renews"},{"type":"Spacer"},{"type":"Text","value":{{ (args.renews_on) | tojson }},"size":"sm"}]},',
  '{"type":"Input","name":"reason","placeholder":"Why are you leaving? (optional)"}',
  "]}",
].join("");
const widgetFile = JSON.stringify({ version: "1.0", name: "Plan", template, sample: { args: { plan: "Pro", status: "active", renews_on: "Nov 3" } } });

const files = {
  "AGENTS.md": "# How to talk to customers\n\n- Be brief.\n- When the customer asks about their plan or subscription, call plan_status.\n- When they press a button on a card, confirm in one sentence what happens next.\n",
  "tools/plan_status.yaml": [
    "description: The customer's current plan, its status and renewal date.",
    "status: Checking your plan",
    "url: https://httpbin.org/anything",
    "query:",
    "  plan: Pro",
    "  status: active",
    "  renews_on: Nov 3, 2026",
    "pick: [args]",
    "widget: plan",
    "",
  ].join("\n"),
  "widgets/plan.widget": widgetFile,
};

await step("owner signs in; the AI is on; the config has a tool with a widget", async () => {
  assert.equal((await agent.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await agent.call("/me")).json.memberships[0].workspaceId;
  widgetKey = (await agent.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  const ai = await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: true, provider: AI_PROVIDER, monthlyReplyCap: 5000 } });
  assert.equal(ai.status, 200, JSON.stringify(ai.json));

  // A tool pointing at a widget that isn't there is refused, by file.
  const bad = await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files: { ...files, "widgets/plan.widget": undefined }, base: null, force: true, message: "x" } });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.json), /no widgets\/plan\.widget/);

  const res = await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files, base: null, force: true, message: "plan card" } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(res.json.summary.widgets, ["plan"]);
});

let conversationId = "";
let socket: TestSocket;
let answer: any;

await step("asked about their plan, the AI calls the tool and the visitor sees the card (live on the step, then saved)", async () => {
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const res = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "Which plan am I on?" }, headers: { "X-Visitor-Token": token } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  conversationId = res.json.conversation.id;
  socket = new TestSocket(`/api/widget/${widgetKey}/conversations/${conversationId}/ws?since=1`, { protocols: [token] });
  await socket.opened;
  const live = await socket.next((e) => e.type === "ai_step" && e.step.state === "done" && e.step.widget, AI_TIMEOUT);
  assert.equal(live.step.label, "Checking your plan");
  assert.equal(live.step.widget.name, "plan");
  const event = await socket.next((e) => e.type === "message" && e.message.authorType === "ai", AI_TIMEOUT);
  answer = event.message;
  console.log(`    AI: ${answer.body.replace(/\s+/g, " ").slice(0, 120)}`);
  assert.equal(answer.meta.widgets?.length, 1, JSON.stringify(answer.meta));
  const card = answer.meta.widgets[0];
  assert.deepEqual(card, live.step.widget);
  assert.equal(card.root.type, "Card");
  assert.match(JSON.stringify(card.root), /"Pro plan".*"active".*"Nov 3, 2026"/);
  assert.equal(card.used, undefined);
});

await step("a forged action (one the card doesn't offer) is refused", async () => {
  const card = answer.meta.widgets[0];
  const clientMsgId = crypto.randomUUID();
  socket.send({ type: "send", clientMsgId, body: "Refund me", attachments: [], widgetAction: { messageId: answer.id, widgetId: card.id, action: { type: "refund.issue" } } });
  const err = await socket.next((e) => e.type === "error" && e.clientMsgId === clientMsgId);
  assert.equal(err.code, "bad_widget_action");
  // Same type, different payload: also refused.
  const other = crypto.randomUUID();
  socket.send({ type: "send", clientMsgId: other, body: "x", attachments: [], widgetAction: { messageId: answer.id, widgetId: card.id, action: { type: "renewal.cancel", payload: { plan: "Enterprise" } } } });
  assert.equal((await socket.next((e) => e.type === "error" && e.clientMsgId === other)).code, "bad_widget_action");
});

await step("pressing the card's button: the label is the message, only the card's fields are kept, the card is used, the AI answers", async () => {
  const card = answer.meta.widgets[0];
  const clientMsgId = crypto.randomUUID();
  socket.send({
    type: "send",
    clientMsgId,
    body: "anything the client says",
    attachments: [],
    widgetAction: { messageId: answer.id, widgetId: card.id, action: { type: "renewal.cancel", payload: { plan: "Pro" } }, values: { reason: "Too pricey", admin: "yes" } },
  });
  const used = await socket.next((e) => e.type === "message" && e.message.id === answer.id && e.message.meta.widgets?.[0]?.used);
  assert.equal(used.message.meta.widgets[0].used.label, "Cancel renewal");
  const sent = await socket.next((e) => e.type === "message" && e.message.clientMsgId === clientMsgId);
  assert.equal(sent.message.authorType, "visitor");
  assert.equal(sent.message.body, "Cancel renewal");
  assert.deepEqual(sent.message.meta.widgetAction, { widgetId: card.id, widget: "plan", type: "renewal.cancel", payload: { plan: "Pro" }, values: { reason: "Too pricey" } });

  const again = crypto.randomUUID();
  socket.send({ type: "send", clientMsgId: again, body: "x", attachments: [], widgetAction: { messageId: answer.id, widgetId: card.id, action: { type: "renewal.keep" } } });
  assert.equal((await socket.next((e) => e.type === "error" && e.clientMsgId === again)).code, "widget_used");

  const reply = await socket.next((e) => e.type === "message" && (e.message.authorType === "ai" || e.message.authorType === "system") && e.message.seq > sent.message.seq, AI_TIMEOUT);
  console.log(`    ${reply.message.authorType}: ${reply.message.body.replace(/\s+/g, " ").slice(0, 140)}`);
});

await step("agents see the card and what was entered in the conversation", async () => {
  const messages = (await agent.call(`/conversations/${conversationId}`)).json.messages as any[];
  const ai = messages.find((m) => m.id === answer.id);
  assert.equal(ai.meta.widgets[0].used.label, "Cancel renewal");
  assert.ok(messages.some((m) => m.meta.widgetAction?.values?.reason === "Too pricey"));
  socket.close();
});

summary();
