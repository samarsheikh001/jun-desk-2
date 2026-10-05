# Feature backlog

Source of truth for what we build and when. Conventions are in `CLAUDE.md`.

- **Ver:** `v1` (MVP) · `v1.1` (right after launch) · `v2` · `v3` · `later` · `—` (cut)
- **Status:** `proposed` · `agreed` · `cut` (only the user agrees or cuts)
- **Dep:** depends on an open decision in `docs/decisions.md`
- **Ref:** research file (`01` market, `02` visitor, `03` architecture, `04` Cloudflare self-host, `05` differentiation)
- **Pillars** (from `research/05-differentiation.md`): **P1** support that sees the bug · **P2** your desk, your Cloudflare · **P3** support agent as code

All `v1` rows were agreed on 2026-10-04; later versions are still mostly `proposed`.

## Version themes (proposed)

- **v1 — "Support that sees the bug, on your Cloudflare."** Demos all three pillars: fast widget with error/request capture, an AI agent grounded in docs that uses debug context, guaranteed human handoff, real-time inbox, agent config as code with an eval CLI, one-click deploy. Slack is a secondary channel in v1, not a headline.
- **v2 — "Know why they're stuck."** Struggle detection, debug context, proactive AI, procedures with testing, email channel, analytics, copilot.
- **v3 — "Everywhere and self-improving."** More channels, voice, co-browse, learning from escalations, MCP ecosystem.

---

## W — Widget (visitor-facing)

| ID | Feature | Ver | Status | Why / notes | Ref |
|---|---|---|---|---|---|
| W-01 | Tiny loader (<5 KB) with stand-in bubble; full app loads on interaction | v1 | shipped | Shipped M1: `public/widget.js` is 3.8 KB unminified; chat iframe loads on first open | 02 |
| W-02 | Full widget isolated in iframe or shadow DOM | v1 | shipped | Shipped M1: launcher in shadow DOM, chat in an iframe from the desk origin | 02 |
| W-03 | Streaming AI responses with resumable streams | v1 | shipped | Shipped M2: AI replies stream token-by-token; late joiners get the partial text | 03 |
| W-04 | Branding: colours, logo, position, greeting, launcher text | v1 | shipped | Shipped M7: Settings → Widget appearance (name, greeting, reply time, colour with readable text, left/right, logo PNG/JPEG/WebP/GIF ≤ 512 KB, live preview). The loader reads it from /config (CORS), so no snippet change; data-color still overrides | 01 |
| W-05 | Conversation history for returning visitors | v1 | shipped | Shipped M1: returning visitors see past conversations; reopens the active one | |
| W-06 | File and image attachments | v1 | shipped | Shipped M1: R2; images inline, other types forced to download (nosniff + CSP sandbox) | |
| W-07 | "Talk to a human" always visible | v1 | shipped | Shipped M2: "Talk to a person" while the AI is answering | 01 |
| W-08 | Offline mode: collect email and promise a reply outside business hours | v1 | agreed | Depends on business hours (I-10) | |
| W-09 | AI-rendered UI: allow-listed cards, forms, buttons, choice chips | v2 | proposed | Declarative (A2UI/ChatKit-style), not arbitrary HTML | 02 |
| W-10 | Help-centre search and articles inside the widget | v2 | proposed | Pairs with K-05 | |
| W-11 | Multilingual UI plus auto-translation of messages | v2 | proposed | | |
| W-12 | CSAT rating at conversation end | v1 | agreed | Feeds billing verification (B-02) and analytics | 01 |
| W-13 | Mobile SDKs (iOS/Android/React Native) | v3 | proposed | Web first | 02 |
| W-14 | Public Core Web Vitals budget and perf page | v2 | proposed | Marketing differentiator | 02 |

## V — Visitors and identity

