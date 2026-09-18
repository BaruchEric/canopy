# Agent workflows implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Markdown-defined, multi-step Claude workflows on one repo with gates between steps, runnable across many repos at once, replacing the hard-coded commit, push and deploy actions.

**Architecture:** A pure parser turns a markdown file into a `Workflow`. A Bun-only `Flows` orchestrator sequences a workflow's steps, each step a normal `Run` through the existing `Runner` (which now takes a spec instead of an action name), runs the step's shell check, and applies its gate (continue, ask, or a Jev verdict). A fleet is N flows with a shared id and a cap of three. The UI adds a flow sheet, a fleet sheet, and a select mode on the board.

**Tech Stack:** Bun, TypeScript strict, React 19, Zustand, `ai` + `@ai-sdk/gateway` for the Jev evaluator, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-17-agent-workflows-design.md`

## Global constraints

- Gates before any task is called done: `bun run typecheck && bun run lint && bun test && bun run build`. Build is required: the server serves `dist/web`.
- `src/core/types.ts`, `src/core/actions.ts`, `src/core/workflow.ts`, `src/core/verdict.ts` and everything under `ui/src` must stay browser-safe: no Bun or node imports.
- Tests rely on `$CANOPY_CONFIG_DIR`; any test touching the config dir sets it to a temp folder.
- No CSS framework. New styles go in `ui/src/styles.css` using the existing tokens.
- No em dashes, no backticks in commit messages, no Claude attribution beyond the session trailer.
- Commits: Eric's standing rule is no commits unless asked. Before executing, confirm once whether tasks may commit as they land. If not, skip every commit step and report the list of ready commits at the end. The working tree already holds uncommitted search work; that must be committed or stashed before task 1 so each task's diff is its own.
- Every commit message ends with the session trailer line: `Claude-Session: https://claude.ai/code/session_01ATKaeCck4C4DhgUzeey9Zw`

## File structure

Created:

- `src/core/workflow.ts` + `workflow.test.ts`: pure parser, `parseWorkflow`.
- `src/core/workflows.ts` + `workflows.test.ts`: Bun loader over the three sources, `loadWorkflows`, `findWorkflow`.
- `lib/workflows/commit.md`, `push.md`, `ship.md`, `deploy.md`, `review.md`: bundled workflows.
- `docs/workflows/example-update-deps.md`: a user workflow example.
- `src/core/verdict.ts` + `verdict.test.ts`: the questions, `decide`, `verdictState`.
- `src/core/jev.ts` + `jev.test.ts`: the evaluator over the gateway, `hasGatewayKey`.
- `src/core/flow.ts` + `flow.test.ts`: `Flows` (flows and fleets), `stepSpec`, `FLEET_CONCURRENCY`.
- `ui/src/flows.ts` + `flows.test.ts`: pure words and arithmetic for chips, strips, selection.
- `ui/src/components/FlowSheet.tsx`: the flow plan, the flow console, the fleet plan, the fleet sheet.
- `ui/src/components/SelectBar.tsx`: the bar along the bottom in select mode.

Modified:

- `src/core/types.ts`: `Run` carries its words; `Workflow*`, `Flow*`, `Fleet`, `Verdict*` types; four new `ServerEvent`s.
- `src/core/actions.ts`: `ActionSpec` gains `task`, `mode`, `progress`, `expectsChange`; `TOOL_SETS`, `checkWhen`; `buildPrompt(repo, spec, note)`; at the end only `ask` and `chat` remain.
- `src/core/runner.ts`: `start(repo, action, spec, note, agent)`; reads `spec.mode` and `run.chat`.
- `src/server/index.ts`: `state.flows`, routes, events, the check runner.
- `ui/src/api.ts`, `ui/src/store.ts`: flows, fleets, workflows, selection, sheet kinds.
- `ui/src/components/RunSheet.tsx`: `Timeline` extracted from `Console`; the new sheet kinds dispatched to `FlowSheet`.
- `ui/src/components/RepoMenu.tsx`: workflows under "with claude".
- `ui/src/components/RunChip.tsx`: `FlowChip`.
- `ui/src/components/RepoGrid.tsx`: tick in select mode, flow chip.
- `ui/src/components/TopBar.tsx`: the select mode toggle.
- `ui/src/App.tsx`: `SelectBar`.
- `ui/src/styles.css`: strip, gate box, verdict bars, ticks, select bar.
- `README.md`, `CLAUDE.md`: the format and the sources.

---

### Task 1: a Run carries its own words, and the Runner takes a spec

**Files:**
- Modify: `src/core/types.ts:255-360` (`Run`)
- Modify: `src/core/actions.ts` (`ActionSpec`, `ACTIONS`, `buildPrompt`; delete `EXPECTS_CHANGE`, `PROGRESS`, `TASKS`)
- Modify: `src/core/runner.ts:196-270, 272-295, 615-640`
- Modify: `src/server/index.ts:866-875`
- Test: `src/core/actions.test.ts`, `src/core/runner.test.ts`

**Interfaces:**
- Produces: `ActionSpec` with `task: string`, `mode: "job" | "ask" | "chat"`, `progress: string`, `expectsChange: boolean`. `buildPrompt(repo: Repo, spec: ActionSpec, note: string): string`. `Runner.start(repo: Repo, action: string, spec: ActionSpec, note: string, agent?: AgentSettings): Run`. `Run` gains `verb`, `progress`, `expectsChange`, `chat`; `Run.action` is `string`.

- [ ] **Step 1: Write the failing tests**

In `src/core/actions.test.ts`, change every `buildPrompt(repo, "commit", ...)` style call to `buildPrompt(repo, ACTIONS.commit, ...)` and add:

```ts
describe("the spec carries the run's words", () => {
  test("every action says what it does and how it ends", () => {
    for (const a of RUN_ACTIONS) {
      const spec = ACTIONS[a];
      expect(spec.task.length).toBeGreaterThan(0);
      expect(spec.progress.length).toBeGreaterThan(0);
    }
    expect(ACTIONS.commit.expectsChange).toBe(true);
    expect(ACTIONS.deploy.expectsChange).toBe(false);
    expect(ACTIONS.chat.mode).toBe("chat");
    expect(ACTIONS.ask.mode).toBe("ask");
    expect(ACTIONS.commit.mode).toBe("job");
  });

  test("a job prompt ends with the ground rules; a chat prompt ends with the message", () => {
    const r = repo();
    const job = buildPrompt(r, ACTIONS.commit, "be brief");
    expect(job).toContain("Note from the user (follow it where it applies):\nbe brief");
    expect(job.trim().endsWith("No headings, no bullet lists.")).toBe(true);
    const chat = buildPrompt(r, ACTIONS.chat, "hello");
    expect(chat.trim().endsWith("First message from the user:\nhello")).toBe(true);
    const ask = buildPrompt(r, ACTIONS.ask, "do x");
    expect(ask).toContain("Note from the user:\ndo x");
  });
});
```

`repo()` is the helper already in that file. Import `RUN_ACTIONS` from `./types` if it is not imported already.

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test src/core/actions.test.ts`
Expected: FAIL, `spec.task` undefined and `buildPrompt` called with a spec where it expects an action name.

- [ ] **Step 3: Reshape `ActionSpec` and `ACTIONS`**

In `src/core/actions.ts` replace the interface:

```ts
export interface ActionSpec {
  /** menu label */
  label: string;
  /** confirm-button verb, also the run's title */
  verb: string;
  /** one short paragraph for the pre-flight dialog: what Claude will do */
  blurb: string;
  /** placeholder for the note box */
  notePlaceholder: string;
  /** the note is the whole prompt, so it cannot be empty */
  noteRequired: boolean;
  /** permission rules added for the session; anything else asks first */
  allowedTools: string[];
  maxTurns: number;
  /** the card chip's word while the run is going */
  progress: string;
  /** a run that leaves git status untouched is reported as "no change" */
  expectsChange: boolean;
  /** the task paragraph of the prompt */
  task: string;
  /** how the note is framed and how the prompt closes: a job ends with the
   *  ground rules, an ask frames the note as the task, a chat puts the
   *  first message last */
  mode: "job" | "ask" | "chat";
}
```

Move each entry of `TASKS` into its spec as `task`, each entry of `PROGRESS` as `progress`, each of `EXPECTS_CHANGE` as `expectsChange`, and set `mode` (`job` for commit, push, commit-push, deploy; `ask`; `chat`). Delete the `TASKS`, `PROGRESS` and `EXPECTS_CHANGE` constants. `RULES`, `SUBMODULE_STEP`, `STRAY_STEP` and `CHAT_RULES` must be declared above `ACTIONS` now, since the template strings read them at module load.

Replace `buildPrompt`:

```ts
/** The full prompt for a run. The repo facts come from canopy's own status
 *  read, so Claude starts with the same picture the card shows. */
export function buildPrompt(repo: Repo, spec: ActionSpec, note: string): string {
  const facts = repoFacts(repo);
  const head = [
    `You are in the git repository ${repo.name} at ${repo.path}, launched from canopy (a multi-repo git dashboard).`,
    facts.length ? `Current state: ${facts.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const trimmed = note.trim();
  const noteBlock = trimmed
    ? spec.mode === "ask"
      ? `Note from the user:\n${trimmed}`
      : spec.mode === "chat"
        ? `First message from the user:\n${trimmed}`
        : `Note from the user (follow it where it applies):\n${trimmed}`
    : "";
  // A chat's first message comes last, where a reply naturally follows it.
  const parts =
    spec.mode === "chat"
      ? [head, spec.task, CHAT_RULES, noteBlock]
      : [head, spec.task, noteBlock, RULES];
  return parts.filter(Boolean).join("\n\n");
}
```

- [ ] **Step 4: `Run` carries its words**

In `src/core/types.ts` change `Run`:

```ts
export interface Run {
  id: string;
  repoId: string;
  /** a built-in action's name, or the workflow's name for a flow's step */
  action: string;
  /** the words the chip and the sheet use, copied from the spec at start */
  verb: string;
  progress: string;
  expectsChange: boolean;
  /** a chat keeps its process between turns and takes messages */
  chat: boolean;
  /** what the user typed into the note box, if anything */
  note: string;
  status: RunStatus;
  /** unix ms */
  startedAt: number;
  endedAt?: number;
  steps: RunStep[];
  /** the prompt the run is blocked on, when status is "waiting" */
  prompt: RunPrompt | null;
  result?: RunResult;
  /** why a failed run failed */
  error?: string;
  /** whether git status differed after the run from before it; set when
   *  the run ends, for actions that are supposed to change something */
  outcome?: "changed" | "unchanged";
}
```

Leave `RUN_ACTIONS` and `RunAction` in place for now; task 13 shrinks them.

- [ ] **Step 5: The Runner takes a spec**

In `src/core/runner.ts`:

- Change the signature to `start(repo: Repo, action: string, spec: ActionSpec, note: string, agent: AgentSettings = DEFAULT_AGENT): Run`. Delete `const spec = ACTIONS[action];`. The busy message becomes `` `${repo.name} already has a ${busy.verb} run going` ``. `const chat = spec.mode === "chat";`. The run literal gains `verb: spec.verb, progress: spec.progress, expectsChange: spec.expectsChange, chat`.
- The three `buildPrompt(...)` calls become `buildPrompt(repo, spec, note)` in `start` (both), and `buildPrompt(live.repo, live.spec, message)` in `say`.
- In `say`: `if (!live.run.chat) throw new Error("only a chat takes messages");`.
- In `drive` and in the `result` handling near line 627: every `live.run.action === "chat"` becomes `live.run.chat`.
- Remove the now-unused `ACTIONS` and `RunAction` imports.

In `src/server/index.ts` line 874: `return json(state.runner.start(repo, b.action, ACTIONS[b.action], note, agent), 201);` and import `ACTIONS` from `../core/actions` if it is not imported.

- [ ] **Step 6: Run the tests**

Run: `bun test src/core/actions.test.ts src/core/runner.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and fix the UI references**

Run: `bun run typecheck`
Expected: errors in `ui/src/components/RunChip.tsx`, `RunSheet.tsx`, `RepoMenu.tsx` about `EXPECTS_CHANGE`, `PROGRESS` and `ACTIONS[run.action]`.

Fix each:

`ui/src/components/RunChip.tsx`: drop the `ACTIONS, EXPECTS_CHANGE, PROGRESS` import; `const verb = run.verb;`; `noChange` uses `run.expectsChange`; the two `PROGRESS[run.action]` become `run.progress`.

`ui/src/components/RunSheet.tsx` `Console`: `const chat = run.chat;`, `noChange` uses `run.expectsChange`, delete `const spec = ACTIONS[run.action];` and replace `spec.verb` in the title with `run.verb`. Run `grep -n "spec\." ui/src/components/RunSheet.tsx` and fix any remaining use inside `Console` the same way; `Plan` keeps its `ACTIONS[action]`. Change the import to `import { ACTIONS, repoFacts } from "../../../src/core/actions";`.

`ui/src/components/RepoMenu.tsx` lines 285-288: `ACTIONS[active.action].verb` becomes `active.verb` (twice).

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/core/actions.ts src/core/actions.test.ts src/core/runner.ts src/server/index.ts ui/src/components/RunChip.tsx ui/src/components/RunSheet.tsx ui/src/components/RepoMenu.tsx
git commit -m "refactor: a run carries its own words, and the runner takes a spec

Claude-Session: https://claude.ai/code/session_01ATKaeCck4C4DhgUzeey9Zw"
```

---

### Task 2: the workflow file parser

**Files:**
- Modify: `src/core/types.ts` (append the workflow types)
- Modify: `src/core/actions.ts` (`TOOL_SETS`, `checkWhen`)
- Create: `src/core/workflow.ts`
- Test: `src/core/workflow.test.ts`

**Interfaces:**
- Produces: `parseWorkflow(text: string, meta: { name: string; source: WorkflowSource; file: string }): WorkflowEntry`; `TOOL_SETS: Record<string, readonly string[]>`; `checkWhen(repo: Repo, when: WorkflowWhen): RunCheck`; types `Workflow`, `WorkflowStep`, `WorkflowEntry`, `WorkflowWhen`, `GateKind`, `WorkflowSource`.

- [ ] **Step 1: Add the types**

Append to `src/core/types.ts`:

```ts
/* ---------- workflows: markdown files that drive Claude step by step ---------- */

export const WORKFLOW_WHENS = ["dirty", "unpushed", "dirty-or-unpushed", "any"] as const;
export type WorkflowWhen = (typeof WORKFLOW_WHENS)[number];

export const GATE_KINDS = ["continue", "ask", "verdict"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

/** where a workflow file came from; later sources win by name */
export type WorkflowSource = "bundled" | "user" | "repo";

export interface WorkflowStep {
  name: string;
  /** permission rules for this step's run, named sets already expanded */
  tools: string[];
  turns: number;
  /** a shell command run in the repo after the step; exit 0 passes */
  check: string | null;
  gate: GateKind;
  /** the step's prompt; empty for a check-only step */
  body: string;
}

export interface Workflow {
  /** `[a-z0-9-]+`, unique across the three sources */
  name: string;
  label: string;
  verb: string;
  blurb: string;
  when: WorkflowWhen;
  expectsChange: boolean;
  notePlaceholder: string;
  noteRequired: boolean;
  steps: WorkflowStep[];
  source: WorkflowSource;
  /** absolute path of the file */
  file: string;
}

/** what the menu lists: a workflow, or a file that failed to parse */
export type WorkflowEntry =
  | { ok: true; workflow: Workflow }
  | { ok: false; name: string; source: WorkflowSource; file: string; error: string };
```

- [ ] **Step 2: Write the failing tests**

`src/core/workflow.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseWorkflow } from "./workflow";

const meta = { name: "ship", source: "bundled" as const, file: "/x/ship.md" };

const SHIP = `---
name: ship
label: ship it
verb: ship
blurb: Runs the gates, commits, pushes.
when: dirty-or-unpushed
expects-change: true
note: anything Claude should know
---

## Gates
tools: bun
turns: 12
check: bun run typecheck && bun test

Run the project's own gates.

## Commit
tools: git-read, git-commit, Bash(cargo fmt:*)
gate: verdict

Task: commit the current changes.

## Push
tools: git-read, git-push
gate: ask

Task: push the branch.
`;

describe("parseWorkflow", () => {
  test("reads the frontmatter and every step", () => {
    const e = parseWorkflow(SHIP, meta);
    if (!e.ok) throw new Error(e.error);
    const w = e.workflow;
    expect(w.name).toBe("ship");
    expect(w.label).toBe("ship it");
    expect(w.verb).toBe("ship");
    expect(w.when).toBe("dirty-or-unpushed");
    expect(w.expectsChange).toBe(true);
    expect(w.notePlaceholder).toBe("anything Claude should know");
    expect(w.noteRequired).toBe(false);
    expect(w.source).toBe("bundled");
    expect(w.file).toBe("/x/ship.md");
    expect(w.steps.map((s) => s.name)).toEqual(["Gates", "Commit", "Push"]);
    const [gates, commit, push] = w.steps;
    expect(gates?.turns).toBe(12);
    expect(gates?.check).toBe("bun run typecheck && bun test");
    expect(gates?.gate).toBe("continue");
    expect(gates?.tools).toContain("Bash(bun run:*)");
    expect(gates?.body).toBe("Run the project's own gates.");
    expect(commit?.tools).toContain("Bash(git commit:*)");
    expect(commit?.tools).toContain("Bash(cargo fmt:*)");
    expect(commit?.gate).toBe("verdict");
    expect(commit?.turns).toBe(30);
    expect(push?.gate).toBe("ask");
    expect(push?.check).toBeNull();
  });

  test("defaults: name from the file, label from the name, verb from the label, git-read tools, when any", () => {
    const e = parseWorkflow(`---\nblurb: b\n---\n\n## Only\n\nDo it.\n`, { ...meta, name: "tidy" });
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.name).toBe("tidy");
    expect(e.workflow.label).toBe("tidy");
    expect(e.workflow.verb).toBe("tidy");
    expect(e.workflow.when).toBe("any");
    expect(e.workflow.expectsChange).toBe(false);
    expect(e.workflow.steps[0]?.tools).toEqual(["Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git branch:*)", "Bash(git remote:*)", "Bash(git rev-parse:*)", "Bash(git fetch:*)"]);
  });

  test("a check-only step has no body", () => {
    const e = parseWorkflow(`---\nblurb: b\n---\n\n## Gates\ncheck: bun test\n\n## Do\n\nWork.\n`, meta);
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.steps[0]?.body).toBe("");
    expect(e.workflow.steps[0]?.check).toBe("bun test");
  });

  test("note-required makes the note the task", () => {
    const e = parseWorkflow(`---\nblurb: b\nnote: what to do\nnote-required: true\n---\n\n## Do\n\nWork.\n`, meta);
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.noteRequired).toBe(true);
  });

  test.each([
    ["no frontmatter", `## Do\n\nWork.\n`, "frontmatter"],
    ["no blurb", `---\nname: x\n---\n\n## Do\n\nWork.\n`, "blurb"],
    ["bad name", `---\nname: Bad Name\nblurb: b\n---\n\n## Do\n\nWork.\n`, "name"],
    ["bad when", `---\nblurb: b\nwhen: sometimes\n---\n\n## Do\n\nWork.\n`, "when"],
    ["no steps", `---\nblurb: b\n---\n\nJust prose.\n`, "step"],
    ["bad gate", `---\nblurb: b\n---\n\n## Do\ngate: maybe\n\nWork.\n`, "gate"],
    ["bad turns", `---\nblurb: b\n---\n\n## Do\nturns: lots\n\nWork.\n`, "turns"],
    ["duplicate step", `---\nblurb: b\n---\n\n## Do\n\nA.\n\n## Do\n\nB.\n`, "twice"],
    ["empty step", `---\nblurb: b\n---\n\n## Do\n\n## Next\n\nB.\n`, "neither a prompt nor a check"],
  ])("rejects %s", (_label, text, word) => {
    const e = parseWorkflow(text, meta);
    expect(e.ok).toBe(false);
    if (!e.ok) {
      expect(e.error).toContain(word);
      expect(e.name).toBe("ship");
      expect(e.file).toBe("/x/ship.md");
    }
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `bun test src/core/workflow.test.ts`
Expected: FAIL, cannot resolve `./workflow`.

- [ ] **Step 4: `TOOL_SETS` and `checkWhen` in actions.ts**

Under the `GIT_PUSH` constant in `src/core/actions.ts` add:

```ts
const BUN = ["Bash(bun run:*)", "Bash(bun test:*)", "Bash(bun install)", "Bash(bun x:*)", "Bash(bunx:*)"];
const READ = ["Read", "Glob", "Grep"];

/** The names a workflow step's `tools:` line may use in place of rules. */
export const TOOL_SETS: Record<string, readonly string[]> = {
  "git-read": GIT_READ,
  "git-commit": GIT_COMMIT,
  "git-push": GIT_PUSH,
  bun: BUN,
  read: READ,
};
```

Use `BUN` inside the deploy spec's `allowedTools` in place of the five literal bun rules already there.

Below `canRun` add:

```ts
/** A workflow's precondition against the repo as the card shows it. */
export function checkWhen(repo: Repo, when: WorkflowWhen): RunCheck {
  if (repo.error) return { ok: false, why: "not a readable repo" };
  const st = repo.status;
  const dirty = (st?.files.length ?? 0) > 0;
  const unpushed = (st?.ahead ?? 0) > 0 || !st?.upstream;
  switch (when) {
    case "dirty":
      return dirty ? { ok: true } : { ok: false, why: "nothing to commit" };
    case "unpushed":
      return unpushed ? { ok: true } : { ok: false, why: "nothing to push" };
    case "dirty-or-unpushed":
      return dirty || unpushed ? { ok: true } : { ok: false, why: "nothing to commit or push" };
    case "any":
      return { ok: true };
  }
}
```

Import `WorkflowWhen` from `./types`.

- [ ] **Step 5: Write the parser**

`src/core/workflow.ts`:

```ts
/** A workflow file: frontmatter for the identity, one `##` heading per step
 *  with a short key block under it and the prompt after. Browser-safe and
 *  pure; the loader in workflows.ts reads the files. */

import { TOOL_SETS } from "./actions";
import {
  GATE_KINDS,
  WORKFLOW_WHENS,
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
  const words = (v ?? "git-read").split(",").map((w) => w.trim()).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    const set = TOOL_SETS[w];
    if (set) out.push(...set);
    else out.push(w);
  }
  return [...new Set(out)];
}

function step(name: string, lines: string[]): WorkflowStep {
  const { keys, rest } = keyBlock(lines);
  const turnsRaw = keys.get("turns");
  const turns = turnsRaw === undefined || turnsRaw === "" ? DEFAULT_TURNS : Number(turnsRaw);
  if (!Number.isInteger(turns) || turns <= 0) throw new Bad(`step ${name}: turns must be a positive whole number, not ${turnsRaw}`);
  const gate: GateKind = oneOf(keys.get("gate"), GATE_KINDS, `step ${name}: gate`, "continue");
  const check = keys.get("check") || null;
  const body = rest.join("\n").trim();
  if (!body && !check) throw new Bad(`step ${name} has neither a prompt nor a check`);
  return { name, tools: tools(keys.get("tools")), turns, check, gate, body };
}

function steps(body: string): WorkflowStep[] {
  const lines = body.split("\n");
  const out: WorkflowStep[] = [];
  let name: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (name === null) return;
    if (out.some((s) => s.name === name)) throw new Bad(`step ${name} appears twice`);
    out.push(step(name, buf));
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
      notePlaceholder: keys.get("note") || "anything Claude should know (optional)",
      noteRequired: bool(keys.get("note-required"), "note-required"),
      steps: steps(body),
      source: meta.source,
      file: meta.file,
    };
    return { ok: true, workflow };
  } catch (err) {
    const error = err instanceof Bad ? err.message : String(err instanceof Error ? err.message : err);
    return { ok: false, name: meta.name, source: meta.source, file: meta.file, error };
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `bun test src/core/workflow.test.ts src/core/actions.test.ts`
Expected: PASS.

- [ ] **Step 7: Gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`

```bash
git add src/core/types.ts src/core/actions.ts src/core/workflow.ts src/core/workflow.test.ts
git commit -m "feat: parse workflow files, markdown with frontmatter and one heading per step

Claude-Session: https://claude.ai/code/session_01ATKaeCck4C4DhgUzeey9Zw"
```

---

### Task 3: the loader and the bundled workflows

**Files:**
- Create: `src/core/workflows.ts`
- Create: `lib/workflows/commit.md`, `lib/workflows/push.md`, `lib/workflows/ship.md`, `lib/workflows/deploy.md`, `lib/workflows/review.md`
- Test: `src/core/workflows.test.ts`

**Interfaces:**
- Consumes: `parseWorkflow` from task 2, `configDir()` from `src/core/store.ts`.
- Produces: `loadWorkflows(repo: Pick<Repo, "path" | "host">): Promise<WorkflowEntry[]>`; `findWorkflow(entries: WorkflowEntry[], name: string): Workflow | undefined`; `BUNDLED_DIR`.

- [ ] **Step 1: Write the failing test**

`src/core/workflows.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkflow, loadWorkflows } from "./workflows";

