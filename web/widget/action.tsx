import { useEffect, useRef, useState, type ReactNode } from "react";
import { actionStatusText, actionSummary, checkInput, visibleResult, type ActionParam, type MessageAction } from "../../shared/actions.ts";

// AI-21: the card under an AI answer that proposed a page action (D-40). It asks for whatever the
// model left out (fields drawn from the action's params: a short list becomes buttons, a date a
// date picker, an email an email field), shows what will happen with a Confirm button, then the
// Done line with Undo. The action itself runs on the host page (widget-actions.js); this card only
// talks to it through WidgetApp. Statuses other than pending come from the server (meta.action).

/** An `auto` action proposed longer ago than this isn't run by itself (a reload, not a live reply). */
const AUTO_RUN_WITHIN_MS = 30_000;
/** Up to this many choices are buttons; more become a select. */
const CHIP_LIMIT = 6;

const label = (name: string) => name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

const Check = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
);

function Field({ name, param, value, onChange }: { name: string; param: ActionParam; value: unknown; onChange: (v: unknown) => void }) {
  const id = `act-${name}`;
  const text = `${label(name)}${param.description ? ` · ${param.description}` : ""}`;
  if (param.type === "boolean") {
    return (
      <div className="w-act-field" role="group" aria-label={text}>
        <span className="w-act-label">{text}</span>
        <div className="w-act-chips">
          {[true, false].map((v) => (
            <button key={String(v)} type="button" className={`w-act-chip${value === v ? " on" : ""}`} aria-pressed={value === v} onClick={() => onChange(v)}>{v ? "Yes" : "No"}</button>
          ))}
        </div>
      </div>
    );
  }
  if (param.enum && param.enum.length <= CHIP_LIMIT) {
    return (
      <div className="w-act-field" role="group" aria-label={text}>
        <span className="w-act-label">{text}</span>
        <div className="w-act-chips">
          {param.enum.map((v) => (
            <button key={String(v)} type="button" className={`w-act-chip${value === v ? " on" : ""}`} aria-pressed={value === v} onClick={() => onChange(v)}>{String(v)}</button>
          ))}
        </div>
      </div>
    );
  }
  if (param.enum) {
    return (
      <label className="w-act-field" htmlFor={id}>
        <span className="w-act-label">{text}</span>
        <select id={id} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(param.type === "string" ? e.target.value : Number(e.target.value))}>
          <option value="" disabled>Choose…</option>
          {param.enum.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
        </select>
      </label>
    );
  }
  const numeric = param.type === "number" || param.type === "integer";
  const type = numeric ? "number" : param.format === "email" ? "email" : param.format === "date" ? "date" : param.format === "url" ? "url" : "text";
  return (
    <label className="w-act-field" htmlFor={id}>
      <span className="w-act-label">{text}</span>
      <input
        id={id}
        type={type}
        value={value === undefined ? "" : String(value)}
        {...(numeric ? { min: param.minimum, max: param.maximum, step: param.type === "integer" ? 1 : "any", inputMode: "numeric" as const } : {})}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function ActionCard({
  action,
  latest,
  createdAt,
  onInput,
  onRun,
  onCancel,
  onUndo,
  undoError,
}: {
  action: MessageAction;
  /** The newest thing in the thread: only then does an `auto` action start by itself. */
  latest: boolean;
  createdAt: number;
  /** The visitor's answers for the missing params (the server checks them and updates the card). */
  onInput: (input: Record<string, unknown>) => void;
  /** Run it on the page with these inputs. */
  onRun: (input: Record<string, unknown>) => void;
  onCancel: () => void;
  onUndo: () => void;
  /** Undo failed on the page (local; the server never learns of it). */
  undoError?: string;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [running, setRunning] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const ran = useRef(false);
  const pending = action.status === "pending";
  const needs = pending && action.missing.length > 0;
  const ready = pending && !needs;

  const run = () => {
    if (ran.current) return;
    ran.current = true;
    setRunning(true);
    onRun(action.input);
  };
  // An action the owner marked safe runs as soon as the reply proposes it, once, and only live.
  const autoNow = ready && action.risk === "auto" && latest && Date.now() - createdAt < AUTO_RUN_WITHIN_MS;
  useEffect(() => {
    if (autoNow) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoNow]);
  useEffect(() => {
    if (!pending) setRunning(false);
    if (action.status !== "ok") setUndoing(false);
  }, [pending, action.status]);
  useEffect(() => {
    if (undoError) setUndoing(false);
  }, [undoError]);

  let body: ReactNode;
  if (needs) {
    const check = checkInput(action, { ...action.input, ...values });
    const filled = action.missing.every((k) => k in check.input);
    const errors = Object.entries(check.errors).filter(([k]) => k in values);
    body = (
      <form
        className="w-act-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (filled) onInput(check.input);
        }}
      >
        <p className="w-act-head">A couple of details first</p>
        {action.missing.map((k) => {
          const param = action.params[k];
          return param ? <Field key={k} name={k} param={param} value={values[k]} onChange={(v) => setValues((s) => ({ ...s, [k]: v }))} /> : null;
        })}
        {errors.length > 0 && <p className="w-act-error" role="alert">{errors.map(([k, e]) => `${label(k)} ${e}`).join(". ")}.</p>}
        <div className="w-act-row">
          <button type="submit" className="w-act-btn" disabled={!filled}>Continue</button>
          <button type="button" className="w-act-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    );
  } else if (pending && running) {
    body = (
      <div className="w-act-status" role="status">
        <span className="w-act-spin" aria-hidden="true" />
        <span>Working on it…</span>
      </div>
    );
  } else if (ready) {
    body = (
      <>
        <p className="w-act-summary">{actionSummary(action)}</p>
        <div className="w-act-row">
          <button type="button" className="w-act-btn" onClick={run}>{action.risk === "auto" ? "Run" : "Confirm"}</button>
          <button type="button" className="w-act-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </>
    );
  } else {
    const ok = action.status === "ok";
    body = (
      <>
        <div className={`w-act-status ${action.status}`} role="status">
          {ok ? <Check /> : <span className="w-act-dot" aria-hidden="true" />}
          <span className="w-act-state">{actionStatusText(action.status)}</span>
          {(ok || action.status === "error") && <span className="w-act-result">{visibleResult(action.result) ?? action.description}</span>}
        </div>
        {ok && action.canUndo && (
          <div className="w-act-row">
            <button
              type="button"
              className="w-act-ghost"
              disabled={undoing}
              onClick={() => {
                setUndoing(true);
                onUndo();
              }}
            >
              {undoing ? "Undoing…" : "Undo"}
            </button>
            {undoError && <span className="w-act-error">{undoError}</span>}
          </div>
        )}
      </>
    );
  }

  return (
    <div className={`w-act w-act-${action.status}`} data-run={action.runId}>
      {(needs || (pending && running)) && <p className="w-act-title">{action.description}</p>}
      {body}
    </div>
  );
}
