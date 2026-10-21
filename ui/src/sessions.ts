import type { AgentCard, Repo, TermInfo } from "../../src/core/types";
import { isLiveAgent } from "../../src/core/types";
import { orderCards, repoOfCard } from "./agentcards";
import type { TermTab } from "./term";

/** A repo's dot in the sessions view's machines tree, most pressing first:
 *  an agent waiting, one working, a shell or idle agent, uncommitted
 *  changes, nothing. */
export type RepoTone = "waiting" | "working" | "live" | "dirty" | "quiet";

const TONE_RANK: Record<RepoTone, number> = { waiting: 0, working: 1, live: 2, dirty: 3, quiet: 4 };

export interface MachineRepo {
  id: string;
  name: string;
  branch: string | null;
  tone: RepoTone;
  shells: number;
  agents: number;
}

export interface Machine {
  name: string;
  home: boolean;
  /** the most pressing tone among its repos */
  tone: RepoTone;
  repos: MachineRepo[];
}

export interface MachinesInput {
  home: string;
  /** the other backends on the page, in their order */
  shown: readonly string[];
  repos: readonly Repo[];
  /** the shells the backends hold */
  shells: readonly TermInfo[];
  /** this browser's tabs, which a shell not yet reported still counts by */
  tabs: readonly TermTab[];
  cards: readonly AgentCard[];
  backendOf: (id: string) => string;
}

const isShell = (t: { task?: string; ranger?: true }): boolean => t.task === undefined && !t.ranger;

const under = (cwd: string, path: string): boolean => cwd === path || cwd.startsWith(`${path.replace(/\/+$/, "")}/`);

/** The repo on `mine` (one backend's checkouts) a live card works in. A
 *  canopy card names its backend, so it only matches that one's; any other
 *  card matches by folder alone, since a web url would put it on every
 *  machine holding a checkout. */
