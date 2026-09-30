/** The event feed: every server event turned into the one-line entries the
 *  feed panel shows. Pure, so it is tested; the store hands it the event and
 *  what it knew before the event, and the difference is what the line says. */

import type {
  AgentRoutes,
  Fleet,
  Flow,
  Device,
  HelperInfo,
  Job,
  KeptShell,
  Repo,
  RepoStatus,
  Run,
  ServerEvent,
  SourceState,
  TaskInfo,
  TermInfo,
  Workspace,
} from "../../src/core/types";
import { chanLine } from "./chan";
import { peerLines } from "./peers";
import { taskLines } from "./tasks";
import { agentWord, harnessOf } from "./runs";

export type FeedKind =
  | "git"
  | "scan"
  | "run"
  | "flow"
  | "fleet"
  | "workspace"
  | "agent"
  | "launch"
  | "client"
  | "shell"
  | "chan"
  | "task";

export interface FeedEntry {
  id: number;
  /** unix ms, when the browser saw it */
  at: number;
  kind: FeedKind;
  /** the source the entry belongs to; "" for one about no source */
  source: string;
  repoId?: string;
  /** the repo's name, when the entry is about one */
  repo?: string;
  text: string;
  /** an entry that only says nothing changed, for a quieter view */
  quiet: boolean;
}

export type FeedLine = Omit<FeedEntry, "id">;

/** What the store knew before the event. */
export interface FeedSnapshot {
  repos: Repo[];
  sources: SourceState[];
  runs: Record<string, Run>;
  flows: Record<string, Flow>;
  fleets: Record<string, Fleet>;
  workspaces: Workspace[];
  /** downloads and builds; absent in a snapshot from before there were any */
  jobs?: Record<string, Job>;
  /** tasks by repo id, so a change can be told from a no-op */
  tasks?: Record<string, TaskInfo[]>;
  /** the tasks known to be running, for a repo whose list was never loaded */
  taskAll?: TaskInfo[];
  /** launch settings by repo path, so a change can be told from a no-op */
  launchers?: Record<string, unknown>;
  /** the helpers attached, so an attach can be told from a detach */
  helpers?: HelperInfo[];
  /** the devices on the stream, so a join can be told from a leave */
  devices?: Device[];
  /** the shells held, so a start can be told from a join */
  shells?: TermInfo[];
  /** the shells kept from before, so one being offered can be told from one
   *  being restored or forgotten */
  kept?: KeptShell[];
  /** the handle the UI speaks tailchan as, so its own posts read "you" */
  chanAs?: string;
}

/** how many entries the feed keeps; older ones fall off the top */
export const FEED_CAP = 500;
/** how many names a line spells out before it says "+N more" */
const NAMES = 3;
/** longest a quoted line of the agent's gets */
const CLIP = 120;

export const shortHash = (h: string): string => h.slice(0, 7);

