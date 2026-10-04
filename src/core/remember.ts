/** Remembered rules: an allow on a run's permission that also says "from
 *  now on", kept canopy-side in the config dir (`remembered.json`) and
 *  answered by `RunCtx.ask` the way a run's own allowlist would be, so the
 *  same kind of request stops asking.
 *
 *  Matching is codexrun's: `parseRule` reads the rule, `autoAnswer` decides
 *  a shell command (one simple command whose words start with a prefix
 *  rule's, or equal an exact one's, run inside the project) and an edit
 *  (every path inside the project, no wider grant). On top of it, a bare
 *  `Bash` covers any shell command run inside the project, chains included,
 *  and is the only rule that ever covers a chain; any other bare tool name
 *  covers that tool, inside the project when it names files. A sandbox
 *  escalation (`Permissions`) and a question are never remembered.
 *
 *  Fail closed: no rule covers a command that reaches outside the project
 *  by any word, or that names a place code runs from (`.git`, an agent's
 *  settings, package scripts: `guardedPath`) in a step that is not a known
 *  reader, nor an edit there; a prefix rule
 *  never covers a command whose words run another program (`runsOther`),
 *  and a bare `Bash` never covers code canopy cannot read (`opaque`). */

import { readFileSync } from "node:fs";
import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { autoAnswer, within, type ApprovalFacts } from "./codexrun";
import { promptFacts } from "./driver";
import { explainCommand, guardedPath } from "./explain";
import { commandWords, EDIT_TOOLS, parseRule, rememberable, runsOther, unwrapShell } from "./shellwords";
import { configDir } from "./store";
import type { FlowStepName, PermissionAsk, RememberedRule, RememberScope, SharedWorkflowSource } from "./types";


/** What a run is, for a scope: its repo's absolute path and, for a flow's
 *  step, which workflow and step. */
export interface RunScope {
  path: string;
  flowStep?: FlowStepName;
}

/** The facts a Claude prompt gives, read off its fields: a shell command,
 *  a file tool's paths, or anything else. Codex hands its own. */
export const factsOf = (p: PermissionAsk): ApprovalFacts => promptFacts(p);

/** Whether one rule covers a permission run in `cwd` (the repo's folder). */
export function ruleCovers(rule: string, p: PermissionAsk, facts: ApprovalFacts, cwd: string): boolean {
  if (p.noRule) return false;
  const r = parseRule(rule);
  if (!r) return false;
  if (r.kind === "bash" || r.name === "Bash") {
    if (p.tool !== "Bash" || facts.kind !== "command" || facts.command === null) return false;
    // read by the prompt's own words (codex's `sh -lc` wrapper already taken
    // off; a Claude `sh -c` kept, which is opaque): Claude's prompts carry no
    // folder, so the words are all there is to go on
    const read = explainCommand(p.command ?? unwrapShell(facts.command), cwd, facts.cwd ?? undefined);
    if (read.flags.includes("outside") || read.guarded) return false;
    if (r.kind === "bash") {
      if (!r.prefix) return autoAnswer([rule], facts, cwd);
      const words = commandWords(facts.command);
      return words !== null && !read.opaque && !runsOther(words) && autoAnswer([rule], facts, cwd);
    }
    if (read.opaque) return false;
    return facts.cwd === null || within(facts.cwd, cwd);
  }
  if (!rememberable(r.name) || p.tool !== r.name) return false;
  if (EDIT_TOOLS.has(r.name)) {
    const changed = [...(p.paths ?? []), ...(facts.kind === "fileChange" ? (facts.paths ?? []) : [])];
    if (changed.some((x) => guardedPath(x, cwd))) return false;
    return facts.kind === "fileChange" && autoAnswer([rule], facts, cwd);
  }
  if (facts.kind !== "other") return false;
  // at least one file, all inside: a Glob with no folder goes where its pattern says
  const paths = p.paths ?? [];
  return paths.length > 0 && paths.every((x) => within(x, cwd));
}

/** Whether every path is inside `root` on disk, not only by its words: a
 *  link in the project can lead out of it. A path that does not exist yet
 *  is judged by its nearest folder that does. With `guard` (an edit), a
 *  path whose real place is where code runs from (`guardedPath`) fails too:
 *  `tools -> .git/hooks` makes `tools/pre-commit` a hook. */
export async function pathsInside(paths: readonly string[], root: string, opts: { guard?: boolean } = {}): Promise<boolean> {
  const realRoot = await realpath(root).catch(() => resolve(root));
  const real = async (p: string): Promise<string> => {
    const abs = resolve(root, p);
    let dir = abs;
    let rest = "";
    for (;;) {
      const got = await realpath(dir).catch(() => null);
      if (got !== null) return rest ? join(got, rest) : got;
      const up = dirname(dir);
      if (up === dir) return abs;
      rest = rest ? join(basename(dir), rest) : basename(dir);
      dir = up;
    }
  };
  for (const p of paths) {
    const at = await real(p);
    if (!within(at, realRoot)) return false;
    if (opts.guard && guardedPath(at, realRoot)) return false;
  }
  return true;
}

/** A step or workflow scope holds only for that workflow's own file, by
 *  where it came from; a repo scope for every run in that folder.
 *  A repo scope is keyed by path, so an incubator seed whose slug is reused
 *  would inherit an old seed's rules: no stage run consults or offers a
 *  remembered rule at all (`Runner.start`, `RunCtx`), which closes that. */
