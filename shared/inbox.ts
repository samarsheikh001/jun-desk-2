// M7 inbox helpers shared by the Worker and the dashboard: @mentions in notes (I-05),
// saved-reply placeholders (I-06) and tag names (I-07). Pure functions.

export interface MentionTarget {
  id: string;
  name: string;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Members @mentioned in a note: "@Name" (case-insensitive) not followed by another letter, so
 * "@Ann" doesn't match "@Anna". Longer names win, so "@Ann Lee" is Ann Lee, not Ann.
 */
export function findMentions(body: string, members: MentionTarget[]): string[] {
  const byLength = [...members].filter((m) => m.name.trim()).sort((a, b) => b.name.length - a.name.length);
  const lower = body.toLowerCase();
  const found = new Set<string>();
  for (let i = lower.indexOf("@"); i !== -1; i = lower.indexOf("@", i + 1)) {
    if (i > 0 && WORD_CHAR.test(body[i - 1]!)) continue; // an email address, not a mention
    for (const m of byLength) {
      const name = m.name.trim().toLowerCase();
      if (!lower.startsWith(name, i + 1)) continue;
      const after = body[i + 1 + name.length];
      if (after !== undefined && WORD_CHAR.test(after)) continue;
      found.add(m.id);
      break;
    }
  }
  return [...found];
}

/** Splits a note into text and @mention parts for highlighting. */
export function mentionParts(body: string, names: string[]): { text: string; mention: boolean }[] {
  const sorted = names.filter((n) => n.trim()).sort((a, b) => b.length - a.length);
  const parts: { text: string; mention: boolean }[] = [];
  let start = 0;
  const lower = body.toLowerCase();
  for (let i = lower.indexOf("@"); i !== -1; i = lower.indexOf("@", i + 1)) {
    if (i < start || (i > 0 && WORD_CHAR.test(body[i - 1]!))) continue;
    const name = sorted.find((n) => lower.startsWith(n.toLowerCase(), i + 1) && !WORD_CHAR.test(body[i + 1 + n.length] ?? " "));
    if (!name) continue;
    if (i > start) parts.push({ text: body.slice(start, i), mention: false });
    parts.push({ text: body.slice(i, i + 1 + name.length), mention: true });
    start = i + 1 + name.length;
  }
  if (start < body.length) parts.push({ text: body.slice(start), mention: false });
  return parts;
}

/** Placeholders a saved reply may use; filled in when it's inserted into the composer. */
export const SAVED_REPLY_PLACEHOLDERS = ["{first_name}", "{agent_name}"] as const;

export function fillSavedReply(body: string, values: { customerName: string | null; agentName: string }): string {
  const first = values.customerName?.trim().split(/\s+/)[0];
  return body.replaceAll("{first_name}", first || "there").replaceAll("{agent_name}", values.agentName);
}

export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS_PER_CONVERSATION = 20;

/** Tag names are trimmed, single-spaced and compared case-insensitively. Null if unusable. */
export function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim().replace(/^#/, "");
  if (!name || name.length > MAX_TAG_LENGTH) return null;
  return name;
}
