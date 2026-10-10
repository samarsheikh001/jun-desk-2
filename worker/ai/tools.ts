import { jsonSchema, tool, type ToolSet } from "ai";
import type { AiStep } from "../../shared/protocol.ts";
import { renderWidget, type MessageWidget, type WidgetSpec } from "../../shared/widgets.ts";
import { DEFAULT_TOOL_STATUS, fillTemplate, type ToolSpec, type ToolUser } from "./config.ts";

// HTTP tools (AI-05): each tools/<name>.yaml becomes a tool the model can call.
// Every call is reported through onAction for the audit log (AI-11).

export const TOOL_TIMEOUT_MS = 10_000;
/** What the model sees of a response, at most. */
export const MAX_TOOL_OUTPUT = 4000;

export interface ToolAction {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  status: "ok" | "error";
  httpStatus: number | null;
  durationMs: number;
  /** W-09: the widget the result was shown as, or why it couldn't be. */
  widget?: { name: string; error?: string };
}

/** What the model reads after a result the customer sees as a card. */
export const WIDGET_SHOWN_NOTE = "(The customer already sees this result in the chat, laid out as a card. Don't repeat its details and don't mention the card; answer their question in a short sentence and add only what helps.)";

export interface ToolRunOptions {
  /** Worker env vars JUN_SECRET_<NAME>. */
  secrets: (name: string) => string | undefined;
  /** Use each tool's `mock:` response instead of calling it (evals). */
  mock?: boolean;
  fetch?: typeof fetch;
  onAction?: (action: ToolAction) => void;
  /**
   * What the visitor may see of each call: the tool's `status:` label, running then done (also
   * when it failed). Never its name, inputs, output or errors. Live chats only; evals leave it out.
   */
  onStep?: (step: AiStep) => void;
  /** The verified customer for {user.*}; null when they aren't signed in. */
  user?: ToolUser | null;
  /** W-09: the config's widgets, for tools with `widget:`. */
  widgets?: WidgetSpec[];
  /** W-09: a tool's result became a card for the customer (also on its step, for live chats). */
  onWidget?: (widget: MessageWidget) => void;
}

export function secretsFromEnv(env: object): (name: string) => string | undefined {
  const vars = env as Record<string, unknown>;
  return (name) => {
    const value = vars[`JUN_SECRET_${name}`];
    return typeof value === "string" ? value : undefined;
  };
}

function inputSchema(spec: ToolSpec) {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [name, input] of Object.entries(spec.input)) {
    properties[name] = {
      type: input.type,
      ...(input.description ? { description: input.description } : {}),
      ...(input.enum ? { enum: input.enum } : {}),
    };
  }
  const required = Object.entries(spec.input).filter(([, i]) => i.required).map(([n]) => n);
  return jsonSchema<Record<string, unknown>>({ type: "object", properties, required, additionalProperties: false });
}

function fillDeep(value: unknown, input: Record<string, unknown>, secrets: ToolRunOptions["secrets"], user: ToolUser | null): unknown {
  if (typeof value === "string") {
    // A value that is exactly "{param}" keeps the input's type (numbers stay numbers).
    const whole = /^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/.exec(value);
    if (whole?.[1] && whole[1] in input) return input[whole[1]];
    return fillTemplate(value, input, secrets, undefined, user);
  }
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, input, secrets, user));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, input, secrets, user)]));
  return value;
}

