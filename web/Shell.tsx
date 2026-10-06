import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpenIcon, BotIcon, ChartColumnIcon, InboxIcon, PaletteIcon, SearchIcon, SettingsIcon, UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import { DeskIcon } from "./components/DeskIcon.tsx";
import { ThemeButton } from "./components/ThemeButton.tsx";
import type { HubClientEvent, HubEvent, LiveVisitor, PresenceEntry } from "../shared/protocol.ts";
import { api, type Me } from "./api.ts";
import { InboxPage } from "./inbox/InboxPage.tsx";
import { AppearancePage } from "./appearance/AppearancePage.tsx";
import { AgentPage } from "./agent/AgentPage.tsx";
import { CommandPalette, ShortcutsHelp } from "./components/CommandPalette.tsx";
import { bridge, isControlTarget, isTypingTarget, modKey } from "./lib/bridge.ts";
import { dispatchShortcut, INITIAL_SHORTCUT_STATE, type ShortcutCommand } from "./lib/commands.ts";
import { KnowledgePage } from "./knowledge/KnowledgePage.tsx";
import { deskServiceWorker, listenForNotificationClicks, notificationPermission, showInPageNotification, tabFocused } from "./lib/notifications.ts";
import { LiveSocket } from "./lib/socket.ts";
import { ReportsPage } from "./reports/ReportsPage.tsx";
import { navigate, usePath } from "./lib/router.ts";
import { SettingsPage } from "./SettingsPage.tsx";
import { VisitorsPage } from "./visitors/VisitorsPage.tsx";
import { STEP_ORDER, useOnboarding, WelcomePage } from "./welcome/WelcomePage.tsx";

