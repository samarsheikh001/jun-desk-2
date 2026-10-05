import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeContext } from "./debug.ts";
import {
  buildDraft,
  errorsSection,
  environmentSection,
  failingRequestsSection,
  fallbackNarrative,
  inferSteps,
  ISSUE_BODY_MAX,
  issueFactsText,
  parseIssueInput,
  parseNarrative,
  parseRepo,
  type IssueFacts,
} from "./issues.ts";

const T = Date.UTC(2026, 9, 5, 13, 2, 11);
const ctx = sanitizeContext({
  page: { url: "https://app.acme.dev/billing?session=abc123", title: "Billing · pat@customer.test" },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  viewport: { w: 1440, h: 900 },
  language: "en-GB",
  timezone: "Europe/London",
  capturedAt: T + 5000,
  events: [
    { t: T - 60_000, kind: "navigation", url: "https://app.acme.dev/dashboard" },
    { t: T - 30_000, kind: "navigation", url: "https://app.acme.dev/billing" },
    { t: T - 20_000, kind: "network", method: "GET", url: "https://app.acme.dev/api/me", status: 200, durationMs: 40 },
    { t: T, kind: "network", method: "POST", url: "https://app.acme.dev/api/billing?email=pat@customer.test", status: 500, durationMs: 231 },
    { t: T + 1000, kind: "error", message: "Payment failed for pat@customer.test", source: "https://app.acme.dev/assets/checkout.js:120", stack: "Error: Payment failed\n    at pay (https://app.acme.dev/assets/checkout.js:120:7)\n    at onClick (x.js:1:1)" },
  ],
})!;
const { events, ...environment } = ctx;

const facts: IssueFacts = {
  conversationUrl: "https://desk.acme.dev/inbox/cv_123",
  transcript: [
    { who: "Customer", body: "Why can't I pay my invoice?\nIt just says something went wrong." },
    { who: "AI", body: "Sorry! The payment request failed on our side." },
    { who: "Team note", body: "Probably the Stripe outage" },
  ],
  environment,
  events,
  account: { company: "Initech", plan: "pro" },
};

test("repo setting: owner/name or a github.com URL", () => {
  assert.equal(parseRepo("acme/web-app"), "acme/web-app");
  assert.equal(parseRepo(" https://github.com/acme/web.app.git/ "), "acme/web.app");
  for (const bad of ["acme", "acme/", "/x", "a/b/c", "-acme/x", "acme/..", "acme/has space", 7, null]) assert.equal(parseRepo(bad), null, String(bad));
});

