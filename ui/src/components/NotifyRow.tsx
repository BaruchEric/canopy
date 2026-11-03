import { useState, useSyncExternalStore } from "react";
import { pushWhyNot, PUSH_WORDS } from "../push";
import { disablePush, enablePush, pushPlace, pushState, subscribePush, testPush } from "../pushclient";
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

/** The device tab's notifications row. Turning either switch on asks the
 *  browser for permission, since a page may only ask in answer to a click.
 *  The second switch is web push (FR-042): the home backend pushes what
 *  waits on you to this browser when no page of yours is open. */
export function NotifyRow() {
  const on = useStore((s) => s.settings.notify);
  const pushOn = useStore((s) => s.settings.push);
  const setSetting = useStore((s) => s.setSetting);
  const [permission, setPermission] = useState<Permission>(permissionNow);
  const why = whyNot(on, permission);
  const push = useSyncExternalStore(subscribePush, pushState);
  const pushWhy = pushWhyNot(pushPlace(pushOn, push));
  const subscribed = pushOn && push.mine !== null && pushWhy === null;

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

  const togglePush = (next: boolean) => {
    setSetting("push", next);
    void (next ? enablePush() : disablePush()).then(() => setPermission(permissionNow()));
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
      <label className="settings-line">
        <input type="checkbox" checked={pushOn} disabled={push.busy} onChange={(e) => togglePush(e.target.checked)} />
        push when the page is closed
      </label>
      <p className="settings-hint">
        A new ask, a run that failed, a branch sent back, a check that gave up, a trigger that needs you: the home backend pushes it to this browser when no page of yours is open. A push carries a title and a link, never a token.
      </p>
      {pushWhy && (
        <p className="settings-hint">
          {pushWhy}
          {pushWhy === PUSH_WORDS.stale && <> <button type="button" className="mini" disabled={push.busy} onClick={() => { void enablePush(true); }}>resubscribe</button></>}
        </p>
      )}
      {subscribed && push.mine && (
        <p className="settings-hint">
          Subscribed as {push.mine.device || "this browser"} on {push.mine.backend}.{" "}
          <button type="button" className="mini" disabled={push.busy} onClick={() => { void testPush(); }}>send a test</button>
          {push.tested && <> {push.tested}.</>}
        </p>
      )}
      {push.error && <p className="settings-hint error">{push.error}</p>}
    </section>
  );
}
