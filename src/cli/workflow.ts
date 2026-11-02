/** `canopy workflow`: a workflow's graph as indented text or Graphviz DOT,
 *  a file checked before a flow runs it, and the workflows a repo can run
 *  with their problems (FR-034). With --repo the backend answers, adding
 *  the repo's own folder and its `.canopy/workflows.json` as HEAD holds
 *  it; without, this machine's bundled and user folders are read. */

import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { graphOf, graphStep, isChain } from "../core/flowgraph";
import type { GraphStep, ScanResult, Workflow, WorkflowEntry, WorkflowGraph } from "../core/types";
import { parseWorkflow } from "../core/workflow";
import { loadWorkflows } from "../core/workflows";
import { ask, errText, has, take, Unreachable, type Target } from "./health";

export const WORKFLOW_USAGE = [
  "usage: canopy workflow show <name> [--repo R] [--dot] [--backend URL]",
  "       canopy workflow check <file>",
  "       canopy workflow list [--repo R] [--backend URL]",
].join("\n");

const entryName = (e: WorkflowEntry): string => (e.ok ? e.workflow.name : e.name);

/** The steps as the repo would run them: the graph's when the backend sent
 *  one, else the file's own. */
const stepsOf = (wf: Workflow, graph: WorkflowGraph | undefined): GraphStep[] => graph?.steps ?? wf.steps.map(graphStep);

const modeWord = (s: GraphStep): string | null => {
  if (s.modeFrom === "repo") return `${s.mode} (repo)`;
  return s.mode === "manual" ? "manual" : null;
};

/** What a step says beyond its name, in the order a reader asks: what it
 *  waits for, when it runs, who releases it, what decides after it. */
function facts(s: GraphStep): string[] {
  const out: string[] = [];
  if (s.after.length > 0) out.push(`after ${s.after.join(", ")}`);
  if (!(s.when.length === 1 && s.when[0] === "always")) out.push(`when ${s.when.join(", ")}`);
  const mode = modeWord(s);
  if (mode) out.push(mode);
  if (s.gate !== "continue") out.push(`gate ${s.gate}`);
  if (s.check) out.push(`check ${s.check}`);
  if (s.retries > 0) out.push(`retries ${s.retries}${s.back !== s.name ? `, back ${s.back}` : ""}`);
  return out;
}

/** One line per step in heading order, indented by its column, then what
 *  the repo's modes file says about this workflow. */
export function showLines(wf: Workflow, graph?: WorkflowGraph): string[] {
  const steps = stepsOf(wf, graph);
  const { depth } = graphOf(steps);
  const lead = steps.map((s) => `${"  ".repeat(depth[s.name] ?? 0)}${s.name}`);
  const width = Math.max(...lead.map((l) => l.length)) + 2;
  return [
    `${wf.name}  ${wf.source}  ${wf.file}`,
    ...steps.map((s, i) => {
      const said = facts(s);
      const head = lead[i] ?? s.name;
      return said.length === 0 ? head : `${head.padEnd(width)}${said.join(" · ")}`;
    }),
    ...(graph?.error ? [`modes: ${graph.error}; a flow of ${wf.name} is refused until it is fixed`] : []),
    ...(graph?.warnings ?? []).map((w) => `warning: ${w}`),
  ];
}