let cfg = "";
let repo = "";
const savedCfg = process.env["CANOPY_CONFIG_DIR"];

beforeAll(async () => {
  cfg = await mkdtemp(join(tmpdir(), "canopy-wf-cfg-"));
  repo = await mkdtemp(join(tmpdir(), "canopy-wf-repo-"));
  process.env["CANOPY_CONFIG_DIR"] = cfg;
  await mkdir(join(cfg, "workflows"), { recursive: true });
  await mkdir(join(repo, ".canopy", "workflows"), { recursive: true });
  await writeFile(
    join(cfg, "workflows", "review.md"),
    `---\nblurb: my own review\n---\n\n## Look\n\nRead the diff.\n`,
  );
  await writeFile(
    join(cfg, "workflows", "broken.md"),
    `---\nname: broken\n---\n\n## Do\n\nx\n`,
  );
  await writeFile(
    join(repo, ".canopy", "workflows", "tidy.md"),
    `---\nblurb: tidy this repo\n---\n\n## Tidy\n\nTidy.\n`,
  );
});

afterAll(async () => {
  if (savedCfg === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = savedCfg;
  await rm(cfg, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe("loadWorkflows", () => {
  test("bundled, then user, then repo, later winning by name; broken files stay listed", async () => {
    const list = await loadWorkflows({ path: repo });
    const names = list.map((e) => (e.ok ? e.workflow.name : e.name));
    expect(names).toEqual(["commit", "push", "ship", "deploy", "review", "broken", "tidy"]);
    const review = findWorkflow(list, "review");
    expect(review?.source).toBe("user");
    expect(review?.blurb).toBe("my own review");
    expect(findWorkflow(list, "commit")?.source).toBe("bundled");
    expect(findWorkflow(list, "tidy")?.source).toBe("repo");
    const broken = list.find((e) => !e.ok);
    expect(broken && !broken.ok ? broken.error : "").toContain("blurb");
    expect(findWorkflow(list, "broken")).toBeUndefined();
  });

  test("a remote repo gets no repo-level files", async () => {
    const list = await loadWorkflows({ path: `ssh://box${repo}`, host: "box" });
    expect(list.some((e) => e.ok && e.workflow.name === "tidy")).toBe(false);
    expect(findWorkflow(list, "review")?.source).toBe("user");
  });

  test("every bundled workflow parses and has the expected shape", async () => {
    const list = await loadWorkflows({ path: "/nonexistent" });
    const ship = findWorkflow(list, "ship");
    expect(ship?.steps.map((s) => s.name)).toEqual(["Gates", "Commit", "Push"]);
    expect(ship?.steps[0]?.check).toContain("bun run typecheck");
    expect(ship?.when).toBe("dirty-or-unpushed");
    expect(findWorkflow(list, "commit")?.when).toBe("dirty");
    expect(findWorkflow(list, "commit")?.expectsChange).toBe(true);
    expect(findWorkflow(list, "push")?.when).toBe("unpushed");
    expect(findWorkflow(list, "deploy")?.when).toBe("any");
    expect(findWorkflow(list, "review")?.steps[0]?.tools).not.toContain("Bash(git commit:*)");
  });
});
```

The first test's `review` expectation only holds with the user override in place, so it runs against the temp config dir set in `beforeAll`.

- [ ] **Step 2: Run the test to see it fail**

Run: `bun test src/core/workflows.test.ts`
Expected: FAIL, cannot resolve `./workflows`.

- [ ] **Step 3: Write the loader**

`src/core/workflows.ts`:

```ts
/** Workflow files from the three places they live, bundled first, the
 *  user's second, the repo's own last, later ones replacing earlier ones
 *  with the same name. Bun-only: the parser is in workflow.ts. */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { configDir } from "./store";
import { parseWorkflow } from "./workflow";
import type { Repo, Workflow, WorkflowEntry, WorkflowSource } from "./types";

export const BUNDLED_DIR = join(import.meta.dir, "../../lib/workflows");

/** Bundled files in the order the menu shows them. */
const BUNDLED_ORDER = ["commit", "push", "ship", "deploy", "review"];

async function readDir(dir: string, source: WorkflowSource): Promise<WorkflowEntry[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }
  if (source === "bundled") {
    names.sort((a, b) => BUNDLED_ORDER.indexOf(basename(a, ".md")) - BUNDLED_ORDER.indexOf(basename(b, ".md")));
  }
  const out: WorkflowEntry[] = [];
  for (const n of names) {
    const file = join(dir, n);
    const meta = { name: basename(n, ".md"), source, file };
    try {
      out.push(parseWorkflow(await readFile(file, "utf8"), meta));
    } catch (err) {
      out.push({ ok: false, ...meta, error: String(err instanceof Error ? err.message : err) });
    }
  }
  return out;
}

const entryName = (e: WorkflowEntry): string => (e.ok ? e.workflow.name : e.name);

export async function loadWorkflows(repo: Pick<Repo, "path" | "host">): Promise<WorkflowEntry[]> {
  const lists = [
    await readDir(BUNDLED_DIR, "bundled"),
    await readDir(join(configDir(), "workflows"), "user"),
    repo.host ? [] : await readDir(join(repo.path, ".canopy", "workflows"), "repo"),
  ];
  // Insertion order is the menu order; an override replaces in place.
  const merged = new Map<string, WorkflowEntry>();
  for (const list of lists) for (const e of list) merged.set(entryName(e), e);
  return [...merged.values()];
}

export function findWorkflow(entries: WorkflowEntry[], name: string): Workflow | undefined {
  const e = entries.find((x) => entryName(x) === name);
  return e?.ok ? e.workflow : undefined;
}
```

- [ ] **Step 4: Write the bundled files**

The prompts are the `task` strings of the corresponding specs in `src/core/actions.ts` at this point in the plan, copied verbatim with the `${SUBMODULE_STEP}` and `${STRAY_STEP}` templates expanded inline (paste the two paragraphs from the constants). The ground rules are not in the file: the runner adds them to every step's prompt.

`lib/workflows/commit.md`:

```markdown
---
name: commit
label: commit
verb: commit
blurb: Claude reads the diff, stages what belongs, writes the message in this repo's style and commits. Unrelated changes become separate commits. Nothing is pushed.
when: dirty
expects-change: true
---

## Commit
tools: git-read, git-commit

Task: commit the current changes, so that git status is clean afterwards.
1. Look at git status and the full diff, including untracked files.
2. If an entry in git status is a submodule (git status --porcelain=v2 marks it with an S field, or git diff --submodule shows it), handle it inside the submodule first: go into its directory and commit there by the same rules (and when this task pushes, push the submodule before pushing this repo, so the pointer stays reachable), then stage the updated pointer in this repo and commit that. Untracked or modified content inside a submodule is a change to deal with, not a reason to stop.
3. For each file you would not commit on your own (build output, a stray backup, an editor file, something that looks accidental), ask with AskUserQuestion what to do with it: commit it, add it to .gitignore and commit that, delete it, or leave it. Do what the user picks. Skip the question only if the user's note already decided.
4. Stage what belongs together. If the changes are clearly unrelated, make more than one commit, each with its own coherent set of files. Otherwise make one.
5. Match the style of recent messages (git log --oneline -15): imperative subject under 65 characters, optional body explaining why.
6. Do not push.
```

`lib/workflows/push.md`:

```markdown
---
name: push
label: push
verb: push
blurb: Claude pushes the current branch. A branch with no upstream gets one. If the remote is ahead, Claude rebases only when that is clearly safe, and otherwise stops and explains. Never a force push.
when: unpushed
expects-change: true
---

## Push
tools: git-read, git-push
turns: 20

Task: push the current branch, so that it is no longer ahead of its upstream.
1. If the branch has an upstream, push to it. If not, push with -u to origin, or to the only remote if there is one; if several remotes and no origin, ask which one.
2. If the push is rejected because the remote is ahead: fetch, and rebase onto the upstream only if the rebase completes without conflicts. On any conflict abort the rebase, leave the repo as it was, and ask how to proceed.
3. If there are uncommitted changes as well, ask whether to commit them first (by the commit rules: submodules handled inside first, stray files decided one by one) or push only what is committed.
4. If the commits being pushed point at submodule commits that are not on the submodule's remote, push the submodule first.
5. Never force-push.
```

`lib/workflows/ship.md`:

```markdown
---
name: ship
label: ship
verb: ship
blurb: Claude runs the project's gates, commits the changes the way the commit workflow does, then pushes the branch the way push does. A failing gate stops it before anything is committed.
when: dirty-or-unpushed
expects-change: true
---

## Gates
tools: bun, read
turns: 40
check: bun run typecheck && bun run lint && bun test && bun run build

Task: run this project's own gates (typecheck, lint, tests, build, in whatever form the project defines them; look at package.json scripts, a Makefile, or CLAUDE.md). If a gate fails and the fix is obvious and inside this repo, fix it and run the gates again. Otherwise stop and say exactly what failed. Do not commit anything in this step.

## Commit
tools: git-read, git-commit
gate: verdict

(paste the six-line commit task from commit.md above, unchanged)

## Push
tools: git-read, git-push
turns: 20

(paste the five-line push task from push.md above, unchanged)
```

If the project has no bun scripts the check fails and the flow stops with the output shown; that is the intended behaviour, and a repo can override `ship` under `.canopy/workflows`.

`lib/workflows/deploy.md`:

```markdown
---
name: deploy
label: deploy
verb: deploy
blurb: Claude works out how this project deploys (Vercel, Firebase, Cloudflare, a Dockerfile, a script...), runs the project's own gates first, and deploys. Uncommitted changes and anything outside the usual pipeline come back to you as a question.
when: any
note: target, environment, or anything else Claude should know (optional)
---

## Deploy
tools: git-read, bun, Bash(npm run:*), Bash(cat:*), Bash(ls:*)
turns: 80

Task: deploy this project to where it normally deploys.
1. Find out how it deploys: vercel.json or .vercel, firebase.json, wrangler.toml, fly.toml, a Dockerfile or compose file, deploy scripts in package.json, a Makefile, and anything CLAUDE.md or README says about deploying. If nothing indicates a deploy target, say so and stop.
2. If there are uncommitted changes, ask with AskUserQuestion whether to commit them first, deploy as-is, or stop.
3. Run the project's own gates before deploying (typecheck, lint, tests, build, in whatever form the project defines them). Stop and report if one fails; do not deploy a failing build.
4. Deploy. Prefer the project's own script over a raw CLI call when both exist.
5. Report the deployment URL and anything you noticed.
```

`lib/workflows/review.md`:

```markdown
---
name: review
label: review
verb: review
blurb: Claude reads the uncommitted changes and the recent commits and reports what looks wrong, risky, or unfinished. It changes nothing.
when: any
---

## Review
tools: git-read, read
turns: 40

Task: review this repository's current state and report. Read git status, the full diff including untracked files, and the last ten commits. Look for bugs, unfinished work, leftover debugging, secrets or credentials, files that should not be committed, and anything that contradicts CLAUDE.md or the README. Do not edit, stage, commit, or run anything that changes files. Finish with a short plain-prose report: what is fine, what needs attention, in order of importance.
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/workflows.test.ts`
Expected: PASS.

- [ ] **Step 6: Gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`

```bash
git add src/core/workflows.ts src/core/workflows.test.ts lib/workflows
git commit -m "feat: load workflows from canopy, the config dir and the repo, with five bundled ones

Claude-Session: https://claude.ai/code/session_01ATKaeCck4C4DhgUzeey9Zw"
```

---

### Task 4: the verdict and the Jev evaluator

**Files:**
- Modify: `src/core/types.ts` (append `VerdictAnswers`, `Verdict`)
- Create: `src/core/verdict.ts`, `src/core/jev.ts`
- Modify: `package.json` (dependencies `ai`, `@ai-sdk/gateway`)
- Test: `src/core/verdict.test.ts`, `src/core/jev.test.ts`

**Interfaces:**
- Produces: `VERDICT_QUESTIONS`, `THRESHOLDS`, `decide(answers: VerdictAnswers): Verdict`, `verdictState(input: { summary: string; check: string | null; changed: boolean | null }): string`, `type Evaluator = (state: string) => Promise<VerdictAnswers>`, `jev: Evaluator`, `hasGatewayKey(): boolean`.

- [ ] **Step 1: Add the types**

Append to `src/core/types.ts`:

```ts
/* ---------- the verdict gate: Jev reads a step's summary ---------- */

export type VerdictOutcome = "done" | "partial" | "blocked";

/** the answers as the evaluator returns them, one per question */
export interface VerdictAnswers {
  outcome: { choice: VerdictOutcome; probabilities?: Record<string, number> };
  needsYou: { probability: number };
  offScope: { probability: number };
}

export interface Verdict {
  answers: VerdictAnswers;
  /** whether the flow may go on without the user */
  go: boolean;
  /** why it may not, one line; null when go */
  reason: string | null;
}
```

- [ ] **Step 2: Write the failing tests**

`src/core/verdict.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { THRESHOLDS, decide, verdictState } from "./verdict";
import type { VerdictAnswers } from "./types";

const answers = (o: Partial<VerdictAnswers> = {}): VerdictAnswers => ({
  outcome: { choice: "done", probabilities: { done: 0.9, partial: 0.05, blocked: 0.05 } },
  needsYou: { probability: 0.1 },
  offScope: { probability: 0.1 },
  ...o,
});

describe("decide", () => {
  test("a confident done with nothing for the user goes", () => {
    const v = decide(answers());
    expect(v.go).toBe(true);
    expect(v.reason).toBeNull();
  });

  test("done exactly at the threshold goes; just under parks", () => {
    expect(decide(answers({ outcome: { choice: "done", probabilities: { done: THRESHOLDS.done } } })).go).toBe(true);
    const v = decide(answers({ outcome: { choice: "done", probabilities: { done: THRESHOLDS.done - 0.01 } } }));
    expect(v.go).toBe(false);
    expect(v.reason).toContain("not sure");
  });

  test("partial and blocked park with the outcome named", () => {
    expect(decide(answers({ outcome: { choice: "partial" } })).reason).toContain("partly");
    expect(decide(answers({ outcome: { choice: "blocked" } })).reason).toContain("blocked");
  });

  test("needs you parks at the threshold", () => {
    const v = decide(answers({ needsYou: { probability: THRESHOLDS.needsYou } }));
    expect(v.go).toBe(false);
    expect(v.reason).toContain("asks you");
  });

  test("off scope parks at the threshold", () => {
    const v = decide(answers({ offScope: { probability: THRESHOLDS.offScope } }));
    expect(v.go).toBe(false);
    expect(v.reason).toContain("outside");
  });

  test("missing probabilities count as certain", () => {
    expect(decide(answers({ outcome: { choice: "done" } })).go).toBe(true);
  });
});

describe("verdictState", () => {
  test("names each part so the classifier can tell them apart", () => {
    const s = verdictState({ summary: "Committed 2 files.", check: "ok\n", changed: true });
    expect(s).toContain("Step summary:\nCommitted 2 files.");
    expect(s).toContain("Check output:\nok");
    expect(s).toContain("git status changed during the step: yes");
  });
  test("leaves out what is unknown", () => {
    const s = verdictState({ summary: "", check: null, changed: null });
    expect(s).toContain("(no summary)");
    expect(s).not.toContain("Check output");
    expect(s).not.toContain("git status changed");
  });
});
```

`src/core/jev.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { hasGatewayKey, jev } from "./jev";
import { decide, verdictState } from "./verdict";

describe("jev, live", () => {
  test.skipIf(!hasGatewayKey())("a clean summary is a go", async () => {
    const answers = await jev(
      verdictState({ summary: "Committed the two changed files as one commit, abc1234. Nothing left in git status.", check: null, changed: true }),
    );
    expect(["done", "partial", "blocked"]).toContain(answers.outcome.choice);
    expect(decide(answers).go).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `bun test src/core/verdict.test.ts src/core/jev.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 4: Install the dependencies**

Run: `bun add ai@^7.0.105 @ai-sdk/gateway@^4.0.85`
Expected: both appear under `dependencies` in `package.json`.

- [ ] **Step 5: Write verdict.ts**

```ts
/** The verdict gate: what a step's closing summary is asked, and what the
 *  answers mean. Pure and browser-safe; jev.ts is the evaluator. */

import type { Verdict, VerdictAnswers } from "./types";

export const VERDICT_QUESTIONS = {
  outcome: {
    type: "choice",
    instructions: "Did the step finish its task?",
    criteria: {
      done: "The task is complete and the summary reports what was done",
      partial: "Some of the task was done and the rest was left, deferred, or explained away",
      blocked: "Nothing or almost nothing was done because of an error, a conflict, or a missing decision",
    },
  },
  needsYou: {
    type: "boolean",
    instructions: "Does the summary ask the user to decide, confirm, or check something before going on?",
  },
  offScope: {
    type: "boolean",
    instructions: "Did the step touch anything outside the repository, or do something beyond what the task asked?",
  },
} as const;

export const THRESHOLDS = {
  /** the done choice needs at least this much probability */
  done: 0.7,
  needsYou: 0.5,
  offScope: 0.5,
} as const;

/** The gate's decision. Continue only when done is confident and nothing
 *  points back at the user. */
export function decide(answers: VerdictAnswers): Verdict {
  const { outcome, needsYou, offScope } = answers;
  const park = (reason: string): Verdict => ({ answers, go: false, reason });
  if (offScope.probability >= THRESHOLDS.offScope) {
    return park("the step seems to have gone outside its task or the repository");
  }
  if (needsYou.probability >= THRESHOLDS.needsYou) {
    return park("the summary asks you something");
  }
  if (outcome.choice === "partial") return park("the step got only partly done");
  if (outcome.choice === "blocked") return park("the step was blocked");
  const p = outcome.probabilities?.[outcome.choice] ?? 1;
  if (p < THRESHOLDS.done) return park("not sure the step is really done");
  return { answers, go: true, reason: null };
}

/** The text the classifier reads: the summary, the check's output when a
 *  check ran, and whether git status moved when that is known. */
export function verdictState(input: {
  summary: string;
  check: string | null;
  changed: boolean | null;
}): string {
  const parts = [`Step summary:\n${input.summary.trim() || "(no summary)"}`];
  if (input.check !== null) parts.push(`Check output:\n${input.check.trim() || "(empty)"}`);
  if (input.changed !== null) parts.push(`git status changed during the step: ${input.changed ? "yes" : "no"}`);
  return parts.join("\n\n");
}
```

- [ ] **Step 6: Write jev.ts**

```ts
/** The Jev classifier through the Vercel AI Gateway, asked the verdict
 *  questions. Ported from ~/dev/ai-tools/jev-lab. Bun-only. */

import { createGateway } from "@ai-sdk/gateway";
import { APICallError, experimental_evaluate as evaluate } from "ai";
import { VERDICT_QUESTIONS } from "./verdict";
import type { VerdictAnswers, VerdictOutcome } from "./types";

export const JEV_MODEL = "typesafe-ai/jev";
/** Jev answers in a few hundred ms; the gateway occasionally hangs, so each
 *  attempt is short and retried. */
const ATTEMPT_TIMEOUT_MS = 6000;
const ATTEMPTS = 3;

export type Evaluator = (state: string) => Promise<VerdictAnswers>;

function gatewayApiKey(): string | undefined {
  return process.env["AI_GATEWAY_API_KEY"] ?? process.env["VERCEL_AI_GATEWAY_API_KEY"];
}

export function hasGatewayKey(): boolean {
  return gatewayApiKey() !== undefined;
}

const isOutcome = (v: unknown): v is VerdictOutcome => v === "done" || v === "partial" || v === "blocked";

function isRetryable(error: unknown): boolean {
  if (APICallError.isInstance(error)) return error.isRetryable;
  return true;
}

export const jev: Evaluator = async (state) => {
  const gateway = createGateway({ apiKey: gatewayApiKey() });
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await evaluate({
        model: gateway.evaluationModel(JEV_MODEL),
        state,
        questions: VERDICT_QUESTIONS,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      const a = result.answers;
      const choice = a.outcome.choice;
      if (!isOutcome(choice)) throw new Error(`unexpected outcome: ${String(choice)}`);
      return {
        outcome: { choice, probabilities: a.outcome.probabilities },
        needsYou: { probability: a.needsYou.probability },
        offScope: { probability: a.offScope.probability },
      };
    } catch (error) {
      if (attempt >= ATTEMPTS || !isRetryable(error)) throw error;
    }
  }
};
```

If `result.answers.outcome.probabilities` is typed differently by the installed `ai` version, read it the way jev-lab's `triage.ts` does (`answers.department.probabilities?.[department]`) and adjust the mapping, not the `VerdictAnswers` type.

- [ ] **Step 7: Run the tests**

Run: `bun test src/core/verdict.test.ts src/core/jev.test.ts`
Expected: verdict PASS; jev live test skipped (or passing with a key in the env).

- [ ] **Step 8: Gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`

```bash
git add package.json bun.lock src/core/types.ts src/core/verdict.ts src/core/verdict.test.ts src/core/jev.ts src/core/jev.test.ts
git commit -m "feat: the verdict gate, Jev reads a step's summary and decides

Claude-Session: https://claude.ai/code/session_01ATKaeCck4C4DhgUzeey9Zw"
```

---

### Task 5: the flow orchestrator

**Files:**
- Modify: `src/core/types.ts` (append `Flow*` types, extend `ServerEvent`)
- Create: `src/core/flow.ts`
- Test: `src/core/flow.test.ts`

**Interfaces:**
- Consumes: `Runner.start(repo, action, spec, note, agent)` shape from task 1 (through the `FlowRunner` interface), `Workflow` from task 2, `decide`, `verdictState`, `Evaluator` from task 4, `buildPrompt`'s framing via `ActionSpec`.
- Produces: `class Flows` with `list()`, `get(id)`, `activeFor(repoId)`, `start(repo, workflow, note, agent)`, `onRun(run)`, `resume(id, choice)`, `stop(id)`, `dismiss(id)`, `stopAll()`; `stepSpec(wf, index, summaries, retryReason?)`; `summaryOf(run)`; types `Flow`, `FlowStep`, `FlowStatus`, `StepStatus`, `FlowChoice`, `FlowRunner`, `FlowHooks`, `CheckResult`.

- [ ] **Step 1: Add the types**

Append to `src/core/types.ts`:

```ts
/* ---------- flows: one workflow running on one repo ---------- */

export type FlowStatus = "working" | "waiting" | "gated" | "done" | "failed" | "stopped";
export type StepStatus = "pending" | "running" | "checking" | "gated" | "passed" | "failed" | "skipped";
export type FlowChoice = "continue" | "retry" | "stop";

export interface FlowStep {
  name: string;
  status: StepStatus;
  /** the step's Run, once it has one */
  runId?: string;
  check?: { command: string; exit: number; output: string };
  verdict?: Verdict;
  /** Claude's closing summary, the last text of the run */
  summary?: string;
  /** why a gate parked or a step failed, for the sheet */
  reason?: string;
}

export interface Flow {
  id: string;
  repoId: string;
  workflow: string;
  verb: string;
  fleetId?: string;
  note: string;
  status: FlowStatus;
  steps: FlowStep[];
  /** index of the step in progress or parked */
  current: number;
  startedAt: number;
  endedAt?: number;
  /** why a failed flow failed */
  error?: string;
  /** set when the flow ends, for workflows that expect change */
  outcome?: "changed" | "unchanged";
}

/** A flow with a live step: running, waiting on a prompt, or parked at a gate. */
export const isFlowActive = (f: Flow): boolean =>
  f.status === "working" || f.status === "waiting" || f.status === "gated";
```

Extend `ServerEvent` with:

```ts
  | { type: "flow"; flow: Flow }
  | { type: "flow-gone"; id: string }
```

(`fleet` and `fleet-gone` come in task 6.)

- [ ] **Step 2: Write the failing tests**

`src/core/flow.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Flows, stepSpec, summaryOf, type CheckResult, type FlowRunner } from "./flow";
import { parseWorkflow } from "./workflow";
import { DEFAULT_AGENT, type Flow, type Repo, type Run, type VerdictAnswers, type Workflow } from "./types";
import type { ActionSpec } from "./actions";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function wf(text: string): Workflow {
  const e = parseWorkflow(text, { name: "t", source: "bundled", file: "/t.md" });
  if (!e.ok) throw new Error(e.error);
  return e.workflow;
}

const TWO = wf(`---
name: two
verb: do two
blurb: b
expects-change: true
---

## First
gate: ask

Do the first.

## Second

Do the second.
`);

const repo = (): Repo => ({
  id: "r",
  name: "r",
  path: "/tmp/r",
  group: "",
  source: "root",
  status: null,
});

/** A Runner that starts nothing and ends runs when told. */
class FakeRunner implements FlowRunner {
  runs = new Map<string, Run>();
  specs: ActionSpec[] = [];
  notes: string[] = [];
  stopped: string[] = [];
  dismissed: string[] = [];
  onChange: (run: Run) => void = () => {};
  private n = 0;
  start(r: Repo, action: string, spec: ActionSpec, note: string): Run {
    this.n += 1;
    const run: Run = {
      id: `run${this.n}`, repoId: r.id, action, verb: spec.verb, progress: spec.progress,
      expectsChange: spec.expectsChange, chat: false, note, status: "working",
      startedAt: 0, steps: [], prompt: null,
    };
    this.runs.set(run.id, run);
    this.specs.push(spec);
    this.notes.push(note);
    return run;
  }
  get(id: string) { return this.runs.get(id); }
  activeFor(repoId: string) {
    return [...this.runs.values()].find((r) => r.repoId === repoId && r.status === "working");
  }
  stop(id: string): Run {
    this.stopped.push(id);
    return this.end(id, "stopped");
  }
  dismiss(id: string) { this.dismissed.push(id); }
  end(id: string, status: Run["status"], text = "", error?: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error(id);
    run.status = status;
    if (text) run.result = { text, costUsd: 0, durationMs: 0, turns: 1 };
    if (error) run.error = error;
    this.onChange(run);
    return run;
  }
  /** the last started run's id */
  last(): string { return `run${this.n}`; }
}

function setup(opts: {
  check?: (cmd: string) => CheckResult;
  evaluator?: ((state: string) => Promise<VerdictAnswers>) | null;
  status?: () => Promise<Repo["status"]>;
} = {}) {
  const runner = new FakeRunner();
  const changes: Flow[] = [];
  const gone: string[] = [];
  const checks: string[] = [];
  const flows = new Flows(runner, {
    onChange: (f) => changes.push(structuredClone(f)),
    onGone: (id) => gone.push(id),
    onFleet: () => {},
    onFleetGone: () => {},
    check: async (_repo, command) => {
      checks.push(command);
      return opts.check ? opts.check(command) : { exit: 0, output: "" };
    },
    evaluator: opts.evaluator ?? null,
    status: opts.status,
  });
  runner.onChange = (run) => flows.onRun(run);
  return { runner, flows, changes, gone, checks };
}

describe("stepSpec", () => {
  test("names the step, carries its tools and turns, and folds earlier summaries in", () => {
    const spec = stepSpec(TWO, 1, [{ name: "First", summary: "did the first" }]);
    expect(spec.verb).toBe("do two · Second");
    expect(spec.progress).toBe("do two: Second");
    expect(spec.maxTurns).toBe(30);
    expect(spec.mode).toBe("job");
    expect(spec.expectsChange).toBe(false);
    expect(spec.task).toContain("Earlier steps of this workflow, already done:\n- First: did the first");
    expect(spec.task.endsWith("Do the second.")).toBe(true);
  });
  test("a retry says why the last try was not accepted", () => {
    const spec = stepSpec(TWO, 0, [], "the summary asks you something");
    expect(spec.task).toContain("not accepted because: the summary asks you something");
  });
});

describe("summaryOf", () => {
  test("prefers the result, then the last text step", () => {
    const base: Run = { id: "x", repoId: "r", action: "a", verb: "v", progress: "p", expectsChange: false, chat: false, note: "", status: "done", startedAt: 0, steps: [], prompt: null };
    expect(summaryOf({ ...base, result: { text: "closing", costUsd: 0, durationMs: 0, turns: 1 } })).toBe("closing");
    expect(summaryOf({ ...base, steps: [{ id: "1", at: 0, kind: "tool" }, { id: "2", at: 0, kind: "text", text: "words" }] })).toBe("words");
    expect(summaryOf(base)).toBe("");
  });
});

describe("Flows", () => {
  test("runs steps in order, parks at an ask gate, continues on resume, and settles the outcome", async () => {
    const st = { branch: "main", upstream: "o/main", ahead: 0, behind: 0, files: [], lastCommit: null } as unknown as Repo["status"];
    const { runner, flows } = setup({ status: async () => st });
    const flow = flows.start({ ...repo(), status: st }, TWO, "note!", DEFAULT_AGENT);
    expect(flow.status).toBe("working");
    expect(flow.steps.map((s) => s.status)).toEqual(["running", "pending"]);
    expect(runner.notes).toEqual(["note!"]);
    runner.end("run1", "done", "first done");
    await flush();
    expect(flows.get(flow.id)?.status).toBe("gated");
    expect(flows.get(flow.id)?.steps[0]?.summary).toBe("first done");
    expect(flows.get(flow.id)?.steps[0]?.status).toBe("gated");
    flows.resume(flow.id, "continue");
    await flush();
    expect(flows.get(flow.id)?.steps[0]?.status).toBe("passed");
    expect(flows.get(flow.id)?.current).toBe(1);
    expect(runner.specs[1]?.task).toContain("First: first done");
    runner.end("run2", "done", "second done");
    await flush();
    const done = flows.get(flow.id);
    expect(done?.status).toBe("done");
    expect(done?.steps.map((s) => s.status)).toEqual(["passed", "passed"]);
    expect(done?.outcome).toBe("unchanged");
  });

  test("retry runs the same step again with the reason, replacing its run", async () => {
    const { runner, flows } = setup();
    const flow = flows.start(repo(), TWO, "", DEFAULT_AGENT);
    runner.end("run1", "done", "hmm");
    await flush();
    flows.resume(flow.id, "retry");
    await flush();
    expect(flows.get(flow.id)?.current).toBe(0);
    expect(flows.get(flow.id)?.steps[0]?.runId).toBe("run2");
    expect(runner.specs[1]?.task).toContain("not accepted because");
    expect(runner.dismissed).toEqual(["run1"]);
  });

  test("stop at a gate ends the flow and skips the rest", async () => {
    const { runner, flows } = setup();
    const flow = flows.start(repo(), TWO, "", DEFAULT_AGENT);
    runner.end("run1", "done", "x");
    await flush();
    flows.resume(flow.id, "stop");
    expect(flows.get(flow.id)?.status).toBe("stopped");
    expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["failed", "skipped"]);
  });

  test("a failing check fails the step and the flow with the output", async () => {
    const CHECKED = wf(`---\nblurb: b\n---\n\n## Gate\ncheck: bun test\n\n## After\n\nx\n`);
    const { flows, checks } = setup({ check: () => ({ exit: 1, output: "1 fail" }) });
    const flow = flows.start(repo(), CHECKED, "", DEFAULT_AGENT);
    await flush();
    expect(checks).toEqual(["bun test"]);
    const f = flows.get(flow.id);
    expect(f?.status).toBe("failed");
    expect(f?.steps[0]?.check).toEqual({ command: "bun test", exit: 1, output: "1 fail" });
    expect(f?.steps[0]?.status).toBe("failed");
    expect(f?.steps[1]?.status).toBe("skipped");
  });

  test("a check-only step starts no run and passes on exit 0", async () => {
    const CHECKED = wf(`---\nblurb: b\n---\n\n## Gate\ncheck: true\n\n## After\n\nx\n`);
    const { runner, flows } = setup();
    const flow = flows.start(repo(), CHECKED, "", DEFAULT_AGENT);
    await flush();
    expect(runner.specs.length).toBe(1);
    expect(runner.specs[0]?.verb).toBe("t · After");
    expect(flows.get(flow.id)?.steps[0]?.status).toBe("passed");
  });

  test("a failed run fails the flow; a stopped run stops it", async () => {
    const a = setup();
    const fa = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.runner.end("run1", "failed", "", "boom");
    await flush();
    expect(a.flows.get(fa.id)?.status).toBe("failed");
    expect(a.flows.get(fa.id)?.error).toBe("boom");
    const b = setup();
    const fb = b.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    b.flows.stop(fb.id);
    await flush();
    expect(b.runner.stopped).toEqual(["run1"]);
    expect(b.flows.get(fb.id)?.status).toBe("stopped");
  });

  test("the verdict gate goes on a go, parks with the reason otherwise, and falls back to ask without an evaluator", async () => {
    const V = wf(`---\nblurb: b\n---\n\n## One\ngate: verdict\n\nx\n\n## Two\n\ny\n`);
    const go: VerdictAnswers = { outcome: { choice: "done", probabilities: { done: 0.95 } }, needsYou: { probability: 0 }, offScope: { probability: 0 } };
    const a = setup({ evaluator: async () => go });
    const fa = a.flows.start(repo(), V, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "all good");
    await flush();
    expect(a.flows.get(fa.id)?.steps[0]?.verdict?.go).toBe(true);
    expect(a.flows.get(fa.id)?.current).toBe(1);

    const b = setup({ evaluator: async () => ({ ...go, needsYou: { probability: 0.9 } }) });
    const fb = b.flows.start(repo(), V, "", DEFAULT_AGENT);
    b.runner.end("run1", "done", "please decide");
    await flush();
    expect(b.flows.get(fb.id)?.status).toBe("gated");
    expect(b.flows.get(fb.id)?.steps[0]?.reason).toBe("the summary asks you something");

    const c = setup({ evaluator: null });
    const fc = c.flows.start(repo(), V, "", DEFAULT_AGENT);
    c.runner.end("run1", "done", "x");
    await flush();
    expect(c.flows.get(fc.id)?.status).toBe("gated");
    expect(c.flows.get(fc.id)?.steps[0]?.reason).toContain("no gateway key");

    const d = setup({ evaluator: async () => { throw new Error("gateway down"); } });
    const fd = d.flows.start(repo(), V, "", DEFAULT_AGENT);
    d.runner.end("run1", "done", "x");
    await flush();
    expect(d.flows.get(fd.id)?.steps[0]?.reason).toContain("gateway down");
  });

  test("mirrors a waiting run, refuses a busy repo, and dismisses only finished flows", async () => {
    const { runner, flows, gone } = setup();
    const flow = flows.start(repo(), TWO, "", DEFAULT_AGENT);
    const run = runner.get("run1");
    if (!run) throw new Error("no run");
    run.status = "waiting";
    runner.onChange(run);
    expect(flows.get(flow.id)?.status).toBe("waiting");
    expect(() => flows.start(repo(), TWO, "", DEFAULT_AGENT)).toThrow(/already/);
    expect(() => flows.dismiss(flow.id)).toThrow(/stop/);
    run.status = "working";
    runner.onChange(run);
    flows.stop(flow.id);
    await flush();
    flows.dismiss(flow.id);
    expect(gone).toEqual([flow.id]);
    expect(runner.dismissed).toContain("run1");
  });
});
```

The `status` stub in the first test casts through `unknown` because `RepoStatus` has more fields than the test cares about; keep the cast in the test only.

- [ ] **Step 3: Run the tests to see them fail**

Run: `bun test src/core/flow.test.ts`
Expected: FAIL, cannot resolve `./flow`.

- [ ] **Step 4: Write flow.ts**

```ts
/** Flows: one workflow on one repo, step by step. Every step is a normal Run
 *  through the Runner; between steps come the check and the gate. Bun-only
 *  through its hooks (the check and the evaluator), pure in its logic, so the
 *  tests drive it with a fake runner. */

import { type ActionSpec } from "./actions";
import { decide, verdictState } from "./verdict";
import {
  isFlowActive,
  isRunActive,
  statusFingerprint,
  type AgentSettings,
  type Fleet,
  type Flow,
  type FlowChoice,
  type Repo,
  type RepoStatus,
  type Run,
  type Workflow,
  type VerdictAnswers,
} from "./types";

const KEEP_FINISHED = 60;

export interface CheckResult {
  exit: number;
  output: string;
}

/** What Flows needs from the Runner; the real one satisfies it. */
export interface FlowRunner {
  start(repo: Repo, action: string, spec: ActionSpec, note: string, agent: AgentSettings): Run;
  get(id: string): Run | undefined;
  activeFor(repoId: string): Run | undefined;
  stop(id: string): Run;
  dismiss(id: string): void;
}

export interface FlowHooks {
  onChange: (flow: Flow) => void;
  onGone: (id: string) => void;
  onFleet: (fleet: Fleet) => void;
  onFleetGone: (id: string) => void;
  /** runs a step's check in the repo */
  check: (repo: Repo, command: string) => Promise<CheckResult>;
  /** null when there is no gateway key: verdict gates then ask */
  evaluator: ((state: string) => Promise<VerdictAnswers>) | null;
  /** a fresh status for the repo, for the outcome; null when unreadable */
  status?: (repoId: string) => Promise<RepoStatus | null>;
}

interface LiveFlow {
  flow: Flow;
  repo: Repo;
  workflow: Workflow;
  agent: AgentSettings;
  before: string;
  /** set by stop(): the run's end that follows is ours */
  stopping: boolean;
  /** the gate's reason a retry carries into the next prompt */
  retry?: string;
}

/** Claude's closing words: the result, else the last text step. */
export function summaryOf(run: Run): string {
  if (run.result?.text) return run.result.text;
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const s = run.steps[i];
    if (s?.kind === "text" && s.text) return s.text;
  }
  return "";
}

