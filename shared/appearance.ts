// W-04 widget appearance: the options, their defaults and limits. The Worker validates and
// serves them (/config), the dashboard's Appearance page edits them and previews the real
// widget with the unsaved draft, and the widget applies them. Defaults reproduce the look
// from before each option existed, so a desk that never touched them doesn't change.

export type WidgetTheme = "auto" | "light" | "dark";
/** `bar`: an "Ask anything…" bar instead of the round button (the Fin-style launcher, D-32). */
export type LauncherStyle = "button" | "card" | "bar";

export const APPEARANCE_DEFAULTS = {
  color: "#2f5bea",
  position: "right",
  /** Follows the visitor's system setting. */
  theme: "auto",
  radius: 16,
  launcher: "button",
  greeting: "Hi! How can we help?",
  replyTime: "We usually reply in a few minutes",
  placeholder: "Write a message…",
} as const;

export const RADIUS_MAX = 24;
export const SUGGESTIONS_MAX = 4;
export const SUGGESTION_LIMIT = 80;
export const TEXT_LIMITS = { displayName: 80, greeting: 200, replyTime: 80, placeholder: 60 } as const;

/** What the widget and the loader get from /config (and the Appearance preview sends the frame). */
export interface WidgetLook {
  workspaceName: string;
  greeting: string;
  color: string;
  position: "left" | "right";
  replyTime: string;
  logoUrl: string | null;
  theme: WidgetTheme;
  radius: number;
  launcher: LauncherStyle;
  placeholder: string;
  suggestions: string[];
}

const HEX = /^#[0-9a-f]{6}$/i;
const THEMES: readonly WidgetTheme[] = ["auto", "light", "dark"];
const LAUNCHERS: readonly LauncherStyle[] = ["button", "card", "bar"];
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Readable text on a brand colour (the loader uses the same rule). */
export function textOn(color: string): string {
  if (!HEX.test(color)) return "#ffffff";
  const n = parseInt(color.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.65 ? "#1c1c1a" : "#ffffff";
}

/** Corner rounding for the widget's own parts: 16 (the default) gives the original 14px bubbles and 8px controls. */
export function radiusVars(radius: number): Record<"--r-md" | "--r-sm", string> {
  return { "--r-md": `${Math.round(radius * 0.875)}px`, "--r-sm": `${Math.round(radius * 0.5)}px` };
}

/**
 * The look for stored (or draft) settings. Lenient: anything unreadable falls back to its
 * default, so a hand-edited row or a half-typed colour never breaks a visitor's chat.
 */
export function widgetLook(s: Record<string, unknown>, workspaceName: string, logoUrl: string | null): WidgetLook {
  const text = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v : fallback);
  const radius = Number(s.radius);
  return {
    workspaceName: text(s.displayName, workspaceName),
    greeting: text(s.greeting, APPEARANCE_DEFAULTS.greeting),
    color: typeof s.color === "string" && HEX.test(s.color) ? s.color.toLowerCase() : APPEARANCE_DEFAULTS.color,
    position: s.position === "left" ? "left" : "right",
    replyTime: text(s.replyTime, APPEARANCE_DEFAULTS.replyTime),
    logoUrl,
    theme: THEMES.includes(s.theme as WidgetTheme) ? (s.theme as WidgetTheme) : APPEARANCE_DEFAULTS.theme,
    radius: s.radius !== undefined && Number.isInteger(radius) && radius >= 0 && radius <= RADIUS_MAX ? radius : APPEARANCE_DEFAULTS.radius,
    launcher: LAUNCHERS.includes(s.launcher as LauncherStyle) ? (s.launcher as LauncherStyle) : APPEARANCE_DEFAULTS.launcher,
    placeholder: text(s.placeholder, APPEARANCE_DEFAULTS.placeholder),
    suggestions: Array.isArray(s.suggestions)
      ? s.suggestions.filter((q): q is string => typeof q === "string" && q.trim() !== "").map((q) => clean(q).slice(0, SUGGESTION_LIMIT)).slice(0, SUGGESTIONS_MAX)
      : [],
  };
}

/**
 * Applies the appearance fields present in a settings update (strict: throws an Error with a
 * message for the admin). Empty text clears a field back to its default.
 */
export function applyAppearance(settings: Record<string, unknown>, body: Record<string, unknown>): void {
  if (body.color !== undefined) {
    if (typeof body.color !== "string" || !HEX.test(body.color)) throw new Error("Colour must look like #2f5bea.");
    settings.color = body.color.toLowerCase();
  }
  if (body.position !== undefined) {
    if (body.position !== "left" && body.position !== "right") throw new Error("Position must be left or right.");
    settings.position = body.position;
  }
  if (body.theme !== undefined) {
    if (!THEMES.includes(body.theme as WidgetTheme)) throw new Error("Theme must be auto, light or dark.");
    settings.theme = body.theme;
  }
  if (body.launcher !== undefined) {
    if (!LAUNCHERS.includes(body.launcher as LauncherStyle)) throw new Error("Launcher must be button, card or bar.");
    settings.launcher = body.launcher;
  }
  if (body.radius !== undefined) {
    if (typeof body.radius !== "number" || !Number.isInteger(body.radius) || body.radius < 0 || body.radius > RADIUS_MAX) {
      throw new Error(`Corner rounding must be a whole number from 0 to ${RADIUS_MAX}.`);
    }
    settings.radius = body.radius;
  }
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "string") throw new Error(`${field} must be text.`);
    const value = clean(body[field] as string);
    if (value.length > max) throw new Error(`Keep ${field} to ${max} characters.`);
    if (value) settings[field] = value;
    else delete settings[field];
  }
  if (body.suggestions !== undefined) {
    if (!Array.isArray(body.suggestions) || body.suggestions.some((q) => typeof q !== "string")) throw new Error("Suggested questions must be a list of text.");
    const list = (body.suggestions as string[]).map(clean).filter(Boolean);
    if (list.length > SUGGESTIONS_MAX) throw new Error(`Use up to ${SUGGESTIONS_MAX} suggested questions.`);
    const long = list.find((q) => q.length > SUGGESTION_LIMIT);
    if (long) throw new Error(`Keep each suggested question to ${SUGGESTION_LIMIT} characters ("${long.slice(0, 30)}…").`);
    if (list.length) settings.suggestions = list;
    else delete settings.suggestions;
  }
}
