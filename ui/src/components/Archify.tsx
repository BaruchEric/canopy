import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { ago } from "../util";
import { Section, useSectionClosed } from "./Surface";
import { FullButton } from "./Floorplan";
import { ARCHIFY_TYPES, archifyHead, archifyLine, checksWord, typeWord, type ArchifyDiagram, type ArchifyInfo, type ArchifyPick } from "../../../src/core/archify";
import { isRunActive, type Repo } from "../../../src/core/types";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** a unix-ms time in the page's own words ("3h ago") */
const agoMs = (ms: number): string => ago(ms / 1000);

/** how often the list is read again while a diagram run goes */
const RUN_EVERY = 8000;

/** What a diagram's frame may do: run its own scripts, save its exports
 *  and open its source links in a tab. Never `allow-same-origin`: the page
 *  runs at an opaque origin, so it cannot reach canopy's storage, cookies
 *  or API, whoever wrote it. */
export const FRAME_SANDBOX = "allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox";

/** A removal asked for twice: the first press arms the button for a few
 *  seconds. `what` names the folder that goes, for the button's titles. */
export function RemoveButton({ busy, onRemove, what = "the diagram's folder" }: { busy: boolean; onRemove: () => void; what?: string }) {
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const t = setTimeout(() => setSure(false), 4000);
    return () => clearTimeout(t);
  }, [sure]);
  return (
    <button
      type="button"
      className={sure ? "mini confirm" : "mini"}
      disabled={busy}
      title={sure ? `Press again to remove ${what} for good` : `Remove ${what} under .archify`}
      onClick={() => (sure ? onRemove() : setSure(true))}
    >
      {sure ? "remove for good" : "remove"}
    </button>
  );
}

/** Saves a page as a file of its own: a download, never a navigation, so
 *  its scripts do not run at canopy's origin. */
