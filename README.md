# Jun Desk

An open-source support desk for B2B SaaS where the AI already knows what broke. The widget on your site notices the failed request or JavaScript error your customer just hit, so when they write "I can't pay my invoice", the AI can answer "your payment request failed with a server error at 14:02, I've flagged it to the team" instead of asking which browser they use. It runs entirely in your own Cloudflare account.

> **Status: v1 release candidate.** Everything below works and is tested end to end. Expect rough edges; [issues](https://github.com/samarsheikh001/jun-desk-2/issues) welcome.

What you get:

- **A chat widget** (about 4 KB) with live replies, typing indicators, read receipts, file uploads, your colour and logo, and business hours. When nobody's around it asks for an email, so you can reply after they've left, and when a conversation is resolved it asks for a quick 👍 or 👎.
- **An AI agent** that answers from your docs with citations and hands off to a person when it can't help, or when the customer asks. It runs on Workers AI out of the box, so you don't need an API key, and it can use OpenAI instead.
- **Support that sees the bug.** Recent errors, failed requests and pages visited are captured in the visitor's browser, masked twice (in the browser and on the server), and shown to your agents and the AI. If something on the page breaks, the widget can offer help on its own: "Adding a team member didn't work. Want a hand?"
- **A support agent you keep in git.** The AI's rules, procedures, tools and tests are plain files. `jun eval` replays recent real conversations against your edits before you push them, so you see which answers would change.
- **A real-time inbox** with assignment, takeover from the AI, internal notes with @mentions, saved replies, tags, a contact sidebar, and a live list of who's on your site right now. You can start a chat with any of them.
- **Issues from a conversation.** "Create issue" drafts a GitHub or Linear issue from the chat and the masked browser details (steps to reproduce, failing requests, errors, browser), your agent edits it and files it, and the conversation keeps the link. The AI never files issues on its own. Screenshots from the chat can go along: uploaded to Linear, linked from GitHub (ticked by default only for a private repo).
- **Screenshots from the widget.** Visitors can press the camera button to send a screenshot of their screen or tab (the browser asks first; they preview it and send or discard it). Desktop browsers only.
- **Reports** for the last 7, 30 or 90 days: conversations, how many the AI resolved on its own, handoff rate and reasons, first-response times, CSAT and replies per teammate.
- **Topics**: the AI labels each chat with a short topic (Billing, Login, …) once it goes quiet, reusing your existing ones. See the top topics in Reports, filter the inbox by topic, and rename, merge or delete them in Settings.

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
| `JunDesk.reportError({ message, code? })` | Tells support what failed, in your app's words (see below) |

Colour, logo, greeting, button side and business hours are set in **Settings** and apply within a minute without touching the snippet. List your domains under **Allowed websites** so nobody can reuse your (public) widget key on their own site.

**Page openers:** under Settings → Install, owners and admins can offer a chat after a visitor has spent some time on a page (up to 10 rules, e.g. 30 s on `/pricing` or anywhere under `/docs/*`), with your own line or one the AI writes from the page. Only time with the tab in view counts; a visitor gets at most one card per page load, and nothing before consent.

**What the widget captures:** JavaScript errors, failed requests (method, URL and status, never request or response bodies) and pages visited, kept in memory and sent only when the visitor writes to you. Query values are stripped, and emails, tokens, keys and card-like numbers are masked before anything leaves the browser. It also notices rage clicks (the same button clicked 3+ times in a second with nothing happening; only the element's tag, id, aria-label, name, role and a short button/link label are kept) and visitors stuck on a page for 3 minutes after something failed with no successful submit; both show up for your agents and can trigger the "Want a hand?" nudge.

**Errors your app knows about:** when something fails for a reason you can name, say so. The message (up to 300 characters, masked like everything else) joins the visitor's timeline, so the AI and your agents see it, and it can trigger the "Want a hand?" nudge ("Your CSV import failed on row 42."). `code` is optional (letters, digits, `_ . -`, up to 60), for your team: agents see it in the timeline and issue drafts; the AI answering visitors never gets it. It does nothing with `data-capture="off"` or before `JunDesk.consent(true)`, and never throws.

```js
// The loader is async, so it may not be there yet.
window.JunDesk?.reportError({ message: "Row 42: missing email", code: "import.row_invalid" });
```

**Signed-in customers:** create an identity secret in Settings → Install. Your backend signs a short-lived HS256 JWT with `sub` (the user's id) and `exp`, plus `email`, `name` and `attributes` if you like (`{ plan: "pro", seats: 12 }`). Agents then see a verified customer, chats follow them across devices, and the AI's tools can look up their own account with `{user.id}`. Without a valid token, visitors stay anonymous.

## The AI

Turn it on in **Settings** (or from Get started) and add your docs under **Knowledge**: paste a docs or help-center URL and it reads the sitemap, re-syncs daily, and lets you see and prune exactly what it indexed. Snippets cover anything that isn't on the web.

- **Files:** drop PDF, DOCX, Markdown or text files (up to 10 MB each, 200 per workspace) on the Knowledge page. Originals stay in your R2 bucket. If Workers AI can't embed them (say its daily free allocation ran out), they're still found by keyword search, and the next re-index adds the vectors.

- **Workers AI** is the default. It's built in and needs no key. Mistral Small 3.1 answered all five of our benchmark questions correctly at about 1 s to the first word (`scripts/bench-models.ts`).
- **OpenAI**: run `npx wrangler secret put OPENAI_API_KEY`. `OPENAI_BASE_URL` routes it through Cloudflare AI Gateway.
- **ChatGPT sign-in** spends your own ChatGPT plan. Settings → AI assistant → ChatGPT sign-in → Sign in with ChatGPT. Locally it returns to the desk by itself; on a deployed desk, paste back the address of the page that doesn't load. OpenAI's terms cover plan usage for your own use, not a desk answering the public.

It hands a conversation to your team when it can't answer from your docs, when the customer asks for a person, after a set number of replies, or when it hits the monthly cap you set. Your team gets a short brief with what was asked and what failed. Outside business hours the AI keeps answering, and chats waiting for a person get your away message.

## Notifications

Each teammate turns them on in **Settings → Notifications** ("Turn on notifications on this device", once per browser or phone) and picks what they want: a chat needs a person, a chat is assigned to them, a customer replies in their chat, or someone @mentions them. With the desk open in a tab you're not looking at, that tab shows the notification; with it closed, your devices get a Web Push (standard VAPID, nothing to configure: the key is created on first use). Nothing is sent while you're looking at the desk. Clicking one opens the conversation.

**iPhone and iPad:** Safari only allows push for web apps on the Home Screen. Open the desk in Safari, tap Share → **Add to Home Screen**, open Jun Desk from there and turn notifications on.

## Issue trackers

An agent's "Create issue" files to GitHub, Linear, or either (they pick when both are set up). Set them up in **Settings → Issue trackers**:

- **GitHub:** create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) for the one repository, with **Issues: Read and write**. Paste it in Token and save, enter the repository (`owner/name`), and press Test connection.
- **Linear:** create a personal API key (Linear → Settings → Security & access). Paste it in API key and save; the teams load, pick one.

Pasted credentials are kept in the workspace's Durable Object storage, not the database, and never shown again (only their last 4 characters). If you'd rather use Worker secrets, set `GITHUB_TOKEN` / `LINEAR_API_KEY` (`npx wrangler secret put …`); they take priority. Issue text is masked again on the server before it's sent. `GITHUB_API_URL` (GitHub Enterprise Server) and `LINEAR_API_URL` override the endpoints.

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
| `npm run test:e2e` | Twelve end-to-end suites against a dev server on a fresh database, with real AI through your ChatGPT login (`npm run jun -- login chatgpt` once; `E2E_AI_PROVIDER=workers-ai` uses Workers AI instead). Start the server with `JUN_STATE_DIR=.wrangler/e2e-state npx vite --port 5174` (after `npx wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e-state`), then run `BASE_URL=http://localhost:5174 npm run test:e2e` |
| `npm run typecheck` | Packages, Worker and dashboard |
| `npm run build` / `npm run deploy` | Build, then migrate and deploy to your Cloudflare account |

Code lives in `worker/` (API and Durable Objects), `web/` (dashboard and widget frame), `public/widget.js` (the loader), `migrations/` (D1), `packages/` (`llm`, `cli`) and `docs/` (research, backlog, decisions, build plan). [CLAUDE.md](CLAUDE.md) has the conventions.

## License

The desk is [AGPL-3.0](LICENSE). The widget loader and the agent-config format are MIT, so putting Jun Desk on your site never triggers a license review. Outside contributions will need a CLA, which isn't set up yet; see [CONTRIBUTING.md](CONTRIBUTING.md).
