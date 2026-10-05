import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanUrl, describeEvents, isIssue, redact, sanitizeContext } from "./debug.ts";

test("redact masks emails, tokens, keys, secrets and card-like numbers", () => {
  const out = redact(
    "user pat@customer.test failed: Bearer abc.def.ghi token=xyz123 password: hunter2 sk_live_4eC39HqLyjWDarjtT1zdp7dc card 4242 4242 4242 4242 jwt eyJhbGciOi.eyJzdWIiOi.SflKxwRJ",
  );
  assert.doesNotMatch(out, /pat@customer\.test|hunter2|xyz123|4242 4242|sk_live_4eC|eyJhbGciOi/);
  assert.match(out, /\[email\]/);
  assert.match(out, /Bearer \[token\]/);
  assert.match(out, /token=\[redacted\]/);
  assert.match(out, /password: \[redacted\]/);
  assert.match(out, /\[key\]/);
  assert.match(out, /\[number\]/);
});

test("cleanUrl keeps paths but drops query values", () => {
  assert.equal(cleanUrl("https://app.acme.dev/billing?invoice=inv_2041&email=pat@x.dev#top", "https://app.acme.dev"), "/billing?invoice=…&email=…");
  assert.equal(cleanUrl("https://api.stripe.com/v1/charges?key=sk_live_x", "https://app.acme.dev"), "https://api.stripe.com/v1/charges?key=…");
  // Relative URLs (or no page origin known) never get an invented origin.
  assert.equal(cleanUrl("/api/billing?id=7"), "/api/billing?id=…");
  assert.equal(cleanUrl("/api/billing", undefined), "/api/billing");
});

test("sanitizeContext re-redacts, drops unknown fields and bad events, caps sizes", () => {
  const ctx = sanitizeContext({
    page: { url: "https://app.acme.dev/billing?token=secret", title: "Billing for pat@customer.test" },
    userAgent: "Mozilla/5.0",
    viewport: { w: 1280, h: 800 },
    language: "en-GB",
    timezone: "Europe/London",
    capturedAt: 1,
    cookies: "should be dropped",
    events: [
      { t: 2, kind: "network", method: "post", url: "https://app.acme.dev/api/billing?email=pat@x.dev", status: 500, durationMs: 231.7, body: "{secret}" },
      { t: 1, kind: "error", message: "Failed for pat@customer.test", source: "app.js:10", stack: "a\nb\nc\nd\ne\nf\ng" },
      { t: 3, kind: "keylogger", message: "nope" },
      "garbage",
    ],
  })!;
  assert.equal(ctx.page.url, "https://app.acme.dev/billing?token=…");
  assert.equal(ctx.page.title, "Billing for [email]");
  assert.equal((ctx as unknown as Record<string, unknown>).cookies, undefined);
  assert.equal(ctx.events.length, 2);
  assert.deepEqual(ctx.events[1], { t: 2, kind: "network", method: "POST", url: "/api/billing?email=…", status: 500, durationMs: 231 });
  assert.equal(ctx.events[0]!.message, "Failed for [email]");
  assert.equal(ctx.events[0]!.stack!.split("\n").length, 5);
  assert.equal(sanitizeContext("nope"), null);
});

test("issues are errors and failed requests; descriptions read well", () => {
  const ctx = sanitizeContext({
    page: { url: "https://a.dev/x" },
    timezone: "UTC",
    events: [
      { t: Date.UTC(2026, 9, 4, 14, 2, 11), kind: "network", method: "POST", url: "https://a.dev/api/billing", status: 500, durationMs: 230 },
      { t: Date.UTC(2026, 9, 4, 14, 1, 0), kind: "navigation", url: "https://a.dev/billing" },
      { t: Date.UTC(2026, 9, 4, 14, 3, 0), kind: "network", method: "GET", url: "https://a.dev/api/me", status: 304 },
    ],
  })!;
  assert.deepEqual(ctx.events.map(isIssue), [false, true, false]);
  assert.deepEqual(describeEvents(ctx), [
    "[14:01:00] Visited /billing",
    "[14:02:11] POST /api/billing → HTTP 500 in 230 ms",
    "[14:03:00] GET /api/me → HTTP 304",
  ]);
});

test("S-12 app errors: message masked and capped, code [\\w.-] only, nothing else kept; an issue", () => {
  const ctx = sanitizeContext({
    page: { url: "https://a.dev/import" },
    timezone: "UTC",
    events: [
      { t: Date.UTC(2026, 9, 5, 9, 0, 0), kind: "app_error", message: "  Row 42: missing email for pat@customer.test (token=abc123)  ", code: "import.row_invalid", stack: "x", url: "https://a.dev/secret?q=1", status: 500 },
      { t: 2, kind: "app_error", message: "x".repeat(5000), code: "bad code!/<script>" + "y".repeat(100) },
      { t: 3, kind: "app_error", message: "Card 4242 4242 4242 4242 declined", code: "sk_live_4eC39HqLyjWDarjtT1zdp7dc" },
      { t: 4, kind: "app_error", message: "   " },
      { t: 5, kind: "app_error", message: { toString: () => "object" } },
      { t: 6, kind: "app_error", message: "No code", code: 42 },
    ],
  })!;
  assert.equal(ctx.events.length, 4);
  assert.deepEqual(ctx.events.at(-1), { t: Date.UTC(2026, 9, 5, 9, 0, 0), kind: "app_error", message: "Row 42: missing email for [email] (token=[redacted])", code: "import.row_invalid" });
  const long = ctx.events.find((e) => e.t === 2)!;
  assert.equal(long.message!.length, 300);
  assert.match(long.code!, /^[\w.-]{1,60}$/);
  assert.ok(long.code!.startsWith("badcodescript"));
  const card = ctx.events.find((e) => e.t === 3)!;
  assert.match(card.message!, /^Card \[number\] ?declined$/);
  assert.equal(card.code, "key");
  assert.deepEqual(ctx.events.find((e) => e.t === 6), { t: 6, kind: "app_error", message: "No code" });
  assert.ok(ctx.events.every(isIssue));
  assert.equal(describeEvents(ctx).at(-1), "[09:00:00] The app reported an error: Row 42: missing email for [email] (token=[redacted]) (code import.row_invalid)");
  assert.equal(describeEvents({ ...ctx, events: [{ t: 0, kind: "app_error", message: "Upload too big" }] })[0], "[00:00:00] The app reported an error: Upload too big");
});
