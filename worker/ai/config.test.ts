import assert from "node:assert/strict";
import { test } from "node:test";
import { systemPrompt } from "./agent.ts";
import { DEFAULT_MAX_REPLIES, defaultFiles, fillTemplate, intentSkill, parseConfig, splitFrontmatter } from "./config.ts";
import { TEMPLATE } from "../../packages/cli/src/template.ts";
import { buildRequest, httpTools, shapeOutput, WIDGET_SHOWN_NOTE } from "./tools.ts";
import { starterWidget } from "../../shared/widgets.ts";
import { dedupeSse } from "./workers-ai.ts";

const REFUND_SKILL = `---
name: refund
description: The customer asks for a refund or money back.
---
1. Ask for the order number if you don't have it.
2. Look it up with lookup_order.
3. Within 14 days: explain how to request it. Otherwise offer account credit.
`;

const ORDER_TOOL = `description: Look up an order by number. Returns status, date and total.
url: https://api.acme.test/orders/{orderNumber}
headers:
  Authorization: Bearer {secrets.ACME_KEY}
input:
  orderNumber:
    type: string
    description: Order number like A-1042
pick: [status, orderedOn, total]
mock: { status: delivered, orderedOn: "2026-09-02", total: "$49.00", internalNote: "x" }
`;

test("default config turns the old guidance into AGENTS.md and parses cleanly", () => {
  const files = defaultFiles("Always mention our status page.");
  const { config, issues } = parseConfig(files);
  assert.deepEqual(issues, []);
  assert.equal(config.maxReplies, 8);
  assert.deepEqual(config.handoffTopics, ["legal or security questions"]);
  assert.match(config.persona, /Always mention our status page\./);
  assert.doesNotMatch(config.persona, /maxReplies/);
});

test("a full config parses: skills, tools, evals", () => {
  const { config, issues } = parseConfig({
    "AGENTS.md": "---\nmaxReplies: 4\n---\nBe brief.",
    "skills/refund/SKILL.md": REFUND_SKILL,
    "tools/lookup_order.yaml": ORDER_TOOL,
    "evals/refunds.yaml": `- name: old order\n  message: Refund for A-1042?\n  expect:\n    outcome: answer\n    tools: [lookup_order]\n    criteria: Offers account credit\n`,
  });
  assert.deepEqual(issues, []);
  assert.equal(config.maxReplies, 4);
  assert.equal(config.persona, "Be brief.");
  assert.deepEqual(config.skills.map((s) => s.name), ["refund"]);
  assert.equal(config.tools[0]!.name, "lookup_order");
  assert.equal(config.tools[0]!.method, "GET");
  assert.equal(config.tools[0]!.input.orderNumber!.required, true);
  assert.deepEqual(config.evals[0], {
    file: "evals/refunds.yaml",
    name: "old order",
    messages: ["Refund for A-1042?"],
    expect: { outcome: "answer", tools: ["lookup_order"], criteria: "Offers account credit" },
  });
});

