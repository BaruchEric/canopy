import { useState } from "react";
import { useStore } from "../store";

type Permission = NotificationPermission | "none";

/** what the browser lets this page do; "none" where it has no Notification
 *  at all, which is every plain-http page off localhost */
const permissionNow = (): Permission => (typeof Notification === "undefined" ? "none" : Notification.permission);

/** why notifications cannot show, in a line, or null when they can (or the
 *  setting is off, when there is nothing to explain) */
function whyNot(on: boolean, permission: Permission): string | null {
  if (!on) return null;
  if (permission === "none") {
    return typeof window !== "undefined" && !window.isSecureContext
      ? "This page is on plain http, and browsers give notifications only to https or localhost. The tab title still counts what waits."
      : "This browser has no system notifications. The tab title still counts what waits.";
  }
  if (permission === "denied") return "The browser blocks notifications for this site. Allow them in its site settings; the tab title still counts what waits.";
  if (permission === "default") return "The browser has not been asked yet: turn this off and on again to ask.";
  return null;
}

/** The device tab's notifications row. Turning it on asks the browser for
 *  permission, since a page may only ask in answer to a click. */
export function NotifyRow() {
  const on = useStore((s) => s.settings.notify);
  const setSetting = useStore((s) => s.setSetting);
  const [permission, setPermission] = useState<Permission>(permissionNow);
  const why = whyNot(on, permission);

  const toggle = (next: boolean) => {
    setSetting("notify", next);
    if (!next || typeof Notification === "undefined" || Notification.permission !== "default") {
      setPermission(permissionNow());
      return;
    }
    void Notification.requestPermission()
      .then(setPermission)
      .catch(() => setPermission(permissionNow()));
  };

  return (
    <section className="settings-row">
      <h3 className="panel-label">notifications</h3>
      <label className="settings-line">
        <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
        notify me while this tab is hidden, and count what waits in its title
      </label>
      <p className="settings-hint">
        A chat whose turn it is, an ask, a run that finished or failed. Only the main window notifies, so a pop-out never doubles one.
      </p>
      {why && <p className="settings-hint">{why}</p>}
    </section>
  );
}