| ID | Feature | Ver | Status | Why / notes | Ref |
|---|---|---|---|---|---|
| V-01 | Live visitor list: current page, referrer, geo, device, time on site | v1 | shipped | Shipped M6: Visitors page, live over the loader's hibernating WebSocket to the workspace hub: page, referrer, location (Cloudflare), device, time on site, pages, verified identity, "in a chat" | 02 |
| V-02 | Page-view trail per visitor session | v1 | shipped | Shipped M4: navigation (incl. pushState/popstate) is part of the captured timeline | 02 |
| V-03 | Identity verification via signed JWT (expiry, revocation) | v1 | shipped | Shipped M6: HS256 JWT (sub, exp, email, name, attributes) signed with a per-workspace identity secret; rotate = revoke; data-user-token or JunDesk.identify(); D-23 | 02 |
| V-04 | Anonymous visitor merged into contact on identify | v1 | shipped | Shipped M6: anonymous visitor merges into the identified contact (conversations + browser tokens); identified users never merge (shared computers get a fresh token) | 03 |
| V-05 | Custom attributes passed from host app (plan, MRR, user id…) | v1 | shipped | Shipped M6: verified `attributes` claim on the contact, shown to agents, given to the AI, usable in tools as {user.<attribute>} | |
| V-06 | Consent-aware mode: no cookies or tracking before consent | v1 | shipped | Shipped M6: data-consent="required" stores nothing and stays off the live list until JunDesk.consent(true) | 02 |
| V-07 | Agent starts a chat with a live visitor | v1 | shipped | Shipped M6: "Start chat" on a live visitor shows a card on their page; replying starts a conversation with the agent's message, assigned to them | 02 |
| V-08 | Pluggable enrichment providers (Clay, Apollo, Cognism…) | v3 | proposed | No single-vendor dependency | 02 |
| V-09 | Company and lead scoring / intent | later | proposed | B2B sales use case | 02 |
| V-11 | Companies/accounts: contacts grouped by company, account-level attributes (plan, MRR) and history | v2 | proposed | New for B2B (D-01); Plain/Pylon are account-centric | 01 |
| V-10 | Visitor segments for targeting | v2 | proposed | Needed by proactive messaging | |

## S — Struggle detection and debug context (main differentiator)

| ID | Feature | Ver | Status | Why / notes | Ref |
|---|---|---|---|---|---|
| S-01 | Capture JS errors and failed network requests in widget SDK | v1 | shipped | Shipped M4: loader captures JS errors, unhandled rejections, failed fetch/XHR (4xx/5xx/network), failed resource loads; in-memory ring buffer (40); sent only with a visitor message | 02, 05 |
| S-02 | Rage-click, dead-click and U-turn detection (Sentry definitions) | v2 | proposed | | 02 |
| S-03 | Debug-context panel on each conversation: recent errors, failed requests, page trail | v1 | shipped | Shipped M4: "Customer context" panel (page, browser, screen, locale) + "What happened" timeline; ⚠ count badge in the inbox list | 02, 05 |
| S-04 | Short session replay (last ~60s) attached on widget open | v3 | proposed | Heavy: privacy masking, storage. Consider integrating rrweb | 02 |
| S-05 | AI uses debug context: summarises what happened and diagnoses ("/api/billing returned 500") | v1 | shipped | Shipped M4: AI gets the timeline; explains what failed and when, then ESCALATE → hands off with a brief quoting the failing request | 02, 05 |
| S-06 | Struggle signals trigger a context-aware AI opener | v1 | shipped | Shipped 2026-10-04 (pulled forward from v2): loader shows "Looks like your payment didn't go through. Want a hand?" ~1 s after a JS error or failed API call; chat opens with that opener; once per page; toggle in Settings | 02 |
| S-07 | PII masking and redaction controls for captured data | v1 | shipped | Shipped M4: no request/response bodies; query values stripped; emails, tokens, keys, secrets, card-like numbers masked in the browser and again on the server; data-capture="off" | 02 |
| S-08 | Create a Linear/Jira/GitHub issue from a conversation with debug context attached | v2 | proposed | **P1**. Moved up: B2B (D-01). Gleap has this (closed) | 02, 05 |
| S-09 | AI drafts a fix PR from a bug conversation (via coding agent) | later | proposed | **P1** stretch. Gleap Kai Code and LogRocket already do it | 05 |
| S-10 | Opt-in error-body capture: for failed requests (status ≥ 400) only, read the first ~300 chars of the response, keep just an `error`/`code`/`message` field if JSON, mask it like everything else. Turns "server error" into "payment provider timed out" for the nudge, the AI and agents. Off by default (e.g. `data-capture="errors+bodies"`) | later | proposed | User asked to keep for later (2026-10-05). Partly reverses D-19 (never capture bodies), so opt-in per site; validation errors can echo user input, hence masking + field allowlist | 02 |
| S-11 | AI-written proactive nudge: the desk writes the one-line opener from the masked failure (method, URL, status, error message, stack top, page title) instead of the URL-keyword guess | v1 | shipped | Shipped 2026-10-05: loader POSTs the masked failure to `/api/widget/:key/nudge` (text/plain, CORS `*`, no preflight); the AI writes one line ("Adding a team member didn't work. Want a hand?"), filtered so nothing technical shows; generic line when AI is off/over cap/slow (2.5 s); cached per failure+page for a day; tokens count toward usage. Also fixed: the old nudge fetched `/config` cross-origin without CORS, so it only worked on same-origin pages | 02 |

