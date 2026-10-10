import { useEffect, useMemo, useRef, useState } from "react";
import { escapeCloses } from "../surface";
import { api } from "../api";
import { clientId } from "../client";
import { dockless, idText, useStore } from "../store";
import { useFitPop } from "../pop";
import { eachOf, stillPicked, unwatched } from "../kept";
import { BackendWord } from "./IdLabel";
import { HARNESS } from "../../../src/core/harness";
import type { AgentSession } from "../../../src/core/types";

/** "now", "5m", "3h", "2d": how long ago */
function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** what a busy row or the whole list is doing: a shell's id, or every pick */
const ALL = "*";

/**
 * The shells chip in the top bar: every shell the backend holds, whichever
 * device started it, to pick up here, and the Claude Code and Codex
 * conversations started at a repo on the backend, to pick back up in a new
 * shell by their own harness. A
 * shell's tab can be hidden here without ending it, which leaves it running
 * for the other devices and in this list. The running shells take picks:
 * join, hide here or end every picked shell at once.
 */
export function ShellsChip() {
  const shells = useStore((s) => s.shells);
  const terms = useStore((s) => s.terms);
  const hidden = useStore((s) => s.hiddenTerms);
  const repos = useStore((s) => s.repos);
  const activePanel = useStore((s) => s.activePanel);
  // this browser's name as the backend has it, to leave out of "on …"
  const me = useStore((s) => s.devices.find((d) => d.id === clientId())?.name ?? null);
  const joinTerm = useStore((s) => s.joinTerm);
  const hideTerm = useStore((s) => s.hideTerm);
  const closeTerm = useStore((s) => s.closeTerm);
  const resumeAgent = useStore((s) => s.resumeAgent);
  const chan = useStore((s) => s.chan);
  const openChan = useStore((s) => s.openChan);
  const loadChan = useStore((s) => s.loadChan);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [repoId, setRepoId] = useState("");
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [asking, setAsking] = useState(false);
  // a bulk action's failure, shown under the list it acted on
  const [pickError, setPickError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);

  // both harnesses only keep conversations for folders on the backend itself
  const local = useMemo(
    () => repos.filter((r) => !r.forge && !r.host).sort((a, b) => a.name.localeCompare(b.name)),
    [repos],
  );

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    setError("");
    // the repo showing in the dock is the one most likely meant
    setRepoId((id) => (local.some((r) => r.id === id) ? id : local.some((r) => r.id === activePanel) ? activePanel! : (local[0]?.id ?? "")));
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
    // the repo default is taken once per opening, not on every scan
  }, [open]);

  // a closed popover forgets its picks and any end it was asking about
  useEffect(() => {
    if (open) return;
    setPicked(new Set());
    setAsking(false);
    setPickError("");
  }, [open]);

  // who is listening, for the dots by each shell's handle
  useEffect(() => {
    if (open) void loadChan();
  }, [open, loadChan]);

  useEffect(() => {
    if (!open || !repoId) {
      setSessions(null);
      return;
    }
    let live = true;
    setSessions(null);
    api
      .agentSessions(repoId)
      .then((list) => live && setSessions(list))
      .catch((e: unknown) => {
        if (!live) return;
        setSessions([]);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [open, repoId]);

  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? idText(id);
  const here = new Set(terms.map((t) => t.id));
  const list = [...shells].sort((a, b) => b.startedAt - a.startedAt);
  const elsewhere = list.filter((t) => !here.has(t.id)).length;
  // a shell ended on another device drops out of the pick
  const chosen = stillPicked(list, picked);
  const chosenHere = chosen.filter((t) => here.has(t.id));
  const idle = unwatched(list).map((t) => t.id);
  const allPicked = list.length > 0 && chosen.length === list.length;
  const idlePicked = idle.length > 0 && chosen.length === idle.length && chosen.every((t) => t.viewers.length === 0);
  const canJoin = !dockless();
  const locked = busy !== "";

  const run = async (key: string, what: () => Promise<void> | void) => {
    setBusy(key);
    setError("");
    try {
      await what();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const runAll = async (act: (id: string) => Promise<void> | void, ids: string[], close: boolean) => {
    setBusy(ALL);
    setPickError("");
    const failed = await eachOf(ids, async (id) => act(id));
    if (failed) setPickError(failed);
    setPicked(new Set());
    setAsking(false);
    setBusy("");
    if (!failed && close) setOpen(false);
  };
  const endOne = async (id: string) => {
    if (here.has(id)) closeTerm(id);
    else await api.endTerm(id);
  };
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

  return (
    <div className="settings shells" ref={ref}>
      <button
        type="button"
        className={open ? "mini on" : "mini"}
        aria-label="Shells on this backend"
        aria-expanded={open}
        title={
          elsewhere
            ? `${list.length} shell${list.length === 1 ? "" : "s"} running, ${elsewhere} not open here`
            : "Shells on this backend, and agent conversations to pick back up"
        }
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">▸_</span> {list.length}
        {elsewhere > 0 && <span className="shells-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="settings-pop shells-pop" role="dialog" aria-label="Shells">
          <section className="settings-row">
            <h3 className="panel-label">running shells</h3>
            {list.length === 0 ? (
              <p className="settings-hint">No shell is running on the backend.</p>
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
                      onChange={() => pick(allPicked ? [] : list.map((t) => t.id))}
                    />
                    {chosen.length > 0 ? `${chosen.length} picked` : "pick all"}
                  </label>
                  {idle.length > 0 && idle.length < list.length && (
                    <button
                      type="button"
                      className={idlePicked ? "mini on" : "mini"}
                      disabled={locked}
                      title={`Pick only the ${idle.length} no device has open`}
                      onClick={() => pick(idlePicked ? [] : idle)}
                    >
                      nobody watching {idle.length}
                    </button>
                  )}
                </div>
                {chosen.length > 0 && (
                  <div className="kept-acts kept-bulk">
                    {asking ? (
                      <>
                        <span className="layout-ask">
                          end {chosen.length} shell{chosen.length === 1 ? "" : "s"} on every device?
                        </span>
                        <button
                          type="button"
                          className="mini confirm"
                          disabled={locked}
                          onClick={() => void runAll(endOne, chosen.map((t) => t.id), false)}
                        >
                          end
                        </button>
                        <button type="button" className="mini" disabled={locked} onClick={() => setAsking(false)}>
                          keep
                        </button>
                      </>
                    ) : (
                      <>
                        {canJoin && (
                          <button
                            type="button"
                            className="mini"
                            disabled={locked}
                            title="Opens every picked shell here as a tab"
                            onClick={() => void runAll(joinTerm, chosen.map((t) => t.id), true)}
                          >
                            join {chosen.length}
                          </button>
                        )}
                        {chosenHere.length > 0 && (
                          <button
                            type="button"
                            className="mini"
                            disabled={locked}
                            title="Takes the picked shells' tabs away here and leaves them running"
                            onClick={() => void runAll(hideTerm, chosenHere.map((t) => t.id), false)}
                          >
                            hide {chosenHere.length} here
                          </button>
                        )}
                        <button type="button" className="mini" disabled={locked} title="Ends every picked shell on every device" onClick={() => setAsking(true)}>
                          end {chosen.length}
                        </button>
                        <button type="button" className="mini" disabled={locked} onClick={() => pick([])}>
                          clear
                        </button>
                      </>
                    )}
                  </div>
                )}
                <ul className="shells-list">
                  {list.map((t) => {
                    const shown = here.has(t.id);
                    const others = t.viewers.filter((v) => v !== me);
                    const rowClass = ["shell-row", "picks", shown && "here", picked.has(t.id) && "on"].filter(Boolean).join(" ");
                    return (
                      <li key={t.id} className={rowClass}>
                        <input
                          type="checkbox"
                          className="kept-pick"
                          aria-label={`Pick ${repoName(t.repoId)}`}
                          checked={picked.has(t.id)}
                          disabled={locked}
                          onChange={() => toggle(t.id)}
                        />
                        <span className="kept-where">
                          {repoName(t.repoId)}
                          {repos.some((r) => r.id === t.repoId) && <BackendWord id={t.repoId} />}
                          <span className="kept-fact">
                            {t.place === "panel" ? "panel" : "strip"} · {ago(t.startedAt, now)}
                            {shown ? " · open here" : hidden.includes(t.id) ? " · hidden here" : ""}
                            {others.length > 0 && ` · on ${others.join(", ")}`}
                            {t.viewers.length === 0 && " · nobody watching"}
                          </span>
                          {t.handle && chan?.ready && (
                            <span className="kept-fact" title="The tailchan handle this shell runs under (TAILCHAN_AS)">
                              <span className={chan.who.some((w) => w.handle === t.handle && w.live) ? "chan-dot live" : "chan-dot"} /> @{t.handle}
                            </span>
                          )}
                        </span>
                        <span className="kept-acts">
                          <button type="button" className="mini" disabled={locked} onClick={() => void run(t.id, () => joinTerm(t.id))}>
                            {shown ? "show" : "join"}
                          </button>
                          {t.handle && chan?.ready && (
                            <button
                              type="button"
                              className="mini"
                              disabled={locked}
                              title={`A tailchan DM to @${t.handle}, whoever runs in the shell`}
                              onClick={() => {
                                setOpen(false);
                                openChan(`@${t.handle}`);
                              }}
                            >
                              message
                            </button>
                          )}
                          {shown && (
                            <button
                              type="button"
                              className="mini"
                              disabled={locked}
                              title="Takes the tab away here and leaves the shell running"
                              onClick={() => void run(t.id, () => hideTerm(t.id))}
                            >
                              hide here
                            </button>
                          )}
                          <button
                            type="button"
                            className="mini"
                            disabled={locked}
                            title="Ends the shell on every device"
                            onClick={() => {
                              if (!window.confirm(`End the shell at ${repoName(t.repoId)} on every device?`)) return;
                              void run(t.id, () => endOne(t.id));
                            }}
                          >
                            end
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {pickError && <p className="settings-hint error">{pickError}</p>}
          </section>
          <section className="settings-row">
            <h3 className="panel-label">agent conversations</h3>
            {local.length === 0 ? (
              <p className="settings-hint">No repo on the backend itself to look in.</p>
            ) : (
              <>
                <select className="settings-input" aria-label="Repo" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
                  {local.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                {sessions === null ? (
                  <p className="settings-hint">reading…</p>
                ) : sessions.length === 0 ? (
                  <p className="settings-hint">No agent conversation was started at {repoName(repoId)} on the backend.</p>
                ) : (
                  <ul className="shells-list">
                    {sessions.map((c) => (
                      <li key={`${c.harness}:${c.id}`} className="shell-row">
                        <span className="kept-where">
                          <span className="claude-prompt">
                            <span className={`harness-glyph h-${c.harness}`} title={HARNESS[c.harness].label} aria-label={HARNESS[c.harness].label}>
                              {HARNESS[c.harness].glyph}
                            </span>{" "}
                            {c.summary ?? c.prompt ?? "(nothing typed in its first part)"}
                          </span>
                          <span className="kept-fact">
                            {ago(c.at, now)}
                            {c.branch && ` · ${c.branch}`}
                            {` · ${Math.max(1, Math.round(c.size / 1024))} KB`}
                          </span>
                        </span>
                        <span className="kept-acts">
                          <button
                            type="button"
                            className="mini"
                            disabled={busy !== ""}
                            title={`A new shell at ${repoName(repoId)} running ${c.harness === "codex" ? "codex resume" : "claude --resume"} ${c.id}`}
                            onClick={() => void run(c.id, () => resumeAgent(repoId, c.id, c.harness))}
                          >
                            {busy === c.id ? "starting…" : "resume"}
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {error && <p className="settings-hint error">{error}</p>}
            <p className="settings-hint">
              Every shell runs on the backend, so any device can join one; ending it ends it everywhere, hiding it only takes it away here. A
              conversation resumes in a new shell by its own harness, with the repo's settings for it. Conversations started on another machine
              live there, not here.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
