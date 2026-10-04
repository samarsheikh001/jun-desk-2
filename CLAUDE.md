# Jun Desk

An open-source, AI-first customer support desk for B2B SaaS, deployable to your own Cloudflare account in one click: an embeddable website widget, live visitor tracking, an AI agent that answers and takes actions, and a real-time inbox for human agents. Think Intercom/Fin, Chatbase, Crisp — rebuilt for 2026.

## Current phase: building v1 (M0–M2 deployed; M4 built locally; M5 next)

Plan: `docs/build-plan.md`. Build milestone by milestone; keep the Deploy button working at every step.

## Code

npm workspaces. `packages/` TypeScript runs directly on Node ≥22.18 (type stripping, no build step); `worker/` and `web/` are bundled by Vite:
- Only erasable TS syntax (no enums, namespaces or constructor parameter properties); relative imports use `.ts` extensions.
- `packages/llm` uses web-standard APIs only (fetch, crypto.subtle, web streams) so it runs on Node and Cloudflare Workers. Node-only code goes in `packages/cli`.
- `packages/` has zero runtime dependencies; the app uses Hono, React and SimpleWebAuthn. Add dependencies only with a clear reason.

| Path | What |
|---|---|
| `worker/` | Hono API under `/api`. Durable Objects: `Conversation` (one per conversation: sockets, seq, write-through to D1) and `WorkspaceHub` (one per workspace: inbox events, presence). Routes: `auth`, `workspaces`, `conversations` (agents), `widget` (public, visitor token), `files` (R2). |
| `worker/ai/` | M2 AI: `knowledge.ts` (sources, Queue crawl jobs, indexing), `extract.ts` (HTMLRewriter), `chunk.ts`, `embeddings.ts` (bge-m3), `knowledge-index.ts` (KnowledgeIndex DO: int8 vectors, in-memory search), `search.ts` (hybrid + rerank), `providers.ts` (Workers AI / OpenAI / dev ChatGPT), `agent.ts` (prompt, citations, handoff rules). AI turns run from the Conversation DO's alarm |
| `shared/debug.ts` | P1 debug context: types, `redact`/`cleanUrl`/`sanitizeContext` (server-side masking; `public/widget.js` mirrors the rules in plain JS, keep them in sync), `describeEvents` for prompts |
| `shared/protocol.ts` | Types and constants shared by Worker, dashboard and widget (socket events, message/conversation shapes) |
| `web/widget/`, `widget.html` | The chat UI inside the widget iframe (served at `/widget?key=`) |
| `public/widget.js` | Embeddable loader (MIT, plain JS, keep under 5 KB); `public/demo.html?key=` is a test page |
| `web/` | React dashboard (Vite), served as the Worker's static assets |
| `migrations/` | D1 migrations (`NNNN_name.sql`); applied by `npm run dev` (local) and `npm run deploy` (remote) |
| `scripts/bench-models.ts` | Latency/behaviour comparison of Workers AI chat models on three support questions (run against the e2e server) |
| `scripts/e2e-*.ts` | E2E on a separate dev server + DB (`JUN_STATE_DIR=.wrangler/e2e-state`, port 5174, see README) so your own local desk isn't wiped: `e2e-auth`, `e2e-chat`, `e2e-ai` (real Workers AI). Helpers in `e2e-lib.ts` |

| Package | What |
|---|---|
| `packages/llm` | Provider interface; `ChatGPTProvider` (Sign in with ChatGPT, **dev only**); `OpenAIProvider` (API key; for release). Responses API streaming, error mapping. |
| `packages/cli` | `jun` CLI: `login chatgpt`, `logout`, `whoami`, `models`, `ask`, `chat`. Credentials in `~/.jun/chatgpt.json` (`$JUN_HOME` overrides). |

Commands: `npm run dev` · `npm test` · `npm run test:e2e` · `npm run typecheck` · `npm run build` · `npm run cf-typegen` (after changing `wrangler.jsonc`) · `npm run jun -- <command>`

AI conventions: the AI only answers when `conversations.handling = 'ai'`; any agent reply, the visitor's "Talk to a person", a HANDOFF line from the model, the turn limit, the monthly cap or an AI error flips it to `human` with a public notice + internal brief. AI replies are idempotent per visitor message (`clientMsgId = ai:<seq>`). Internal messages (`internal = 1`) must never reach visitors (socket broadcast uses the `agent` tag; widget queries exclude them). Local dev: Workers AI always calls Cloudflare (needs `CLOUDFLARE_ACCOUNT_ID` in a gitignored `.env` when the login has several accounts); the dev server binds 127.0.0.1 for the ChatGPT loopback callback; workerd can't fetch its own dev server, so crawl tests use a public URL.

P1 conventions: never capture request/response bodies or storage; mask in the browser *and* on the server; debug context only reaches agents (`/api/conversations/:id/context`) and the AI prompt, never other visitors. The model's control lines (`HANDOFF:` at the start, `ESCALATE:` as the last line) are stripped from what streams to visitors (`streamVisible`).

Realtime conventions: the Worker authenticates every socket upgrade (agent cookie, or visitor token as the 2nd WebSocket subprotocol) and forwards to the DO with `x-jun-*` headers; DOs trust those headers. Messages get `seq` from the Conversation DO and are idempotent per `clientMsgId`. D1 stays the source of truth.

