/**
 * A repo's knowledge graph (FR-072): canopy's copy of Understand-Anything
 * (Egonex-AI/Understand-Anything, MIT, in lib/understand-anything) turns a
 * checkout into a graph of its files, functions, classes and how they
 * connect, sorted into layers, with a guided tour and a plain-English
 * summary on every node. Its scripts do the mechanical half (scan,
 * tree-sitter, batching, merging); a canopy run of the user's own claude,
 * given the plugin with `--plugin-dir`, writes the summaries through the
 * plugin's subagents. The graph lands in the checkout's own `.ua/` (or the
 * legacy `.understand-anything/`), which canopy keeps out of git, and the
 * plugin's read-only viewer serves it through a preview slot, never at
 * canopy's origin.
 *
 * This file is the pure half: the run's spec and prompt, how the graph's
 * JSON reads, and the words a state is shown in. Browser-safe, so the page
 * and the CLI say the same thing. The Bun half is server/understand.ts.
 * Tested in understand.test.ts.
 */

import { TOOL_SETS, type ActionSpec } from "./actions";

/** the upstream release lib/understand-anything holds (VENDOR.md says how to move it) */
export const UNDERSTAND_VERSION = "2.9.8";

/** a graph run's action name, which the page and the CLI find it by */
export const UNDERSTAND_ACTION = "understand";

/** The graph's folder at the checkout's root: the legacy name when a
 *  checkout already has it, as the plugin itself decides, else `.ua`. */
export const UNDERSTAND_FOLDERS = [".understand-anything", ".ua"] as const;
export type UnderstandFolder = (typeof UNDERSTAND_FOLDERS)[number];

/** the folder a checkout's graph lives in, given which names exist there */
export const graphFolder = (exists: (name: UnderstandFolder) => boolean): UnderstandFolder => (exists(".understand-anything") ? ".understand-anything" : ".ua");

/** Where canopy's prepared copy of the plugin stands on this machine. It is
 *  installed and built once (bun install, the core and the dashboard) from
 *  lib/understand-anything into the config dir, on first use. */
export type UnderstandPlugin = { state: "ready" | "preparing" | "unprepared" } | { state: "failed"; error: string };
export type PluginState = UnderstandPlugin["state"];

/** no graph, a graph, or a graph file canopy cannot read */
export type GraphState = "none" | "graph" | "unknown";

/** What a checkout's graph file says, before git and the server. */
export interface UnderstandGraph {
  state: GraphState;
  /** when the graph was made (ISO), else null */
  analyzedAt: string | null;
  /** the commit it was made at, else null */
  commit: string | null;
  nodes: number | null;
  edges: number | null;
  /** nodes of type file */
  files: number | null;
  layers: number | null;
  /** the guided tour's steps */
  tour: number | null;
  /** why the graph could not be read, with state `unknown` */
  error?: string;
}

