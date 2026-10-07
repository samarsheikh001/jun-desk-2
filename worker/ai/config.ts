import { parse as parseYaml } from "yaml";

// Support agent as code (AI-18). A config is a set of text files, the same in git and in the desk:
//   AGENTS.md                 persona, tone, rules; optional frontmatter guardrails
//   skills/<name>/SKILL.md    procedures (Agent Skills format: name + description frontmatter)
//   tools/<name>.yaml         HTTP lookups the AI may call (AI-05)
//   evals/<name>.yaml         test cases for `jun eval` (AI-19)
// Parsing is pure so the Worker, tests and the eval runner share it.

export const MAX_CONFIG_FILES = 200;
export const MAX_CONFIG_BYTES = 256 * 1024;
export const DEFAULT_MAX_REPLIES = 8;

export interface Skill {
  name: string;
  description: string;
  instructions: string;
}

export interface ToolInput {
  type: "string" | "number" | "integer" | "boolean";
  description?: string;
  required: boolean;
  enum?: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
  input: Record<string, ToolInput>;
  /** Keep only these top-level fields of a JSON response (less noise for the model). */
  pick?: string[];
  /** Canned response used instead of the real call by `jun eval --mock-tools`. */
  mock?: unknown;
  /** What the visitor sees while the AI uses this tool ("Checking your order"); never the tool's name or data. */
  status?: string;
}

export type EvalOutcome = "answer" | "handoff" | "escalate";

export interface EvalCase {
  file: string;
  name: string;
  messages: string[];
  expect: { outcome?: EvalOutcome; tools?: string[]; criteria?: string };
}

export interface AgentConfig {
  /** Saved version, or null for the built-in default. */
  version: number | null;
  /** AGENTS.md without frontmatter. */
  persona: string;
  maxReplies: number;
  /** Topics the AI must always hand to a person. */
  handoffTopics: string[];
  skills: Skill[];
  tools: ToolSpec[];
  evals: EvalCase[];
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export type ConfigFiles = Record<string, string>;

export const DEFAULT_AGENTS_MD = `---
# Guardrails. Remove a line to use the default.
maxReplies: 8            # AI replies per conversation before a person takes over
handoffTopics:           # always hand these to a person
  - legal or security questions
---
# How to talk to customers

- Be friendly, concise and specific. A few short sentences or a short list.
- Use the customer's name if you know it.
- Don't promise refunds, credits, discounts or timelines unless a procedure says you can.
`;

/** The config a workspace starts with: the old Settings guidance (if any) becomes AGENTS.md. */
export function defaultFiles(instructions = ""): ConfigFiles {
  const extra = instructions.trim() ? `\n# Guidance from the team\n\n${instructions.trim()}\n` : "";
  return { "AGENTS.md": DEFAULT_AGENTS_MD + extra };
}

const SKILL_PATH = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/;
const TOOL_PATH = /^tools\/([a-z][a-z0-9_]*)\.ya?ml$/;
const EVAL_PATH = /^evals\/([a-zA-Z0-9_-]+)\.ya?ml$/;
const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g;

export function isConfigPath(path: string): boolean {
  return path === "AGENTS.md" || path === "README.md" || SKILL_PATH.test(path) || TOOL_PATH.test(path) || EVAL_PATH.test(path);
}

/** Splits `---\nyaml\n---\nbody`. Returns null frontmatter when there is none. */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { frontmatter: null, body: normalized };
  return { frontmatter: match[1]!, body: normalized.slice(match[0].length) };
}

function yaml(path: string, source: string, issues: ConfigIssue[]): unknown {
  try {
    return parseYaml(source, { prettyErrors: true }) ?? {};
  } catch (error) {
    issues.push({ path, message: `Invalid YAML: ${(error as Error).message.split("\n")[0]}` });
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(path: string, value: Record<string, unknown>, allowed: string[], issues: ConfigIssue[], where = ""): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push({ path, message: `Unknown key "${where}${key}". Allowed: ${allowed.join(", ")}.` });
  }
}

function stringMap(path: string, value: unknown, field: string, issues: ConfigIssue[]): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    issues.push({ path, message: `"${field}" must be a map of names to values.` });
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else issues.push({ path, message: `"${field}.${k}" must be a string.` });
  }
  return out;
}

