import assert from "node:assert/strict";
import { test } from "node:test";
import { APPEARANCE_DEFAULTS, applyAppearance, radiusVars, textOn, widgetLook } from "./appearance.ts";

test("appearance: an untouched desk gets the original look", () => {
  assert.deepEqual(widgetLook({}, "Acme", null), {
    workspaceName: "Acme",
    greeting: "Hi! How can we help?",
    color: "#2f5bea",
    position: "right",
    replyTime: "We usually reply in a few minutes",
    logoUrl: null,
    theme: "auto",
    radius: 16,
    launcher: "button",
    placeholder: "Write a message…",
    suggestions: [],
  });
  assert.deepEqual(radiusVars(APPEARANCE_DEFAULTS.radius), { "--r-md": "14px", "--r-sm": "8px" });
});

test("appearance: reading is lenient (half-typed drafts, hand-edited rows)", () => {
  const look = widgetLook({ color: "#12", radius: 99, theme: "neon", launcher: 3, greeting: "  ", suggestions: ["  ", "Pricing?", 7, "a", "b", "c"] }, "Acme", null);
  assert.equal(look.color, "#2f5bea");
  assert.equal(look.radius, 16);
  assert.equal(look.theme, "auto");
  assert.equal(look.launcher, "button");
  assert.equal(look.greeting, "Hi! How can we help?");
  assert.deepEqual(look.suggestions, ["Pricing?", "a", "b", "c"]);
  assert.equal(widgetLook({ radius: 0 }, "Acme", null).radius, 0);
});

test("appearance: writing is strict, and empty text clears a field", () => {
  const settings: Record<string, unknown> = { greeting: "Old" };
  applyAppearance(settings, { color: "#FF6600", theme: "dark", radius: 4, launcher: "card", greeting: " ", placeholder: " Ask   us ", suggestions: [" How much? ", ""] });
  assert.deepEqual(settings, { color: "#ff6600", theme: "dark", radius: 4, launcher: "card", placeholder: "Ask us", suggestions: ["How much?"] });
  for (const body of [{ color: "blue" }, { position: "top" }, { theme: "neon" }, { launcher: "banner" }, { radius: 25 }, { radius: 2.5 }, { radius: "4" }, { placeholder: "x".repeat(61) }, { suggestions: "a" }, { suggestions: ["1", "2", "3", "4", "5"] }, { suggestions: ["x".repeat(81)] }]) {
    assert.throws(() => applyAppearance({}, body), Error, JSON.stringify(body));
  }
  applyAppearance(settings, { suggestions: [] });
  assert.equal(settings.suggestions, undefined);
});

test("appearance: readable text on the brand colour", () => {
  assert.equal(textOn("#2f5bea"), "#ffffff");
  assert.equal(textOn("#ffe066"), "#1c1c1a");
});
