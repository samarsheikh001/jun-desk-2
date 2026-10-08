import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { ACTION_ONLY_BODY, actionStatusText, visibleResult, type MessageAction } from "../../shared/actions.ts";
import type { AiStep, Source } from "../../shared/protocol.ts";
import type { AiAnswerView } from "../components/MessageList.tsx";
import { ActionCard } from "./action.tsx";

// An AI answer in the widget: words resolve out of a blur as they stream, citations become
// inline source chips, then copy, the cited sources and follow-up questions appear.

/** One reveal step; the step grows with the backlog so a fast stream never falls far behind. */
const TICK_MS = 45;

type Token = { kind: "word"; text: string } | { kind: "code"; text: string; space: string } | { kind: "cite"; n: number; space: string };

// A word, `code`, or [n] citation, each with the whitespace after it (or whitespace alone).
const TOKEN = /(?:\[(\d{1,2})\]|`([^`\n]+)`|[^\s[`]+|[[`]|(?=\s))(\s*)/g;

function tokenize(body: string): Token[] {
  const tokens: Token[] = [];
  for (const m of body.matchAll(TOKEN)) {
    const space = m[3] ?? "";
    if (m[1]) tokens.push({ kind: "cite", n: Number(m[1]), space });
    else if (m[2]) tokens.push({ kind: "code", text: m[2], space });
    else tokens.push({ kind: "word", text: m[0] });
  }
  return tokens;
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How many tokens to show: all at once for history, paced for a reply that's being written. */
function useReveal(total: number, live: boolean): number {
  const [shown, setShown] = useState(() => (live && !reducedMotion() ? 0 : total));
  useEffect(() => {
    if (shown >= total) return;
    const t = setTimeout(() => setShown((s) => Math.min(total, s + Math.max(1, Math.ceil((total - s) / 10)))), TICK_MS);
    return () => clearTimeout(t);
  }, [shown, total]);
  return Math.min(shown, total);
}

function host(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Where a source lives: its site's domain, or its title for snippets and files. */
function sourceLabel(source: Source): string {
  return (source.url && host(source.url)) || (source.title.length > 28 ? `${source.title.slice(0, 27)}…` : source.title);
}

/** The site's favicon; a lettered tile for snippets, files and sites without one. */
function SourceIcon({ source, className }: { source: Source; className: string }) {
  const [failed, setFailed] = useState(false);
  const site = source.url ? host(source.url) : null;
  if (site && !failed) {
    return <img src={`${new URL(source.url!).origin}/favicon.ico`} alt="" className={className} onError={() => setFailed(true)} />;
  }
  const name = site ?? source.title;
  let hue = 0;
  for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className={`${className} w-src-letter`} style={{ background: `hsl(${hue} 55% 46%)` }} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function SourceChip({ source }: { source: Source }) {
  const inner = (
    <>
      <SourceIcon source={source} className="w-cite-icon" />
      <span>{sourceLabel(source)}</span>
    </>
  );
  return source.url ? (
    <a className="w-cite" href={source.url} target="_blank" rel="noreferrer" title={source.title}>{inner}</a>
  ) : (
    <span className="w-cite" title={source.title}>{inner}</span>
  );
}

const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="w-answer-btn"
      aria-label={copied ? "Copied" : "Copy answer"}
      title={copied ? "Copied" : "Copy"}
      onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined)}
    >
      {copied ? (
        <Icon><path d="M20 6 9 17l-5-5" /></Icon>
      ) : (
        <Icon><rect x="9" y="9" width="12" height="12" rx="2.5" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Icon>
      )}
    </button>
  );
}

/**
 * One line in the steps list. YAML tools give a label and a state; a page action (AI-21) adds
 * what it returned, an error, or Undo.
 */
interface StepLine extends AiStep {
  detail?: string;
  error?: string;
  undo?: { run: () => void; busy: boolean; error?: string };
}

/**
 * The AI's tool steps above its answer: open with a shimmering label while it works, then one
 * quiet line the visitor can open. Labels are the admin's `status:` text, or a page action's
 * description, nothing else.
 */
function Steps({ steps, working }: { steps: StepLine[]; working: boolean }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const expanded = manual ?? working;
  const running = [...steps].reverse().find((s) => s.state === "running");
  const label = working ? (running?.label ?? "Working on it") : steps.length === 1 ? steps[0]!.label : `Used ${steps.length} steps`;
  // A page action's outcome stays on the folded line: what came of it, its error, and Undo.
  const last = steps.at(-1);
  const outcome = !working && last && (last.detail || last.error || last.undo) ? last : null;
  return (
    <div className={`w-steps${working ? " working" : ""}`}>
      <div className="w-steps-row">
      <button type="button" className="w-steps-head" aria-expanded={expanded} onClick={() => setManual(!expanded)}>
        <svg className="w-steps-spark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
        </svg>
        <span role="status" className="w-steps-label">
          <span key={working ? "working" : "done"} className={working ? "w-steps-shimmer" : "w-steps-done"}>{label}</span>
        </span>
        <svg className="w-steps-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {outcome && !expanded && (
        <>
          {(outcome.detail || outcome.error) && <span className={`w-step-detail${outcome.error ? " error" : ""}`}>{outcome.error ?? outcome.detail}</span>}
          {outcome.undo && <button type="button" className="w-step-undo" disabled={outcome.undo.busy} onClick={outcome.undo.run}>{outcome.undo.busy ? "Undoing…" : "Undo"}</button>}
          {outcome.undo?.error && <span className="w-step-detail error">{outcome.undo.error}</span>}
        </>
      )}
      </div>
      <div className={`w-steps-panel${expanded ? " open" : ""}`} inert={!expanded}>
        <div>
          <ol className="w-steps-list">
            {steps.map((s) => (
              <li key={s.id} className={`w-step${s.error ? " error" : ""}`}>
                {s.state === "running" ? (
                  <span className="w-step-spin" role="img" aria-label="In progress" />
                ) : s.error ? (
                  <span className="w-step-dot" role="img" aria-label="Failed" />
                ) : (
                  <svg className="w-step-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Done">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
                <span className="w-step-label">{s.label}</span>
                {(s.detail || s.error) && <span className="w-step-detail">{s.error ?? s.detail}</span>}
                {s.undo && (
                  <button type="button" className="w-step-undo" disabled={s.undo.busy} onClick={s.undo.run}>{s.undo.busy ? "Undoing…" : "Undo"}</button>
                )}
                {s.undo?.error && <span className="w-step-detail error">{s.undo.error}</span>}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

/** AI-21: how the chat drives the page action an answer proposed. */
export interface ActionControls {
  /** The action is running on the page right now (after Confirm, or at once when `auto`). */
  running: boolean;
  onInput: (input: Record<string, unknown>) => void;
  onRun: (input: Record<string, unknown>) => void;
  onCancel: () => void;
  onUndo: () => void;
  undoError?: string;
}

export function AiAnswer({ answer, onFollowUp, controls }: { answer: AiAnswerView; onFollowUp?: (question: string) => void; controls?: ActionControls }) {
  const { sources, followUps, streaming, latest, steps: toolSteps } = answer;
  const action = answer.action;
  // An action-only reply has a placeholder body for the inbox; here the step line or the card says it.
  const body = action && answer.body === ACTION_ONLY_BODY ? "" : answer.body;
  // AI-21: a page action is a step line like a YAML tool once it runs; the card only while it waits on the visitor.
  const [undoing, setUndoing] = useState(false);
  useEffect(() => {
    if (action?.status !== "ok" || controls?.undoError) setUndoing(false);
  }, [action?.status, controls?.undoError]);
  const actionRunning = Boolean(action && action.status === "pending" && controls?.running);
  const actionStep: StepLine | null = action && (actionRunning || action.status !== "pending") ? actionLine(action, actionRunning, controls, undoing, () => { setUndoing(true); controls?.onUndo(); }) : null;
  const steps: StepLine[] = actionStep ? [...toolSteps, actionStep] : toolSteps;
  const waiting = Boolean(action && action.status === "pending" && !actionRunning && controls);
  // Open while tools run before (or between) the words; folded once the answer is being written.
  const working = (streaming && (!body || steps.some((s) => s.state === "running"))) || actionRunning;
  const tokens = useMemo(() => tokenize(body), [body]);
  // Animate a reply that started streaming here; history shows as it is.
  const [live] = useState(streaming);
  const shown = useReveal(tokens.length, live);
  const done = !streaming && shown >= tokens.length;
  const [open, setOpen] = useState(false);

  // Distinct sites for the avatar stack.
  const stack = sources.filter((s, i) => sources.findIndex((o) => sourceLabel(o) === sourceLabel(s)) === i).slice(0, 3);
  const plain = body.replace(/\s*\[\d{1,2}\]/g, "");

  return (
    <div className="w-answer">
      {steps.length > 0 && <Steps steps={steps} working={working} />}
      {(body || (!steps.length && !action)) && <div className="bubble">
        {tokens.slice(0, shown).map((t, i) => {
          const anim = live ? " w-anim" : "";
          if (t.kind === "word") return <span key={i} className={`w-word${anim}`}>{t.text}</span>;
          if (t.kind === "code") return <span key={i} className={`w-word${anim}`}><code>{t.text}</code>{t.space}</span>;
          const source = sources[t.n - 1];
          return (
            <Fragment key={i}>
              {source && <span className={`w-cite-wrap${anim}`}><SourceChip source={source} /></span>}
              {t.space}
            </Fragment>
          );
        })}
        {!done && <span className="w-caret" aria-hidden="true" />}
      </div>}

      {done && sources.length > 0 && (
        <>
          <div className={`w-answer-row${live ? " w-anim-in" : ""}`}>
            <CopyButton text={plain} />
            <button type="button" className="w-src-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <span className="w-src-stack">
                {stack.map((s) => <SourceIcon key={sourceLabel(s)} source={s} className="w-src-avatar" />)}
              </span>
              <span>{sources.length === 1 ? "1 source" : `${sources.length} sources`}</span>
            </button>
          </div>
          <div className={`w-src-panel${open ? " open" : ""}`} inert={!open}>
            <div>
              <div className="w-src-list">
                {sources.map((s, i) => {
                  const row = (
                    <>
                      <SourceIcon source={s} className="w-src-icon" />
                      <span className="w-src-name">{s.title}</span>
                      {s.url && <span className="w-src-domain">{host(s.url)}</span>}
                    </>
                  );
                  return s.url ? (
                    <a key={i} className="w-src-row" href={s.url} target="_blank" rel="noreferrer">{row}</a>
                  ) : (
                    <div key={i} className="w-src-row">{row}</div>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}

      {waiting && action && controls && (
        <ActionCard action={action} latest={latest} createdAt={answer.createdAt ?? 0} onInput={controls.onInput} onRun={controls.onRun} onCancel={controls.onCancel} />
      )}

      {done && latest && onFollowUp && followUps.length > 0 && (
        <div className="w-follow" role="group" aria-label="Follow-up questions">
          <p className="w-follow-head">Follow-ups</p>
          {followUps.map((q, i) => (
            <button key={q} type="button" className="w-follow-item" style={{ animationDelay: `${i * 90}ms` }} onClick={() => onFollowUp(q)}>
              <Icon><path d="M9 10l-5 5 5 5" /><path d="M20 4v7a4 4 0 0 1-4 4H4" /></Icon>
              <span>{q}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The step line for a page action: its description, then what came of it. */
function actionLine(action: MessageAction, running: boolean, controls: ActionControls | undefined, undoing: boolean, undo: () => void): StepLine {
  const line: StepLine = { id: action.runId, label: action.description, state: running ? "running" : "done" };
  if (action.status === "error") line.error = action.result ?? "Didn't work";
  else if (action.status === "ok") {
    const detail = visibleResult(action.result);
    if (detail) line.detail = detail;
    if (action.canUndo && controls) line.undo = { run: undo, busy: undoing, ...(controls.undoError ? { error: controls.undoError } : {}) };
  } else if (!running) line.detail = actionStatusText(action.status);
  return line;
}