/** The spec for one step's run: the step's prompt behind what earlier
 *  steps reported, framed by the runner the way any job is. */
export function stepSpec(
  wf: Workflow,
  index: number,
  summaries: { name: string; summary: string }[],
  retryReason?: string,
): ActionSpec {
  const step = wf.steps[index];
  if (!step) throw new Error(`${wf.name} has no step ${index}`);
  const earlier = summaries.length
    ? `Earlier steps of this workflow, already done:\n${summaries
        .map((s) => `- ${s.name}: ${s.summary.trim() || "(no summary)"}`)
        .join("\n")}`
    : "";
  const retry = retryReason
    ? `This step is being run again. The last try was not accepted because: ${retryReason}. Address that.`
    : "";
  return {
    label: step.name,
    verb: `${wf.verb} · ${step.name}`,
    blurb: wf.blurb,
    notePlaceholder: wf.notePlaceholder,
    noteRequired: wf.noteRequired,
    allowedTools: step.tools,
    maxTurns: step.turns,
    progress: `${wf.verb}: ${step.name}`,
    // the flow judges the outcome over all its steps
    expectsChange: false,
    task: [earlier, retry, step.body].filter(Boolean).join("\n\n"),
    mode: "job",
  };
}

export class Flows {
  private live = new Map<string, LiveFlow>();
  /** run id to flow id, for onRun */
  private byRun = new Map<string, string>();