test("config errors name the file and the problem", () => {
  const { config, issues } = parseConfig({
    "AGENTS.md": "---\nmaxReplys: 4\n---\nhi",
    "skills/refund/SKILL.md": "---\nname: refunds\n---\nsteps",
    "tools/lookup.yaml": "url: ftp://x\ninput:\n  id: string\nheaders:\n  X: '{token}'",
    "tools/leaky.yaml": "description: d\nurl: https://x.test/?key={secrets.KEY}",
    "tools/handoff.yaml": "description: d\nurl: https://x.test/",
    "notes.txt": "hello",
  });
  const text = issues.map((i) => `${i.path}: ${i.message}`).join("\n");
  assert.match(text, /tools\/handoff\.yaml: "handoff" is a built-in tool name/);
  assert.match(text, /AGENTS\.md: Unknown key "maxReplys"/);
  assert.match(text, /skills\/refund\/SKILL\.md: name must match the folder name/);
  assert.match(text, /skills\/refund\/SKILL\.md: description is required/);
  assert.match(text, /tools\/lookup\.yaml: description is required/);
  assert.match(text, /tools\/lookup\.yaml: url must start with https/);
  assert.match(text, /tools\/lookup\.yaml: \{token\} isn't an input/);
  assert.match(text, /tools\/leaky\.yaml: Put secrets in headers/);
  assert.match(text, /notes\.txt: Unknown file/);
  assert.equal(config.maxReplies, DEFAULT_MAX_REPLIES);
  assert.deepEqual(config.tools, []);
  assert.deepEqual(parseConfig({}).issues.map((i) => i.path), ["AGENTS.md"]);
});

test("frontmatter is optional and CRLF-safe", () => {
  assert.deepEqual(splitFrontmatter("no frontmatter"), { frontmatter: null, body: "no frontmatter" });
  assert.deepEqual(splitFrontmatter("---\r\na: 1\r\n---\r\nbody"), { frontmatter: "a: 1", body: "body" });
});

test("tool requests fill inputs (encoded in URLs) and secrets (headers only)", async () => {
  const spec = parseConfig({ "AGENTS.md": "x", "tools/lookup_order.yaml": ORDER_TOOL }).config.tools[0]!;
  const request = buildRequest(spec, { orderNumber: "A 1/2" }, (name) => (name === "ACME_KEY" ? "s3cret" : undefined));
  assert.equal(request.url, "https://api.acme.test/orders/A%201%2F2");
  assert.equal(request.headers.get("authorization"), "Bearer s3cret");
  assert.throws(() => buildRequest(spec, { orderNumber: "1" }, () => undefined), /JUN_SECRET_ACME_KEY/);
  assert.equal(fillTemplate("{a}-{b}", { a: 1 }, () => undefined), "1-");
});

test("POST tools send typed JSON bodies", async () => {
  const { config } = parseConfig({
    "AGENTS.md": "x",
    "tools/find_user.yaml": "description: d\nmethod: POST\nurl: https://x.test/graphql\nbody:\n  query: user(id)\n  variables: { id: '{id}', label: 'user {id}' }\ninput:\n  id: { type: integer }",
  });
  const request = buildRequest(config.tools[0]!, { id: 7 }, () => undefined);
  assert.deepEqual(await request.json(), { query: "user(id)", variables: { id: 7, label: "user 7" } });
});

test("tool output is picked and capped; calls are reported", async () => {
  assert.equal(shapeOutput('{"a":1,"b":2,"c":3}', ["a", "c"]), '{"a":1,"c":3}');
  assert.equal(shapeOutput("x".repeat(5000)).length, 4000 + "… (truncated)".length);

  const spec = parseConfig({ "AGENTS.md": "x", "tools/lookup_order.yaml": ORDER_TOOL }).config.tools[0]!;
  const actions: unknown[] = [];
  const tools = httpTools([spec], {
    secrets: () => "k",
    fetch: (async () => new Response('{"status":"shipped","secretField":1}', { status: 200 })) as typeof fetch,
    onAction: (a) => actions.push(a),
  });
  const out = await tools.lookup_order!.execute!({ orderNumber: "A-1" }, { toolCallId: "1", messages: [] } as never);
  assert.equal(out, '{"status":"shipped"}');
  assert.equal((actions[0] as { status: string }).status, "ok");

  const failing = httpTools([spec], { secrets: () => "k", fetch: (async () => new Response("nope", { status: 404 })) as typeof fetch });
  assert.equal(await failing.lookup_order!.execute!({ orderNumber: "A-1" }, { toolCallId: "1", messages: [] } as never), "ERROR (HTTP 404): nope");

  const mocked = httpTools([spec], { secrets: () => undefined, mock: true });
  assert.equal(await mocked.lookup_order!.execute!({ orderNumber: "A-1" }, { toolCallId: "1", messages: [] } as never), '{"status":"delivered","orderedOn":"2026-09-02","total":"$49.00"}');
});

test("tool status: optional one-line label for visitors, validated", () => {
  const ok = parseConfig({ "AGENTS.md": "x", "tools/lookup_order.yaml": `${ORDER_TOOL}status: "  Checking your order  "\n` });
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.config.tools[0]!.status, "Checking your order");
  assert.equal(parseConfig({ "AGENTS.md": "x", "tools/lookup_order.yaml": ORDER_TOOL }).config.tools[0]!.status, undefined);

  const bad = (status: string) => parseConfig({ "AGENTS.md": "x", "tools/t.yaml": `description: d\nurl: https://x.test\n${status}\n` });
  for (const [yaml, message] of [
    ["status: ''", /status must be a short text/],
    ["status: 42", /status must be a short text/],
    [`status: ${"x".repeat(61)}`, /at most 60 characters/],
    ["status: |\n  Checking\n  your order", /one line/],
    ["status: 'Checking {orderNumber}'", /no \{placeholders\}/],
  ] as const) {
    const { config, issues } = bad(yaml);
    assert.match(issues.map((i) => i.message).join("\n"), message, yaml);
    assert.deepEqual(config.tools, []);
  }
});