## AI — AI agent

| ID | Feature | Ver | Status | Why / notes | Ref |
|---|---|---|---|---|---|
| AI-01 | Answers grounded in the knowledge base, with citations | v1 | shipped | Shipped M2: hybrid search (vectors in KnowledgeIndex DO + D1 FTS5, RRF, bge-reranker), inline [n] citations with source links | 01, 03 |
| AI-02 | "I don't know" + handoff when confidence is low (no guessing) | v1 | shipped | Shipped M2: prompt requires HANDOFF when sources lack the answer; verified it hands off rather than guessing | 03 |
| AI-03 | Escalation rules: asks for human, N turns unresolved, negative sentiment, deny-listed intents | v1 | shipped | Shipped M2: asks for a person (regex + model), 8 AI turns, monthly cap, AI errors. Sentiment-based escalation not yet | 03 |
| AI-04 | Structured handoff brief: identity, intent, what was tried, suggested next step | v1 | shipped | Shipped M2: internal note with reason + AI-written Issue/Tried/Next brief (facts from transcript only) | 03 |
| AI-05 | Custom tools / actions via HTTP endpoints (lookups) | v1 | shipped | Shipped M5: `tools/<name>.yaml` (GET/POST, input placeholders, Worker-secret headers, `pick` fields, 10 s timeout, 4 KB to the model). Failures are explained, not guessed | 01, 03 |
| AI-06 | Approval gate for risky actions (refund, cancel): human or customer confirms | v2 | proposed | AI SDK `needsApproval` pattern | 03 |
| AI-07 | Persona, tone and guidance instructions per workspace | v1 | shipped | Shipped M2: guidance text in Settings → AI assistant | |
| AI-08 | Prompt-injection and abuse guardrails | v1 | shipped | Shipped M2 (prompt-level): ignores instructions in sources/messages; no dedicated classifier yet | 03 |
| AI-09 | Procedures: plain-language multi-step workflows with per-step policy | v2 | proposed | Decagon AOPs / Fin Procedures. Basic version shipped with AI-18 (plain-language procedures as SKILL.md files); per-step policy still v2 | 01 |
| AI-10 | Simulation and regression testing: replay past conversations before publishing changes | v2 | proposed | Fin/Decagon have it; SMB tools don't | 01, 03 |
| AI-11 | Action audit log (tool, args, approval, result) | v1 | shipped | Shipped M5: `ai_actions` table (tool, input, output, HTTP status, duration, config version); "AI actions" in the inbox side panel; never sent to visitors. Approval column waits for AI-06 | 03 |
| AI-12 | Suggested KB articles mined from escalated conversations | v3 | proposed | Chatwoot FAQ suggestions / Duet Apprentice | 01 |
| AI-13 | Agent builder from SOPs and transcripts ("write my procedure") | later | proposed | Sierra Ghostwriter | 01 |
| AI-14 | MCP client: connect customer's MCP servers as tools | v2 | proposed | | 03 |
| AI-15 | Desk exposed as an MCP server (query conversations, KB) | v3 | proposed | | 03 |
| AI-16 | Model routing: Haiku for triage, Sonnet for answers, Opus for hard cases and eval grading | v1 | agreed | One model per workspace in M2 (configurable). Routing (small model for triage) not yet | 03 |
| AI-17 | Gateway for customers' own AI agents as a channel | later | proposed | Decagon launched this 2026-10-01; watch adoption | 01 |
| AI-18 | Agent config as code: procedures, persona, tools and guardrails as files in a git repo; dashboard edits the same config | v1 | shipped | Shipped M5: AGENTS.md + skills/*/SKILL.md + tools/*.yaml + evals/*.yaml; versions in D1; Agent page edits the same files; `jun init/pull/push` with API tokens; conflict rules in D-22 | 05 |
| AI-19 | Eval runner: replay past conversations against a config change, show answer diffs; CLI first, then GitHub Action with PR comment | v1 | shipped | Shipped M5: `jun eval` runs evals/*.yaml (outcome, tools, LLM-judged criteria) and replays recent real conversations with live vs candidate config (temperature 0, judge for substance); NDJSON stream; `--fail-on-change`, `--mock-tools` for CI. GitHub Action still v2 | 05 |

## K — Knowledge base

| ID | Feature | Ver | Status | Why / notes | Ref |
|---|---|---|---|---|---|
| K-01 | Website crawl with scheduled re-sync | v1 | shipped | Shipped M2: sitemap first, else link-following (depth 3, page cap), robots.txt, Queue jobs, content-hash skip, daily cron re-sync, removed pages pruned | 01, 03 |
| K-02 | File upload (PDF, DOCX, MD, TXT) | v1 | agreed | | 01 |
| K-03 | Manual Q&A / snippets | v1 | shipped | Shipped M2: snippets (markdown headings become sections) | |
| K-04 | Source management: see chunks, exclude pages, re-index | v1 | shipped | Shipped M7: per-source detail: indexed pages with chunk counts and their text, remove a page (kept out of future syncs), skip paths, page cap, edit snippets (re-indexed now) | |
| K-05 | Hosted help centre (public articles, SEO) | v2 | proposed | Also the KB source | |
| K-06 | Integrations: Notion, Google Drive, Confluence, Zendesk/Intercom article import | v2 | proposed | Import also helps migration | |
| K-07 | "Content gaps" report: questions the AI couldn't answer | v2 | proposed | | |

## I — Inbox (human agents)

| ID | Feature | Ver | Status | Why / notes | Ref |
|---|---|---|---|---|---|
| I-01 | Real-time shared inbox: AI, pending, open, snoozed, resolved views | v1 | shipped | Shipped M1: Open/Pending/Resolved/All + mine/unassigned filters, live via WorkspaceHub DO | 03 |
| I-02 | Assignment: manual, round-robin, capacity-based | v1 | agreed | Manual assignment shipped in M1; round-robin and capacity-based in v1.1 (D-12) | 03 |
| I-03 | Typing indicators, read receipts, agent presence | v1 | shipped | Shipped M1: typing both ways, read receipts ("Seen"), agent presence avatars | 03 |
| I-04 | Agent takeover / barge-in on an AI conversation | v1 | shipped | Shipped M2: agent reply takes over (internal note); "Take over" / "Hand back to AI" buttons | 03 |
| I-05 | Internal notes and @mentions | v1 | agreed | | |
| I-06 | Saved replies / macros | v1 | agreed | | |
| I-07 | Tags and conversation attributes | v1 | agreed | | |
| I-08 | Contact sidebar: attributes, past conversations, page trail, debug context | v1 | shipped | Shipped M7: sidebar shows the customer (verified details + attributes, or what an agent noted), other conversations (linked), AI actions and browser details; agents can name/email anonymous visitors, not verified ones | |
| I-09 | Teams and routing rules | v2 | proposed | | |
| I-10 | Business hours and auto-replies | v1 | shipped | Shipped M7: weekly hours in a time zone (DST-safe), away message with {when}; one automatic away reply per closed period for chats with the team (not while an agent replied in the last 15 min); widget header says "We're away · back Monday at 09:00". The AI keeps answering 24/7 | |
| I-11 | SLA policies with breach alerts | v2 | proposed | DO alarms fit timers well | 03 |
| I-12 | Copilot: draft reply, summarise, translate, rephrase | v2 | proposed | Table stakes in 2026, but v1 is about the autonomous agent | 01 |
| I-13 | Keyboard-first UI and command palette | v1.1 | agreed | Pushed to v1.1 to make room for pillar slices (D-12) | |
| I-14 | Desktop and mobile push notifications for agents | v1.1 | agreed | Pushed to v1.1 (D-12). Slack notifications (C-09) cover most of this in v1 | |
| I-15 | Agent mobile app | later | proposed | | |
| I-16 | Tickets: async work items, conversation → ticket | v2 | proposed | Separate entity or type flag? See D-05 | 03 |
| I-17 | Automations / workflow rules (if X then assign/tag/close) | v2 | proposed | | |

## C — Channels

| ID | Feature | Ver | Status | Why / notes | Ref |
|---|---|---|---|---|---|
| C-01 | Web widget | v1 | shipped | Shipped in M1 (2026-10-04) | |
| C-02 | Email (inbound forwarding and outbound replies) | v2 | proposed | Second most important channel | 01 |
| C-03 | Slack Connect / shared channels | v1.1 | agreed | Uses the deploying company's own Slack app, installed only in its own workspace. Customers talk to us in shared Slack Connect channels; each thread = conversation; AI answers in-thread or hands off. B2B core channel (Pylon/Plain). D-13 Moved to v1.1 2026-10-04 (Slack is secondary). | 01 |
| C-09 | Team replies from Slack: only chats handed off to a human appear, as a thread whose first message is the handoff brief, debug context and transcript link; replies sync back to the visitor. Setting: "post all new chats" for small teams | v1 | agreed | Shares the Slack app + thread-sync layer with C-03. D-13 |  |
| C-12 | AI in Slack Connect channels: default = AI drafts a reply for a human to approve and send in one click; per-channel setting lets the AI reply directly | v1.1 | agreed | A wrong answer in a shared channel is seen by the customer's whole team. D-13 Moved to v1.1 2026-10-04 (Slack is secondary). | 05 |
| C-10 | "Add to Slack" for customers on free Slack: same app enabled for other workspaces; customer installs in one click and picks a channel | v1.1 | agreed | Covers customers without paid Slack (Slack Connect needs paid on both sides). Reuses v1 thread sync. Check Slack's rate limits for apps installed in other workspaces first. D-13 | |
| C-11 | Customer-built Slack app: customer creates an internal app from our manifest and pastes its token into the desk | later | agreed | Only for customers whose security policy blocks third-party apps. Too much setup for most; vendor holds a token into customer's Slack. D-13 | |
| C-04 | WhatsApp | later | proposed | Moved down: B2B (D-01) | 01 |
| C-05 | Instagram / Messenger / Telegram | later | proposed | | 01 |
| C-06 | Voice AI agent (phone and web) | v3 | proposed | Expected mid-market+; big build | 01 |
| C-07 | SMS | later | proposed | | |
| C-08 | Discord / Teams | later | proposed | B2B | 01 |

## P — Proactive engagement

| ID | Feature | Ver | Status | Why / notes | Ref |
|---|---|---|---|---|---|
| P-01 | Signal-triggered AI openers (struggle, page, segment) | v1 | building | Partly shipped with S-06 (error-triggered nudge). Page/segment triggers still v2 | 02 |
| P-02 | Public API / webhook to start an AI conversation from the customer's backend (e.g. payment failed) | v2 | proposed | Fin Proactive Procedures equivalent | 02 |
| P-03 | Basic targeted messages (page/URL rules) | v2 | proposed | Simple version before P-01 | 02 |
| P-04 | Outbound campaigns (email/in-app broadcasts) | later | proposed | Scope creep toward marketing tools | |
| P-05 | Product tours / in-app guidance | — | proposed | See "Not building" | 02 |

## X — Co-browse

| ID | Feature | Ver | Status | Why / notes | Ref |
|---|---|---|---|---|---|
| X-01 | Human co-browse (view and highlight visitor's page, masked inputs) | v3 | proposed | Crisp has it, Zendesk doesn't | 02 |
| X-02 | AI co-browse: agent highlights and annotates elements to guide the user | later | proposed | Cobrowse.io; cutting-edge | 02 |

## A — Analytics

| ID | Feature | Ver | Status | Why / notes | Ref |
|---|---|---|---|---|---|
| A-01 | Core metrics: conversations, AI resolution rate, handoff rate, first-response time, CSAT | v1 | agreed | Basic dashboard only in v1 | 01 |
| A-02 | Topic clustering of conversations | v2 | proposed | Table stakes | 01 |
| A-03 | AI quality: per-answer feedback, low-confidence review queue | v2 | proposed | | 03 |
| A-04 | Agent performance and SLA reports | v2 | proposed | | |
| A-05 | Export / data warehouse sync | later | proposed | | |

## B — Billing model

Applies to the paid hosted cloud (D-04). B-03 also applies to self-hosters' own LLM spend.

| ID | Feature | Ver | Status | Why / notes | Ref |
|---|---|---|---|---|---|
| B-01 | Pricing model for the hosted cloud | v2 | proposed | Cloud in v2 (D-16) | 01 |
| B-02 | Charge only verified resolutions (customer-confirmed or eval-verified), never "silence = resolved" | v2 | proposed | Direct answer to Fin billing complaints. Ships with the cloud in v2 (D-16) | 01 |
| B-03 | LLM spend caps and usage alerts; AI degrades to "leave a message", never goes silent | v1 | shipped | Shipped M2: monthly reply cap; at the cap chats go to the team with a notice, never silence | 01 |
| B-04 | Usage page: AI conversations, tokens and cost per conversation | v2 | proposed | | 01 |

## T — Platform, admin and security

| ID | Feature | Ver | Status | Why / notes | Ref |
|---|---|---|---|---|---|
| T-01 | Multi-tenant workspaces, members, roles (owner/admin/agent) | v1 | shipped | Workspaces, roles owner > admin > agent (manage only lower roles), invite links with role, pending-invite list and revoke, role changes, member removal (signs them out). Shipped 2026-10-04 | 03 |
| T-02 | Built-in auth with **passkeys** (WebAuthn): owner created on first visit with SETUP_TOKEN; invites; recovery via SETUP_TOKEN. Magic link / Google / SSO optional later | v1 | building | D-17. Built 2026-10-04 (M0); e2e-tested with a software authenticator and verified with a real device on the live deployment | 04 |
| T-03 | Public REST API + webhooks | v2 | proposed | Webhooks for conversation events in v1 if cheap | |
| T-04 | Audit log | v2 | proposed | | 03 |
| T-05 | GDPR: data export, deletion, retention settings, EU data residency | v2 | proposed | Export/delete basics in v1 | 02 |
| T-06 | Integrations: HubSpot/Salesforce CRM, Stripe (subscription lookups) | v3 | proposed | Refocused for B2B (D-01); Shopify dropped | |
| T-07 | Open-source, self-hostable on the user's own Cloudflare account. Server/dashboard AGPL-3.0; widget, SDKs, config format MIT; CLA for contributors | v1 | building | AGPL LICENSE + CONTRIBUTING added (M0). CLA bot and text not set up yet (D-14) | 04 |
| T-09 | "Deploy to Cloudflare" button: provisions D1, DOs, Vectorize, R2, Workers AI; prompts for secrets | v1 | building | Config + button in README (M0). Deployed via `npm run deploy` to jun-desk.samarsheikh001.workers.dev on 2026-10-04 (auto-provisioned D1). The button itself is untested: the repo is private | 04 |
| T-10 | LLM provider choice: Claude (BYO key) recommended, Workers AI zero-key fallback | v1 | shipped | Shipped M2: Workers AI (zero-key default, Mistral Small 3.1 since M5), OpenAI API key (OPENAI_API_KEY secret, AI Gateway via OPENAI_BASE_URL), ChatGPT sign-in dev-only. M5: all providers through the AI SDK | 04 |
| T-11 | First-run setup wizard: create admin, connect LLM, crawl site, copy widget snippet | v1 | agreed | One-click deploy should end in a working bot in minutes | 04 |
| T-13 | Slack app manifest + guided setup: self-hoster creates their own Slack app in a few clicks from a bundled manifest | v1 | agreed | Each self-hosted install needs its own Slack app; this keeps one-click feel. D-13 | 04 |
| T-15 | Sign in with ChatGPT as a **dev-only** LLM provider + `jun` CLI (`login`, `ask`, `chat`, `models`); release builds use an API key | v1 | agreed | D-10. Built 2026-10-04 in `packages/llm`, `packages/cli`. Must never ship enabled for visitor traffic | 06 |
| T-12 | Upgrade path: update from upstream + automatic D1 migrations | v1 | building | `npm run deploy` (scripts/deploy.ts): migrate→deploy on upgrades, deploy→migrate on first install. Upgrade order verified live 2026-10-04; first-install order not yet | 04 |
| T-14 | Hosted cloud: multi-tenant Jun Desk run by us, signup, billing, one D1 per workspace | v2 | agreed | D-04, D-16 | 04 |
| T-08 | SOC 2 | later | proposed | Needed for mid-market sales | |
| T-16 | Widget domain allowlist: only listed websites can show the chat, appear on the live visitor list or trigger AI nudges | v1 | shipped | Shipped 2026-10-05 (follow-up to M6): Settings → Install → Allowed websites (`acme.com`, `*.acme.com`); live socket and nudge check the browser's Origin; the chat frame is served with CSP `frame-ancestors`; empty list = any site; the desk's own origin always works. A non-browser script can still fake Origin (rate limits later) | 02 |

---

## Not building (cut, pending confirmation)

These are proposed as `—`. Each needs the user to confirm the cut.

| ID | Item | Why not |
|---|---|---|
| N-01 | "Silence = resolved" billing (Fin-style assumed resolutions) | Main source of competitor billing anger; we market against it |
| N-02 | Rule-based timed pop-ups as the primary proactive tool | Outdated; replaced by signal-driven openers (P-01). P-03 keeps a simple version |
| N-03 | Built-in person-level de-anonymization (RB2B-style) | Privacy/legal risk, US-only, conflicts with consent-first positioning |
| N-04 | Single hard-wired enrichment vendor (Clearbit-style) | Clearbit Reveal is gone; use pluggable providers (V-08) |
| N-05 | Product tours / in-app guidance builder (P-05) | Separate product category (Amplitude Guides, Userlane); scope creep |
| N-06 | Arbitrary AI-generated HTML in the widget | Security risk; use allow-listed components (W-09) |
| N-07 | Our own voice/speech model | Decagon-scale investment; use providers for C-06 |
| N-08 | Full session-replay product (competing with PostHog/LogRocket) | Only the short support-scoped replay (S-04); integrate others |
| N-09 | Visual drag-and-drop bot-flow builder | 2020-era pattern; plain-language procedures (AI-09) replace it |
| N-10 | Marketing email automation suite | Different product; P-04 stays `later` at most |
