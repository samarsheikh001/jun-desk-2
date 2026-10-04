import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chatgptOAuth as oauth, tokensFromResponse, type CredentialStore } from "@jun/llm";

/** Port used in OpenAI's examples; any free port works, only the port may vary. */
const PREFERRED_PORT = 1455;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is printed too, so the user can open it by hand.
  }
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5"><h1>${title}</h1><p>${body}</p></body>`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface LoginResult {
  email: string | undefined;
  registered: boolean;
}

/**
 * Sign in with ChatGPT using the loopback flow from
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 */
export async function loginWithChatGPT(
  store: CredentialStore,
  options: { openBrowser?: boolean; log?: (line: string) => void } = {},
): Promise<LoginResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const existing = await store.load();
  // The host id must be stable for this machine and saved before the first sign-in.
  const hostId = existing?.hostId ?? crypto.randomUUID();
  if (!existing) await store.save({ hostId });

  const state = oauth.randomToken();
  const nonce = oauth.randomToken();
  const codeVerifier = oauth.randomToken(48);
  const codeChallenge = await oauth.pkceChallenge(codeVerifier);

  let settle!: { resolve: (v: { code: string; clientId: string | undefined }) => void; reject: (e: Error) => void };
  const callback = new Promise<{ code: string; clientId: string | undefined }>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== oauth.CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const params = url.searchParams;
    const fail = (message: string) => {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("Sign-in failed", escapeHtml(message)));
      settle.reject(new Error(message));
    };
    if (params.get("state") !== state) return fail("State mismatch. Start the sign-in again from the terminal.");
    const error = params.get("error");
    if (error) return fail(`${error}${params.get("error_description") ? `: ${params.get("error_description")}` : ""}`);
    const code = params.get("code");
    if (!code) return fail("No authorization code in the callback.");

    res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(page("Signed in to Jun Desk", "You can close this tab and go back to the terminal."));
    settle.resolve({ code, clientId: params.get("client_id") ?? undefined });
  });

  // Start the listener before building the URL, as the docs require.
  let port: number;
  try {
    port = await listen(server, PREFERRED_PORT);
  } catch {
    port = await listen(server, 0);
  }
  const redirectUri = `http://127.0.0.1:${port}${oauth.CALLBACK_PATH}`;

  const authorizeUrl = oauth.buildAuthorizeUrl({
    clientId: existing?.clientId,
    hostId,
    redirectUri,
    state,
    nonce,
    codeChallenge,
    idTokenHint: existing?.tokens?.idToken,
  });

  log("Opening your browser to sign in with ChatGPT. If it doesn't open, visit:");
  log(authorizeUrl);
  if (options.openBrowser !== false) openBrowser(authorizeUrl);

  const timeout = setTimeout(() => settle.reject(new Error("Timed out waiting for sign-in (5 minutes).")), LOGIN_TIMEOUT_MS);
  try {
    const { code, clientId: issuedClientId } = await callback;
    // First registration returns the issued client id in the callback; save that, not dynamic_agent_client.
    const clientId = issuedClientId ?? existing?.clientId;
    if (!clientId || clientId === oauth.REGISTRATION_CLIENT_ID) {
      throw new Error("The callback didn't include an issued client_id.");
    }

    const response = await oauth.exchangeCode({ clientId, code, codeVerifier, redirectUri });
    if (!response.id_token) throw new Error("Token response has no id_token.");
    await oauth.verifyIdToken(response.id_token, { clientId, nonce });

    const tokens = tokensFromResponse(response);
    await store.save({ hostId, clientId, tokens });
    return { email: tokens.email, registered: !existing?.clientId };
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}
