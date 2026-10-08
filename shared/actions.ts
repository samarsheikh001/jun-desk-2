// AI-21 page actions over WebMCP (D-40). Pure functions shared by the Worker (sanitising the
// list the loader sends, offering the actions to the model, checking its inputs), the widget
// (param UI, confirm, Done) and the eval runner.
//
// A page action is a WebMCP tool ({ name, description, inputSchema, annotations }) the host
// page registered, plus Jun's extras. The functions (`execute`, `undo`) never leave the page:
// the loader sends only descriptions, the model picks one, the page runs it.

export type ActionRisk = "auto" | "confirm" | "human";
export type ParamType = "string" | "number" | "integer" | "boolean";

export interface ActionParam {
  type: ParamType;
  description?: string;
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
  /** JSON Schema `format` the widget may render specially (email, date, url). */
  format?: string;
}

/** One action as the Worker keeps it for a turn and offers it to the model. */
export interface PageAction {
  /** The loader's id (name, or name#key for one instance of several). */
  id: string;
  /** The WebMCP tool name as registered. */
  name: string;
  /** The tool name the model sees: pa_<name>, suffixed when several instances share a name. */
  tool: string;
  description: string;
  params: Record<string, ActionParam>;
  required: string[];
  risk: ActionRisk;
  /** Small facts for the model (price, plan…), from the host's code. */
  context: Record<string, string | number | boolean>;
  /** The loader saw the action's element in the viewport when the message was sent. */
  visible: boolean;
}

export type ActionStatus = "pending" | "ok" | "error" | "cancelled" | "gone" | "undone";
export const ACTION_RESULT_STATUSES: ActionStatus[] = ["ok", "error", "cancelled", "gone", "undone"];

/** The action an AI message proposed (`meta.action`); the widget runs it and reports back. */
export interface MessageAction {
  runId: string;
  id: string;
  name: string;
  description: string;
  risk: "auto" | "confirm";
  params: Record<string, ActionParam>;
  required: string[];
  input: Record<string, unknown>;
  /** Required params the model didn't fill: the widget asks for them first. */
  missing: string[];
  status: ActionStatus;
  /** What the page returned (Done line), or the error. */
  result: string | null;
  canUndo: boolean;
  /** The AI already had its follow-up turn after this action's result (one per run). */
  continued?: boolean;
}

/** AI messages in a row after the visitor's last message (a chain of actions), at most. */
export const MAX_ACTION_CHAIN = 8;