  constructor(
    private runner: FlowRunner,
    private hooks: FlowHooks,
  ) {}

  list(): Flow[] {
    return [...this.live.values()].map((l) => l.flow);
  }

  get(id: string): Flow | undefined {
    return this.live.get(id)?.flow;
  }

  activeFor(repoId: string): Flow | undefined {
    for (const l of this.live.values()) {
      if (l.flow.repoId === repoId && isFlowActive(l.flow)) return l.flow;
    }
    return undefined;
  }

  start(repo: Repo, workflow: Workflow, note: string, agent: AgentSettings, fleetId?: string): Flow {
    const busyFlow = this.activeFor(repo.id);
    if (busyFlow) throw new Error(`${repo.name} already has ${busyFlow.verb} going`);
    const busyRun = this.runner.activeFor(repo.id);
    if (busyRun) throw new Error(`${repo.name} already has a ${busyRun.verb} run going`);
    if (workflow.noteRequired && !note.trim()) throw new Error("write what Claude should do first");
    const flow: Flow = {
      id: crypto.randomUUID().slice(0, 8),
      repoId: repo.id,
      workflow: workflow.name,
      verb: workflow.verb,
      ...(fleetId ? { fleetId } : {}),
      note: note.trim(),
      status: "working",
      steps: workflow.steps.map((s) => ({ name: s.name, status: "pending" })),
      current: 0,
      startedAt: Date.now(),
    };
    const live: LiveFlow = {
      flow,
      repo,
      workflow,
      agent,
      before: statusFingerprint(repo.status),
      stopping: false,
    };
    this.live.set(flow.id, live);
    this.prune();
    void this.runStep(live);
    return flow;
  }

  /** The Runner's every change comes here; a step's run ending moves the flow. */
  onRun(run: Run): void {
    const id = this.byRun.get(run.id);
    const live = id ? this.live.get(id) : undefined;
    if (!live) return;
    const step = live.flow.steps[live.flow.current];
    if (!step || step.runId !== run.id) return;
    if (run.status === "working" || run.status === "waiting" || run.status === "idle") {
      const status = run.status === "waiting" ? "waiting" : "working";
      if (live.flow.status !== status) {
        live.flow.status = status;
        this.emit(live);
      }
      return;
    }
    this.byRun.delete(run.id);
    if (run.status === "failed") {
      step.status = "failed";
      step.reason = run.error ?? "the run failed";
      this.end(live, "failed", step.reason);
      return;
    }
    if (run.status === "stopped") {
      step.status = "failed";
      step.reason = "stopped";
      this.end(live, "stopped");
      return;
    }
    step.summary = summaryOf(run);
    void this.afterRun(live);
  }

  resume(id: string, choice: FlowChoice): Flow {
    const live = this.live.get(id);
    if (!live) throw new Error(`unknown flow: ${id}`);
    if (live.flow.status !== "gated") throw new Error("the flow is not waiting at a gate");
    const step = live.flow.steps[live.flow.current];
    if (!step) throw new Error("no current step");
    if (choice === "stop") {
      step.status = "failed";
      step.reason = "stopped at the gate";
      this.end(live, "stopped");
      return live.flow;
    }
    if (choice === "retry") {
      live.retry = step.reason;
      if (step.runId) {
        try {
          this.runner.dismiss(step.runId);
        } catch {
          // an active run cannot be dismissed; it is not, or we would not be gated
        }
      }
      delete step.runId;
      delete step.check;
      delete step.verdict;
      delete step.summary;
      delete step.reason;
      void this.runStep(live);
      return live.flow;
    }
    void this.pass(live);
    return live.flow;
  }

  stop(id: string): Flow {
    const live = this.live.get(id);
    if (!live) throw new Error(`unknown flow: ${id}`);
    if (!isFlowActive(live.flow)) return live.flow;
    if (live.flow.status === "gated") return this.resume(id, "stop");
    live.stopping = true;
    const step = live.flow.steps[live.flow.current];
    if (step?.runId) {
      // the run's stopped status comes back through onRun and ends the flow
      this.runner.stop(step.runId);
    } else {
      if (step) {
        step.status = "failed";
        step.reason = "stopped";
      }
      this.end(live, "stopped");
    }
    return live.flow;
  }

  dismiss(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    if (isFlowActive(live.flow)) throw new Error("stop the flow before dismissing it");
    for (const s of live.flow.steps) {
      if (s.runId) {
        try {
          this.runner.dismiss(s.runId);
        } catch {
          // already gone
        }
      }
    }
    this.live.delete(id);
    this.hooks.onGone(id);
  }

  stopAll(): void {
    for (const l of this.live.values()) {
      if (isFlowActive(l.flow)) this.stop(l.flow.id);
    }
  }

  private emit(live: LiveFlow): void {
    this.hooks.onChange(live.flow);
  }

  private prune(): void {
    const finished = [...this.live.values()]
      .filter((l) => !isFlowActive(l.flow))
      .sort((a, b) => (a.flow.endedAt ?? 0) - (b.flow.endedAt ?? 0));
    while (finished.length > KEEP_FINISHED) {
      const oldest = finished.shift();
      if (!oldest) break;
      this.live.delete(oldest.flow.id);
      this.hooks.onGone(oldest.flow.id);
    }
  }

  private summaries(live: LiveFlow): { name: string; summary: string }[] {
    return live.flow.steps
      .slice(0, live.flow.current)
      .filter((s) => s.status === "passed")
      .map((s) => ({ name: s.name, summary: s.summary ?? "" }));
  }

  private async runStep(live: LiveFlow): Promise<void> {
    const { flow, workflow } = live;
    const def = workflow.steps[flow.current];
    const step = flow.steps[flow.current];
    if (!def || !step) return;
    if (!def.body) {
      // check-only: no Claude, straight to the command
      flow.status = "working";
      await this.check(live);
      return;
    }
    const spec = stepSpec(workflow, flow.current, this.summaries(live), live.retry);
    delete live.retry;
    let run: Run;
    try {
      run = this.runner.start(live.repo, workflow.name, spec, flow.note, live.agent);
    } catch (err) {
      step.status = "failed";
      step.reason = String(err instanceof Error ? err.message : err);
      this.end(live, "failed", step.reason);
      return;
    }
    step.status = "running";
    step.runId = run.id;
    flow.status = "working";
    this.byRun.set(run.id, flow.id);
    this.emit(live);
  }

  private async afterRun(live: LiveFlow): Promise<void> {
    const def = live.workflow.steps[live.flow.current];
    if (def?.check) await this.check(live);
    else await this.gate(live);
  }

  /** Runs the step's command; a non-zero exit ends the flow. */
  private async check(live: LiveFlow): Promise<void> {
    const def = live.workflow.steps[live.flow.current];
    const step = live.flow.steps[live.flow.current];
    if (!def?.check || !step) return;
    step.status = "checking";
    this.emit(live);
    const r = await this.hooks.check(live.repo, def.check);
    if (!isFlowActive(live.flow)) return;
    step.check = { command: def.check, exit: r.exit, output: r.output };
    if (r.exit !== 0) {
      step.status = "failed";
      step.reason = `check failed with exit ${r.exit}`;
      this.end(live, "failed", step.reason);
      return;
    }
    await this.gate(live);
  }

  private async gate(live: LiveFlow): Promise<void> {
    const def = live.workflow.steps[live.flow.current];
    const step = live.flow.steps[live.flow.current];
    if (!def || !step) return;
    switch (def.gate) {
      case "continue":
        await this.pass(live);
        return;
      case "ask":
        this.park(live, "this step asks before the next one starts");
        return;
      case "verdict": {
        if (!this.hooks.evaluator) {
          this.park(live, "no gateway key, so the verdict is yours");
          return;
        }
        let changed: boolean | null = null;
        if (this.hooks.status) {
          try {
            const st = await this.hooks.status(live.flow.repoId);
            changed = st ? statusFingerprint(st) !== live.before : null;
          } catch {
            changed = null;
          }
        }
        try {
          const answers = await this.hooks.evaluator(
            verdictState({ summary: step.summary ?? "", check: step.check?.output ?? null, changed }),
          );
          if (!isFlowActive(live.flow)) return;
          const v = decide(answers);
          step.verdict = v;
          if (v.go) await this.pass(live);
          else this.park(live, v.reason ?? "the verdict said no");
        } catch (err) {
          if (!isFlowActive(live.flow)) return;
          this.park(live, `verdict unavailable: ${String(err instanceof Error ? err.message : err)}`);
        }
        return;
      }
    }
  }

  private park(live: LiveFlow, reason: string): void {
    const step = live.flow.steps[live.flow.current];
    if (!step) return;
    step.status = "gated";
    step.reason = reason;
    live.flow.status = "gated";
    this.emit(live);
  }

  private async pass(live: LiveFlow): Promise<void> {
    const step = live.flow.steps[live.flow.current];
    if (!step) return;
    step.status = "passed";
    delete step.reason;
    if (live.flow.current + 1 >= live.flow.steps.length) {
      this.end(live, "done");
      return;
    }
    live.flow.current += 1;
    this.emit(live);
    await this.runStep(live);
  }

  private end(live: LiveFlow, status: "done" | "failed" | "stopped", error?: string): void {
    if (!isFlowActive(live.flow)) return;
    live.flow.status = status;
    live.flow.endedAt = Date.now();
    if (error) live.flow.error = error;
    for (const s of live.flow.steps) if (s.status === "pending") s.status = "skipped";
    this.emit(live);
    this.onFlowEnd(live.flow);
    void this.settle(live);
  }

  /** Task 6 fills this in: a fleet's flow ending starts the next repo. */
  protected onFlowEnd(_flow: Flow): void {}

  private async settle(live: LiveFlow): Promise<void> {
    if (!live.workflow.expectsChange || !this.hooks.status) return;
    let after: string | null = null;
    try {
      const st = await this.hooks.status(live.flow.repoId);
      after = st ? statusFingerprint(st) : null;
    } catch {
      after = null;
    }
    if (after === null || isFlowActive(live.flow)) return;
    live.flow.outcome = after === live.before ? "unchanged" : "changed";
    this.emit(live);
  }
}

/** Unused until task 6, exported so the type exists for the hooks. */
export const _isRunActive = isRunActive;
```

Remove the `_isRunActive` export and the `isRunActive` import once task 6 is in place if it is still unused; oxlint flags unused imports. `Fleet` is imported for the hooks type and is added to `types.ts` in task 6; for this task, add a placeholder there now:

```ts
/** filled in by the fleet task */
export interface Fleet {
  id: string;
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/flow.test.ts`
Expected: PASS.

- [ ] **Step 6: Gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`

```bash
git add src/core/types.ts src/core/flow.ts src/core/flow.test.ts
git commit -m "feat: flows, a workflow run step by step with a check and a gate between steps

Claude-Session: https://claude.ai/code/session_01ATKaeCck4C4DhgUzeey9Zw"
```

---

### Task 6: fleets

**Files:**
- Modify: `src/core/types.ts` (`Fleet`, two events)
- Modify: `src/core/flow.ts`
- Test: `src/core/flow.test.ts`

**Interfaces:**
- Consumes: `Flows`, `checkWhen`.
- Produces: `Flows.startFleet(repos: Repo[], workflow: Workflow, note: string, agentFor: (repo: Repo) => AgentSettings): Fleet`, `fleets()`, `getFleet(id)`, `stopFleet(id)`, `dismissFleet(id)`, `FLEET_CONCURRENCY`, `fleetSkipReason(repo, workflow): string | null`.

- [ ] **Step 1: The type**

Replace the placeholder `Fleet` in `src/core/types.ts`:

```ts
/* ---------- fleets: one workflow over many repos ---------- */

export interface FleetRepo {
  repoId: string;
  /** the flow, once started */
  flowId?: string;
  /** why this repo was passed over, when it was */
  skipped?: string;
}

export interface Fleet {
  id: string;
  workflow: string;
  verb: string;
  note: string;
  repos: FleetRepo[];
  status: "working" | "done" | "stopped";
  startedAt: number;
  endedAt?: number;
}
```

Extend `ServerEvent` with `| { type: "fleet"; fleet: Fleet } | { type: "fleet-gone"; id: string }`.

- [ ] **Step 2: Write the failing tests**

Append to `src/core/flow.test.ts` (the `setup` helper gains `fleets: Fleet[]` collected from `onFleet`, and `fleetGone: string[]`):

```ts
describe("fleets", () => {
  const dirty = (id: string): Repo => ({
    ...repo(),
    id,
    name: id,
    path: `/tmp/${id}`,
    status: { branch: "main", upstream: "o/main", ahead: 0, behind: 0, files: [{ path: "a", index: "M", worktree: " ", untracked: false }], lastCommit: null } as unknown as Repo["status"],
  });
  const DIRTY_WF = wf(`---\nblurb: b\nwhen: dirty\n---\n\n## Do\n\nx\n`);