const NAV = [
  { id: "inbox", label: "Inbox", Icon: InboxIcon },
  { id: "visitors", label: "Visitors", Icon: UsersIcon },
  { id: "knowledge", label: "Knowledge", Icon: BookOpenIcon },
  { id: "agent", label: "Agent", Icon: BotIcon },
  { id: "appearance", label: "Appearance", Icon: PaletteIcon },
  { id: "reports", label: "Reports", Icon: ChartColumnIcon },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
] as const;

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
  const onboarding = useOnboarding(workspace?.workspaceId ?? "");
  // The "Get started n/6" badge follows what's done elsewhere (Settings, Knowledge…).
  const { reload: reloadOnboarding } = onboarding;
  useEffect(() => {
    if (workspace) reloadOnboarding().catch(() => {});
  }, [path, workspace, reloadOnboarding]);

  useEffect(() => {
    if (path === "/" || path === "") navigate("/inbox", { replace: true });
  }, [path]);

  useEffect(() => {
    if (!workspace) return;
    // I-14: the hub skips Web Push for you while a desk tab is in front of you.
    const reportFocus = () => socket.send({ type: "focus", focused: tabFocused() } satisfies HubClientEvent);
    const socket = new LiveSocket<HubEvent>({
      url: () => `/api/workspaces/${workspace.workspaceId}/ws`,
      onState: (state) => {
        if (state === "open") reportFocus();
      },
      onEvent: (event) => {
        // Not in front of you: a system notification (in front: the inbox's own toasts and lists).
        if (event.type === "notify" && event.mode === "system" && !tabFocused()) void showInPageNotification(event.notification).catch(() => {});
        if (event.type === "presence") setOnline(event.online);
        if (event.type === "visitors") setVisitors(event.visitors);
        if (event.type === "visitor") setVisitors((list) => [...list.filter((v) => v.sessionId !== event.visitor.sessionId), event.visitor]);
        if (event.type === "visitor_left") setVisitors((list) => list.filter((v) => v.sessionId !== event.sessionId));
        for (const listener of listeners.current) listener(event);
      },
    });
    window.addEventListener("focus", reportFocus);
    window.addEventListener("blur", reportFocus);
    document.addEventListener("visibilitychange", reportFocus);
    // The service worker shows notifications (in-page ones too) and routes clicks to this tab.
    if (notificationPermission() === "granted") void deskServiceWorker().catch(() => {});
    const stopClicks = listenForNotificationClicks();
    return () => {
      socket.close();
      window.removeEventListener("focus", reportFocus);
      window.removeEventListener("blur", reportFocus);
      document.removeEventListener("visibilitychange", reportFocus);
      stopClicks();
    };
  }, [workspace]);

  // I-13: the command palette, the "?" sheet and the keyboard shortcuts.
  const [overlay, setOverlay] = useState<"palette" | "help" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const shortcutState = useRef(INITIAL_SHORTCUT_STATE);
  const openOverlay = useCallback((next: "palette" | "help") => {
    setOverlay((current) => {
      if (!current && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
      return next;
    });
  }, []);
  const afterClose = useRef<(() => void) | null>(null);
  /** Closes the palette or sheet; once it's gone, focus goes back and `then` runs (it may move focus on). */
  const closeOverlay = useCallback((then?: () => void) => {
    afterClose.current = then ?? null;
    setOverlay(null);
  }, []);
  useEffect(() => {
    if (overlay) return;
    // After the commit: while a modal dialog is open the rest of the page is inert and can't take focus.
    const target = returnFocus.current;
    const then = afterClose.current;
    returnFocus.current = null;
    afterClose.current = null;
    if (target?.isConnected) target.focus();
    then?.();
  }, [overlay]);
  const showNotice = useCallback((text: string) => setNotice(text), []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const openHelp = useCallback(() => openOverlay("help"), [openOverlay]);

  useEffect(() => {
    const run = (command: ShortcutCommand) => {
      const { inbox, thread } = bridge;
      switch (command) {
        case "palette": return overlay === "palette" ? closeOverlay() : openOverlay("palette");
        case "help": return openOverlay("help");
        case "go-inbox": return navigate("/inbox");
        case "go-visitors": return navigate("/visitors");
        case "go-reports": return navigate("/reports");
        case "go-settings": return navigate("/settings");
        case "next": return inbox?.move(1);
        case "previous": return inbox?.move(-1);
        case "open": return inbox?.openCursor();
        case "search": return inbox?.focusSearch();
        case "resolve": return inbox?.act("resolve");
        case "assign-me": return inbox?.act("assign-me");
        case "reply": return thread?.focusComposer("reply");
        case "note": return thread?.focusComposer("note");
        case "tag": return thread?.startTag();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented && !(e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey))) return;
      const otherDialog = Array.from(document.querySelectorAll("dialog[open]")).some((d) => !d.classList.contains("palette"));
      const { command, state } = dispatchShortcut(
        {
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          isComposing: e.isComposing || e.key === "Process" || e.keyCode === 229,
          typing: isTypingTarget(e.target) && overlay !== "palette",
          onControl: isControlTarget(e.target),
        },
        shortcutState.current,
        { inbox: window.location.pathname.startsWith("/inbox"), modal: overlay === "palette" ? "palette" : otherDialog || overlay ? "other" : "none" },
        Date.now(),
      );
      shortcutState.current = state;
      if (!command) return;
      e.preventDefault();
      run(command);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlay, openOverlay, closeOverlay]);

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
    : path.startsWith("/appearance") ? "appearance"
    : path.startsWith("/visitors") ? "visitors"
    : path.startsWith("/reports") ? "reports"
    : path.startsWith("/welcome") ? "welcome"
    : "inbox";
  const ob = onboarding.state;
  const obDone = ob ? STEP_ORDER.filter((k) => ob.steps[k]).length : 0;
  const showGetStarted = Boolean(ob && !ob.dismissed && obDone < STEP_ORDER.length && workspace.role !== "agent");
  const canEdit = workspace.role !== "agent";
  const conversationId = path.match(/^\/inbox\/([\w-]+)/)?.[1] ?? null;

  return (
    <div className="shell">
      <ScrollArea render={<header />} className="sidebar" contentClassName="sidebar-body">
        <div className="brand"><DeskIcon /><span>Jun Desk</span></div>
        <nav aria-label="Main">
          {NAV.map(({ id, label, Icon }) => (
            <a
              key={id}
              href={`/${id}`}
              className={`nav-item ${section === id ? "active" : ""}`}
              aria-current={section === id ? "page" : undefined}
              onClick={(e) => { e.preventDefault(); navigate(`/${id}`); }}
            >
              <Icon aria-hidden="true" />
              {label}
              {id === "visitors" && visitors.length > 0 && <span className="nav-count">{visitors.length}</span>}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-tools">
            <Button variant="outline" size="sm" className="palette-open" onClick={() => openOverlay("palette")} aria-keyshortcuts="Control+K Meta+K" title="Search and commands">
              <SearchIcon aria-hidden="true" /><span className="palette-open-label">Search</span> <kbd>{modKey()} K</kbd>
            </Button>
            <ThemeButton />
            <Button variant="outline" size="icon-sm" className="shortcuts-open" onClick={openHelp} aria-label="Keyboard shortcuts" aria-keyshortcuts="Shift+?" title="Keyboard shortcuts (?)">?</Button>
          </div>
          {showGetStarted && section !== "welcome" && (
            <a className="get-started" href="/welcome" onClick={(e) => { e.preventDefault(); navigate("/welcome"); }}>Get started <span className="muted">{obDone}/{STEP_ORDER.length}</span></a>
          )}
          <div className="sidebar-user">
            <span className="presence" title={online.map((o) => o.name).join(", ")}>
              {online.slice(0, 5).map((o) => (
                <span key={o.userId} className="avatar" title={`${o.name} is online`}>{o.name.slice(0, 1).toUpperCase()}</span>
              ))}
            </span>
            <span className="workspace">{workspace.workspaceName}</span>
            <Button variant="ghost" size="sm" onClick={async () => { await api("/auth/logout", { body: {} }); onSignOut(); }}>Sign out</Button>
          </div>
        </div>
      </ScrollArea>
      <ScrollArea render={<main />} className="desk-main" contentClassName="desk-main-body">
      {section === "inbox" ? (
        <InboxPage workspaceId={workspace.workspaceId} me={me.user} hub={hub} conversationId={conversationId} />
      ) : section === "knowledge" ? (
        <KnowledgePage workspaceId={workspace.workspaceId} canEdit={canEdit} />
      ) : section === "welcome" ? (
        <WelcomePage workspaceId={workspace.workspaceId} workspaceName={workspace.workspaceName} onboarding={onboarding.state} reload={onboarding.reload} />
      ) : section === "visitors" ? (
        <VisitorsPage workspaceId={workspace.workspaceId} visitors={visitors} />
      ) : section === "reports" ? (
        <ReportsPage workspaceId={workspace.workspaceId} />
      ) : section === "appearance" ? (
        <AppearancePage workspaceId={workspace.workspaceId} workspaceName={workspace.workspaceName} canEdit={canEdit} />
      ) : section === "agent" ? (
        <AgentPage workspaceId={workspace.workspaceId} canEdit={canEdit} />
      ) : (
        <SettingsPage me={me} />
      )}
      </ScrollArea>
      {overlay === "palette" && <CommandPalette workspaceId={workspace.workspaceId} meId={me.user.id} onClose={closeOverlay} onHelp={openHelp} onToast={showNotice} />}
      {overlay === "help" && <ShortcutsHelp onClose={closeOverlay} />}
      {notice && <div className="toast" role="status"><span>{notice}</span></div>}
    </div>
  );
}