test("tool calls report visitor-safe steps: the label only, running then done, also on failure", async () => {
  const spec = parseConfig({ "AGENTS.md": "x", "tools/lookup_order.yaml": `${ORDER_TOOL}status: Checking your order\n` }).config.tools[0]!;
  const plain = parseConfig({ "AGENTS.md": "x", "tools/other.yaml": "description: d\nurl: https://x.test/secret-path" }).config.tools[0]!;
  const steps: unknown[] = [];
  const tools = httpTools([spec, plain], {
    secrets: () => "k",
    fetch: (async () => new Response("internal failure detail", { status: 500 })) as typeof fetch,
    onStep: (s) => steps.push(s),
  });
  await tools.lookup_order!.execute!({ orderNumber: "A-1" }, { toolCallId: "call_x", messages: [] } as never);
  await tools.other!.execute!({}, { toolCallId: "call_y", messages: [] } as never);
  assert.deepEqual(steps, [
    { id: "s1", label: "Checking your order", state: "running" },
    { id: "s1", label: "Checking your order", state: "done" },
    { id: "s2", label: "Looking that up", state: "running" },
    { id: "s2", label: "Looking that up", state: "done" },
  ]);
  // Nothing about the tool, its input or its result.
  assert.doesNotMatch(JSON.stringify(steps), /lookup_order|other|A-1|500|internal|x\.test|call_/);
});

test("prompt includes procedures, tools, handoff topics and today's date", () => {
  const { config } = parseConfig({
    "AGENTS.md": "---\nhandoffTopics: [legal questions]\n---\nBe warm.",
    "skills/refund/SKILL.md": REFUND_SKILL,
    "tools/lookup_order.yaml": ORDER_TOOL,
  });
  const prompt = systemPrompt({
    workspaceName: "Acme",
    persona: config.persona,
    handoffTopics: config.handoffTopics,
    skills: config.skills,
    tools: config.tools,
    hits: [],
    today: "Monday 5 October 2026",
  });
  assert.match(prompt, /Today is Monday 5 October 2026\./);
  assert.match(prompt, /Be warm\./);
  assert.match(prompt, /the request is about: legal questions/);
  assert.match(prompt, /tools \(lookup_order\)/);
  assert.match(prompt, /## refund\nWhen: The customer asks for a refund/);
  const catalog = systemPrompt({ workspaceName: "Acme", persona: "", skills: config.skills, skillCatalog: true, hits: [] });
  assert.match(catalog, /activate_skill/);
  assert.doesNotMatch(catalog, /Look it up with lookup_order/);
});

const CANCEL_SKILL = `---
name: cancellation
description: The customer wants to cancel.
intent: cancel
opening: "Sorry to see you go. What's the main reason?"
replies: [Too expensive, Other, Too expensive]
exit: Cancel anyway
---
Too expensive: offer 50% off for 3 months (offer: discount_50_3m). Nothing else.
`;

test("AI-20: a skill's frontmatter defines an intent (opening, replies, exit)", () => {
  const { config, issues } = parseConfig({ "AGENTS.md": "Be kind.", "skills/cancellation/SKILL.md": CANCEL_SKILL, "skills/refund/SKILL.md": REFUND_SKILL });
  assert.deepEqual(issues, []);
  assert.deepEqual(intentSkill(config, "cancel")?.intent, {
    name: "cancel",
    opening: "Sorry to see you go. What's the main reason?",
    replies: ["Too expensive", "Other"], // deduped
    exit: "Cancel anyway",
  });
  assert.equal(intentSkill(config, "refund"), null);
  assert.equal(config.skills.find((s) => s.name === "refund")!.intent, undefined);
  // A bare intent (no opening, replies or exit) is fine.
  const bare = parseConfig({ "AGENTS.md": "x", "skills/upgrade/SKILL.md": "---\nname: upgrade\ndescription: Upgrading.\nintent: upgrade\n---\nHelp them pick a plan.\n" });
  assert.deepEqual(bare.issues, []);
  assert.deepEqual(bare.config.skills[0]!.intent, { name: "upgrade", opening: null, replies: [], exit: null });
});

test("AI-20: intent frontmatter is validated, one skill per intent", () => {
  const skill = (folder: string, extra: string) => `---\nname: ${folder}\ndescription: d\n${extra}\n---\nSteps.\n`;
  const check = (extra: string, pattern: RegExp) => {
    const { config, issues } = parseConfig({ "AGENTS.md": "x", "skills/a/SKILL.md": skill("a", extra) });
    assert.equal(config.skills.length, 0, extra);
    assert.match(issues.map((i) => i.message).join("\n"), pattern, extra);
  };
  check("intent: Cancel Now", /intent must be a short name/);
  check("opening: Hi", /only apply with intent/);
  check("intent: cancel\nreplies: [a, b]", /replies need an opening/);
  check(`intent: cancel\nopening: Why?\nreplies: [${Array.from({ length: 9 }, (_, i) => `r${i}`).join(", ")}]`, /at most 8/);
  check("intent: cancel\nexit: [x]", /exit must be a short button label/);
  check(`intent: cancel\nexit: ${"x".repeat(41)}`, /exit must be a short button label/);
  const dup = parseConfig({ "AGENTS.md": "x", "skills/a/SKILL.md": skill("a", "intent: cancel"), "skills/b/SKILL.md": skill("b", "intent: cancel") });
  assert.deepEqual(dup.config.skills.map((s) => s.name), ["a"]);
  assert.match(dup.issues[0]!.message, /already defined by skills\/a\/SKILL\.md/);
  assert.equal(dup.issues[0]!.path, "skills/b/SKILL.md");
});

test("AI-20: eval cases can run as an intent chat", () => {
  const ok = parseConfig({ "AGENTS.md": "x", "evals/c.yaml": "- name: c\n  intent: cancel\n  message: Too expensive\n" });
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.config.evals[0]!.intent, "cancel");
  const bad = parseConfig({ "AGENTS.md": "x", "evals/c.yaml": "- name: c\n  intent: Cancel!\n  message: hi\n" });
  assert.match(bad.issues[0]!.message, /intent must be an intent name/);
});

