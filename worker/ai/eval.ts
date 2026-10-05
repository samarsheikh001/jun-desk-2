import type { Message } from "../../shared/protocol.ts";
import { describeEvents, type DebugContext } from "../../shared/debug.ts";
import { loadMessages } from "../lib/conversations.ts";
import { asksForHuman, resolveCitations } from "./agent.ts";
import type { AgentConfig, EvalCase, EvalOutcome } from "./config.ts";
import { completeText, type AgentModel } from "./providers.ts";
import { runAgent, type RunResult } from "./run.ts";

// `jun eval` (AI-19): before a config change goes live, run it against
//  1. the config's own test cases (evals/*.yaml): pass/fail, and
//  2. recent real conversations, replayed with the live config and the candidate:
//     which answers would change.
// Results stream back as NDJSON events so the CLI can print as it goes.

export const DEFAULT_REPLAY_SAMPLE = 20;
export const MAX_REPLAY_SAMPLE = 50;
const CONCURRENCY = 4;

export interface ReplyView {
  outcome: EvalOutcome;
  reply: string;
  tools: string[];
}

export type EvalEvent =
  | { type: "start"; liveVersion: number | null; cases: number; conversations: number }
  | { type: "case"; file: string; name: string; pass: boolean; failures: string[]; result: ReplyView }
  | { type: "replay"; conversationId: string; question: string; verdict: "same" | "changed"; why: string; live: ReplyView; candidate: ReplyView }
  | { type: "error"; scope: string; message: string }
  | { type: "done"; cases: { passed: number; failed: number }; replay: { same: number; changed: number; errors: number } };

export interface EvalContext {
  env: Env;
  workspaceId: string;
  workspaceName: string;
  /** Writes the replies (job `answer`, as live chats). */
  model: AgentModel;
  /** Grades them (job `judge`). */
  judgeModel: AgentModel;
  live: AgentConfig;
  candidate: AgentConfig;
  sample: number;
  mockTools: boolean;
}

function view(result: RunResult): ReplyView {
  const outcome: EvalOutcome = result.outcome.kind === "handoff" ? "handoff" : result.outcome.escalate ? "escalate" : "answer";
  const reply =
    result.outcome.kind === "handoff"
      ? `(hands off: ${result.outcome.reason})`
      : resolveCitations(result.outcome.text, result.hits).text + (result.outcome.escalate ? `\n(escalates: ${result.outcome.escalate})` : "");
  return { outcome, reply, tools: result.actions.map((a) => a.tool) };
}

function message(seq: number, body: string, authorType: Message["authorType"] = "visitor"): Message {
  return { id: `eval_${seq}`, seq, authorType, authorId: null, authorName: null, body, attachments: [], clientMsgId: `eval:${seq}`, createdAt: Date.now(), internal: false, meta: {} };
}

