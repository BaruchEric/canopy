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
 *  escalation (`Permissions`) and a question are never remembered. */

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { autoAnswer, within, type ApprovalFacts } from "./codexrun";
import { promptFacts } from "./driver";
import { parseRule, rememberable } from "./shellwords";
import { configDir } from "./store";
import type { FlowStepName, PermissionAsk, RememberedRule, RememberScope } from "./types";

/** the tools whose rule is about files, covered inside the project only */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

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
  const r = parseRule(rule);
  if (!r) return false;
  if (r.kind === "bash") return p.tool === "Bash" && autoAnswer([rule], facts, cwd);
  if (!rememberable(r.name)) return false;
  if (r.kind === "tool" && r.name === "Bash") {
    return p.tool === "Bash" && facts.kind === "command" && (facts.cwd === null || within(facts.cwd, cwd));
  }
  if (p.tool !== r.name) return false;
  if (EDIT_TOOLS.has(r.name)) return facts.kind === "fileChange" && autoAnswer([rule], facts, cwd);
  if (facts.kind !== "other") return false;
  return (p.paths ?? []).every((x) => within(x, cwd));
}

export function scopeHolds(s: RememberScope, run: RunScope): boolean {
  if (s.kind === "repo") return s.path === run.path;
  if (!run.flowStep || run.flowStep.workflow !== s.workflow) return false;
  return s.kind === "workflow" || run.flowStep.step === s.step;
}

/** The scope of this run a remember asks for, or null when the run has no
 *  such scope (a step's or a workflow's outside a flow). */
export function scopeOf(kind: RememberScope["kind"], run: RunScope): RememberScope | null {
  if (kind === "repo") return { kind: "repo", path: run.path };
  if (!run.flowStep) return null;
  return kind === "workflow" ? { kind: "workflow", workflow: run.flowStep.workflow } : { kind: "step", ...run.flowStep };
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
  if (v["kind"] === "workflow" && text(v["workflow"])) return { kind: "workflow", workflow: v["workflow"] };
  if (v["kind"] === "step" && text(v["workflow"]) && text(v["step"])) return { kind: "step", workflow: v["workflow"], step: v["step"] };
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

  private write(next: RememberedRule[]): Promise<void> {
    const run = this.chain
      .catch(() => {})
      .then(async () => {
        const dir = dirname(this.file);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const tmp = join(dir, `.${basename(this.file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
        await writeFile(tmp, `${JSON.stringify({ rules: next }, null, 2)}\n`, { mode: 0o600 });
        await rename(tmp, this.file);
      });
    this.chain = run;
    return run;
  }

  /** Keeps a rule for a scope; the same rule for the same scope is kept once. */
  async add(rule: string, scope: RememberScope, extra: { by?: string; from?: string } = {}): Promise<RememberedRule> {
    if (!applicable(rule)) throw new Error(`${rule} is not a rule canopy can remember`);
    const held = this.rules.find((r) => r.rule === rule && sameScope(r.scope, scope));
    if (held) return held;
    const entry: RememberedRule = {
      id: crypto.randomUUID().slice(0, 8),
      rule,
      scope,
      at: Date.now(),
      ...(extra.by ? { by: extra.by } : {}),
      ...(extra.from ? { from: extra.from.slice(0, 200) } : {}),
    };
    this.rules = [...this.rules, entry];
    await this.write(this.rules);
    return entry;
  }

  /** Drops a rule by id; false when there is none. */
  async forget(id: string): Promise<boolean> {
    if (!this.rules.some((r) => r.id === id)) return false;
    this.rules = this.rules.filter((r) => r.id !== id);
    await this.write(this.rules);
    return true;
  }
}
