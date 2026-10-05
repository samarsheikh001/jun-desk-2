# Jun Desk

Open-source AI support desk for B2B SaaS that knows what broke before your customer finishes typing — running in your own Cloudflare account.

> **Status: early development (M4).** Live chat widget, real-time inbox, an AI assistant that answers from your docs with citations, and **support that sees the bug**: the widget notices errors and failed requests in your customer's browser, so the AI and your team know what broke. See [`docs/build-plan.md`](docs/build-plan.md).

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/samarsheikh001/jun-desk-2)

The button creates the Worker, a D1 database and a Durable Object namespace in your account. It asks for one secret:

- **`SETUP_TOKEN`**: any passphrase of 16+ characters. On first visit you enter it once to create the owner account. Keep it: it's also how you recover access if you lose all your passkeys.

Then open your Worker's URL, enter the setup token, and create a passkey (fingerprint, face or device PIN). No email service, OAuth app or database server is needed.

> Passkeys are tied to the hostname you create them on. If you later move the desk to a custom domain, sign in on the old URL and add a passkey on the new one, or use the recovery page (`/recover`).

## The widget

Paste the snippet from **Settings → Install the chat widget**, ideally in `<head>` so it sees errors from the start of the page.

The loader also keeps a short, in-memory list of what went wrong in the visitor's browser: JavaScript errors, failed requests (status only, never bodies) and pages visited. It's shared with your team only when the visitor sends a message. Query values are stripped and emails, tokens and secrets are masked before anything leaves the browser (and again on the server). To turn it off, add `data-capture="off"` to the script tag.

## AI assistant

Turn it on in **Settings → AI assistant** and add your docs under **Knowledge**. Providers:

- **Workers AI** (default): built in, no key needed.
- **OpenAI**: `npx wrangler secret put OPENAI_API_KEY`. Optional `OPENAI_BASE_URL` to route through Cloudflare AI Gateway.
- **ChatGPT sign-in** (local development only): add `JUN_DEV_CHATGPT=1` to `.dev.vars`, then use "Sign in with ChatGPT" in Settings. OpenAI allows ChatGPT plan usage for open-source apps running on your own machine; deployed desks must use an API key or Workers AI.

## Know who you're talking to

- **Live visitors:** the **Visitors** page lists everyone on pages with the widget, with page, referrer, location, device and time on site. "Start chat" pops a message up on their page.
- **Signed-in customers:** create an identity secret in Settings → Install, have your backend sign a short-lived HS256 JWT for the logged-in user (`sub`, `exp`, optional `email`, `name`, `attributes`), and pass it to the widget:

  ```html
  <script src="https://your-desk.example.com/widget.js" data-key="wk_…" data-user-token="<signed JWT>" async></script>
  <!-- or later: JunDesk.identify(jwt), and JunDesk.logout() on sign-out -->
  ```

  Agents see a verified name, email and attributes; chats follow the user across devices; the AI greets them and tools can look up their account with `{user.id}`.
- **Allowed websites:** list your domains in Settings → Install so copies of your (public) widget key don't work on other sites.
- **Consent:** add `data-consent="required"` and the widget stores nothing and stays off the visitor list until you call `JunDesk.consent(true)`.

## Support agent as code

The AI's persona, procedures, tools and test cases are plain files. Edit them on the **Agent** page, or keep them in git and use the `jun` CLI (from a checkout of this repo; create a token in Settings → API tokens):

```sh
npm run jun -- login https://your-desk.example.com
npm run jun -- init support-agent     # or: pull support-agent (the desk's live config)
npm run jun -- eval support-agent     # run evals/*.yaml and replay recent real chats against your edits
npm run jun -- push support-agent -m "Refund window is now 30 days"
```

| File | What |
|---|---|
| `AGENTS.md` | Persona and rules. Frontmatter: `maxReplies`, `handoffTopics` |
| `skills/<name>/SKILL.md` | Procedures in plain language ([Agent Skills](https://agentskills.io) format: `name`, `description`) |
| `tools/<name>.yaml` | HTTP lookups the AI may call. Secrets: `{secrets.NAME}` in headers, set with `npx wrangler secret put JUN_SECRET_NAME` |
| `evals/<name>.yaml` | Test cases: a customer message and the expected outcome, tools, or criteria |

Every save is a version (the Agent page shows history and can restore). In CI, set `JUN_DESK_URL` and `JUN_DESK_TOKEN` and run `jun eval --fail-on-change`.

## Develop

Requires Node 22.18+.

```sh
npm install
cp .dev.vars.example .dev.vars   # set SETUP_TOKEN (16+ characters)
npm run dev                      # dashboard + Worker on http://localhost:5173
```

| Command | What |
|---|---|
| `npm run dev` | Applies local D1 migrations, then runs Vite with the Worker in the Workers runtime |
| `npm run build` then `npm run deploy` | Build; then deploy to your Cloudflare account with remote D1 migrations (handles first install and upgrades). Set the secret once with `npx wrangler secret put SETUP_TOKEN` |
| `npm test` | Unit tests (`packages/`, `worker/`, `shared/`) |
| `npm run test:e2e` | Auth, chat, AI, debug context, agent-as-code and visitors/identity end to end against a dev server on a fresh DB: run `JUN_STATE_DIR=.wrangler/e2e-state npx vite --port 5174` (after `wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e-state`), then `BASE_URL=http://localhost:5174 npm run test:e2e`. Uses real Workers AI |
| `npm run typecheck` | Packages, Worker and dashboard |
| `npm run jun -- <command>` | `jun` CLI: `login <desk-url>`, `init`, `pull`, `push`, `eval`; dev LLM: `login chatgpt`, `ask`, `chat`, `models` |

Layout: `worker/` (API, Durable Objects), `web/` (dashboard), `migrations/` (D1), `packages/` (`llm`, `cli`), `docs/` (research, backlog, decisions, build plan).

## License

The desk is [AGPL-3.0](LICENSE). The embeddable widget, SDKs and agent-config format will be MIT so embedding Jun Desk never triggers a license review. See [CONTRIBUTING.md](CONTRIBUTING.md).
