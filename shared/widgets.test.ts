import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { actionUrl, checkWidget, itemIds, markWidgetUsed, matchWidgetAction, nodeText, parseWidgetFile, renderWidget, TOOL_ACTION, toolActionInput, widgetActionLine, widgetActionUsed, widgetData, WidgetError } from "./widgets.ts";

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

// W-17: a product list: one "Add" per row (a tool action), a link per row, and a card-level checkout.
const shop = checkWidget({
  type: "ListView",
  children: [
    { type: "ListViewItem", children: [{ type: "Text", value: "Red dress" }, { type: "Button", label: "Add", onClickAction: { type: "tool:add_to_cart", payload: { sku: "R1" } } }, { type: "Button", label: "View", onClickAction: { type: "open_url", payload: { url: "https://shop.test/r1" } } }] },
    { type: "ListViewItem", children: [{ type: "Text", value: "Blue dress" }, { type: "Button", label: "Add", onClickAction: { type: "tool:add_to_cart", payload: { sku: "B2" } } }] },
    { type: "ListViewItem", onClickAction: { type: "pick" }, children: [{ type: "Text", value: "Same action" }] },
    { type: "ListViewItem", onClickAction: { type: "pick" }, children: [{ type: "Text", value: "Same action again" }] },
  ],
});

test("W-17: list items have ids and their own actions; used one by one", () => {
  assert.deepEqual([...itemIds(shop).values()], ["i0", "i1", "i2", "i3"]);
  const blue = matchWidgetAction(shop, { type: "tool:add_to_cart", payload: { sku: "B2" } }, {}, "i1");
  assert.equal(blue?.item, "i1");
  // The same action in two rows: the row the visitor names.
  assert.equal(matchWidgetAction(shop, { type: "pick" }, {}, "i3")?.item, "i3");
  assert.equal(matchWidgetAction(shop, { type: "pick" }, {})?.item, "i2");
  const widget = { id: "w1", name: "shop", root: shop };
  const after = markWidgetUsed(widget, "Add", "i1", 1);
  assert.equal(widgetActionUsed(after, "i1"), true);
  assert.equal(widgetActionUsed(after, "i0"), false, "other rows still work");
  assert.equal(widgetActionUsed(markWidgetUsed(widget, "Checkout", undefined, 1), "i0"), true, "a used card turns every row off");
});

test("W-17: links open in the browser (https only) and are never sent", () => {
  assert.equal(actionUrl({ type: "open_url", payload: { url: "https://shop.test/r1" } }), "https://shop.test/r1");
  assert.equal(actionUrl({ type: "open_url", payload: { url: "javascript:alert(1)" } }), null);
  assert.equal(actionUrl({ type: "open_url", payload: { url: "http://shop.test" } }), null);
  assert.equal(matchWidgetAction(shop, { type: "open_url", payload: { url: "https://shop.test/r1" } }, {}, "i0"), null);
});

test("W-17: a tool action's input is its payload plus what was entered, only the tool's own inputs, typed", () => {
  const input = toolActionInput({ type: "tool:add_to_cart", payload: { sku: "R1", admin: true } }, { size: "M", qty: "2", gift: true }, { sku: { type: "string" }, size: { type: "string" }, qty: { type: "integer" }, gift: { type: "boolean" } });
  assert.deepEqual(input, { sku: "R1", size: "M", qty: 2, gift: true });
  assert.equal(TOOL_ACTION.exec("tool:add_to_cart")?.[1], "add_to_cart");
  assert.equal(
    widgetActionLine("Add", { widgetId: "w1", widget: "shop", type: "tool:add_to_cart", payload: { sku: "R1" }, item: "i0", tool: { name: "add_to_cart", status: "ok", output: '{"items":1}' } }),
    '[On the shop card the customer pressed "Add": action tool:add_to_cart, payload {"sku":"R1"}]\n[That ran add_to_cart: done. Result: {"items":1}]',
  );
});
