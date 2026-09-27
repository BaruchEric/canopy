import { useEffect, useRef, useState } from "react";
import { homeConn, useStore } from "../store";
import { useFitPop } from "../pop";

/** "2m", "3h", "2d": how long ago a kept shell was last written out */
function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * The shells a machine going down left behind. The chip is there only when
 * there are some; each one restores into a new shell at the same repo, under
 * the same name, with what it printed ahead of it. A shell that had Claude in it can be
 * restored with `claude --continue` typed into it, which picks the
 * conversation back up. The processes themselves are gone; this restores
 * the terminal, not what was running in it.
 */
export function KeptShells() {
  const kept = useStore((s) => s.kept);
  const keeping = useStore((s) => homeConn(s).keeping);
  const repos = useStore((s) => s.repos);
  const restoreShell = useStore((s) => s.restoreShell);
  const forgetShell = useStore((s) => s.forgetShell);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);

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

  if (kept.length === 0 && !open) return null;

  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? id;
  const run = async (id: string, what: () => Promise<void>) => {
    setBusy(id);
    setError("");
    try {
      await what();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="settings kept" ref={ref}>
      <button
        type="button"
        className={open ? "mini on" : "mini"}
        aria-label="Shells from before"
        aria-expanded={open}
        title={`${kept.length} shell${kept.length === 1 ? "" : "s"} from before this backend went down`}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">⟲</span> {kept.length}
      </button>
      {open && (
        <div className="settings-pop kept-pop" role="dialog" aria-label="Shells from before">
          <section className="settings-row">
            <h3 className="panel-label">shells from before</h3>
            {kept.length === 0 ? (
              <p className="settings-hint">Nothing was left behind.</p>
            ) : (
              <ul className="kept-list">
                {kept.map((k) => (
                  <li key={k.id} className="kept-shell">
                    <span className="kept-where">
                      {repoName(k.repoId)}
                      <span className="kept-fact">
                        {ago(k.savedAt, now)} · {k.lines} line{k.lines === 1 ? "" : "s"}
                        {k.agent && ` · ${k.agent} was running`}
                      </span>
                    </span>
                    <span className="kept-acts">
                      <button type="button" className="mini" disabled={busy === k.id} onClick={() => void run(k.id, () => restoreShell(k.id))}>
                        restore
                      </button>
                      {k.agent === "claude" && (
                        <button
                          type="button"
                          className="mini"
                          disabled={busy === k.id}
                          title="Restores the shell and runs claude --continue in it"
                          onClick={() => void run(k.id, () => restoreShell(k.id, true))}
                        >
                          restore + continue
                        </button>
                      )}
                      <button type="button" className="mini" disabled={busy === k.id} onClick={() => void run(k.id, () => forgetShell(k.id))}>
                        forget
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {error && <p className="settings-hint error">{error}</p>}
            <p className="settings-hint">
              A restored shell is a new shell at the same repo, under the same name, with what the old one printed ahead of it. The processes that were
              in it are gone: a shell that had Claude in it is offered a <code>claude --continue</code>, which picks the conversation back up.
              {!keeping && " Recording is off, so nothing new is being kept; settings has the switch."}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
