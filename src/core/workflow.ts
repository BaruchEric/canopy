/** A workflow file: frontmatter for the identity, one `##` heading per step
 *  with a short key block under it and the prompt after. Browser-safe and
 *  pure; the loader in workflows.ts reads the files.
 *
 *  `agent: <profile>` names the agent profile a step's run starts with, in
 *  the step's key block, or in the frontmatter for every step that names
 *  none of its own. It beats the repo's routes the way a launch pick does;
 *  without one a step follows the repo's `flow` route. */

import { TOOL_SETS } from "./actions";
import { isProfileName } from "./route";
import {
  GATE_KINDS,
  WORKFLOW_WHENS,
  type FlowBudget,
  type GateKind,
  type Workflow,
  type WorkflowEntry,
  type WorkflowSource,
  type WorkflowStep,
  type WorkflowWhen,
} from "./types";

const DEFAULT_TURNS = 30;
const NAME = /^[a-z0-9-]+$/;
const KEY_LINE = /^([a-z][a-z-]*):[ \t]*(.*)$/;

class Bad extends Error {}

/** `key: value` lines into a map; a line that is not one ends the block. */
function keyBlock(lines: string[]): { keys: Map<string, string>; rest: string[] } {
  const keys = new Map<string, string>();
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") break;
    const m = KEY_LINE.exec(line);
    if (!m) break;
    keys.set(m[1] ?? "", (m[2] ?? "").trim());
  }
  return { keys, rest: lines.slice(i) };
}

function frontmatter(text: string): { keys: Map<string, string>; body: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Bad("no frontmatter: the file must start with a --- block");
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) throw new Bad("frontmatter never closes: no second --- line");
  const { keys, rest } = keyBlock(lines.slice(1, end));
  const stray = rest.find((l) => l.trim() !== "");
  if (stray !== undefined) throw new Bad(`frontmatter line is not key: value: ${stray}`);
  return { keys, body: lines.slice(end + 1).join("\n") };
}

function oneOf<T extends string>(v: string | undefined, allowed: readonly T[], what: string, fallback: T): T {
  if (v === undefined || v === "") return fallback;
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new Bad(`${what} must be one of ${allowed.join(", ")}, not ${v}`);
}

function bool(v: string | undefined, what: string): boolean {
  if (v === undefined || v === "" || v === "false") return false;
  if (v === "true") return true;
  throw new Bad(`${what} must be true or false, not ${v}`);
}

function tools(v: string | undefined): string[] {
  const words = (v || "git-read").split(",").map((w) => w.trim()).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    const set = TOOL_SETS[w];
    if (set) out.push(...set);
    else out.push(w);
  }
  return [...new Set(out)];
}

/** An `agent:` line's profile name, or undefined when there is none. */
function agentKey(v: string | undefined, what: string): string | undefined {
  if (v === undefined || v === "") return undefined;
  if (!isProfileName(v)) throw new Bad(`${what} must name a profile (lowercase letters, digits, - and _), not ${v}`);
  return v;
}

const MAX_RETRIES = 10;
const BUDGET = /^(\d+)\s+runs?\s*,\s*(\d+(?:\.\d+)?)\s*h$/;

function retriesKey(v: string | undefined, name: string): number {
  if (v === undefined || v === "") return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_RETRIES) {
    throw new Bad(`step ${name}: retries must be a whole number from 0 to ${MAX_RETRIES}, not ${v}`);
  }
  return n;
}

function evidenceKey(v: string | undefined, name: string): string[] {
  if (v === undefined || v === "") return [];
  const paths = v.split(/\s+/).filter(Boolean);
  for (const p of paths) {
    if (p.startsWith("/") || p.split("/").includes("..")) {
      throw new Bad(`step ${name}: evidence must be paths inside the repo, not ${p}`);
    }
  }
  return paths;
}

