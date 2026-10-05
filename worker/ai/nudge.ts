import type { DebugEvent } from "../../shared/debug.ts";

// S-11: the proactive nudge's one-liner, written by the AI from the (masked) failure instead
// of guessed from URL keywords. Pure helpers; the route in routes/widget.ts calls the model.

export const GENERIC_NUDGE = "Looks like something went wrong on this page. Want a hand?";

export function nudgePrompt(workspaceName: string): string {
  return `You write the one-line message a support chat widget on ${workspaceName}'s website shows right after something failed for the visitor.
Rules:
- ONE short, friendly sentence of at most 14 words, then "Want a hand?".
- Say in plain words what the visitor was doing that didn't work (e.g. "your payment didn't go through", "the usage chart didn't load", "saving your changes failed"), using only the facts given.
- Never mention URLs, status codes, error names, code or technical terms. Never guess the cause. Never promise anything.
- If the facts don't say what the visitor was doing, write: ${GENERIC_NUDGE}
Reply with the message only.`;
}

/** The failure as facts for the model (already masked by the loader and again by the server). */
export function nudgeFacts(event: DebugEvent, page: { url: string; title: string }): string {
  const lines = [`Page: ${page.title || "(untitled)"} (${page.url})`];
  if (event.kind === "network") {
    lines.push(`A request the page made failed: ${event.method ?? "GET"} ${event.url ?? "?"} → ${event.status ? `HTTP ${event.status}` : "no response"}${event.message ? ` (${event.message})` : ""}`);
  } else {
    lines.push(`A JavaScript error happened: ${event.message ?? "unknown error"}`);
    if (event.source) lines.push(`In: ${event.source}`);
    if (event.stack) lines.push(`Stack (top): ${event.stack.split("\n").slice(0, 3).join(" | ")}`);
  }
  return lines.join("\n");
}

/**
 * The model's line, if it's usable on a customer's page: one short sentence, no technical
 * detail leaking through. Otherwise null (the caller falls back to the generic line).
 */
export function cleanNudge(raw: string): string | null {
  let text = raw.trim().split("\n")[0]!.trim().replace(/^["'“”*_\s]+|["'“”*_\s]+$/g, "");
  if (!text) return null;
  if (!/want a hand\?$/i.test(text)) text = `${text.replace(/[.!?]*$/, ".")} Want a hand?`;
  if (text.length > 140) return null;
  // Anything that looks technical stays out of the visitor's sight.
  if (/https?:|\/[a-z0-9_-]+\/|\b[1-5]\d\d\b|\b(error|exception|undefined|null|api|http|status|stack|typeerror|500|404)\b/i.test(text)) return null;
  return text;
}

/** Same failure on the same page → same line; lets the route cache instead of calling the model. */
export function nudgeCacheKey(workspaceId: string, event: DebugEvent, page: { url: string; title: string }): string {
  const what = event.kind === "network" ? `${event.method} ${event.url} ${event.status}` : `${event.message} ${event.source ?? ""}`;
  return `${workspaceId}|${page.url}|${page.title}|${event.kind}|${what}`;
}
