import { useCallback, useEffect, useState } from "react";
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from "../../shared/notifications.ts";
import { api, describeError } from "../api.ts";
import { currentSubscription, deviceName, enablePush, endpointHash, notificationPermission, pushSupport, type Device } from "../lib/notifications.ts";
import { useAction } from "../useAction.ts";
import { Button } from "@/components/ui/button.tsx";

import { Card } from "@/components/ui/card.tsx";
const TRIGGERS: { key: keyof NotificationPrefs; label: string; hint: string }[] = [
  { key: "needsPerson", label: "A chat needs a person", hint: "Handed to the team and nobody has it yet (or round robin gave it to you)." },
  { key: "assigned", label: "A chat is assigned to you", hint: "By round robin or by a teammate." },
  { key: "visitorReply", label: "A customer replies in your chat", hint: "Chats assigned to you." },
  { key: "mention", label: "Someone @mentions you in a note", hint: "" },
];

const day = (ms: number) => new Date(ms).toLocaleDateString();

/** I-14: your notifications. Per person: which events, and which of your devices get them. */
export function NotificationsPanel({ workspaceId }: { workspaceId: string }) {
  const base = `/workspaces/${workspaceId}`;
  const support = pushSupport();
  const [permission, setPermission] = useState(notificationPermission);
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();

  const load = useCallback(async () => {
    const [list, subscription] = await Promise.all([api<{ devices: Device[] }>(`${base}/push/subscriptions`), currentSubscription().catch(() => null)]);
    setDevices(list.devices);
    const hash = subscription ? await endpointHash(subscription.endpoint) : null;
    setThisDevice(list.devices.find((d) => d.endpointHash === hash)?.id ?? null);
  }, [base]);
  useEffect(() => {
    api<{ prefs: NotificationPrefs }>(`${base}/notifications`).then((r) => setPrefs(r.prefs), () => setPrefs(DEFAULT_NOTIFICATION_PREFS));
    load().catch(() => {});
  }, [base, load]);

  const toggle = (key: keyof NotificationPrefs, value: boolean) =>
    run(async () => {
      setPrefs((p) => p && { ...p, [key]: value });
      setPrefs((await api<{ prefs: NotificationPrefs }>(`${base}/notifications`, { method: "PUT", body: { [key]: value } })).prefs);
    });

  const turnOn = () =>
    run(async () => {
      setSent(false);
      try {
        const device = await enablePush(workspaceId);
        setThisDevice(device.id);
      } catch (e) {
        setPermission(notificationPermission());
        // Permission granted but no push service (some browsers, headless ones): the open desk still notifies.
        if (notificationPermission() === "granted") throw new Error(`This browser couldn't subscribe to push (${describeError(e)}). You'll still get notifications while the desk is open in a tab.`);
        throw e;
      }
      setPermission(notificationPermission());
      await load();
    });

  const remove = (device: Device) =>
    run(async () => {
      if (device.id === thisDevice) await (await currentSubscription())?.unsubscribe();
      await api(`${base}/push/subscriptions/${device.id}`, { method: "DELETE" });
      await load();
    });

  const test = () =>
    run(async () => {
      setSent(false);
      await api(`${base}/push/test`, { body: { subscriptionId: thisDevice } });
      setSent(true);
    });

  const current = devices.find((d) => d.id === thisDevice);
  return (
    <Card className="panel" id="notifications">
      <h2>Notifications</h2>
      <p className="muted small">
        Get a notification when a chat needs you. With the desk open in a tab you're not looking at, the tab shows it; with the desk closed, your devices get a push.
        Nothing is sent while you're looking at the desk.
      </p>

      <div className="notify-device">
        {support === "ios-home-screen" ? (
          <p className="small">On iPhone and iPad, notifications work only in the desk added to your Home Screen: tap Share, then <strong>Add to Home Screen</strong>, open Jun Desk from there and turn them on.</p>
        ) : support === "unsupported" ? (
          <p className="small">This browser can't show notifications. Try a current Chrome, Edge, Firefox or Safari.</p>
        ) : permission === "denied" ? (
          <p className="small error">Notifications are blocked for this site. Allow them in your browser's site settings (the icon next to the address bar), then reload this page.</p>
        ) : current ? (
          <div className="row wrap">
            <span className="small"><span className="ok-text">●</span> On for this device ({deviceName(current.userAgent)})</span>
            <span className="spacer" />
            <Button size="sm" disabled={busy} onClick={test}>Send a test notification</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => remove(current)}>Turn off on this device</Button>
          </div>
        ) : (
          <div className="row wrap">
            <Button disabled={busy} onClick={turnOn}>Turn on notifications on this device</Button>
            <span className="muted small">Your browser will ask for permission.</span>
          </div>
        )}
        {sent && <p className="small ok-text">Sent. It should appear in a few seconds.</p>}
        {error && <p className="small error">{error}</p>}
      </div>

      <h3>Notify me when</h3>
      <div className="stack">
        {TRIGGERS.map((t) => (
          <label key={t.key} className="check small notify-trigger">
            <input type="checkbox" checked={prefs?.[t.key] ?? true} disabled={!prefs || busy} onChange={(e) => toggle(t.key, e.target.checked)} />
            <span>
              {t.label}
              {t.hint && <span className="muted"> · {t.hint}</span>}
            </span>
          </label>
        ))}
      </div>

      {devices.length > 0 && (
        <>
          <h3>Your devices</h3>
          <ul className="list">
            {devices.map((d) => (
              <li key={d.id}>
                <span>
                  {deviceName(d.userAgent)}
                  {d.id === thisDevice && <em className="tag">this device</em>}
                </span>
                <span className="muted small">
                  added {day(d.createdAt)} · {d.lastSuccessAt ? `last delivered ${day(d.lastSuccessAt)}` : "nothing delivered yet"}
                  {d.failures > 0 && ` · ${d.failures} failed`}
                </span>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => remove(d)}>Remove</Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
