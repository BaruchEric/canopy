/**
 * The new goal's box, over the goals going in the manager view (FR-067): the
 * goal in Eric's words, the repos he names with `@`, the files he attaches,
 * pastes or drops, and the model and effort the coordinator starts on. Start
 * goal hands it to a backend that runs a coordinator (`newGoal`), at no repo,
 * and opens the goal; an error shows under the box, and the words and the
 * files stay. With no such backend online the box still drafts, over this
 * page's own repos, and start goal stays off. The pure half is goals.ts.
 */
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { HARNESS } from "../../../src/core/harness";
import { sizeWord } from "../../../src/core/sprout";
import type { AgentEffort, Mention } from "../../../src/core/types";
import { NO_ROUTES } from "../agents";
import { coordBackends, coordDefaults, goalLimitsWhy, goalRepoChoices, goalRepoRows, namedRepos } from "../goals";
import { applyPick, mentionAt, type Sigil } from "../mentions";
import { managerNew, openManager } from "../routes";
import { useStore } from "../store";

/** the box offers `@` alone: a repo, never a file or a command */
const AT: readonly Sigil[] = ["@"];

const CLAUDE = HARNESS.claude;

/** an attached file and the key its chip keeps while others go */
interface Attached {
  key: number;
  file: File;
}

/** the list with `extra` at its head when it is not in it already */
const withFirst = <T,>(list: readonly T[], extra: T): T[] => (list.includes(extra) ? [...list] : [extra, ...list]);

export function GoalComposer({ autoFocus = false }: { autoFocus?: boolean }) {
  const conns = useStore((s) => s.conns);
  const order = useStore((s) => s.backendOrder);
  const home = useStore((s) => s.home);
  const repos = useStore((s) => s.repos);
  const agents = useStore((s) => s.agents);
  const newGoal = useStore((s) => s.newGoal);
  const backends = useMemo(() => coordBackends(conns, order), [conns, order]);
  const [pick, setPick] = useState<string | null>(null);
  // the backend picked while it still runs a coordinator, else the first that does
  const backend = pick !== null && backends.includes(pick) ? pick : backends[0];
  const where = backend ?? home;
  const choices = useMemo(() => goalRepoChoices(repos, where), [repos, where]);
  const routes = agents[where];
  const defaults = useMemo(() => coordDefaults(routes ?? NO_ROUTES), [routes]);
  // what Eric picked over the route's defaults; null follows the route, which may load later
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<AgentEffort | null>(null);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [files, setFiles] = useState<Attached[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [row, setRow] = useState(0);
  // the `@` word whose menu Escape closed, until the word changes
  const [dismissed, setDismissed] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);

  // focused when the address asks for a new goal: on arrival, and when the
  // top bar's button or the key asks again while the box is up
  useEffect(() => {
    if (autoFocus) box.current?.focus();
    const pop = () => {
      if (managerNew(location.search)) box.current?.focus();
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [autoFocus]);

  const at = focused ? mentionAt(text, caret, AT) : null;
  const query = at ? at.query : null;
  const atKey = at ? `${at.start}:${at.query}` : null;
  const rows = useMemo(() => (query === null ? [] : goalRepoRows(choices, query)), [choices, query]);
  useEffect(() => setRow(0), [query]);
  const sel = Math.min(row, Math.max(0, rows.length - 1));
  const open = at !== null && rows.length > 0 && dismissed !== atKey;

  const named = useMemo(() => namedRepos(text, choices), [text, choices]);
  const why = goalLimitsWhy({ text, repos: named.length, files: files.map((f) => f.file) });
  const ready = backend !== undefined && text.trim() !== "" && why === null && !busy;

  const models = withFirst(CLAUDE.models, model ?? defaults.model);
  const efforts = withFirst(CLAUDE.efforts, effort ?? defaults.effort);

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

  const start = async () => {
    if (!ready || backend === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const id = await newGoal(backend, {
        goal: text.trim(),
        repos: named,
        files: files.map((f) => f.file),
        ...(model !== null ? { model } : {}),
        ...(effort !== null ? { effort } : {}),
      });
      openManager(id);
    } catch (err) {
      // the server's own words; the text and the files stay for another go
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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
      void start();
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

  return (
    <section className="mgr-new" aria-label="new goal">
      <div className="mgr-new-head">
        <h2 className="mgr-h">new goal</h2>
        {backends.length > 1 && backend !== undefined ? (
          <label className="mgr-new-on">
            runs on
            <select
              className="settings-input"
              value={backend}
              aria-label="The backend the coordinator runs on"
              onChange={(e) => {
                setPick(e.target.value);
                setModel(null);
                setEffort(null);
              }}
            >
              {backends.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
        ) : (
          backend !== undefined && <span className="mgr-new-on">runs on {backend}</span>
        )}
      </div>
      {backend === undefined && <p className="mgr-sub mgr-new-none">No backend here runs a coordinator; the mini does when it is online.</p>}
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
          placeholder="what should get done? @ names a repo"
          aria-label="The goal"
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
        <button type="button" className="mini" title="Files for the coordinator to read before it plans; paste or drop them on the box too" onClick={() => picker.current?.click()}>
          + attach
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label="Files for the goal"
          onChange={(e) => {
            if (e.target.files) add(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
      </div>
      {why && <p className="note err mgr-new-why">{why}</p>}
      {backend !== undefined && (
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
          <span className="mgr-new-from">(from {backend}'s coordinate route)</span>
        </div>
      )}
      <div className="mgr-new-foot">
        <button type="button" className="mini strong" disabled={!ready} title="⌘↩" onClick={() => void start()}>
          {busy ? "starting…" : "start goal"}
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