  test("skips repos the precondition or the machine rules out, runs three at a time, and ends when all have", async () => {
    const { runner, flows, fleets } = setup();
    const repos = [dirty("a"), dirty("b"), dirty("c"), dirty("d"), { ...repo(), id: "clean", name: "clean" }, { ...dirty("far"), host: "box" }, { ...dirty("forge"), forge: "x" } as unknown as Repo, { ...dirty("bad"), error: "nope" }];
    const fleet = flows.startFleet(repos, DIRTY_WF, "n", () => DEFAULT_AGENT);
    expect(fleet.repos.map((r) => r.skipped ?? "run")).toEqual(["run", "run", "run", "run", "nothing to commit", "Claude runs only work on this machine", "a forge repo has no checkout", "not a readable repo"]);
    expect(runner.specs.length).toBe(3);
    expect(flows.list().filter((f) => f.fleetId === fleet.id).length).toBe(3);
    runner.end("run1", "done", "ok");
    await flush();
    expect(runner.specs.length).toBe(4);
    runner.end("run2", "done", "ok");
    runner.end("run3", "done", "ok");
    runner.end("run4", "done", "ok");
    await flush();
    const f = flows.getFleet(fleet.id);
    expect(f?.status).toBe("done");
    expect(f?.repos.filter((r) => r.flowId).length).toBe(4);
    expect(fleets.at(-1)?.status).toBe("done");
  });

  test("a parked flow holds its slot", async () => {
    const ASK = wf(`---\nblurb: b\n---\n\n## Do\ngate: ask\n\nx\n`);
    const { runner, flows } = setup();
    flows.startFleet([dirty("a"), dirty("b"), dirty("c"), dirty("d")], ASK, "", () => DEFAULT_AGENT);
    runner.end("run1", "done", "ok");
    await flush();
    expect(runner.specs.length).toBe(3);
    const parked = flows.list().find((f) => f.status === "gated");
    if (!parked) throw new Error("nothing parked");
    flows.resume(parked.id, "continue");
    await flush();
    expect(runner.specs.length).toBe(4);
  });

  test("stop ends the running flows and drops the pending ones", async () => {
    const { runner, flows, fleetGone } = setup();
    const fleet = flows.startFleet([dirty("a"), dirty("b"), dirty("c"), dirty("d")], DIRTY_WF, "", () => DEFAULT_AGENT);
    flows.stopFleet(fleet.id);
    await flush();
    expect(runner.stopped.sort()).toEqual(["run1", "run2", "run3"]);
    const f = flows.getFleet(fleet.id);
    expect(f?.status).toBe("stopped");
    expect(f?.repos[3]?.skipped).toBe("stopped before it started");
    flows.dismissFleet(fleet.id);
    expect(fleetGone).toEqual([fleet.id]);
  });

