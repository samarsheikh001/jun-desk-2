// End-to-end test of passkey auth against a running dev server, using a software
// authenticator (P-256 / ES256, "none" attestation) in place of a real device.
//
//   npm run dev            # in one terminal
//   npm run test:e2e       # in another (BASE_URL defaults to http://localhost:5173)
//
// Needs a fresh local database: `rm -rf .wrangler/state` then restart `npm run dev`.

import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const ORIGIN = new URL(BASE).origin;
const RP_ID = new URL(BASE).hostname;
const SETUP_TOKEN = process.env.SETUP_TOKEN ?? /^SETUP_TOKEN=(.*)$/m.exec(readFileSync(".dev.vars", "utf8"))?.[1]?.trim();
if (!SETUP_TOKEN) throw new Error("No SETUP_TOKEN in env or .dev.vars");

// ---------- tiny CBOR encoder (enough for attestation objects and COSE keys) ----------
function cborHead(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  throw new Error("CBOR length too large for this encoder");
}
function cbor(value: unknown): number[] {
  if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === "string") {
    const bytes = [...new TextEncoder().encode(value)];
    return [...cborHead(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) return [...cborHead(2, value.length), ...value];
  if (value instanceof Map) {
    const out = cborHead(5, value.size);
    for (const [k, v] of value) out.push(...cbor(k), ...cbor(v));
    return out;
  }
  throw new Error(`Unsupported CBOR value: ${String(value)}`);
}

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) => new Uint8Array(createHash("sha256").update(data).digest());
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

