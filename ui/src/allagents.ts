import type { AgentCard, AgentKind, AgentState, Repo, Run, RunStatus, TermInfo } from "../../src/core/types";
import { isLiveAgent } from "../../src/core/types";
import { cardName, repoName, type IsChat } from "./agentcards";
import { coordTurn, isCoordinator } from "./coord";

/* Every agent the board shows, not only the broker's. The registry knows an
   agent through its tailchan hook, so a canopy run or chat, or a Claude or
   Codex in a canopy shell, is missing from it whenever there is no broker
   or no hook. Here those become cards of their own, shaped like the
   broker's, so the board's plans, keys and tiles take them as they take
   any other. A registry card that already names the run or the shell (its
   `where.canopy`) stands for it, and no second card is made. Pure. */

/** a run's card id: `run:` and the run's id as the page qualifies it */
export const RUN_CARD = "run:";
/** a shell's card id: `shell:` and the shell's id as the page qualifies it */
export const SHELL_CARD = "shell:";

export const isMadeCard = (id: string): boolean => id.startsWith(RUN_CARD) || id.startsWith(SHELL_CARD);

/** what an agent is called on the board: its repo, else (for a card made
 *  here, which has no handle) its folder, else its handle or harness */
export function agentName(c: AgentCard): string {
  const repo = repoName(c.repo);
  if (repo) return repo;
  const folder = c.cwd.replace(/\/+$/, "").split("/").pop();
  return isMadeCard(c.id) && folder ? folder : cardName(c);
}

/** one line on what a card made here is: a chat, a run's verb, or a shell
 *  whose agent has no hook to say what it does */
export function madeWord(c: AgentCard, run: Pick<Run, "chat" | "verb"> | undefined): string | null {
  if (c.id.startsWith(SHELL_CARD)) return `${c.harness} in a canopy shell, no hook: its state is a guess`;
  if (c.id.startsWith(RUN_CARD) && run) return run.chat ? "canopy chat" : `canopy run: ${run.verb}`;
  return null;
}

/** The ids the page qualifies, and back: a backend's own id for it. */
export interface Ids {
  split: (id: string) => [string, string];
  qual: (backend: string, id: string) => string;
}

/** A run's state as the broker words one: a chat between turns is the
 *  user's turn, as Claude's idle prompt is a hooked agent's. */
export function runState(s: RunStatus): AgentState {
  if (s === "working") return "working";
  if (s === "waiting" || s === "idle") return "waiting";
  return "ended";
}

const runWaits = (r: Run): string | null => {
  if (r.status === "idle") return isCoordinator(r) ? coordTurn(r) : "your turn";
  const p = r.prompt;
  if (r.status !== "waiting" || !p) return null;
  if (p.kind === "permission") return `permission: ${p.title}`;
  if (p.kind === "question") return p.questions[0]?.question ?? "a question";
  return "a plan to approve";
};

function base(id: string, backend: string, harness: AgentCard["harness"], repo: Repo | undefined, path: string): AgentCard {
  return {
    id,
    handle: "",
    node: backend,
    harness,
    session: null,
    origin: "canopy-shell",
    cwd: repo?.path ?? path,
    repo: repo?.link ?? null,
    branch: repo?.status?.branch ?? null,
    model: null,
    mode: null,
    state: "idle",
    waiting: null,
    caps: [],
    offers: [],
    notifyIdle: false,
    where: { os: "", container: false, pid: null, term: null, canopy: { backend } },
    transcript: null,
    startedAt: 0,
    seenAt: 0,
    endedAt: null,
  };
}

/** A canopy run or chat as a card. `where.canopy.run` is the backend's own
 *  run id, as a hook would have written it. */
export function runCard(r: Run, repo: Repo | undefined, ids: Ids): AgentCard {
  const [backend, plain] = ids.split(r.id);
  // an idle coordinator waits on its children, not on you, unless cards
  // wait for start these
  const state = r.status === "idle" && isCoordinator(r) && !coordTurn(r) ? "idle" : runState(r.status);
  const last = r.steps.at(-1)?.at ?? r.startedAt;
  const c = base(`${RUN_CARD}${r.id}`, backend, r.harness, repo, repo?.path ?? "");
  return {
    ...c,
    session: r.session ?? null,
    origin: "canopy-run",
    state,
    waiting: runWaits(r),
    where: { ...c.where, canopy: { backend, run: plain } },
    startedAt: r.startedAt,
    seenAt: r.endedAt ?? last,
    endedAt: state === "ended" ? (r.endedAt ?? last) : null,
  };
}

