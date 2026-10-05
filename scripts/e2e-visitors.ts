// End-to-end test of M6: identity verification (V-03), merging visitors (V-04), attributes
// (V-05), the live visitor list over the loader's socket (V-01) and agent-started chats (V-07),
// plus the AI using the verified customer in a tool ({user.id}). Real Workers AI for the last step.

import assert from "node:assert/strict";
import { signIdentityToken } from "../worker/lib/identity.ts";
import { Client, cookieHeader, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

const AI_TIMEOUT = 120_000;
// Unique per run, so the suite can run again on the same database.
const RUN = crypto.randomUUID().slice(0, 8);
const ADA = `ada-${RUN}`;
const GRACE = `grace-${RUN}`;
const ECHO_URL = process.env.ECHO_URL ?? "https://httpbin.org/anything";
const agent = new Client();
let workspaceId = "";
let widgetKey = "";
let secret = "";
let agentName = "";

const userToken = async (sub: string, extra: Record<string, unknown> = {}, key = secret) =>
  signIdentityToken({ sub, exp: Math.floor(Date.now() / 1000) + 600, ...extra }, key);

async function newVisitor() {
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  return { visitor, token };
}

async function startConversation(token: string, body: string, extra: Record<string, unknown> = {}) {
  const res = await new Client().call(`/widget/${widgetKey}/conversations`, {
    body: { clientMsgId: crypto.randomUUID(), body, ...extra },
    headers: { "X-Visitor-Token": token },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.conversation;
}

const listConversations = async (token: string) =>
  (await new Client().call(`/widget/${widgetKey}/conversations`, { headers: { "X-Visitor-Token": token } })).json.conversations as { id: string }[];

const identify = (token: string | null, jwt: string) =>
  new Client().call(`/widget/${widgetKey}/identify`, { body: { userToken: jwt }, headers: token ? { "X-Visitor-Token": token } : {} });

await step("owner signs in, turns the AI off for now, and creates an identity secret", async () => {
  assert.equal((await agent.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  const me = (await agent.call("/me")).json;
  workspaceId = me.memberships[0].workspaceId;
  agentName = me.user.name;
  widgetKey = (await agent.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: false, provider: "workers-ai", monthlyReplyCap: 1000 } });
  const res = await agent.call(`/workspaces/${workspaceId}/identity`, { body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  secret = res.json.secret;
  assert.match(secret, /^jis_/);
  assert.equal((await agent.call(`/workspaces/${workspaceId}/identity`)).json.secret, secret);
});

let ada = "";

await step("an anonymous visitor identifies with a signed token and becomes a verified contact", async () => {
  const { token } = await newVisitor();
  const conversation = await startConversation(token, "Hi, question about billing");
  // Forged, expired and wrong-secret tokens are refused.
  assert.equal((await identify(token, await userToken(ADA, {}, "wrong secret"))).status, 401);
  assert.equal((await identify(token, await signIdentityToken({ sub: ADA, exp: Math.floor(Date.now() / 1000) - 600 }, secret))).status, 401);

  const res = await identify(token, await userToken(ADA, { email: "ada@acme.test", name: "Ada Lovelace", attributes: { plan: "pro", seats: 12 } }));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.token, token, "an anonymous browser keeps its token");
  ada = token;
  const summary = (await agent.call(`/conversations/${conversation.id}`)).json.conversation;
  assert.equal(summary.contact.name, "Ada Lovelace");
  assert.equal(summary.contact.verified, true);
  const contact = (await agent.call(`/workspaces/${workspaceId}/contacts/${summary.contact.id}`)).json.contact;
  assert.deepEqual(contact.attributes, { plan: "pro", seats: 12 });
  assert.equal(contact.externalId, ADA);
});

await step("on a second device, Ada's anonymous chat merges into her contact", async () => {
  const { token } = await newVisitor();
  const phone = await startConversation(token, "Sent from my phone");
  const res = await identify(token, await userToken(ADA, { email: "ada@acme.test", name: "Ada Lovelace" }));
  assert.equal(res.status, 200);
  assert.equal(res.json.token, token);
  const fromPhone = (await listConversations(token)).map((c) => c.id);
  const fromLaptop = (await listConversations(ada)).map((c) => c.id);
  assert.ok(fromPhone.includes(phone.id));
  assert.deepEqual(new Set(fromPhone), new Set(fromLaptop), "both browsers see all of Ada's chats");
  assert.equal(fromLaptop.length, 2);
  assert.equal((await agent.call(`/conversations/${phone.id}`)).json.conversation.contact.verified, true);
});

await step("on a shared computer, another user never inherits Ada's history", async () => {
  const res = await identify(ada, await userToken(GRACE, { name: "Grace Hopper" }));
  assert.equal(res.status, 200);
  assert.notEqual(res.json.token, ada, "a different user gets a different browser token");
  assert.deepEqual(await listConversations(res.json.token), []);
  assert.equal((await listConversations(ada)).length, 2, "Ada's own token still works for Ada");
  // No token at all: same, a fresh token for that user.
  const fresh = await identify(null, await userToken(ADA));
  assert.equal(fresh.status, 200);
  assert.equal((await listConversations(fresh.json.token)).length, 2);
});

let agentHub: TestSocket;
let live: TestSocket;
const SESSION = `e2e${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

await step("the loader's live socket (from the customer's site) shows the visitor to agents", async () => {
  agentHub = new TestSocket(`/api/workspaces/${workspaceId}/ws`, { headers: { cookie: cookieHeader(agent) } });
  await agentHub.opened;
  await agentHub.next((e) => e.type === "visitors");
  live = new TestSocket(`/api/widget/${widgetKey}/live?s=${SESSION}`, { headers: { Origin: "https://customer.example" } });
  await live.opened;
  live.send({ t: "page", url: "https://customer.example/pricing", title: "Pricing", ref: "https://google.com/", start: Date.now() - 65_000, lang: "en-GB", tz: "Europe/London" });
  const seen = await agentHub.next((e) => e.type === "visitor" && e.visitor.sessionId === SESSION);
  assert.equal(seen.visitor.page.url, "https://customer.example/pricing");
  assert.equal(seen.visitor.pages, 1);
  assert.equal(seen.visitor.contact, null);
  assert.ok(Date.now() - seen.visitor.startedAt >= 60_000);
  live.send({ t: "page", url: "https://customer.example/billing", title: "Billing" });
  const moved = await agentHub.next((e) => e.type === "visitor" && e.visitor.sessionId === SESSION && e.visitor.pages === 2);
  assert.equal(moved.visitor.page.title, "Billing");
  // Bad sessions are refused; visitors never receive inbox events.
  assert.equal((await new Client().call(`/widget/${widgetKey}/live?s=x`)).status, 400);
});

await step("the live socket identifies the visitor (bad tokens are refused)", async () => {
  live.send({ t: "id", token: "nope" });
  assert.equal((await live.next((e) => e.t === "id")).ok, false);
  live.send({ t: "id", token: await userToken(ADA, { name: "Ada Lovelace", email: "ada@acme.test" }) });
  assert.equal((await live.next((e) => e.t === "id")).ok, true);
  const seen = await agentHub.next((e) => e.type === "visitor" && e.visitor.sessionId === SESSION && e.visitor.contact?.verified);
  assert.equal(seen.visitor.contact.name, "Ada Lovelace");
  assert.ok(!live.events.some((e) => e.type === "conversation" || e.type === "presence" || e.type === "visitor"));
});

let inviteId = "";

await step("an agent starts a chat with a live visitor: the invite reaches only their page", async () => {
  const res = await agent.call(`/workspaces/${workspaceId}/visitors/${SESSION}/invite`, { body: { body: "Hi Ada! Anything I can help with on billing?" } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const invite = await live.next((e) => e.t === "invite");
  assert.equal(invite.body, "Hi Ada! Anything I can help with on billing?");
  assert.match(invite.from, new RegExp(`^${agentName} from `));
  inviteId = invite.id;
  assert.equal((await agent.call(`/workspaces/${workspaceId}/visitors/nobody-here-123/invite`, { body: { body: "hello?" } })).status, 410);
});

await step("replying to the invite starts a conversation with the agent, assigned to them", async () => {
  const conversation = await startConversation(ada, "Yes please, my invoice looks wrong", { inviteId, sessionId: SESSION });
  assert.equal(conversation.handling, "human");
  assert.ok(conversation.assigneeId, "assigned to the inviting agent");
  const messages = (await agent.call(`/conversations/${conversation.id}`)).json.messages;
  assert.deepEqual(messages.map((m: { authorType: string }) => m.authorType), ["agent", "visitor"]);
  assert.equal(messages[0].body, "Hi Ada! Anything I can help with on billing?");
  const inChat = await agentHub.next((e) => e.type === "visitor" && e.visitor.sessionId === SESSION && e.visitor.inChat);
  assert.equal(inChat.visitor.inChat, true);
  // An invite is single use.
  const again = await startConversation(ada, "another one", { inviteId, sessionId: SESSION });
  const againMessages = (await agent.call(`/conversations/${again.id}`)).json.messages;
  assert.deepEqual(againMessages.map((m: { authorType: string }) => m.authorType), ["visitor"]);
});

await step("when the visitor leaves, agents see them go", async () => {
  live.close();
  await agentHub.next((e) => e.type === "visitor_left" && e.sessionId === SESSION);
  agentHub.close();
});

await step("the AI looks up the signed-in customer's own account with {user.id}", async () => {
  const live = (await agent.call(`/workspaces/${workspaceId}/agent`)).json;
  const files = {
    ...live.files,
    "tools/my_account.yaml": `description: The signed-in customer's own account (plan, seats). Use it for questions about their plan or account.
url: ${ECHO_URL}/accounts/{user.id}
query:
  plan: '{user.plan}'
  seats: '{user.seats}'
pick: [args, url]
`,
  };
  const saved = await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files, base: live.version, message: "my_account tool" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: true, provider: "workers-ai", monthlyReplyCap: 1000 } });

  const { token } = await newVisitor();
  await identify(token, await userToken(ADA, { name: "Ada Lovelace", email: "ada@acme.test", attributes: { plan: "pro", seats: 12 } }));
  const conversation = await startConversation(token, "Which plan am I on, and how many seats do I have?");
  const socket = new TestSocket(`/api/widget/${widgetKey}/conversations/${conversation.id}/ws?since=1`, { protocols: [token] });
  await socket.opened;
  const event = await socket.next(
    (e) => (e.type === "message" && ["ai", "system"].includes(e.message.authorType)) || (e.type === "messages" && e.messages.some((m: { authorType: string }) => ["ai", "system"].includes(m.authorType))),
    AI_TIMEOUT,
  );
  const reply = event.type === "message" ? event.message : event.messages.find((m: { authorType: string }) => ["ai", "system"].includes(m.authorType));
  socket.close();
  assert.equal(reply.authorType, "ai", reply.body);
  assert.match(reply.body, /pro/i, reply.body);
  const actions = (await agent.call(`/conversations/${conversation.id}/actions`)).json.actions;
  const call = actions.find((a: { tool: string }) => a.tool === "my_account");
  assert.ok(call, `expected a my_account call; got ${JSON.stringify(actions)} and reply: ${reply.body}`);
  assert.equal(call.status, "ok");
  assert.ok(call.output.includes(`accounts/${ADA}`), call.output);
});

summary();
