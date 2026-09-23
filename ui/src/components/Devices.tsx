import { useEffect, useRef, useState } from "react";
import { clientId } from "../client";
import { useStore } from "../store";
import { useFitPop } from "../pop";
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

/** the shells a device has a socket on, by their repo's name */
function shellsOf(d: Device, shells: TermInfo[], repoName: (id: string) => string): string[] {
  return shells.filter((t) => t.viewers.includes(d.name)).map((t) => repoName(t.repoId));
}

/**
 * The devices chip in the top bar: how many browsers are on the backend,
 * and, open, each one with its platform, how long it has been on, how many
 * windows, and the shells it is looking at. This browser is marked. Best
 * effort: it comes off the event stream, so a device shows for as long as
 * its stream is open and goes a beat after it closes.
 */
export function DevicesChip() {
  const devices = useStore((s) => s.devices);
  const shells = useStore((s) => s.shells);
  // the repos array itself: a selector that mapped it to tuples would hand
  // useShallow new tuples every time and re-render without end (React #185)
  const repos = useStore((s) => s.repos);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);
  const me = clientId();

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(tick);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? id;
  const others = devices.filter((d) => d.id !== me).length;

  return (
    <div className="settings devices" ref={ref}>
      <button
        type="button"
        className={open ? "mini on" : "mini"}
        aria-label="Devices on this backend"
        aria-expanded={open}
        title={others ? `${others} other ${others === 1 ? "device" : "devices"} on this backend` : "Only this browser is on the backend"}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">⌘</span> {devices.length || 1}
      </button>
      {open && (
        <div className="settings-pop devices-pop" role="dialog" aria-label="Devices">
          <section className="settings-row">
            <h3 className="panel-label">devices</h3>
            {devices.length === 0 ? (
              <p className="settings-hint">The backend has not said who is on yet.</p>
            ) : (
              <ul className="devices-list">
                {devices.map((d) => {
                  const on = shellsOf(d, shells, repoName);
                  return (
                    <li key={d.id} className={d.id === me ? "device me" : "device"}>
                      <span className="device-name">
                        {d.name}
                        {d.id === me && <span className="device-tag">this browser</span>}
                      </span>
                      <span className="device-fact">
                        {PLATFORM[d.platform] ?? d.platform} · {ago(d.since, now)}
                        {d.streams > 1 && ` · ${d.streams} windows`}
                      </span>
                      {on.length > 0 && <span className="device-fact">in a shell at {on.join(", ")}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="settings-hint">
              Every browser on the backend, by the name it gave itself (settings, "this device"). A shell opened on one shows on the others as a tab.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