  test("a repo that is busy when its turn comes is skipped, not failed", async () => {
    const { runner, flows } = setup();
    flows.start(dirty("a"), TWO, "", DEFAULT_AGENT);
    const fleet = flows.startFleet([dirty("a"), dirty("b")], DIRTY_WF, "", () => DEFAULT_AGENT);
    expect(flows.getFleet(fleet.id)?.repos[0]?.skipped).toContain("already has");
    expect(runner.specs.length).toBe(2);
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `bun test src/core/flow.test.ts`
Expected: FAIL, `startFleet` is not a function.

- [ ] **Step 4: Add fleets to flow.ts**

Add at the top: `import { checkWhen, type ActionSpec } from "./actions";` (replacing the type-only import) and `export const FLEET_CONCURRENCY = 3;`. Remove the `_isRunActive` export and the `isRunActive` import.

Add the skip reason, exported for the UI's pre-flight:

```ts
/** Why a fleet passes a repo over, or null when it may run. */
export function fleetSkipReason(repo: Repo, workflow: Workflow): string | null {
  if (repo.forge) return "a forge repo has no checkout";
  if (repo.error) return "not a readable repo";
  if (repo.host) return "Claude runs only work on this machine";
  const c = checkWhen(repo, workflow.when);
  return c.ok ? null : c.why;
}
```

Check the `Repo` type for the forge field's exact name (`grep -n "forge" src/core/types.ts`) and use it. Inside `Flows` add:

```ts
  private fleetsLive = new Map<string, { fleet: Fleet; workflow: Workflow; note: string; pending: Repo[]; agentFor: (repo: Repo) => AgentSettings }>();

  fleets(): Fleet[] {
    return [...this.fleetsLive.values()].map((f) => f.fleet);
  }

  getFleet(id: string): Fleet | undefined {
    return this.fleetsLive.get(id)?.fleet;
  }

  startFleet(repos: Repo[], workflow: Workflow, note: string, agentFor: (repo: Repo) => AgentSettings): Fleet {
    const fleet: Fleet = {
      id: crypto.randomUUID().slice(0, 8),
      workflow: workflow.name,
      verb: workflow.verb,
      note: note.trim(),
      repos: repos.map((r) => {
        const skipped = fleetSkipReason(r, workflow);
        return skipped ? { repoId: r.id, skipped } : { repoId: r.id };
      }),
      status: "working",
      startedAt: Date.now(),
    };
    const pending = repos.filter((r) => !fleetSkipReason(r, workflow));
    this.fleetsLive.set(fleet.id, { fleet, workflow, note, pending, agentFor });
    this.pump(fleet.id);
    return fleet;
  }

  stopFleet(id: string): Fleet {
    const lf = this.fleetsLive.get(id);
    if (!lf) throw new Error(`unknown fleet: ${id}`);
    if (lf.fleet.status !== "working") return lf.fleet;
    for (const r of lf.pending) {
      const entry = lf.fleet.repos.find((x) => x.repoId === r.id);
      if (entry) entry.skipped = "stopped before it started";
    }
    lf.pending = [];
    // Marked stopped before the flows end, or the last flow's end would
    // pump the fleet and finish it as done.
    lf.fleet.status = "stopped";
    lf.fleet.endedAt = Date.now();
    for (const l of this.live.values()) {
      if (l.flow.fleetId === id && isFlowActive(l.flow)) this.stop(l.flow.id);
    }
    this.hooks.onFleet(lf.fleet);
    return lf.fleet;
  }

  dismissFleet(id: string): void {
    const lf = this.fleetsLive.get(id);
    if (!lf) return;
    if (lf.fleet.status === "working") throw new Error("stop the fleet before dismissing it");
    for (const r of lf.fleet.repos) {
      if (r.flowId && this.live.has(r.flowId)) {
        try {
          this.dismiss(r.flowId);
        } catch {
          // a flow still active stays; it can be dismissed on its own later
        }
      }
    }
    this.fleetsLive.delete(id);
    this.hooks.onFleetGone(id);
  }

  private running(fleetId: string): number {
    let n = 0;
    for (const l of this.live.values()) if (l.flow.fleetId === fleetId && isFlowActive(l.flow)) n += 1;
    return n;
  }

  /** Starts pending repos up to the cap; ends the fleet when nothing is left. */
  private pump(fleetId: string): void {
    const lf = this.fleetsLive.get(fleetId);
    if (!lf || lf.fleet.status !== "working") return;
    while (lf.pending.length && this.running(fleetId) < FLEET_CONCURRENCY) {
      const repo = lf.pending.shift();
      if (!repo) break;
      const entry = lf.fleet.repos.find((x) => x.repoId === repo.id);
      try {
        const flow = this.start(repo, lf.workflow, lf.note, lf.agentFor(repo), fleetId);
        if (entry) entry.flowId = flow.id;
      } catch (err) {
        if (entry) entry.skipped = String(err instanceof Error ? err.message : err);
      }
    }
    if (!lf.pending.length && this.running(fleetId) === 0) {
      this.finishFleet(lf, "done");
      return;
    }
    this.hooks.onFleet(lf.fleet);
  }

  private finishFleet(lf: { fleet: Fleet }, status: "done" | "stopped"): void {
    if (lf.fleet.status !== "working") return;
    lf.fleet.status = status;
    lf.fleet.endedAt = Date.now();
    this.hooks.onFleet(lf.fleet);
  }

  protected onFlowEnd(flow: Flow): void {
    if (flow.fleetId) this.pump(flow.fleetId);
  }
```

Delete the empty `onFlowEnd` stub from task 5. `stopAll()` also stops every working fleet first, so pending repos do not start while the server shuts down:

```ts
  stopAll(): void {
    for (const f of this.fleetsLive.values()) if (f.fleet.status === "working") this.stopFleet(f.fleet.id);
    for (const l of this.live.values()) if (isFlowActive(l.flow)) this.stop(l.flow.id);
  }
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/flow.test.ts`
Expected: PASS.

- [ ] **Step 6: Gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`

```bash
git add src/core/types.ts src/core/flow.ts src/core/flow.test.ts
git commit -m "feat: fleets, one workflow over many repos, three at a time

Claude-Session: https://claude.ai/code/session_01ATKaeCck4C4DhgUzeey9Zw"
```

---

### Task 7: the server, routes and events

**Files:**
- Modify: `src/server/index.ts` (state, hooks, routes, shutdown)

**Interfaces:**
- Consumes: `Flows`, `FLEET_CONCURRENCY`, `loadWorkflows`, `findWorkflow`, `jev`, `hasGatewayKey`, `exec`, `onHost`, `parseLocator`, `shellQuote` (check the name in `src/core/host.ts` with `grep -n "export function" src/core/host.ts`; it is the single-quoting helper `remoteCommand` uses).
- Produces: routes `GET /api/verdict` (`{ready}`, whether a gateway key is set), `GET /api/repos/workflows?id=`, `POST /api/repos/flow?id=`, `GET /api/flows`, `POST /api/flows/resume`, `POST /api/flows/stop`, `DELETE /api/flows?id=`, `GET /api/fleets`, `POST /api/fleet`, `POST /api/fleet/stop`, `DELETE /api/fleet?id=`; events `flow`, `flow-gone`, `fleet`, `fleet-gone`.

There is no unit test for the server (it never had one); the check is the gates plus a curl walk at the end.

- [ ] **Step 1: State and hooks**

In `ServerState` add `flows: Flows;`. Where the `Runner` is constructed (line ~954), chain the flows into its `onChange`, and construct the flows after it. Because the state literal is built in one expression, build the runner first:

```ts
  const runner = new Runner({
    onChange: (run) => {
      broadcast(state, { type: "run", run });
      state.flows.onRun(run);
    },
    onGone: (id) => broadcast(state, { type: "run-gone", id }),
    status: (repoId) =>
      refreshAndBroadcast(state, repoId)
        .then((r) => r.status)
        .catch(() => null),
  });
  const flows = new Flows(runner, {
    onChange: (flow) => broadcast(state, { type: "flow", flow }),
    onGone: (id) => broadcast(state, { type: "flow-gone", id }),
    onFleet: (fleet) => broadcast(state, { type: "fleet", fleet }),
    onFleetGone: (id) => broadcast(state, { type: "fleet-gone", id }),
    check: runCheck,
    evaluator: hasGatewayKey() ? jev : null,
    status: (repoId) =>
      refreshAndBroadcast(state, repoId)
        .then((r) => r.status)
        .catch(() => null),
  });
```

and put `runner` and `flows` into the state literal. `state` is referenced inside the closures before it is assigned; that is how the runner's hooks already work, so keep the same shape (a `const state: ServerState = {...}` after the two constructions, closures reading `state` lazily).

Add the check runner near the top of the file, after `HttpError`:

```ts
/** stdout and stderr of a check, tail-capped for the sheet */
const CHECK_OUTPUT_CAP = 4000;
const CHECK_TIMEOUT = 10 * 60_000;

/** A step's check, in the repo, through a login shell so the user's PATH
 *  (bun, cargo) applies; over ssh for a remote repo. */
async function runCheck(repo: Repo, command: string): Promise<CheckResult> {
  const { host, path } = parseLocator(repo.path);
  const r =
    host === null
      ? await exec(["sh", "-lc", command], { cwd: path, timeoutMs: CHECK_TIMEOUT })
      : await onHost(host, ["sh", "-lc", `cd ${shellQuote(path)} && ${command}`], { timeoutMs: CHECK_TIMEOUT });
  const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
  return { exit: r.code, output: out.length > CHECK_OUTPUT_CAP ? `…${out.slice(-CHECK_OUTPUT_CAP)}` : out };
}
```

Import `Flows`, `type CheckResult` from `../core/flow`, `loadWorkflows`, `findWorkflow` from `../core/workflows`, `jev`, `hasGatewayKey` from `../core/jev`, `exec`, `onHost` from `../core/exec`, `parseLocator` and the quoting helper from `../core/host`, and the `Flow`/`Fleet` types if the file's `ServerEvent` import list is explicit.

- [ ] **Step 2: The routes**

Next to the `/api/runs` routes add:

```ts
  if (path === "/api/flows" && method === "GET") return json(state.flows.list());
  if (path === "/api/flows" && method === "DELETE") {
    try {
      state.flows.dismiss(url.searchParams.get("id") ?? "");
    } catch (err) {
      throw new HttpError(400, String(err instanceof Error ? err.message : err));
    }
    return json({ ok: true });
  }
  if (path === "/api/flows/resume" && method === "POST") {
    const b = (await req.json()) as { id?: unknown; choice?: unknown };
    if (typeof b.id !== "string" || !isFlowChoice(b.choice)) return json({ error: "missing flow id or choice" }, 400);
    try {
      return json(state.flows.resume(b.id, b.choice));
    } catch (err) {
      throw new HttpError(400, String(err instanceof Error ? err.message : err));
    }
  }
  if (path === "/api/flows/stop" && method === "POST") {
    const b = (await req.json()) as { id?: unknown };
    if (typeof b.id !== "string") return json({ error: "missing flow id" }, 400);
    try {
      return json(state.flows.stop(b.id));
    } catch (err) {
      throw new HttpError(400, String(err instanceof Error ? err.message : err));
    }
  }
  if (path === "/api/verdict" && method === "GET") return json({ ready: hasGatewayKey() });
  if (path === "/api/fleets" && method === "GET") return json(state.flows.fleets());
  if (path === "/api/fleet" && method === "POST") {
    const b = (await req.json()) as { workflow?: unknown; ids?: unknown; note?: unknown };
    if (typeof b.workflow !== "string" || !Array.isArray(b.ids) || !b.ids.every((x) => typeof x === "string")) {
      return json({ error: "missing workflow or ids" }, 400);
    }
    const ids = b.ids as string[];
    const repos = ids.map((id) => state.result.repos.find((r) => r.id === id)).filter((r): r is Repo => r !== undefined);
    if (!repos.length) return json({ error: "no known repos in ids" }, 400);
    // The fleet's workflow is resolved once, from the bundled and user
    // sources: a fleet runs the same file everywhere, so repo overrides
    // do not apply.
    const wf = findWorkflow(await loadWorkflows({ path: "", host: "none" }), b.workflow);
    if (!wf) return json({ error: `unknown workflow: ${b.workflow}` }, 400);
    const cfg = await loadConfig();
    const note = typeof b.note === "string" ? b.note : "";
    return json(state.flows.startFleet(repos, wf, note, (r) => agentFor(cfg, r.path)), 201);
  }
  if (path === "/api/fleet/stop" && method === "POST") {
    const b = (await req.json()) as { id?: unknown };
    if (typeof b.id !== "string") return json({ error: "missing fleet id" }, 400);
    try {
      return json(state.flows.stopFleet(b.id));
    } catch (err) {
      throw new HttpError(400, String(err instanceof Error ? err.message : err));
    }
  }
  if (path === "/api/fleet" && method === "DELETE") {
    try {
      state.flows.dismissFleet(url.searchParams.get("id") ?? "");
    } catch (err) {
      throw new HttpError(400, String(err instanceof Error ? err.message : err));
    }
    return json({ ok: true });
  }
```

with, next to `isRunAction`:

```ts
const isFlowChoice = (v: unknown): v is FlowChoice => v === "continue" || v === "retry" || v === "stop";
```

The `{ path: "", host: "none" }` trick makes `loadWorkflows` skip the repo source; `host` is truthy so the repo folder is never read.

Inside the per-repo block (where `action === "run"` lives) add:

```ts
    if (method === "GET" && action === "workflows") {
      if (repo.forge) return json([], 200);
      return json(await loadWorkflows(repo));
    }
    if (method === "POST" && action === "flow") {
      if (repo.forge) return json({ error: `${repo.name} is a forge repo with no checkout` }, 400);
      if (repo.host) return json({ error: `Claude runs only work on this machine; ${repo.name} is on ${repo.host}` }, 400);
      const b = (await req.json()) as { workflow?: unknown; note?: unknown };
      if (typeof b.workflow !== "string") return json({ error: "missing workflow" }, 400);
      const entries = await loadWorkflows(repo);
      const wf = findWorkflow(entries, b.workflow);
      if (!wf) {
        const broken = entries.find((e) => !e.ok && e.name === b.workflow);
        return json({ error: broken && !broken.ok ? broken.error : `unknown workflow: ${b.workflow}` }, 400);
      }
      const note = typeof b.note === "string" ? b.note : "";
      const agent = agentFor(await loadConfig(), repo.path);
      try {
        return json(state.flows.start(repo, wf, note, agent), 201);
      } catch (err) {
        throw new HttpError(400, String(err instanceof Error ? err.message : err));
      }
    }
```

Check how that block already answers 400 for a forge repo (the CLAUDE.md says every `/api/repos/*` route does); if the block guards before reaching the action switch, drop the duplicate forge check.

- [ ] **Step 3: Shutdown**

Where `state.runner.stopAll()` is called on stop (line ~1088), call `state.flows.stopAll()` first.

- [ ] **Step 4: Gates**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

- [ ] **Step 5: Walk the routes against a running server**

Start a dev server on a spare port against a small scratch folder holding one repo with an uncommitted file (a temp dir works: `git init`, touch a file), then, using curl or the browser:

```bash
curl -s "http://127.0.0.1:7850/api/repos/workflows?id=." | head -c 400
curl -s -X POST "http://127.0.0.1:7850/api/repos/flow?id=." -H 'content-type: application/json' -d '{"workflow":"review","note":""}'
curl -s "http://127.0.0.1:7850/api/flows"
```

Expected: the workflow list with five bundled entries; a 201 with a flow whose first step is `running`; the flow list moving to `done` once Claude finishes (or `waiting` if it asks). The memory notes say the context-mode hook refuses Bash HTTP calls in this session; if so, run the calls through `ctx_execute` or the browser instead.

- [ ] **Step 6: Commit**

```bash
git add src/server/index.ts
git commit -m "feat: flow and fleet routes and events, the check runner, workflows per repo

Claude-Session: https://claude.ai/code/session_01ATKaeCck4C4DhgUzeey9Zw"
```

---

### Task 8: the browser side, pure parts, api and store

**Files:**
- Create: `ui/src/flows.ts`
- Test: `ui/src/flows.test.ts`
- Modify: `ui/src/api.ts`, `ui/src/store.ts`

**Interfaces:**
- Consumes: the routes of task 7 and the types of tasks 2, 5, 6.
- Produces: pure `flowWord(flow, long)`, `stepWord(step)`, `fleetCounts(fleet, flows)`, `oldestParked(fleet, flows)`, `selectable(repos)`; store fields `flows`, `fleets`, `workflows`, `flowRuns`, `selecting`, `selected`; store actions `loadWorkflows`, `planFlow`, `startFlow`, `resumeFlow`, `stopFlow`, `dismissFlow`, `showFlow`, `setSelecting`, `toggleSelected`, `planFleet`, `startFleet`, `stopFleet`, `dismissFleet`, `showFleet`; selectors `flowFor`, `activeFlowFor`; new `Sheet` kinds `flow-plan`, `flow`, `fleet-plan`, `fleet`.

- [ ] **Step 1: Write the failing tests**

`ui/src/flows.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { fleetCounts, flowWord, oldestParked, selectable, stepWord } from "./flows";
import type { Fleet, Flow, FlowStep, Repo } from "../../src/core/types";

const flow = (o: Partial<Flow> = {}): Flow => ({
  id: "f", repoId: "r", workflow: "ship", verb: "ship", note: "", status: "working",
  steps: [{ name: "Gates", status: "passed" }, { name: "Commit", status: "running" }, { name: "Push", status: "pending" }],
  current: 1, startedAt: 0, ...o,
});

describe("flowWord", () => {
  test("says the step while working, needs you when parked or waiting, and the end otherwise", () => {
    expect(flowWord(flow(), false)).toBe("ship: Commit…");
    expect(flowWord(flow(), true)).toBe("ship, step 2 of 3: Commit");
    expect(flowWord(flow({ status: "gated" }), false)).toBe("needs you");
    expect(flowWord(flow({ status: "waiting" }), true)).toBe("ship: claude needs you");
    expect(flowWord(flow({ status: "done" }), false)).toBe("done");
    expect(flowWord(flow({ status: "done", outcome: "unchanged" }), true)).toBe("ship: no change");
    expect(flowWord(flow({ status: "failed" }), true)).toBe("ship failed");
    expect(flowWord(flow({ status: "stopped" }), false)).toBe("stopped");
  });
});

describe("stepWord", () => {
  test.each<[FlowStep["status"], string]>([
    ["pending", "waiting its turn"], ["running", "claude is working"], ["checking", "running the check"],
    ["gated", "waiting for you"], ["passed", "passed"], ["failed", "failed"], ["skipped", "skipped"],
  ])("%s", (status, word) => {
    expect(stepWord({ name: "x", status })).toBe(word);
  });
});

describe("fleetCounts and oldestParked", () => {
  const fleet: Fleet = { id: "F", workflow: "ship", verb: "ship", note: "", status: "working", startedAt: 0,
    repos: [{ repoId: "a", flowId: "fa" }, { repoId: "b", flowId: "fb" }, { repoId: "c" }, { repoId: "d", skipped: "nothing to commit" }] };
  const flows: Record<string, Flow> = {
    fa: flow({ id: "fa", repoId: "a", status: "gated", startedAt: 5 }),
    fb: flow({ id: "fb", repoId: "b", status: "waiting", startedAt: 2 }),
  };
  test("counts by state", () => {
    expect(fleetCounts(fleet, flows)).toEqual({ pending: 1, active: 2, needsYou: 2, done: 0, failed: 0, skipped: 1 });
  });
  test("the oldest parked flow comes first", () => {
    expect(oldestParked(fleet, flows)?.id).toBe("fb");
    expect(oldestParked({ ...fleet, repos: [] }, flows)).toBeUndefined();
  });
});

describe("selectable", () => {
  test("drops forge, unreadable and remote repos", () => {
    const base = { name: "x", path: "/x", group: "", source: "s", status: null } as Omit<Repo, "id">;
    const repos: Repo[] = [
      { ...base, id: "ok" },
      { ...base, id: "far", host: "box" },
      { ...base, id: "bad", error: "nope" },
      { ...base, id: "forge", forge: { kind: "forgejo", full: "o/n" } } as unknown as Repo,
    ];
    expect(selectable(repos).map((r) => r.id)).toEqual(["ok"]);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test ui/src/flows.test.ts`
Expected: FAIL, cannot resolve `./flows`.

- [ ] **Step 3: Write flows.ts**

```ts
/** Words and arithmetic for flows and fleets in the UI. Pure. */

import { isFlowActive, type Fleet, type Flow, type FlowStep, type Repo } from "../../src/core/types";

export const STEP_WORD: Record<FlowStep["status"], string> = {
  pending: "waiting its turn",
  running: "claude is working",
  checking: "running the check",
  gated: "waiting for you",
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
};

export const stepWord = (step: FlowStep): string => STEP_WORD[step.status];

/** The chip's word for a flow, short on a card and long in a panel. */
export function flowWord(flow: Flow, long: boolean): string {
  const step = flow.steps[flow.current];
  const name = step?.name ?? "";
  switch (flow.status) {
    case "working":
      return long ? `${flow.verb}, step ${flow.current + 1} of ${flow.steps.length}: ${name}` : `${flow.verb}: ${name}…`;
    case "waiting":
      return long ? `${flow.verb}: claude needs you` : "needs you";
    case "gated":
      return long ? `${flow.verb}: ${name} is waiting for you` : "needs you";
    case "done":
      if (flow.outcome === "unchanged") return long ? `${flow.verb}: no change` : "no change";
      return long ? `${flow.verb} done` : "done";
    case "failed":
      return long ? `${flow.verb} failed` : "failed";
    case "stopped":
      return long ? `${flow.verb} stopped` : "stopped";
  }
}

export interface FleetCounts {
  pending: number;
  active: number;
  needsYou: number;
  done: number;
  failed: number;
  skipped: number;
}

export function fleetCounts(fleet: Fleet, flows: Record<string, Flow>): FleetCounts {
  const c: FleetCounts = { pending: 0, active: 0, needsYou: 0, done: 0, failed: 0, skipped: 0 };
  for (const r of fleet.repos) {
    if (r.skipped) c.skipped += 1;
    else if (!r.flowId) c.pending += 1;
    else {
      const f = flows[r.flowId];
      if (!f) c.pending += 1;
      else if (isFlowActive(f)) {
        c.active += 1;
        if (f.status === "gated" || f.status === "waiting") c.needsYou += 1;
      } else if (f.status === "done") c.done += 1;
      else c.failed += 1;
    }
  }
  return c;
}

/** The parked or waiting flow that has been so the longest, by start time. */
export function oldestParked(fleet: Fleet, flows: Record<string, Flow>): Flow | undefined {
  let best: Flow | undefined;
  for (const r of fleet.repos) {
    const f = r.flowId ? flows[r.flowId] : undefined;
    if (!f || (f.status !== "gated" && f.status !== "waiting")) continue;
    if (!best || f.startedAt < best.startedAt) best = f;
  }
  return best;
}

/** The repos a fleet may be pointed at from this browser. */
export const selectable = (repos: Repo[]): Repo[] => repos.filter((r) => !r.forge && !r.error && !r.host);
```

- [ ] **Step 4: Run the tests**

Run: `bun test ui/src/flows.test.ts`
Expected: PASS.

- [ ] **Step 5: The api client**

Add to `ui/src/api.ts`'s `api` object (imports for `Fleet`, `Flow`, `FlowChoice`, `WorkflowEntry` from the types file):

```ts
  workflows: (id: string) => req<WorkflowEntry[]>(`/api/repos/workflows?${rq(id)}`),
  startFlow: (id: string, workflow: string, note: string) =>
    req<Flow>(`/api/repos/flow?${rq(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow, note }),
    }),
  flows: () => req<Flow[]>("/api/flows"),
  resumeFlow: (id: string, choice: FlowChoice) =>
    req<Flow>("/api/flows/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, choice }),
    }),
  stopFlow: (id: string) =>
    req<Flow>("/api/flows/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }),
  dismissFlow: (id: string) => req<{ ok: true }>(`/api/flows?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  verdict: () => req<{ ready: boolean }>("/api/verdict"),
  fleets: () => req<Fleet[]>("/api/fleets"),
  startFleet: (workflow: string, ids: string[], note: string) =>
    req<Fleet>("/api/fleet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow, ids, note }),
    }),
  stopFleet: (id: string) =>
    req<Fleet>("/api/fleet/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }),
  dismissFleet: (id: string) => req<{ ok: true }>(`/api/fleet?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
```

Match the header and body style the existing `run`/`answerRun` entries use; `rq` is the existing id-encoding helper in that file.

- [ ] **Step 6: The store**

In `ui/src/store.ts`:

State fields (in `CanopyState` and the initial object):

```ts
  flows: Record<string, Flow>;
  fleets: Record<string, Fleet>;
  /** workflows the menu last fetched, by repo id */
  workflows: Record<string, WorkflowEntry[]>;
  /** run id to flow id, for every run a flow owns; those runs stay off the cards */
  flowRuns: Record<string, string>;
  /** select mode on the board */
  selecting: boolean;
  selected: string[];
  /** whether the server has a gateway key, so verdict gates can judge */
  verdictReady: boolean;
```

initial: `flows: {}, fleets: {}, workflows: {}, flowRuns: {}, selecting: false, selected: [], verdictReady: false`. The initial load also calls `api.verdict()` and sets `verdictReady` from its `ready`.

`Sheet` gains:

```ts
  | { kind: "flow-plan"; repoId: string; workflow: string }
  | { kind: "flow"; flowId: string }
  | { kind: "fleet-plan"; workflow: string }
  | { kind: "fleet"; fleetId: string }
```

Actions (declared in the state interface and implemented):

```ts
  loadWorkflows: async (repoId) => {
    const list = await api.workflows(repoId);
    set((s) => ({ workflows: { ...s.workflows, [repoId]: list } }));
  },
  planFlow: (repoId, workflow) => {
    const active = activeFlowFor(get(), repoId) ?? undefined;
    if (active) {
      set({ sheet: { kind: "flow", flowId: active.id } });
      return;
    }
    const run = activeRunFor(get(), repoId);
    set({ sheet: run ? { kind: "run", runId: run.id } : { kind: "flow-plan", repoId, workflow } });
  },
  startFlow: async (repoId, workflow, note) => {
    const flow = await api.startFlow(repoId, workflow, note);
    set((s) => ({ flows: { ...s.flows, [flow.id]: flow }, sheet: { kind: "flow", flowId: flow.id } }));
  },
  resumeFlow: async (flowId, choice) => {
    const flow = await api.resumeFlow(flowId, choice);
    set((s) => ({ flows: { ...s.flows, [flow.id]: flow } }));
  },
  stopFlow: async (flowId) => {
    const flow = await api.stopFlow(flowId);
    set((s) => ({ flows: { ...s.flows, [flow.id]: flow } }));
  },
  dismissFlow: async (flowId) => {
    await api.dismissFlow(flowId);
    set((s) => {
      const { [flowId]: _gone, ...flows } = s.flows;
      const sheet = s.sheet?.kind === "flow" && s.sheet.flowId === flowId ? null : s.sheet;
      return { flows, sheet };
    });
  },
  showFlow: (flowId) => set({ sheet: { kind: "flow", flowId } }),
  setSelecting: (on) =>
    set((s) => ({ selecting: on, selected: on ? selectable(visibleRepos(s)).map((r) => r.id) : [] })),
  toggleSelected: (repoId) =>
    set((s) => ({
      selected: s.selected.includes(repoId) ? s.selected.filter((x) => x !== repoId) : [...s.selected, repoId],
    })),
  planFleet: (workflow) => set({ sheet: { kind: "fleet-plan", workflow } }),
  startFleet: async (workflow, note) => {
    const fleet = await api.startFleet(workflow, get().selected, note);
    set((s) => ({ fleets: { ...s.fleets, [fleet.id]: fleet }, sheet: { kind: "fleet", fleetId: fleet.id }, selecting: false, selected: [] }));
  },
  stopFleet: async (fleetId) => {
    const fleet = await api.stopFleet(fleetId);
    set((s) => ({ fleets: { ...s.fleets, [fleet.id]: fleet } }));
  },
  dismissFleet: async (fleetId) => {
    await api.dismissFleet(fleetId);
    set((s) => {
      const { [fleetId]: _gone, ...fleets } = s.fleets;
      const sheet = s.sheet?.kind === "fleet" && s.sheet.fleetId === fleetId ? null : s.sheet;
      return { fleets, sheet };
    });
  },
  showFleet: (fleetId) => set({ sheet: { kind: "fleet", fleetId } }),
```

Signatures in the interface: `loadWorkflows(repoId: string): Promise<void>`, `planFlow(repoId: string, workflow: string): void`, `startFlow(repoId: string, workflow: string, note: string): Promise<void>`, `resumeFlow(flowId: string, choice: FlowChoice): Promise<void>`, `stopFlow(flowId: string): Promise<void>`, `dismissFlow(flowId: string): Promise<void>`, `showFlow(flowId: string): void`, `setSelecting(on: boolean): void`, `toggleSelected(repoId: string): void`, `planFleet(workflow: string): void`, `startFleet(workflow: string, note: string): Promise<void>`, `stopFleet(fleetId: string): Promise<void>`, `dismissFleet(fleetId: string): Promise<void>`, `showFleet(fleetId: string): void`.

Events, in the `subscribe` handler next to `run` and `run-gone`:

```ts
    } else if (ev.type === "flow") {
      set((s) => {
        const flowRuns = { ...s.flowRuns };
        for (const st of ev.flow.steps) if (st.runId) flowRuns[st.runId] = ev.flow.id;
        return { flows: { ...s.flows, [ev.flow.id]: ev.flow }, flowRuns };
      });
    } else if (ev.type === "flow-gone") {
      set((s) => {
        const { [ev.id]: _gone, ...flows } = s.flows;
        const flowRuns = Object.fromEntries(Object.entries(s.flowRuns).filter(([, f]) => f !== ev.id));
        const sheet = s.sheet?.kind === "flow" && s.sheet.flowId === ev.id ? null : s.sheet;
        return { flows, flowRuns, sheet };
      });
    } else if (ev.type === "fleet") {
      set((s) => ({ fleets: { ...s.fleets, [ev.fleet.id]: ev.fleet } }));
    } else if (ev.type === "fleet-gone") {
      set((s) => {
        const { [ev.id]: _gone, ...fleets } = s.fleets;
        const sheet = s.sheet?.kind === "fleet" && s.sheet.fleetId === ev.id ? null : s.sheet;
        return { fleets, sheet };
      });
    }
```

Initial load and `rescan`: fetch `api.flows()` and `api.fleets()` beside `api.runs()`, and set `flows`, `fleets`, and `flowRuns` built the same way as in the `flow` event (a small helper `flowRunsOf(flows: Flow[]): Record<string, string>` at module level, used in both places).

Selectors, next to `runFor`:

```ts
/** A repo's newest flow, active first. */
export function flowFor(s: CanopyState, repoId: string): Flow | undefined {
  let best: Flow | undefined;
  for (const f of Object.values(s.flows)) {
    if (f.repoId !== repoId) continue;
    if (!best || (isFlowActive(f) && !isFlowActive(best)) || (isFlowActive(f) === isFlowActive(best) && f.startedAt > best.startedAt)) best = f;
  }
  return best;
}

export function activeFlowFor(s: CanopyState, repoId: string): Flow | undefined {
  const f = flowFor(s, repoId);
  return f && isFlowActive(f) ? f : undefined;
}
```

And change `runFor` to skip runs a flow owns: at the top of its loop, `if (s.flowRuns[r.id]) continue;`. `allRuns` (the runs pill) keeps them.

- [ ] **Step 7: Gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`

```bash
git add ui/src/flows.ts ui/src/flows.test.ts ui/src/api.ts ui/src/store.ts
git commit -m "feat: flows, fleets and workflows in the browser store, with the pure words beside them

Claude-Session: https://claude.ai/code/session_01ATKaeCck4C4DhgUzeey9Zw"
```

---

### Task 9: workflows in the menu, the flow plan, the flow chip, the flow sheet

**Files:**
- Modify: `ui/src/components/RepoMenu.tsx`
- Modify: `ui/src/components/RunChip.tsx`
- Modify: `ui/src/components/RepoGrid.tsx`, `ui/src/components/Dock.tsx` (wherever `RunChip` renders in the panel head; `grep -n RunChip ui/src`)
- Modify: `ui/src/components/RunSheet.tsx` (`Timeline` extracted, new sheet kinds dispatched)
- Create: `ui/src/components/FlowSheet.tsx`
- Modify: `ui/src/styles.css`

**Interfaces:**
- Consumes: store actions and selectors of task 8, `flowWord`, `stepWord`, `checkWhen`.
- Produces: `Timeline` exported from `RunSheet.tsx`; `FlowChip`; `FlowPlan`, `FlowConsole` exported from `FlowSheet.tsx`; CSS classes `.step-strip`, `.step-seg`, `.gate`, `.verdict-bars`.

No unit tests here beyond the gates: the pure parts were tested in task 8. The check is the browser walk in step 8.

- [ ] **Step 1: The menu lists workflows**

In `RepoMenu.tsx`:

- `const JOBS = ["ask"] as const;` replaces the `RUN_ACTIONS.filter(...)` line, so the built-in commit, push, commit-push and deploy no longer show (their workflow twins do). Drop `fact()`'s commit/push cases or the whole function if only `ask` remains (it returns "" for ask).
- Read `const workflows = useStore((s) => s.workflows[repo.id]);`, `const loadWorkflows = useStore((s) => s.loadWorkflows);`, `const planFlow = useStore((s) => s.planFlow);`, `const activeFlow = useStore((s) => activeFlowFor(s, repo.id));`, `const showFlow = useStore((s) => s.showFlow);`.
- In the effect that runs when `open` becomes true, add `if (open && !repo.host && !repo.forge) void loadWorkflows(repo.id);` (a fresh fetch on every open, so an edited file shows).
- Under the "with claude" label, before the chat item, when `activeFlow` render the same "live" item the active run has, with text `flowWord(activeFlow, true)` and `onClick` `showFlow(activeFlow.id)`. The existing `active` run item stays for ask and chat.
- After the chat item, render the workflow items:

```tsx
              {!repo.host && (workflows ?? []).map((e) => {
                if (!e.ok) {
                  return (
                    <button key={`wf-${e.name}`} type="button" role="menuitem" className="menu-item" aria-disabled title={e.error} tabIndex={-1}>
                      <span className="menu-text">{e.name}</span>
                      <span className="menu-fact">will not parse</span>
                    </button>
                  );
                }
                const w = e.workflow;
                const check = active || activeFlow ? { ok: false as const, why: "wait for the current run" } : checkWhen(repo, w.when);
                return (
                  <button
                    key={`wf-${w.name}`}
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    aria-disabled={!check.ok}
                    title={check.ok ? w.blurb : check.why}
                    tabIndex={check.ok ? 0 : -1}
                    onClick={() => {
                      if (!check.ok) return;
                      setOpen(false);
                      planFlow(repo.id, w.name);
                    }}
                  >
                    <span className="menu-text">{w.label}</span>
                    <span className="menu-fact">
                      {check.ok ? (w.steps.length === 1 ? "" : `${w.steps.length} steps`) : check.why}
                    </span>
                  </button>
                );
              })}
```

Import `checkWhen` from actions and `flowWord` from `../flows`, `activeFlowFor` from the store.

- [ ] **Step 2: The flow chip**

Add to `RunChip.tsx`:

```tsx
/** The flow's word on a card or in the panel. Same colours as a run's. */
export function FlowChip({ flow, long = false }: { flow: Flow; long?: boolean }) {
  const showFlow = useStore((s) => s.showFlow);
  const status = flow.status === "gated" ? "waiting" : flow.status;
  const noChange = flow.status === "done" && flow.outcome === "unchanged";
  return (
    <button
      type="button"
      className={`run-chip st-${status}${noChange ? " no-change" : ""}`}
      title="Show the workflow"
      onClick={(e) => {
        e.stopPropagation();
        showFlow(flow.id);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <span className="dot" />
      {flowWord(flow, long)}
    </button>
  );
}
```

In `RepoGrid.tsx`'s card: `const flow = useStore((s) => flowFor(s, repo.id));` and in `card-bot` render `{flow ? <FlowChip flow={flow} /> : run && <RunChip run={run} />}`; the `live` class computes from the flow when there is one (`flow.status === "working" || flow.status === "waiting" || flow.status === "gated"` maps to ` run-working` or ` run-waiting`). Do the same where the panel head renders `<RunChip run={run} long />`.

- [ ] **Step 3: Extract `Timeline` from `Console`**

In `RunSheet.tsx`, cut the `<div ref={list} className="sheet-body console" ...>` block out of `Console` into:

```tsx
/** The run's timeline: note, steps, the prompt to answer, the outcome. Used
 *  by the run console and by a flow's console for the current step. */
export function Timeline({
  run,
  repo,
  error,
  onAnswer,
}: {
  run: Run;
  repo: Repo | undefined;
  error: string | null;
  onAnswer: (a: RunAnswer) => void;
}) {
  const chat = run.chat;
  const active = isRunActive(run);
  const noChange = run.status === "done" && run.outcome === "unchanged" && run.expectsChange;
  const list = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useEffect(() => {
    const el = list.current;
    if (!el || !stuck.current) return;
    el.scrollTop = el.scrollHeight;
  }, [run.steps.length, run.prompt, run.status]);
  const last = run.steps[run.steps.length - 1];
  const steps =
    !chat && run.result && last?.kind === "text" && last.text === run.result.text
      ? run.steps.slice(0, -1)
      : run.steps;
  return (
    <div ref={list} className="sheet-body console" onScroll={(e) => { const el = e.currentTarget; stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
      {/* the existing body, verbatim, with answerRun(...) replaced by onAnswer(a) */}
    </div>
  );
}
```

`Console` then renders `<Timeline run={run} repo={repo} error={error} onAnswer={(a) => void act(() => answerRun(run.id, run.prompt?.id ?? "", a))} />` between its header and the composer, and loses the `list`, `stuck`, `last`, `steps` locals and the scroll effect. Behaviour is unchanged; check by opening a run after the build.

- [ ] **Step 4: Dispatch the new sheet kinds**

In `RunSheet.tsx`'s `Body`, before the final `Console` return:

```tsx
  if (sheet.kind === "flow-plan") {
    if (!repo) return <Missing what="That repo is no longer in the tree." onClose={close} />;
    return <FlowPlan repo={repo} workflow={sheet.workflow} />;
  }
  if (sheet.kind === "flow") return <FlowConsole flowId={sheet.flowId} />;
  if (sheet.kind === "fleet-plan") return <FleetPlan workflow={sheet.workflow} />;
  if (sheet.kind === "fleet") return <FleetSheet fleetId={sheet.fleetId} />;
```

and `sheetRepoId` returns `sheet.repoId` for `flow-plan`, `runs`-independent `undefined` for `flow`, `fleet-plan` and `fleet` (the flow console looks its repo up itself). `FleetPlan` and `FleetSheet` are task 10; for this task export two placeholders from `FlowSheet.tsx` that render `<Missing what="not yet" .../>`, replaced in task 10.

- [ ] **Step 5: `FlowSheet.tsx`, the plan and the console**

```tsx
import { useState } from "react";
import { describeAgent, isDefaultAgent } from "../../../src/core/agent";
import { repoFacts } from "../../../src/core/actions";
import { isFlowActive, type Flow, type FlowStep, type Repo, type Verdict } from "../../../src/core/types";
import { flowWord, stepWord } from "../flows";
import { agentFor, useStore } from "../store";
import { Timeline } from "./RunSheet";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ---------- pre-flight for one repo ---------- */

export function FlowPlan({ repo, workflow }: { repo: Repo; workflow: string }) {
  const close = useStore((s) => s.closeSheet);
  const startFlow = useStore((s) => s.startFlow);
  const agent = useStore((s) => agentFor(s, repo));
  const verdictReady = useStore((s) => s.verdictReady);
  const entry = useStore((s) => s.workflows[repo.id]?.find((e) => e.ok && e.workflow.name === workflow));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!entry || !entry.ok) {
    return (
      <>
        <p className="sheet-empty">That workflow is gone from the menu.</p>
        <footer className="sheet-foot"><span className="spacer" /><button type="button" className="mini" onClick={close}>close</button></footer>
      </>
    );
  }
  const w = entry.workflow;
  const ready = !busy && (!w.noteRequired || note.trim().length > 0);
  const go = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await startFlow(repo.id, w.name, note);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };
  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">with claude · {w.source === "bundled" ? "built in" : w.source === "user" ? "your workflow" : "this repo's workflow"}</div>
          <h2 className="sheet-title">{w.verb} <span className="sheet-repo">{repo.id}</span></h2>
        </div>
        <button type="button" className="mini close" onClick={close} aria-label="Close">✕</button>
      </header>
      <div className="sheet-body plan">
        <div className="facts">
          {repoFacts(repo).map((f) => <span key={f} className="branch">{f}</span>)}
          {!isDefaultAgent(agent) && <span className="branch" title="This repo's agent settings">{describeAgent(agent)}</span>}
        </div>
        <p className="blurb">{w.blurb}</p>
        <ol className="plan-steps">
          {w.steps.map((s) => (
            <li key={s.name}>
              <span className="plan-step-name">{s.name}</span>
              <span className="plan-step-meta">
                {s.body ? "" : "check only"}
                {s.check ? ` · check: ${s.check}` : ""}
                {s.gate !== "continue" ? ` · gate: ${s.gate}` : ""}
              </span>
            </li>
          ))}
        </ol>
        <textarea
          className="plan-note"
          rows={w.noteRequired ? 5 : 3}
          placeholder={w.notePlaceholder}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void go(); }}
          aria-label={w.noteRequired ? "What Claude should do" : "Note for Claude"}
        />
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">
          {w.steps.some((s) => s.gate === "verdict") && !verdictReady
            ? "No gateway key on the server, so verdict gates will ask you instead."
            : agent.yolo
              ? "Yolo is on for this repo: Claude runs without asking."
              : "Claude asks before running anything that is not part of the job."}
        </span>
        <button type="button" className="mini" onClick={close}>cancel</button>
        <button type="button" className="mini strong" disabled={!ready} title="⌘↩" onClick={() => void go()}>
          {busy ? "starting…" : w.verb}
        </button>
      </footer>
    </>
  );
}

/* ---------- the step strip ---------- */

export function StepStrip({ flow, shown, onPick }: { flow: Flow; shown: number; onPick: (i: number) => void }) {
  return (
    <ol className="step-strip" aria-label="Steps">
      {flow.steps.map((s, i) => (
        <li key={s.name}>
          <button
            type="button"
            className={`step-seg st-${s.status}${i === shown ? " shown" : ""}`}
            title={`${s.name}: ${stepWord(s)}`}
            aria-current={i === flow.current ? "step" : undefined}
            disabled={!s.runId && !s.check}
            onClick={() => onPick(i)}
          >
            <span className="dot" />
            {s.name}
          </button>
        </li>
      ))}
    </ol>
  );
}

/* ---------- the gate ---------- */

function VerdictBars({ verdict }: { verdict: Verdict }) {
  const rows: [string, number][] = [
    ["done", verdict.answers.outcome.probabilities?.["done"] ?? (verdict.answers.outcome.choice === "done" ? 1 : 0)],
    ["needs you", verdict.answers.needsYou.probability],
    ["off scope", verdict.answers.offScope.probability],
  ];
  return (
    <dl className="verdict-bars">
      {rows.map(([label, p]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd><span className="bar" style={{ width: `${Math.round(p * 100)}%` }} /><span className="pct">{Math.round(p * 100)}%</span></dd>
        </div>
      ))}
    </dl>
  );
}

function Gate({ flow, step, onChoose }: { flow: Flow; step: FlowStep; onChoose: (c: "continue" | "retry" | "stop") => void }) {
  const last = flow.current + 1 >= flow.steps.length;
  return (
    <div className="gate">
      <p className="outcome-lead">{step.reason}</p>
      {step.summary && <p className="gate-summary">{step.summary}</p>}
      {step.check && (
        <details className="gate-check">
          <summary>check passed: {step.check.command}</summary>
          <pre>{step.check.output || "(no output)"}</pre>
        </details>
      )}
      {step.verdict && <VerdictBars verdict={step.verdict} />}
      <div className="gate-buttons">
        <button type="button" className="mini strong" onClick={() => onChoose("continue")}>
          {last ? "accept and finish" : `continue to ${flow.steps[flow.current + 1]?.name ?? "the next step"}`}
        </button>
        <button type="button" className="mini" onClick={() => onChoose("retry")}>retry this step</button>
        <button type="button" className="mini" onClick={() => onChoose("stop")}>stop here</button>
      </div>
    </div>
  );
}

/* ---------- the console ---------- */

export function FlowConsole({ flowId }: { flowId: string }) {
  const close = useStore((s) => s.closeSheet);
  const flow = useStore((s) => s.flows[flowId]);
  const repo = useStore((s) => s.repos.find((r) => r.id === flow?.repoId));
  const stopFlow = useStore((s) => s.stopFlow);
  const dismissFlow = useStore((s) => s.dismissFlow);
  const resumeFlow = useStore((s) => s.resumeFlow);
  const answerRun = useStore((s) => s.answerRun);
  const [picked, setPicked] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!flow) {
    return (
      <>
        <p className="sheet-empty">That workflow run is gone.</p>
        <footer className="sheet-foot"><span className="spacer" /><button type="button" className="mini" onClick={close}>close</button></footer>
      </>
    );
  }
  const active = isFlowActive(flow);
  const shown = picked ?? flow.current;
  const step = flow.steps[shown];
  const run = useStore((s) => (step?.runId ? s.runs[step.runId] : undefined));
  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errText(err));
    }
  };
  const elapsed = (flow.endedAt ?? Date.now()) - flow.startedAt;
  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">with claude · workflow</div>
          <h2 className="sheet-title">{flow.verb} <span className="sheet-repo">{flow.repoId}</span></h2>
        </div>
        <span className={`status st-${flow.status === "gated" ? "waiting" : flow.status}`}>
          <span className="dot" />
          {flowWord(flow, true)}
        </span>
        <span className="clock" title="elapsed">{mmss(elapsed)}</span>
        <button type="button" className="mini close" onClick={close} aria-label="Close">✕</button>
      </header>
      <StepStrip flow={flow} shown={shown} onPick={(i) => setPicked(i === flow.current ? null : i)} />
      {step && flow.status === "gated" && shown === flow.current ? (
        <div className="sheet-body console">
          <Gate flow={flow} step={step} onChoose={(c) => void act(() => resumeFlow(flow.id, c))} />
          {run && <Timeline run={run} repo={repo} error={null} onAnswer={() => {}} />}
        </div>
      ) : run ? (
        <Timeline run={run} repo={repo} error={error} onAnswer={(a) => void act(() => answerRun(run.id, run.prompt?.id ?? "", a))} />
      ) : (
        <div className="sheet-body console">
          {step?.check ? (
            <details className="gate-check" open>
              <summary>{step.status === "failed" ? "check failed" : "check"}: {step.check.command}</summary>
              <pre>{step.check.output || "(no output)"}</pre>
            </details>
          ) : (
            <p className="sheet-empty">{step ? stepWord(step) : "no step"}</p>
          )}
          {flow.status === "failed" && <div className="outcome err"><p>{flow.error ?? "The workflow failed."}</p></div>}
          {error && <p className="note err">{error}</p>}
        </div>
      )}
      <footer className="sheet-foot">
        <span className="sheet-hint">step {shown + 1} of {flow.steps.length}{step ? `: ${stepWord(step)}` : ""}</span>
        <span className="spacer" />
        {active ? (
          <button type="button" className="mini" onClick={() => void act(() => stopFlow(flow.id))}>stop</button>
        ) : (
          <button type="button" className="mini" onClick={() => void act(() => dismissFlow(flow.id))}>dismiss</button>
        )}
        <button type="button" className="mini strong" onClick={close}>{active ? "hide" : "close"}</button>
      </footer>
    </>
  );
}

