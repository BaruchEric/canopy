/**
 * The new box, over the goals and projects in the manager's overview: one
 * place to start something, a goal or a project. The words and the files
 * belong to the box and stay when the kind switches; the box remembers the
 * kind it last started.
 *
 * A goal (FR-067) is the words, the repos named with `@`, the files, and the
 * model and effort the coordinator starts on. Start goal hands it to a
 * backend that runs a coordinator (`newGoal`), at no repo, and opens the
 * goal. With no such backend online the goal side still drafts, over this
 * page's own repos, and start goal stays off.
 *
 * A project goes to the incubator: the words as the idea, links, a repo to
 * start from, the files and a voice memo as its inputs, on a backend that
 * runs stages. Start project sends it (`createSprout`) and opens its sheet.
 *
 * An error shows under the box, and what was typed stays. What a kind cannot
 * take is said under the box: a file a project cannot take holds its start,
 * and the project side's links and repo stay out of a goal. The pure half
 * is newbox.ts and goals.ts.
 */
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { HARNESS } from "../../../src/core/harness";
import { sizeWord } from "../../../src/core/sprout";
import type { AgentEffort, Mention } from "../../../src/core/types";
import { NO_ROUTES } from "../agents";
import { coordBackends, coordDefaults, goalLimitsWhy, goalRepoChoices, goalRepoRows, namedRepos } from "../goals";
import { applyPick, mentionAt, type Sigil } from "../mentions";
import { goalLeaves, kindOf, NEW_KIND_KEY, projectFilesWhy, projectForm, projectHasInput } from "../newbox";
import { managerNew, newKindHere, openManager, type NewKind } from "../routes";
import { cannotStart, sproutBackend, stagesChoice, stagesUnread } from "../sprouts";
import { isOnline, useStore } from "../store";
import { Recorder } from "./IncubatorSheets";
import { Seg } from "./Seg";

/** the goal side offers `@` alone: a repo, never a file or a command */
const AT: readonly Sigil[] = ["@"];

const CLAUDE = HARNESS.claude;

const KINDS = [
  { value: "goal", label: "goal", title: "Work across repos you have: a coordinator plans cards in the repos you name with @" },
  { value: "project", label: "project", title: "Something new: the incubator clarifies and researches the idea, then builds it" },
] as const;

const BLURB: Record<NewKind, string> = {
  goal: "A coordinator plans cards in the repos you name with @, and your files go to the workers that need them.",
  project: "Clarify reads everything given here and asks at most four questions; research then looks for something to renovate or extend before anything new is built.",
};

const PLACEHOLDER: Record<NewKind, string> = {
  goal: "what should get done? @ names a repo",
  project: "the idea, in as many words as you like",
};

/** an attached file and the key its chip keeps while others go */
interface Attached {
  key: number;
  file: File;
}

/** the list with `extra` at its head when it is not in it already */
const withFirst = <T,>(list: readonly T[], extra: T): T[] => (list.includes(extra) ? [...list] : [extra, ...list]);

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** the address's query; a test or a server render may have no location */
const search = (): string => (typeof location === "undefined" ? "" : location.search);

/** the kind the box last started, where the browser keeps it */
function storedKind(): NewKind {
  try {
    return kindOf(localStorage.getItem(NEW_KIND_KEY));
  } catch {
    return "goal";
  }
}

function rememberKind(kind: NewKind): void {
  try {
    localStorage.setItem(NEW_KIND_KEY, kind);
  } catch {
    // a private window keeps nothing; the box starts on a goal next time
  }
}