/** Raw (r||s) ECDSA signature → ASN.1 DER, which WebAuthn expects. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

class SoftAuthenticator {
  credentials = new Map<string, { key: webcrypto.CryptoKeyPair; userHandle: string; counter: number }>();

  async create(options: { challenge: string; user: { id: string }; rp: { id?: string } }) {
    const key = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
    const jwk = await webcrypto.subtle.exportKey("jwk", key.publicKey);
    const credId = webcrypto.getRandomValues(new Uint8Array(16));
    const coseKey = new Map<number, unknown>([
      [1, 2], [3, -7], [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
    ]);
    const authData = concat(
      sha256(options.rp.id ?? RP_ID),
      new Uint8Array([0x45]), // UP | UV | AT
      new Uint8Array([0, 0, 0, 0]),
      new Uint8Array(16), // AAGUID
      new Uint8Array([0, credId.length]),
      credId,
      new Uint8Array(cbor(coseKey)),
    );
    const attestationObject = new Uint8Array(cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]])));
    const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: ORIGIN, crossOrigin: false });
    const id = b64url(credId);
    this.credentials.set(id, { key, userHandle: options.user.id, counter: 0 });
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(Buffer.from(clientDataJSON)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  async get(options: { challenge: string; rpId?: string }, credentialId?: string) {
    const id = credentialId ?? [...this.credentials.keys()][0]!;
    const cred = this.credentials.get(id)!;
    cred.counter++;
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, cred.counter);
    const authData = concat(sha256(options.rpId ?? RP_ID), new Uint8Array([0x05]), counter);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
    const raw = new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, cred.key.privateKey, concat(authData, sha256(clientDataJSON))));
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(rawToDer(raw)),
        userHandle: cred.userHandle,
      },
    };
  }
}

// ---------- a browser-ish client with a cookie jar ----------
class Client {
  cookies = new Map<string, string>();

  async call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { Origin: ORIGIN, ...init.headers };
    if (init.body !== undefined) headers["Content-Type"] ??= "application/json";
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${BASE}/api${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      body: init.body === undefined ? null : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, ...rest] = pair!.split("=");
      const value = rest.join("=");
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), value);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    return { status: res.status, json };
  }

  async register(prefix: string, auth: SoftAuthenticator, body: Record<string, unknown> = {}) {
    const options = await this.call(`${prefix}/options`, { body });
    assert.equal(options.status, 200, `${prefix}/options: ${JSON.stringify(options.json)}`);
    const response = await auth.create(options.json as any);
    return this.call(`${prefix}/verify`, { body: { response } });
  }

  async login(auth: SoftAuthenticator, credentialId?: string) {
    const options = await this.call("/auth/login/options", { body: {} });
    assert.equal(options.status, 200);
    const response = await auth.get(options.json as any, credentialId);
    return this.call("/auth/login/verify", { body: { response } });
  }
}

let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`✔ ${name}`);
}

const owner = new SoftAuthenticator();
const browser = new Client();

await step("fresh install reports setup needed", async () => {
  const { json } = await browser.call("/me");
  assert.deepEqual(json, { user: null, setupComplete: false });
});

await step("CSRF: cross-origin and non-JSON writes are rejected", async () => {
  assert.equal((await browser.call("/auth/login/options", { body: {}, headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await browser.call("/auth/login/options", { body: "x=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 400);
});

await step("wrong setup token is refused", async () => {
  const res = await browser.call("/setup/options", { body: { token: "wrong-token-wrong-token", workspaceName: "Acme", name: "Ada", email: "ada@acme.test" } });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, "bad_setup_token");
});

await step("setup creates the workspace, owner and passkey, and signs in", async () => {
  const res = await browser.register("/setup", owner, { token: SETUP_TOKEN, workspaceName: "Acme Support", name: "Ada", email: "Ada@Acme.test" });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const me = await browser.call("/me");
  assert.equal(me.json.user.name, "Ada");
  assert.equal(me.json.user.email, "ada@acme.test");
  assert.equal(me.json.memberships[0].role, "owner");
  assert.equal(me.json.memberships[0].workspaceName, "Acme Support");
});

await step("setup can't run twice", async () => {
  const res = await new Client().call("/setup/options", { body: { token: SETUP_TOKEN, workspaceName: "X", name: "Eve", email: "eve@x.test" } });
  assert.equal(res.status, 409);
});

await step("sign out, then sign in with the passkey", async () => {
  await browser.call("/auth/logout", { body: {} });
  assert.equal((await browser.call("/me")).json.user, null);
  const res = await browser.login(owner);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal((await browser.call("/me")).json.user.name, "Ada");
});

await step("a replayed or unknown login is rejected", async () => {
  const stranger = new SoftAuthenticator();
  await stranger.create({ challenge: "x", user: { id: "u" }, rp: {} });
  const res = await new Client().login(stranger);
  assert.equal(res.status, 401);
  // Verifying without a fresh challenge (no challenge cookie) fails too.
  const replay = await new Client().call("/auth/login/verify", { body: { response: await owner.get({ challenge: "old" }) } });
  assert.equal(replay.status, 400);
});

await step("add a second passkey, remove it, but never the last one", async () => {
  const second = new SoftAuthenticator();
  assert.equal((await browser.register("/passkeys", second)).status, 200);
  const list = (await browser.call("/passkeys")).json.passkeys as { id: string }[];
  assert.equal(list.length, 2);
  assert.equal((await browser.call(`/passkeys/${encodeURIComponent(list[1]!.id)}`, { method: "DELETE" })).status, 200);
  const res = await browser.call(`/passkeys/${encodeURIComponent(list[0]!.id)}`, { method: "DELETE" });
  assert.equal(res.status, 409);
});

await step("owner invites an agent; the agent joins with a passkey; the link is single use", async () => {
  const workspaceId = (await browser.call("/me")).json.memberships[0].workspaceId as string;
  const invite = await browser.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } });
  assert.equal(invite.status, 200);
  const token = new URL(invite.json.url).pathname.split("/").pop()!;

  const agentBrowser = new Client();
  assert.equal((await agentBrowser.call(`/invites/${token}`)).json.workspaceName, "Acme Support");
  const res = await agentBrowser.register(`/invites/${token}`, new SoftAuthenticator(), { name: "Grace", email: "grace@acme.test" });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const me = (await agentBrowser.call("/me")).json;
  assert.equal(me.memberships[0].role, "agent");

  assert.equal((await new Client().call(`/invites/${token}`)).status, 410);
  const members = (await browser.call(`/workspaces/${workspaceId}/members`)).json.members as { role: string }[];
  assert.deepEqual(members.map((m) => m.role), ["owner", "agent"]);

  // Agents can't create invites.
  assert.equal((await agentBrowser.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } })).status, 403);
});

await step("team roles: admins manage agents only; nobody manages the owner; removal signs out", async () => {
  const workspaceId = (await browser.call("/me")).json.memberships[0].workspaceId as string;
  const base = `/workspaces/${workspaceId}`;
  const join = async (role: "admin" | "agent", name: string, inviter = browser) => {
    const invite = await inviter.call(`${base}/invites`, { body: { role } });
    assert.equal(invite.status, 200, JSON.stringify(invite.json));
    const token = new URL(invite.json.url).pathname.split("/").pop()!;
    const client = new Client();
    const res = await client.register(`/invites/${token}`, new SoftAuthenticator(), { name, email: `${name.toLowerCase()}@acme.test` });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return { client, id: (await client.call("/me")).json.user.id as string };
  };

  const admin = await join("admin", "Linus");
  const ownerId = (await browser.call("/me")).json.user.id as string;

  // Admins can invite agents, not admins.
  assert.equal((await admin.client.call(`${base}/invites`, { body: { role: "admin" } })).status, 403);
  const agent = await join("agent", "Ken", admin.client);

  // Admins can't touch the owner or other admins; they can manage agents.
  assert.equal((await admin.client.call(`${base}/members/${ownerId}`, { method: "DELETE" })).status, 403);
  assert.equal((await admin.client.call(`${base}/members/${ownerId}`, { method: "PATCH", body: { role: "agent" } })).status, 403);
  assert.equal((await admin.client.call(`${base}/members/${agent.id}`, { method: "PATCH", body: { role: "admin" } })).status, 403);
  // Agents can't manage anyone or see invites.
  assert.equal((await agent.client.call(`${base}/members/${admin.id}`, { method: "DELETE" })).status, 403);
  assert.equal((await agent.client.call(`${base}/invites`)).status, 403);

  // Owner promotes and demotes.
  assert.equal((await browser.call(`${base}/members/${agent.id}`, { method: "PATCH", body: { role: "admin" } })).status, 200);
  assert.equal((await browser.call(`${base}/members/${agent.id}`, { method: "PATCH", body: { role: "agent" } })).status, 200);

  // Pending invites can be listed and revoked.
  const pending = await browser.call(`${base}/invites`, { body: { role: "agent" } });
  const token = new URL(pending.json.url).pathname.split("/").pop()!;
  const list = (await browser.call(`${base}/invites`)).json.invites as { id: string }[];
  assert.equal(list.length, 1);
  assert.equal((await browser.call(`${base}/invites/${encodeURIComponent(list[0]!.id)}`, { method: "DELETE" })).status, 200);
  assert.equal((await new Client().call(`/invites/${token}`)).status, 410);

  // Admin removes the agent: the agent is signed out and their account is gone.
  assert.equal((await admin.client.call(`${base}/members/${agent.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await agent.client.call("/passkeys")).status, 401);
  assert.equal((await agent.client.call("/me")).json.user, null);
});

await step("recovery with the setup token adds a new owner passkey", async () => {
  const lostDevice = new SoftAuthenticator();
  const fresh = new Client();
  assert.equal((await fresh.call("/recover/options", { body: { token: "wrong-token-wrong-token" } })).status, 403);
  const res = await fresh.register("/recover", lostDevice, { token: SETUP_TOKEN });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal((await fresh.call("/me")).json.user.name, "Ada");
});

await step("signed-out requests to protected routes get 401", async () => {
  assert.equal((await new Client().call("/passkeys")).status, 401);
});

console.log(`\n${passed} steps passed`);
