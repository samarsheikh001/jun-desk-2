// Debug context captured by the widget loader on the customer's site (P1: support that
// sees the bug). Shared by the Worker (server-side sanitising, AI prompt) and the
// dashboard (timeline). The loader (public/widget.js) applies the same redaction rules
// in plain JS; keep them in sync.

/** app_error: the host app's own words, from JunDesk.reportError({ message, code? }) (S-12). */
export type DebugEventKind = "error" | "network" | "navigation" | "app_error";

export interface DebugEvent {
  /** Epoch ms. */
  t: number;
  kind: DebugEventKind;
  /** error / app_error: message; network: error text for failures without a status. */
  message?: string;
  /** app_error: the app's optional error code (`[\w.-]`, at most 60 chars). */
  code?: string;
  /** error: "file:line"; */
  source?: string;
  /** error: first lines of the stack. */
  stack?: string;
  /** network */
  method?: string;
  /** network / navigation: path (+ query keys only) for same-site URLs, origin+path otherwise. */
  url?: string;
  /** network: HTTP status, or 0 for a network failure / blocked resource. */
  status?: number;
  durationMs?: number;
}

export interface DebugContext {
  page: { url: string; title: string };
  userAgent: string;
  viewport: { w: number; h: number };
  language: string;
  timezone: string;
  /** Epoch ms when the browser took the snapshot. */
  capturedAt: number;
  events: DebugEvent[];
}

export const MAX_DEBUG_EVENTS = 50;
const MAX_TEXT = 500;

/** Masks personal data and secrets in free text (error messages, stacks, titles). */
export function redact(input: unknown, max = MAX_TEXT): string {
  return String(input ?? "")
    .slice(0, max * 2)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]")
    .replace(/(bearer\s+)[\w.~+/-]+=*/gi, "$1[token]")
    .replace(/\b(sk|pk|rk)_(live|test)_[\w]+/gi, "[key]")
    .replace(/((?:pass(?:word)?|passwd|secret|token|api[_-]?key|auth\w*|session\w*|cookie)["']?\s*[:=]\s*["']?)[^\s"'&,;)]+/gi, "$1[redacted]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[number]")
    .slice(0, max);
}

/** Keeps a URL's path but never query values (they often hold tokens, emails, ids). */
export function cleanUrl(input: unknown, pageOrigin?: string): string {
  const raw = String(input ?? "").slice(0, 2000);
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw);
    const url = new URL(raw, pageOrigin ?? "https://relative.invalid");
    const keys = [...new Set(url.searchParams.keys())].slice(0, 10);
    const query = keys.length ? `?${keys.map((k) => `${redact(k, 40)}=…`).join("&")}` : "";
    const path = redact(url.pathname, 300);
    // Same-site (or relative) URLs become paths; other sites keep their origin.
    const sameSite = !absolute || (pageOrigin !== undefined && url.origin === new URL(pageOrigin).origin);
    return sameSite ? `${path}${query}` : `${url.origin}${path}${query}`;
  } catch {
    return redact(raw.split(/[?#]/)[0], 300);
  }
}

const KINDS = new Set<DebugEventKind>(["error", "network", "navigation", "app_error"]);
export const MAX_APP_ERROR = 300;

/** An app error code: masked, then only `[\w.-]`, at most 60 chars; "" when nothing's left. */
export function cleanCode(input: unknown): string {
  return typeof input === "string" ? redact(input, 60).replace(/[^\w.-]/g, "") : "";
}

/**
 * Validates and re-redacts context from the browser. Never trust the client: unknown
 * fields are dropped, strings are capped and masked again, URLs lose query values.
 */
export function sanitizeContext(raw: unknown): DebugContext | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const page = (r.page ?? {}) as Record<string, unknown>;
  let origin: string | undefined;
  try {
    origin = new URL(String(page.url ?? "")).origin;
  } catch {
    origin = undefined;
  }
  const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const viewport = (r.viewport ?? {}) as Record<string, unknown>;

  const events: DebugEvent[] = [];
  for (const e of Array.isArray(r.events) ? r.events.slice(-MAX_DEBUG_EVENTS) : []) {
    if (!e || typeof e !== "object") continue;
    const ev = e as Record<string, unknown>;
    if (!KINDS.has(ev.kind as DebugEventKind)) continue;
    const out: DebugEvent = { t: num(ev.t), kind: ev.kind as DebugEventKind };
    if (out.kind === "app_error") {
      // Only what reportError() sends: a message and an optional code.
      const message = typeof ev.message === "string" ? redact(ev.message.trim(), MAX_APP_ERROR) : "";
      if (!message) continue;
      out.message = message;
      const code = cleanCode(ev.code);
      if (code) out.code = code;
      events.push(out);
      continue;
    }
    if (ev.message != null) out.message = redact(ev.message);
    if (ev.source != null) out.source = redact(ev.source, 300);
    if (ev.stack != null) out.stack = redact(ev.stack, 800).split("\n").slice(0, 5).join("\n");
    if (ev.method != null) out.method = String(ev.method).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10);
    if (ev.url != null) out.url = cleanUrl(ev.url, origin);
    if (ev.status != null) out.status = Math.max(0, Math.min(999, Math.trunc(num(ev.status))));
    if (ev.durationMs != null) out.durationMs = Math.max(0, Math.trunc(num(ev.durationMs)));
    events.push(out);
  }
  events.sort((a, b) => a.t - b.t);

  return {
    page: { url: cleanUrl(page.url ?? ""), title: redact(page.title ?? "", 200) },
    userAgent: String(r.userAgent ?? "").slice(0, 300),
    viewport: { w: Math.trunc(num(viewport.w)), h: Math.trunc(num(viewport.h)) },
    language: String(r.language ?? "").slice(0, 20),
    timezone: String(r.timezone ?? "").slice(0, 60),
    capturedAt: num(r.capturedAt, Date.now()),
    events,
  };
}

