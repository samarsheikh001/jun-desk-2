import { useEffect, useMemo, useState, type FormEvent } from "react";
import { DEFAULT_AWAY_MESSAGE, describeOpening, isOpen, nextOpening, WEEKDAYS, type BusinessHours, type DayHours, type Weekday } from "../../shared/hours.ts";
import { api, ApiError } from "../api.ts";
import { useAction } from "../useAction.ts";
import { Card } from "@/components/ui/card.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";

// W-04 widget appearance and I-10 business hours (Settings).

export interface InboxSettings {
  color?: string;
  position?: "left" | "right";
  greeting?: string;
  replyTime?: string;
  displayName?: string;
  logoKey?: string;
  hours?: BusinessHours;
  /** W-12: ask for a rating when a conversation is resolved (default on). */
  csat?: boolean;
}

const DEFAULT_COLOR = "#2f5bea";

export function AppearancePanel({ workspaceId, widgetKey, workspaceName, settings, canEdit, onSaved }: {
  workspaceId: string;
  widgetKey: string;
  workspaceName: string;
  settings: InboxSettings;
  canEdit: boolean;
  onSaved: (s: InboxSettings) => void;
}) {
  const [color, setColor] = useState(settings.color ?? DEFAULT_COLOR);
  const [position, setPosition] = useState<"left" | "right">(settings.position ?? "right");
  const [name, setName] = useState(settings.displayName ?? "");
  const [greeting, setGreeting] = useState(settings.greeting ?? "");
  const [replyTime, setReplyTime] = useState(settings.replyTime ?? "");
  const [csat, setCsat] = useState(settings.csat !== false);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ settings: InboxSettings }>(`/workspaces/${workspaceId}/inbox`, {
        method: "PATCH",
        body: { color, position, displayName: name, greeting, replyTime, csat },
      });
      onSaved(r.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  const uploadLogo = (file: File) =>
    run(async () => {
      const response = await fetch(`/api/workspaces/${workspaceId}/inbox/logo`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream", "X-Jun-Upload": "1" },
        body: file,
        credentials: "same-origin",
      });
      const json = (await response.json().catch(() => ({}))) as { settings?: InboxSettings; error?: { code: string; message: string } };
      if (!response.ok) throw new ApiError(json.error?.code ?? "http_error", json.error?.message ?? "Upload failed.");
      onSaved(json.settings!);
    });

  const textOn = useMemo(() => {
    const n = parseInt(color.slice(1), 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.65 ? "#1c1c1a" : "#fff";
  }, [color]);
  const logo = settings.logoKey ? `/api/widget/${widgetKey}/logo?v=${settings.logoKey}` : null;

  return (
    <Card className="panel">
      <h2>Widget appearance</h2>
      <p className="muted small">Changes show on your site within a minute; no need to update the snippet.</p>
      <div className="appearance">
        <form onSubmit={save} className="ai-form">
          <label className="field">
            <span>Name shown in the chat</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={workspaceName} maxLength={80} disabled={!canEdit} />
          </label>
          <label className="field">
            <span>Greeting</span>
            <Input value={greeting} onChange={(e) => setGreeting(e.target.value)} placeholder="Hi! How can we help?" maxLength={200} disabled={!canEdit} />
          </label>
          <label className="field">
            <span>Reply time</span>
            <Input value={replyTime} onChange={(e) => setReplyTime(e.target.value)} placeholder="We usually reply in a few minutes" maxLength={80} disabled={!canEdit} />
          </label>
          <div className="row">
            <label className="field">
              <span>Colour</span>
              <span className="row">
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} disabled={!canEdit} aria-label="Brand colour" />
                <Input value={color} onChange={(e) => setColor(e.target.value)} pattern="#[0-9a-fA-F]{6}" style={{ width: 100 }} disabled={!canEdit} aria-label="Brand colour (hex)" />
              </span>
            </label>
            <fieldset className="field" disabled={!canEdit}>
              <span>Button position</span>
              <span className="row small">
                <label className="check"><input type="radio" checked={position === "right"} onChange={() => setPosition("right")} /> Right</label>
                <label className="check"><input type="radio" checked={position === "left"} onChange={() => setPosition("left")} /> Left</label>
              </span>
            </fieldset>
          </div>
          <div className="field">
            <span>Logo <span className="muted">(PNG, JPEG, WebP or GIF, up to 512 KB)</span></span>
            <span className="row">
              {logo && <img src={logo} alt="Current logo" className="logo-thumb" />}
              {canEdit && <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.target.value = ""; }} aria-label="Upload logo" />}
              {canEdit && logo && <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => run(async () => onSaved((await api<{ settings: InboxSettings }>(`/workspaces/${workspaceId}/inbox/logo`, { method: "DELETE" })).settings))}>Remove</Button>}
            </span>
          </div>
          <label className="check small">
            <input type="checkbox" checked={csat} onChange={(e) => setCsat(e.target.checked)} disabled={!canEdit} />
            Ask "How did we do?" when a conversation is resolved
          </label>
          {error && <p className="error small">{error}</p>}
          {canEdit && <div className="row"><Button disabled={busy}>Save</Button>{saved && <span className="muted small">Saved ✓</span>}</div>}
        </form>
        <div className={`wpreview ${position}`} aria-label="Preview">
          <div className="wpreview-frame">
            <div className="wpreview-head" style={{ background: color, color: textOn }}>
              {logo && <img src={logo} alt="" />}
              <div>
                <strong>{name || workspaceName}</strong>
                <div className="small">{replyTime || "We usually reply in a few minutes"}</div>
              </div>
            </div>
            <div className="wpreview-body">
              <strong>{greeting || "Hi! How can we help?"}</strong>
              <span className="wpreview-cta" style={{ background: color, color: textOn }}>Send us a message</span>
            </div>
          </div>
          <div className="wpreview-btn" style={{ background: color, color: textOn }}>💬</div>
        </div>
      </div>
    </Card>
  );
}