export function FleetPlan({ workflow }: { workflow: string }) {
  return <p className="sheet-empty">fleet plan for {workflow}: task 10</p>;
}
export function FleetSheet({ fleetId }: { fleetId: string }) {
  return <p className="sheet-empty">fleet {fleetId}: task 10</p>;
}
```

The `useStore` call for `run` sits after an early return; hooks must not be conditional, so move the `run` selector above the `if (!flow)` guard, reading `flow?.steps[picked ?? flow.current]?.runId` inline. Do that when writing the file, not after the lint complains.

The Timeline inside a gated flow gets a no-op `onAnswer` because a gated step's run has ended; nothing is waiting there.

- [ ] **Step 6: Styles**

Append to `ui/src/styles.css`, using the existing tokens (`--line`, `--ink-dim`, `--moss`, `--rust`, `--sky`, `--lichen`, `--raised`; check the exact names at the top of the file):

```css
/* ---------- workflow steps in the sheet ---------- */
.step-strip {
  display: flex;
  gap: 4px;
  margin: 0;
  padding: 8px 16px 0;
  list-style: none;
  overflow-x: auto;
}
.step-strip li { flex: 1 1 0; min-width: 0; }
.step-seg {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: transparent;
  color: var(--ink-dim);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.step-seg:disabled { cursor: default; }
.step-seg.shown { border-color: var(--ink-dim); color: var(--ink); }
.step-seg .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--line); flex: none; }
.step-seg.st-running .dot, .step-seg.st-checking .dot { background: var(--sky); }
.step-seg.st-gated .dot { background: var(--lichen); }
.step-seg.st-passed .dot { background: var(--moss); }
.step-seg.st-failed .dot { background: var(--rust); }
.plan-steps { margin: 8px 0 0; padding-left: 20px; font-size: 13px; }
.plan-steps li { margin: 2px 0; }
.plan-step-meta { color: var(--ink-dim); margin-left: 6px; }
.gate { border: 1px solid var(--lichen); border-radius: 8px; padding: 12px; margin: 0 0 12px; }
.gate-summary { white-space: pre-wrap; margin: 8px 0; }
.gate-check summary { cursor: pointer; color: var(--ink-dim); font-size: 12px; }
.gate-check pre { max-height: 240px; overflow: auto; font-size: 12px; }
.gate-buttons { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.verdict-bars { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 8px 0; font-size: 12px; }
.verdict-bars div { display: contents; }
.verdict-bars dt { color: var(--ink-dim); }
.verdict-bars dd { margin: 0; display: flex; align-items: center; gap: 8px; }
.verdict-bars .bar { display: inline-block; height: 8px; border-radius: 4px; background: var(--sky); min-width: 2px; }
.verdict-bars .pct { color: var(--ink-dim); }
```

- [ ] **Step 7: Gates**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

- [ ] **Step 8: Walk it in the browser**

Restart the server (the memory notes say `:7850` is a launchd agent; kill its PID and launchd respawns it with the new build) and open `http://127.0.0.1:7850`. On a dirty repo's ⋯ menu: the "with claude" list shows commit, push, ship, deploy, review, then ask, chat, agent, herdr, settings. Pick review, confirm, and watch the flow sheet: one segment in the strip, the timeline filling, then done. Pick ship on a repo with a failing gate (or edit `.canopy/workflows/ship.md` in a scratch repo to `check: false`) and see the flow fail with the check output. Pick a workflow with `gate: ask` and see the gate box with three buttons, then continue.

- [ ] **Step 9: Commit**

```bash
git add ui/src/components/RepoMenu.tsx ui/src/components/RunChip.tsx ui/src/components/RepoGrid.tsx ui/src/components/Dock.tsx ui/src/components/RunSheet.tsx ui/src/components/FlowSheet.tsx ui/src/styles.css
git commit -m "feat: workflows in the card menu, a flow sheet with a step strip and a gate

Claude-Session: https://claude.ai/code/session_01ATKaeCck4C4DhgUzeey9Zw"
```

---

### Task 10: select mode and fleets in the browser

**Files:**
- Modify: `ui/src/components/TopBar.tsx`, `ui/src/components/RepoGrid.tsx`, `ui/src/App.tsx`
- Create: `ui/src/components/SelectBar.tsx`
- Modify: `ui/src/components/FlowSheet.tsx` (`FleetPlan`, `FleetSheet`)
- Modify: `ui/src/styles.css`

**Interfaces:**
- Consumes: `selecting`, `selected`, `setSelecting`, `toggleSelected`, `planFleet`, `startFleet`, `stopFleet`, `dismissFleet`, `showFleet`, `fleetCounts`, `oldestParked`, `selectable`, `fleetSkipReason`.

- [ ] **Step 1: The toggle in the top bar**

Next to the search button in `TopBar.tsx`:

```tsx
      <button
        type="button"
        className={selecting ? "pill on" : "pill"}
        aria-pressed={selecting}
        title="Pick repos to run one workflow on all of them"
        onClick={() => setSelecting(!selecting)}
      >
        {selecting ? `${selected.length} picked` : "select"}
      </button>
```

with `const selecting = useStore((s) => s.selecting);`, `const selected = useStore((s) => s.selected);`, `const setSelecting = useStore((s) => s.setSelecting);`. `selected` is a stored array, not a derived one, so no `useShallow` is needed.

- [ ] **Step 2: Ticks on the cards**

In `RepoGrid.tsx`'s card: `const selecting = useStore((s) => s.selecting);`, `const picked = useStore((s) => s.selected.includes(repo.id));`, `const toggleSelected = useStore((s) => s.toggleSelected);`, `const canPick = !repo.forge && !repo.error && !repo.host;`. In select mode a click on the card toggles instead of opening:

```tsx
      onClick={(e) => {
        if (selecting) {
          if (canPick) toggleSelected(repo.id);
          return;
        }
        openRepo(repo.id, e);
      }}
```

and the same in the Enter handler. Add ` picked` to the class name when `selecting && picked`, ` unpickable` when `selecting && !canPick`, and in `card-top` before the glyph:

```tsx
        {selecting && (
          <span className={`tick${picked ? " on" : ""}`} aria-hidden="true">
            {picked ? "✓" : ""}
          </span>
        )}
```

- [ ] **Step 3: The select bar**

`ui/src/components/SelectBar.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore, visibleRepos } from "../store";
import { selectable } from "../flows";
import { api } from "../api";
import type { WorkflowEntry } from "../../../src/core/types";

/** The bar along the bottom in select mode: the count, a workflow picker,
 *  and start. The picker lists the bundled and user workflows, fetched
 *  through the first visible repo since the list is the same for all. */
export function SelectBar() {
  const selecting = useStore((s) => s.selecting);
  const selected = useStore((s) => s.selected);
  const setSelecting = useStore((s) => s.setSelecting);
  const planFleet = useStore((s) => s.planFleet);
  const visible = useStore(useShallow((s) => selectable(visibleRepos(s)).map((r) => r.id)));
  const setSelected = useStore((s) => s.setSelected);
  const [list, setList] = useState<WorkflowEntry[]>([]);
  const [workflow, setWorkflow] = useState("");
  useEffect(() => {
    if (!selecting || !visible[0]) return;
    let live = true;
    void api.workflows(visible[0]).then((l) => {
      if (!live) return;
      const ok = l.filter((e) => e.ok && e.workflow.source !== "repo");
      setList(ok);
      const first = ok[0];
      if (first?.ok && !workflow) setWorkflow(first.workflow.name);
    });
    return () => {
      live = false;
    };
  }, [selecting, visible[0]]);
  if (!selecting) return null;
  return (
    <div className="select-bar" role="toolbar" aria-label="Fleet">
      <span className="select-count">
        {selected.length} of {visible.length} repos
      </span>
      <button type="button" className="mini" onClick={() => setSelected(visible)}>all in view</button>
      <button type="button" className="mini" onClick={() => setSelected([])}>none</button>
      <span className="spacer" />
      <select className="select-wf" value={workflow} onChange={(e) => setWorkflow(e.target.value)} aria-label="Workflow">
        {list.map((e) => e.ok && <option key={e.workflow.name} value={e.workflow.name}>{e.workflow.label}</option>)}
      </select>
      <button type="button" className="mini strong" disabled={!selected.length || !workflow} onClick={() => planFleet(workflow)}>
        run on {selected.length}…
      </button>
      <button type="button" className="mini" onClick={() => setSelecting(false)}>done</button>
    </div>
  );
}
```

This needs one more store action, `setSelected(ids: string[]): void` (`set({ selected: ids })`); add it to the store beside `toggleSelected`. Render `<SelectBar />` in `App.tsx` right above `<TermDock />`.

- [ ] **Step 4: The fleet plan and the fleet sheet**

Replace the two placeholders in `FlowSheet.tsx`:

```tsx
export function FleetPlan({ workflow }: { workflow: string }) {
  const close = useStore((s) => s.closeSheet);
  const startFleet = useStore((s) => s.startFleet);
  const selected = useStore((s) => s.selected);
  const repos = useStore(useShallow((s) => s.repos.filter((r) => selected.includes(r.id))));
  const entry = useStore((s) => Object.values(s.workflows).flat().find((e) => e.ok && e.workflow.name === workflow));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const w = entry && entry.ok ? entry.workflow : undefined;
  const rows = repos.map((r) => ({ repo: r, skipped: w ? fleetSkipReason(r, w) : null }));
  const running = rows.filter((r) => !r.skipped);
  const skipped = rows.filter((r) => r.skipped);
  const byReason = new Map<string, string[]>();
  for (const r of skipped) byReason.set(r.skipped ?? "", [...(byReason.get(r.skipped ?? "") ?? []), r.repo.name]);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await startFleet(workflow, note);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };
  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">with claude · fleet</div>
          <h2 className="sheet-title">{w?.verb ?? workflow} <span className="sheet-repo">{running.length} of {repos.length} repos</span></h2>
        </div>
        <button type="button" className="mini close" onClick={close} aria-label="Close">✕</button>
      </header>
      <div className="sheet-body plan">
        {w && <p className="blurb">{w.blurb}</p>}
        <p className="fleet-list">{running.map((r) => r.repo.name).join(", ") || "nothing to run on"}</p>
        {[...byReason.entries()].map(([why, names]) => (
          <p key={why} className="fleet-skipped"><span className="eyebrow">skipped, {why}</span>{names.join(", ")}</p>
        ))}
        <textarea className="plan-note" rows={3} placeholder={w?.notePlaceholder ?? "anything Claude should know (optional)"} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note for Claude" />
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">Three repos at a time. A workflow that stops to ask holds its place until you answer.</span>
        <button type="button" className="mini" onClick={close}>cancel</button>
        <button type="button" className="mini strong" disabled={busy || !running.length} onClick={() => void go()}>{busy ? "starting…" : `run on ${running.length}`}</button>
      </footer>
    </>
  );
}

export function FleetSheet({ fleetId }: { fleetId: string }) {
  const close = useStore((s) => s.closeSheet);
  const fleet = useStore((s) => s.fleets[fleetId]);
  const flows = useStore((s) => s.flows);
  const repos = useStore((s) => s.repos);
  const stopFleet = useStore((s) => s.stopFleet);
  const dismissFleet = useStore((s) => s.dismissFleet);
  const showFlow = useStore((s) => s.showFlow);
  const resumeFlow = useStore((s) => s.resumeFlow);
  const answerRun = useStore((s) => s.answerRun);
  const runs = useStore((s) => s.runs);
  const [error, setError] = useState<string | null>(null);
  if (!fleet) {
    return (
      <>
        <p className="sheet-empty">That fleet is gone.</p>
        <footer className="sheet-foot"><span className="spacer" /><button type="button" className="mini" onClick={close}>close</button></footer>
      </>
    );
  }
  const counts = fleetCounts(fleet, flows);
  const parked = oldestParked(fleet, flows);
  const parkedStep = parked?.steps[parked.current];
  const parkedRun = parkedStep?.runId ? runs[parkedStep.runId] : undefined;
  const working = fleet.status === "working";
  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errText(err));
    }
  };
  const name = (id: string) => repos.find((r) => r.id === id)?.name ?? id;
  const word = (r: Fleet["repos"][number]): string => {
    if (r.skipped) return `skipped, ${r.skipped}`;
    const f = r.flowId ? flows[r.flowId] : undefined;
    if (!f) return "waiting its turn";
    return flowWord(f, true);
  };
  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">with claude · fleet</div>
          <h2 className="sheet-title">{fleet.verb} <span className="sheet-repo">{fleet.repos.length} repos</span></h2>
        </div>
        <span className={`status st-${counts.needsYou ? "waiting" : working ? "working" : "done"}`}>
          <span className="dot" />
          {working
            ? `${counts.active} running, ${counts.pending} to go${counts.needsYou ? `, ${counts.needsYou} need${counts.needsYou === 1 ? "s" : ""} you` : ""}`
            : `${counts.done} done, ${counts.failed} failed, ${counts.skipped} skipped`}
        </span>
        <button type="button" className="mini close" onClick={close} aria-label="Close">✕</button>
      </header>
      <div className="sheet-body console">
        {parked && parkedStep && (
          <section className="fleet-needs">
            <p className="eyebrow">needs you: {name(parked.repoId)}</p>
            {parked.status === "gated" ? (
              <Gate flow={parked} step={parkedStep} onChoose={(c) => void act(() => resumeFlow(parked.id, c))} />
            ) : parkedRun?.prompt ? (
              <Timeline run={parkedRun} repo={repos.find((r) => r.id === parked.repoId)} error={null} onAnswer={(a) => void act(() => answerRun(parkedRun.id, parkedRun.prompt?.id ?? "", a))} />
            ) : null}
          </section>
        )}
        <ul className="fleet-rows">
          {fleet.repos.map((r) => {
            const f = r.flowId ? flows[r.flowId] : undefined;
            const st = r.skipped ? "skipped" : !f ? "pending" : f.status === "gated" ? "waiting" : f.status;
            const summary = f && !isFlowActive(f) ? (f.steps[f.current]?.summary ?? "").split(/(?<=\.)\s/)[0] : "";
            return (
              <li key={r.repoId} className={`fleet-row st-${st}`}>
                <button type="button" className="fleet-name" disabled={!f} onClick={() => f && showFlow(f.id)}>
                  <span className="dot" />
                  {name(r.repoId)}
                </button>
                <span className="fleet-word">{word(r)}</span>
                {summary && <span className="fleet-summary">{summary}</span>}
              </li>
            );
          })}
        </ul>
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="spacer" />
        {working ? (
          <button type="button" className="mini" onClick={() => void act(() => stopFleet(fleet.id))}>stop all</button>
        ) : (
          <button type="button" className="mini" onClick={() => void act(() => dismissFleet(fleet.id))}>dismiss</button>
        )}
        <button type="button" className="mini strong" onClick={close}>{working ? "hide" : "close"}</button>
      </footer>
    </>
  );
}
```

Imports to add at the top of `FlowSheet.tsx`: `useShallow` from `zustand/react/shallow`, `fleetSkipReason` from `../../../src/core/flow` (it imports nothing Bun-only: `flow.ts` must stay importable by the browser for this one function, so keep `flow.ts` free of node imports; it is, since the check and evaluator come through hooks), `fleetCounts`, `oldestParked` from `../flows`, and the `Fleet` type. If the Vite build complains about `flow.ts` pulling `crypto` or similar, move `fleetSkipReason` into `src/core/actions.ts` instead and update task 6's import.

- [ ] **Step 5: Styles**

Append to `ui/src/styles.css`:

```css
/* ---------- select mode and fleets ---------- */
.card .tick {
  width: 16px; height: 16px; border: 1px solid var(--line); border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; margin-right: 6px; flex: none;
}
.card .tick.on { background: var(--moss); border-color: var(--moss); color: var(--bg); }
.card.picked { outline: 2px solid var(--moss); }
.card.unpickable { opacity: 0.45; }
.select-bar {
  display: flex; align-items: center; gap: 8px; padding: 8px 16px;
  border-top: 1px solid var(--line); background: var(--raised);
}
.select-count { font-size: 13px; color: var(--ink-dim); }
.select-wf { font: inherit; font-size: 13px; padding: 4px 8px; }
.fleet-list { margin: 8px 0; }
.fleet-skipped { margin: 4px 0; color: var(--ink-dim); font-size: 13px; }
.fleet-skipped .eyebrow { display: block; }
.fleet-needs { border: 1px solid var(--lichen); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
.fleet-rows { list-style: none; margin: 0; padding: 0; }
.fleet-row { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; padding: 6px 0; border-bottom: 1px solid var(--line); align-items: baseline; }
.fleet-name { font: inherit; background: none; border: 0; padding: 0; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; color: var(--ink); }
.fleet-name:disabled { cursor: default; color: var(--ink-dim); }
.fleet-name .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--line); }
.fleet-row.st-working .dot { background: var(--sky); }
.fleet-row.st-waiting .dot { background: var(--lichen); }
.fleet-row.st-done .dot { background: var(--moss); }
.fleet-row.st-failed .dot, .fleet-row.st-stopped .dot { background: var(--rust); }
.fleet-word { color: var(--ink-dim); font-size: 13px; }
.fleet-summary { grid-column: 2; font-size: 13px; }
```

Use the file's real token names (`grep -n "^  --" ui/src/styles.css | head -40`) in place of `--bg`, `--ink`, `--ink-dim`, `--line`, `--raised` if they differ.

- [ ] **Step 6: Gates**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

- [ ] **Step 7: Walk it in the browser**

Restart the server, open canopy, press select in the top bar: every pickable card gets a tick, the bar appears along the bottom with the count. Untick two, pick review, press run. The fleet plan lists the repos, and any skipped with the reason. Confirm: the fleet sheet shows rows moving from waiting its turn to working to done, three at a time. Click a row to open its flow. Try ship over two scratch repos where one has `gate: ask` in a `.canopy/workflows/ship.md` override: the needs-you strip shows the gate for that repo.

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/TopBar.tsx ui/src/components/RepoGrid.tsx ui/src/components/SelectBar.tsx ui/src/components/FlowSheet.tsx ui/src/App.tsx ui/src/store.ts ui/src/styles.css
git commit -m "feat: select repos on the board and run one workflow over all of them

Claude-Session: https://claude.ai/code/session_01ATKaeCck4C4DhgUzeey9Zw"
```

---

### Task 11: retire the built-in jobs, document the format

**Files:**
- Modify: `src/core/types.ts` (`RUN_ACTIONS`), `src/core/actions.ts`, `src/core/actions.test.ts`, `src/core/runner.test.ts`
- Modify: `ui/src/components/RepoMenu.tsx` (the `fact` helper), `ui/src/components/RunSheet.tsx` (`Plan` still uses `ACTIONS[action]`, unchanged)
- Create: `docs/workflows/example-update-deps.md`
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Shrink the actions**

In `src/core/types.ts`: `export const RUN_ACTIONS = ["ask", "chat"] as const;`.

In `src/core/actions.ts`: delete the `commit`, `push`, `commit-push` and `deploy` entries of `ACTIONS`, the `SUBMODULE_STEP` and `STRAY_STEP` constants (they now live in the bundled files), and `canRun` (`checkWhen` replaces it). Keep `GIT_READ`, `GIT_COMMIT`, `GIT_PUSH`, `BUN`, `READ` for `TOOL_SETS`. `RULES`, `CHAT_RULES`, `repoFacts`, `buildPrompt`, `describeTool`, `toolDetail` stay.

In `src/core/actions.test.ts`: delete the `canRun` tests and add the same cases for `checkWhen` with `when` values:

```ts
describe("checkWhen", () => {
  test("dirty, unpushed, either, any", () => {
    expect(checkWhen(repo(), "dirty")).toEqual({ ok: false, why: "nothing to commit" });
    expect(checkWhen(repo({ files: [file] }), "dirty")).toEqual({ ok: true });
    expect(checkWhen(repo(), "unpushed")).toEqual({ ok: false, why: "nothing to push" });
    expect(checkWhen(repo({ ahead: 2 }), "unpushed")).toEqual({ ok: true });
    expect(checkWhen(repo({ upstream: null }), "unpushed")).toEqual({ ok: true });
    expect(checkWhen(repo(), "dirty-or-unpushed").ok).toBe(false);
    expect(checkWhen(repo({ ahead: 1 }), "dirty-or-unpushed").ok).toBe(true);
    expect(checkWhen(repo(), "any")).toEqual({ ok: true });
    expect(checkWhen({ ...repo(), error: "nope" }, "any").ok).toBe(false);
  });
});
```

and change any test still reading `ACTIONS.commit` (the "spec carries the run's words" test from task 1 loops `RUN_ACTIONS`, so it adapts; replace its `ACTIONS.commit.expectsChange` and `ACTIONS.deploy.expectsChange` lines with `expect(ACTIONS.ask.expectsChange).toBe(false)`, and the `buildPrompt(r, ACTIONS.commit, ...)` job case with `ACTIONS.ask` plus a hand-built job spec: `{ ...ACTIONS.ask, mode: "job", task: "Task: x" }`).

In `src/core/runner.test.ts`: `cliArgs(ACTIONS.commit, ...)` becomes `cliArgs(ACTIONS.ask, ...)`.

In `ui/src/components/RepoMenu.tsx`: delete `fact` if it only returns "" now, and its call.

- [ ] **Step 2: Gates**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass. Typecheck will point at anything still naming a retired action; fix each by hand.

- [ ] **Step 3: The example user workflow**

`docs/workflows/example-update-deps.md`:

```markdown
---
name: update-deps
label: update deps
verb: update deps
blurb: Claude bumps the project's dependencies within their ranges, runs the gates, and commits the lockfile and manifest changes as one commit.
when: any
expects-change: true
---

## Update
tools: bun, read, git-read
turns: 40

Task: update this project's dependencies. Find the package manager from the lockfile (bun.lock, package-lock.json, Cargo.lock, uv.lock) and run its update command within the ranges the manifest allows. Do not change major versions. Report what moved.

## Gates
check: bun run typecheck && bun run lint && bun test && bun run build

## Commit
tools: git-read, git-commit
gate: verdict

Task: commit the manifest and lockfile changes as one commit whose subject names the notable bumps. Leave every other change alone.
```

Copy it to `~/.config/canopy/workflows/` to use it; it is a document, not a bundled file.

- [ ] **Step 4: README and CLAUDE.md**

README: add a "Workflows" section after the existing Claude section, saying: a workflow is a markdown file; the frontmatter keys and the step keys as two short tables (copy from the spec's section 1); the three folders and that later ones win by name; the five bundled ones and what each does; the gates (check, ask, verdict) and that verdict needs `AI_GATEWAY_API_KEY` in the server's environment and falls back to ask without it; fleets from the select button; the example file under `docs/workflows`.

CLAUDE.md: in the `src/core/` line add `workflow` (the parser), `workflows` (the loader and the three sources), `flow` (the `Flows` orchestrator over Runner, one Run per step, check then gate, fleets with `FLEET_CONCURRENCY`), `verdict` (questions, `decide`, thresholds) and `jev` (the evaluator, null without a key). In the `src/server/` line add the flow and fleet routes and the four events. In the `ui/` line add `FlowSheet.tsx`, `SelectBar.tsx`, `flows.ts`, the `flowRuns` rule (a flow's runs stay off the cards), and that `flow.ts` must stay free of node imports because the browser imports `fleetSkipReason` from it. In gotchas add: a fleet resolves its workflow from the bundled and user sources only, and the `{ path: "", host: "none" }` call is how the server asks for that.

- [ ] **Step 5: Gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`

```bash
git add src/core/types.ts src/core/actions.ts src/core/actions.test.ts src/core/runner.test.ts ui/src/components/RepoMenu.tsx docs/workflows/example-update-deps.md README.md CLAUDE.md
git commit -m "refactor: commit, push and deploy are bundled workflows now; document the format

Claude-Session: https://claude.ai/code/session_01ATKaeCck4C4DhgUzeey9Zw"
```

---

## Done when

- Every task's gates pass and the three browser walks (tasks 7, 9, 10) behaved as described.
- `bun ~/.claude/skills/verify-build/clean-rebuild.sh verify "FlowConsole"` proves the served bundle is the new build.
- The ⋯ menu of a dirty repo shows commit, push, ship, deploy, review, ask, chat; select mode runs review across three repos; a `gate: ask` workflow parks and continues.