/** "a, b, c +2 more" */
export function listNames(names: string[]): string {
  const shown = names.slice(0, NAMES).join(", ");
  const rest = names.length - NAMES;
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

/** one line of the agent's, clipped */
export function clip(text: string, max = CLIP): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function about(repo: Repo | undefined, kind: FeedKind, at: number, text: string, quiet = false): FeedLine {
  const line: FeedLine = { at, kind, source: repo?.source ?? "", text, quiet };
  if (repo) {
    line.repoId = repo.id;
    line.repo = repo.name;
  }
  return line;
}

/** What changed between two readings of a repo's status. Every difference is
 *  its own line; none means the watcher fired for nothing the card shows. */
export function statusLines(before: RepoStatus | null, after: RepoStatus | null): string[] {
  if (!after) return before ? ["status lost"] : [];
  if (!before) {
    const parts = [`on ${after.branch}`];
    if (after.files.length) parts.push(`${after.files.length} changed`);
    return [parts.join(", ")];
  }
  const lines: string[] = [];
  if (after.branch !== before.branch) lines.push(`switched to ${after.branch} from ${before.branch}`);
  if (after.lastCommit && after.lastCommit.hash !== before.lastCommit?.hash) {
    lines.push(`commit ${shortHash(after.lastCommit.hash)} ${after.lastCommit.subject}`);
  }
  if (after.ahead !== before.ahead || after.behind !== before.behind) {
    const pos: string[] = [];
    if (after.ahead) pos.push(`${after.ahead} ahead`);
    if (after.behind) pos.push(`${after.behind} behind`);
    lines.push(pos.length ? pos.join(", ") : "in sync with upstream");
  }
  if (after.tip && after.tip.hash !== before.tip?.hash) {
    lines.push(`${after.tip.ref} pushed ${shortHash(after.tip.hash)} ${after.tip.subject}`);
  }
  const was = new Map(before.files.map((f) => [f.path, f]));
  const now = new Map(after.files.map((f) => [f.path, f]));
  const added = after.files.filter((f) => !was.has(f.path)).map((f) => f.path);
  const gone = before.files.filter((f) => !now.has(f.path)).map((f) => f.path);
  const edited = after.files
    .filter((f) => {
      const old = was.get(f.path);
      return old !== undefined && (old.mtime !== f.mtime || old.index !== f.index || old.worktree !== f.worktree);
    })
    .map((f) => f.path);
  if (added.length) lines.push(`changed ${listNames(added)}`);
  if (edited.length) lines.push(`edited ${listNames(edited)}`);
  if (gone.length) lines.push(after.files.length === 0 ? "clean" : `reverted ${listNames(gone)}`);
  return lines;
}

function repoLines(ev: Extract<ServerEvent, { type: "repo" }>, prev: FeedSnapshot, at: number): FeedLine[] {
  const before = prev.repos.find((r) => r.id === ev.repo.id);
  const repo = ev.repo;
  if (repo.error && repo.error !== before?.error) return [about(repo, "git", at, `error: ${repo.error}`)];
  const lines: FeedLine[] = [];
  if (before?.error && !repo.error) lines.push(about(repo, "git", at, "error cleared"));
  const diffs = statusLines(before?.status ?? null, repo.status);
  for (const text of diffs) lines.push(about(repo, "git", at, text));
  for (const text of peerLines(before?.peers, repo.peers)) lines.push(about(repo, "git", at, text));
  // Zero where there was no count is not news; zero where there were some is.
  const open = repo.pulls?.open ?? 0;
  const was = before?.pulls?.open ?? 0;
  if (open !== was) {
    lines.push(about(repo, "git", at, open === 0 ? "no open pull requests" : `${open} open pull request${open === 1 ? "" : "s"}`));
  }
  if (lines.length === 0) lines.push(about(repo, "git", at, "re-read, no change", true));
  return lines;
}

function scanLines(ev: Extract<ServerEvent, { type: "scan" }>, prev: FeedSnapshot, at: number): FeedLine[] {
  const lines: FeedLine[] = [];
  const had = new Map(prev.sources.map((s) => [s.id, s]));
  const has = new Map(ev.result.sources.map((s) => [s.id, s]));
  const line = (source: string, text: string): FeedLine => ({ at, kind: "scan", source, text, quiet: false });
  for (const s of prev.sources) if (!has.has(s.id)) lines.push(line(s.id, `source ${s.label} removed`));
  for (const s of ev.result.sources) {
    const old = had.get(s.id);
    const mine = ev.result.repos.filter((r) => r.source === s.id);
    const oldMine = prev.repos.filter((r) => r.source === s.id);
    if (!old) {
      lines.push(line(s.id, `source ${s.label} added, ${mine.length} repo${mine.length === 1 ? "" : "s"}`));
      continue;
    }
    if (s.error && s.error !== old.error) {
      lines.push(line(s.id, `scan failed: ${s.error}`));
      continue;
    }
    if (old.error && !s.error) lines.push(line(s.id, "scan recovered"));
    if (s.scannedAt === old.scannedAt) continue;
    const oldIds = new Set(oldMine.map((r) => r.id));
    const newIds = new Set(mine.map((r) => r.id));
    const added = mine.filter((r) => !oldIds.has(r.id)).map((r) => r.name);
    const gone = oldMine.filter((r) => !newIds.has(r.id)).map((r) => r.name);
    const parts = [`rescanned, ${mine.length} repo${mine.length === 1 ? "" : "s"}`];
    if (added.length) parts.push(`new ${listNames(added)}`);
    if (gone.length) parts.push(`gone ${listNames(gone)}`);
    lines.push(line(s.id, parts.join("; ")));
  }
  return lines;
}

function workspaceLines(ev: Extract<ServerEvent, { type: "workspaces" }>, prev: FeedSnapshot, at: number): FeedLine[] {
  const lines: FeedLine[] = [];
  const had = new Map(prev.workspaces.map((w) => [w.name, w]));
  const has = new Map(ev.workspaces.map((w) => [w.name, w]));
  for (const w of prev.workspaces) if (!has.has(w.name)) lines.push({ at, kind: "workspace", source: "", text: `workspace ${w.name} removed`, quiet: false });
  for (const w of ev.workspaces) {
    const old = had.get(w.name);
    if (!old) lines.push({ at, kind: "workspace", source: "", text: `workspace ${w.name} created with ${w.repos.length} repo${w.repos.length === 1 ? "" : "s"}`, quiet: false });
    else if (old.repos.length !== w.repos.length || old.repos.some((p, i) => p !== w.repos[i])) {
      lines.push({ at, kind: "workspace", source: "", text: `workspace ${w.name} now ${w.repos.length} repo${w.repos.length === 1 ? "" : "s"}`, quiet: false });
    }
  }
  return lines;
}

/** what changed in a record keyed by name: added, changed and removed keys */
function keyed(before: Record<string, unknown>, after: Record<string, unknown>): { key: string; change: "added" | "changed" | "removed" }[] {
  const out: { key: string; change: "added" | "changed" | "removed" }[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null)) continue;
    out.push({ key, change: !(key in before) ? "added" : !(key in after) ? "removed" : "changed" });
  }
  return out;
}

