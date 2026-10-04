# Jun Desk

Open-source AI support desk for B2B SaaS that knows what broke before your customer finishes typing — running in your own Cloudflare account.

> **Status: early development (M2).** Live chat widget, real-time inbox, and an AI assistant that answers from your docs with citations and hands off to your team. See [`docs/build-plan.md`](docs/build-plan.md).

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/samarsheikh001/jun-desk-2)

The button creates the Worker, a D1 database and a Durable Object namespace in your account. It asks for one secret:

- **`SETUP_TOKEN`**: any passphrase of 16+ characters. On first visit you enter it once to create the owner account. Keep it: it's also how you recover access if you lose all your passkeys.

Then open your Worker's URL, enter the setup token, and create a passkey (fingerprint, face or device PIN). No email service, OAuth app or database server is needed.

> Passkeys are tied to the hostname you create them on. If you later move the desk to a custom domain, sign in on the old URL and add a passkey on the new one, or use the recovery page (`/recover`).

## AI assistant

Turn it on in **Settings → AI assistant** and add your docs under **Knowledge**. Providers:

- **Workers AI** (default): built in, no key needed.
- **OpenAI**: `npx wrangler secret put OPENAI_API_KEY`. Optional `OPENAI_BASE_URL` to route through Cloudflare AI Gateway.
- **ChatGPT sign-in** (local development only): add `JUN_DEV_CHATGPT=1` to `.dev.vars`, then use "Sign in with ChatGPT" in Settings. OpenAI allows ChatGPT plan usage for open-source apps running on your own machine; deployed desks must use an API key or Workers AI.

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
| `npm test` | Unit tests (`packages/`) |
| `npm run test:e2e` | Auth, chat and AI end to end against a dev server on a fresh DB: run `JUN_STATE_DIR=.wrangler/e2e-state npx vite --port 5174` (after `wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e-state`), then `BASE_URL=http://localhost:5174 npm run test:e2e`. Uses real Workers AI |
| `npm run typecheck` | Packages, Worker and dashboard |
| `npm run jun -- <command>` | Developer CLI (`login chatgpt`, `ask`, `chat`, `models`) |

Layout: `worker/` (API, Durable Objects), `web/` (dashboard), `migrations/` (D1), `packages/` (`llm`, `cli`), `docs/` (research, backlog, decisions, build plan).

## License

The desk is [AGPL-3.0](LICENSE). The embeddable widget, SDKs and agent-config format will be MIT so embedding Jun Desk never triggers a license review. See [CONTRIBUTING.md](CONTRIBUTING.md).
