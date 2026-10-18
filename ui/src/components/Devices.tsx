import { useEffect, useState } from "react";
import { clientId } from "../client";
import { backendOf, plainOf } from "../registry";
import { idText, useStore } from "../store";
import { BackendWord } from "./IdLabel";
import type { Device, TermInfo } from "../../../src/core/types";

/** what a device's platform word reads as in the list */
const PLATFORM: Record<string, string> = {
  mac: "Mac",
  android: "Android",
  windows: "Windows",
  linux: "Linux",
  ios: "iPhone",
  other: "browser",
};

/** "2m", "3h", "2d": how long a device has been on */
function ago(since: number, now: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** the repos a device has a socket on a shell at, on the device's own
 *  backend: two backends' devices can share a display name, so the match
 *  never crosses backends. */
function shellsOf(d: Device, shells: TermInfo[]): string[] {
  const b = backendOf(d.id);
  return shells.filter((t) => backendOf(t.id) === b && t.viewers.includes(d.name)).map((t) => t.repoId);
}

/** How many browsers are on the backend, this one counted when the stream
 *  has not said yet. */
export function useDeviceCount(): number {
  return useStore((s) => s.devices.length) || 1;
}

/**
 * The devices section of the backend menu: each browser on the backend with
 * its platform, how long it has been on, how many windows, and the shells it
 * is looking at. This browser is marked. Best effort: it comes off the event
 * stream, so a device shows for as long as its stream is open and goes a
 * beat after it closes.
 */
export function DevicesSection() {
  const devices = useStore((s) => s.devices);
  const shells = useStore((s) => s.shells);
  // the repos array itself: a selector that mapped it to tuples would hand
  // useShallow new tuples every time and re-render without end (React #185)
  const repos = useStore((s) => s.repos);
  const [now, setNow] = useState(() => Date.now());
  const me = clientId();

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? idText(id);

  return (
    <section className="settings-row">
      <h3 className="panel-label">devices</h3>
      {devices.length === 0 ? (
        <p className="settings-hint">The backend has not said who is on yet.</p>
      ) : (
        <ul className="devices-list">
          {devices.map((d) => {
            const on = shellsOf(d, shells);
            const mine = plainOf(d.id) === me;
            return (
              <li key={d.id} className={mine ? "device me" : "device"}>
                <span className="device-name">
                  {d.name}
                  <BackendWord id={d.id} />
                  {mine && <span className="device-tag">this browser</span>}
                </span>
                <span className="device-fact">
                  {PLATFORM[d.platform] ?? d.platform} · {ago(d.since, now)}
                  {d.streams > 1 && ` · ${d.streams} windows`}
                </span>
                {on.length > 0 && (
                  <span className="device-fact">
                    in a shell at{" "}
                    {on.map((id, i) => (
                      <span key={id}>
                        {i > 0 && ", "}
                        {repos.some((r) => r.id === id) ? (
                          <>
                            {repoName(id)}
                            <BackendWord id={id} />
                          </>
                        ) : (
                          idText(id)
                        )}
                      </span>
                    ))}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="settings-hint">
        Every browser on the backend, by the name it gave itself (settings, "this device"). A shell opened on one shows on the others as a tab.
      </p>
    </section>
  );
}
