import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { ACTION_ONLY_BODY, actionChip, actionStatusText, actionSummary, actionTitle, visibleResult, type MessageAction } from "../../shared/actions.ts";
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
 * One row in the steps list. YAML tools give a label and a state; a page action (AI-21) adds a
 * chip (what came of it, or its inputs), detail lines for the expanded row, an error, or Undo.
 */
interface StepLine extends AiStep {
  chip?: string;
  lines?: string[];
  error?: string;
  undo?: { run: () => void; busy: boolean; error?: string };
}

const chevron = <path d="M6 9l6 6 6-6" />;

/**
 * One tool call: its state icon (a chevron instead on hover, when there's more to show), a short
 * title and a chip. Opening it shows what it did. An error opens it by itself.
 */
function StepRow({ step }: { step: StepLine }) {
  const more = Boolean(step.lines?.length || step.error || step.undo?.error);
  const [open, setOpen] = useState(Boolean(step.error));
  useEffect(() => {
    if (step.error) setOpen(true);
  }, [step.error]);
  const running = step.state === "running";
  return (
    <li className={`w-row${open ? " open" : ""}${step.error ? " error" : ""}`}>
      <div className="w-row-line">
        <button type="button" className="w-row-btn" aria-expanded={more ? open : undefined} disabled={!more} onClick={() => setOpen(!open)}>
          <span className="w-row-icon">
            {running ? (
              <span className="w-step-spin" role="img" aria-label="In progress" />
            ) : step.error ? (
              <span className="w-step-dot" role="img" aria-label="Failed" />
            ) : (
              <svg className="w-row-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Done">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            )}
            {more && !running && (
              <svg className="w-row-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{chevron}</svg>
            )}
          </span>
          <span className={`w-row-label${running ? " w-steps-shimmer" : ""}`}>{step.label}</span>
          {step.chip && <span className="w-row-chip">{step.chip}</span>}
        </button>
        {step.undo && (
          <button type="button" className="w-step-undo" disabled={step.undo.busy} onClick={step.undo.run}>{step.undo.busy ? "Undoing…" : "Undo"}</button>
        )}
      </div>
      {more && (
        <div className={`w-row-detail${open ? " open" : ""}`} inert={!open}>
          <div>
            <div className="w-row-lines">
              {step.lines?.map((line, i) => <span key={i}>{line}</span>)}
              {step.error && <span className="error">{step.error}</span>}
              {step.undo?.error && <span className="error">{step.undo.error}</span>}
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * The AI's tool calls (above its answer; a page action's under it), one row each. Several fold
 * under an "N steps" header, open until the visitor closes it. Nothing opens or folds by itself
 * while tools run, so the reply only ever grows. Labels are the admin's `status:` text, or a page
 * action's name; nothing else of a server tool reaches the visitor.
 */
function Steps({ steps, working }: { steps: StepLine[]; working: boolean }) {
  const [open, setOpen] = useState(true);
  const rows = (
    <ol className="w-rows">
      {steps.map((s) => <StepRow key={s.id} step={s} />)}
    </ol>
  );
  if (steps.length === 1) return <div className={`w-steps${working ? " working" : ""}`}>{rows}</div>;
  return (
    <div className={`w-steps${working ? " working" : ""}`}>
      <button type="button" className="w-steps-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg className="w-steps-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{chevron}</svg>
        <span className="w-steps-count">{steps.length} steps</span>
      </button>
      <div className={`w-steps-panel${open ? " open" : ""}`} inert={!open}>
        <div>{rows}</div>
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
  // Server tools ran before the words; a page action is called after them ("I'll set your pickup"),
  // so its step goes under the text.
  const after = Boolean(actionStep && body);
  const waiting = Boolean(action && action.status === "pending" && !actionRunning && controls);
  // Working (the label shimmers) while tools run before (or between) the words.
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
      {after ? toolSteps.length > 0 && <Steps steps={toolSteps} working={working && !actionRunning} /> : steps.length > 0 && <Steps steps={steps} working={working} />}
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
      {after && actionStep && <Steps steps={[actionStep]} working={actionRunning} />}

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

/** The step row for a page action: a short title, a chip, and what it did when opened. */
function actionLine(action: MessageAction, running: boolean, controls: ActionControls | undefined, undoing: boolean, undo: () => void): StepLine {
  const line: StepLine = { id: action.runId, label: actionTitle(action.name), state: running ? "running" : "done" };
  const chip = actionChip(action);
  if (chip) line.chip = chip;
  const lines = [action.description];
  const inputs = actionSummary({ description: "", input: action.input }).replace(/^ · /, "");
  if (inputs) lines.push(inputs);
  if (action.status === "error") line.error = action.result ?? "Didn't work";
  else if (action.status === "ok") {
    const result = visibleResult(action.result);
    if (result && result !== chip) lines.push(result);
    if (action.canUndo && controls) line.undo = { run: undo, busy: undoing, ...(controls.undoError ? { error: controls.undoError } : {}) };
  } else if (!running) lines.push(actionStatusText(action.status));
  line.lines = lines;
  return line;
}
