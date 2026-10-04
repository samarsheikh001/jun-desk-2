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
