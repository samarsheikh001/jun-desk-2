import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? {} : { "Content-Type": "application/json" },
    body: init.body === undefined ? null : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  const json = (await response.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!response.ok) throw new ApiError(json.error?.code ?? "http_error", json.error?.message ?? `Request failed (${response.status})`);
  return json as T;
}

/** Runs a passkey registration: get options from `prefix/options`, then post the result to `prefix/verify`. */
export async function registerPasskey(prefix: string, body: Record<string, unknown> = {}): Promise<void> {
  const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>(`${prefix}/options`, { body });
  const response = await startRegistration({ optionsJSON });
  await api(`${prefix}/verify`, { body: { response } });
}

export async function signInWithPasskey(): Promise<void> {
  const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>("/auth/login/options", { body: {} });
  const response = await startAuthentication({ optionsJSON });
  await api("/auth/login/verify", { body: { response } });
}

/** Turns WebAuthn and API errors into something worth showing a person. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.name === "NotAllowedError") return "Passkey prompt was cancelled or timed out.";
  if (error instanceof Error && error.name === "InvalidStateError") return "This device already has a passkey for this account.";
  return error instanceof Error ? error.message : String(error);
}

export interface Me {
  user: { id: string; name: string; email: string | null } | null;
  memberships?: { workspaceId: string; workspaceName: string; role: "owner" | "admin" | "agent" }[];
  setupComplete: boolean;
}