function parseAgentsMd(text: string, issues: ConfigIssue[]): Pick<AgentConfig, "persona" | "maxReplies" | "handoffTopics"> {
  const { frontmatter, body } = splitFrontmatter(text);
  const out = { persona: body.trim(), maxReplies: DEFAULT_MAX_REPLIES, handoffTopics: [] as string[] };
  if (frontmatter === null) return out;
  const data = yaml("AGENTS.md", frontmatter, issues);
  if (data === undefined) return out;
  if (!isRecord(data)) {
    issues.push({ path: "AGENTS.md", message: "Frontmatter must be a YAML map." });
    return out;
  }
  unknownKeys("AGENTS.md", data, ["maxReplies", "handoffTopics"], issues);
  if (data.maxReplies !== undefined) {
    const n = data.maxReplies;
    if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 50) out.maxReplies = n;
    else issues.push({ path: "AGENTS.md", message: "maxReplies must be a whole number from 1 to 50." });
  }
  if (data.handoffTopics !== undefined) {
    if (Array.isArray(data.handoffTopics) && data.handoffTopics.every((t) => typeof t === "string" && t.trim())) {
      out.handoffTopics = (data.handoffTopics as string[]).map((t) => t.trim()).slice(0, 30);
    } else {
      issues.push({ path: "AGENTS.md", message: "handoffTopics must be a list of short descriptions." });
    }
  }
  return out;
}

function parseSkill(path: string, folder: string, text: string, issues: ConfigIssue[]): Skill | null {
  const { frontmatter, body } = splitFrontmatter(text);
  if (frontmatter === null) {
    issues.push({ path, message: "SKILL.md needs frontmatter with name and description (---\\nname: …\\ndescription: …\\n---)." });
    return null;
  }
  const data = yaml(path, frontmatter, issues);
  if (!isRecord(data)) {
    if (data !== undefined) issues.push({ path, message: "Frontmatter must be a YAML map." });
    return null;
  }
  // Agent Skills fields we don't use (license, metadata, …) are allowed and ignored.
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (name !== folder) issues.push({ path, message: `name must match the folder name ("${folder}").` });
  if (!description) issues.push({ path, message: "description is required: say when this procedure applies." });
  else if (description.length > 1024) issues.push({ path, message: "description must be at most 1024 characters." });
  if (!body.trim()) issues.push({ path, message: "The procedure itself (below the frontmatter) is empty." });
  if (name !== folder || !description || description.length > 1024 || !body.trim()) return null;
  return { name, description, instructions: body.trim() };
}

const INPUT_TYPES = ["string", "number", "integer", "boolean"] as const;
/** The visitor's label for a tool call without its own `status:`. */
export const DEFAULT_TOOL_STATUS = "Looking that up";
export const MAX_TOOL_STATUS = 60;

