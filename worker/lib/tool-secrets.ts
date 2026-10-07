// Tool secrets (Worker secrets JUN_SECRET_<NAME>) go only in request headers, but an API that
// echoes its request (or puts a key in an error message) could return one: never keep or show it.

/** Replaces the value of every JUN_SECRET_* (6+ characters) in `text` with ••••. */
export function secretScrubber(env: object): (text: string) => string {
  const secrets = Object.entries(env as Record<string, unknown>)
    .filter(([k, v]) => k.startsWith("JUN_SECRET_") && typeof v === "string" && v.length >= 6)
    .map(([, v]) => v as string);
  return (text) => secrets.reduce((t, secret) => t.split(secret).join("••••"), text);
}
