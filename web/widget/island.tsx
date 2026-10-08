import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Typewriter } from "./bar.tsx";

// W-04 "island" launcher (D-39): one small control at the bottom centre of the page that changes
// shape to fit each moment and always returns to a resting pill. Like the bar (bar.tsx) the frame
// is transparent and always shown; it tells the loader its size and the part of it that's drawn
// (`jun:css`), which the loader applies as the frame's inline style. Everything happens inside
// the frame: the page itself is never touched. Styles: `widget.css` (`html.island`).

const postToHost = (message: unknown) => window.parent !== window && window.parent.postMessage(message, "*");
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * rest: the pill. nudge: a one-line offer of help (P-01, V-07). open: the question box and the
 * suggested questions. thinking: one status line while the assistant works. answer: the latest
 * exchange with a follow-up box. panel: the whole conversation (a teammate's chat, or on request).
 */
export type IslandState = "rest" | "nudge" | "open" | "thinking" | "answer" | "panel";

/** Each state's width; phones cap every width at the frame minus 24px. */
const WIDTHS: Record<IslandState, number> = { rest: 360, nudge: 440, open: 660, thinking: 420, answer: 560, panel: 660 };
/** Room around the island kept visible for its shadow (which `.i-shell` keeps well inside it). */
const GLOW = 32;
/** The island's distance from the bottom of the viewport (matches `.i-root`'s padding). */
const edge = (width: number) => (width < 640 ? 12 : 24);
/** The frame's spring: a slight overshoot, about 0.65s (the proposal's stiffness 380 / damping 30). */
export const SPRING = "cubic-bezier(.34, 1.25, .5, 1)";

/**
 * Sizes the frame: a fixed transparent box at the bottom centre (up to 720×680), clipped to the
 * island's box plus its shadow so the rest of the frame doesn't take the page's clicks. The clip
 * animates with the same curve as the island, so the two stay together.
 */
function useIslandFrame(box: { w: number; h: number }, live: boolean): void {
  useLayoutEffect(() => {
    const motion = reducedMotion() ? "" : `transition:clip-path ${live ? ".25s ease-out" : `.65s ${SPRING}`};`;
    const bottom = edge(window.innerWidth);
    postToHost({
      type: "jun:css",
      css:
        "display:block;top:auto;bottom:0;left:0;right:0;margin:0 auto;width:min(720px,100%);height:min(680px,100%);" +
        `border:0;border-radius:0;background:none;box-shadow:none;color-scheme:normal;${motion}` +
        `clip-path:inset(calc(100% - ${box.h + bottom + GLOW}px) calc(50% - ${box.w / 2 + GLOW}px) ${Math.max(0, bottom - GLOW)}px)`,
    });
  }, [box.w, box.h, live]);
}

/**
 * The morphing container. New content is drawn off to the side at the state's width and measured;
 * the shell then springs to that exact size (measure, then move). A key per state swaps the content
 * with a short fade and un-blur.
 */
export function Island({ state, live, neon, onOpen, children }: { state: IslandState; live: boolean; neon: boolean; onOpen: () => void; children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  // "/" opens the resting island from inside the frame too (after Escape the focus is still here;
  // the loader handles the key on the host page).
  useEffect(() => {
    if (state !== "rest" && state !== "nudge") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        onOpen();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state, onOpen]);
  const [measured, setMeasured] = useState(56);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const w = Math.min(WIDTHS[state], viewport.w - 24);
  // The panel fills what it's given; everything else is as tall as its content.
  const panelHeight = Math.max(240, Math.min(560, viewport.h - edge(viewport.w) - GLOW));
  useEffect(() => {
    const el = content.current;
    if (!el || state === "panel") return;
    const measure = () => setMeasured(Math.ceil(el.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [state]);
  const h = state === "panel" ? panelHeight : measured;
  useIslandFrame({ w, h }, live);
  return (
    <div className="i-root">
      {/* The box carries the size and its spring; the neon ring and glow sit on it, outside the clipped shell. */}
      <div className={`i-box i-s-${state}${live ? " i-live" : ""}`} style={{ width: w, height: h }}>
        {neon && <div className="i-glow" aria-hidden="true" />}
        {neon && <div className="i-ring" aria-hidden="true" />}
        <div className="i-shell" role="region" aria-label="Chat">
          <div key={state} className="i-view" ref={content} style={{ width: w, ...(state === "panel" ? { height: panelHeight } : {}) }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The mark: the workspace logo, or the Jun agent mark (as the chat header), pulsing while the assistant works. */
export function Mark({ logoUrl, pulse = false }: { logoUrl: string | null; pulse?: boolean }) {
  return <img className={`i-mark${pulse ? " pulse" : ""}`} src={logoUrl ?? "/jun-agent.svg"} alt="" />;
}

/** Resting: the mark, a hint that types out the suggested questions (or a new reply), and the "/" key. */
export function RestPill({ logoUrl, suggestions, placeholder, unread, onOpen }: { logoUrl: string | null; suggestions: string[]; placeholder: string; unread: string | null; onOpen: () => void }) {
  return (
    <button type="button" className="i-rest" aria-label={unread ?? "Ask this page anything"} onClick={onOpen}>
      <Mark logoUrl={logoUrl} pulse={Boolean(unread)} />
      {unread ? <span className="i-rest-text">{unread}</span> : <Typewriter phrases={suggestions} fallback={placeholder} />}
      <kbd className="i-kbd" aria-hidden="true">/</kbd>
    </button>
  );
}

/** Nudge: a one-line offer with an Ask button; ignored, it goes away on its own. */
export function NudgeLine({ logoUrl, text, from, onAsk, onDismiss }: { logoUrl: string | null; text: string; from: string | null; onAsk: () => void; onDismiss: () => void }) {
  return (
    <div className="i-nudge" role="dialog" aria-label="Need help?">
      <Mark logoUrl={logoUrl} />
      <span className="i-nudge-text">
        {from && <span className="i-nudge-from">{from} · </span>}
        {text}
      </span>
      <button type="button" className="i-ask" onClick={onAsk}>Ask</button>
      <button type="button" className="i-ghost i-x" aria-label="Dismiss" onClick={onDismiss}>×</button>
    </div>
  );
}

/** Thinking: one specific line, the running tool step's label when there is one. */
export function StatusLine({ logoUrl, label }: { logoUrl: string | null; label: string }) {
  return (
    <div className="i-status" role="status">
      <Mark logoUrl={logoUrl} pulse />
      <span className="i-status-text">{label}</span>
    </div>
  );
}

/** The header of the answer and panel states: who's talking, the intent's exit, a view toggle and Close. */
export function IslandHead({ name, logoUrl, exit, toggle, onClose }: {
  name: string;
  logoUrl: string | null;
  /** AI-20: the intent's exit button (D-37: always on screen, one click). */
  exit: { label: string; run: () => void } | null;
  toggle: { label: string; run: () => void } | null;
  onClose: () => void;
}) {
  return (
    <div className="i-head">
      <Mark logoUrl={logoUrl} />
      <span className="i-name">{name}</span>
      {exit && <button type="button" className="i-exit" onClick={exit.run}>{exit.label}</button>}
      <span className="i-spacer" />
      {toggle && <button type="button" className="i-ghost" onClick={toggle.run}>{toggle.label}</button>}
      <button type="button" className="i-ghost i-x" aria-label="Close" onClick={onClose}>×</button>
    </div>
  );
}

/** Open: the suggested questions as chips over the question box. */
export function IslandChips({ questions, onPick }: { questions: string[]; onPick: (q: string) => void }) {
  if (questions.length === 0) return null;
  return (
    <div className="i-chips" role="group" aria-label="Suggested questions">
      {questions.map((q, i) => (
        <button key={q} type="button" className="i-chip" style={{ animationDelay: `${120 + i * 60}ms` }} onClick={() => onPick(q)}>{q}</button>
      ))}
    </div>
  );
}
