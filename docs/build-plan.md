# v1 build plan

*Drafted 2026-10-04. Orders the 56 `v1` features from `features.md` into milestones. Each milestone ends in something you can demo.*

**Principles**

1. **The deploy button works from day one.** One-click deploy is a hard constraint (D-02). We keep it green on every milestone instead of bolting it on at the end.
2. **Get a working conversation early, then add pillars.** The order is chat → AI → handoff → P1 → P3 → polish.
3. **P1 (support that sees the bug) comes before visitor tracking and inbox polish**, because it's the lead pillar (D-12).
4. **Slack stays late and small** (secondary channel; only C-09 is in v1).

**Size** is a rough relative guess (S / M / L), not an estimate. We'll size properly once the repo exists.

**🚀 = launch-critical.** If time runs short, unmarked items can slip to v1.1 without hurting the launch story.

---

## M0 — Foundation

*Demo: click "Deploy to Cloudflare" → an empty Jun Desk is live, and you can log in.*

| ID | Feature | Size | |
|---|---|---|---|
| T-09 | Deploy-to-Cloudflare button (D1, DOs, Vectorize, R2, Workers AI provisioned) | M | 🚀 |
| T-07 | Repo layout, licenses (AGPL server, MIT widget/SDK), CLA bot | S | 🚀 |
| T-01 | Workspaces, members, roles; multi-workspace schema from day one (D-09) | M | 🚀 |
| T-02 | Built-in auth: magic link + Google | M | 🚀 |
| T-12 | D1 migrations run automatically on deploy/upgrade | S | 🚀 |

**Decide before starting:**
- **D-11 data layer.** Recommendation: D1 is the source of truth for conversations and messages; each conversation's Durable Object holds live state (sockets, typing, the agent loop) and writes through to D1.
- **D-05 tickets.** Recommendation: one `conversation` table with a type flag.
- **Repo layout.** The deploy button needs a self-contained Workers app. Recommendation: the deployable Worker sits at the repo root; the widget and SDK are packages whose builds go into the Worker's static assets.

## M1 — Conversation loop (no AI yet)

*Demo: a visitor on a test site chats, and an agent replies from the inbox in real time.*

| ID | Feature | Size | |
|---|---|---|---|
| C-01 | Web widget channel | — | 🚀 |
| W-01 | Loader under 5 KB with a stand-in bubble | M | 🚀 |
| W-02 | Widget isolated in an iframe or shadow DOM | S | 🚀 |
| I-01 | Real-time inbox with status views | L | 🚀 |
| I-03 | Typing indicators, read receipts, agent presence | S | 🚀 |
| W-05 | History for returning visitors | S | 🚀 |
| W-06 | Attachments (R2) | S | 🚀 |
| I-02 | Manual assignment (round-robin and capacity → v1.1) | S | 🚀 |

## M2 — AI agent answers

*Demo: crawl a docs site, ask a question in the widget, and get a streamed answer with citations.*

| ID | Feature | Size | |
|---|---|---|---|
| T-10 | LLM provider: Claude BYO key, Workers AI fallback | S | 🚀 |
| K-01 | Website crawl with scheduled re-sync | M | 🚀 |
| K-03 | Manual Q&A snippets | S | 🚀 |
| K-02 | File upload (PDF, MD, TXT first; DOCX can slip) | S | |
| AI-01 | Answers grounded in the KB, with citations | M | 🚀 |
| AI-02 | "I don't know" when confidence is low | S | 🚀 |
| AI-07 | Persona and tone instructions | S | 🚀 |
| AI-08 | Prompt-injection and abuse guardrails | S | 🚀 |
| W-03 | Streaming with resumable streams | M | 🚀 |
| B-03 | LLM spend caps; degrades to "leave a message" | S | 🚀 |
| AI-16 | Model routing (Haiku triage → Sonnet answers); one model is fine at first | S | |

**Decide before starting:** **D-10 default LLM.** Recommendation: Claude Sonnet 5.5 with the user's own key, falling back to Workers AI.

## M3 — Handoff to humans

*Demo: the AI can't solve the problem and hands off. The agent gets a brief in the inbox and in Slack, and replies from either.*

