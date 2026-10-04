import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../../shared/protocol.ts";
import { asksForHuman, resolveCitations, searchQuery, systemPrompt, toChatMessages } from "./agent.ts";
import { blocksFromText, chunkBlocks, decodeEntities } from "./chunk.ts";
import { ftsQuery } from "./query.ts";
import type { SearchHit } from "./query.ts";

const hit = (title: string, url: string | null = null): SearchHit => ({ id: title, title, heading: "", url, text: "...", score: 1 });

test("chunks stay within sections and carry the heading path", () => {
  const chunks = chunkBlocks([
    { kind: "heading", level: 1, text: "Billing" },
    { kind: "text", text: "Intro to billing." },
    { kind: "heading", level: 2, text: "Refunds" },
    { kind: "text", text: "Refunds within 14 days." },
    { kind: "heading", level: 2, text: "Invoices" },
    { kind: "text", text: "Invoices are emailed." },
  ]);
  assert.deepEqual(chunks, [
    { heading: "Billing", text: "Intro to billing." },
    { heading: "Billing › Refunds", text: "Refunds within 14 days." },
    { heading: "Billing › Invoices", text: "Invoices are emailed." },
  ]);
});

test("long sections are split near the target size, never over the max", () => {
  const sentence = "This sentence is about forty characters. ";
  const chunks = chunkBlocks([{ kind: "text", text: sentence.repeat(200) }]);
  assert.ok(chunks.length > 3);
  for (const c of chunks) assert.ok(c.text.length <= 2000);
});

test("snippets: markdown headings become sections", () => {
  assert.deepEqual(blocksFromText("# Refunds\n\nWithin 14 days.\n\nEmail us."), [
    { kind: "heading", level: 1, text: "Refunds" },
    { kind: "text", text: "Within 14 days." },
    { kind: "text", text: "Email us." },
  ]);
});

test("HTML entities decode", () => {
  assert.equal(decodeEntities("Tom &amp; Jerry&#39;s &lt;b&gt; &#x1F600;"), "Tom & Jerry's <b> 😀");
});

test("citations are renumbered by first use; unknown ones are dropped", () => {
  const { text, sources } = resolveCitations("Refunds take 14 days [3]. Invoices are monthly [1][3]. Ignore [9].", [hit("A", "https://a"), hit("B"), hit("C", "https://c")]);
  assert.equal(text, "Refunds take 14 days [1]. Invoices are monthly [2][1]. Ignore.");
  assert.deepEqual(sources, [{ title: "C", url: "https://c" }, { title: "A", url: "https://a" }]);
});

test("asking for a human is detected without the model", () => {
  for (const yes of ["Can I talk to a human?", "speak with someone please", "human please", "I want to chat with support"]) assert.ok(asksForHuman(yes), yes);
  for (const no of ["How do I add a team member?", "Is there human review of invoices?"]) assert.ok(!asksForHuman(no), no);
});

const msg = (authorType: Message["authorType"], body: string, extra: Partial<Message> = {}): Message => ({
  id: body, seq: 0, authorType, authorId: null, authorName: null, body, attachments: [], clientMsgId: body, createdAt: 0, internal: false, meta: {}, ...extra,
});

test("search query adds the previous visitor message to short follow-ups", () => {
  assert.equal(searchQuery([msg("visitor", "How much is the Team plan?"), msg("ai", "It's $20."), msg("visitor", "and yearly?")]), "How much is the Team plan?\nand yearly?");
  assert.equal(searchQuery([msg("visitor", "How do I export all my data to CSV from the dashboard?")]), "How do I export all my data to CSV from the dashboard?");
});

test("model input excludes internal notes and system messages", () => {
  const input = toChatMessages([
    msg("visitor", "hi"),
    msg("system", "Handed off", { internal: true }),
    msg("system", "A teammate will reply"),
    msg("agent", "Hello! I'm Ada."),
  ]);
  assert.deepEqual(input, [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello! I'm Ada." }]);
});

test("system prompt numbers sources and keeps the handoff rule", () => {
  const prompt = systemPrompt({ workspaceName: "Acme", instructions: "Be brief.", hits: [hit("Refunds", "https://acme.dev/refunds")] });
  assert.match(prompt, /\[1\] Refunds \(https:\/\/acme\.dev\/refunds\)/);
  assert.match(prompt, /HANDOFF: <short reason>/);
  assert.match(prompt, /Be brief\./);
});

test("FTS query quotes terms and drops stopwords", () => {
  assert.equal(ftsQuery('How do I get a "refund" for /api/billing?'), '"get" OR "refund" OR "api" OR "billing"');
  assert.equal(ftsQuery("is it the"), null);
});

test("parseReply: answers, handoffs and escalations", async () => {
  const { parseReply } = await import("./agent.ts");
  assert.deepEqual(parseReply("HANDOFF: needs a refund"), { kind: "handoff", reason: "needs a refund" });
  assert.deepEqual(parseReply("  "), { kind: "handoff", reason: "The AI couldn't answer from the knowledge base." });
  assert.deepEqual(parseReply("Refunds take 14 days [1]."), { kind: "answer", text: "Refunds take 14 days [1].", escalate: null });
  assert.deepEqual(parseReply("Your payment request failed with a 500 at 14:02. I've flagged it.\nESCALATE: POST /api/billing returns 500"), {
    kind: "answer",
    text: "Your payment request failed with a 500 at 14:02. I've flagged it.",
    escalate: "POST /api/billing returns 500",
  });
});

test("streamVisible never shows HANDOFF or ESCALATE lines, even mid-stream", async () => {
  const { streamVisible } = await import("./agent.ts");
  assert.equal(streamVisible("HAND"), "");
  assert.equal(streamVisible("HANDOFF: refund"), "");
  assert.equal(streamVisible("Hello"), "Hello");
  assert.equal(streamVisible("It failed.\nES"), "It failed.");
  assert.equal(streamVisible("It failed.\nESCALATE: POST /api/billing 500"), "It failed.");
  assert.equal(streamVisible("It failed.\nEspecially"), "It failed.\nEspecially");
  // Mid-line, as some models write it.
  assert.equal(streamVisible("I've flagged it. ESCAL"), "I've flagged it.");
  assert.equal(streamVisible("I've flagged it. ESCALATE: POST /api/billing 500"), "I've flagged it.");
  assert.equal(streamVisible("Ends with E"), "Ends with");
});

test("parseReply finds ESCALATE mid-line too", async () => {
  const { parseReply } = await import("./agent.ts");
  assert.deepEqual(parseReply("It failed with a 500 at 17:06. I've flagged this to the team. ESCALATE: POST /api/billing returns 500"), {
    kind: "answer",
    text: "It failed with a 500 at 17:06. I've flagged this to the team.",
    escalate: "POST /api/billing returns 500",
  });
});

test("citations in full-width brackets (some models) are understood", () => {
  const { text, sources } = resolveCitations("Refunds within 14 days【1】 or credit【2†L3-L5】.", [hit("A"), hit("B")]);
  assert.equal(text, "Refunds within 14 days[1] or credit[2].");
  assert.equal(sources.length, 2);
});
