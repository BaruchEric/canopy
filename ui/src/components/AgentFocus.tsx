import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AgentCard } from "../../../src/core/types";
import { joinTarget } from "../agentcards";
import { allAgents, runOfCard, shellsToProbe, type Ids } from "../allagents";
import { ansiLines, trimTail, type AnsiRun } from "../ansi";
import { api } from "../api";
import { quickAnswers } from "../board";
import { backendOf, plainOf, qual } from "../registry";
import { canAnswer, inboxItems, useStore } from "../store";
import type { TermTab } from "../term";
import { InboxRow } from "./Inbox";
import { RunPane } from "./RunSheet";
import { AgentDetail } from "./Registry";
import { ShellSpotHere } from "./Surface";
import { TermView } from "./TermDock";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** the page's own reading of a qualified id */
export const pageIds: Ids = { split: (id) => [backendOf(id), plainOf(id)], qual };

/** how often the board asks its shells what runs in them */
export const SHELL_PROBE_EVERY = 15_000;

let probing = 0;
let probeTimer: ReturnType<typeof setInterval> | undefined;

let asking = false;

/** one probe at a time, however many views ask for one */
function probeNow() {
  if (asking || (typeof document !== "undefined" && document.visibilityState !== "visible")) return;
  const s = useStore.getState();
  asking = true;
  void s.probeShells(shellsToProbe(Object.values(s.registry), s.shells, pageIds)).finally(() => {
    asking = false;
  });
}

/**
 * Keeps `shellAgents` current while any view of every agent is up: asks at
 * once, whenever the shells change, and every `SHELL_PROBE_EVERY` after.
 * One timer however many views ask.
 */
export function useShellProbe() {
  const shells = useStore((s) => s.shells);
  useEffect(() => {
    probing++;
    if (probing === 1) probeTimer = setInterval(probeNow, SHELL_PROBE_EVERY);
    return () => {
      probing--;
      if (probing === 0) clearInterval(probeTimer);
    };
  }, []);
  useEffect(() => probeNow(), [shells]);
}

/**
 * Every agent the page knows: the registry's cards, and a card for each
 * canopy run or chat and each agent in a canopy shell that no registry card
 * names (`allAgents`). Read with `useShellProbe` running somewhere, or
 * shells show only through their hooks.
 */
export function useAllAgents(): AgentCard[] {
  const registry = useStore((s) => s.registry);
  const runs = useStore((s) => s.runs);
  const shells = useStore((s) => s.shells);
  const shellAgents = useStore((s) => s.shellAgents);
  const repos = useStore((s) => s.repos);
  return useMemo(
    () => allAgents({ cards: Object.values(registry), runs: Object.values(runs), shells, shellAgents, repos, ids: pageIds }),
    [registry, runs, shells, shellAgents, repos],
  );
}

/** one agent by its card id, from every agent the page knows */
export function useAgentCard(id: string | null): AgentCard | undefined {
  const all = useAllAgents();
  return id ? all.find((c) => c.id === id) : undefined;
}

/** the run a card stands for, while the page holds it */
function useCardRun(card: AgentCard) {
  const id = card.where.canopy?.run ? runOfCard(card, pageIds) : null;
  return useStore((s) => (id ? s.runs[id] : undefined));
}

/**
 * The canopy shell an agent runs in, as a tab a view can join: only for a
 * card whose `where.canopy.term` names a shell on a backend the page shows
 * and whose repo has a folder. The tab only ever joins, so a shell that is
 * gone says so instead of starting a new one under its name.
 */
export function useCardShell(card: AgentCard | undefined): TermTab | null {
  const shown = useStore(useShallow((s) => s.backendOrder));
  const target = card ? joinTarget(card, shown, qual) : null;
  const info = useStore((s) => (target ? s.shells.find((t) => t.id === target) : undefined));
  const repo = useStore((s) => (info ? s.repos.find((r) => r.id === info.repoId) : undefined));
  const id = info?.id;
  const place = info?.place;
  return useMemo(
    () => (id && place && repo && !repo.forge ? { id, repoId: repo.id, name: repo.name, path: repo.path, place, joinOnly: true } : null),
    [id, place, repo],
  );
}

