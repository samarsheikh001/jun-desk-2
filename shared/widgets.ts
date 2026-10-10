// W-09 (D-43): ChatKit-compatible widgets. A widget is a small card the AI shows in the chat,
// built from a tool's result: `widgets/<name>.widget` (exported from ChatKit Studio, or written
// by hand) holds a Jinja template that renders to the widget's JSON tree, and a tool with
// `widget: <name>` fills it with its response. The format is OpenAI's ChatKit widget format
// (component names and props per openai/chatkit-python `chatkit/widgets.py` and openai/chatkit-js
// `widgets.d.ts`, both Apache-2.0); the template runs in our own interpreter (shared/jinja.ts) and
// the tree is drawn by our own renderer (web/widget/chatkit/). Pure: Worker, widget and tests.

import { compileTemplate, TemplateError, type Template } from "./jinja.ts";

/** Every component the renderer knows. Anything else makes the widget invalid. */
export const WIDGET_COMPONENTS = new Set([
  "Basic", "Card", "ListView", "ListViewItem",
  "Box", "Row", "Col", "Form", "Spacer", "Divider", "Transition",
  "Table", "Table.Row", "Table.Cell",
  "Text", "Title", "Caption", "Markdown", "Label", "Badge", "Icon", "Image", "Chart",
  "Button", "Input", "Textarea", "Select", "DatePicker", "Checkbox", "RadioGroup",
]);
const ROOTS = new Set(["Basic", "Card", "ListView"]);
/** Components that hold a value the visitor enters (sent with a form's action under `name`). */
const FIELDS = new Set(["Input", "Textarea", "Select", "DatePicker", "Checkbox", "RadioGroup"]);

export const MAX_WIDGET_NODES = 400;
export const MAX_WIDGET_DEPTH = 24;
export const MAX_WIDGET_JSON = 48 * 1024;
const MAX_STRING = 4000;
/** D-47: a `summary` template's length, and the rendered line's. */
export const MAX_SUMMARY_TEMPLATE = 200;
export const MAX_SUMMARY = 80;
/** Values the visitor sends with an action: fields, and characters per field. */
export const MAX_ACTION_VALUES = 30;
export const MAX_ACTION_VALUE = 2000;

export class WidgetError extends Error {}

/** One node of a widget tree: `type` plus its props (and `children`). Loose by design: unknown props are ignored. */
export interface WidgetNode {
  type: string;
  children?: WidgetNode[];
  [prop: string]: unknown;
}

/** What a button, list item, form or card confirm/cancel sends: ChatKit's ActionConfig. */
export interface WidgetActionConfig {
  type: string;
  payload?: unknown;
  /**
   * ChatKit: "client" hands the action to the host page (the loader's `widgetAction` event), never
   * to the server; "server" (the default) sends it. Read only in the browser.
   */
  handler?: "server" | "client";
  /** ChatKit: what shows as busy while it's sent ("auto": the pressed control; a card's confirm: the card). */
  loadingBehavior?: "auto" | "none" | "self" | "container";
}

/** ChatKit's `handler: "client"`: the action goes to the host page, never to the server. */
export function isClientAction(value: unknown): boolean {
  return isRecord(value) && value.handler === "client";
}

/** A widget the AI showed (in `meta.widgets` of its message, and live on the tool's step). */
export interface MessageWidget {
  /** Opaque per message, for actions (`w<n>`). */
  id: string;
  /** The widget file's name (`widgets/<name>.widget`); agents see it, the AI's history too. */
  name: string;
  root: WidgetNode;
  /**
   * D-47: the file's own one-line summary (its `summary` template rendered with the same data;
   * plain text, ≤ 80 chars). The island's folded pill shows it before guessing with `widgetSummary`.
   */
  summary?: string;
  /** Set once the visitor used one of the card's own actions (confirm, a form, a button outside a list): it takes no more. */
  used?: { label: string; at: number };
  /** W-17: list items used one by one (by item id, `i<n>`): only that row is done, the rest still work. */
  items?: Record<string, { label: string; at: number }>;
}

/** W-17: `tool:<name>` on a button runs that tool at once (the press is the visitor's yes); the AI then answers. */
export const TOOL_ACTION = /^tool:([a-z][a-z0-9_]*)$/;
/** W-17: `open_url` with `payload.url` opens an https link (checkout, invoice); handled in the browser, never sent. */
export const OPEN_URL = "open_url";

