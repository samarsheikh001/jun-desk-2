# Jun Desk

An open-source, AI-first customer support desk for B2B SaaS, deployable to your own Cloudflare account in one click: an embeddable website widget, live visitor tracking, an AI agent that answers and takes actions, and a real-time inbox for human agents. Think Intercom/Fin, Chatbase, Crisp — rebuilt for 2026.

## Current phase: planning, with an early LLM spike

Planning is mostly done (see docs below); M0 in `docs/build-plan.md` hasn't started. The only code so far is the LLM provider layer and a dev CLI. Don't scaffold the Worker/dashboard or pick frameworks unless asked.

## Code

npm workspaces, TypeScript run directly by Node ≥22.18 (type stripping, **no build step**):
- Only erasable TS syntax (no enums, namespaces or constructor parameter properties); relative imports use `.ts` extensions.
- `packages/llm` uses web-standard APIs only (fetch, crypto.subtle, web streams) so it runs on Node and Cloudflare Workers. Node-only code goes in `packages/cli`.
- Zero runtime dependencies so far; keep it that way unless there's a clear reason.

| Package | What |
|---|---|
| `packages/llm` | Provider interface; `ChatGPTProvider` (Sign in with ChatGPT, **dev only**); `OpenAIProvider` (API key; for release). Responses API streaming, error mapping. |
| `packages/cli` | `jun` CLI: `login chatgpt`, `logout`, `whoami`, `models`, `ask`, `chat`. Credentials in `~/.jun/chatgpt.json` (`$JUN_HOME` overrides). |

Commands: `npm test` · `npm run typecheck` · `npm run jun -- <command>`

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
- **Stack: Cloudflare.** Workers serve the API, dashboard and widget assets. Durable Objects handle realtime, presence and the per-conversation agent (Agents SDK). D1 holds durable records, Vectorize the KB, R2 files.
- **Positioning — three pillars** (`docs/research/05-differentiation.md`): **P1 support that sees the bug** (lead: the widget captures errors and failed requests, the AI diagnoses, files Linear/GitHub issues), **P2 your desk, your Cloudflare**, **P3 support agent as code** (config in git, evals). v1 must demo all three.
- **Slack is secondary, not a core feature or pillar.** The core is the widget, AI agent, debug context and inbox. v1 includes only team replies from Slack (handed-off chats); customer Slack Connect channels are v1.1; don't let Slack drive architecture or priorities.

## Still open

Slack rate limits for C-10 (D-13), default release LLM provider (D-10: OpenAI API key vs Claude vs Workers AI), data layer details (D-11), tickets model (D-05).
