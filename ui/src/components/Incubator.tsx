/**
 * The incubator: one card per new project with its stage strip, the
 * + project sheet that takes an idea in words, links, files, a voice memo
 * or a repo, and one project's sheet (intent, inputs, the chain of flows,
 * what it spent, and add input, stop, resume, dismiss).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { INPUT_FILE_MAX, inputKindOf, inputType, sizeWord } from "../../../src/core/sprout";
import { isVercelAppUrl } from "../../../src/core/deploy";
import type { SproutDetail } from "../../../src/core/types";
import { api } from "../api";
import { dropSproutHere, sproutHere } from "../routes";
import { INPUT_GLYPH, STAGES, needsYou, sortSprouts, sproutWord, stageStrip, type StageMark } from "../sprouts";
import { useStore } from "../store";
import { ago } from "../util";
import { InboxChip } from "./Inbox";
import { Questions } from "./Prompts";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);
/** the HTTP status `api` puts on its errors, when there is one */
const statusOf = (err: unknown): number | undefined =>
  typeof err === "object" && err !== null && "status" in err && typeof err.status === "number" ? err.status : undefined;

const MARK_WORD: Record<StageMark, string> = { done: "done", now: "in progress", stuck: "stopped here", todo: "not yet" };

export function NewProjectButton() {
  const ready = useStore((s) => s.sproutsReady);
  const open = useStore((s) => s.openNewSprout);
  if (!ready) return null;
  return (
    <button type="button" className="mini new-project" title="A new project from an idea, a link, a file, a voice memo or a repo (n)" onClick={open}>
      + project
    </button>
  );
}

function StageStrip({ id }: { id: string }) {
  const marks = useStore(useShallow((s) => {
    const sp = s.sprouts[id];
    return sp ? stageStrip(sp).map((x) => x.mark) : [];
  }));
  // stageStrip lists the stages in STAGES order, so a mark's index is its stage
  return (
    <ol className="stage-strip" aria-label="Stages">
      {marks.map((mark, i) => (
        <li key={STAGES[i]} className={`stage ${mark}`} title={`${STAGES[i]}: ${MARK_WORD[mark]}`}>
          {STAGES[i]}
        </li>
      ))}
    </ol>
  );
}

function SproutCard({ id }: { id: string }) {
  const s = useStore((st) => st.sprouts[id]);
  const show = useStore((st) => st.showSprout);
  if (!s) return null;
  return (
    <button type="button" className={`sprout-card${needsYou(s) ? " needs" : ""}`} onClick={() => show(s.id)}>
      <span className="sprout-head">
        <span className="sprout-title">{s.title}</span>
        <span className={`sprout-word st-${s.status}`}>{sproutWord(s)}</span>
      </span>
      <StageStrip id={s.id} />
      {s.parked && <span className="sprout-parked">{s.parked}</span>}
      <span className="sprout-meta">
        {s.inputs.length} {s.inputs.length === 1 ? "input" : "inputs"} · {s.spent.runs} {s.spent.runs === 1 ? "run" : "runs"} · {ago(s.updatedAt / 1000)}
      </span>
    </button>
  );
}

/** Whether the stages run isolated, the stage runner's container with no
 *  token of canopy's, or not; nothing from a backend too old to say. */
function StagesWord() {
  const stages = useStore((s) => s.stages);
  if (!stages) return null;
  return stages.isolated ? (
    <span className="stages-word" title="Stages run in the stages container through the stage runner (CANOPY_STAGE_SOCKET), where none of canopy's tokens are.">
      stages isolated
    </span>
  ) : (
    <span
      className="stages-word not"
      title="Stages are not isolated: either CANOPY_INCUBATOR_UNISOLATED=1 runs them here with canopy's tokens, or the stage runner (CANOPY_STAGE_SOCKET) is away or not set up and they wait."
    >
      stages not isolated
    </span>
  );
}