/** The https URL an `open_url` action opens, or null. */
export function actionUrl(action: WidgetActionConfig): string | null {
  if (action.type !== OPEN_URL || !isRecord(action.payload) || typeof action.payload.url !== "string") return null;
  return /^https:\/\/[^\s]+$/i.test(action.payload.url) ? action.payload.url : null;
}

/** On the visitor message an action sends (its body is the action's label). */
export interface WidgetActionMeta {
  widgetId: string;
  widget: string;
  type: string;
  payload?: unknown;
  /** What the visitor entered in the card's fields, by field name. */
  values?: Record<string, string | boolean>;
  /** W-17: the list item it was pressed in (only that row is used). */
  item?: string;
  /**
   * W-17: a `tool:<name>` action ran that tool. `output` is never stored here (meta reaches the
   * visitor): the Conversation object keeps it for the AI's history, agents see it in the audit log.
   */
  tool?: { name: string; status: "ok" | "error"; output?: string };
}

/** A parsed `widgets/<name>.widget`. */
export interface WidgetSpec {
  name: string;
  /** The widget's own title in the file ("Order status"). */
  title: string;
  template: Template;
  /** D-47: optional `summary`, a Jinja template for one plain-text line ("{{ high }} · {{ city }}"). */
  summary?: Template;
  /** The data the widget was designed with (ChatKit Studio's default state), when the file has it. */
  sample?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Base64url (ChatKit Studio's `encodedWidget`) to text, in any runtime. */
function decodeBase64Url(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Reads a `.widget` file: `{ version: "1.0", name, template, jsonSchema, … }` (ChatKit Studio's
 * Download). Throws WidgetError with a message for the admin.
 */
export function parseWidgetFile(name: string, text: string): WidgetSpec {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new WidgetError("A .widget file is JSON (download it from ChatKit Studio, or write { \"version\": \"1.0\", \"name\": …, \"template\": … }).");
  }
  if (!isRecord(file)) throw new WidgetError("A .widget file is a JSON object.");
  if (file.version !== "1.0") throw new WidgetError(`Unsupported widget version ${JSON.stringify(file.version ?? null)}: only "1.0".`);
  if (typeof file.template !== "string" || !file.template.trim()) throw new WidgetError("template is required: the widget's Jinja template.");
  let template: Template;
  try {
    template = compileTemplate(file.template);
  } catch (error) {
    throw new WidgetError(`template: ${(error as Error).message}`);
  }
  // `summary` (ours, D-47): one line for the island's folded pill, from the same data as the card.
  let summary: Template | undefined;
  if (file.summary !== undefined && file.summary !== null) {
    if (typeof file.summary !== "string") throw new WidgetError('summary is a Jinja template string, like "{{ plan }} · {{ status }}".');
    if (file.summary.length > MAX_SUMMARY_TEMPLATE) throw new WidgetError(`summary is longer than ${MAX_SUMMARY_TEMPLATE} characters.`);
    if (file.summary.trim()) {
      try {
        summary = compileTemplate(file.summary);
      } catch (error) {
        throw new WidgetError(`summary: ${(error as Error).message}`);
      }
    }
  }
  // `sample`: data to preview and check it with (ours; ChatKit ignores it). Else ChatKit Studio's default state.
  let sample: Record<string, unknown> | undefined = isRecord(file.sample) ? file.sample : undefined;
  if (!sample && typeof file.encodedWidget === "string") {
    try {
      const studio = JSON.parse(decodeBase64Url(file.encodedWidget)) as unknown;
      if (isRecord(studio) && isRecord(studio.defaultState)) sample = studio.defaultState;
    } catch {
      // not ours to judge: the sample is only for checking
    }
  }
  return { name, title: typeof file.name === "string" && file.name.trim() ? file.name.trim() : name, template, ...(summary ? { summary } : {}), ...(sample ? { sample } : {}) };
}

/**
 * D-47: a widget's `summary` line for this data: whitespace collapsed, cut at `MAX_SUMMARY` with
 * "…"; "" when there's no summary or it renders empty (or only punctuation). Throws WidgetError when the template fails.
 */
export function renderSummary(spec: Pick<WidgetSpec, "summary">, data: unknown): string {
  if (!spec.summary) return "";
  let text: string;
  try {
    text = spec.summary.render(widgetData(data));
  } catch (error) {
    throw new WidgetError(`summary: ${(error as Error).message}`);
  }
  const line = text.replace(/\s+/g, " ").trim();
  // Only separators left (" · " with the data missing) says nothing: no line.
  if (!/[\p{L}\p{N}]/u.test(line)) return "";
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1).trimEnd()}…` : line;
}

/** `renderSummary` for a card being shown: a failing summary never fails the card, it's just left out. */
export function summaryFor(spec: Pick<WidgetSpec, "summary">, data: unknown): { summary?: string } {
  try {
    const summary = renderSummary(spec, data);
    return summary ? { summary } : {};
  } catch {
    return {};
  }
}

/** The summary line the dashboard's preview shows (rendered with the sample), or "". */
export function previewSummary(name: string, text: string): string {
  try {
    const spec = parseWidgetFile(name, text);
    return spec.sample ? renderSummary(spec, spec.sample) : "";
  } catch {
    return "";
  }
}

/**
 * A widget's preview: rendered from its sample data, else ChatKit Studio's own render
 * (`outputJsonPreview`). Throws WidgetError when there's nothing to show or it doesn't render.
 */
export function previewWidget(name: string, text: string): WidgetNode {
  const spec = parseWidgetFile(name, text);
  if (spec.sample) return renderWidget(spec, spec.sample);
  const file = JSON.parse(text) as Record<string, unknown>;
  const preview = typeof file.outputJsonPreview === "string" ? (JSON.parse(file.outputJsonPreview) as unknown) : file.outputJsonPreview;
  if (preview === undefined) throw new WidgetError('Add "sample": { … } (data like your tool returns) to see a preview.');
  return checkWidget(preview);
}

/** A starter widget (the dashboard's "Add widget"): a plan summary card, with sample data to preview. */
export function starterWidget(title: string): string {
  const template = [
    '{"type":"Card","size":"sm","children":[',
    '{"type":"Row","children":[{"type":"Title","value":{{ (plan) | tojson }},"size":"sm"},{"type":"Spacer"},',
    '{"type":"Badge","label":{{ (status) | tojson }},"color":{% if status == "active" %}"success"{% else %}"warning"{% endif %}}]},',
    '{"type":"Divider","flush":true},',
    '{"type":"Row","children":[{"type":"Caption","value":"Renews"},{"type":"Spacer"},{"type":"Text","value":{{ (renews_on) | tojson }},"size":"sm"}]},',
    '{"type":"Row","children":[{"type":"Caption","value":"Seats"},{"type":"Spacer"},{"type":"Text","value":{{ (seats_used ~ " of " ~ seats) | tojson }},"size":"sm"}]}',
    '{% if invoice_url is defined %},{"type":"Button","label":"View invoice","iconEnd":"external-link","onClickAction":{"type":"open_url","payload":{"url":{{ (invoice_url) | tojson }}}}}{% endif %}',
    "]}",
  ].join("");
  return `${JSON.stringify(
    {
      version: "1.0",
      name: title,
      template,
      // One line for the chat's folded pill (optional; plain text from the same data).
      summary: "{{ plan }} plan · {{ status }}",
      sample: { plan: "Pro", status: "active", renews_on: "Nov 3, 2026", seats: 10, seats_used: 7 },
    },
    null,
    2,
  )}
`;
}

/** A tool's result as the template's data: an object as is, a list as `items`, anything else as `value`. */
export function widgetData(result: unknown): Record<string, unknown> {
  if (isRecord(result)) return result;
  if (Array.isArray(result)) return { items: result };
  return { value: result };
}

/** Renders a widget with data and checks the tree. Throws WidgetError (template or tree problems). */
export function renderWidget(spec: Pick<WidgetSpec, "template">, data: unknown): WidgetNode {
  let text: string;
  try {
    text = spec.template.render(widgetData(data));
  } catch (error) {
    throw new WidgetError(error instanceof TemplateError ? `template: ${error.message}` : `template failed: ${(error as Error).message}`);
  }
  let tree: unknown;
  try {
    tree = JSON.parse(text);
  } catch {
    throw new WidgetError("The template didn't render valid JSON (a value without | tojson?).");
  }
  return checkWidget(tree);
}

/**
 * Checks a rendered tree: known components, a Card/ListView/Basic root, size limits. Drops null
 * props (the Studio writes `undefined` as null) and null children; cuts very long strings.
 */
export function checkWidget(tree: unknown): WidgetNode {
  if (JSON.stringify(tree)?.length > MAX_WIDGET_JSON) throw new WidgetError(`The widget is larger than ${MAX_WIDGET_JSON / 1024} KB.`);
  let nodes = 0;
  const clean = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined).map((v) => clean(v, depth));
    if (isRecord(value)) {
      if (depth > MAX_WIDGET_DEPTH) throw new WidgetError(`The widget is nested deeper than ${MAX_WIDGET_DEPTH} levels.`);
      return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, clean(v, depth + 1)]));
    }
    return value;
  };
  const node = (value: unknown, depth: number, path: string): WidgetNode => {
    if (!isRecord(value) || typeof value.type !== "string") throw new WidgetError(`${path}: every component needs a "type".`);
    if (!WIDGET_COMPONENTS.has(value.type)) throw new WidgetError(`${path}: unknown component "${value.type}".`);
    if (++nodes > MAX_WIDGET_NODES) throw new WidgetError(`The widget has more than ${MAX_WIDGET_NODES} components.`);
    if (depth > MAX_WIDGET_DEPTH) throw new WidgetError(`The widget is nested deeper than ${MAX_WIDGET_DEPTH} levels.`);
    const out: WidgetNode = { type: value.type };
    for (const [key, prop] of Object.entries(value)) {
      if (key === "type" || prop === null || prop === undefined) continue;
      if (key === "children") {
        const list = (Array.isArray(prop) ? prop : [prop]).filter((c) => c !== null && c !== undefined && c !== false);
        out.children = list.map((c, i) => node(c, depth + 1, `${path}.${value.type}[${i}]`));
      } else out[key] = clean(prop, depth + 1);
    }
    return out;
  };
  const root = node(tree, 0, "widget");
  if (!ROOTS.has(root.type)) throw new WidgetError(`The widget's root must be a Card, ListView or Basic (got ${root.type}).`);
  return root;
}