const ALL_DAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

function zones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  // Browsers' lists leave out plain "UTC"; teams spread across zones often want it.
  const list = intl.supportedValuesOf?.("timeZone") ?? [];
  return ["UTC", ...list.filter((z) => z !== "UTC")];
}

export function HoursPanel({ workspaceId, settings, canEdit, onSaved }: { workspaceId: string; settings: InboxSettings; canEdit: boolean; onSaved: (s: InboxSettings) => void }) {
  const initial = settings.hours;
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [timezone, setTimezone] = useState(initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [days, setDays] = useState<Record<number, DayHours | null>>(() =>
    Object.fromEntries(ALL_DAYS.map((d) => [d, initial ? initial.days.find((x) => x.day === d) ?? null : d >= 1 && d <= 5 ? { day: d, start: "09:00", end: "17:00" } : null])),
  );
  const [away, setAway] = useState(initial?.awayMessage ?? DEFAULT_AWAY_MESSAGE);
  const [saved, setSaved] = useState(false);
  const [now, setNow] = useState(Date.now());
  const { busy, error, run } = useAction();
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const hours: BusinessHours = { enabled, timezone, days: ALL_DAYS.map((d) => days[d]).filter((d): d is DayHours => Boolean(d)), awayMessage: away };
  let status = "Always open (hours are off)";
  try {
    if (enabled) {
      const next = nextOpening(hours, now);
      status = isOpen(hours, now) ? "Open now" : next ? `Closed now · opens ${describeOpening(next, timezone, now)}` : "Closed (no open days)";
    }
  } catch {
    status = "";
  }

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ settings: InboxSettings }>(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { hours } });
      onSaved(r.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  return (
    <Card className="panel">
      <div className="row">
        <h2>Business hours</h2>
        <span className="spacer" />
        <span className="tag">{status}</span>
      </div>
      <p className="muted small">Outside these hours the AI still answers. When a chat is with your team, the visitor gets your away message once, and the widget says when you're back.</p>
      <form onSubmit={save} className="ai-form">
        <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!canEdit} /> Use business hours</label>
        <label className="field">
          <span>Time zone</span>
          <NativeSelect value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={!canEdit}>
            {zones().map((z) => <NativeSelectOption key={z} value={z}>{z.replace(/_/g, " ")}</NativeSelectOption>)}
          </NativeSelect>
        </label>
        <div className="hours-grid">
          {ALL_DAYS.map((d) => {
            const v = days[d];
            return (
              <div key={d} className="row hours-row">
                <label className="check" style={{ width: 130 }}>
                  <input type="checkbox" checked={Boolean(v)} disabled={!canEdit} onChange={(e) => setDays({ ...days, [d]: e.target.checked ? { day: d, start: "09:00", end: "17:00" } : null })} /> {WEEKDAYS[d]}
                </label>
                {v ? (
                  <>
                    <Input type="time" value={v.start} disabled={!canEdit} onChange={(e) => setDays({ ...days, [d]: { ...v, start: e.target.value } })} aria-label={`${WEEKDAYS[d]} opens`} />
                    <span className="muted">to</span>
                    <Input type="time" value={v.end === "24:00" ? "23:59" : v.end} disabled={!canEdit} onChange={(e) => setDays({ ...days, [d]: { ...v, end: e.target.value === "23:59" ? "24:00" : e.target.value } })} aria-label={`${WEEKDAYS[d]} closes`} />
                  </>
                ) : (
                  <span className="muted small">Closed</span>
                )}
              </div>
            );
          })}
        </div>
        <label className="field">
          <span>Away message <span className="muted">({"{when}"} becomes e.g. "on Monday at 09:00 (London time)")</span></span>
          <Textarea rows={2} value={away} onChange={(e) => setAway(e.target.value)} maxLength={500} disabled={!canEdit} />
        </label>
        {error && <p className="error small">{error}</p>}
        {canEdit && <div className="row"><Button disabled={busy}>Save</Button>{saved && <span className="muted small">Saved ✓</span>}</div>}
      </form>
    </Card>
  );
}
