import { useEffect, useMemo, useRef, useState } from "react";
import type { HubEvent, LiveVisitor, PresenceEntry } from "../shared/protocol.ts";
import { api, type Me } from "./api.ts";
import { InboxPage } from "./inbox/InboxPage.tsx";
import { AgentPage } from "./agent/AgentPage.tsx";
import { KnowledgePage } from "./knowledge/KnowledgePage.tsx";
import { LiveSocket } from "./lib/socket.ts";
import { navigate, usePath } from "./lib/router.ts";
import { SettingsPage } from "./SettingsPage.tsx";
import { VisitorsPage } from "./visitors/VisitorsPage.tsx";

export interface Hub {
  subscribe(listener: (event: HubEvent) => void): () => void;
}

/** Signed-in layout: header, navigation, the workspace hub socket, and the current page. */
export function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const path = usePath();
  const workspace = me.memberships?.[0];
  const [online, setOnline] = useState<PresenceEntry[]>([]);
  // V-01: kept here (not in the page) because the hub sends the full list only on connect.
  const [visitors, setVisitors] = useState<LiveVisitor[]>([]);
  const listeners = useRef(new Set<(event: HubEvent) => void>());

  useEffect(() => {
    if (path === "/" || path === "") navigate("/inbox", { replace: true });
  }, [path]);

  useEffect(() => {
    if (!workspace) return;
    const socket = new LiveSocket<HubEvent>({
      url: () => `/api/workspaces/${workspace.workspaceId}/ws`,
      onEvent: (event) => {
        if (event.type === "presence") setOnline(event.online);
        if (event.type === "visitors") setVisitors(event.visitors);
        if (event.type === "visitor") setVisitors((list) => [...list.filter((v) => v.sessionId !== event.visitor.sessionId), event.visitor]);
        if (event.type === "visitor_left") setVisitors((list) => list.filter((v) => v.sessionId !== event.sessionId));
        for (const listener of listeners.current) listener(event);
      },
    });
    return () => socket.close();
  }, [workspace]);

  const hub = useMemo<Hub>(
    () => ({
      subscribe(listener) {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [],
  );

  if (!workspace || !me.user) return <div className="center muted">You're not a member of any workspace.</div>;
  const section =
    path.startsWith("/settings") ? "settings"
    : path.startsWith("/knowledge") ? "knowledge"
    : path.startsWith("/agent") ? "agent"
    : path.startsWith("/visitors") ? "visitors"
    : "inbox";
  const canEdit = workspace.role !== "agent";
  const conversationId = path.match(/^\/inbox\/([\w-]+)/)?.[1] ?? null;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">Jun Desk</div>
        <nav>
          <a href="/inbox" className={section === "inbox" ? "active" : ""} onClick={(e) => { e.preventDefault(); navigate("/inbox"); }}>Inbox</a>
          <a href="/visitors" className={section === "visitors" ? "active" : ""} onClick={(e) => { e.preventDefault(); navigate("/visitors"); }}>
            Visitors{visitors.length > 0 && <span className="nav-count">{visitors.length}</span>}
          </a>
          <a href="/knowledge" className={section === "knowledge" ? "active" : ""} onClick={(e) => { e.preventDefault(); navigate("/knowledge"); }}>Knowledge</a>
          <a href="/agent" className={section === "agent" ? "active" : ""} onClick={(e) => { e.preventDefault(); navigate("/agent"); }}>Agent</a>
          <a href="/settings" className={section === "settings" ? "active" : ""} onClick={(e) => { e.preventDefault(); navigate("/settings"); }}>Settings</a>
        </nav>
        <span className="spacer" />
        <span className="presence" title={online.map((o) => o.name).join(", ")}>
          {online.slice(0, 5).map((o) => (
            <span key={o.userId} className="avatar" title={`${o.name} is online`}>{o.name.slice(0, 1).toUpperCase()}</span>
          ))}
        </span>
        <span className="muted small">{workspace.workspaceName}</span>
        <button className="ghost small" onClick={async () => { await api("/auth/logout", { body: {} }); onSignOut(); }}>Sign out</button>
      </header>
      {section === "inbox" ? (
        <InboxPage workspaceId={workspace.workspaceId} me={me.user} hub={hub} conversationId={conversationId} />
      ) : section === "knowledge" ? (
        <KnowledgePage workspaceId={workspace.workspaceId} canEdit={canEdit} />
      ) : section === "visitors" ? (
        <VisitorsPage workspaceId={workspace.workspaceId} visitors={visitors} />
      ) : section === "agent" ? (
        <AgentPage workspaceId={workspace.workspaceId} canEdit={canEdit} />
      ) : (
        <SettingsPage me={me} />
      )}
    </div>
  );
}
