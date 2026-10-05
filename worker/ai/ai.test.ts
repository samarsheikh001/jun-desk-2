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
  const prompt = systemPrompt({ workspaceName: "Acme", persona: "Be brief.", hits: [hit("Refunds", "https://acme.dev/refunds")] });
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

test("S-11 nudge: facts describe the failure; unsafe or rambling lines fall back", async () => {
  const { cleanNudge, nudgeFacts, GENERIC_NUDGE } = await import("./nudge.ts");
  const page = { url: "https://app.acme.test/billing", title: "Billing" };
  assert.match(nudgeFacts({ t: 1, kind: "network", method: "POST", url: "/api/billing", status: 500 }, page), /POST \/api\/billing → HTTP 500/);
  assert.match(nudgeFacts({ t: 1, kind: "error", message: "TypeError: x is undefined", source: "/chart.js:4" }, page), /JavaScript error happened: TypeError/);
  assert.equal(cleanNudge('"Looks like your invoice payment didn\'t go through. Want a hand?"'), "Looks like your invoice payment didn't go through. Want a hand?");
  assert.equal(cleanNudge("Looks like the usage chart didn't load"), "Looks like the usage chart didn't load. Want a hand?");
  assert.equal(cleanNudge("Your POST to /api/billing returned 500. Want a hand?"), null);
  assert.equal(cleanNudge("A TypeError happened. Want a hand?"), null);
  assert.equal(cleanNudge(`${"Very long ".repeat(20)}Want a hand?`), null);
  assert.equal(cleanNudge(GENERIC_NUDGE), GENERIC_NUDGE);
  // S-12: the app's own words; its numbers ("row 142") may show, its code never reaches the model.
  const facts = nudgeFacts({ t: 1, kind: "app_error", message: "Row 142: missing email", code: "import.row_invalid" }, { url: "/import", title: "Import contacts" });
  assert.match(facts, /in its own words: "Row 142: missing email"/);
  assert.doesNotMatch(facts, /import\.row_invalid/);
  assert.equal(cleanNudge("Your CSV import failed on row 142. Want a hand?", "Row 142: missing email"), "Your CSV import failed on row 142. Want a hand?");
  assert.equal(cleanNudge("Your CSV import failed on row 142. Want a hand?"), null);
  assert.equal(cleanNudge("Your import got HTTP 500. Want a hand?", "Row 142: missing email"), null);
  assert.equal(cleanNudge("Row 9 for [email] wasn't imported. Want a hand?", "Row 9: missing name for [email]"), null);
});

test("S-02 / S-13 nudge: rage clicks and stuck pages as plain facts; one cache line per element / page and issue", async () => {
  const { cleanNudge, nudgeCacheKey, nudgeFacts } = await import("./nudge.ts");
  const page = { url: "https://app.acme.test/reports", title: "Reports" };
  const rage = nudgeFacts({ t: 1, kind: "rage_click", count: 4, target: { tag: "button", id: "export-btn", text: "Export CSV" } }, page);
  assert.match(rage, /clicked the "Export CSV" button 4 times in a row and nothing happened/);
  assert.doesNotMatch(rage, /export-btn/, "ids are for agents, not the line");
  assert.match(nudgeFacts({ t: 1, kind: "rage_click", count: 3, target: { tag: "a" } }, page), /clicked a link 3 times/);
  assert.match(nudgeFacts({ t: 1, kind: "rage_click", count: 3, target: { tag: "div" } }, page), /clicked something on the page 3 times/);
  const stuck = nudgeFacts({ t: 1, kind: "stuck", url: "/reports", seconds: 185, issue: "network" }, page);
  assert.match(stuck, /on this page for 3 min after a failed request/);
  assert.match(stuck, /Still working on this\? Want a hand\?/);
  // The filter still applies; numbers on the button the visitor sees may show.
  assert.equal(cleanNudge("Looks like that button isn't responding. Want a hand?"), "Looks like that button isn't responding. Want a hand?");
  assert.equal(cleanNudge("Still working on this? Want a hand?"), "Still working on this? Want a hand?");
  assert.equal(cleanNudge("Looks like the Pay 250 button isn't responding. Want a hand?", "Pay 250"), "Looks like the Pay 250 button isn't responding. Want a hand?");
  assert.equal(cleanNudge("The button#export-btn click threw an error. Want a hand?"), null);
  const key = (seconds: number) => nudgeCacheKey("ws", { t: 1, kind: "stuck", url: "/reports", seconds, issue: "network" }, page);
  assert.equal(key(180), key(240));
  assert.notEqual(
    nudgeCacheKey("ws", { t: 1, kind: "rage_click", count: 3, target: { tag: "button", text: "Export" } }, page),
    nudgeCacheKey("ws", { t: 1, kind: "rage_click", count: 3, target: { tag: "button", text: "Save" } }, page),
  );
});

test("K-04: excluded pages match by exact URL or path prefix", async () => {
  const { isExcluded } = await import("./urls.ts");
  const rules = ["https://docs.acme.test/old-page?utm_source=x", "/blog/", "/changelog*"];
  assert.equal(isExcluded(new URL("https://docs.acme.test/old-page"), rules), true, "exact URL (tracking params dropped)");
  assert.equal(isExcluded(new URL("https://docs.acme.test/old-page-2"), rules), false);
  assert.equal(isExcluded(new URL("https://docs.acme.test/blog/launch"), rules), true);
  assert.equal(isExcluded(new URL("https://docs.acme.test/changelog-2026"), rules), true);
  assert.equal(isExcluded(new URL("https://docs.acme.test/guides/blog/"), rules), false, "prefixes start at the root");
  assert.equal(isExcluded(new URL("https://docs.acme.test/x"), undefined), false);
});

test("P-01 page opener: facts from title, path and hint; technical or alarming lines fall back", async () => {
  const { cleanOpener, openerFacts, GENERIC_OPENER } = await import("./nudge.ts");
  const facts = openerFacts({ path: "/pricing", title: "Pricing – Acme" }, "help choosing between Team and Business");
  assert.match(facts, /Page title: Pricing – Acme/);
  assert.match(facts, /Page path: \/pricing/);
  assert.match(facts, /wants to offer on this page: help choosing between Team and Business/);
  assert.doesNotMatch(openerFacts({ path: "/", title: "" }), /offer/);
  assert.match(openerFacts({ path: "/", title: "" }), /\(untitled\)/);
  assert.equal(cleanOpener('"Comparing plans? Happy to help you pick the right one."'), "Comparing plans? Happy to help you pick the right one.");
  assert.equal(cleanOpener("Questions about our plans\nSure!"), "Questions about our plans.");
  assert.equal(cleanOpener(GENERIC_OPENER), GENERIC_OPENER);
  assert.equal(cleanOpener("Need help with the /docs/api page?"), null);
  assert.equal(cleanOpener("Seeing an error on this page?"), null);
  assert.equal(cleanOpener("Something went wrong? We can help."), null);
  assert.equal(cleanOpener("Having problems with billing?"), null);
  assert.equal(cleanOpener("Check https://acme.com for prices."), null);
  assert.equal(cleanOpener(`${"Very long ".repeat(15)}line.`), null);
  assert.equal(cleanOpener("  "), null);
});