const quote = (text: string): string => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The graph as Graphviz DOT: a box per step, labelled with its mode and
 *  gate when they are not the plain ones, `after` as arrows (labelled with
 *  the step's `when`), `back` as dashed arrows. canopy does not render it. */
export function dotText(wf: Workflow, graph?: WorkflowGraph): string {
  const steps = stepsOf(wf, graph);
  const { edges } = graphOf(steps);
  const lines = [`digraph ${quote(wf.name)} {`, "  rankdir=LR;", "  node [shape=box];"];
  for (const s of steps) {
    const extra = [modeWord(s), s.gate !== "continue" ? `gate ${s.gate}` : null].filter((x): x is string => x !== null);
    const attrs = [
      ...(extra.length > 0 ? [`label=${quote([s.name, ...extra].join("\n")).replace(/\n/g, "\\n")}`] : []),
      ...(s.mode === "manual" ? ["style=bold"] : []),
    ];
    lines.push(`  ${quote(s.name)}${attrs.length > 0 ? ` [${attrs.join(", ")}]` : ""};`);
  }
  for (const e of edges) {
    const attrs = e.kind === "back" ? ["style=dashed", 'label="back"'] : e.when ? [`label=${quote(`when ${e.when.join(", ")}`)}`] : [];
    lines.push(`  ${quote(e.from)} -> ${quote(e.to)}${attrs.length > 0 ? ` [${attrs.join(", ")}]` : ""};`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** The list: a line per workflow with its source and shape, the repo's
 *  say on its steps, and under it what is wrong with it; a modes file that
 *  cannot be read once at the end, since it holds every flow. */
export function listLines(title: string, entries: readonly WorkflowEntry[]): string[] {
  if (entries.length === 0) return [`${title}: no workflows`];
  const width = Math.max(...entries.map((e) => entryName(e).length)) + 2;
  const pad = " ".repeat(2 + width + 9);
  const out = [title];
  let broken: string | undefined;
  for (const e of entries) {
    const head = `  ${entryName(e).padEnd(width)}${(e.ok ? e.workflow.source : e.source).padEnd(9)}`;
    if (!e.ok) {
      out.push(`${head}does not parse: ${e.error}`);
      continue;
    }
    const steps = stepsOf(e.workflow, e.graph);
    const shape = `${steps.length} ${steps.length === 1 ? "step" : "steps"}${isChain(steps) ? "" : " as a graph"}`;
    const repo = Object.entries(e.graph?.modes ?? {}).map(([step, mode]) => `${step} ${mode} (repo)`);
    const manual = steps.filter((s) => s.mode === "manual" && s.modeFrom !== "repo").map((s) => `${s.name} manual`);
    out.push(`${head}${[shape, ...manual, ...repo].join(", ")}`);
    for (const w of e.graph?.warnings ?? []) out.push(`${pad}warning: ${w}`);
    broken ??= e.graph?.error;
  }
  if (broken) out.push(`modes: ${broken}; every flow on this repo is refused until it is fixed`);
  return out;
}

/** A file read as a workflow: the graph when it parses, else its error. */
export function checkLines(entry: WorkflowEntry): { ok: boolean; lines: string[] } {
  if (!entry.ok) return { ok: false, lines: [`${entry.file}: ${entry.error}`] };
  const n = entry.workflow.steps.length;
  return { ok: true, lines: [`${entry.workflow.file}: ok, ${n} ${n === 1 ? "step" : "steps"}`, ...showLines(entry.workflow).slice(1)] };
}

const isPath = (v: string): boolean => v === "." || v.startsWith("/") || v.startsWith("./") || v.startsWith("../") || v.startsWith("~");

const home = (v: string): string => v.replace(/^~(?=$|\/)/, process.env["HOME"] ?? "~");

export async function workflowCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  // the bare flag first, so `--repo --dot` leaves --repo with no repo
  const dot = has(args, "--dot");
  const repoFlag = args.includes("--repo");
  const repoArg = take(args, "--repo");
  if (repoFlag && (repoArg === undefined || repoArg.startsWith("-"))) return fail("--repo needs a repo id or a path");
  const base = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  const target: Target = { name: "home", urls: [base] };
  const failed = (err: unknown): never => fail(err instanceof Unreachable ? `home did not answer: ${err.message}` : errText(err));

  /** the repo's id: as given, or the one the backend scans at a path */
  const repoId = async (arg: string): Promise<string> => {
    if (!isPath(arg)) return arg;
    const path = await realpath(resolve(home(arg))).catch(() => fail(`no such folder: ${arg}`));
    const tree = await ask<ScanResult>(target, "GET", "/api/tree").catch(failed);
    return tree.repos.find((r) => r.path === path)?.id ?? fail(`home does not scan ${path}`);
  };
  /** the backend's list for --repo, else this machine's bundled and user workflows */
  const entries = async (): Promise<{ title: string; list: WorkflowEntry[] }> => {
    if (repoArg === undefined) {
      const list = (await loadWorkflows({ path: "", host: "none" })).filter((e) => !e.ok || e.workflow.listed !== false);
      return { title: "bundled and user workflows on this machine", list };
    }
    const id = await repoId(repoArg);
    const list = await ask<WorkflowEntry[]>(target, "GET", `/api/repos/workflows?id=${encodeURIComponent(id)}`).catch(failed);
    return { title: `workflows for ${id}`, list };
  };

  const sub = args.shift();
  if (sub === "show") {
    const name = args.shift();
    if (!name || args.length > 0) return fail(WORKFLOW_USAGE);
    const { title, list } = await entries();
    const entry = list.find((e) => entryName(e) === name);
    if (!entry) return fail(`no workflow called ${name} in the ${title}`);
    if (!entry.ok) return fail(`${name} does not parse: ${entry.error}`);
    console.log(dot ? dotText(entry.workflow, entry.graph) : showLines(entry.workflow, entry.graph).join("\n"));
    return;
  }
  if (sub === "check") {
    const file = args.shift();
    if (!file || args.length > 0 || dot || repoArg !== undefined) return fail(WORKFLOW_USAGE);
    const path = resolve(home(file));
    const text = await Bun.file(path).text().catch(() => fail(`no such file: ${file}`));
    const { ok, lines } = checkLines(parseWorkflow(text, { name: basename(path, ".md"), source: "user", file: path }));
    if (!ok) return fail(lines.join("\n"));
    console.log(lines.join("\n"));
    return;
  }
  if (sub === "list") {
    if (args.length > 0 || dot) return fail(WORKFLOW_USAGE);
    const { title, list } = await entries();
    console.log(listLines(title, list).join("\n"));
    return;
  }
  return fail(WORKFLOW_USAGE);
}