function parseTool(path: string, name: string, text: string, issues: ConfigIssue[]): ToolSpec | null {
  const data = yaml(path, text, issues);
  if (data === undefined) return null;
  if (!isRecord(data)) {
    issues.push({ path, message: "A tool file must be a YAML map." });
    return null;
  }
  const before = issues.length;
  unknownKeys(path, data, ["description", "method", "url", "headers", "query", "body", "input", "pick", "mock", "status"], issues);

  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!description) issues.push({ path, message: "description is required: tell the AI what this returns and when to use it." });

  const method = String(data.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") issues.push({ path, message: "method must be GET or POST." });

  const url = typeof data.url === "string" ? data.url.trim() : "";
  if (!/^https?:\/\//.test(url)) issues.push({ path, message: "url must start with https:// (or http://)." });

  const input: Record<string, ToolInput> = {};
  if (data.input !== undefined && !isRecord(data.input)) issues.push({ path, message: "input must be a map of parameter names." });
  for (const [key, raw] of Object.entries(isRecord(data.input) ? data.input : {})) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      issues.push({ path, message: `Input name "${key}" must be letters, digits and underscores.` });
      continue;
    }
    const spec = isRecord(raw) ? raw : { type: raw };
    unknownKeys(path, spec, ["type", "description", "required", "enum"], issues, `input.${key}.`);
    const type = String(spec.type ?? "string");
    if (!(INPUT_TYPES as readonly string[]).includes(type)) {
      issues.push({ path, message: `input.${key}.type must be one of ${INPUT_TYPES.join(", ")}.` });
      continue;
    }
    if (spec.enum !== undefined && !(Array.isArray(spec.enum) && spec.enum.every((v) => typeof v === "string"))) {
      issues.push({ path, message: `input.${key}.enum must be a list of strings.` });
    }
    input[key] = {
      type: type as ToolInput["type"],
      required: spec.required !== false,
      ...(typeof spec.description === "string" ? { description: spec.description } : {}),
      ...(Array.isArray(spec.enum) ? { enum: spec.enum.map(String) } : {}),
    };
  }

  const headers = stringMap(path, data.headers, "headers", issues);
  const query = stringMap(path, data.query, "query", issues);
  if (data.body !== undefined && method !== "POST") issues.push({ path, message: "body is only sent with method: POST." });
  let pick: string[] | undefined;
  if (data.pick !== undefined) {
    if (Array.isArray(data.pick) && data.pick.every((p) => typeof p === "string")) pick = data.pick as string[];
    else issues.push({ path, message: "pick must be a list of field names." });
  }

  // Shown to visitors as is, so plain text only: no placeholders, no line breaks.
  let status: string | undefined;
  if (data.status !== undefined) {
    const value = typeof data.status === "string" ? data.status.trim() : "";
    if (!value) issues.push({ path, message: 'status must be a short text for the customer, like "Checking your order".' });
    else if (/[^\S ]/.test(value)) issues.push({ path, message: "status must be one line of plain text." });
    else if (value.length > MAX_TOOL_STATUS) issues.push({ path, message: `status must be at most ${MAX_TOOL_STATUS} characters.` });
    else if (/[{}]/.test(value)) issues.push({ path, message: "status is shown as is: no {placeholders}." });
    else status = value;
  }

  // Every {placeholder} must be an input or a secret.
  const templated = [url, ...Object.values(headers), ...Object.values(query), JSON.stringify(data.body ?? null)];
  for (const source of templated) {
    for (const [, ref] of source.matchAll(PLACEHOLDER)) {
      if (ref!.startsWith("secrets.")) {
        if (!/^secrets\.[A-Z][A-Z0-9_]*$/.test(ref!)) issues.push({ path, message: `{${ref}}: secret names are UPPER_SNAKE_CASE.` });
      } else if (ref!.startsWith("user.")) {
        // The signed-in customer, verified by the host app's identity token (V-03).
        if (!/^user\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(ref!)) issues.push({ path, message: `{${ref}}: use {user.id}, {user.email}, {user.name} or {user.<attribute>}.` });
      } else if (!input[ref!]) {
        issues.push({ path, message: `{${ref}} isn't an input. Add it under input:, {user.id} (signed-in customer), or {secrets.NAME}.` });
      }
    }
  }
  for (const source of [url, ...Object.values(query)]) {
    if (/\{secrets\./.test(source)) issues.push({ path, message: "Put secrets in headers, not the URL or query (URLs end up in logs)." });
  }

  if (issues.length > before) return null;
  return {
    name,
    description,
    method: method as ToolSpec["method"],
    url,
    headers,
    query,
    ...(data.body !== undefined ? { body: data.body } : {}),
    input,
    ...(pick ? { pick } : {}),
    ...(data.mock !== undefined ? { mock: data.mock } : {}),
    ...(status ? { status } : {}),
  };
}

const OUTCOMES: EvalOutcome[] = ["answer", "handoff", "escalate"];

function parseEvals(path: string, text: string, issues: ConfigIssue[]): EvalCase[] {
  const data = yaml(path, text, issues);
  if (data === undefined) return [];
  if (!Array.isArray(data)) {
    issues.push({ path, message: "An eval file is a YAML list of cases (- name: …)." });
    return [];
  }
  const cases: EvalCase[] = [];
  data.forEach((raw, i) => {
    const where = `case ${i + 1}`;
    if (!isRecord(raw)) {
      issues.push({ path, message: `${where}: must be a map with name, message(s) and expect.` });
      return;
    }
    unknownKeys(path, raw, ["name", "message", "messages", "expect"], issues, `${where}: `);
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : where;
    const messages =
      typeof raw.message === "string" ? [raw.message]
      : Array.isArray(raw.messages) && raw.messages.every((m) => typeof m === "string") ? (raw.messages as string[])
      : [];
    if (!messages.length || messages.some((m) => !m.trim())) {
      issues.push({ path, message: `${name}: give the customer's message (message: "…") or messages (a list).` });
      return;
    }
    const expect: EvalCase["expect"] = {};
    if (raw.expect !== undefined) {
      if (!isRecord(raw.expect)) {
        issues.push({ path, message: `${name}: expect must be a map.` });
        return;
      }
      unknownKeys(path, raw.expect, ["outcome", "tools", "criteria"], issues, `${name}: expect.`);
      if (raw.expect.outcome !== undefined) {
        if (OUTCOMES.includes(raw.expect.outcome as EvalOutcome)) expect.outcome = raw.expect.outcome as EvalOutcome;
        else issues.push({ path, message: `${name}: expect.outcome must be one of ${OUTCOMES.join(", ")}.` });
      }
      if (raw.expect.tools !== undefined) {
        if (Array.isArray(raw.expect.tools) && raw.expect.tools.every((t) => typeof t === "string")) expect.tools = raw.expect.tools as string[];
        else issues.push({ path, message: `${name}: expect.tools must be a list of tool names.` });
      }
      if (raw.expect.criteria !== undefined) {
        if (typeof raw.expect.criteria === "string" && raw.expect.criteria.trim()) expect.criteria = raw.expect.criteria.trim();
        else issues.push({ path, message: `${name}: expect.criteria must be a sentence describing a good reply.` });
      }
    }
    cases.push({ file: path, name, messages, expect });
  });
  return cases;
}