/** The routing's changes: a repo's override, a profile, a role's route. */
function agentLines(ev: Extract<ServerEvent, { type: "agents" }>, prev: FeedSnapshot, at: number, prevAgents: AgentRoutes): FeedLine[] {
  const lines: FeedLine[] = [];
  const plain = (text: string): FeedLine => ({ at, kind: "agent", source: "", text, quiet: false });
  for (const { key: path, change } of keyed(prevAgents.repos, ev.agents.repos)) {
    const repo = prev.repos.find((r) => r.path === path);
    const text = change === "removed" ? "agent override reset" : "agent override changed";
    lines.push(repo ? about(repo, "agent", at, text) : plain(`${text} for ${path}`));
  }
  for (const { key, change } of keyed(prevAgents.profiles, ev.agents.profiles)) {
    lines.push(plain(`agent profile ${key} ${change === "removed" ? "deleted" : change}`));
  }
  for (const { key, change } of keyed(prevAgents.roles, ev.agents.roles)) {
    lines.push(plain(`${key} route ${change === "removed" ? "back to the default" : "changed"}`));
  }
  return lines;
}

function stepLine(run: Run, index: number): string | null {
  const st = run.steps[index];
  if (!st) return null;
  if (st.kind === "tool" && st.tool) return `${st.tool.name}: ${clip(st.tool.title, 100)}`;
  if (st.kind === "text" && st.text) return `${agentWord(harnessOf(run))}: ${clip(st.text)}`;
  if (st.kind === "user" && st.text) return `you: ${clip(st.text)}`;
  if (st.kind === "note" && st.text) return clip(st.text);
  return null;
}

function runLines(ev: Extract<ServerEvent, { type: "run" }>, prev: FeedSnapshot, at: number): FeedLine[] {
  const run = ev.run;
  const before = prev.runs[run.id];
  const repo = prev.repos.find((r) => r.id === run.repoId);
  const lines: FeedLine[] = [];
  const say = (text: string) => lines.push(about(repo, "run", at, text));
  if (!before) {
    say(run.chat ? "chat opened" : `${run.verb} started${run.note ? `: ${clip(run.note, 80)}` : ""}`);
  }
  for (let i = before?.steps.length ?? 0; i < run.steps.length; i++) {
    const text = stepLine(run, i);
    if (text) say(text);
  }
  if (before?.status !== run.status) {
    if (run.status === "waiting" && run.prompt) {
      say(run.prompt.kind === "permission" ? `asks to ${run.prompt.tool}: ${clip(run.prompt.title, 100)}` : "asks a question");
    } else if (run.status === "idle" && before) {
      say(`${agentWord(harnessOf(run))} answered, chat idle`);
    } else if (run.status === "done") {
      const tail = run.outcome ? `, ${run.outcome}` : "";
      say(`${run.verb} done${tail}${run.result ? ` in ${Math.round(run.result.durationMs / 1000)}s` : ""}`);
    } else if (run.status === "failed") {
      say(`${run.verb} failed${run.error ? `: ${clip(run.error, 100)}` : ""}`);
    } else if (run.status === "stopped") {
      say(`${run.verb} stopped`);
    } else if (run.status === "working" && before?.status === "waiting") {
      say("answered, working again");
    }
  }
  return lines;
}

