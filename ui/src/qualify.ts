import type {
  Device,
  Fleet,
  Flow,
  GrepRepoResult,
  HealthCheck,
  HistoryOverview,
  Job,
  KeptShell,
  LandingInfo,
  PrWatch,
  Repo,
  RepoHistory,
  Run,
  ScanResult,
  TaskInfo,
  ServerEvent,
  SourceState,
  Sprout,
  SproutDetail,
  TermInfo,
} from "../../src/core/types";
import type { TriggerEvent } from "../../src/core/trigger";
import type { Collision } from "../../src/core/touch";

/* What one backend sends, with every id it minted given the backend's name
   (through `q`), so two backends' ids never meet. Pure; the api layer is
   the only caller outside the tests. Paths, names and settings maps keyed
   by path pass through: they belong to the backend and are kept per
   backend by the store. */

/** An id mapper: `qualify` with the registry and a backend filled in. */
export type Q = (id: string) => string;

export const qRepo = (q: Q, r: Repo): Repo => ({
  ...r,
  id: q(r.id),
  source: q(r.source),
  ...(r.forge?.clonedAs !== undefined ? { forge: { ...r.forge, clonedAs: q(r.forge.clonedAs) } } : {}),
});

export const qSource = (q: Q, s: SourceState): SourceState => ({ ...s, id: q(s.id) });

export const qScan = (q: Q, t: ScanResult): ScanResult => ({
  ...t,
  repos: t.repos.map((r) => qRepo(q, r)),
  sources: t.sources.map((s) => qSource(q, s)),
});

export const qRun = (q: Q, r: Run): Run => ({
  ...r,
  id: q(r.id),
  repoId: q(r.repoId),
  ...(r.branch ? { branch: { ...r.branch, origin: q(r.branch.origin) } } : {}),
  // a coordinator's child names it, and its cards name their repos and runs
  ...(r.parent !== undefined ? { parent: q(r.parent) } : {}),
  ...(r.tasks ? { tasks: r.tasks.map((t) => ({ ...t, repo: q(t.repo), ...(t.run !== undefined ? { run: q(t.run) } : {}) })) } : {}),
});

/** The landing queue: a branch's id, its runs' and its repo's under the
 *  backend's name. Folders stay the backend's own. */
export const qLanding = (q: Q, l: LandingInfo): LandingInfo => ({
  runs: l.runs.map((r) => ({ ...r, id: q(r.id), runId: q(r.runId), repoId: q(r.repoId) })),
  entries: l.entries.map((e) => ({ ...e, id: q(e.id), repoId: q(e.repoId), ...(e.fixing !== undefined ? { fixing: q(e.fixing) } : {}) })),
  orphans: l.orphans,
  notices: (l.notices ?? []).map((n) => ({ ...n, id: q(n.id), entry: q(n.entry), repoId: q(n.repoId) })),
  ...(l.collisions !== undefined ? {
    collisions: l.collisions.map((collision): Collision => ({
      ...collision,
      id: q(collision.id),
      repoId: q(collision.repoId),
      run: q(collision.run),
      with: collision.with.kind === "run"
        ? { ...collision.with, run: q(collision.with.run) }
        : collision.with.kind === "branch"
          ? { ...collision.with, origin: q(collision.with.origin) }
          : collision.with,
    })),
  } : {}),
});

/** The PR watches: a branch's id, its run's and its repo's under the
 *  backend's name, and the fix run going. Folders stay the backend's own. */
export const qPrs = (q: Q, prs: readonly PrWatch[]): PrWatch[] =>
  prs.map((w) => ({ ...w, id: q(w.id), runId: q(w.runId), repoId: q(w.repoId), ...(w.fixing ? { fixing: { ...w.fixing, run: q(w.fixing.run) } } : {}) }));

/** Trigger events: the event's id, its repo's, its run's and its branch's
 *  under the backend's name. */
export const qTriggers = (q: Q, events: readonly TriggerEvent[]): TriggerEvent[] =>
  events.map((e) => ({
    ...e,
    id: q(e.id),
    repoId: q(e.repoId),
    ...(e.runId !== undefined ? { runId: q(e.runId) } : {}),
    ...(e.branch !== undefined ? { branch: q(e.branch) } : {}),
  }));

export const qFlow = (q: Q, f: Flow): Flow => ({
  ...f,
  id: q(f.id),
  repoId: q(f.repoId),
  ...(f.fleetId !== undefined ? { fleetId: q(f.fleetId) } : {}),
  steps: f.steps.map((st) => (st.runId !== undefined ? { ...st, runId: q(st.runId) } : st)),
});

export const qFleet = (q: Q, f: Fleet): Fleet => ({
  ...f,
  id: q(f.id),
  repos: f.repos.map((r) => ({
    ...r,
    repoId: q(r.repoId),
    ...(r.flowId !== undefined ? { flowId: q(r.flowId) } : {}),
  })),
});

export const qTask = (q: Q, t: TaskInfo): TaskInfo => ({ ...t, repoId: q(t.repoId), termId: q(t.termId) });
export const qJob = (q: Q, j: Job): Job => ({ ...j, id: q(j.id), repoId: q(j.repoId) });

export const qTerm = (q: Q, t: TermInfo): TermInfo => ({ ...t, id: q(t.id), repoId: q(t.repoId) });

export const qKept = (q: Q, k: KeptShell): KeptShell => ({ ...k, id: q(k.id), repoId: q(k.repoId) });

/** A device's id is the browser's own, the same on every backend; qualified,
 *  one browser on two backends is two rows, each with its backend's word. */
export const qDevice = (q: Q, d: Device): Device => ({ ...d, id: q(d.id) });