export function scopeHolds(s: RememberScope, run: RunScope): boolean {
  if (s.kind === "repo") return s.path === run.path;
  const f = run.flowStep;
  if (!f || f.source === "repo" || f.workflow !== s.workflow || f.source !== s.source) return false;
  return s.kind === "workflow" || f.step === s.step;
}

/** The scope of this run a remember asks for, or null when the run has no
 *  such scope: a step's or a workflow's outside a flow, or for a workflow
 *  the repo itself ships (a clone could name its own file `scout`). */
export function scopeOf(kind: RememberScope["kind"], run: RunScope): RememberScope | null {
  if (kind === "repo") return { kind: "repo", path: run.path };
  const f = run.flowStep;
  if (!f || f.source === "repo") return null;
  const source: SharedWorkflowSource = f.source;
  return kind === "workflow" ? { kind: "workflow", workflow: f.workflow, source } : { kind: "step", workflow: f.workflow, step: f.step, source };
}

export { scopeWords } from "./shellwords";

/** The remembered rule that answers this permission, or null. */
export function rememberedFor(
  rules: readonly RememberedRule[],
  run: RunScope,
  p: PermissionAsk,
  facts: ApprovalFacts,
  cwd: string,
): RememberedRule | null {
  return rules.find((r) => scopeHolds(r.scope, run) && ruleCovers(r.rule, p, facts, cwd)) ?? null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function scopeFrom(v: unknown): RememberScope | null {
  if (!isRecord(v)) return null;
  if (v["kind"] === "repo" && text(v["path"])) return { kind: "repo", path: v["path"] };
  const source = v["source"];
  if (source !== "bundled" && source !== "user") return null;
  if (v["kind"] === "workflow" && text(v["workflow"])) return { kind: "workflow", workflow: v["workflow"], source };
  if (v["kind"] === "step" && text(v["workflow"]) && text(v["step"])) return { kind: "step", workflow: v["workflow"], step: v["step"], source };
  return null;
}

/** A rule canopy can apply: one `parseRule` reads, not a tool never remembered. */
export const applicable = (rule: string): boolean => {
  const r = parseRule(rule);
  return r !== null && (r.kind === "bash" || rememberable(r.name));
};

/** The file's rules, each checked; anything else is dropped. */
export function parseRemembered(raw: string): RememberedRule[] {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = isRecord(v) && Array.isArray(v["rules"]) ? v["rules"] : [];
  return list.flatMap((r: unknown): RememberedRule[] => {
    if (!isRecord(r) || !text(r["id"]) || !text(r["rule"]) || !applicable(r["rule"])) return [];
    const scope = scopeFrom(r["scope"]);
    if (!scope) return [];
    return [
      {
        id: r["id"],
        rule: r["rule"],
        scope,
        at: typeof r["at"] === "number" ? r["at"] : 0,
        ...(text(r["by"]) ? { by: r["by"] } : {}),
        ...(text(r["from"]) ? { from: r["from"].slice(0, 200) } : {}),
      },
    ];
  });
}

const sameScope = (a: RememberScope, b: RememberScope): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The remembered rules, held in memory for every prompt and written whole
 *  through a rename at 0600, one write after another. */
export class RememberedRules {
  private rules: RememberedRule[];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string = join(configDir(), "remembered.json"),
    log: (line: string) => void = (line) => console.error(`remembered: ${line}`),
  ) {
    let raw: string | null = null;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      raw = null;
    }
    this.rules = raw === null ? [] : parseRemembered(raw);
    if (raw !== null && this.rules.length === 0 && raw.trim() && !/"rules"\s*:\s*\[\s*\]/.test(raw)) {
      log(`${file} holds no rule canopy can read; it is read as empty and written over at the next change`);
    }
  }

  list(): RememberedRule[] {
    return this.rules;
  }

  /** One change after another: `change` reads the rules as the last write
   *  left them, the file is written, and only then does the change count in
   *  memory, so a rule that never reached the disk never answers a prompt. */
  private update<T>(change: (rules: readonly RememberedRule[]) => { next: RememberedRule[] | null; out: T }): Promise<T> {
    const run = this.chain
      .catch(() => {})
      .then(async () => {
        const { next, out } = change(this.rules);
        if (next === null) return out;
        const dir = dirname(this.file);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const tmp = join(dir, `.${basename(this.file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
        await writeFile(tmp, `${JSON.stringify({ rules: next }, null, 2)}\n`, { mode: 0o600 });
        await rename(tmp, this.file);
        this.rules = next;
        return out;
      });
    this.chain = run;
    return run;
  }

  /** Keeps a rule for a scope; the same rule for the same scope is kept once. */
  async add(rule: string, scope: RememberScope, extra: { by?: string; from?: string } = {}): Promise<RememberedRule> {
    if (!applicable(rule)) throw new Error(`${rule} is not a rule canopy can remember`);
    return this.update((rules) => {
      const held = rules.find((r) => r.rule === rule && sameScope(r.scope, scope));
      if (held) return { next: null, out: held };
      const entry: RememberedRule = {
        id: crypto.randomUUID().slice(0, 8),
        rule,
        scope,
        at: Date.now(),
        ...(extra.by ? { by: extra.by } : {}),
        ...(extra.from ? { from: extra.from.slice(0, 200) } : {}),
      };
      return { next: [...rules, entry], out: entry };
    });
  }

  /** Drops a rule by id; false when there is none. */
  forget(id: string): Promise<boolean> {
    return this.update((rules) =>
      rules.some((r) => r.id === id) ? { next: rules.filter((r) => r.id !== id), out: true } : { next: null, out: false },
    );
  }
}
