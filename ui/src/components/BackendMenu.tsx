import { useEffect, useRef, useState } from "react";
import { hasOtherBackend } from "../backends";
import { onBeat } from "../live";
import { seenWord } from "../peers";
import { HANGS_RIGHT, useFitPop } from "../pop";
import { PopGrip } from "./PopGrip";
import { homeConn, useStore } from "../store";
import { escapeCloses } from "../surface";
import { BackendTags, BackendsSection } from "./Backends";
import { DevicesSection, useDeviceCount } from "./Devices";
import { Caret } from "./PickMenu";

/** What the live light says, in its tooltip and at the head of the menu. */
function liveWord(state: string, reason: string | undefined): string {
  if (state === "online") return "live: changes show as they happen";
  if (state === "connecting") return "connecting to the backend…";
  if (state === "signin") return "sign in to the backend";
  return `offline${reason ? `: ${reason}` : ""}; showing what it last said`;
}

/** The home backend's stream, as one light: moss while it is live, and a
 *  flash on every event it sends, so a change that lands off screen still
 *  shows that the page heard it. Rust when the stream is down. */
export function LiveDot() {
  const state = useStore((s) => homeConn(s).status.state);
  const reason = useStore((s) => homeConn(s).status.reason);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      onBeat(() => {
        const el = ref.current;
        if (!el) return;
        // restart the flash: drop the class, let a frame see it gone, add it
        el.classList.remove("beat");
        void el.offsetWidth;
        el.classList.add("beat");
      }),
    [],
  );
  const word = liveWord(state, reason);
  return (
    <span ref={ref} className={`live-dot ${state}`} role="status" title={word} aria-label={word}>
      <i aria-hidden="true" />
    </span>
  );
}

/**
 * The backend as one control: the live light and the name of each backend
 * this page shows (rust while one is not online), and a peer this backend
 * could not reach, rust, until it can. Open, it says the stream's state,
 * then the backends with their switches, the peers the last pass reached,
 * and the browsers on the backend. These were four chips, read rarely and
 * side by side; the light and the names are what is worth a glance.
 */
export function BackendMenu() {
  const home = useStore((s) => s.home);
  const entries = useStore((s) => s.settings.backends);
  const peerSeen = useStore((s) => s.peerSeen);
  const state = useStore((s) => homeConn(s).status.state);
  const reason = useStore((s) => homeConn(s).status.reason);
  const devices = useDeviceCount();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      escapeCloses(e, () => setOpen(false));
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const several = hasOtherBackend(entries, home);
  const lost = peerSeen.filter((p) => !p.ok);
  const title = [
    liveWord(state, reason),
    `${devices} ${devices === 1 ? "browser" : "browsers"} on the backend`,
    ...peerSeen.map(seenWord),
  ].join("\n");
  return (
    <div className="settings backend-menu" ref={ref}>
      <button
        type="button"
        className={open ? "pill pick-btn backend-btn open" : "pill pick-btn backend-btn"}
        aria-label="Backend: the live stream, backends, peers and devices"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={title}
        onClick={() => setOpen(!open)}
      >
        <LiveDot />
        <span className="backend-names">{several ? <BackendTags /> : <span className="backend-tag">{home || "backend"}</span>}</span>
        {lost.map((p) => (
          <span key={p.name} className="backend-tag offline" title={seenWord(p)}>
            {p.name}
          </span>
        ))}
        <Caret />
      </button>
      {open && (
        <div className="settings-pop backend-pop" role="dialog" aria-label="Backend">
          <section className="settings-row">
            <h3 className="panel-label">stream</h3>
            <p className={state === "online" ? "settings-hint" : "settings-hint error"}>{liveWord(state, reason)}</p>
          </section>
          <BackendsSection />
          {peerSeen.length > 0 && (
            <section className="settings-row">
              <h3 className="panel-label">peers</h3>
              <ul className="peers-list">
                {peerSeen.map((p) => (
                  <li key={p.name} className={p.ok ? "peer-seen" : "peer-seen offline"}>
                    {seenWord(p)}
                  </li>
                ))}
              </ul>
              <p className="settings-hint">What this backend pulls from, and when the last pass reached each.</p>
            </section>
          )}
          <DevicesSection />
          <PopGrip name="backend" anchor={HANGS_RIGHT} />
        </div>
      )}
    </div>
  );
}