/** whether an element is on screen, so a peek off it reads nothing */
function useInView(ref: React.RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setSeen(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return seen;
}

/** how often a peek reads its shell's screen again */
export const PEEK_EVERY = 2000;

const runStyle = (r: AnsiRun): CSSProperties | undefined => {
  if (!r.fg && !r.bg && !r.bold && !r.dim && !r.italic && !r.under && !r.inverse) return undefined;
  const fg = r.inverse ? (r.bg ?? "var(--bark0)") : r.fg;
  const bg = r.inverse ? (r.fg ?? "var(--ink)") : r.bg;
  return {
    color: fg,
    background: bg,
    fontWeight: r.bold ? 700 : undefined,
    opacity: r.dim ? 0.65 : undefined,
    fontStyle: r.italic ? "italic" : undefined,
    textDecoration: r.under ? "underline" : undefined,
  };
};

/**
 * A shell's screen as it stands, read again every `PEEK_EVERY` while it is
 * on screen and the page is in view. Read only, and it never joins the
 * shell, so a small tile never sizes the agent's terminal under the person
 * using it elsewhere: tmux sizes a window to its latest client.
 */
export function Peek({ term }: { term: string }) {
  const [text, setText] = useState<string | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLPreElement>(null);
  const seen = useInView(ref);
  useEffect(() => {
    if (!seen) return;
    let on = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      if (document.visibilityState !== "visible") {
        timer = setTimeout(read, PEEK_EVERY);
        return;
      }
      api
        .termScreen(term)
        .then((r) => {
          if (!on) return;
          setText(r.text);
          setErr(null);
        })
        .catch((e: unknown) => on && setErr(errText(e)))
        .finally(() => {
          if (on) timer = setTimeout(read, PEEK_EVERY);
        });
    };
    read();
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [term, seen]);
  const lines = useMemo(() => (text ? trimTail(ansiLines(text)) : []), [text]);
  return (
    <pre ref={ref} className="peek" aria-label="The shell's screen, read only">
      {text === null && <span className="peek-note">A plain shell: there is no pane to read. Open it to see it.</span>}
      {err && text === undefined && <span className="peek-note">{err}</span>}
      {lines.map((line, i) => (
        <div key={i} className="peek-line">
          {line.length === 0
            ? " "
            : line.map((r, j) => (
                <span key={j} style={runStyle(r)}>
                  {r.text}
                </span>
              ))}
        </div>
      ))}
    </pre>
  );
}

type State = ReturnType<typeof useStore.getState>;

/** the inbox's key for what an agent waits on: its run's prompt, else its
 *  open ask; null when it waits on nothing the inbox holds */
const waitKeyOf = (card: AgentCard) => (s: State): string | null => {
  const run = card.where.canopy?.run ? runOfCard(card, pageIds) : null;
  if (run && s.runs[run]?.status === "waiting") return `run:${run}`;
  const ask = Object.values(s.asks).find((a) => a.state === "open" && a.agent === card.id);
  return ask ? `ask:${ask.id}` : null;
};

/** the inbox item an agent waits on, if any */
function useWaitItem(card: AgentCard) {
  const key = useStore(waitKeyOf(card));
  return useStore((s) => (key ? inboxItems(s).find((x) => x.key === key) : undefined));
}

/**
 * The answers a row gives in one press (allow or deny; a single question's
 * options), sent through the inbox, so the hook hears them as it hears the
 * inbox's own. An ask that needs the whole form, or a device with no answer
 * key, gets "answer", which opens it in the inbox.
 */
export function QuickAnswer({ card }: { card: AgentCard }) {
  const item = useWaitItem(card);
  const can = useStore(canAnswer);
  const answerInbox = useStore((s) => s.answerInbox);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // with nothing to answer the row line already says "waits on: your turn"
  if (!item) return null;
  // a broker's ask needs this device's answer key; a run's prompt does not
  const quick = item.source !== "ask" || can ? quickAnswers(item) : null;
  const send = (i: number) => {
    const a = quick?.[i];
    if (!item || !a) return;
    setBusy(true);
    setErr(null);
    answerInbox(item, a.answer)
      .catch((e: unknown) => setErr(errText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <span className="bt-acts" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {quick?.map((a, i) => (
        <button key={a.label} type="button" className={a.main ? "mini bt-go" : "mini"} disabled={busy} title={item.title} onClick={() => send(i)}>
          {a.label}
        </button>
      ))}
      {!quick && (
        <button type="button" className="mini" title={item.title} onClick={() => useStore.getState().openInbox(item.key)}>
          answer
        </button>
      )}
      {err && <span className="bt-err">{err}</span>}
    </span>
  );
}

/** The ask an agent waits on, with the inbox's whole form, open: what the
 *  focus shows above the agent's screen. */
export function AskHere({ card, onGit }: { card: AgentCard; onGit?: () => void }) {
  const item = useWaitItem(card);
  // a run's prompt shows in its own timeline, under this
  const ranHere = useCardRun(card) !== undefined;
  const can = useStore(canAnswer);
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!item) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [item]);
  if (!item || ranHere) return null;
  return (
    <ul className="inbox-list bt-ask">
      <InboxRow item={item} now={now} open={open} onToggle={() => setOpen((o) => !o)} canAnswer={can} onGit={onGit} />
    </ul>
  );
}

/**
 * What an agent shows at size: its live shell when `live` and it has one,
 * else a peek at its shell, else its transcript and facts (an agent from
 * elsewhere, or a scan's, has no canopy shell). `active` is whether the
 * live shell is the one showing; a kept one stays joined, hidden. With
 * `showing` off (a tile shown as a row) only a kept shell stays, hidden,
 * and nothing is read.
 */
export function AgentScreen({ card, live, active, showing = true, now }: { card: AgentCard; live: boolean; active: boolean; showing?: boolean; now: number }) {
  const tab = useCardShell(card);
  const run = useCardRun(card);
  const repo = useStore((s) => (run ? s.repos.find((r) => r.id === run.repoId) : undefined));
  // a canopy run or chat shows as the run sheet does: its timeline, its
  // prompt to answer, a chat's message box
  if (run) return showing ? <RunPane run={run} repo={repo} /> : null;
  const shell = tab && live;
  return (
    <>
      {shell && (
        <ShellSpotHere.Provider value="place">
          <TermView tab={tab} active={active && showing} quiet />
        </ShellSpotHere.Provider>
      )}
      {showing && !(shell && active) && (tab ? <Peek term={tab.id} /> : <div className="bt-detail"><AgentDetail card={card} now={now} /></div>)}
    </>
  );
}
