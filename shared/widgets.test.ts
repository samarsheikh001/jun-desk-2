import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkWidget, matchWidgetAction, nodeText, parseWidgetFile, renderWidget, widgetActionLine, widgetData, WidgetError } from "./widgets.ts";

// A widget exported from ChatKit Studio's Download (2026-10-10), with the Studio's own render of its
// default state as `outputJsonPreview`: our interpreter must produce the same tree.
const studio = readFileSync(new URL("./fixtures/studio-probe.widget", import.meta.url), "utf8");

test("a ChatKit Studio export renders like the Studio's own preview", () => {
  const spec = parseWidgetFile("probe", studio);
  assert.equal(spec.title, "Create Event");
  assert.ok(spec.sample, "default state decoded from encodedWidget");
  const tree = renderWidget(spec, spec.sample);
  const raw = JSON.parse(studio).outputJsonPreview;
  const preview = typeof raw === "string" ? JSON.parse(raw) : raw;
  // The Studio previews template strings (`${index + 1}`) as text; its compiled template gives the
  // number. Text values are drawn as text either way.
  const text = (n: unknown): unknown => (Array.isArray(n) ? n.map(text) : n && typeof n === "object" ? Object.fromEntries(Object.entries(n).map(([k, v]) => [k, k === "value" && typeof v === "number" ? String(v) : text(v)])) : n);
  assert.deepEqual(text(tree), text(checkWidget(preview)));
});

test("tool results as template data", () => {
  assert.deepEqual(widgetData({ a: 1 }), { a: 1 });
  assert.deepEqual(widgetData([1, 2]), { items: [1, 2] });
  assert.deepEqual(widgetData("x"), { value: "x" });
});

test("widget files: clear errors", () => {
  assert.throws(() => parseWidgetFile("x", "nope"), /JSON/);
  assert.throws(() => parseWidgetFile("x", JSON.stringify({ version: "2.0", template: "{}" })), /version/);
  assert.throws(() => parseWidgetFile("x", JSON.stringify({ version: "1.0" })), /template is required/);
  assert.throws(() => parseWidgetFile("x", JSON.stringify({ version: "1.0", template: "{{ f() }}" })), /template:/);
  const spec = parseWidgetFile("x", JSON.stringify({ version: "1.0", name: "X", template: '{"type":"Card","children":[{"type":"Text","value":{{ v }}}]}' }));
  assert.throws(() => renderWidget(spec, { v: "unquoted" }), /valid JSON/);
});

test("trees: known components, a root container, limits; nulls dropped", () => {
  assert.throws(() => checkWidget({ type: "Text", value: "x" }), /root must be/);
  assert.throws(() => checkWidget({ type: "Card", children: [{ type: "script" }] }), /unknown component "script"/);
  assert.throws(() => checkWidget({ type: "Card", children: [{ value: "x" }] }), WidgetError);
  assert.throws(() => checkWidget({ type: "Card", children: Array.from({ length: 500 }, () => ({ type: "Divider" })) }), /more than/);
  assert.deepEqual(checkWidget({ type: "Card", border: null, children: [null, { type: "Text", value: "a", color: null }] }), { type: "Card", children: [{ type: "Text", value: "a" }] });
});

const card = checkWidget({
  type: "Card",
  confirm: { label: "Add to calendar", action: { type: "calendar.add", payload: { id: 1 } } },
  cancel: { label: "Discard", action: { type: "calendar.discard" } },
  children: [
    { type: "Title", value: "Lunch" },
    { type: "Form", onSubmitAction: { type: "note.save" }, children: [{ type: "Input", name: "note" }, { type: "Checkbox", name: "remind" }, { type: "Button", label: "Save", submit: true }] },
    { type: "Button", label: "Open", onClickAction: { type: "open", payload: { url: "x" } } },
  ],
});

test("a visitor's action must be one the widget offers; only its fields' values are kept", () => {
  assert.deepEqual(matchWidgetAction(card, { type: "calendar.add", payload: { id: 1 } }, {}), { label: "Add to calendar", action: { type: "calendar.add", payload: { id: 1 } }, values: {} });
  assert.equal(matchWidgetAction(card, { type: "calendar.add", payload: { id: 2 } }, {}), null, "payload must match");
  assert.equal(matchWidgetAction(card, { type: "refund.issue" }, {}), null);
  assert.deepEqual(matchWidgetAction(card, { type: "note.save" }, { note: "hi", remind: true, admin: "yes", n: 3 })?.values, { note: "hi", remind: true });
  assert.equal(matchWidgetAction(card, { type: "note.save" }, {})?.label, "Save");
  assert.equal(matchWidgetAction(card, { type: "open", payload: { url: "x" } }, {})?.label, "Open");
});

test("text of a card, and the history line for an action", () => {
  assert.equal(nodeText(card), "Lunch · Save · Open");
  assert.equal(
    widgetActionLine("Save", { widgetId: "w1", widget: "event", type: "note.save", values: { note: "hi" } }),
    '[On the event card the customer pressed "Save": action note.save, entered {"note":"hi"}]',
  );
});
