import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { CLI_GLYPH, CLI_NAME, accept, complete, recall, type CliEntry, type Suggestion } from "../cli";
import { runLine } from "../clirun";
import { useStore } from "../store";
import { stateOf } from "../util";
import type { Line } from "../../../src/core/treelines";

/** the status marks the CLI draws, by a repo's state */
const MARK: Record<string, string> = { conflict: "◆", error: "✗", dirty: "●", ahead: "◐", clean: "○" };

/** The peers' names for completion, read once per page: they change only
 *  when the backend's config does. */
let peerNames: Promise<string[]> | null = null;
const loadPeers = (): Promise<string[]> =>
  (peerNames ??= api
    .peers()
    .then((p) => p.peers.map((x) => x.name))
    .catch(() => []));

/**
 * The prompt: `canopy ▸`, the line, the rest of the first completion as
 * ghost text after it, and the words that could come next. Tab or → at the
 * end takes the completion, ↑ and ↓ walk the list (or, on an empty line,
 * the commands run before), Enter runs the line as typed.
 */
export function Prompt({ autoFocus, onRan, compact }: { autoFocus?: boolean; onRan?: () => void; compact?: boolean }) {
  const [value, setValue] = useState("");
  const [pick, setPick] = useState(0);
  const [hist, setHist] = useState(-1);
  const [peers, setPeers] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { repos, workspaces, sources, log } = useStore(
    useShallow((s) => ({ repos: s.repos, workspaces: s.workspaces, sources: s.sources, log: s.cliLog })),
  );

  useEffect(() => {
    void loadPeers().then(setPeers);
  }, []);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const ctx = useMemo(
    () => ({ repos, workspaces: workspaces.map((w) => w.name), sources: sources.filter((s) => !s.launch).map((s) => s.id), peers }),
    [repos, workspaces, sources, peers],
  );
  const done = useMemo(() => complete(value, ctx), [value, ctx]);
  const past = useMemo(() => recall(log), [log]);
  // the panel's prompt lists completions only while it is being typed in
  const options = compact && (!focused || value === "") ? [] : done.options;
  const at = Math.min(pick, Math.max(0, options.length - 1));
  const chosen = options[at];
  const byId = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);

  const set = (v: string) => {
    setValue(v);
    setPick(0);
  };
  const take = (o: Suggestion) => {
    set(accept(value, o.value));
    input.current?.focus();
  };
  const run = () => {
    const line = value.trim();
    if (line === "") return;
    set("");
    setHist(-1);
    onRan?.();
    void runLine(line);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const atEnd = e.currentTarget.selectionStart === value.length;
    if (e.key === "Enter") {
      e.preventDefault();
      run();
    } else if (e.key === "Tab" && chosen) {
      e.preventDefault();
      take(chosen);
    } else if (e.key === "ArrowRight" && atEnd && done.ghost && chosen) {
      e.preventDefault();
      take(chosen);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const up = e.key === "ArrowUp";
      // an empty line, or one already recalled, walks the commands run
      if ((value === "" || hist !== -1) && past.length > 0) {
        e.preventDefault();
        const next = Math.max(-1, Math.min(past.length - 1, hist + (up ? 1 : -1)));
        setHist(next);
        setValue(next === -1 ? "" : (past[next] ?? ""));
        setPick(0);
      } else if (options.length > 0) {
        e.preventDefault();
        setPick((at + (up ? options.length - 1 : 1)) % options.length);
      }
    } else if (e.key === "u" && e.ctrlKey) {
      e.preventDefault();
      set("");
    }
  };

  const listId = compact ? "cli-options-panel" : "cli-options-pop";
  return (
    <div className={compact ? "cli-prompt compact" : "cli-prompt"}>
      <div className="cli-row">
        <label className="cli-ps1" htmlFor={`${listId}-input`}>
          <span className="cli-name">{CLI_NAME}</span>
          <span className="cli-caret" aria-hidden="true">
            {CLI_GLYPH}
          </span>
        </label>
        <div className="cli-field">
          <span className="cli-ghost" aria-hidden="true">
            <span className="cli-typed">{value}</span>
            {done.ghost}
          </span>
          <input
            id={`${listId}-input`}
            ref={input}
            value={value}
            onChange={(e) => {
              set(e.target.value);
              setHist(-1);
            }}
            onKeyDown={onKey}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            enterKeyHint="go"
            role="combobox"
            aria-expanded={options.length > 0}
            aria-controls={listId}
            aria-activedescendant={chosen ? `${listId}-${at}` : undefined}
            aria-label="canopy command"
            placeholder={compact ? "a command, or help" : "status, push <repo>, spec status, help…"}
          />
        </div>
        <button type="button" className="mini cli-go" onClick={run} disabled={value.trim() === ""} aria-label="Run the command">
          ↵
        </button>
      </div>
      {options.length > 0 && (
        <ul className="cli-options" id={listId} role="listbox" aria-label="Completions">
          {options.map((o, i) => {
            const r = o.repo === undefined ? undefined : byId.get(o.repo);
            const state = r ? stateOf(r) : null;
            return (
              <li
                key={o.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === at}
                className={i === at ? "on" : ""}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => take(o)}
              >
                <span className={state ? `cli-mark s-${state}` : "cli-mark"} aria-hidden="true">
                  {state ? (MARK[state] ?? "○") : ""}
                </span>
                <span className="cli-value">{o.value}</span>
                <span className="cli-hint">{o.hint}</span>
              </li>
            );
          })}
        </ul>
      )}
      {!compact && (
        <p className="cli-keys">
          <kbd>⇥</kbd> complete <kbd>↑</kbd>
          <kbd>↓</kbd> choose <kbd>↵</kbd> run <kbd>esc</kbd> close
        </p>
      )}
    </div>
  );
}