/** One reply, with the same shortcut the live desk takes when the customer asks for a person. */
function answer(ctx: EvalContext, config: AgentConfig, history: Message[], technical: string[] = []): Promise<RunResult> {
  if (asksForHuman(history.at(-1)?.body ?? "")) {
    return Promise.resolve({
      raw: "",
      outcome: { kind: "handoff", reason: "The customer asked for a person." },
      hits: [],
      actions: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  }
  return runAgent({ env: ctx.env, workspaceId: ctx.workspaceId, workspaceName: ctx.workspaceName, model: ctx.model, config, history, technical, mockTools: ctx.mockTools, temperature: 0 });
}

/** Runs several turns of a test case; replies come from the config under test. */
async function runCase(ctx: EvalContext, c: EvalCase): Promise<RunResult> {
  const history: Message[] = [];
  let result: RunResult | null = null;
  for (const [i, body] of c.messages.entries()) {
    history.push(message(i * 2 + 1, body));
    result = await answer(ctx, ctx.candidate, history);
    if (result.outcome.kind === "handoff") break;
    history.push(message(i * 2 + 2, result.outcome.text, "ai"));
  }
  return result!;
}

async function judge(ctx: EvalContext, prompt: string): Promise<{ yes: boolean; why: string }> {
  const { text } = await completeText({
    model: ctx.judgeModel.model,
    ...ctx.judgeModel.prompt("You grade customer support replies. Be strict and literal. Answer with one word on the first line (YES or NO), then one short sentence explaining why."),
    messages: [{ role: "user", content: prompt }],
    maxOutputTokens: 800,
    temperature: 0,
  });
  const [first = "", ...rest] = text.trim().split("\n");
  return { yes: /^\W*yes\b/i.test(first), why: (rest.join(" ").trim() || first.replace(/^\W*(yes|no)\W*/i, "")).slice(0, 300) };
}

async function checkCase(ctx: EvalContext, c: EvalCase): Promise<EvalEvent> {
  const result = view(await runCase(ctx, c));
  const failures: string[] = [];
  if (c.expect.outcome && result.outcome !== c.expect.outcome) failures.push(`expected outcome ${c.expect.outcome}, got ${result.outcome}`);
  for (const t of c.expect.tools ?? []) if (!result.tools.includes(t)) failures.push(`expected a call to ${t}${result.tools.length ? ` (called: ${result.tools.join(", ")})` : " (no tools called)"}`);
  if (c.expect.criteria) {
    const verdict = await judge(ctx, `Customer:\n${c.messages.join("\n")}\n\nSupport reply:\n${result.reply}\n\nDoes the reply meet this requirement: "${c.expect.criteria}"?`);
    if (!verdict.yes) failures.push(`criteria not met: ${c.expect.criteria} (${verdict.why})`);
  }
  return { type: "case", file: c.file, name: c.name, pass: failures.length === 0, failures, result };
}

interface ReplayTurn {
  conversationId: string;
  history: Message[];
  technical: string[];
}

/** The first customer message of recent conversations the AI handled. */
async function replayTurns(ctx: EvalContext): Promise<ReplayTurn[]> {
  const rows = await ctx.env.DB.prepare(
    `SELECT c.id FROM conversations c
     WHERE c.workspace_id = ? AND EXISTS (
       SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.internal = 0
         AND (m.author_type = 'ai' OR (m.author_type = 'system' AND m.meta LIKE '%handoffReason%')))
     ORDER BY c.last_message_at DESC LIMIT ?`,
  )
    .bind(ctx.workspaceId, ctx.sample)
    .all<{ id: string }>();
  const turns: ReplayTurn[] = [];
  for (const { id } of rows.results) {
    const messages = await loadMessages(ctx.env.DB, id, { includeInternal: false, limit: 40 });
    const first = messages.findIndex((m) => m.authorType === "visitor" && m.body.trim());
    if (first === -1) continue;
    const seq = messages[first]!.seq;
    const snapshot = await ctx.env.DB.prepare("SELECT context FROM debug_snapshots WHERE conversation_id = ? AND message_seq <= ? ORDER BY message_seq DESC LIMIT 1")
      .bind(id, seq)
      .first<{ context: string }>();
    let technical: string[] = [];
    if (snapshot) {
      const context = JSON.parse(snapshot.context) as DebugContext;
      technical = [`Page: ${context.page.url}`, ...describeEvents(context).slice(-25)];
    }
    turns.push({ conversationId: id, history: messages.slice(0, first + 1), technical });
  }
  return turns;
}

async function replay(ctx: EvalContext, turn: ReplayTurn): Promise<EvalEvent> {
  const run = (config: AgentConfig) => answer(ctx, config, turn.history, turn.technical);
  const [liveRun, candidateRun] = await Promise.all([run(ctx.live), run(ctx.candidate)]);
  const live = view(liveRun);
  const candidate = view(candidateRun);
  const question = turn.history.at(-1)!.body;
  if (live.outcome !== candidate.outcome) {
    return { type: "replay", conversationId: turn.conversationId, question, verdict: "changed", why: `${live.outcome} → ${candidate.outcome}`, live, candidate };
  }
  if (live.outcome === "handoff") {
    return { type: "replay", conversationId: turn.conversationId, question, verdict: "same", why: "hands off either way", live, candidate };
  }
  // Same kind of outcome: ask whether the substance differs (wording always does).
  const verdict = await judge(
    ctx,
    `Customer: ${question}\n\nReply A:\n${live.reply}\n\nReply B:\n${candidate.reply}\n\nDo A and B tell the customer the same thing in substance: the same facts, the same decision, the same next step? Ignore wording, tone and length.`,
  );
  return { type: "replay", conversationId: turn.conversationId, question, verdict: verdict.yes ? "same" : "changed", why: verdict.why, live, candidate };
}

/** Runs at most `limit` tasks at a time, emitting each result as soon as it's ready. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(workers);
}

export async function runEval(ctx: EvalContext, emit: (event: EvalEvent) => void, options: { cases: boolean; replay: boolean }): Promise<void> {
  const cases = options.cases ? ctx.candidate.evals : [];
  const turns = options.replay ? await replayTurns(ctx) : [];
  emit({ type: "start", liveVersion: ctx.live.version, cases: cases.length, conversations: turns.length });
  const summary = { cases: { passed: 0, failed: 0 }, replay: { same: 0, changed: 0, errors: 0 } };

  await pool(cases, CONCURRENCY, async (c) => {
    try {
      const event = await checkCase(ctx, c);
      if (event.type === "case") summary.cases[event.pass ? "passed" : "failed"]++;
      emit(event);
    } catch (error) {
      summary.cases.failed++;
      emit({ type: "error", scope: `${c.file}: ${c.name}`, message: (error as Error).message });
    }
  });
  await pool(turns, CONCURRENCY, async (turn) => {
    try {
      const event = await replay(ctx, turn);
      if (event.type === "replay") summary.replay[event.verdict]++;
      emit(event);
    } catch (error) {
      summary.replay.errors++;
      emit({ type: "error", scope: `conversation ${turn.conversationId}`, message: (error as Error).message });
    }
  });
  emit({ type: "done", ...summary });
}
