import { useEffect, useRef, useState } from "react";
import { hasOtherBackend, signinUrl } from "../backends";
import { sameBuild } from "../../../src/core/version";
import { PAGE_BUILD } from "../build";
import { connOf, useStore } from "../store";
import { useFitPop } from "../pop";

/** what a backend's state reads as in the popover */
const STATE_WORD: Record<string, string> = {
  connecting: "connecting",
  online: "online",
  offline: "offline",
  signin: "sign in",
};

/**
 * The backends chip in the top bar: one word per backend this page shows,
 * rust for any state but online (the way `PeersChip` marks an unreachable
 * peer). Open, it lists every backend the home one named, hidden ones
 * included: its state, why it is offline, the URL this page uses for it, a
 * version note when it runs another build, a retry for a non-home backend
 * that is not online, a sign-in link when the gate asked for one, and the
 * "show here" checkbox that hides it or brings it back. Gated on the
 * registry (home named at least one other backend), not on how many are
 * currently shown, so hiding the last other backend cannot also hide the
 * one control that un-hides it. Absent with one backend.
 */
export function BackendsChip() {
  const home = useStore((s) => s.home);
  const backendOrder = useStore((s) => s.backendOrder);
  const entries = useStore((s) => s.settings.backends);
  const conns = useStore((s) => s.conns);
  const retryBackend = useStore((s) => s.retryBackend);
  const hideBackend = useStore((s) => s.hideBackend);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // gated on the registry, not on backendOrder (how many are shown): hiding
  // the only other backend must not also hide the one control that can
  // bring it back, so the chip stays up as long as home named one other
  // than itself
  if (!hasOtherBackend(entries, home)) return null;

  // every backend the home one named, home first, hidden ones included:
  // a hidden one has no entry in conns (hideBackend drops it) or in
  // backendOrder, so it is told apart by name alone
  const names = [home, ...entries.map((e) => e.name).filter((n) => n !== home)];

  return (
    <div className="settings backends" ref={ref}>
      <button
        type="button"
        className={open ? "mini backends-tags on" : "mini backends-tags"}
        aria-label="Backends"
        aria-expanded={open}
        title="Every backend this page talks to"
        onClick={() => setOpen(!open)}
      >
        {backendOrder.map((name) => {
          const online = (conns[name]?.status.state ?? "connecting") === "online";
          return (
            <span key={name} className={online ? "backend-tag" : "backend-tag offline"}>
              {name}
            </span>
          );
        })}
      </button>
      {open && (
        <div className="settings-pop backends-pop" role="dialog" aria-label="Backends">
          <section className="settings-row">
            <h3 className="panel-label">backends</h3>
            <ul className="backends-list">
              {names.map((name) => {
                const shown = backendOrder.includes(name);
                const conn = connOf({ conns, home }, name);
                const status = conn.status;
                const stale = Boolean(shown && conn.about && PAGE_BUILD && !sameBuild(PAGE_BUILD, conn.about));
                return (
                  <li key={name} className="backend-row">
                    <span className="backend-main">
                      <span className="backend-name">{name}</span>
                      <span className={shown && status.state === "online" ? "backend-state" : "backend-state offline"}>
                        {shown ? (STATE_WORD[status.state] ?? status.state) : "hidden"}
                      </span>
                    </span>
                    {shown && <span className="backend-fact">{name === home ? "this page" : conn.base || "no url yet"}</span>}
                    {shown && status.reason && <span className="backend-fact">{status.reason}</span>}
                    {stale && <span className="backend-fact">another build</span>}
                    <span className="backend-acts">
                      {shown && name !== home && status.state !== "online" && (
                        <button type="button" className="mini" onClick={() => void retryBackend(name)}>
                          retry
                        </button>
                      )}
                      {shown && status.state === "signin" && status.login && (
                        <a href={signinUrl(status.login, conn.base)} target="_blank" rel="noreferrer" className="mini">
                          sign in
                        </a>
                      )}
                      <label className="settings-line">
                        <input
                          type="checkbox"
                          checked={shown}
                          disabled={name === home}
                          onChange={(e) => hideBackend(name, !e.target.checked)}
                        />
                        show here
                      </label>
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="settings-hint">
              Every backend the home one named. Unchecking one hides its checkouts and shells here; the backend itself keeps running.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