function* walk(node: WidgetNode): Generator<WidgetNode> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

function actionOf(value: unknown): WidgetActionConfig | null {
  return isRecord(value) && typeof value.type === "string" && value.type.trim() ? { type: value.type, ...(value.payload !== undefined ? { payload: value.payload } : {}) } : null;
}

/**
 * W-17: an id for every ListViewItem, in tree order (`i0`, `i1`, …). The server and the renderer
 * walk the same saved tree, so they agree on which row is which.
 */
export function itemIds(root: WidgetNode): Map<WidgetNode, string> {
  const ids = new Map<WidgetNode, string>();
  for (const node of walk(root)) if (node.type === "ListViewItem") ids.set(node, `i${ids.size}`);
  return ids;
}

/** One action a widget offers: the label the visitor sees on it, and the list item it's in (if any). */
export interface OfferedAction {
  action: WidgetActionConfig;
  label: string;
  item?: string;
}

/** Every action a widget offers. Actions inside a list item belong to that item (W-17); the rest to the card. */
export function widgetActions(root: WidgetNode): OfferedAction[] {
  const out: OfferedAction[] = [];
  const ids = itemIds(root);
  const visit = (node: WidgetNode, item: string | undefined) => {
    const here = ids.get(node) ?? item;
    const at = here ? { item: here } : {};
    const click = isClientAction(node.onClickAction) ? null : actionOf(node.onClickAction);
    if (click) out.push({ action: click, label: typeof node.label === "string" && node.label ? node.label : nodeText(node) || click.type, ...at });
    const submit = isClientAction(node.onSubmitAction) ? null : actionOf(node.onSubmitAction);
    if (submit) {
      const button = [...walk(node)].find((n) => n.type === "Button" && n.submit === true && typeof n.label === "string");
      out.push({ action: submit, label: (button?.label as string | undefined) ?? "Submit", ...at });
    }
    for (const key of ["confirm", "cancel"] as const) {
      const card = node[key];
      const action = isRecord(card) && !isClientAction(card.action) ? actionOf(card.action) : null;
      if (action) out.push({ action, label: isRecord(card) && typeof card.label === "string" ? card.label : key === "confirm" ? "Confirm" : "Cancel", ...at });
    }
    for (const child of node.children ?? []) visit(child, here);
  };
  visit(root, undefined);
  return out;
}