/** A lookup's result (JSON) is for the AI; the card shows only plain text. */
export function visibleResult(result: string | null): string | null {
  if (!result) return null;
  const t = result.trim();
  return /^[[{]/.test(t) ? null : t;
}

/** Offered to the model per reply (after `rankActions`). */
export const MAX_PAGE_ACTIONS = 30;
/** Accepted from the loader per message, before the question is known. */
export const MAX_PAGE_ACTIONS_INTAKE = 60;
export const MAX_ACTION_DESCRIPTION = 200;
export const MAX_ACTION_PARAMS = 12;
/** Lookups return JSON for the AI's next turn; keep enough of it to be useful. */
export const MAX_ACTION_RESULT = 2000;
const MAX_ENUM = 24;
const MAX_CONTEXT_ENTRIES = 8;
const MAX_CONTEXT_VALUE = 80;
const MAX_PARAM_DESCRIPTION = 120;
const MAX_STRING_INPUT = 500;
const PARAM_TYPES: ParamType[] = ["string", "number", "integer", "boolean"];
const RISKS: ActionRisk[] = ["auto", "confirm", "human"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One line of plain text: control characters out, whitespace collapsed, capped. */
function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function paramFrom(raw: unknown): ActionParam | null {
  if (!isRecord(raw)) return null;
  let type = raw.type;
  const values = Array.isArray(raw.enum) ? raw.enum.filter((v): v is string | number => (typeof v === "string" && v.length <= MAX_CONTEXT_VALUE) || (typeof v === "number" && Number.isFinite(v))).slice(0, MAX_ENUM) : [];
  if (Array.isArray(type)) type = type.find((t) => t !== "null");
  if (type === undefined && values.length) type = values.every((v) => typeof v === "number") ? "number" : "string";
  if (!PARAM_TYPES.includes(type as ParamType)) return null;
  const param: ActionParam = { type: type as ParamType };
  const description = clean(raw.description, MAX_PARAM_DESCRIPTION);
  if (description) param.description = description;
  if (values.length) param.enum = values;
  if (typeof raw.minimum === "number" && Number.isFinite(raw.minimum)) param.minimum = raw.minimum;
  if (typeof raw.maximum === "number" && Number.isFinite(raw.maximum)) param.maximum = raw.maximum;
  const format = clean(raw.format, 20);
  if (format && /^[a-z-]+$/.test(format)) param.format = format;
  return param;
}

function riskFrom(raw: Record<string, unknown>): ActionRisk {
  if (RISKS.includes(raw.risk as ActionRisk)) return raw.risk as ActionRisk;
  const annotations = isRecord(raw.annotations) ? raw.annotations : {};
  // WebMCP: consequentialHint asks for confirmation; a read-only tool may run at once. Default: confirm.
  if (annotations.consequentialHint === true) return "confirm";
  if (annotations.readOnlyHint === true) return "auto";
  return "confirm";
}

/** The model's tool name for a page action: pa_ + a safe slug of the registered name. */
export function toolSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return `pa_${slug || "action"}`;
}

/**
 * The list the loader sent, made safe for the model and the widget: known fields only, one-line
 * text, capped sizes and count, unique ids (a later duplicate replaces the earlier one) and
 * unique tool names. Anything that isn't a list of actions gives [].
 */
export function sanitizeActions(raw: unknown): PageAction[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, Omit<PageAction, "tool">>();
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item)) continue;
    const name = clean(item.name, 64);
    const description = clean(item.description, MAX_ACTION_DESCRIPTION);
    if (!name || !description) continue;
    const rawId = clean(item.id, 120);
    const id = /^[\w.:#@/-]+$/.test(rawId) ? rawId : `${name}#${index}`;

    const params: Record<string, ActionParam> = {};
    const schema = isRecord(item.inputSchema) ? item.inputSchema : {};
    if (isRecord(schema.properties)) {
      for (const [key, value] of Object.entries(schema.properties)) {
        if (Object.keys(params).length >= MAX_ACTION_PARAMS) break;
        if (!/^[A-Za-z_][\w-]{0,39}$/.test(key)) continue;
        const param = paramFrom(value);
        if (param) params[key] = param;
      }
    }
    const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string" && k in params) : [];

    const context: PageAction["context"] = {};
    if (isRecord(item.context)) {
      for (const [key, value] of Object.entries(item.context)) {
        if (Object.keys(context).length >= MAX_CONTEXT_ENTRIES) break;
        const k = clean(key, 40);
        if (!k) continue;
        if (typeof value === "string") {
          const v = clean(value, MAX_CONTEXT_VALUE);
          if (v) context[k] = v;
        } else if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") context[k] = value;
      }
    }
    byId.delete(id);
    byId.set(id, { id, name, description, params, required, risk: riskFrom(item), context, visible: item.visible === true });
  }

  const taken = new Set<string>();
  const out: PageAction[] = [];
  for (const action of byId.values()) {
    if (out.length >= MAX_PAGE_ACTIONS_INTAKE) break;
    const base = toolSlug(action.name);
    let tool = base;
    for (let n = 2; taken.has(tool); n++) tool = `${base}_${n}`;
    taken.add(tool);
    out.push({ ...action, tool });
  }
  return out;
}

/** Words of 3+ letters or digits, lowercased, deduped. */
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

/**
 * The actions worth offering for this question, best first, at most MAX_PAGE_ACTIONS: every word the
 * question shares with an action's name, description or context counts double, being on screen
 * counts once, and registration order breaks ties (so the loader's order holds when nothing matches).
 */
export function rankActions(actions: PageAction[], question: string): PageAction[] {
  const asked = words(question);
  const score = (a: PageAction): number => {
    let n = a.visible ? 1 : 0;
    const own = words(`${a.name} ${a.description} ${Object.entries(a.context).map(([k, v]) => `${k} ${String(v)}`).join(" ")}`);
    for (const w of own) if (asked.has(w)) n += 2;
    return n;
  };
  return actions
    .map((a, i) => ({ a, i, s: score(a) }))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .slice(0, MAX_PAGE_ACTIONS)
    .map((x) => x.a);
}

/**
 * Page patterns, as the loader and `tools/*.yaml` use them: an exact path, or a prefix ending in
 * `*` ("/plans/*" matches "/plans/pro" and "/plans/"). No patterns means everywhere. Keep in step
 * with `matches` in public/widget-actions.js.
 */
export function matchesPage(patterns: string[] | undefined, path: string | null | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  if (!path) return false;
  return patterns.some((p) => (p.endsWith("*") ? path.startsWith(p.slice(0, -1)) : path === p));
}

/**
 * The JSON Schema the model gets. Every param is optional for the model: it fills what the
 * customer said and leaves the rest out, and the widget asks for what's still required
 * (`checkInput`), so the model never has to guess a size or a date.
 */