/** A canopy shell with Claude or Codex in it and no hook to say more: its
 *  state is unknown, so it reads as idle. */
export function shellCard(t: TermInfo, agent: AgentKind, repo: Repo | undefined, ids: Ids): AgentCard {
  const [backend, plain] = ids.split(t.id);
  const c = base(`${SHELL_CARD}${t.id}`, backend, agent, repo, t.path);
  return {
    ...c,
    handle: t.handle ?? "",
    where: { ...c.where, canopy: { backend, term: plain } },
    startedAt: t.startedAt,
    seenAt: t.startedAt,
  };
}

/** the qualified run or shell a card names, for matching */
const claimedBy = (c: AgentCard, ids: Pick<Ids, "qual">, kind: "run" | "term"): string | null => {
  const cw = c.where.canopy;
  const own = cw?.[kind];
  return own && cw.backend ? ids.qual(cw.backend, own) : null;
};

export interface AllAgentsInput {
  cards: readonly AgentCard[];
  runs: readonly Run[];
  shells: readonly TermInfo[];
  /** what `/api/terms/agent` said of each shell, by its qualified id */
  shellAgents: Readonly<Record<string, AgentKind | null>>;
  repos: readonly Repo[];
  ids: Ids;
}

/**
 * The registry's cards, then a card for each canopy run or chat and each
 * canopy shell running an agent that no registry card names. A shell is
 * named only by a live card: once the hooked agent in it ended, whatever
 * runs there now is its own. A task's session is never an agent here.
 */
export function allAgents({ cards, runs, shells, shellAgents, repos, ids }: AllAgentsInput): AgentCard[] {
  const repoOf = (id: string) => repos.find((r) => r.id === id);
  const runsNamed = new Set<string>();
  const shellsNamed = new Set<string>();
  for (const c of cards) {
    const run = claimedBy(c, ids, "run");
    if (run) runsNamed.add(run);
    const term = claimedBy(c, ids, "term");
    if (term && isLiveAgent(c)) shellsNamed.add(term);
  }
  const made: AgentCard[] = [];
  for (const r of runs) if (!runsNamed.has(r.id)) made.push(runCard(r, repoOf(r.repoId), ids));
  for (const t of shells) {
    const agent = shellAgents[t.id];
    if (t.task || !agent || shellsNamed.has(t.id)) continue;
    made.push(shellCard(t, agent, repoOf(t.repoId), ids));
  }
  // A process scan finds the same agent a shell's card stands for, with
  // less to say: the same harness in the same folder, started in the shell's
  // life. A scan card names a tailnet node, not a backend, so the folder and
  // the time are what tie the two.
  const madeShells = made.filter((c) => c.id.startsWith(SHELL_CARD));
  const echoes = (c: AgentCard) =>
    c.origin === "scan" && isLiveAgent(c) && madeShells.some((m) => m.harness === c.harness && m.cwd === c.cwd && c.startedAt >= m.startedAt);
  return [...cards.filter((c) => !echoes(c)), ...made];
}

/** the shells worth asking what runs in them: not a task's, and not one a
 *  live registry card already names */
export function shellsToProbe(cards: readonly AgentCard[], shells: readonly TermInfo[], ids: Ids): string[] {
  const named = new Set(cards.filter(isLiveAgent).map((c) => claimedBy(c, ids, "term")));
  return shells.filter((t) => !t.task && !named.has(t.id)).map((t) => t.id);
}

/** the run a card stands for, as the page keys its runs */
export const runOfCard = (c: AgentCard, ids: Ids): string | null => claimedBy(c, ids, "run");

/** Whether a card is a canopy chat's, given the chats' run ids as the page
 *  qualifies them: a made run card and a registry card naming the run
 *  alike. What sorts a chat with the sessions rather than the runs. */
export function chatOf(chats: readonly string[], ids: Pick<Ids, "qual">): IsChat {
  const set = new Set(chats);
  return (c) => {
    const run = claimedBy(c, ids, "run");
    return run !== null && set.has(run);
  };
}