export function NewComposer({ autoFocus = false }: { autoFocus?: boolean }) {
  const [kind, setKindNow] = useState<NewKind>(() => newKindHere(search()) ?? storedKind());
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [files, setFiles] = useState<Attached[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);
  const loadMissingStages = useStore((s) => s.loadMissingStages);

  const setKind = (next: NewKind) => {
    setKindNow(next);
    rememberKind(next);
    setError(null);
  };
  // the project side needs each backend's stages, read once
  useEffect(() => {
    if (kind === "project") loadMissingStages();
  }, [kind, loadMissingStages]);

  // focused when the address asks for the box: on arrival, and when the
  // top bar's button or the key asks again while the box is up
  useEffect(() => {
    if (autoFocus) box.current?.focus();
    const pop = () => {
      if (!managerNew(search())) return;
      const asked = newKindHere(search());
      if (asked) setKindNow(asked);
      box.current?.focus();
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [autoFocus]);

  /* ---------- the goal side ---------- */
  const conns = useStore((s) => s.conns);
  const order = useStore((s) => s.backendOrder);
  const home = useStore((s) => s.home);
  const repos = useStore((s) => s.repos);
  const agents = useStore((s) => s.agents);
  const newGoal = useStore((s) => s.newGoal);
  const coords = useMemo(() => coordBackends(conns, order), [conns, order]);
  const [coordPick, setCoordPick] = useState<string | null>(null);
  // the backend picked while it still runs a coordinator, else the first that does
  const coordOn = coordPick !== null && coords.includes(coordPick) ? coordPick : coords[0];
  const where = coordOn ?? home;
  const choices = useMemo(() => goalRepoChoices(repos, where), [repos, where]);
  const routes = agents[where];
  const defaults = useMemo(() => coordDefaults(routes ?? NO_ROUTES), [routes]);
  // what Eric picked over the route's defaults; null follows the route, which may load later
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<AgentEffort | null>(null);
  const [row, setRow] = useState(0);
  // the `@` word whose menu Escape closed, until the word changes
  const [dismissed, setDismissed] = useState<string | null>(null);

  const at = focused && kind === "goal" ? mentionAt(text, caret, AT) : null;
  const query = at ? at.query : null;
  const atKey = at ? `${at.start}:${at.query}` : null;
  const rows = useMemo(() => (query === null ? [] : goalRepoRows(choices, query)), [choices, query]);
  useEffect(() => setRow(0), [query]);
  const sel = Math.min(row, Math.max(0, rows.length - 1));
  const open = at !== null && rows.length > 0 && dismissed !== atKey;

  const named = useMemo(() => namedRepos(text, choices), [text, choices]);
  const goalWhy = goalLimitsWhy({ text, repos: named.length, files: files.map((f) => f.file) });
  const models = withFirst(CLAUDE.models, model ?? defaults.model);
  const efforts = withFirst(CLAUDE.efforts, effort ?? defaults.effort);

  /* ---------- the project side ---------- */
  const [links, setLinks] = useState("");
  const [repo, setRepo] = useState("");
  const [recording, setRecording] = useState(false);
  const online = useStore(useShallow((s) => s.backendOrder.filter((b) => isOnline(s, b))));
  const stages = useStore((s) => s.stages);
  const stagesErr = useStore((s) => s.stagesErr);
  const createSprout = useStore((s) => s.createSprout);
  const showSprout = useStore((s) => s.showSprout);
  // the default follows the backends' stages as they answer, until picked
  const fallback = useStore((s) => sproutBackend(s.backendOrder, s.home, s.stages, (b) => isOnline(s, b)));
  const [stagePick, setStagePick] = useState<string | null>(null);
  const stageOn = stagePick ?? fallback;
  const stOf = (b: string) => (Object.hasOwn(stages, b) ? stages[b] : undefined);
  const errOf = (b: string) => (Object.hasOwn(stagesErr, b) ? stagesErr[b] : undefined);
  const stageWord = stagesChoice(stageOn, stOf(stageOn), errOf(stageOn));
  // a backend with stages off would hold the project queued for good
  const stageBlocked = cannotStart(stageOn, stOf(stageOn));
  // a read of its stages that failed, said, while nothing else has said (FR-062)
  const unread = stagesUnread(stageOn, stOf(stageOn), errOf(stageOn));
  const filesWhy = projectFilesWhy(files.map((f) => f.file));
  // the send on its way, which stop and the box's going call off
  const sending = useRef<AbortController | null>(null);
  useEffect(() => () => sending.current?.abort(), []);

  // the command line's `new`: its words land on the project side
  const draft = useStore((s) => s.newDraft);
  const takeDraft = useStore((s) => s.draftSprout);
  useEffect(() => {
    if (!draft) return;
    setKindNow("project");
    if (draft.text) setText(draft.text);
    if (draft.urls.length > 0) setLinks(draft.urls.join("\n"));
    if (draft.repo) setRepo(draft.repo);
    takeDraft(null);
    box.current?.focus();
  }, [draft, takeDraft]);

  /* ---------- both ---------- */
  const ready =
    !busy &&
    (kind === "goal"
      ? coordOn !== undefined && text.trim() !== "" && goalWhy === null
      : !recording && stageBlocked === null && filesWhy === null && projectHasInput({ text, links, repo, files: files.length }));

  const add = (list: readonly File[]) => {
    if (list.length === 0) return;
    const fresh = list.map((file) => ({ key: nextKey.current++, file }));
    setFiles((fs) => [...fs, ...fresh]);
  };

  const accept = (m: Mention) => {
    if (!at) return;
    const next = applyPick(text, at, m.name);
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const startGoal = async () => {
    if (coordOn === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const id = await newGoal(coordOn, {
        goal: text.trim(),
        repos: named,
        files: files.map((f) => f.file),
        ...(model !== null ? { model } : {}),
        ...(effort !== null ? { effort } : {}),
      });
      openManager(id);
    } catch (err) {
      // the server's own words; the text and the files stay for another go
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const startProject = () => {
    sending.current?.abort();
    const ctl = new AbortController();
    sending.current = ctl;
    setBusy(true);
    setError(null);
    createSprout(projectForm({ text, links, repo, files: files.map((f) => f.file) }), stageOn, ctl.signal).then(
      (s) => {
        // a stop that came as the answer did keeps the box as it was
        if (ctl.signal.aborted) return;
        setBusy(false);
        setText("");
        setLinks("");
        setRepo("");
        setFiles([]);
        showSprout(s.id);
      },
      (err: unknown) => {
        if (ctl.signal.aborted) return;
        setError(errText(err));
        setBusy(false);
      },
    );
  };

  const start = () => {
    if (!ready) return;
    if (kind === "goal") void startGoal();
    else startProject();
  };

  const stopSending = () => {
    sending.current?.abort();
    sending.current = null;
    setBusy(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && atKey !== null) {
      // the key is the menu's alone, not the page's
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        take();
        setRow((sel + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        take();
        const m = rows[sel];
        if (m) accept(m);
        return;
      }
      if (e.key === "Escape") {
        take();
        setDismissed(atKey);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      start();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const got = Array.from(e.clipboardData.files);
    // words paste as words; only files are taken
    if (got.length === 0) return;
    e.preventDefault();
    add(got);
  };

  const carriesFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes("Files");

  const why = kind === "goal" ? goalWhy : (filesWhy ?? stageBlocked);
  const leaves = kind === "goal" ? goalLeaves(links, repo) : null;

  return (
    <section className="mgr-new" aria-label="new goal or project">
      <div className="mgr-new-head">
        <h2 className="mgr-h">new</h2>
        {/* held while a start is on its way, so the button keeps saying what it sends */}
        <Seg label="What to start" value={kind} options={busy ? KINDS.map((k) => ({ ...k, disabled: true })) : KINDS} onChange={setKind} className="mgr-new-kind" />
        {kind === "goal" ? (
          coords.length > 1 && coordOn !== undefined ? (
            <label className="mgr-new-on">
              runs on
              <select
                className="settings-input"
                value={coordOn}
                aria-label="The backend the coordinator runs on"
                onChange={(e) => {
                  setCoordPick(e.target.value);
                  setModel(null);
                  setEffort(null);
                }}
              >
                {coords.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            coordOn !== undefined && <span className="mgr-new-on">runs on {coordOn}</span>
          )
        ) : online.length > 1 ? (
          <label className="mgr-new-on">
            runs on
            <select className="settings-input" value={stageOn} aria-label="The backend whose incubator takes the project" onChange={(e) => setStagePick(e.target.value)}>
              {online.map((b) => (
                <option key={b} value={b}>
                  {b} · {stagesChoice(b, stOf(b), errOf(b)).word}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="mgr-new-on" title={stageWord.title}>
            runs on {stageOn} · <span className={`stages-word${stageWord.warn ? " not" : ""}`}>{stageWord.word}</span>
          </span>
        )}
      </div>
      <p className="mgr-sub mgr-new-blurb">{BLURB[kind]}</p>
      {kind === "goal" && coordOn === undefined && <p className="mgr-sub mgr-new-none">No backend here runs a coordinator; the mini does when it is online.</p>}
      <div
        className={`mgr-new-box${over ? " over" : ""}`}
        onDragOver={(e) => {
          if (!carriesFiles(e)) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          // dropped words go into the box as words
          if (e.dataTransfer.files.length === 0) return;
          e.preventDefault();
          add(Array.from(e.dataTransfer.files));
        }}
      >
        <textarea
          ref={box}
          className="plan-note mgr-new-text"
          rows={3}
          value={text}
          placeholder={PLACEHOLDER[kind]}
          aria-label={kind === "goal" ? "The goal" : "The idea"}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {open && (
          <ul className="mention-menu below" role="listbox" aria-label="Repos">
            {rows.map((m, i) => (
              <li
                key={m.name}
                role="option"
                aria-selected={i === sel}
                className={`mention-row${i === sel ? " on" : ""}`}
                // on pointer down, before the box could lose focus to the click
                onPointerDown={(e) => {
                  e.preventDefault();
                  accept(m);
                }}
                onMouseEnter={() => setRow(i)}
              >
                <span className="mention-sigil" aria-hidden="true">
                  @
                </span>
                <span className="mention-name">{m.name}</span>
                <span className="mention-hint">{m.description}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mgr-new-files">
        {files.map(({ key, file }) => (
          <span key={key} className="mgr-chip mgr-new-file" title={`${file.name}, ${sizeWord(file.size)}`}>
            <span className="mgr-new-name">{file.name}</span>
            <button type="button" className="mini" aria-label={`Remove ${file.name}`} onClick={() => setFiles((fs) => fs.filter((f) => f.key !== key))}>
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          className="mini"
          title={kind === "goal" ? "Files for the coordinator to read before it plans; paste or drop them on the box too" : "Images, voice memos, pdfs or notes for the project; paste or drop them on the box too"}
          onClick={() => picker.current?.click()}
        >
          + attach
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label={kind === "goal" ? "Files for the goal" : "Files for the project"}
          onChange={(e) => {
            if (e.target.files) add(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
        {kind === "project" && <Recorder onFiles={add} onRecording={setRecording} />}
      </div>
      {kind === "project" && (
        <div className="mgr-new-project">
          <textarea className="plan-note mgr-new-links" rows={2} placeholder="Links, one per line" value={links} onChange={(e) => setLinks(e.target.value)} aria-label="Links" />
          <input
            className="intake-line mgr-new-repo"
            type="url"
            placeholder="A git repo to start from (optional)"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            aria-label="A git repo to start from"
          />
        </div>
      )}
      {why && <p className="note err mgr-new-why">{why}</p>}
      {kind === "project" && unread && <p className="note">{unread}</p>}
      {leaves && <p className="note mgr-new-leaves">{leaves}</p>}
      {kind === "goal" && coordOn !== undefined && (
        <div className="mgr-new-agent">
          <span>Claude Code</span>
          <label>
            model
            <select className="settings-input" value={model ?? defaults.model} aria-label="The coordinator's model" onChange={(e) => setModel(e.target.value === defaults.model ? null : e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label>
            effort
            <select
              className="settings-input"
              value={effort ?? defaults.effort}
              aria-label="The coordinator's effort"
              onChange={(e) => {
                const picked = efforts.find((x) => x === e.target.value);
                if (picked) setEffort(picked === defaults.effort ? null : picked);
              }}
            >
              {efforts.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <span className="mgr-new-from">(from {coordOn}'s coordinate route)</span>
        </div>
      )}
      <div className="mgr-new-foot">
        {kind === "project" && busy && (
          <button type="button" className="mini" title="Stops the upload; what you typed stays" onClick={stopSending}>
            stop sending
          </button>
        )}
        <button
          type="button"
          className="mini strong"
          disabled={!ready}
          title={recording ? "Stop the recording first, so the memo goes with it" : "⌘↩"}
          onClick={start}
        >
          {kind === "goal" ? (busy ? "starting…" : "start goal") : busy ? "sending…" : "start project"}
        </button>
      </div>
      {error && (
        <p className="note err mgr-new-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
