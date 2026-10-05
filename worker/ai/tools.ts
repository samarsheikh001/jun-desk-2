import { jsonSchema, tool, type ToolSet } from "ai";
import { fillTemplate, type ToolSpec, type ToolUser } from "./config.ts";

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
}

export interface ToolRunOptions {
  /** Worker env vars JUN_SECRET_<NAME>. */
  secrets: (name: string) => string | undefined;
  /** Use each tool's `mock:` response instead of calling it (evals). */
  mock?: boolean;
  fetch?: typeof fetch;
  onAction?: (action: ToolAction) => void;
  /** The verified customer for {user.*}; null when they aren't signed in. */
  user?: ToolUser | null;
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

async function callTool(spec: ToolSpec, input: Record<string, unknown>, options: ToolRunOptions): Promise<ToolAction> {
  const started = Date.now();
  const action = (status: ToolAction["status"], output: string, httpStatus: number | null): ToolAction => ({
    tool: spec.name,
    input,
    output,
    status,
    httpStatus,
    durationMs: Date.now() - started,
  });
  if (options.mock) {
    if (spec.mock === undefined) return action("error", "No mock response defined for this tool.", null);
    return action("ok", shapeOutput(typeof spec.mock === "string" ? spec.mock : JSON.stringify(spec.mock), spec.pick), null);
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
    return action(response.ok ? "ok" : "error", output, response.status);
  } catch (error) {
    const timedOut = (error as Error).name === "TimeoutError";
    return action("error", timedOut ? `No response within ${TOOL_TIMEOUT_MS / 1000} s.` : `Request failed: ${(error as Error).message}`, null);
  }
}

/** AI SDK tools for a config's HTTP tools. Failed calls return an error the model can explain. */
export function httpTools(specs: ToolSpec[], options: ToolRunOptions): ToolSet {
  const tools: ToolSet = {};
  for (const spec of specs) {
    tools[spec.name] = tool({
      description: spec.description,
      inputSchema: inputSchema(spec),
      execute: async (input: Record<string, unknown>) => {
        const action = await callTool(spec, input, options);
        options.onAction?.(action);
        return action.status === "ok"
          ? action.output
          : `ERROR${action.httpStatus ? ` (HTTP ${action.httpStatus})` : ""}: ${action.output}`;
      },
    });
  }
  return tools;
}