| ID | Feature | Size | |
|---|---|---|---|
| W-07 | "Talk to a human" always visible | S | 🚀 |
| AI-03 | Escalation rules | S | 🚀 |
| AI-04 | Structured handoff brief | S | 🚀 |
| I-04 | Agent takeover / barge-in | S | 🚀 |
| C-09 | Team replies from Slack (handed-off chats only) | M | |
| T-13 | Slack app manifest + guided setup | S | |

## M4 — P1: support that sees the bug ⭐

*Demo: the test site throws a 500 on /api/billing. The visitor asks "why can't I pay?" The AI answers "your request to /api/billing failed at 14:02, I've flagged it", and the agent sees the debug panel.*

| ID | Feature | Size | |
|---|---|---|---|
| S-01 | Capture JS errors and failed requests in the widget SDK | M | 🚀 |
| S-07 | PII masking for captured data (ships with S-01) | M | 🚀 |
| V-02 | Page-view trail per session | S | 🚀 |
| S-03 | Debug panel on each conversation | M | 🚀 |
| S-05 | AI uses debug context to diagnose | M | 🚀 |

## M5 — P3: support agent as code ⭐

*Demo: edit `agent/procedures/refund.md` in git, run `jun eval`, and see which past answers change before deploying.*

| ID | Feature | Size | |
|---|---|---|---|
| AI-18 | Agent config as files in git; dashboard edits the same config | L | 🚀 |
| AI-05 | Custom tools via HTTP endpoints (defined in config) | M | 🚀 |
| AI-11 | Action audit log | S | 🚀 |
| AI-19 | Eval runner CLI: replay conversations, show answer diffs | M | 🚀 |

## M6 — Visitors and identity

*Demo: watch live visitors, see who's logged in (verified), and start a chat with one.*

| ID | Feature | Size | |
|---|---|---|---|
| V-03 | JWT identity verification | S | 🚀 |
| V-04 | Merge anonymous visitor into contact on identify | S | 🚀 |
| V-05 | Custom attributes from host app | S | 🚀 |
| V-06 | Consent-aware mode (no cookies before consent) | S | 🚀 |
| V-01 | Live visitor list | M | 🚀 |
| V-07 | Agent starts a chat with a live visitor | S | |

## M7 — Inbox and widget polish

*Demo: it feels like a real product a team can use every day.*

| ID | Feature | Size | |
|---|---|---|---|
| I-08 | Contact sidebar (attributes, history, trail, debug context) | M | 🚀 |
| W-04 | Widget branding | S | 🚀 |
| I-10 | Business hours and auto-replies | S | 🚀 |
| K-04 | KB source management | M | 🚀 |
| I-05 | Internal notes and @mentions | S | |
| I-06 | Saved replies | S | |
| I-07 | Tags and attributes | S | |
| W-08 | Offline mode (collect email) | S | |
| W-12 | CSAT rating | S | |
| A-01 | Core metrics dashboard | M | |

## M8 — Launch

*Demo: a stranger goes from the README to a working AI desk on their own site in under 10 minutes.*

| ID | Feature | Size | |
|---|---|---|---|
| T-11 | First-run setup wizard | M | 🚀 |
| T-12 | Upgrade path verified on a real older install | S | 🚀 |
| — | README, docs site, demo video, launch post (HN, GitHub) | M | 🚀 |

---

## Summary

- **56 v1 features: 45 launch-critical 🚀, 11 can slip to v1.1:** K-02, AI-16, C-09, T-13, V-07, I-05, I-06, I-07, W-08, W-12, A-01. T-12 appears in both M0 (migrations) and M8 (verified upgrade).
- **Critical path:** M0 → M1 → M2 → M3 → M4. After M2, M5 and M6 can run in parallel if there are two people.
- **Earliest "show someone" moment:** end of M4. That's when the lead pillar works end to end, so it's a good point to recruit design partners.

## Open before M0

- [ ] D-11 data layer (recommendation above)
- [ ] D-05 tickets model (recommendation above)
- [ ] Repo layout for the deploy button (recommendation above)
- [ ] Mark the remaining `proposed` v1 features as `agreed` (or cut) in `features.md`