export function IncubatorView({ onGit }: { onGit?: () => void }) {
  const ready = useStore((s) => s.sproutsReady);
  const ids = useStore(useShallow((s) => sortSprouts(Object.values(s.sprouts)).map((x) => x.id)));
  const show = useStore((s) => s.showSprout);
  const waiting = useStore((s) => s.stages?.waiting ?? null);
  // `canopy new` prints a link to its project: open it once the list is in
  useEffect(() => {
    const id = sproutHere(window.location.search);
    if (!id || !ready) return;
    show(id);
    dropSproutHere();
  }, [ready, show]);
  return (
    <section className="incubator-view" aria-label="Incubator">
      <div className="agents-bar">
        <NewProjectButton />
        <StagesWord />
        <span className="agents-has">
          <InboxChip onGit={onGit} />
        </span>
      </div>
      {waiting && <p className="stages-waiting">queued: {waiting}</p>}
      {!ready ? (
        <p className="sheet-empty">The home backend has no incubator to show, or has not answered yet.</p>
      ) : ids.length === 0 ? (
        <div className="incubator-empty">
          <p>Nothing in the incubator. A project starts from an idea, a link, a file, a voice memo or a repo, and is clarified and researched before anything is built.</p>
          <NewProjectButton />
        </div>
      ) : (
        <div className="sprout-grid">
          {ids.map((id) => (
            <SproutCard key={id} id={id} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Records a voice memo where the page may use the microphone (a secure
 *  page), else offers a file picker for audio, which on a phone opens its
 *  own recorder. `onRecording` says when a recording starts and ends, so the
 *  form can hold its submit until the memo is a file. */
function Recorder({ onFiles, onRecording }: { onFiles: (files: File[]) => void; onRecording: (on: boolean) => void }) {
  const can = window.isSecureContext && typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  const rec = useRef<MediaRecorder | null>(null);
  // false once the form is gone: a permission prompt answered after that
  // must not leave the microphone on with nothing to stop it
  const alive = useRef(true);
  const pick = useRef<HTMLInputElement>(null);
  // one start at a time: a second click while the permission prompt is up
  // would make a second stream the first recorder's stop never reaches
  const starting = useRef(false);
  const [pending, setPending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const r = rec.current;
      if (!r) return;
      r.onstop = null;
      if (r.state !== "inactive") r.stop();
      for (const t of r.stream.getTracks()) t.stop();
    };
  }, []);
  if (!can) {
    return (
      <>
        <button
          type="button"
          className="mini"
          title="The microphone needs an https page; this picks a recording instead, and a phone offers to make one"
          onClick={() => pick.current?.click()}
        >
          upload a voice memo
        </button>
        <input
          ref={pick}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            if (e.target.files) onFiles(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
      </>
    );
  }
  const start = async () => {
    if (starting.current || rec.current) return;
    starting.current = true;
    setPending(true);
    setErr(null);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      const live = stream;
      // Safari records mp4 only
      const type = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const r = new MediaRecorder(live, { mimeType: type });
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      r.onstop = () => {
        for (const t of live.getTracks()) t.stop();
        rec.current = null;
        setRecording(false);
        onRecording(false);
        if (chunks.length === 0) return;
        const ext = type === "audio/webm" ? "webm" : "m4a";
        onFiles([new File(chunks, `voice-${Date.now()}.${ext}`, { type: r.mimeType || type })]);
      };
      r.onerror = () => {
        // the recorder died: let go of the microphone and say so
        for (const t of live.getTracks()) t.stop();
        r.onstop = null;
        rec.current = null;
        setRecording(false);
        onRecording(false);
        if (alive.current) setErr("the recording failed");
      };
      r.start();
      rec.current = r;
      setRecording(true);
      onRecording(true);
    } catch (e) {
      // a recorder that failed to make or start leaves the microphone on
      if (stream) for (const t of stream.getTracks()) t.stop();
      rec.current = null;
      if (alive.current) setErr(errText(e));
    } finally {
      starting.current = false;
      if (alive.current) setPending(false);
    }
  };
  return (
    <>
      {recording ? (
        <button type="button" className="mini strong recording" onClick={() => rec.current?.stop()}>
          ■ stop recording
        </button>
      ) : (
        <button type="button" className="mini" disabled={pending} onClick={() => void start()}>
          ● record
        </button>
      )}
      {recording && <span className="note recording">recording; stop it to add the memo</span>}
      {err && <span className="note err">{err}</span>}
    </>
  );
}

/** The inputs a project starts from or takes later, as one form, with the
 *  sheet's body and footer. */
function IntakeForm({
  lead,
  allowRepo,
  busy,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  lead?: ReactNode;
  allowRepo: boolean;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: (form: FormData) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [links, setLinks] = useState("");
  const [repo, setRepo] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [recording, setRecording] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const add = (list: File[]) => {
    const ok: File[] = [];
    const bad: string[] = [];
    for (const f of list) {
      if (!inputType(f.type, f.name)) bad.push(`${f.name}: canopy takes audio, images, pdf, text and markdown`);
      else if (f.size > INPUT_FILE_MAX) bad.push(`${f.name} is over ${sizeWord(INPUT_FILE_MAX)}`);
      else ok.push(f);
    }
    setFiles((fs) => [...fs, ...ok]);
    setRefused(bad.length ? bad.join("; ") : null);
  };
  const urls = links.split(/\s+/).filter(Boolean);
  const ready = !busy && !recording && (text.trim().length > 0 || urls.length > 0 || files.length > 0 || (allowRepo && repo.trim().length > 0));
  const submit = () => {
    if (!ready) return;
    const form = new FormData();
    if (text.trim()) form.append("text", text);
    for (const u of urls) form.append("url", u);
    if (allowRepo && repo.trim()) form.append("repo", repo.trim());
    for (const f of files) form.append("file", f, f.name);
    form.append("via", "sheet");
    onSubmit(form);
  };
  return (
    <>
      <div className="sheet-body plan intake">
        {lead}
        <textarea
          className="plan-note intake-text"
          rows={6}
          placeholder="The idea, in as many words as you like"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          aria-label="The idea"
        />
        <div
          className={`drop-zone${over ? " over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            add(Array.from(e.dataTransfer.files));
          }}
        >
          <span className="dim">Drop images, voice memos, pdfs or notes here, or</span>
          <button type="button" className="mini" onClick={() => picker.current?.click()}>
            pick files
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            accept="audio/*,image/*,application/pdf,text/plain,text/markdown,.md,.markdown,.txt"
            onChange={(e) => {
              if (e.target.files) add(Array.from(e.target.files));
              e.target.value = "";
            }}
          />
          <Recorder onFiles={add} onRecording={setRecording} />
        </div>
        {files.length > 0 && (
          <ul className="intake-files">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                <span aria-hidden="true">{INPUT_GLYPH[inputKindOf(inputType(f.type, f.name) ?? "")]}</span> {f.name} <span className="dim">{sizeWord(f.size)}</span>
                <button type="button" className="mini" aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        {refused && <p className="note err">{refused}</p>}
        <textarea className="plan-note intake-links" rows={2} placeholder="Links, one per line" value={links} onChange={(e) => setLinks(e.target.value)} aria-label="Links" />
        {allowRepo && (
          <input
            className="intake-line"
            type="url"
            placeholder="A git repo to start from (optional)"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            aria-label="A git repo to start from"
          />
        )}
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">Everything here is kept as it came, and only its index and summaries go to the vault.</span>
        <button type="button" className="mini" onClick={onCancel}>
          cancel
        </button>
        <button
          type="button"
          className="mini strong"
          disabled={!ready}
          title={recording ? "Stop the recording first, so the memo goes with it" : undefined}
          onClick={submit}
        >
          {busy ? "sending…" : submitLabel}
        </button>
      </footer>
    </>
  );
}

function SheetHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) {
  const close = useStore((s) => s.closeSheet);
  return (
    <header className="sheet-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2 className="sheet-title">
          {title} {sub && <span className="sheet-repo">{sub}</span>}
        </h2>
      </div>
      <button type="button" className="mini close" onClick={close} aria-label="Close">
        ✕
      </button>
    </header>
  );
}

export function NewSproutSheet() {
  const close = useStore((s) => s.closeSheet);
  const create = useStore((s) => s.createSprout);
  const show = useStore((s) => s.showSprout);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (form: FormData) => {
    setBusy(true);
    setError(null);
    create(form).then(
      (s) => show(s.id),
      (e: unknown) => {
        setError(errText(e));
        setBusy(false);
      },
    );
  };
  return (
    <>
      <SheetHead eyebrow="incubator" title="a new project" />
      <IntakeForm
        lead={<p className="blurb">Clarify reads everything given here and asks at most four questions; research then looks for something to renovate or extend before anything new is built.</p>}
        allowRepo
        busy={busy}
        error={error}
        submitLabel="start"
        onSubmit={submit}
        onCancel={close}
      />
    </>
  );
}

export function SproutSheet({ id }: { id: string }) {
  const close = useStore((s) => s.closeSheet);
  const sprout = useStore((s) => s.sprouts[id]);
  const showFlow = useStore((s) => s.showFlow);
  const answerSprout = useStore((s) => s.answerSprout);
  const addSproutInputs = useStore((s) => s.addSproutInputs);
  const stopSprout = useStore((s) => s.stopSprout);
  const resumeSprout = useStore((s) => s.resumeSprout);
  const dismissSprout = useStore((s) => s.dismissSprout);
  const [detail, setDetail] = useState<SproutDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updatedAt = sprout?.updatedAt;
  // the seed's own words, read again whenever the sprout moves
  useEffect(() => {
    // a dismissed project has nothing left to read
    if (updatedAt === undefined) return;
    let live = true;
    api.sprout(id).then(
      (d) => {
        if (!live) return;
        setDetail(d);
        setDetailErr(null);
      },
      (e: unknown) => {
        // a 404 is a project dismissed under the sheet; anything else is a
        // read that failed, said so, with the last good words kept
        if (live && statusOf(e) !== 404) setDetailErr(errText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [id, updatedAt]);
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    fn()
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setBusy(false));
  };

  if (!sprout) {
    return (
      <>
        <p className="sheet-empty">That project is not in the incubator any more.</p>
        <footer className="sheet-foot">
          <span className="spacer" />
          <button type="button" className="mini" onClick={close}>
            close
          </button>
        </footer>
      </>
    );
  }
  const ended = sprout.status === "live" || sprout.status === "rejected" || sprout.status === "handed-off" || sprout.status === "stopped";
  if (adding) {
    return (
      <>
        <SheetHead eyebrow="add to" title={sprout.title} />
        <IntakeForm
          lead={<p className="blurb">After clarify has looked, more input sends the project back to clarify before research.</p>}
          allowRepo={false}
          busy={busy}
          error={error}
          submitLabel="add"
          onSubmit={(form) => act(() => addSproutInputs(id, form).then(() => setAdding(false)))}
          onCancel={() => setAdding(false)}
        />
      </>
    );
  }
  const asking = sprout.status === "clarifying" && (sprout.questions?.length ?? 0) > 0;
  const minutes = Math.round(sprout.spent.workMs / 60_000);
  return (
    <>
      <SheetHead eyebrow={`incubator · ${sproutWord(sprout)}`} title={sprout.title} sub={sprout.repoId} />
      <div className="sheet-body plan sprout-sheet">
        <StageStrip id={sprout.id} />
        {sprout.status === "parked" && (
          <div className="ask">
            <div className="eyebrow">parked</div>
            <p>{sprout.parked}</p>
            <div className="ask-row">
              <button type="button" className="mini strong" disabled={busy} onClick={() => act(() => resumeSprout(id, "continue"))}>
                continue
              </button>
              <button type="button" className="mini" disabled={busy} onClick={() => act(() => resumeSprout(id, "retry"))}>
                retry
              </button>
              <span className="spacer" />
              <button type="button" className="mini" disabled={busy} onClick={() => act(() => stopSprout(id))}>
                stop
              </button>
            </div>
          </div>
        )}
        {(sprout.pick || sprout.privateRepo || sprout.url) && (
          <div className="ask">
            <div className="eyebrow">where it lives</div>
            {sprout.pick && (
              <p>
                {sprout.pick.kind}, on {sprout.pick.host}. {sprout.pick.why}
              </p>
            )}
            {sprout.privateRepo && (
              <p>
                {/^[\w.-]+\/[\w.-]+$/.test(sprout.privateRepo) ? (
                  <a href={`https://github.com/${sprout.privateRepo}`} target="_blank" rel="noopener noreferrer">
                    {sprout.privateRepo}
                  </a>
                ) : (
                  sprout.privateRepo
                )}{" "}
                (private)
              </p>
            )}
            {sprout.url && (
              <p>
                {isVercelAppUrl(sprout.url) ? (
                  <a href={sprout.url} target="_blank" rel="noopener noreferrer">
                    {sprout.url}
                  </a>
                ) : (
                  sprout.url
                )}
              </p>
            )}
          </div>
        )}
        {asking && sprout.questions && (
          <Questions
            questions={sprout.questions}
            who="clarify"
            busy={busy}
            onAnswer={(answers) => act(() => answerSprout(id, answers))}
            onDecline={() => act(() => answerSprout(id, null))}
            declineLabel="go on assumptions"
            declineTitle="Research goes on with what clarify assumed, and intent.md says you chose that"
          />
        )}
        <h3 className="eyebrow">intent</h3>
        {detailErr && <p className="dim">Could not read the project's files: {detailErr}</p>}
        {detail?.intent ? (
          <pre className="sprout-doc">{detail.intent}</pre>
        ) : (
          !detailErr && <p className="dim">Clarify has not written it yet.</p>
        )}
        <h3 className="eyebrow">inputs</h3>
        <ul className="sprout-inputs">
          {sprout.inputs.map((e) => (
            <li key={e.n}>
              <span aria-hidden="true">{INPUT_GLYPH[e.kind]}</span> <span className="sprout-input-label">{e.label}</span>{" "}
              <span className="dim">{e.summary || e.note || "not summarized yet"}</span>
            </li>
          ))}
        </ul>
        {detail?.research && (
          <>
            <h3 className="eyebrow">research</h3>
            <pre className="sprout-doc">{detail.research}</pre>
          </>
        )}
        {sprout.flows.length > 0 && (
          <>
            <h3 className="eyebrow">stages run</h3>
            <ol className="sprout-flows">
              {sprout.flows.map((f) => (
                <li key={f.flowId}>
                  <button type="button" className="mini" onClick={() => showFlow(f.flowId)}>
                    {f.workflow}
                  </button>{" "}
                  <span className="dim">{f.outcome ?? "running"}</span>
                </li>
              ))}
            </ol>
          </>
        )}
        <p className="dim">
          {sprout.spent.runs} {sprout.spent.runs === 1 ? "run" : "runs"}, {minutes} {minutes === 1 ? "minute" : "minutes"} of agent work so far
        </p>
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        {ended ? (
          <button type="button" className="mini" disabled={busy} title="Off the list; the seed, the inputs and the vault note stay" onClick={() => act(() => dismissSprout(id).then(close))}>
            dismiss
          </button>
        ) : (
          <>
            {sprout.status !== "deploying" && (
              <button type="button" className="mini" disabled={busy} onClick={() => setAdding(true)}>
                add input
              </button>
            )}
            {sprout.status !== "parked" && (
              <button type="button" className="mini" disabled={busy} onClick={() => act(() => stopSprout(id))}>
                stop
              </button>
            )}
          </>
        )}
        <span className="spacer" />
        <button type="button" className="mini" onClick={close}>
          close
        </button>
      </footer>
    </>
  );
}