Worker conventions: throw `HttpError` for expected failures (rendered as `{ error: { code, message } }`); non-GET API requests must be JSON (CSRF guard in `worker/index.ts`); IDs are prefixed random strings (`newId("usr")`), timestamps are epoch ms; secrets/tokens are stored only as SHA-256 hashes.

**Sign in with ChatGPT is development-only (D-10).** OpenAI allows plan usage for open-source, locally run apps spending the signed-in user's own plan. Released/deployed builds must use `OpenAIProvider` with an API key (or another API-key provider). Never wire `ChatGPTProvider` into anything that serves website visitors in a release. Use only OpenAI's documented flow, never the Codex `backend-api` workaround.

## Docs map

| File | Purpose |
|---|---|
| `docs/features.md` | **Source of truth** for the feature backlog: every feature with an ID, proposed version, status, and rationale. Includes the "Not building" list. |
| `docs/build-plan.md` | v1 milestones (M0–M8) in build order, launch-critical 🚀 markers, decisions needed before each milestone. |
| `docs/decisions.md` | Open questions that block planning, plus a dated log of decisions made. |
| `docs/research/01-market-landscape.md` | Competitors (Fin/Intercom, Chatbase, Decagon, Sierra, Plain, Pylon, Crisp, Chatwoot, Zendesk), table stakes, differentiators, complaints, pricing trends. |
| `docs/research/02-visitor-experience.md` | Visitor tracking, identity, proactive engagement, struggle detection, co-browse, widget tech & privacy. |
| `docs/research/03-architecture.md` | Realtime transport, AI agent layer, data model, OSS references, candidate stacks, Claude model options. |
| `docs/research/04-cloudflare-self-host.md` | Deploy-to-Cloudflare button capabilities and limits, D1 limits, implications for the open-source build. |
| `docs/research/05-differentiation.md` | Which differentiators are already claimed (Gleap, Sierra, Cloudflare-native OSS), OSS competitors, **positioning thesis and three pillars**. |
| `docs/research/06-chatgpt-login.md` | Whether "Sign in with ChatGPT" can power the AI (no for the live agent; maybe for the local eval CLI), OpenAI API-key route via AI Gateway. |

## How we work on the docs

- **Features** use stable IDs (`W-01`, `AI-03`, …). Never renumber; retire with status `cut` instead of deleting.
- **Status values:** `proposed` → `agreed` → (later `building`, `shipped`), or `cut`. Only the user moves a feature to `agreed` or `cut` — Claude may *propose* changes and record them as `proposed`.
- **Versions:** `v1` (MVP), `v2`, `v3`, `later` (backlog, unscheduled), `—` (cut).
- When a decision is made, add a dated entry to `docs/decisions.md` and update the affected features in the same change.
- **Research claims need a source URL.** Mark anything from third-party/vendor marketing as such, and flag unverified claims with *(unverified)*. Date new research sections (`as of YYYY-MM-DD`) — this market moves monthly.
- New research goes in a new numbered file under `docs/research/` (`04-…md`) and gets a row in the table above.

## Decided (see `docs/decisions.md` log)

- **Target customer: B2B SaaS.** Prioritise Slack Connect, debug context, issue-tracker links, account-level context.
- **Open source, one-click "Deploy to Cloudflare".** This is a hard constraint on every technical choice:
  - Everything must run on Cloudflare primitives the deploy button can auto-provision: Workers, Durable Objects, D1, Vectorize, R2, KV, Queues, Workers AI.
  - **No external services required** for a working install: no Postgres, Redis, Clerk/Auth0, or paid SaaS. Optional integrations are fine.
  - Workers only, not Pages; the deployable app must be self-contained in its directory.
- **Business model: open source + paid hosted cloud (cloud ships in v2).** Server/dashboard AGPL-3.0; widget, SDKs and agent-config format MIT; CLA required for contributions. Data model is multi-workspace from day one (the cloud is multi-tenant), even though self-hosted v1 shows one workspace.
- **Login: passkeys (D-17)**, owner created with `SETUP_TOKEN`, agents via invite links. No email or OAuth service required.
- **Data and layout:** D1 is the source of truth; each conversation's Durable Object holds live state and writes through to D1. One `conversation` table with a `chat`/`ticket` type. The Worker lives at the repo root; `packages/` builds into its assets.
- **Stack: Cloudflare.** Workers serve the API, dashboard and widget assets. Durable Objects handle realtime, presence and the per-conversation agent (Agents SDK). D1 holds durable records, Vectorize the KB, R2 files.
- **Positioning — three pillars** (`docs/research/05-differentiation.md`): **P1 support that sees the bug** (lead: the widget captures errors and failed requests, the AI diagnoses, files Linear/GitHub issues), **P2 your desk, your Cloudflare**, **P3 support agent as code** (config in git, evals). v1 must demo all three.
- **Slack is secondary, not a core feature or pillar.** The core is the widget, AI agent, debug context and inbox. v1 includes only team replies from Slack (handed-off chats); customer Slack Connect channels are v1.1; don't let Slack drive architecture or priorities.

## Still open

Slack rate limits for C-10 (D-13), default release LLM provider (D-10: OpenAI API key vs Claude vs Workers AI).
