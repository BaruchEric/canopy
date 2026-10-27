/** A workflow file: frontmatter for the identity, one `##` heading per step
 *  with a short key block under it and the prompt after. Browser-safe and
 *  pure; the loader in workflows.ts reads the files.
 *
 *  `agent: <profile>` names the agent profile a step's run starts with, in
 *  the step's key block, or in the frontmatter for every step that names
 *  none of its own. It beats the repo's routes the way a launch pick does;
 *  without one a step follows the repo's `flow` route. Steps can name earlier
 *  dependencies, conditions and a manual mode. */

import { TOOL_SETS } from "./actions";
import { isProfileName } from "./route";
import {
  GATE_KINDS,
  STEP_MODES,
  STEP_WHENS,
  WORKFLOW_WHENS,
  type FlowBudget,
  type GateKind,
  type StepMode,
  type StepWhen,
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

export function frontmatter(text: string): { keys: Map<string, string>; body: string } {
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

export const READ_ONLY_SETS = ["git-read", "read"] as const;

const READ_ONLY_RULES: ReadonlySet<string> = new Set(READ_ONLY_SETS.flatMap((name) => TOOL_SETS[name] ?? []));

/** Whether every expanded permission rule is in one of the read-only sets. */
export function readOnlyTools(rules: readonly string[]): boolean {
  return rules.every((rule) => READ_ONLY_RULES.has(rule));
}

/** Whether the step uses read-only tools and has no writing check. */
export function readOnlyStep(step: Pick<WorkflowStep, "tools" | "check">): boolean {
  return readOnlyTools(step.tools) && (step.check === null || step.check === "@gates");
}

/** A workflow record written before graph fields became required. */
export type RecordedWorkflow = Omit<Workflow, "steps"> & {
  steps: (Omit<WorkflowStep, "after" | "when" | "mode"> & Partial<Pick<WorkflowStep, "after" | "when" | "mode">>)[];
};

/** Fill graph defaults for workflow records written before those fields existed. */
export function chained(wf: RecordedWorkflow): Workflow {
  const steps: WorkflowStep[] = wf.steps.map((step, index): WorkflowStep => {
    const previous = wf.steps[index - 1];
    return {
      ...step,
      after: step.after ?? (previous ? [previous.name] : []),
      when: step.when ?? ["always"],
      mode: step.mode ?? "auto",
    };
  });
  return { ...wf, steps };
}

/** Why an unattended workflow asks for a person or a manual release. */
export function unattendedRefusal(wf: Workflow, where: string): string | null {
  for (const step of wf.steps) {
    if (step.gate === "ask") {
      return `${wf.name}'s ${step.name} step asks before the next one starts, and no one answers ${where}`;
    }
    if (step.mode === "manual") {
      const by = step.modeFrom === "repo" ? "the repo's .canopy/workflows.json" : "its workflow file";
      return `${wf.name}'s ${step.name} step waits for a go, made manual by ${by}, and no one gives one in ${where}`;
    }
  }
  return null;
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

interface ParsedStep {
  step: Omit<WorkflowStep, "after" | "when">;
  after: string | undefined;
  when: string | undefined;
}

function commaWords(value: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const part of value.split(",")) {
    const word = part.trim();
    if (word && !seen.has(word)) {
      seen.add(word);
      words.push(word);
    }
  }
  return words;
}

function step(name: string, lines: string[], agent: string | undefined): ParsedStep {
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
  const mode: StepMode = oneOf(keys.get("mode"), STEP_MODES, `step ${name}: mode`, "auto");
  return {
    step: {
      name,
      tools: tools(keys.get("tools")),
      turns,
      check,
      gate,
      body,
      retries: retriesKey(keys.get("retries"), name),
      back: keys.get("back") || name,
      evidence,
      mode,
      ...(profile ? { agent: profile } : {}),
    },
    after: keys.get("after"),
    when: keys.get("when"),
  };
}

function afterSteps(parsed: ParsedStep, index: number, steps: ParsedStep[], positions: ReadonlyMap<string, number>): string[] {
  const raw = parsed.after;
  const names = raw === undefined || raw.trim() === "" ? [] : commaWords(raw);
  if (names.length === 0) {
    const previous = steps[index - 1];
    return previous ? [previous.step.name] : [];
  }
  for (const name of names) {
    const position = positions.get(name);
    if (position === undefined) throw new Bad(`step ${parsed.step.name}: after names no step called ${name}`);
    if (position === index) throw new Bad(`step ${parsed.step.name}: after names itself`);
    if (position > index) throw new Bad(`step ${parsed.step.name}: after names a later step, ${name}`);
  }
  return names;
}

function hasPrerequisite(
  after: string[],
  steps: ParsedStep[],
  positions: ReadonlyMap<string, number>,
  matches: (step: ParsedStep["step"]) => boolean,
): boolean {
  return after.some((name) => {
    const position = positions.get(name);
    const predecessor = position === undefined ? undefined : steps[position];
    return predecessor !== undefined && matches(predecessor.step);
  });
}

function whenSteps(parsed: ParsedStep, after: string[], steps: ParsedStep[], positions: ReadonlyMap<string, number>): StepWhen[] {
  const words = parsed.when === undefined ? [] : commaWords(parsed.when);
  const explicit = words.length > 0;
  const conditions = explicit ? words : ["always"];
  const when: StepWhen[] = [];
  for (const word of conditions) {
    const condition = STEP_WHENS.find((candidate) => candidate === word);
    if (!condition) throw new Bad(`step ${parsed.step.name}: when must be one of ${STEP_WHENS.join(", ")}, not ${word}`);
    when.push(condition);
  }
  if (explicit && after.length === 0) {
    throw new Bad(`step ${parsed.step.name}: when needs a step before it to wait on`);
  }
  for (const condition of when) {
    if (condition.startsWith("verdict ") && !hasPrerequisite(after, steps, positions, (step) => step.gate === "verdict")) {
      throw new Bad(`step ${parsed.step.name}: when ${condition} needs a step before it with gate: verdict`);
    }
    if (condition.startsWith("judge ") && !hasPrerequisite(after, steps, positions, (step) => step.gate === "judge")) {
      throw new Bad(`step ${parsed.step.name}: when ${condition} needs a step before it with gate: judge`);
    }
    if (condition.startsWith("check ") && !hasPrerequisite(after, steps, positions, (step) => step.check !== null)) {
      throw new Bad(`step ${parsed.step.name}: when ${condition} needs a step before it with a check`);
    }
  }
  return when;
}

function steps(body: string, agent: string | undefined): WorkflowStep[] {
  const lines = body.split("\n");
  const out: ParsedStep[] = [];
  let name: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (name === null) return;
    if (out.some((s) => s.step.name === name)) throw new Bad(`step ${name} appears twice`);
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
  const positions = new Map<string, number>();
  out.forEach((s, i) => positions.set(s.step.name, i));
  out.forEach((s, i) => {
    const to = positions.get(s.step.back);
    if (to === undefined) throw new Bad(`step ${s.step.name}: back names no step called ${s.step.back}`);
    if (to > i) throw new Bad(`step ${s.step.name}: back must name this step or an earlier one, not ${s.step.back}`);
    if (!s.step.body && s.step.retries > 0 && to === i) {
      throw new Bad(`step ${s.step.name}: a check-only step's retries need back: an earlier step`);
    }
  });

  return out.map((parsed, i) => {
    const after = afterSteps(parsed, i, out, positions);
    const when = whenSteps(parsed, after, out, positions);
    return { ...parsed.step, after, when };
  });
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
    const listedRaw = keys.get("listed");
    const listed = listedRaw === undefined || listedRaw === "" ? true : bool(listedRaw, "listed");
    const workflow: Workflow = {
      name,
      label,
      verb,
      blurb,
      when,
      expectsChange: bool(keys.get("expects-change"), "expects-change"),
      notePlaceholder: keys.get("note") || "anything the agent should know (optional)",
      noteRequired: bool(keys.get("note-required"), "note-required"),
      ...(listed ? {} : { listed: false as const }),
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