function flowLines(ev: Extract<ServerEvent, { type: "flow" }>, prev: FeedSnapshot, at: number): FeedLine[] {
  const flow = ev.flow;
  const before = prev.flows[flow.id];
  const repo = prev.repos.find((r) => r.id === flow.repoId);
  const lines: FeedLine[] = [];
  const say = (text: string) => lines.push(about(repo, "flow", at, text));
  if (!before) say(`workflow ${flow.workflow} started${flow.fleetId ? " by fleet" : ""}`);
  flow.steps.forEach((st, i) => {
    const old = before?.steps[i];
    if (old?.status === st.status) return;
    if (st.status === "pending") return;
    const why = st.reason ? `: ${clip(st.reason, 100)}` : "";
    if (st.status === "running") say(`step ${st.name} running`);
    else if (st.status === "checking") say(`step ${st.name} checking`);
    else if (st.status === "gated") say(`step ${st.name} gated${why}`);
    else if (st.status === "passed") say(`step ${st.name} passed`);
    else if (st.status === "failed") say(`step ${st.name} failed${why}`);
    else if (st.status === "skipped") say(`step ${st.name} skipped${why}`);
  });
  if (before?.status !== flow.status) {
    if (flow.status === "done") say(`workflow ${flow.workflow} done${flow.outcome ? `, ${flow.outcome}` : ""}`);
    else if (flow.status === "failed") say(`workflow ${flow.workflow} failed${flow.error ? `: ${clip(flow.error, 100)}` : ""}`);
    else if (flow.status === "stopped") say(`workflow ${flow.workflow} stopped`);
  }
  return lines;
}

function fleetLines(ev: Extract<ServerEvent, { type: "fleet" }>, prev: FeedSnapshot, at: number): FeedLine[] {
  const fleet = ev.fleet;
  const before = prev.fleets[fleet.id];
  const lines: FeedLine[] = [];
  const say = (text: string) => lines.push({ at, kind: "fleet", source: "", text, quiet: false });
  if (!before) {
    say(`fleet ${fleet.workflow} over ${fleet.repos.length} repo${fleet.repos.length === 1 ? "" : "s"}`);
  }
  fleet.repos.forEach((fr, i) => {
    const old = before?.repos[i];
    if (fr.skipped && fr.skipped !== old?.skipped) {
      const repo = prev.repos.find((r) => r.id === fr.repoId);
      lines.push(about(repo, "fleet", at, `skipped: ${fr.skipped}`));
    }
  });
  if (before && before.status !== fleet.status) {
    if (fleet.status === "done") say(`fleet ${fleet.workflow} done`);
    else if (fleet.status === "stopped") say(`fleet ${fleet.workflow} stopped`);
  }
  return lines;
}

/**
 * The lines one event adds to the feed, given what the store held before it
 * was applied. `prevAgents` is the backend's agent routing, kept separate
 * because the snapshot's other fields are what every event needs and this
 * one is not.
 */