test("AI-20: the prompt follows the intent's skill once, with the exit and offer rules", () => {
  const { config } = parseConfig({ "AGENTS.md": "x", "skills/cancellation/SKILL.md": CANCEL_SKILL, "skills/refund/SKILL.md": REFUND_SKILL });
  const prompt = systemPrompt({ workspaceName: "Acme", persona: "", skills: config.skills, hits: [], intent: { name: "cancel", skill: intentSkill(config, "cancel") } });
  assert.match(prompt, /opened it from Acme's app with the intent "cancel"/);
  assert.match(prompt, /fixed question "Sorry to see you go\. What's the main reason\?" and quick replies \(Too expensive, Other\)/);
  assert.match(prompt, /Never invent offers/);
  assert.match(prompt, /wait for a clear yes/);
  assert.match(prompt, /point them to the "Cancel anyway" button/);
  assert.equal(prompt.split("offer 50% off for 3 months").length, 2, "the intent's procedure appears once");
  assert.match(prompt, /## refund\nWhen:/, "other procedures stay");
  // Without the intent the skill is an ordinary procedure, and there's no exit rule.
  const plain = systemPrompt({ workspaceName: "Acme", persona: "", skills: config.skills, hits: [] });
  assert.match(plain, /## cancellation\nWhen:/);
  assert.doesNotMatch(plain, /Cancel anyway|intent/);
  // An intent no skill defines is only mentioned.
  const unknown = systemPrompt({ workspaceName: "Acme", persona: "", hits: [], intent: { name: "upgrade", skill: null } });
  assert.match(unknown, /with the intent "upgrade"\. No procedure is defined for it/);
});

test("jun init starter files parse cleanly, examples included (renamed to .yaml)", () => {
  const files = Object.fromEntries(Object.entries(TEMPLATE).map(([path, text]) => [path.replace(/\.example$/, ""), text]));
  const { config, issues } = parseConfig(files);
  assert.deepEqual(issues, []);
  const spec = intentSkill(config, "cancel")?.intent;
  assert.equal(spec?.exit, "Cancel anyway");
  assert.equal(spec?.replies.length, 6);
  const offer = config.tools.find((t) => t.name === "apply_save_offer")!;
  assert.equal(offer.method, "POST");
  assert.deepEqual(offer.body, { userId: "{user.id}", offer: "{offer}" });
  assert.ok(config.evals.some((e) => e.intent === "cancel"));
});

test("Workers AI stream dedupe drops the legacy copies of each chunk", async () => {
  const chunks = [
    'data: {"response":"Hi","choices":[{"delta":{"content":"Hi"}}],"tool_calls":[]}\n\ndata: {"response":" there"',
    ',"choices":[{"delta":{"content":" there"}}]}\n\ndata: {"response":"legacy only"}\n\ndata: [DONE]\n\n',
  ];
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  const out = await new Response(input.pipeThrough(dedupeSse())).text();
  const events = out.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  assert.deepEqual(events, ['{"choices":[{"delta":{"content":"Hi"}}]}', '{"choices":[{"delta":{"content":" there"}}]}', '{"response":"legacy only"}', "[DONE]"]);
});

test("W-09 widgets: widgets/<name>.widget files, `widget:` on a tool, checked against each other", () => {
  const widget = starterWidget("Subscription");
  const tool = "description: The customer's plan\nurl: https://api.example.com/plan\nwidget: subscription\n";
  const ok = parseConfig({ "AGENTS.md": "x", "widgets/subscription.widget": widget, "tools/plan.yaml": tool });
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.config.widgets[0]!.name, "subscription");
  assert.equal(ok.config.tools[0]!.widget, "subscription");

  const missing = parseConfig({ "AGENTS.md": "x", "tools/plan.yaml": tool });
  assert.match(missing.issues.map((i) => `${i.path}: ${i.message}`).join("\n"), /tools\/plan\.yaml: widget: there's no widgets\/subscription\.widget/);
  // A widget whose sample doesn't render is an error on its file.
  const broken = parseConfig({ "AGENTS.md": "x", "widgets/x.widget": JSON.stringify({ version: "1.0", template: '{"type":"Text","value":"x"}', sample: {} }) });
  assert.match(broken.issues[0]!.message, /root must be/);
  assert.match(parseConfig({ "AGENTS.md": "x", "widgets/Bad Name.widget": widget }).issues[0]!.message, /Unknown file/);
});

test("W-09: a tool with a widget shows its result as a card (step, onWidget) and tells the model", async () => {
  const { config } = parseConfig({
    "AGENTS.md": "x",
    "widgets/subscription.widget": starterWidget("Subscription"),
    "tools/plan.yaml": "description: d\nurl: https://api.example.com/plan\npick: [plan]\nwidget: subscription\nstatus: Checking your plan\n",
  });
  const steps: unknown[] = [];
  const shown: unknown[] = [];
  const actions: { widget?: unknown }[] = [];
  const body = { plan: "Team", status: "past_due", renews_on: "Dec 1", seats: 5, seats_used: 5, internal_id: 42 };
  const tools = httpTools(config.tools, {
    secrets: () => undefined,
    fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch,
    widgets: config.widgets,
    onStep: (s) => steps.push(s),
    onWidget: (w) => shown.push(w),
    onAction: (a) => actions.push(a),
  });
  const out = await tools.plan!.execute!({}, { toolCallId: "1", messages: [] } as never);
  // The model gets the picked fields and the note; the card is built from the whole response.
  assert.equal(out, `{"plan":"Team"}\n\n${WIDGET_SHOWN_NOTE}`);
  assert.equal(shown.length, 1);
  const card = shown[0] as { id: string; name: string; root: { type: string } };
  assert.equal(card.name, "subscription");
  assert.equal(card.root.type, "Card");
  assert.match(JSON.stringify(card.root), /"Team".*"past_due".*"5 of 5"/);
  assert.deepEqual((steps[1] as { widget?: unknown }).widget, card);
  assert.deepEqual(actions[0]!.widget, { name: "subscription" });

  // A response that doesn't fit: no card, the answer goes on as text, the audit log says why.
  const notJson = httpTools(config.tools, { secrets: () => undefined, fetch: (async () => new Response("plain text", { status: 200 })) as typeof fetch, widgets: config.widgets, onAction: (a) => actions.push(a) });
  assert.equal(await notJson.plan!.execute!({}, { toolCallId: "2", messages: [] } as never), "plain text");
  assert.deepEqual(actions[1]!.widget, { name: "subscription", error: "the response isn't JSON" });
});