/** Builds the request for a call. Exported for tests. */
export function buildRequest(spec: ToolSpec, input: Record<string, unknown>, secrets: ToolRunOptions["secrets"], user: ToolUser | null = null): Request {
  const url = new URL(fillTemplate(spec.url, input, secrets, encodeURIComponent, user));
  for (const [key, template] of Object.entries(spec.query)) {
    const value = fillTemplate(template, input, secrets, undefined, user);
    if (value !== "") url.searchParams.set(key, value);
  }
  const headers = new Headers({ accept: "application/json", "user-agent": "JunDesk-Agent/1" });
  for (const [key, template] of Object.entries(spec.headers)) headers.set(key, fillTemplate(template, input, secrets, undefined, user));
  let body: string | undefined;
  if (spec.method === "POST") {
    body = JSON.stringify(spec.body === undefined ? input : fillDeep(spec.body, input, secrets, user));
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return new Request(url, { method: spec.method, headers, ...(body !== undefined ? { body } : {}) });
}

/** Shortens a response for the model: picked fields, then a hard length cap. Exported for tests. */
export function shapeOutput(text: string, pick?: string[]): string {
  let out = text;
  if (pick?.length) {
    try {
      const json = JSON.parse(text) as unknown;
      if (json && typeof json === "object" && !Array.isArray(json)) {
        out = JSON.stringify(Object.fromEntries(pick.filter((k) => k in json).map((k) => [k, (json as Record<string, unknown>)[k]])));
      }
    } catch {
      // not JSON: keep the text
    }
  }
  return out.length > MAX_TOOL_OUTPUT ? `${out.slice(0, MAX_TOOL_OUTPUT)}… (truncated)` : out;
}

/** A call's outcome, plus the whole response for a widget (the model gets the shortened `output`). */
type ToolCall = ToolAction & { raw?: string };

async function callTool(spec: ToolSpec, input: Record<string, unknown>, options: ToolRunOptions): Promise<ToolCall> {
  const started = Date.now();
  const action = (status: ToolAction["status"], output: string, httpStatus: number | null, raw?: string): ToolCall => ({
    tool: spec.name,
    input,
    output,
    status,
    httpStatus,
    durationMs: Date.now() - started,
    ...(raw !== undefined ? { raw } : {}),
  });
  if (options.mock) {
    if (spec.mock === undefined) return action("error", "No mock response defined for this tool.", null);
    const mock = typeof spec.mock === "string" ? spec.mock : JSON.stringify(spec.mock);
    return action("ok", shapeOutput(mock, spec.pick), null, mock);
  }
  let request: Request;
  try {
    request = buildRequest(spec, input, options.secrets, options.user ?? null);
  } catch (error) {
    return action("error", (error as Error).message, null);
  }
  try {
    const response = await (options.fetch ?? fetch)(request, { signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
    const text = await response.text();
    const output = shapeOutput(text || `(empty response, HTTP ${response.status})`, response.ok ? spec.pick : undefined);
    return action(response.ok ? "ok" : "error", output, response.status, response.ok ? text : undefined);
  } catch (error) {
    const timedOut = (error as Error).name === "TimeoutError";
    return action("error", timedOut ? `No response within ${TOOL_TIMEOUT_MS / 1000} s.` : `Request failed: ${(error as Error).message}`, null);
  }
}

/**
 * W-09: a successful result as the tool's widget. The whole JSON response fills the template (the
 * model gets the `pick`ed, shortened output); a result that doesn't fit the widget is shown as text
 * only, and the audit log says why.
 */
function showWidget(spec: ToolSpec, call: ToolCall, options: ToolRunOptions, id: string): MessageWidget | null {
  if (!spec.widget || call.status !== "ok" || call.raw === undefined) return null;
  const widget = options.widgets?.find((w) => w.name === spec.widget);
  try {
    if (!widget) throw new Error(`no widgets/${spec.widget}.widget`);
    let data: unknown;
    try {
      data = JSON.parse(call.raw);
    } catch {
      throw new Error("the response isn't JSON");
    }
    const root = renderWidget(widget, data);
    call.widget = { name: widget.name };
    return { id: `w${id.slice(1)}`, name: widget.name, root };
  } catch (error) {
    call.widget = { name: spec.widget, error: (error as Error).message };
    console.warn(`[ai] widget ${spec.widget} for ${spec.name}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * W-17: runs a tool for a card's `tool:<name>` button, outside the model's loop (the press is the
 * visitor's confirmation). Same request, secrets, identity, audit and widget as a model call.
 */
export async function runTool(spec: ToolSpec, input: Record<string, unknown>, options: ToolRunOptions, widgetId: string): Promise<{ action: ToolAction; widget: MessageWidget | null }> {
  const missing = Object.entries(spec.input).filter(([name, i]) => i.required && input[name] === undefined).map(([name]) => name);
  if (missing.length) {
    return { action: { tool: spec.name, input, output: `Missing input: ${missing.join(", ")}.`, status: "error", httpStatus: null, durationMs: 0 }, widget: null };
  }
  const call = await callTool(spec, input, options);
  const widget = showWidget(spec, call, options, widgetId);
  const { raw: _raw, ...action } = call;
  return { action, widget: widget ? { ...widget, id: widgetId } : null };
}

/** AI SDK tools for a config's HTTP tools. Failed calls return an error the model can explain. */
export function httpTools(specs: ToolSpec[], options: ToolRunOptions): ToolSet {
  const tools: ToolSet = {};
  let calls = 0;
  for (const spec of specs) {
    const label = spec.status ?? DEFAULT_TOOL_STATUS;
    tools[spec.name] = tool({
      description: spec.description,
      inputSchema: inputSchema(spec),
      execute: async (input: Record<string, unknown>) => {
        // An opaque id per call: the model's toolCallId or the tool name would tell the visitor more.
        const id = `s${++calls}`;
        options.onStep?.({ id, label, state: "running" });
        let call: ToolCall | undefined;
        let widget: MessageWidget | null = null;
        try {
          call = await callTool(spec, input, options);
          widget = showWidget(spec, call, options, id);
        } finally {
          // The card travels with the finished step, so it shows as soon as the call is done.
          options.onStep?.({ id, label, state: "done", ...(widget ? { widget } : {}) });
        }
        if (widget) options.onWidget?.(widget);
        const { raw: _raw, ...action } = call;
        options.onAction?.(action);
        if (action.status !== "ok") return `ERROR${action.httpStatus ? ` (HTTP ${action.httpStatus})` : ""}: ${action.output}`;
        return widget ? `${action.output}\n\n${WIDGET_SHOWN_NOTE}` : action.output;
      },
    });
  }
  return tools;
}