/** The names of the fields the visitor can fill in (sent with the action). */
export function widgetFields(root: WidgetNode): Set<string> {
  const names = new Set<string>();
  for (const node of walk(root)) {
    if (FIELDS.has(node.type) && typeof node.name === "string" && node.name) names.add(node.name);
    if ((node.type === "Text" || node.type === "Title") && isRecord(node.editable) && typeof node.editable.name === "string") names.add(node.editable.name);
  }
  return names;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Checks an action a visitor sent against the widget they saw: it must be one the widget offers
 * (same type and payload, in the list item they say), and only its own fields' values are kept.
 * Null when it isn't. `open_url` never comes here: the browser opens it.
 */
export function matchWidgetAction(
  root: WidgetNode,
  sent: unknown,
  values: unknown,
  item?: unknown,
): { label: string; action: WidgetActionConfig; values: Record<string, string | boolean>; item?: string } | null {
  const want = actionOf(sent);
  if (!want || want.type === OPEN_URL) return null;
  const same = widgetActions(root).filter((a) => a.action.type === want.type && sameJson(a.action.payload, want.payload));
  // The same action can sit in several rows ("Add" with the same payload): the row the visitor says, else the first.
  const hit = same.find((a) => (a.item ?? null) === (typeof item === "string" ? item : null)) ?? same[0];
  if (!hit) return null;
  return { label: hit.label.slice(0, 200), action: hit.action, values: matchValues(root, values), ...(hit.item ? { item: hit.item } : {}) };
}

/** The fields whose ChatKit `onChangeAction` can run on the server: only `tool:<name>` ones (D-51). */
const CHANGE_FIELDS = new Set(["Select", "Checkbox", "RadioGroup", "DatePicker"]);

/**
 * D-51: checks a field's `onChangeAction` a visitor's change sent. ChatKit sends it on every
 * change; here only a `tool:<name>` action does anything (the tool runs quietly and the card it
 * returns replaces this one), so only those match. `field` is the changed field's name; only the
 * card's own fields' values are kept, as for a press. Null when the card doesn't offer it.
 */
export function matchWidgetChange(
  root: WidgetNode,
  field: unknown,
  sent: unknown,
  values: unknown,
): { action: WidgetActionConfig; field: string; values: Record<string, string | boolean>; item?: string } | null {
  const want = actionOf(sent);
  if (!want || !TOOL_ACTION.test(want.type) || typeof field !== "string") return null;
  const ids = itemIds(root);
  let hit: { action: WidgetActionConfig; item?: string } | null = null;
  const visit = (node: WidgetNode, item: string | undefined) => {
    const here = ids.get(node) ?? item;
    if (!hit && CHANGE_FIELDS.has(node.type) && node.name === field && !isClientAction(node.onChangeAction)) {
      const action = actionOf(node.onChangeAction);
      if (action && action.type === want.type && sameJson(action.payload, want.payload)) hit = { action, ...(here ? { item: here } : {}) };
    }
    for (const child of node.children ?? []) visit(child, here);
  };
  visit(root, undefined);
  if (!hit) return null;
  const found = hit as { action: WidgetActionConfig; item?: string };
  const kept = matchValues(root, values);
  return { action: found.action, field, values: kept, ...(found.item ? { item: found.item } : {}) };
}

function matchValues(root: WidgetNode, values: unknown): Record<string, string | boolean> {
  const fields = widgetFields(root);
  const kept: Record<string, string | boolean> = {};
  if (isRecord(values)) {
    for (const [key, value] of Object.entries(values)) {
      if (!fields.has(key) || Object.keys(kept).length >= MAX_ACTION_VALUES) continue;
      if (typeof value === "boolean") kept[key] = value;
      else if (typeof value === "string" || typeof value === "number") kept[key] = String(value).slice(0, MAX_ACTION_VALUE);
    }
  }
  return kept;
}

/** Whether the action the visitor pressed is already used: the whole card, or (in a list) that row. */
export function widgetActionUsed(widget: MessageWidget, item: string | undefined): boolean {
  return Boolean(widget.used || (item && widget.items?.[item]));
}

/** The widget after a press: that row is used (W-17), or the whole card for its own actions. */
export function markWidgetUsed(widget: MessageWidget, label: string, item: string | undefined, at: number): MessageWidget {
  return item ? { ...widget, items: { ...widget.items, [item]: { label, at } } } : { ...widget, used: { label, at } };
}

/** W-17: a tool action's input: its payload's fields plus what was entered, only names the tool takes. */
export function toolActionInput(action: WidgetActionConfig, values: Record<string, string | boolean>, inputs: Record<string, { type: string }>): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...(isRecord(action.payload) ? action.payload : {}), ...values };
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(inputs)) {
    const v = raw[name];
    if (v === undefined || v === null || v === "") continue;
    if (spec.type === "number" || spec.type === "integer") {
      const n = Number(v);
      if (Number.isFinite(n)) out[name] = spec.type === "integer" ? Math.trunc(n) : n;
    } else if (spec.type === "boolean") out[name] = v === true || v === "true" || v === "on";
    else out[name] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

/** The visible words of a node and its children, in order (for previews and labels). */
export function nodeText(node: WidgetNode, max = 400): string {
  const parts: string[] = [];
  for (const n of walk(node)) {
    for (const key of ["value", "label"] as const) {
      const v = n[key];
      if ((typeof v === "string" || typeof v === "number") && String(v).trim() && n.type !== "Input" && n.type !== "Textarea") parts.push(String(v).trim());
    }
    if (parts.join(" ").length > max) break;
  }
  const text = parts.join(" · ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One line for a card folded into the island's pill, like a live activity ("Team plan · active").
 * Card: its first Title (else the first semibold/bold Text; else `status.text`), then the first
 * Caption when that title is a bare number or word (≤ 4 chars: "47° · San Francisco, CA"), then the
 * first Badge; with no Badge after a status-only lead, the first Text or Caption says what it's about.
 * ListView: `status.text` (or "N items" alone) and the item count ("Invoices · 3"). Empty parts are
 * skipped, whitespace collapsed, cut at `max` with "…"; "" when nothing is left.
 */
export function widgetSummary(root: WidgetNode, max = 60): string {
  const clean = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim() : "");
  const status = isRecord(root.status) ? clean(root.status.text) : "";
  const nodes = [...walk(root)].slice(1);
  const first = (match: (n: WidgetNode) => boolean, key: "value" | "label" = "value"): string => {
    for (const n of nodes) if (match(n) && clean(n[key])) return clean(n[key]);
    return "";
  };
  const parts: string[] = [];
  if (root.type === "ListView") {
    const count = (root.children ?? []).filter((c) => c.type === "ListViewItem").length;
    if (status) parts.push(status, String(count));
    else if (count) parts.push(`${count} ${count === 1 ? "item" : "items"}`);
  } else {
    const title = first((n) => n.type === "Title") || first((n) => n.type === "Text" && (n.weight === "semibold" || n.weight === "bold"));
    const badge = first((n) => n.type === "Badge", "label");
    if (title) {
      parts.push(title);
      if (title.length <= 4) parts.push(first((n) => n.type === "Caption"));
      parts.push(badge);
    } else {
      parts.push(status, badge);
      if (!badge) parts.push(first((n) => n.type === "Text" || n.type === "Caption"));
    }
  }
  const seen = new Set<string>();
  const line = parts.filter((p) => p && !seen.has(p) && seen.add(p)).join(" · ");
  return line.length > max ? `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…` : line;
}

/** The line the AI's history gets for an action the visitor took on a card. */
export function widgetActionLine(label: string, meta: WidgetActionMeta): string {
  const details = [`action ${meta.type}`];
  if (meta.payload !== undefined) details.push(`payload ${JSON.stringify(meta.payload)}`);
  if (meta.values && Object.keys(meta.values).length) details.push(`entered ${JSON.stringify(meta.values)}`);
  const line = `[On the ${meta.widget} card the customer pressed "${label}": ${details.join(", ")}]`;
  if (!meta.tool) return line;
  // W-17: the button ran a tool already; the AI only says what happened (and what's next).
  const output = meta.tool.output ?? "";
  const out = output.length > 1500 ? `${output.slice(0, 1500)}…` : output;
  return `${line}\n[That ran ${meta.tool.name}: ${meta.tool.status === "ok" ? "done" : "failed"}.${out ? ` Result: ${out}` : ""}]`;
}

/** The body of an AI message that only showed cards (the inbox preview; the widget hides it). */
export const WIDGET_ONLY_BODY = "Here's what I found:";
