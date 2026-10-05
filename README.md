# Jun Desk

An open-source support desk for B2B SaaS where the AI already knows what broke. The widget on your site notices the failed request or JavaScript error your customer just hit, so when they write "I can't pay my invoice", the AI can answer "your payment request failed with a server error at 14:02, I've flagged it to the team" instead of asking which browser they use. It runs entirely in your own Cloudflare account.

> **Status: v1 release candidate.** Everything below works and is tested end to end. Expect rough edges; [issues](https://github.com/samarsheikh001/jun-desk-2/issues) welcome.

What you get:

- **A chat widget** (about 4 KB) with live replies, typing indicators, read receipts, file uploads, your colour and logo, and business hours. When nobody's around it asks for an email, so you can reply after they've left, and when a conversation is resolved it asks for a quick 👍 or 👎.
- **An AI agent** that answers from your docs with citations and hands off to a person when it can't help, or when the customer asks. It runs on Workers AI out of the box, so you don't need an API key, and it can use OpenAI instead.
- **Support that sees the bug.** Recent errors, failed requests and pages visited are captured in the visitor's browser, masked twice (in the browser and on the server), and shown to your agents and the AI. If something on the page breaks, the widget can offer help on its own: "Adding a team member didn't work. Want a hand?"
- **A support agent you keep in git.** The AI's rules, procedures, tools and tests are plain files. `jun eval` replays recent real conversations against your edits before you push them, so you see which answers would change.
- **A real-time inbox** with assignment, takeover from the AI, internal notes with @mentions, saved replies, tags, a contact sidebar, and a live list of who's on your site right now. You can start a chat with any of them.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/samarsheikh001/jun-desk-2)

The button copies this repo into your GitHub account, creates the Worker, a D1 database, an R2 bucket, a Queue and the Durable Objects, and asks for one secret:

- **`SETUP_TOKEN`**: any passphrase of 16+ characters. You type it once on first visit to create the owner account. Keep it somewhere safe, because it's also how you get back in if you lose every passkey.

Then open the Worker's URL, enter the token and create a passkey (fingerprint, face or device PIN). A **Get started** page walks you through the rest: add your docs, turn on the AI, brand the widget, paste the snippet on your site and invite your team. Each step ticks itself off as you go. Nothing else needs signing up for; there's no email service, auth provider or database server to run.

Prefer the command line? Clone the repo, then `npm install`, `npx wrangler secret put SETUP_TOKEN` and `npm run build && npm run deploy`.

> Passkeys belong to the hostname you create them on. If you move the desk to a custom domain later, sign in on the old URL and add a passkey on the new one, or use `/recover` with the setup token.

## Upgrade

Pull the new version into your copy of the repo and run `npm run deploy`:

```sh
git pull https://github.com/samarsheikh001/jun-desk-2 main
npm install && npm run build && npm run deploy
```

`npm run deploy` applies any new D1 migrations **before** it deploys the new Worker, so new code never runs against an old schema. Your conversations, contacts, knowledge, passkeys and visitors' chat history carry over. `scripts/upgrade-check.ts` is the test for this: it seeds an old install, upgrades it and checks everything survived. It passes from the first AI release (M2) onwards.

## Put the widget on your site

Copy the snippet from **Settings → Install the chat widget**, ideally into `<head>` so it sees errors from the start of the page:

```html
<script src="https://your-desk.example.com/widget.js" data-key="wk_…" async></script>
```

| Option | What it does |
|---|---|
| `data-user-token="<jwt>"` or `JunDesk.identify(jwt)` | Says who the signed-in customer is (see below). `JunDesk.logout()` on sign-out |
| `data-consent="required"` | Stores nothing and stays off your visitor list until `JunDesk.consent(true)` (for cookie banners) |
| `data-capture="off"` | Turns off error and request capture |
| `data-color="#0f766e"` | Overrides the brand colour from Settings |
| `JunDesk.open()`, `.close()`, `.toggle()` | Control the chat from your own buttons |

Colour, logo, greeting, button side and business hours are set in **Settings** and apply within a minute without touching the snippet. List your domains under **Allowed websites** so nobody can reuse your (public) widget key on their own site.

**What the widget captures:** JavaScript errors, failed requests (method, URL and status, never request or response bodies) and pages visited, kept in memory and sent only when the visitor writes to you. Query values are stripped, and emails, tokens, keys and card-like numbers are masked before anything leaves the browser.

**Signed-in customers:** create an identity secret in Settings → Install. Your backend signs a short-lived HS256 JWT with `sub` (the user's id) and `exp`, plus `email`, `name` and `attributes` if you like (`{ plan: "pro", seats: 12 }`). Agents then see a verified customer, chats follow them across devices, and the AI's tools can look up their own account with `{user.id}`. Without a valid token, visitors stay anonymous.

## The AI

Turn it on in **Settings** (or from Get started) and add your docs under **Knowledge**: paste a docs or help-center URL and it reads the sitemap, re-syncs daily, and lets you see and prune exactly what it indexed. Snippets cover anything that isn't on the web.

- **Workers AI** is the default. It's built in and needs no key. Mistral Small 3.1 answered all five of our benchmark questions correctly at about 1 s to the first word (`scripts/bench-models.ts`).
- **OpenAI**: run `npx wrangler secret put OPENAI_API_KEY`. `OPENAI_BASE_URL` routes it through Cloudflare AI Gateway.
- **ChatGPT sign-in** is for local development only: add `JUN_DEV_CHATGPT=1` to `.dev.vars`. OpenAI allows plan usage for open-source apps running on your own machine, not for a deployed desk answering the public.

It hands a conversation to your team when it can't answer from your docs, when the customer asks for a person, after a set number of replies, or when it hits the monthly cap you set. Your team gets a short brief with what was asked and what failed. Outside business hours the AI keeps answering, and chats waiting for a person get your away message.

## Support agent as code

The AI's persona, procedures, tools and tests are files. Edit them on the **Agent** page, or keep them in git and use the `jun` CLI from a checkout of this repo (create a token in Settings → API tokens):

```sh
npm run jun -- login https://your-desk.example.com
npm run jun -- pull support-agent      # the live config (or `init` for a starter)
npm run jun -- eval support-agent      # your test cases, plus a replay of recent real chats
npm run jun -- push support-agent -m "Refund window is now 30 days"
```

| File | What |
|---|---|
| `AGENTS.md` | Tone and rules. Frontmatter: `maxReplies`, `handoffTopics` |
| `skills/<name>/SKILL.md` | Procedures in plain language, in the [Agent Skills](https://agentskills.io) format |
| `tools/<name>.yaml` | HTTP lookups the AI may call, e.g. order status. Secrets go in headers as `{secrets.NAME}` (Worker secret `JUN_SECRET_NAME`) |
| `evals/<name>.yaml` | A customer message and what a good reply does: outcome, tools called, or criteria |

Every save is a version you can restore, and every tool call is logged next to the conversation. In CI, set `JUN_DESK_URL` and `JUN_DESK_TOKEN` and run `jun eval --fail-on-change`.

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
| `npm test` | Unit tests |
| `npm run test:e2e` | Eight end-to-end suites against a dev server on a fresh database, with real Workers AI. Start the server with `JUN_STATE_DIR=.wrangler/e2e-state npx vite --port 5174` (after `npx wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e-state`), then run `BASE_URL=http://localhost:5174 npm run test:e2e` |
| `npm run typecheck` | Packages, Worker and dashboard |
| `npm run build` / `npm run deploy` | Build, then migrate and deploy to your Cloudflare account |

Code lives in `worker/` (API and Durable Objects), `web/` (dashboard and widget frame), `public/widget.js` (the loader), `migrations/` (D1), `packages/` (`llm`, `cli`) and `docs/` (research, backlog, decisions, build plan). [CLAUDE.md](CLAUDE.md) has the conventions.

## License

The desk is [AGPL-3.0](LICENSE). The widget loader and the agent-config format are MIT, so putting Jun Desk on your site never triggers a license review. Outside contributions will need a CLA, which isn't set up yet; see [CONTRIBUTING.md](CONTRIBUTING.md).