test("failing requests: only failures, masked URL, status, time in the visitor's zone, duration", () => {
  const section = failingRequestsSection(events, "Europe/London");
  assert.match(section, /^## Failing requests/);
  assert.match(section, /\| 14:02:11 \| `POST \/api\/billing\?email=…` \| 500 \| 231 ms \|/);
  assert.doesNotMatch(section, /api\/me/);
  assert.doesNotMatch(section, /pat@customer/);
  assert.equal(failingRequestsSection([]), "## Failing requests\n\nNone recorded.");
  // A network failure without a status; pipes can't break the table.
  assert.match(failingRequestsSection([{ t: T, kind: "network", method: "GET", url: "/a|b", status: 0, message: "Failed to fetch" }], "UTC"), /`GET \/a\\\|b` \| no response \(Failed to fetch\) \| – \|/);
});

test("errors: message and the top stack frame", () => {
  const section = errorsSection(events, "Europe/London");
  assert.match(section, /- 14:02:12 `Payment failed for \[email\]`\n {2}`at pay \(https:\/\/app\.acme\.dev\/assets\/checkout\.js:120:7\)`/);
  assert.match(errorsSection([{ t: T, kind: "error", message: "x is `undefined`", source: "a.js:3" }], "UTC"), /`x is 'undefined'`\n {2}`a\.js:3`/);
  assert.equal(errorsSection([]), "## Errors\n\nNone recorded.");
});

test("S-12 app errors: in the Errors section, the steps and the fallback's actual", () => {
  const app = sanitizeContext({ page: { url: "https://app.acme.dev/import" }, events: [{ t: T + 2000, kind: "app_error", message: "Row 42: missing `email` for pat@customer.test", code: "import.row_invalid" }] })!.events;
  const all = [...events, ...app];
  const section = errorsSection(all, "Europe/London");
  assert.match(section, /- 14:02:12 `Payment failed for \[email\]`/);
  assert.match(section, /- 14:02:13 Reported by the app: `Row 42: missing 'email' for \[email\]` \(code `import\.row_invalid`\)/);
  assert.equal(inferSteps({ environment, events: all }).at(-1), "The app reports an error: `Row 42: missing 'email' for [email]` (code `import.row_invalid`)");
  const withApp = { ...facts, events: all };
  assert.equal(fallbackNarrative(withApp).actual, "The app reported: `Row 42: missing 'email' for [email]` (code `import.row_invalid`).");
  assert.match(buildDraft(fallbackNarrative(withApp), withApp).body, /## Errors\n\n[^#]*Reported by the app: `Row 42/);
});

test("environment: browser, OS, screen, locale, page; account without personal data", () => {
  const section = environmentSection(environment, facts.account);
  assert.match(section, /- Page: `https:\/\/app\.acme\.dev\/billing\?session=…` \(Billing · \[email\]\)/);
  assert.match(section, /- Browser: Chrome 141\n- OS: Windows\n- Screen: 1440×900\n- Locale: en-GB · Europe\/London/);
  assert.match(section, /- Recorded: 2026-10-05 14:02 \(Europe\/London\)/);
  assert.match(section, /- Account: Initech\n- Plan: pro/);
  assert.match(environmentSection(null), /No browser details/);
});

test("steps are inferred from the page trail up to the last failure", () => {
  assert.deepEqual(inferSteps(facts), [
    "Open `/dashboard`",
    "Open `/billing`",
    "The page sends `POST /api/billing?email=…`, which fails with HTTP 500",
    "A JavaScript error is thrown: `Payment failed for [email]`",
  ]);
  assert.deepEqual(inferSteps({ environment, events: [] }), ["Open `https://app.acme.dev/billing?session=…`"]);
  assert.match(inferSteps({ environment: null, events: [] })[0]!, /^Unknown/);
});

test("fallback draft: title from the first customer message, facts only", () => {
  const n = fallbackNarrative(facts);
  assert.equal(n.title, "Why can't I pay my invoice? It just says something went wrong.");
  assert.equal(n.expected, "Unknown");
  assert.equal(n.actual, "`POST /api/billing?email=…` returned HTTP 500.");
  assert.equal(fallbackNarrative({ ...facts, events: events.filter((e) => e.kind === "error") }).actual, "JavaScript error: `Payment failed for [email]`.");
  const long = fallbackNarrative({ ...facts, transcript: [{ who: "Customer", body: `My email is pat@customer.test and ${"x".repeat(200)}` }], events: [] });
  assert.ok(long.title.length <= 80 && long.title.endsWith("…"));
  assert.match(long.title, /\[email\]/);
  assert.equal(long.actual, "Unknown");
  assert.equal(fallbackNarrative({ ...facts, transcript: [] }).title, "Problem reported in a support conversation");
});

test("the model's answer is parsed, masked and capped; no title means use the template", () => {
  const n = parseNarrative(`**TITLE:** "Invoice payment fails with HTTP 500"
SUMMARY:
The customer tried to pay. Contact pat@customer.test today.
STEPS:
1. Open /billing
2) Click Pay
- Wait
EXPECTED: The invoice is paid.
ACTUAL:
POST /api/billing returned 500.`)!;
  assert.equal(n.title, "Invoice payment fails with HTTP 500");
  assert.equal(n.summary, "The customer tried to pay. Contact [email] today.");
  assert.deepEqual(n.steps, ["Open /billing", "Click Pay", "Wait"]);
  assert.equal(n.expected, "The invoice is paid.");
  assert.equal(n.actual, "POST /api/billing returned 500.");
  assert.deepEqual(parseNarrative("TITLE: Broken\nSUMMARY: x")!.steps, ["Unknown"]);
  assert.equal(parseNarrative("TITLE: Broken\nSUMMARY: x")!.actual, "Unknown");
  assert.equal(parseNarrative("Here is your issue: it's broken"), null);
  assert.equal(parseNarrative("TITLE: Unknown"), null);
  assert.equal(parseNarrative('TITLE: Pay fails: "Something went wrong"')!.title, 'Pay fails: "Something went wrong"');
  assert.equal(parseNarrative('TITLE: "Pay fails"')!.title, "Pay fails");
  assert.equal(parseNarrative(`TITLE: ${"y".repeat(400)}`)!.title.length, 256);
});

test("the draft has every section and the link back; facts for the model hold no email", () => {
  const draft = buildDraft(fallbackNarrative(facts), facts);
  const headings = [...draft.body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ["Summary", "Steps to reproduce", "Expected vs actual", "Failing requests", "Errors", "Environment"]);
  assert.match(draft.body, /_Inferred from the visitor's session/);
  assert.match(draft.body, /\n1\. Open `\/dashboard`\n2\. Open `\/billing`\n/);
  assert.ok(draft.body.endsWith("---\nFrom a support conversation in Jun Desk: https://desk.acme.dev/inbox/cv_123"));
  assert.doesNotMatch(draft.body, /pat@customer|abc123/);

  const text = issueFactsText(facts);
  assert.match(text, /Customer: Why can't I pay/);
  assert.match(text, /Team note: Probably the Stripe outage/);
  assert.match(text, /POST \/api\/billing\?email=… → HTTP 500/);
  assert.match(text, /Customer account: Initech, plan pro/);
  assert.doesNotMatch(text, /@/);

  const huge = buildDraft({ ...fallbackNarrative(facts), summary: "z".repeat(ISSUE_BODY_MAX) }, facts);
  assert.ok(huge.body.length <= ISSUE_BODY_MAX);
  assert.match(huge.body, /_\(truncated\)_\n\n---\nFrom a support conversation/);
});

test("filing input: lengths, labels, and the body is masked again", () => {
  const input = parseIssueInput({ title: "  Pay   fails ", body: "pasted: Bearer abc.def password=hunter2 pat@customer.test 4242 4242 4242 4242", labels: ["bug", " bug ", "billing", ""] });
  assert.equal(input.title, "Pay fails");
  assert.doesNotMatch(input.body, /abc\.def|hunter2|pat@customer|4242 4242/);
  assert.deepEqual(input.labels, ["bug", "billing"]);
  assert.deepEqual(parseIssueInput({ title: "x" }), { title: "x", body: "", labels: [] });
  assert.throws(() => parseIssueInput({ title: " " }), /needs a title/);
  assert.throws(() => parseIssueInput({ title: "x".repeat(257) }), /256/);
  assert.equal(parseIssueInput({ title: "x".repeat(256) }).title.length, 256);
  assert.throws(() => parseIssueInput({ title: "x", body: "y".repeat(ISSUE_BODY_MAX + 1) }), /60,000/);
  assert.throws(() => parseIssueInput({ title: "x", body: 5 }), /text/);
  assert.throws(() => parseIssueInput({ title: "x", labels: "bug" }), /list/);
  assert.throws(() => parseIssueInput({ title: "x", labels: Array.from({ length: 11 }, (_, i) => `l${i}`) }), /At most 10/);
  assert.throws(() => parseIssueInput({ title: "x", labels: ["l".repeat(51)] }), /50 characters/);
});
