import { useEffect, useRef, useState } from "react";
import { escapeCloses } from "../surface";
import { homeConn, idParts, useStore } from "../store";
import { registry } from "../registry";
import { useFitPop } from "../pop";
import { eachOf, keptByBackend, newestFirst, restorePlan, stillPicked } from "../kept";

/** "2m", "3h", "2d": how long ago a kept shell was last written out */
function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** the backend a kept shell is on, home included */
const ownerOf = (id: string): string => idParts(id)[0];

/** what a busy row or the whole list is doing: a shell's id, or every pick */
const ALL = "*";

/**
 * The shells a machine going down left behind. The chip is there only when
 * there are some; each one restores into a new shell at the same repo, under
 * the same name, with what it printed ahead of it. A shell that had an agent in it
 * can be restored with the agent's continue typed into it (`claude
 * --continue`, `codex resume --last`), which picks the conversation back up. The processes themselves are gone; this restores
 * the terminal, not what was running in it. The list runs newest first
 * across backends, tags each row with its backend when there is more than
 * one, and takes picks: restore, continue or forget every picked shell at once.
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
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [asking, setAsking] = useState(false);
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
      escapeCloses(e, () => setOpen(false));
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(tick);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // a closed popover forgets its picks and any forget it was asking about
  useEffect(() => {
    if (open) return;
    setPicked(new Set());
    setAsking(false);
  }, [open]);

  if (kept.length === 0 && !open) return null;

  const list = newestFirst(kept);
  const chosen = stillPicked(list, picked);
  const backends = keptByBackend(list, ownerOf);
  const tagged = registry().names.length > 1;
  const anyAgent = chosen.some((k) => k.agent !== null);
  const allPicked = list.length > 0 && chosen.length === list.length;

  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? idParts(id)[1];
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
  const runAll = async (act: (id: string) => Promise<void>, ids: string[]) => {
    setBusy(ALL);
    setError("");
    const failed = await eachOf(ids, act);
    if (failed) setError(failed);
    setPicked(new Set());
    setAsking(false);
    setBusy("");
  };
  const restoreAll = (resume: boolean) => {
    const plan = new Map(restorePlan(chosen, resume).map((p) => [p.id, p.resume]));
    void runAll((id) => restoreShell(id, plan.get(id) ?? false), [...plan.keys()]);
  };
  const forgetAll = () => void runAll(forgetShell, chosen.map((k) => k.id));

  const toggle = (id: string) => {
    setAsking(false);
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const pick = (ids: string[]) => {
    setAsking(false);
    setPicked(new Set(ids));
  };
  const onlyOn = (b: string) => list.filter((k) => ownerOf(k.id) === b).map((k) => k.id);
  const pickedOn = (b: string) => {
    const ids = onlyOn(b);
    return ids.length > 0 && ids.length === chosen.length && chosen.every((k) => ownerOf(k.id) === b);
  };
  const locked = busy !== "";

  return (
    <div className="settings kept" ref={ref}>
      <button
        type="button"
        className={open ? "mini kept-chip on" : "mini kept-chip"}
        aria-label="Shells from before"
        aria-expanded={open}
        title={`${kept.length} shell${kept.length === 1 ? "" : "s"} from before this backend went down`}
        onClick={() => setOpen(!open)}
      >
        <svg
          className="kept-glyph"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 7v5l4 2" />
        </svg>
        {kept.length}
      </button>
      {open && (
        <div className="settings-pop kept-pop" role="dialog" aria-label="Shells from before">
          <section className="settings-row">
            <h3 className="panel-label">shells from before</h3>
            {list.length === 0 ? (
              <p className="settings-hint">Nothing was left behind.</p>
            ) : (
              <>
                <div className="kept-bar">
                  <label className="kept-all">
                    <input
                      type="checkbox"
                      checked={allPicked}
                      ref={(el) => {
                        if (el) el.indeterminate = chosen.length > 0 && !allPicked;
                      }}
                      disabled={locked}
                      onChange={() => pick(allPicked ? [] : list.map((k) => k.id))}
                    />
                    {chosen.length > 0 ? `${chosen.length} picked` : "pick all"}
                  </label>
                  {tagged && backends.length > 1 && (
                    <span className="kept-by">
                      {backends.map((b) => (
                        <button
                          key={b.name}
                          type="button"
                          className={pickedOn(b.name) ? "mini on" : "mini"}
                          disabled={locked}
                          title={`Pick only the ${b.count} on ${b.name}`}
                          onClick={() => pick(pickedOn(b.name) ? [] : onlyOn(b.name))}
                        >
                          {b.name} {b.count}
                        </button>
                      ))}
                    </span>
                  )}
                </div>
                {chosen.length > 0 && (
                  <div className="kept-acts kept-bulk">
                    {asking ? (
                      <>
                        <span className="layout-ask">
                          forget {chosen.length} shell{chosen.length === 1 ? "" : "s"} and {chosen.length === 1 ? "its" : "their"} history?
                        </span>
                        <button type="button" className="mini confirm" disabled={locked} onClick={forgetAll}>
                          forget
                        </button>
                        <button type="button" className="mini" disabled={locked} onClick={() => setAsking(false)}>
                          keep
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="mini" disabled={locked} onClick={() => restoreAll(false)}>
                          restore {chosen.length}
                        </button>
                        {anyAgent && (
                          <button
                            type="button"
                            className="mini"
                            disabled={locked}
                            title="Restores every picked shell and types the agent's continue into the ones that had an agent"
                            onClick={() => restoreAll(true)}
                          >
                            restore + continue
                          </button>
                        )}
                        <button type="button" className="mini" disabled={locked} onClick={() => setAsking(true)}>
                          forget {chosen.length}
                        </button>
                        <button type="button" className="mini" disabled={locked} onClick={() => pick([])}>
                          clear
                        </button>
                      </>
                    )}
                  </div>
                )}
                <ul className="kept-list">
                  {list.map((k) => {
                    return (
                      <li key={k.id} className={picked.has(k.id) ? "kept-shell on" : "kept-shell"}>
                        <input
                          type="checkbox"
                          className="kept-pick"
                          aria-label={`Pick ${repoName(k.repoId)}`}
                          checked={picked.has(k.id)}
                          disabled={locked}
                          onChange={() => toggle(k.id)}
                        />
                        <span className="kept-where">
                          <span>
                            {repoName(k.repoId)}
                            {tagged && <span className="backend-word">{ownerOf(k.id)}</span>}
                          </span>
                          <span className="kept-fact">
                            {ago(k.savedAt, now)} · {k.lines} line{k.lines === 1 ? "" : "s"}
                            {k.agent && ` · ${k.agent} was running`}
                          </span>
                        </span>
                        <span className="kept-acts">
                          <button type="button" className="mini" disabled={locked} onClick={() => void run(k.id, () => restoreShell(k.id))}>
                            restore
                          </button>
                          {k.agent && (
                            <button
                              type="button"
                              className="mini"
                              disabled={locked}
                              title={`Restores the shell and runs ${k.agent === "codex" ? "codex resume --last" : "claude --continue"} in it`}
                              onClick={() => void run(k.id, () => restoreShell(k.id, true))}
                            >
                              restore + continue
                            </button>
                          )}
                          <button type="button" className="mini" disabled={locked} onClick={() => void run(k.id, () => forgetShell(k.id))}>
                            forget
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {error && <p className="settings-hint error">{error}</p>}
            <p className="settings-hint">
              A restored shell is a new shell at the same repo, under the same name, with what the old one printed ahead of it. The processes that were
              in it are gone: a shell that had an agent in it is offered its continue (<code>claude --continue</code>, <code>codex resume --last</code>),
              which picks the conversation back up.
              {!keeping && " Recording is off, so nothing new is being kept; settings has the switch."}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