export function describeEvent(
  ev: ServerEvent,
  prev: FeedSnapshot,
  at: number,
  prevAgents: AgentRoutes = { profiles: {}, roles: {}, repos: {} },
): FeedLine[] {
  switch (ev.type) {
    case "repo":
      return repoLines(ev, prev, at);
    case "scan":
      return scanLines(ev, prev, at);
    case "workspaces":
      return workspaceLines(ev, prev, at);
    case "agents":
      return agentLines(ev, prev, at, prevAgents);
    case "run":
      return runLines(ev, prev, at);
    case "run-gone": {
      const run = prev.runs[ev.id];
      const repo = run ? prev.repos.find((r) => r.id === run.repoId) : undefined;
      return [about(repo, "run", at, run ? `${run.chat ? "chat" : run.verb} dismissed` : "run dismissed", true)];
    }
    case "flow":
      return flowLines(ev, prev, at);
    case "flow-gone": {
      const flow = prev.flows[ev.id];
      const repo = flow ? prev.repos.find((r) => r.id === flow.repoId) : undefined;
      return [about(repo, "flow", at, flow ? `workflow ${flow.workflow} dismissed` : "workflow dismissed", true)];
    }
    case "fleet":
      return fleetLines(ev, prev, at);
    case "fleet-gone": {
      const fleet = prev.fleets[ev.id];
      return [{ at, kind: "fleet", source: "", text: fleet ? `fleet ${fleet.workflow} dismissed` : "fleet dismissed", quiet: true }];
    }
    case "job":
      return jobLines(ev, prev, at);
    case "job-gone": {
      const job = prev.jobs?.[ev.id];
      const repo = job ? prev.repos.find((r) => r.id === job.repoId) : undefined;
      return [about(repo, "launch", at, job ? `${job.title} dismissed` : "job dismissed", true)];
    }
    case "builds": {
      const repo = prev.repos.find((r) => r.id === ev.repoId);
      const name = buildName(ev.build);
      const text =
        ev.what === "launched"
          ? `launched ${name}`
          : ev.what === "exited"
            ? `${name} exited`
            : ev.what === "removed"
              ? `removed ${name}`
              : ev.what === "installed"
                ? `installed ${name}`
                : `built ${name}`;
      // a job's own end line already said it was installed or built
      return [about(repo, "launch", at, text, ev.what === "installed" || ev.what === "built" || ev.what === "exited")];
    }
    case "launchers":
      return launcherLines(ev, prev, at);
    case "helpers": {
      // one line per helper that came or went since the last list
      const before = prev.helpers ?? [];
      const lines: FeedLine[] = [];
      for (const h of ev.helpers) {
        const was = before.find((b) => b.name === h.name);
        if (!was) lines.push(about(undefined, "client", at, `helper ${h.name} attached from ${h.address} (${h.openers.length ? h.openers.join(", ") : "no openers"})`));
        else if (was.since !== h.since) lines.push(about(undefined, "client", at, `helper ${h.name} reattached`, true));
      }
      for (const b of before) {
        if (!ev.helpers.some((h) => h.name === b.name)) lines.push(about(undefined, "client", at, `helper ${b.name} gone`));
      }
      return lines;
    }
    case "devices": {
      // who came and who went; a stream count change alone is a quiet line
      const before = prev.devices ?? [];
      const lines: FeedLine[] = [];
      for (const d of ev.devices) {
        const was = before.find((b) => b.id === d.id);
        if (!was) lines.push(about(undefined, "client", at, `${d.name} connected (${d.platform})`));
        else if (was.streams !== d.streams) lines.push(about(undefined, "client", at, `${d.name}: ${d.streams} ${d.streams === 1 ? "window" : "windows"}`, true));
        else if (was.name !== d.name) lines.push(about(undefined, "client", at, `${was.name} is now ${d.name}`, true));
      }
      for (const b of before) {
        if (!ev.devices.some((d) => d.id === b.id)) lines.push(about(undefined, "client", at, `${b.name} left`));
      }
      return lines;
    }
    case "terms": {
      // shells that started or ended; who joined or left one is quiet
      const before = prev.shells ?? [];
      const lines: FeedLine[] = [];
      const repoOf = (id: string) => prev.repos.find((r) => r.id === id);
      for (const t of ev.terms) {
        const was = before.find((b) => b.id === t.id);
        if (!was) lines.push(about(repoOf(t.repoId), "shell", at, `shell opened (${t.place})${t.viewers.length ? ` by ${t.viewers.join(", ")}` : ""}`));
        else if (was.viewers.join() !== t.viewers.join()) {
          const came = t.viewers.filter((v) => !was.viewers.includes(v));
          const went = was.viewers.filter((v) => !t.viewers.includes(v));
          const text = [...came.map((v) => `${v} joined the shell`), ...went.map((v) => `${v} left the shell`)].join(", ");
          if (text) lines.push(about(repoOf(t.repoId), "shell", at, text, true));
        }
      }
      for (const b of before) {
        if (!ev.terms.some((t) => t.id === b.id)) lines.push(about(repoOf(b.repoId), "shell", at, "shell ended"));
      }
      return lines;
    }
    case "kept": {
      // what the machine going down left behind, and what leaves the list
      // again as it is restored or forgotten
      const before = prev.kept ?? [];
      const lines: FeedLine[] = [];
      const repoOf = (id: string) => prev.repos.find((r) => r.id === id);
      for (const k of ev.kept) {
        if (!before.some((b) => b.id === k.id)) {
          lines.push(about(repoOf(k.repoId), "shell", at, `a shell from before is here to restore${k.agent ? ` (${k.agent} was running)` : ""}`));
        }
      }
      for (const b of before) {
        if (!ev.kept.some((k) => k.id === b.id)) lines.push(about(repoOf(b.repoId), "shell", at, "a kept shell is gone from the list", true));
      }
      return lines;
    }
    case "peers":
      return [];
    case "tasks": {
      const repo = prev.repos.find((r) => r.id === ev.repoId);
      return taskLines(prev.tasks?.[ev.repoId] ?? prev.taskAll?.filter((t) => t.repoId === ev.repoId), ev.tasks, at).map((text) => about(repo, "task", at, text));
    }
    case "chan":
      // a channel line canopy marked silent is a quiet one
      return [{ at, kind: "chan", source: "", text: chanLine(ev.message, prev.chanAs ?? ""), quiet: ev.message.meta["silent"] === true }];
  }
}