export function actionInputSchema(action: PageAction): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [key, p] of Object.entries(action.params)) {
    const note = action.required.includes(key) ? " (required; leave out if the customer didn't say)" : "";
    properties[key] = {
      type: p.type,
      ...(p.description || note ? { description: `${p.description ?? ""}${note}`.trim() } : {}),
      ...(p.enum ? { enum: p.enum } : {}),
      ...(p.minimum !== undefined ? { minimum: p.minimum } : {}),
      ...(p.maximum !== undefined ? { maximum: p.maximum } : {}),
    };
  }
  return { type: "object", properties, required: [], additionalProperties: false };
}

/** How the model is told about the actions on the customer's page (one line each). */
export function describePageAction(action: PageAction): string {
  const context = Object.entries(action.context).map(([k, v]) => `${k}: ${String(v)}`);
  const params = Object.keys(action.params);
  return `${action.tool}: ${action.description}${context.length ? ` (${context.join(", ")})` : ""}${params.length ? ` [inputs: ${params.join(", ")}]` : ""}`;
}

export interface InputCheck {
  /** Known params with valid values, coerced to their types. */
  input: Record<string, unknown>;
  /** Required params that are absent or invalid. */
  missing: string[];
  /** Why a given value was dropped, per param. */
  errors: Record<string, string>;
}

function coerce(param: ActionParam, raw: unknown): { value?: unknown; error?: string } {
  if (raw === null || raw === undefined || raw === "") return {};
  switch (param.type) {
    case "boolean": {
      if (typeof raw === "boolean") return { value: raw };
      if (raw === "true" || raw === "false") return { value: raw === "true" };
      return { error: "must be yes or no" };
    }
    case "number":
    case "integer": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return { error: "must be a number" };
      if (param.type === "integer" && !Number.isInteger(n)) return { error: "must be a whole number" };
      if (param.minimum !== undefined && n < param.minimum) return { error: `must be at least ${param.minimum}` };
      if (param.maximum !== undefined && n > param.maximum) return { error: `must be at most ${param.maximum}` };
      if (param.enum && !param.enum.includes(n)) return { error: `must be one of ${param.enum.join(", ")}` };
      return { value: n };
    }
    default: {
      const s = typeof raw === "string" ? raw.trim() : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "";
      if (!s) return { error: "must be text" };
      if (param.enum) {
        const match = param.enum.find((v) => String(v).toLowerCase() === s.toLowerCase());
        return match === undefined ? { error: `must be one of ${param.enum.join(", ")}` } : { value: match };
      }
      return { value: s.slice(0, MAX_STRING_INPUT) };
    }
  }
}

/** Checks inputs (the model's, or the customer's answers) against the action's params. */
export function checkInput(action: Pick<PageAction, "params" | "required">, raw: unknown): InputCheck {
  const input: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const given = isRecord(raw) ? raw : {};
  for (const [key, param] of Object.entries(action.params)) {
    const { value, error } = coerce(param, given[key]);
    if (error) errors[key] = error;
    else if (value !== undefined) input[key] = value;
  }
  const missing = action.required.filter((k) => !(k in input));
  return { input, missing, errors };
}

/** One line for the confirm step and the inbox: the action and the inputs it will run with. */
export function actionSummary(action: Pick<MessageAction, "description" | "input">): string {
  const inputs = Object.entries(action.input).map(([k, v]) => `${k}: ${String(v)}`);
  return inputs.length ? `${action.description} · ${inputs.join(" · ")}` : action.description;
}

/** What the model sees of a past action in the conversation history (appended to its own message). */
export function describeActionForModel(action: MessageAction): string {
  const input = Object.keys(action.input).length ? ` with ${JSON.stringify(action.input)}` : "";
  switch (action.status) {
    case "pending":
      return `[You proposed the page action "${action.name}"${input}; the customer hasn't confirmed it yet.]`;
    case "ok":
      return `[The page action "${action.name}"${input} ran${action.result ? `: ${action.result}` : ""}.]`;
    case "error":
      return `[The page action "${action.name}"${input} failed${action.result ? `: ${action.result}` : ""}.]`;
    case "cancelled":
      return `[The customer cancelled the page action "${action.name}".]`;
    case "gone":
      return `[The page action "${action.name}" was no longer available (the customer left the page), so it didn't run.]`;
    case "undone":
      return `[The customer undid the page action "${action.name}".]`;
  }
}

/** The status word the widget and the inbox show under an action. */
export function actionStatusText(status: ActionStatus): string {
  switch (status) {
    case "pending":
      return "Waiting for you";
    case "ok":
      return "Done";
    case "error":
      return "Didn't work";
    case "cancelled":
      return "Cancelled";
    case "gone":
      return "No longer on this page";
    case "undone":
      return "Undone";
  }
}
