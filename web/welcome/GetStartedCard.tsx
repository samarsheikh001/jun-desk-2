import { useState } from "react";
import { navigate } from "../lib/router.ts";
import { STEP_ORDER, type Onboarding } from "./WelcomePage.tsx";

// T-11: the sidebar's "Get started" checklist (after Widgo's): progress bar, % badge, and a
// link per step to where it's done. The header folds the list away (not remembered, like theirs).

const STEPS: Record<(typeof STEP_ORDER)[number], { label: string; href: string }> = {
  account: { label: "Create your account", href: "/welcome" },
  knowledge: { label: "Add your docs", href: "/knowledge" },
  ai: { label: "Turn on the AI", href: "/welcome" },
  brand: { label: "Make the widget yours", href: "/appearance" },
  install: { label: "Install on your site", href: "/welcome" },
  team: { label: "Invite your team", href: "/welcome" },
};

export function GetStartedCard({ onboarding }: { onboarding: Onboarding }) {
  const [open, setOpen] = useState(true);
  const done = STEP_ORDER.filter((k) => onboarding.steps[k]).length;
  const percent = Math.round((done / STEP_ORDER.length) * 100);

  return (
    <div className="gs-card">
      <div className="gs-track"><div className="gs-fill" style={{ width: `${percent}%` }} /></div>
      <button type="button" className="gs-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <h4>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="gs-bolt" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
          Get started
        </h4>
        <span className="gs-meta">
          <span className="gs-percent">{percent}%</span>
          <svg viewBox="0 0 16 16" aria-hidden="true" className={`gs-chevron ${open ? "open" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>
        </span>
      </button>
      {open && (
        <div className="gs-list">
          {STEP_ORDER.map((key, i) => {
            const { label, href } = STEPS[key];
            const ok = onboarding.steps[key];
            return (
              <a key={key} href={href} className="gs-step" onClick={(e) => { e.preventDefault(); navigate(href); }}>
                <span className={`gs-n ${ok ? "done" : ""}`}>{ok ? "✓" : i + 1}</span>
                <span className={ok ? "gs-done" : undefined}>{label}</span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
