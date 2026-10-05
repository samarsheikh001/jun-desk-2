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
| W-08 | Offline mode: collect email and promise a reply outside business hours | v1 | shipped | Shipped M7 (collect only): when a chat waits for the team (outside hours, or no reply within a minute) the widget asks for an email; it's saved on the (anonymous) contact with a note for agents, who reply from their own mail client ("Reply by email" in the sidebar). Sending replies by email automatically needs an email provider: later, opt-in | |
| W-09 | AI-rendered UI: allow-listed cards, forms, buttons, choice chips | v2 | proposed | Declarative (A2UI/ChatKit-style), not arbitrary HTML | 02 |
| W-10 | Help-centre search and articles inside the widget | v2 | proposed | Pairs with K-05 | |
| W-11 | Multilingual UI plus auto-translation of messages | v2 | proposed | | |
| W-12 | CSAT rating at conversation end | v1 | shipped | Shipped M7: when a conversation the team or the AI answered is resolved, the widget asks "How did we do?" (👍/👎, then an optional comment). Once per resolution: writing again reopens it, and the next resolution can be rated again. Every rating is kept (`csat_ratings`, for A-01); the latest shows as a badge in the inbox, with a rating filter and a note for agents. On by default, off in Settings → Widget appearance. Feeds billing verification (B-02) and analytics | 01 |
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
| S-02 | Rage-click, dead-click and U-turn detection (Sentry definitions) | v1 | shipped | **Shipped 2026-10-05 (rage clicks only, pulled forward from v2):** `rage_click` timeline event when the same element gets 3+ clicks within 1 s and 30 px and nothing in the DOM changes or scrolls until 1 s after the last (Sentry: 3+ clicks on an element with no DOM change or scroll within 7 s). Keeps only a safe target (tag, id, aria-label, name, role, and the visible label of a button/link ≤ 40 chars), masked in the loader and again in `sanitizeContext`, plus the count. Skips text inputs, selects, contenteditable, canvas/video, scripted clicks and triple clicks that select text. Counts as an issue (⚠), shown in "What happened", the AI prompt and issue drafts; triggers the S-11 nudge ("Looks like the Export CSV button isn't responding. Want a hand?"). Dead clicks (single) and U-turns not built: one unanswered click is too often a slow request or a click on plain text | 02 |
| S-03 | Debug-context panel on each conversation: recent errors, failed requests, page trail | v1 | shipped | Shipped M4: "Customer context" panel (page, browser, screen, locale) + "What happened" timeline; ⚠ count badge in the inbox list | 02, 05 |
| S-04 | Short session replay (last ~60s) attached on widget open | v3 | proposed | Heavy: privacy masking, storage. Consider integrating rrweb | 02 |
| S-05 | AI uses debug context: summarises what happened and diagnoses ("/api/billing returned 500") | v1 | shipped | Shipped M4: AI gets the timeline; explains what failed and when, then ESCALATE → hands off with a brief quoting the failing request | 02, 05 |
| S-06 | Struggle signals trigger a context-aware AI opener | v1 | shipped | Shipped 2026-10-04 (pulled forward from v2): loader shows "Looks like your payment didn't go through. Want a hand?" ~1 s after a JS error or failed API call; chat opens with that opener; once per page; toggle in Settings. **2026-10-05:** a request that got no response (status 0: ad blocker, privacy tool, DNS or network failure) only counts for the nudge and for S-13 "stuck" when it went to the page's own site (same origin, or a host with the same last two labels, three for `co.uk`-style suffixes, so `app.acme.com` → `api.acme.com` counts and analytics/trackers don't); HTTP 4xx/5xx from any origin keep the old rules; every failure still goes in the agent's timeline | 02 |
| S-07 | PII masking and redaction controls for captured data | v1 | shipped | Shipped M4: no request/response bodies; query values stripped; emails, tokens, keys, secrets, card-like numbers masked in the browser and again on the server; data-capture="off" | 02 |
| S-08 | Create a GitHub or Linear issue from a conversation: the AI drafts title, reproduction steps, expected vs actual, failing requests and browser from the transcript + debug context; the agent edits and files it; link back to the conversation. Jira later | v1 | shipped | **P1**. Pulled into v1 before launch (2026-10-05, D-26) so the demo runs widget → diagnosis → issue. One click by an agent, never filed by the AI on its own. Gleap has this (closed). **Shipped 2026-10-05:** "Create issue" in the inbox header opens a dialog with an AI draft (Workers AI or the configured model, 15 s budget; a template from the same facts when AI is off, over the cap or fails). The model writes only title, summary, steps, expected/actual and is told to say "Unknown" rather than guess; failing requests, errors, environment and the link back are assembled from the masked debug context (`shared/issues.ts`). Agents pick GitHub or Linear when both are set up (last choice remembered); the body is masked again server-side before filing; one issue per click (`clientId`); the conversation gets an internal "Issue created" note and an Issues bar. Settings → Issue trackers: repo / Linear team, Test connection (loads Linear teams); credentials only as Worker secrets `GITHUB_TOKEN` / `LINEAR_API_KEY` Credentials can be pasted in Settings (kept in the workspace hub's Durable Object storage, not D1, write-only) or set as Worker secrets, which win. | 02, 05 |
| S-09 | AI drafts a fix PR from a bug conversation (via coding agent) | later | proposed | **P1** stretch. Gleap Kai Code and LogRocket already do it | 05 |
| S-10 | Opt-in error-body capture: for failed requests (status ≥ 400) only, read the first ~300 chars of the response, keep just an `error`/`code`/`message` field if JSON, mask it like everything else. Turns "server error" into "payment provider timed out" for the nudge, the AI and agents. Off by default (e.g. `data-capture="errors+bodies"`) | later | proposed | User asked to keep for later (2026-10-05). Partly reverses D-19 (never capture bodies), so opt-in per site; validation errors can echo user input, hence masking + field allowlist | 02 |
| S-11 | AI-written proactive nudge: the desk writes the one-line opener from the masked failure (method, URL, status, error message, stack top, page title) instead of the URL-keyword guess | v1 | shipped | Shipped 2026-10-05: loader POSTs the masked failure to `/api/widget/:key/nudge` (text/plain, CORS `*`, no preflight); the AI writes one line ("Adding a team member didn't work. Want a hand?"), filtered so nothing technical shows; generic line when AI is off/over cap/slow (10 s, raised from 2.5 s for ChatGPT models); cached per failure+page for a day; tokens count toward usage. Also fixed: the old nudge fetched `/config` cross-origin without CORS, so it only worked on same-origin pages | 02 |
| S-12 | `JunDesk.reportError({ message, code? })`: the customer's app tells the widget exactly what failed ("Row 42: missing email"); the message (masked, ≤ 300 chars) joins the timeline and feeds the nudge (S-11), the AI and agents | v1 | shipped | Gets "your CSV import failed on row 42" without reading response bodies (keeps D-19, unlike S-10): the app chooses what to share. Small: one loader method + timeline event type. **Shipped 2026-10-05:** `app_error` timeline event (message masked, ≤ 300 chars; optional code `[\w.-]` ≤ 60), masked in the loader and again in `sanitizeContext`; counts as an issue (⚠), shown in "What happened" as "Reported by the app", in the AI prompt, handoff brief and issue drafts (Errors section, fallback "actual"); triggers the S-11 nudge ("Your contact import failed because row 42 is missing an email. Want a hand?"), numbers from the app's message allowed through the filter. No-op with `data-capture="off"` or before consent; bad input is ignored, never throws | 02, 05 |
| S-13 | "Stuck on a form" signal: same page for ~3 min with an earlier error and no successful submit triggers the nudge | v1 | shipped | Narrowed on purpose: a plain time-on-page timer fires on people reading docs and is the timed pop-up we cut (N-02). Pairs with S-02. **Shipped 2026-10-05 (pulled forward from v2):** `stuck` timeline event (page path, visible seconds, kind of the earlier issue) after 3 visible minutes on the same path (hidden-tab time doesn't count; SPA navigation to another path resets) when the page had a JS error, app error, rage click or failed request (any status, but not asset loads) and no `submit` or 2xx non-GET request since. Not counted as an issue itself (it follows one). Triggers the nudge ("Still working on this? Want a hand?") unless one was already shown on the page; no-op before consent or with `data-capture="off"` | 02 |
| S-14 | Screenshots in issues: the conversation's image attachments (visitor's and agents') listed in the Create issue dialog, ticked by default; Linear gets them uploaded to its own storage (inline, private), GitHub gets links to the desk's unguessable file URLs | v1 | shipped | Built before launch (D-28). GitHub has no image-upload API, so links are visible to anyone who can see the repo: fine for private repos, a risk for public ones. **Shipped 2026-10-05:** the dialog lists the conversation's images (public messages and internal notes) as thumbnails with checkboxes, up to 10. Linear: ticked, each uploaded with `fileUpload` + a PUT to Linear's storage and embedded inline. GitHub: Markdown links to `/api/files/<key>`, ticked only when Test connection's `GET /repos` says the repo is private (checked when the dialog opens); on a public or unknown repo they start unticked with a warning. The server accepts only images attached to this conversation (400 otherwise); an image that fails to upload is left out and the toast says so | 05 |
| S-15 | "Send a screenshot" button in the widget: the visitor captures their screen/tab with the browser's permission prompt (`getDisplayMedia`) and it arrives as a chat attachment; the AI may ask for one | v1 | shipped | Built before launch (D-28). Explicit visitor action only, so it keeps D-19 (no silent capture); Chrome/Edge/Firefox, limited Safari, mostly not mobile. Automatic capture stays S-04 (v3). **Shipped 2026-10-05:** a camera button next to the paperclip asks the browser to share (current tab offered first), grabs one frame and stops sharing at once; the visitor previews it and sends or discards it; it goes as a normal PNG attachment (JPEG if over 10 MB, longest side ≤ 2560 px). The loader's iframe now has `allow="display-capture"` (needed in a cross-origin iframe); the button is hidden where the API or that permission is missing. The AI's prompt says it may ask for one | 02 |

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
| AI-16 | Model routing: a model per AI job within the workspace's provider (e.g. a small fast model for nudges, a stronger one for answers and eval grading) | v1 | shipped | **Shipped 2026-10-06:** every AI call names its job (`answer` visitor replies and eval replies, `brief` handoff brief, `nudge` nudges and openers, `draft` issue drafts, `topics` topic labels, `judge` eval grading) and `modelFor` picks its model: an admin override (`ai_settings.models`, migration 0013) or the workspace model, so nothing changes until one is set. Same provider for every job. An override the provider rejects as unknown falls back to the workspace model once (logged), so a typo doesn't break nudges or briefs. Settings → AI assistant → "Advanced: model per task", with "Suggested for ChatGPT" (`gpt-6-luna` for nudge, topics and brief). Usage accounting unchanged | 03 |
| AI-17 | Gateway for customers' own AI agents as a channel | later | proposed | Decagon launched this 2026-10-01; watch adoption | 01 |
| AI-18 | Agent config as code: procedures, persona, tools and guardrails as files in a git repo; dashboard edits the same config | v1 | shipped | Shipped M5: AGENTS.md + skills/*/SKILL.md + tools/*.yaml + evals/*.yaml; versions in D1; Agent page edits the same files; `jun init/pull/push` with API tokens; conflict rules in D-22 | 05 |
| AI-19 | Eval runner: replay past conversations against a config change, show answer diffs; CLI first, then GitHub Action with PR comment | v1 | shipped | Shipped M5: `jun eval` runs evals/*.yaml (outcome, tools, LLM-judged criteria) and replays recent real conversations with live vs candidate config (temperature 0, judge for substance); NDJSON stream; `--fail-on-change`, `--mock-tools` for CI. GitHub Action still v2 | 05 |

## K — Knowledge base

| ID | Feature | Ver | Status | Why / notes | Ref |
|---|---|---|---|---|---|
| K-01 | Website crawl with scheduled re-sync | v1 | shipped | Shipped M2: sitemap first, else link-following (depth 3, page cap), robots.txt, Queue jobs, content-hash skip, daily cron re-sync, removed pages pruned | 01, 03 |
| K-02 | File upload (PDF, DOCX, MD, TXT) | v1 | shipped | Shipped 2026-10-05: drag-and-drop on the Knowledge page (≤ 10 MB each, ≤ 200 per workspace, type checked by extension and bytes); original in R2, indexed by a Queue job. PDF via Workers AI toMarkdown, DOCX by our own unzip + XML reader (no new dependency). Indexing no longer fails when embedding does: chunks stay keyword-searchable and a re-index or the daily cron adds vectors (also for pages and snippets) | 01 |
| K-03 | Manual Q&A / snippets | v1 | shipped | Shipped M2: snippets (markdown headings become sections) | |
| K-04 | Source management: see chunks, exclude pages, re-index | v1 | shipped | Shipped M7: per-source detail: indexed pages with chunk counts and their text, remove a page (kept out of future syncs), skip paths, page cap, edit snippets (re-indexed now) | |
| K-05 | Hosted help centre (public articles, SEO) | v2 | proposed | Also the KB source | |
| K-06 | Integrations: Notion, Google Drive, Confluence, Zendesk/Intercom article import | v2 | proposed | Import also helps migration | |
| K-07 | "Content gaps" report: questions the AI couldn't answer | v2 | proposed | | |
| K-08 | Vectorize as an optional scale mode for knowledge search | later | proposed | Revisit when a workspace nears hundreds of thousands of chunks: today's `KnowledgeIndex` Durable Object (D-18) loads int8 vectors into memory and gets slow at that size, where Vectorize's index scales better. Below that ours is cheaper on the free tier (Vectorize counts every queried dimension: ~30M/month free ≈ 30k searches at 1,024 dims). Embedding cost (bge-m3) is the same either way. Vectorize isn't auto-provisioned by the Deploy button, so it must stay opt-in | 04 |

## I — Inbox (human agents)

| ID | Feature | Ver | Status | Why / notes | Ref |
|---|---|---|---|---|---|
| I-01 | Real-time shared inbox: AI, pending, open, snoozed, resolved views | v1 | shipped | Shipped M1: Open/Pending/Resolved/All + mine/unassigned filters, live via WorkspaceHub DO | 03 |
| I-02 | Assignment: manual, round-robin, capacity-based | v1 | shipped | Manual assignment shipped in M1; round-robin and capacity-based in v1.1 (D-12). **Shipped 2026-10-05:** Settings → Assignment: Manual (default) or Round robin with an optional cap on open chats per teammate. Runs on an AI handoff and on new chats while the AI is off; picks the online teammate (dashboard open) who has waited longest, skipping anyone at the cap; turns are kept in the workspace hub so simultaneous handoffs don't collide; a manual assignment or an invite always wins; an internal note says who got it. Nobody online/eligible → stays Unassigned | 03 |
| I-03 | Typing indicators, read receipts, agent presence | v1 | shipped | Shipped M1: typing both ways, read receipts ("Seen"), agent presence avatars | 03 |
| I-04 | Agent takeover / barge-in on an AI conversation | v1 | shipped | Shipped M2: agent reply takes over (internal note); "Take over" / "Hand back to AI" buttons | 03 |
| I-05 | Internal notes and @mentions | v1 | shipped | Shipped M7: Reply/Note switch in the composer; notes never reach the visitor or the AI and don't take over from the AI; @ suggests teammates; mentions get a live toast and a "Mentions me" filter (unread until opened) | |
| I-06 | Saved replies / macros | v1 | shipped | Shipped M7: team-shared, managed in Settings, inserted with "/" in the composer; `{first_name}` and `{agent_name}` placeholders. Macros that also change status/tags are not built | |
| I-07 | Tags and conversation attributes | v1 | shipped | Shipped M7: tags (added from the conversation header, inbox filter, rename/delete in Settings, never sent to visitors). Custom conversation attributes not built; contact attributes come from identity (V-05) | |
| I-08 | Contact sidebar: attributes, past conversations, page trail, debug context | v1 | shipped | Shipped M7: sidebar shows the customer (verified details + attributes, or what an agent noted), other conversations (linked), AI actions and browser details; agents can name/email anonymous visitors, not verified ones | |
| I-09 | Teams and routing rules | v2 | proposed | | |
| I-10 | Business hours and auto-replies | v1 | shipped | Shipped M7: weekly hours in a time zone (DST-safe), away message with {when}; one automatic away reply per closed period for chats with the team (not while an agent replied in the last 15 min); widget header says "We're away · back Monday at 09:00". The AI keeps answering 24/7 | |
| I-11 | SLA policies with breach alerts | v2 | proposed | DO alarms fit timers well | 03 |
| I-12 | Copilot: draft reply, summarise, translate, rephrase | v2 | proposed | Table stakes in 2026, but v1 is about the autonomous agent | 01 |
| I-13 | Keyboard-first UI and command palette | v1.1 | agreed | Pushed to v1.1 to make room for pillar slices (D-12) | |
| I-14 | Desktop and mobile push notifications for agents | v1 | shipped | Pushed to v1.1 (D-12), then shipped before launch, so v1 (D-29). **Shipped 2026-10-06:** Settings → Notifications per teammate: turn on per device, four toggles (chat needs a person, assigned to you, customer replied in your chat, @mention; all on by default), test notification, device list. Unassigned handoffs (and new chats while the AI is off) go to everyone who opted in; round-robin chats only to the assignee; never to whoever caused it. A desk tab you're not looking at shows a system notification; otherwise Web Push (VAPID + aes128gcm with WebCrypto, no dependencies; the key lives in the workspace hub's Durable Object storage). Nothing is pushed while you have the desk focused. iPhone/iPad need the desk added to the Home Screen | |
| I-15 | Agent mobile app | later | proposed | | |
| I-16 | Tickets: async work items, conversation → ticket | v2 | proposed | Separate entity or type flag? See D-05 | 03 |
| I-17 | Automations / workflow rules (if X then assign/tag/close) | v2 | proposed | | |

## C — Channels

| ID | Feature | Ver | Status | Why / notes | Ref |
|---|---|---|---|---|---|
| C-01 | Web widget | v1 | shipped | Shipped in M1 (2026-10-04) | |
| C-02 | Email (inbound forwarding and outbound replies) | v2 | proposed | Second most important channel | 01 |
| C-03 | Slack Connect / shared channels | v1.1 | agreed | Uses the deploying company's own Slack app, installed only in its own workspace. Customers talk to us in shared Slack Connect channels; each thread = conversation; AI answers in-thread or hands off. B2B core channel (Pylon/Plain). D-13 Moved to v1.1 2026-10-04 (Slack is secondary). | 01 |
| C-09 | Team replies from Slack: only chats handed off to a human appear, as a thread whose first message is the handoff brief, debug context and transcript link; replies sync back to the visitor. Setting: "post all new chats" for small teams | v1.1 | agreed | Shares the Slack app + thread-sync layer with C-03. D-13 Deferred to the backlog by the user (2026-10-05, D-28): not needed for their own desk now. |  |
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
| P-01 | Signal-triggered AI openers (struggle, page, segment) | v1 | shipped | Partly shipped with S-06 (error-triggered nudge). **Shipped 2026-10-06 (page triggers):** owners/admins set up to 10 rules in Settings → Install (inbox settings JSON, no migration): a path pattern (`/pricing`, `/docs/*` = /docs and below, `*/billing`, `*`; `*` matches anything, path only, validated server-side), 5–600 s of *visible* time on that page (S-13's ticker; hidden tabs don't count, SPA navigation restarts it), and fixed text (≤ 140) or "Let the AI write it" (one friendly line from page title/path + optional hint ≤ 200, same cache/usage/fallback as S-11, filtered for technical or alarming words). The widget config gives the loader only id + regex + delay; the loader matches, then asks the nudge route, which re-checks rule, path, proactive toggle and allowed websites. One card per page load shared with the nudges (no opener after an error nudge, a card, or once the chat was opened); nothing before consent; works with `data-capture="off"` (sends only the page URL and title, like the live visitor list). Loader +74 B gzipped. Not built: "first-time visitors only" (loader bytes) and segment triggers (v2) | 02 |
| P-02 | Public API / webhook to start an AI conversation from the customer's backend (e.g. payment failed) | v2 | proposed | Fin Proactive Procedures equivalent | 02 |
| P-03 | Basic targeted messages (page/URL rules) | v1 | shipped | Simple version before P-01. **Shipped 2026-10-06 as P-01's page openers** (path rules, visible-time delay, fixed or AI-written line); v1 per D-29 | 02 |
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
| A-01 | Core metrics: conversations, AI resolution rate, handoff rate, first-response time, CSAT | v1 | shipped | Shipped M7: **Reports** page for the last 7, 30 or 90 calendar days in the viewer's time zone, for conversations *started* in the period. **AI conversations** = the AI posted a public answer, or the conversation was handed off from the AI (a handoff only happens from AI handling, so a visitor asking for a person before the AI answered counts). **AI resolved** = an AI conversation with no handoff and no public agent reply; **handoff rate** = handed off / AI conversations, with the top 5 reasons (`meta.handoffReason` on the public handoff notice, details like error text grouped). **First response** = first visitor message to the first public agent reply after it (median and p90; notes and system messages never count); the AI's median first answer separately. **Resolved** = currently resolved (no time to resolve: there's no resolved-at timestamp yet). **CSAT** = 👍 / (👍 + 👎) over ratings given in the period, plus the 5 newest 👎 comments linking to the conversation. **Per teammate**: public replies sent in the period, conversations replied in, median first response where they replied first. Reads at most 20,000 conversations and says so. **AI off**: a chat that reaches the AI while AI replies are off ("AI replies are turned off.") went to the team, so it's never an AI conversation, handoff or reason (counted as "reached the AI while it was off"); if the AI answered before that, it stays an AI conversation, neither resolved nor handed off. When AI replies are off now and no conversation in the period was the AI's, a calm "AI assistant: Off" card linking to Settings → AI assistant replaces "AI resolved" / "Handed off", and the handoff reasons and the chart's AI split are hidden. Basic dashboard only in v1 | 01 |
| A-02 | Topic clustering of conversations | v2 | shipped | Table stakes. Shipped 2026-10-05: labels, not vector clustering. Each conversation gets one short AI topic (1–3 words, Title Case), reusing the workspace's existing topics when one fits; new ones only while there are fewer than 40. Batched off the hot path (25 per model call, `completeText`): a 15-minute cron, lazily when Reports opens (at most every 5 minutes per workspace) and Settings → Topics → "Label now". Eligible: a visitor message, resolved or no new message for 10 minutes, started in the last 90 days. The prompt gets the first three visitor messages, up to two replies (public only, never notes) and the start page's path. Skipped while AI replies are off or the monthly cap is reached; tokens count toward usage, not the reply cap. Relabelled only if the visitor wrote more after labelling and had fewer than three messages then. Reports: "Top topics" (count, share of labelled chats, AI resolution rate per topic), each opening the inbox filtered by it. Inbox: topic filter, topic on rows and the header. Admins rename, merge and delete topics (deleted topics' chats get labelled again). Agents only: visitors never see topics | 01 |
| A-03 | AI quality: per-answer feedback, low-confidence review queue | v2 | proposed | | 03 |
| A-04 | Agent performance and SLA reports | v2 | proposed | | |
| A-05 | Export / data warehouse sync | later | proposed | | |
| A-06 | Pages where chats start: on Reports, the pages visitors most often open a chat from | v1 | shipped | Shipped M8: a Reports card with the top 8 pages for conversations started in the period, count and share of those with a known page. The page is the one in the conversation's first debug snapshot (the loader sends it with the visitor's first message, even with `data-capture="off"`), so no new tracking and no migration. Grouped as origin + path: no query or hash, no trailing slash, id-like segments (numbers, UUIDs, long hex, `cus_…`-style ids, long letter+digit tokens) as `:id`; paths only when every page is on one site. Chats without a page (widget opened outside a site) are counted separately. No inbox filter yet. Shows where docs or product confuse people. Uses the page already stored with each conversation, so no new tracking. Site-wide traffic analytics (visitor counts, top pages) stays out: Plausible/PostHog do it, it costs a D1 write per page view, and today only chatting visitors' browsing is stored | 02 |

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
| T-02 | Built-in auth with **passkeys** (WebAuthn): owner created on first visit with SETUP_TOKEN; invites; recovery via SETUP_TOKEN. Magic link / Google / SSO optional later | v1 | shipped | D-17. Built 2026-10-04 (M0); e2e-tested with a software authenticator and verified with a real device on the live deployment. Shipped: in use on the live desk since M0 | 04 |
| T-03 | Public REST API + webhooks | v2 | proposed | Webhooks for conversation events in v1 if cheap | |
| T-04 | Audit log | v2 | proposed | | 03 |
| T-05 | GDPR: data export, deletion, retention settings, EU data residency | v2 | proposed | Export/delete basics in v1 | 02 |
| T-06 | Integrations: HubSpot/Salesforce CRM, Stripe (subscription lookups) | v3 | proposed | Refocused for B2B (D-01); Shopify dropped | |
| T-07 | Open-source, self-hostable on the user's own Cloudflare account. Server/dashboard AGPL-3.0; widget, SDKs, config format MIT; CLA for contributors | v1 | building | AGPL LICENSE + CONTRIBUTING added (M0). CLA bot and text not set up yet (D-14). Remaining work is on the M8 launch checklist (docs/build-plan.md): public repo, CLA bot, Deploy button test | 04 |
| T-09 | "Deploy to Cloudflare" button: provisions D1, DOs, Vectorize, R2, Workers AI; prompts for secrets | v1 | building | Config + button in README. `npm run deploy` deploys and migrates (verified live). The button itself can't be tested while the repo is private: it needs a public GitHub/GitLab repo. Our setup matches its model: secrets from `.dev.vars.example`, `cloudflare.bindings` descriptions in package.json, `npm run deploy` as the deploy command, migrations by binding name. Remaining work is on the M8 launch checklist (docs/build-plan.md): public repo, CLA bot, Deploy button test | 04 |
| T-10 | LLM provider choice: Claude (BYO key) recommended, Workers AI zero-key fallback | v1 | shipped | Shipped M2: Workers AI (zero-key default, Mistral Small 3.1 since M5), OpenAI API key (OPENAI_API_KEY secret, AI Gateway via OPENAI_BASE_URL), ChatGPT sign-in dev-only. M5: all providers through the AI SDK | 04 |
| T-11 | First-run setup wizard: create admin, connect LLM, crawl site, copy widget snippet | v1 | shipped | Shipped M8: setup lands on "Get started" (/welcome): account, docs (crawl from the page), AI on, brand colour, install (ticks itself off the first time the loader runs on a non-desk origin), invite link. Steps come from real state; "Get started n/6" in the top bar until done or hidden | 04 |
| T-13 | Slack app manifest + guided setup: self-hoster creates their own Slack app in a few clicks from a bundled manifest | v1.1 | agreed | Each self-hosted install needs its own Slack app; this keeps one-click feel. D-13 Deferred to the backlog by the user (2026-10-05, D-28): not needed for their own desk now. | 04 |
| T-15 | Sign in with ChatGPT as a **dev-only** LLM provider + `jun` CLI (`login`, `ask`, `chat`, `models`); release builds use an API key | v1 | agreed | D-10. Built 2026-10-04 in `packages/llm`, `packages/cli`. Must never ship enabled for visitor traffic | 06 |
| T-12 | Upgrade path: update from upstream + automatic D1 migrations | v1 | shipped | Shipped M8: `npm run deploy` migrates before deploying on upgrades. Verified with `scripts/upgrade-check.ts`: an M2 install (migrations 0001–0003) with an owner, AI guidance, knowledge and a visitor conversation, upgraded to M8 (0004–0006 applied): access, history, the visitor's old token, knowledge, AGENTS.md from the old guidance, AI turn and new features all work. The live desk went M2→M7 the same way | 04 |
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