/** Parses and validates a config. Invalid files are reported and left out; it never throws. */
export function parseConfig(files: ConfigFiles, version: number | null = null): { config: AgentConfig; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const paths = Object.keys(files).sort();
  if (paths.length > MAX_CONFIG_FILES) issues.push({ path: "", message: `At most ${MAX_CONFIG_FILES} files.` });
  const bytes = paths.reduce((n, p) => n + new TextEncoder().encode(files[p]!).length, 0);
  if (bytes > MAX_CONFIG_BYTES) issues.push({ path: "", message: `Config is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_CONFIG_BYTES / 1024} KB.` });
  if (!("AGENTS.md" in files)) issues.push({ path: "AGENTS.md", message: "AGENTS.md is required (persona and rules)." });

  const config: AgentConfig = {
    version,
    ...parseAgentsMd(files["AGENTS.md"] ?? "", issues),
    skills: [],
    tools: [],
    evals: [],
  };
  for (const path of paths) {
    const text = files[path]!;
    let m: RegExpExecArray | null;
    if (path === "AGENTS.md" || path === "README.md") continue;
    if ((m = SKILL_PATH.exec(path))) {
      const skill = parseSkill(path, m[1]!, text, issues);
      if (skill) config.skills.push(skill);
    } else if ((m = TOOL_PATH.exec(path))) {
      if (config.tools.some((t) => t.name === m![1])) {
        issues.push({ path, message: `Duplicate tool "${m[1]}" (.yaml and .yml).` });
        continue;
      }
      const tool = parseTool(path, m[1]!, text, issues);
      if (tool) config.tools.push(tool);
    } else if (EVAL_PATH.test(path)) {
      config.evals.push(...parseEvals(path, text, issues));
    } else {
      issues.push({
        path,
        message: "Unknown file. Allowed: AGENTS.md, README.md, skills/<name>/SKILL.md, tools/<name>.yaml, evals/<name>.yaml (lowercase names).",
      });
    }
  }
  if (config.tools.length > 20) issues.push({ path: "tools/", message: "At most 20 tools." });
  return { config, issues };
}

/** The customer as verified by the host app (V-03), for {user.*} placeholders. */
export interface ToolUser {
  id: string;
  email: string | null;
  name: string | null;
  attributes: Record<string, string | number | boolean>;
}

export class NotSignedInError extends Error {
  constructor() {
    super("The customer isn't signed in (no verified identity), so their account can't be looked up. Ask them to sign in, or hand off.");
  }
}

/** Values for {placeholders}: tool inputs, the verified customer, and secrets from Worker env vars JUN_SECRET_<NAME>. */
export function fillTemplate(
  template: string,
  input: Record<string, unknown>,
  secrets: (name: string) => string | undefined,
  encode: (s: string) => string = (s) => s,
  user: ToolUser | null = null,
): string {
  return template.replace(PLACEHOLDER, (_, ref: string) => {
    if (ref.startsWith("user.")) {
      if (!user) throw new NotSignedInError();
      const field = ref.slice("user.".length);
      const value = field === "id" ? user.id : field === "email" ? user.email : field === "name" ? user.name : user.attributes[field];
      if (value === undefined || value === null) throw new Error(`The signed-in customer has no ${field}.`);
      return encode(String(value));
    }
    if (ref.startsWith("secrets.")) {
      const value = secrets(ref.slice("secrets.".length));
      if (value === undefined) throw new Error(`Secret ${ref.slice(8)} isn't set (Worker secret JUN_SECRET_${ref.slice(8)}).`);
      return value;
    }
    const value = input[ref];
    return value === undefined || value === null ? "" : encode(String(value));
  });
}