/** A sprout's own id, its seed's repo id, the flows it ran and an extend's
 *  target are all the backend's, so a sheet opens the right flow. */
export const qSprout = (q: Q, s: Sprout): Sprout => ({
  ...s,
  id: q(s.id),
  repoId: q(s.repoId),
  flows: s.flows.map((f) => ({ ...f, flowId: q(f.flowId) })),
  ...(s.retro ? { retro: { ...s.retro, ...(s.retro.flowId !== undefined ? { flowId: q(s.retro.flowId) } : {}) } } : {}),
  ...(s.work?.kind === "extend" ? { work: { ...s.work, target: q(s.work.target) } } : {}),
});

export const qSproutDetail = (q: Q, d: SproutDetail): SproutDetail => ({ ...d, sprout: qSprout(q, d.sprout) });

export const qHistory = (q: Q, h: HistoryOverview): HistoryOverview =>
  h.available ? { ...h, repos: Object.fromEntries(Object.entries(h.repos).map(([id, v]) => [q(id), v])) } : h;

export const qGrep = (q: Q, g: GrepRepoResult): GrepRepoResult => ({ ...g, repo: q(g.repo) });

export function qEvent(q: Q, ev: ServerEvent): ServerEvent {
  switch (ev.type) {
    case "repo":
      return { ...ev, repo: qRepo(q, ev.repo) };
    case "scan":
      return { ...ev, result: qScan(q, ev.result) };
    case "run":
      return { ...ev, run: qRun(q, ev.run) };
    case "flow":
      return { ...ev, flow: qFlow(q, ev.flow) };
    case "fleet":
      return { ...ev, fleet: qFleet(q, ev.fleet) };
    case "job":
      return { ...ev, job: qJob(q, ev.job) };
    case "run-gone":
    case "flow-gone":
    case "fleet-gone":
    case "job-gone":
      return { ...ev, id: q(ev.id) };
    case "builds":
      return { ...ev, repoId: q(ev.repoId) };
    case "terms":
      return { ...ev, terms: ev.terms.map((t) => qTerm(q, t)) };
    case "devices":
      return { ...ev, devices: ev.devices.map((d) => qDevice(q, d)) };
    case "kept":
      return { ...ev, kept: ev.kept.map((k) => qKept(q, k)) };
    case "tasks":
      return { ...ev, repoId: q(ev.repoId), tasks: ev.tasks.map((t) => qTask(q, t)) };
    case "incubator":
      return { ...ev, sprout: qSprout(q, ev.sprout) };
    case "incubator-gone":
      return { ...ev, id: q(ev.id) };
    case "workspaces":
    case "agents":
    case "launchers":
    // a repo scope is an absolute path, a step's a workflow's name: no id to qualify
    case "remembered":
    case "helpers":
    case "peers":
    case "chan":
    // the registry's cards and the asks are the broker's, named by the
    // broker's own ids; only home's are read (the store drops any other
    // backend's)
    case "registry":
    case "asks":
    // where a backend runs stages is kept per backend by the store; the
    // retro lessons on offer are the home backend's alone
    case "stages":
    case "advice":
    // the ranger's ids are its backend's own; the store qualifies its tab
    case "ranger":
    // the sweep is the home backend's alone, like the ranger
    case "sweep":
      return ev;
    case "health":
      return { ...ev, checks: ev.checks.map((c) => qCheck(q, c)) };
    case "capacity":
      return {
        ...ev,
        capacity: {
          ...ev.capacity,
          held: ev.capacity.held.map((h) => ({ ...h, id: q(h.id), repoId: q(h.repoId) })),
        },
      };
    case "landing":
      return { ...ev, landing: qLanding(q, ev.landing) };
    case "prs":
      return { ...ev, prs: qPrs(q, ev.prs) };
    case "triggers":
      return { ...ev, events: qTriggers(q, ev.events) };
    // the kit names machines, not repos: nothing to qualify
    case "kit":
    case "secrets":
    // pair ids are the backend's own and name no repo
    case "auth":
    // keep awake names no repo; the store files it under its backend
    case "awake":
      return ev;
  }
}

/** a repo's check names its repo as this page does */
export const qCheck = (q: Q, c: HealthCheck): HealthCheck => (c.scope.kind === "repo" ? { ...c, scope: { kind: "repo", repoId: q(c.scope.repoId) } } : c);

type Available = Extract<HistoryOverview, { available: true }>;

/** Several backends' archive overviews as one, on the first available
 *  one's days: a day it does not cover drops out of the others' arrays and
 *  a day they lack is 0, so every ring on the board shares one strip. One
 *  overview is handed back as it is. */
export function mergeHistory(parts: readonly HistoryOverview[]): HistoryOverview | null {
  if (parts.length === 1) return parts[0] ?? null;
  const ok = parts.filter((p): p is Available => p.available);
  const base = ok[0];
  if (!base) return parts[0] ?? null;
  const at = new Map(base.days.map((d, i) => [d, i]));
  const align = (days: string[], vals: number[]): number[] => {
    const out = base.days.map(() => 0);
    days.forEach((d, i) => {
      const j = at.get(d);
      if (j !== undefined) out[j] = vals[i] ?? 0;
    });
    return out;
  };
  const repos: Record<string, RepoHistory> = {};
  let maxDay = 0;
  for (const p of ok) {
    maxDay = Math.max(maxDay, p.maxDay);
    for (const [id, h] of Object.entries(p.repos)) {
      repos[id] = p === base ? h : { ...h, days: align(p.days, h.days), daySessions: align(p.days, h.daySessions) };
    }
  }
  return { available: true, days: base.days, maxDay, repos, fetchedAt: base.fetchedAt };
}