/** A checkout's graph as the route answers it. */
export interface UnderstandInfo extends UnderstandGraph {
  folder: UnderstandFolder;
  /** commits on HEAD since the graph's commit; null when git cannot tell */
  behind: number | null;
  /** files those commits changed; null as above */
  changed: number | null;
  /** the business-domain graph (/understand-domain) is there too */
  domain: boolean;
  /** per-file lessons (code-lessons.json) are there */
  lessons: boolean;
  plugin: UnderstandPlugin;
  /** the graph's viewer, while one answers for this checkout; its token
   *  comes only from `open`, an operate call */
  server: { port: number } | null;
  /** the canopy run making or updating the graph, while one is going */
  run: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const len = (v: unknown): number | null => (Array.isArray(v) ? v.length : null);

/** knowledge-graph.json as canopy keeps it: its size, when and at which
 *  commit it was made. Anything that is not a graph is state `unknown`. */
export function parseGraph(raw: unknown): UnderstandGraph {
  const blank = { analyzedAt: null, commit: null, nodes: null, edges: null, files: null, layers: null, tour: null };
  if (!isRecord(raw) || !Array.isArray(raw["nodes"]) || !Array.isArray(raw["edges"])) {
    return { state: "unknown", ...blank, error: "knowledge-graph.json is not a graph canopy can read" };
  }
  const project = isRecord(raw["project"]) ? raw["project"] : {};
  const nodes = raw["nodes"];
  return {
    state: "graph",
    analyzedAt: text(project["analyzedAt"]),
    commit: text(project["gitCommitHash"]),
    nodes: nodes.length,
    edges: raw["edges"].length,
    files: nodes.filter((n) => isRecord(n) && n["type"] === "file").length,
    layers: len(raw["layers"]),
    tour: len(raw["tour"]),
  };
}

/** meta.json's word on the last analysis, which an incremental update
 *  moves while the graph's own project block may lag; null when unreadable. */
export function parseMeta(raw: unknown): { analyzedAt: string | null; commit: string | null } | null {
  if (!isRecord(raw)) return null;
  const analyzedAt = text(raw["lastAnalyzedAt"]);
  const commit = text(raw["gitCommitHash"]);
  return analyzedAt || commit ? { analyzedAt, commit } : null;
}

/** The graph with meta.json laid over it, where meta.json says more. */
export function withMeta(graph: UnderstandGraph, meta: ReturnType<typeof parseMeta>): UnderstandGraph {
  if (graph.state !== "graph" || !meta) return graph;
  return { ...graph, analyzedAt: meta.analyzedAt ?? graph.analyzedAt, commit: meta.commit ?? graph.commit };
}

/** A viewer as canopy's state file records it. */
export interface UnderstandServer {
  pid: number;
  port: number;
  token: string;
  /** the checkout it serves (real path) */
  root: string;
  /** the prepared copy it runs from */
  key: string;
}

/** a state file read back, or null when it is not one canopy wrote */
export function parseServerState(raw: unknown): UnderstandServer | null {
  if (!isRecord(raw)) return null;
  const pid = num(raw["pid"]);
  const port = num(raw["port"]);
  const { token, root, key } = raw;
  if (pid === null || pid <= 0 || port === null || port <= 0 || port > 65535) return null;
  if (typeof token !== "string" || !/^[0-9a-f]{16,}$/.test(token)) return null;
  if (typeof root !== "string" || !root || typeof key !== "string" || !key) return null;
  return { pid, port, token, root, key };
}

/** A graph run's start: where the plugin is, where the checkout is, and
 *  what the user asked for. */
export interface UnderstandStart {
  /** canopy's prepared copy of the plugin, the run's `--plugin-dir` */
  pluginDir: string;
  /** the understand skill's folder inside it, where its scripts are */
  skillDir: string;
  /** the skill's scripts (`*.mjs` and `*.py` in skillDir), each allowed */
  scripts: readonly string[];
  /** the checkout's real path: the project root, and the root of the rule
   *  that lets the run write the graph's folder */
  root: string;
  folder: UnderstandFolder;
  /** the first graph, a refresh of what changed since, or a rebuild from
   *  nothing (`--full`) */
  how: GraphRun;
}

/** what a start does to the checkout's graph */
export type GraphRun = "make" | "update" | "rebuild";

/** The start a request asks for: a rebuild when it asks for one, else an
 *  update where a graph is there and the first graph where none is. */
export const graphRun = (state: GraphState, full: boolean): GraphRun => (full ? "rebuild" : state === "none" ? "make" : "update");

/** What a graph run may do without asking: read, git's reads, the skill's
 *  scripts (under node, or python for the two merge scripts), make its
 *  scratch folders, and write inside the graph's folder. Claude matches
 *  file rules on Edit alone, which covers Write too, and `//` starts an
 *  absolute path. The plugin's subagents run under the same rules. */
export function understandTools(s: Pick<UnderstandStart, "skillDir" | "scripts" | "root" | "folder">): string[] {
  const dir = `${s.root}/${s.folder}`;
  return [
    ...(TOOL_SETS["read"] ?? []),
    ...(TOOL_SETS["git-read"] ?? []),
    `Edit(/${dir}/**)`,
    `Bash(mkdir -p ${dir}:*)`,
    ...s.scripts.flatMap((name) =>
      name.endsWith(".py") ? [`Bash(python ${s.skillDir}/${name}:*)`, `Bash(python3 ${s.skillDir}/${name}:*)`] : [`Bash(node ${s.skillDir}/${name}:*)`],
    ),
  ];
}

/** The task paragraph of a graph run's prompt. The skill holds the method;
 *  this says which half of it applies and where canopy differs: the plugin
 *  is already built, canopy serves the graph, the ignore file goes ahead
 *  without a confirmation, no auto-update hook, and nothing outside the
 *  graph's folder is written or committed. */
export function understandTask(s: UnderstandStart): string {
  const args = [s.root, ...(s.how === "rebuild" ? ["--full"] : [])].join(" ");
  return [
    `Task: ${s.how === "make" ? "make a knowledge graph of this repository" : `${s.how} this repository's knowledge graph`} with the understand-anything:understand skill, which canopy loaded for this run (Understand-Anything ${UNDERSTAND_VERSION}, from ${s.pluginDir}). The graph maps the code's files, functions and classes and how they connect, sorted into layers, with a guided tour and a plain-English summary on every node, kept in ${s.folder}/ at the repository root. Invoke the skill first with the arguments "${args}" and follow it.`,
    {
      make: "There is no graph yet: the skill runs its full analysis.",
      update: "A graph is there already: the skill's pre-flight decides how much to redo. If it says the graph is current at this commit, ask with AskUserQuestion as the skill says.",
      rebuild: "Rebuild the graph from nothing (--full), whatever is there now.",
    }[s.how],
    `The project root is ${s.root}. The plugin root (PLUGIN_ROOT) is ${s.pluginDir}; canopy installed and built it, so never install or build it, and skip step 1.5's build.`,
    "Where canopy differs from the skill's own steps:",
    "- Stop once the graph is saved and reported. Do not run /understand-dashboard or anything that serves or opens the graph (no npx, no vite, no browser): canopy serves it in this repository's map section, so end with the skill's report, without a URL.",
    "- Phase 0.5: use the .understandignore the script writes as it is and go on without waiting for a confirmation.",
    "- Never turn auto-update on: no --auto-update, and leave config.json's autoUpdate as it is.",
    `- Write only inside ${s.folder}/, and commit nothing: canopy keeps the folder out of git.`,
  ].join("\n");
}

/** A graph run's spec: an ask, read-mostly, whose prompt is the task above
 *  plus the user's note. The skill fans a large repo out over many
 *  subagent batches, so the cap is high. */
export function understandSpec(s: UnderstandStart): ActionSpec {
  return {
    label: startWord(s.how),
    verb: "understand",
    blurb:
      "Claude reads the code with Understand-Anything's scripts and subagents and writes a knowledge graph of its files, functions, classes and layers, with a guided tour, into the repo's graph folder (kept out of git). It asks before running anything beyond reading, git's reads and the plugin's own scripts.",
    notePlaceholder: "anything the graph should know (optional)",
    noteRequired: false,
    allowedTools: understandTools(s),
    maxTurns: 400,
    progress: "understanding",
    expectsChange: false,
    mode: "ask",
    task: understandTask(s),
  };
}

/** "make the graph", "update the graph" or "rebuild the graph", for a
 *  button, the run's label and the CLI. */
export const startWord = (how: GraphRun): string => `${how} the graph`;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** One line for a checkout's graph, as the section and `canopy understand`
 *  show it. `ago` words a time (the page's "3h ago", the CLI's own). */
export function understandLine(info: Pick<UnderstandInfo, "state" | "analyzedAt" | "nodes" | "edges" | "files" | "layers" | "behind" | "changed" | "error">, ago: (iso: string) => string): string {
  switch (info.state) {
    case "none":
      return "no graph yet";
    case "unknown":
      return `could not read the graph${info.error ? `: ${info.error}` : ""}`;
    case "graph": {
      const size = [
        info.nodes !== null ? plural(info.nodes, "node") : "",
        info.files !== null ? plural(info.files, "file") : "",
        info.layers ? plural(info.layers, "layer") : "",
      ].filter(Boolean);
      const made = info.analyzedAt ? `, made ${ago(info.analyzedAt)}` : "";
      const since = info.behind ? `; ${plural(info.behind, "commit")} since${info.changed ? `, ${plural(info.changed, "file")} changed` : ""}` : "";
      return `${size.length ? size.join(" in ").replace(/ in (\d+ layers?)$/, ", $1") : "a graph"}${made}${since}`;
    }
  }
}

/** The few words after the section's name: what state the graph is in. */
export function understandHead(info: Pick<UnderstandInfo, "state" | "behind" | "run" | "plugin"> | null): string {
  if (!info) return "";
  if (info.run) return "understanding";
  if (info.plugin.state === "preparing") return "getting ready";
  switch (info.state) {
    case "graph":
      return info.behind ? `${info.behind} behind` : "current";
    case "unknown":
      return "unreadable";
    case "none":
      return "";
  }
}

/** What the page and the CLI say while the plugin is being prepared. */
export const PREPARING_WORDS = "getting Understand-Anything ready on this backend (the first time it installs and builds, a minute or two)";

/** A refusal or wait from the route, in words. `preparing` is the 202 a
 *  start or an open answers while the plugin is not built yet. */
export interface UnderstandWait {
  preparing: true;
  plugin: UnderstandPlugin;
}

export const isWait = (v: unknown): v is UnderstandWait => isRecord(v) && v["preparing"] === true;