/** `release:v1.0` as "v1.0", `pr:12` as "PR #12", `local` as "this checkout". */
export function buildName(key: string): string {
  if (key === "local") return "this checkout";
  const pr = /^pr:(\d+)$/.exec(key);
  if (pr) return `PR #${pr[1]}`;
  return key.replace(/^release:/, "");
}

function jobLines(ev: Extract<ServerEvent, { type: "job" }>, prev: FeedSnapshot, at: number): FeedLine[] {
  const job = ev.job;
  const before = prev.jobs?.[job.id];
  const repo = prev.repos.find((r) => r.id === job.repoId);
  const lines: FeedLine[] = [];
  const say = (text: string, quiet = false) => lines.push(about(repo, "launch", at, text, quiet));
  if (!before) say(`${job.title} started`);
  if (before?.status !== job.status) {
    const secs = job.endedAt ? ` in ${Math.round((job.endedAt - job.startedAt) / 1000)}s` : "";
    if (job.status === "done") say(`${job.title} done${secs}`);
    else if (job.status === "failed") say(`${job.title} failed${job.error ? `: ${clip(job.error, 100)}` : ""}`);
    else if (job.status === "stopped") say(`${job.title} stopped`);
  }
  return lines;
}

function launcherLines(ev: Extract<ServerEvent, { type: "launchers" }>, prev: FeedSnapshot, at: number): FeedLine[] {
  const lines: FeedLine[] = [];
  const was = prev.launchers ?? {};
  for (const path of new Set([...Object.keys(was), ...Object.keys(ev.launchers)])) {
    if (JSON.stringify(was[path] ?? null) === JSON.stringify(ev.launchers[path] ?? null)) continue;
    const repo = prev.repos.find((r) => r.path === path);
    const text = path in ev.launchers ? "launch settings changed" : "launch settings reset";
    lines.push(repo ? about(repo, "launch", at, text) : { at, kind: "launch", source: "", text: `${text} for ${path}`, quiet: false });
  }
  return lines;
}

/** Appends lines to the feed, numbering them from `seq`, and keeps the feed
 *  under the cap by dropping the oldest. Returns the new list and next seq. */
export function appendFeed(
  feed: FeedEntry[],
  lines: FeedLine[],
  seq: number,
  cap = FEED_CAP,
): { feed: FeedEntry[]; seq: number } {
  if (lines.length === 0) return { feed, seq };
  const next = feed.concat(lines.map((l, i) => ({ ...l, id: seq + i })));
  return { feed: next.length > cap ? next.slice(next.length - cap) : next, seq: seq + lines.length };
}

/** The entries in view: one source's, or every source's, quiet ones optional. */
export function filterFeed(feed: FeedEntry[], source: string | null, quiet: boolean): FeedEntry[] {
  return feed.filter((e) => (quiet || !e.quiet) && (source === null || e.source === source || e.source === ""));
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** "14:05:09" local */
export function clock(at: number): string {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