/** The prompt over the page, from ⌘K or `:`. A command that answers sends
 *  its answer to the transcript panel; one that goes somewhere goes. */
export function CommandPop() {
  const open = useStore((s) => s.cliOpen);
  const setOpen = useStore((s) => s.setCliOpen);
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      back?.focus();
    };
  }, [open, setOpen]);
  if (!open) return null;
  return (
    <div className="cli-veil" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="cli-pop" role="dialog" aria-modal="true" aria-label="canopy command line">
        <Prompt autoFocus onRan={() => setOpen(false)} />
      </div>
    </div>
  );
}

/* ---------- the transcript ---------- */

/** a line of toned segments, a repo's name a button that opens its panel */
function OutLine({ line, open }: { line: Line; open: (id: string) => void }) {
  const parts: ReactNode[] = line.map((s, i) => {
    const cls = s.tone ? `t-${s.tone}` : undefined;
    if (s.repo !== undefined) {
      const id = s.repo;
      return (
        <button key={i} type="button" className={`cli-repo${cls ? ` ${cls}` : ""}`} title={`Open ${id}`} onClick={() => open(id)}>
          {s.text}
        </button>
      );
    }
    return cls ? (
      <span key={i} className={cls}>
        {s.text}
      </span>
    ) : (
      s.text
    );
  });
  return <div className="cli-line">{parts.length ? parts : " "}</div>;
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Entry({ e, open }: { e: CliEntry; open: (id: string) => void }) {
  return (
    <li className={`cli-entry s-${e.status}`}>
      <div className="cli-echo">
        <span className="cli-caret" aria-hidden="true">
          {CLI_GLYPH}
        </span>
        <span className="cli-said">{e.line}</span>
        <span className="cli-when">
          {e.status === "running" ? "running…" : <time dateTime={new Date(e.at).toISOString()}>{clock(e.at)}</time>}
        </span>
        <button
          type="button"
          className="mini cli-again"
          disabled={e.status === "running"}
          title={`Run ${e.line} again`}
          aria-label={`Run ${e.line} again`}
          onClick={() => void runLine(e.line)}
        >
          ↻
        </button>
      </div>
      {e.out.length > 0 && (
        <div className="cli-out">
          {e.out.map((l, i) => (
            <OutLine key={i} line={l} open={open} />
          ))}
        </div>
      )}
    </li>
  );
}

const TRY = ["status", "spec status", "peers", "ws", "help"];

/** The transcript panel's body: each command as typed, what it printed,
 *  and a prompt at the foot to keep going. */
export function CliBody({ hidden }: { hidden?: boolean }) {
  const log = useStore((s) => s.cliLog);
  const openPanel = useStore((s) => s.openPanel);
  const end = useRef<HTMLDivElement>(null);
  const last = log.at(-1);
  useEffect(() => {
    if (!hidden) end.current?.scrollIntoView({ block: "end" });
  }, [hidden, last?.id, last?.status]);
  return (
    <div className="cli-body">
      {log.length === 0 ? (
        <div className="cli-empty">
          <p>The CLI's words, run against what this page sees. Repo names in the answers open their panels.</p>
          <p className="cli-try">
            {TRY.map((t) => (
              <button key={t} type="button" className="mini" onClick={() => void runLine(t)}>
                {t}
              </button>
            ))}
          </p>
        </div>
      ) : (
        <ol className="cli-log" aria-live="polite">
          {log.map((e) => (
            <Entry key={e.id} e={e} open={openPanel} />
          ))}
        </ol>
      )}
      <div ref={end} className="cli-foot">
        <Prompt compact />
      </div>
    </div>
  );
}