function repoOn(c: AgentCard, machine: string, mine: readonly Repo[]): Repo | undefined {
  const on = c.where.canopy?.backend;
  if (on) return on === machine ? repoOfCard(c, mine) : undefined;
  if (!c.cwd) return undefined;
  return mine.filter((r) => !r.host && under(c.cwd, r.path)).sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * The sessions view's machines: this backend first, then the others shown,
 * each with the repos worth a row there: one with a shell or a live agent,
 * one starred, or `keep` (the repo of the session showing). Rows sort by
 * name so a dot changing never moves one.
 */
export function machinesOf(i: MachinesInput, keep: readonly string[] = []): Machine[] {
  const names = [i.home, ...i.shown.filter((n) => n !== i.home)];
  const shells = new Map<string, number>();
  const bump = (id: string) => shells.set(id, (shells.get(id) ?? 0) + 1);
  for (const t of i.shells) if (isShell(t)) bump(t.repoId);
  // a tab whose shell the backend has not reported yet
  for (const t of i.tabs) if (isShell(t) && !i.shells.some((s) => s.id === t.id)) bump(t.repoId);
  const live = i.cards.filter(isLiveAgent);
  return names.map((name) => {
    const mine = i.repos.filter((r) => !r.forge && i.backendOf(r.id) === name);
    const agents = new Map<string, AgentCard[]>();
    for (const c of live) {
      const r = repoOn(c, name, mine);
      if (r) agents.set(r.id, [...(agents.get(r.id) ?? []), c]);
    }
    const repos: MachineRepo[] = mine
      .filter((r) => shells.has(r.id) || agents.has(r.id) || r.favorite || keep.includes(r.id))
      .map((r) => {
        const on = agents.get(r.id) ?? [];
        const n = shells.get(r.id) ?? 0;
        const tone: RepoTone = on.some((c) => c.state === "waiting")
          ? "waiting"
          : on.some((c) => c.state === "working")
            ? "working"
            : n > 0 || on.length > 0
              ? "live"
              : (r.status?.files.length ?? 0) > 0
                ? "dirty"
                : "quiet";
        return { id: r.id, name: r.name, branch: r.status?.branch ?? null, tone, shells: n, agents: on.length };
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const tone = repos.reduce<RepoTone>((t, r) => (TONE_RANK[r.tone] < TONE_RANK[t] ? r.tone : t), "quiet");
    return { name, home: name === i.home, tone, repos };
  });
}

/** The shell a repo's row brings up when no tab here shows one: a shell the
 *  backend holds at the repo (hidden here, in a panel, or another device's),
 *  a strip one before a panel one, the newest first. Null when there is
 *  none, and only then does the row start a new shell. */
export function heldShellAt(repoId: string, shells: readonly TermInfo[], tabs: readonly { id: string }[]): TermInfo | null {
  const held = shells.filter((t) => t.repoId === repoId && isShell(t) && !tabs.some((x) => x.id === t.id));
  held.sort((a, b) => Number(a.place !== "strip") - Number(b.place !== "strip") || b.startedAt - a.startedAt);
  return held[0] ?? null;
}

/** What the tab row shows: every tab, one machine's, or one repo's, picked
 *  in the left column. */
export type TabScope = { repo: string } | { machine: string } | null;

/** The tabs in `scope`, in their order. */
export function tabsIn<T extends { repoId: string }>(tabs: readonly T[], scope: TabScope, backendOf: (id: string) => string): T[] {
  if (!scope) return [...tabs];
  if ("repo" in scope) return tabs.filter((t) => t.repoId === scope.repo);
  return tabs.filter((t) => backendOf(t.repoId) === scope.machine);
}

/** The tab to show once the scope changed: the one showing when it is still
 *  in, else the last one in; null when the scope has none. */
export function showingIn(tabs: readonly { id: string }[], active: string | null): string | null {
  return tabs.some((t) => t.id === active) ? active : (tabs.at(-1)?.id ?? null);
}

/** The strip shells the backends hold that no tab here shows (hidden here,
 *  or another device's), oldest first: what the tab row offers to bring
 *  back. Panel shells stay with their panels. */
export function untabbed(shells: readonly TermInfo[], tabs: readonly { id: string }[]): TermInfo[] {
  return shells.filter((t) => isShell(t) && t.place === "strip" && !tabs.some((x) => x.id === t.id)).sort((a, b) => a.startedAt - b.startedAt);
}

/** The agents list: every live agent, waiting first, then working, idle;
 *  newest first within each. */
export const agentRows = (cards: readonly AgentCard[]): AgentCard[] => orderCards(cards.filter(isLiveAgent));

/** The tab `by` steps from `active`, wrapping; null with no tabs. */
export function stepTab(tabs: readonly { id: string }[], active: string | null, by: 1 | -1): string | null {
  if (tabs.length === 0) return null;
  const at = tabs.findIndex((t) => t.id === active);
  if (at < 0) return (by === 1 ? tabs[0] : tabs.at(-1))?.id ?? null;
  return tabs[(at + by + tabs.length) % tabs.length]?.id ?? null;
}

/** The next waiting agent after `current` in the list's order, wrapping;
 *  null when none waits. */
export function nextWaitingRow(rows: readonly AgentCard[], current: string | null): string | null {
  const waiting = rows.filter((c) => c.state === "waiting");
  if (waiting.length === 0) return null;
  const at = waiting.findIndex((c) => c.id === current);
  return waiting[(at + 1) % waiting.length]?.id ?? null;
}

export type SessionsKey = "next-tab" | "prev-tab" | "new" | "next-waiting";

/** The view's own keys, never from a field or a terminal (whose keys are
 *  the shell's), and never with a modifier. */
export function sessionsKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, inField: boolean): SessionsKey | null {
  if (inField || e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case "]":
      return "next-tab";
    case "[":
      return "prev-tab";
    case "n":
      return "new";
    case "w":
      return "next-waiting";
    default:
      return null;
  }
}

/** Repos for the "new shell" picker: names containing `q`, those starting
 *  with it first, at most `max`. */
export function pickRepos(repos: readonly Repo[], q: string, max = 8): Repo[] {
  const want = q.trim().toLowerCase();
  if (!want) return [];
  return repos
    .filter((r) => !r.forge && r.name.toLowerCase().includes(want))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(want)) - Number(!b.name.toLowerCase().startsWith(want)) || a.name.localeCompare(b.name))
    .slice(0, max);
}
