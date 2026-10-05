// Starter files for `jun init`. Keep AGENTS.md in sync with DEFAULT_AGENTS_MD in worker/ai/config.ts.

export const TEMPLATE: Record<string, string> = {
  "README.md": `# Support agent

This folder is your Jun Desk AI agent, as code. Edit it like any other code: in a branch, reviewed in a pull request.

| File | What it does |
|---|---|
| \`AGENTS.md\` | Persona, tone and rules. Frontmatter sets guardrails (\`maxReplies\`, \`handoffTopics\`). |
| \`skills/<name>/SKILL.md\` | Procedures in plain language ("refund requests: first…"). \`description\` says when one applies. |
| \`tools/<name>.yaml\` | HTTP lookups the AI may call (order status, plan, usage…). |
| \`evals/<name>.yaml\` | Test cases: a customer message and what a good reply does. |

\`\`\`sh
jun eval .        # run the test cases and replay recent real conversations against these files
jun push . -m "…" # make it live (the dashboard shows each version)
jun pull .        # bring dashboard edits back here
\`\`\`

To add a tool, copy \`tools/lookup_order.yaml.example\` to \`tools/lookup_order.yaml\`, point it at your API,
and set its secret on the Worker: \`npx wrangler secret put JUN_SECRET_ACME_API_KEY\`.
`,
  "AGENTS.md": `---
# Guardrails. Remove a line to use the default.
maxReplies: 8            # AI replies per conversation before a person takes over
handoffTopics:           # always hand these to a person
  - legal or security questions
---
# How to talk to customers

- Be friendly, concise and specific. A few short sentences or a short list.
- Use the customer's name if you know it.
- Don't promise refunds, credits, discounts or timelines unless a procedure says you can.
`,
  "skills/refund/SKILL.md": `---
name: refund
description: The customer asks for a refund, their money back, or to cancel a charge.
---
1. Ask for the order or invoice number if they haven't given it.
2. Explain that refunds are reviewed by the billing team within one business day.
3. Hand off to a person with the order number in the reason.
`,
  "tools/lookup_order.yaml.example": `# Rename to lookup_order.yaml to enable. The AI calls it when a customer asks about an order.
description: Look up an order by its number. Returns status, order date and total.
method: GET
url: https://api.example.com/orders/{orderNumber}
headers:
  Authorization: Bearer {secrets.ACME_API_KEY}   # Worker secret JUN_SECRET_ACME_API_KEY
input:
  orderNumber:
    type: string
    description: The order number, like A-1042
pick: [status, orderedOn, total]                 # only these fields reach the AI
mock: { status: delivered, orderedOn: "2026-09-02", total: "$49.00" }   # used by jun eval --mock-tools
`,
  "evals/basics.yaml": `- name: greeting
  message: hi there
  expect:
    outcome: answer

- name: refund goes to a person
  message: I want my money back for order A-1042
  expect:
    outcome: handoff

- name: asks for a human
  message: can I talk to a real person please
  expect:
    outcome: handoff
`,
};