export function savePage(html: string, file: string): void {
  const href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = href;
  a.download = file;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

function DiagramRow({ d, on, pick }: { d: ArchifyDiagram; on: boolean; pick: () => void }) {
  return (
    <li>
      <button type="button" className={`arch-item${on ? " on" : ""}`} aria-current={on ? "true" : undefined} onClick={pick} title={`.archify/${d.id}/${d.file}`}>
        <span className="arch-title">{d.title ?? d.id}</span>
        <span className="arch-meta">
          {typeWord(d.type)} · {agoMs(d.builtAt)} · <span className={d.checks === "fail" ? "arch-bad" : undefined}>{checksWord(d.checks)}</span>
          {d.tracked ? " · in git" : ""}
        </span>
      </button>
    </li>
  );
}

/**
 * The map section's diagrams (FR-071): canopy's copy of Archify, drawn by a
 * Claude run into the repo's own `.archify/` and shown here in a sandboxed
 * frame. Lists the diagrams, starts the run that draws or revises one,
 * shows one, saves its page as a file and removes it. `kinds` is the
 * map's kind switch, which sits at the top of the body.
 */
export function ArchifyMap({ repo, kinds }: { repo: Repo; kinds: ReactNode }) {
  const closed = useSectionClosed(repo.id, "map");
  const [info, setInfo] = useState<ArchifyInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"make" | "revise" | "remove" | null>(null);
  const [type, setType] = useState<ArchifyPick>("auto");
  const [note, setNote] = useState("");
  const [change, setChange] = useState("");
  // the diagram chosen in the list; null shows the newest
  const [picked, setPicked] = useState<string | null>(null);
  // the shown page, keyed by its folder and build time so a revise reloads it
  const [page, setPage] = useState<{ key: string; html: string } | null>(null);
  const showRun = useStore((s) => s.showRun);
  const runId = info?.run ?? null;
  const run = useStore((s) => (runId ? s.runs[runId] : undefined));
  const going = runId !== null && (run === undefined || isRunActive(run));

  const load = useCallback(
    () =>
      api.archify(repo.id).then(
        (got) => {
          setInfo(got);
          setError(null);
        },
        (e: unknown) => setError(errText(e)),
      ),
    [repo.id],
  );
  useEffect(() => {
    if (!closed) void load();
  }, [closed, load]);

  // while a run goes, read again now and then; when it ends, once more
  useEffect(() => {
    if (closed || !going) return;
    const timer = setInterval(() => void load(), RUN_EVERY);
    return () => {
      clearInterval(timer);
      void load();
    };
  }, [closed, going, load]);

  const diagrams = info?.diagrams ?? [];
  const shown = diagrams.find((d) => d.id === picked) ?? diagrams[0] ?? null;
  const key = shown ? `${shown.id}@${shown.builtAt}` : null;
  const pageKey = page?.key ?? null;

  // the shown diagram's page, fetched when it or its build changes
  useEffect(() => {
    if (closed || key === null || !shown || pageKey === key) return;
    let live = true;
    api.archifyPage(repo.id, shown.id).then(
      (html) => {
        if (live) setPage({ key, html });
      },
      (e: unknown) => {
        if (live) setError(errText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [closed, key, pageKey, shown, repo.id]);

  const start = (body: { type: ArchifyPick; note: string } | { diagram: string; note: string }) => {
    setBusy("diagram" in body ? "revise" : "make");
    setError(null);
    api
      .archifyStart(repo.id, body)
      .then((r) => {
        if ("diagram" in body) setChange("");
        else {
          setNote("");
          // the new diagram is the newest, which the list shows once it lands
          setPicked(null);
        }
        setInfo((i) => (i ? { ...i, run: r.id } : i));
        showRun(r.id);
      })
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setBusy(null));
  };

  const remove = (id: string) => {
    setBusy("remove");
    setError(null);
    api
      .archifyRemove(repo.id, id)
      .then(() => {
        // off the list at once, so the frame does not ask for its page again
        setInfo((i) => (i ? { ...i, diagrams: i.diagrams.filter((d) => d.id !== id) } : i));
        setPicked(null);
        setPage(null);
        return load();
      })
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setBusy(null));
  };

  const html = page && page.key === key ? page.html : null;
  return (
    <Section
      repo={repo}
      k="map"
      className="map"
      label="Map"
      head={archifyHead(info ? { ...info, run: going ? runId : null } : null)}
      title="Checked, interactive diagrams of the code, drawn by Claude with Archify"
      noCapture={html ? "The diagram is a sandboxed frame, which a capture cannot see into" : undefined}
      tools={(m, setM) => (html ? <FullButton mode={m} setMode={setM} what="diagram" /> : null)}
    >
      <div className="map-body">
        {kinds}
        <p className="map-line">
          <span>{info ? archifyLine(info, agoMs) : "reading the diagrams…"}</span>
          {going && runId && (
            <button type="button" className={`mini${run?.status === "waiting" ? " strong" : ""}`} onClick={() => showRun(runId)} title="The run drawing the diagram, where its questions wait">
              {run?.status === "waiting" ? "the run is waiting on you" : "drawing now: see the run"}
            </button>
          )}
        </p>
        {!going && (
          <div className="map-start">
            <select className="arch-type" value={type} aria-label="What kind of diagram" title="What kind of diagram; auto lets Claude choose from your note" onChange={(e) => setType(e.target.value === "auto" ? "auto" : (ARCHIFY_TYPES.find((t) => t === e.target.value) ?? "auto"))}>
              <option value="auto">auto</option>
              {ARCHIFY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t === "explainer" ? "one-page explainer" : typeWord(t)}
                </option>
              ))}
            </select>
            <input
              className="map-note"
              type="text"
              value={note}
              placeholder="what to draw (optional: the repo's architecture)"
              aria-label="What the diagram should show"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && busy === null) start({ type, note: note.trim() });
              }}
            />
            <button
              type="button"
              className={diagrams.length ? "mini" : "mini strong"}
              disabled={busy !== null}
              onClick={() => start({ type, note: note.trim() })}
              title="Claude reads the code and draws a checked, interactive diagram with Archify into .archify/, which stays out of git"
            >
              {busy === "make" ? "starting…" : "draw"}
            </button>
          </div>
        )}
        {diagrams.length > 0 && (
          <ul className="arch-list" aria-label="Diagrams">
            {diagrams.map((d) => (
              <DiagramRow key={d.id} d={d} on={d.id === shown?.id} pick={() => setPicked(d.id)} />
            ))}
          </ul>
        )}
        {shown && (
          <div className="map-acts">
            {!going && (
              <>
                <input
                  className="map-note"
                  type="text"
                  value={change}
                  placeholder="what to change in this diagram"
                  aria-label="What to change in the diagram shown"
                  onChange={(e) => setChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && busy === null && change.trim()) start({ diagram: shown.id, note: change.trim() });
                  }}
                />
                <button type="button" className="mini" disabled={busy !== null || !change.trim()} onClick={() => start({ diagram: shown.id, note: change.trim() })} title="Claude edits this diagram as your words say and checks it again">
                  {busy === "revise" ? "starting…" : "revise"}
                </button>
              </>
            )}
            <button type="button" className="mini" disabled={html === null} onClick={() => html !== null && savePage(html, shown.file)} title="Save the diagram as one HTML file, which opens in any browser">
              save the file
            </button>
            {!going && !shown.tracked && <RemoveButton busy={busy !== null} onRemove={() => remove(shown.id)} />}
          </div>
        )}
        {error && (
          <p className="map-error" role="alert">
            {error}
          </p>
        )}
        {shown && (
          <div className="map-frame-wrap">
            {html !== null ? (
              <iframe key={key} className="map-frame" sandbox={FRAME_SANDBOX} referrerPolicy="no-referrer" srcDoc={html} title={shown.title ?? shown.id} />
            ) : (
              <p className="arch-loading">loading the diagram…</p>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}
