import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import type { LiveVisitor } from "../../shared/protocol.ts";
import { api, describeError } from "../api.ts";
import { describeBrowser } from "../../shared/debug.ts";
import { Card } from "@/components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { globeSpots } from "../lib/globe-spots.ts";

// MapLibre is big (~220 KB gzipped): only this page loads it.
const VisitorGlobe = lazy(() => import("./VisitorGlobe.tsx"));

// V-01 live visitors and V-07 agent-started chats. The list itself comes from the workspace
// hub socket (Shell keeps it), so it updates as people browse.

const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** "Visitor #4821" from the session id (stable while they browse). */
const sessionLabel = (id: string) => `Visitor #${(parseInt(id.slice(0, 6), 16) % 9000) + 1000}`;
const visitorName = (v: LiveVisitor) => v.contact?.name ?? v.contact?.email ?? sessionLabel(v.sessionId);

const countryName = (() => {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(undefined, { type: "region" });
  } catch {}
  return (code: string) => {
    try {
      return names?.of(code) ?? code;
    } catch {
      return code;
    }
  };
})();

function flag(country: string | null): string {
  if (!country || !/^[A-Z]{2}$/.test(country)) return "";
  return String.fromCodePoint(...[...country].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    // The loader masks query values as "…"; show it, not %E2%80%A6.
    return decodeURI(`${u.host}${u.pathname}${u.search}`);
  } catch {
    return url;
  }
}

function InviteForm({ workspaceId, visitor, onDone }: { workspaceId: string; visitor: LiveVisitor; onDone: (sent: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = visitor.contact?.name?.split(" ")[0];
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body = String(new FormData(e.currentTarget).get("body") ?? "").trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/workspaces/${workspaceId}/visitors/${visitor.sessionId}/invite`, { body: { body } });
      onDone(true);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  return (
    <form className="visitor-invite" onSubmit={submit}>
      <Input name="body" autoFocus maxLength={1000} defaultValue={`Hi${name ? ` ${name}` : ""}! Can I help you with anything${visitor.page.title ? ` on ${visitor.page.title}` : ""}?`} />
      <Button disabled={busy}>Send</Button>
      <Button variant="outline" type="button" onClick={() => onDone(false)}>Cancel</Button>
      {error && <span className="error small">{error}</span>}
    </form>
  );
}

export function VisitorsPage({ workspaceId, visitors }: { workspaceId: string; visitors: LiveVisitor[] }) {
  const [now, setNow] = useState(Date.now());
  const [inviting, setInviting] = useState<string | null>(null);
  const [invited, setInvited] = useState<Set<string>>(new Set());
  const [hovered, setHovered] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const sorted = [...visitors].sort((a, b) => Number(Boolean(b.contact?.verified)) - Number(Boolean(a.contact?.verified)) || a.startedAt - b.startedAt);
  const spots = useMemo(() => globeSpots(visitors, (v) => (v.contact ? visitorName(v) : v.city ?? (v.country ? countryName(v.country) : sessionLabel(v.sessionId)))), [visitors]);
  const countries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of visitors) if (v.country) counts.set(v.country, (counts.get(v.country) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [visitors]);

  return (
    <div className="content wide">
      <Card className="panel visitor-globe-panel">
        <Suspense fallback={<div className="visitor-globe" />}>
          <VisitorGlobe spots={spots} countries={countries.map(([code]) => code)} focus={hovered} />
        </Suspense>
        <div className="visitor-globe-stats">
          <div className="visitor-live">
            <span className="live-dot" aria-hidden />
            <span className="visitor-live-count">{visitors.length}</span>
            <span className="muted">{visitors.length === 1 ? "visitor" : "visitors"} on your site now</span>
          </div>
          {countries.length > 0 ? (
            <ul className="visitor-countries">
              {countries.slice(0, 5).map(([code, n]) => (
                <li key={code}>
                  <span>{flag(code)} {countryName(code)}</span>
                  <span className="muted">{n}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">When someone opens a page with the widget, they light up on the globe.</p>
          )}
        </div>
      </Card>
      <Card className="panel">
        <div className="row">
          <h2>Visitors on your site</h2>
          <span className="tag">{visitors.length} live</span>
        </div>
        <p className="muted small">People browsing pages with the widget right now. Signed-in customers show who they are when your site sends an identity token (Settings → Install).</p>
        {sorted.length === 0 ? (
          <p className="muted">Nobody right now. Open your site (or the demo page from Settings) in another tab to see yourself here.</p>
        ) : (
          <Table className="visitors">
            <TableHeader>
              <TableRow>
                <TableHead>Visitor</TableHead>
                <TableHead>Page</TableHead>
                <TableHead>From</TableHead>
                <TableHead>On site</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((v) => (
                <TableRow key={v.sessionId} onMouseEnter={() => setHovered(v.sessionId)} onMouseLeave={() => setHovered((h) => (h === v.sessionId ? null : h))}>
                  <TableCell>
                    <div className="strong">
                      {visitorName(v)}
                      {v.contact?.verified && <span className="verified" title="Identity verified by your site">✓</span>}
                    </div>
                    <div className="muted small">
                      {v.contact?.name && v.contact.email ? `${v.contact.email} · ` : ""}
                      {flag(v.country)} {[v.city, v.country].filter(Boolean).join(", ") || "Unknown location"} · {describeBrowser(v.userAgent)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>{v.page.title || "Untitled page"}</div>
                    <div className="muted small"><code>{pathOf(v.page.url)}</code></div>
                  </TableCell>
                  <TableCell className="small">{v.referrer ? <code>{pathOf(v.referrer)}</code> : <span className="muted">Direct</span>}</TableCell>
                  <TableCell className="small">
                    {duration(now - v.startedAt)}
                    <div className="muted">{v.pages} page{v.pages === 1 ? "" : "s"}</div>
                  </TableCell>
                  <TableCell className="visitor-action">
                    {v.inChat ? (
                      <span className="tag">In a chat</span>
                    ) : invited.has(v.sessionId) ? (
                      <span className="muted small">Invite sent</span>
                    ) : inviting === v.sessionId ? null : (
                      <Button variant="outline" size="sm" onClick={() => setInviting(v.sessionId)}>Start chat</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {inviting && sorted.some((v) => v.sessionId === inviting) && (
          <InviteForm
            workspaceId={workspaceId}
            visitor={sorted.find((v) => v.sessionId === inviting)!}
            onDone={(sent) => {
              if (sent) setInvited((s) => new Set(s).add(inviting));
              setInviting(null);
            }}
          />
        )}
      </Card>
    </div>
  );
}