function budgetKey(v: string | undefined): FlowBudget | null {
  if (v === undefined || v === "") return null;
  const m = BUDGET.exec(v);
  const runs = Number(m?.[1]);
  const hours = Number(m?.[2]);
  if (!m || !(runs > 0) || !(hours > 0)) throw new Bad(`budget must read like "30 runs, 6h", not ${v}`);
  return { runs, hours };
}

function step(name: string, lines: string[], agent: string | undefined): WorkflowStep {
  const { keys, rest } = keyBlock(lines);
  const turnsRaw = keys.get("turns");
  const turns = turnsRaw === undefined || turnsRaw === "" ? DEFAULT_TURNS : Number(turnsRaw);
  if (!Number.isInteger(turns) || turns <= 0) throw new Bad(`step ${name}: turns must be a positive whole number, not ${turnsRaw}`);
  const gate: GateKind = oneOf(keys.get("gate"), GATE_KINDS, `step ${name}: gate`, "continue");
  const check = keys.get("check") || null;
  const body = rest.join("\n").trim();
  if (!body && !check) throw new Bad(`step ${name} has neither a prompt nor a check`);
  const profile = agentKey(keys.get("agent"), `step ${name}: agent`) ?? agent;
  const evidence = evidenceKey(keys.get("evidence"), name);
  if (evidence.length > 0 && gate !== "judge") throw new Bad(`step ${name}: evidence is only read by gate: judge`);
  return {
    name,
    tools: tools(keys.get("tools")),
    turns,
    check,
    gate,
    body,
    retries: retriesKey(keys.get("retries"), name),
    back: keys.get("back") || name,
    evidence,
    ...(profile ? { agent: profile } : {}),
  };
}

function steps(body: string, agent: string | undefined): WorkflowStep[] {
  const lines = body.split("\n");
  const out: WorkflowStep[] = [];
  let name: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (name === null) return;
    if (out.some((s) => s.name === name)) throw new Bad(`step ${name} appears twice`);
    out.push(step(name, buf, agent));
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      name = m[1] ?? "";
      buf = [];
    } else if (name !== null) {
      buf.push(line);
    }
  }
  flush();
  if (out.length === 0) throw new Bad("no steps: a workflow needs at least one ## heading");
  out.forEach((s, i) => {
    const to = out.findIndex((t) => t.name === s.back);
    if (to === -1) throw new Bad(`step ${s.name}: back names no step called ${s.back}`);
    if (to > i) throw new Bad(`step ${s.name}: back must name this step or an earlier one, not ${s.back}`);
    if (!s.body && s.retries > 0 && to === i) {
      throw new Bad(`step ${s.name}: a check-only step's retries need back: an earlier step`);
    }
  });
  return out;
}

export function parseWorkflow(
  text: string,
  meta: { name: string; source: WorkflowSource; file: string },
): WorkflowEntry {
  try {
    const { keys, body } = frontmatter(text);
    const name = keys.get("name") || meta.name;
    if (!NAME.test(name)) throw new Bad(`name must match [a-z0-9-]+, not ${name}`);
    const blurb = keys.get("blurb");
    if (!blurb) throw new Bad("blurb is required: one paragraph for the pre-flight");
    const label = keys.get("label") || name;
    const verb = keys.get("verb") || label;
    const when: WorkflowWhen = oneOf(keys.get("when"), WORKFLOW_WHENS, "when", "any");
    const workflow: Workflow = {
      name,
      label,
      verb,
      blurb,
      when,
      expectsChange: bool(keys.get("expects-change"), "expects-change"),
      notePlaceholder: keys.get("note") || "anything the agent should know (optional)",
      noteRequired: bool(keys.get("note-required"), "note-required"),
      steps: steps(body, agentKey(keys.get("agent"), "agent")),
      budget: budgetKey(keys.get("budget")),
      source: meta.source,
      file: meta.file,
    };
    return { ok: true, workflow };
  } catch (err) {
    const error = err instanceof Bad ? err.message : String(err instanceof Error ? err.message : err);
    return { ok: false, name: meta.name, source: meta.source, file: meta.file, error };
  }
}