/** Errors (the browser's and the app's own) and failed requests (what the inbox badge counts). */
export function isIssue(e: DebugEvent): boolean {
  return e.kind === "error" || e.kind === "app_error" || (e.kind === "network" && (e.status === 0 || (e.status ?? 0) >= 400));
}

/** "14:02:11" in the visitor's timezone when known. */
export function formatEventTime(t: number, timezone?: string): string {
  try {
    return new Date(t).toLocaleTimeString("en-GB", { hour12: false, ...(timezone ? { timeZone: timezone } : {}) });
  } catch {
    return new Date(t).toISOString().slice(11, 19);
  }
}

/** One line per event, oldest first, for the AI prompt and handoff briefs. */
export function describeEvents(context: DebugContext): string[] {
  return context.events.map((e) => {
    const at = formatEventTime(e.t, context.timezone);
    if (e.kind === "navigation") return `[${at}] Visited ${e.url}`;
    if (e.kind === "network") {
      const outcome = e.status ? `HTTP ${e.status}` : `failed${e.message ? ` (${e.message})` : ""}`;
      return `[${at}] ${e.method ?? "GET"} ${e.url} → ${outcome}${e.durationMs != null ? ` in ${e.durationMs} ms` : ""}`;
    }
    if (e.kind === "app_error") return `[${at}] The app reported an error: ${e.message}${e.code ? ` (code ${e.code})` : ""}`;
    return `[${at}] JavaScript error: ${e.message}${e.source ? ` at ${e.source}` : ""}`;
  });
}

/** "Chrome 141" from a user agent string (good enough for a support panel or an issue). */
export function browserName(ua: string): string {
  const version = (re: RegExp) => re.exec(ua)?.[1];
  if (version(/Edg\/(\d+)/)) return `Edge ${version(/Edg\/(\d+)/)}`;
  if (version(/Firefox\/(\d+)/)) return `Firefox ${version(/Firefox\/(\d+)/)}`;
  if (version(/Chrome\/(\d+)/)) return `Chrome ${version(/Chrome\/(\d+)/)}`;
  if (/Safari/.test(ua) && version(/Version\/(\d+)/)) return `Safari ${version(/Version\/(\d+)/)}`;
  return "Unknown browser";
}

/** "Windows", "macOS", … or "" when the user agent doesn't say. */
export function osName(ua: string): string {
  return /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
}

/** "Chrome 141 on Windows". */
export function describeBrowser(ua: string): string {
  const os = osName(ua);
  return os ? `${browserName(ua)} on ${os}` : browserName(ua);
}
