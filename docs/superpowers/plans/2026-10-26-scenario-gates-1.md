# Scenario gates, plan 1: command scenarios in the landing queue (FR-032)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** planned 2026-10-26. Written in the worktree
`.claude/worktrees/specs-2026-10-25` on branch `worktree-specs-2026-10-25`.

**Goal:** a repo's holdout scenarios, kept under `<configDir>/scenarios/<repo key>/`
outside every checkout, run in the landing queue after the gates; a red one sends
the branch back with the scenario's name and the observed output and never its
text; the result is written on the branch's record, the run sheet shows it, and
`canopy scenarios` lists, adds and runs a set.

**Architecture:** a pure parser (`core/scenario.ts`) reads scenario files and the
repo's `.canopy/scenarios.json`; a server module (`server/scenarios.ts`) owns the
folder, the temp copy a run sees as `SCENARIO_DIR`, the pass that runs a set and
the routes; the queue's `turn` in `server/landing.ts` calls the pass between the
last gate and the moved check, through a `deps.scenario` runner the tests stand
in for. Command scenarios only: a `judge` scenario parses and is listed, but
plan 2 brings it into the run.

**Tech Stack:** Bun, TypeScript strict, React 19, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-scenario-gates-design.md`, the
"Plans" list's item 1. The index is
`docs/superpowers/specs/2026-10-25-software-factory-borrowings-design.md`.

## Global constraints

- A scenario `name` matches `GATE_NAME` in `core/gates.ts`: `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/`.
- The set lives at `<configDir>/scenarios/<repo key>/`, `repoKey` from `core/worktree.ts`, one `<name>.md` per scenario.
- The default run line is `bun test "$SCENARIO_DIR"`; the variable is `SCENARIO_DIR`, with no `CANOPY_` prefix so `gateEnv` keeps it.
- A run line (a scenario's or the set's default) that contains `CANOPY_` is refused at parse.
- `.canopy/scenarios.json` is read from the main checkout's folder like `.canopy/gates.json`, never from a worktree. Defaults: `run` as above, `judge: "jev"`, `minimum: 1`, `timeout: 600`; `timeout` at most `1800`; `minimum` between 0 and 1.
- The whole set folder is copied to a fresh temp dir before each pass and removed after, even when a runner throws.
- The agent never receives a scenario's text: a red entry's `gate` is `scenario: <name>` and its `reason` is the output tail (`TAIL_CHARS`, 4000).
- Every file the UI imports from `src/core/` stays browser-safe: `core/scenario.ts` has no `node:` import.
- Plain words, no em dashes, sentence case headings (the unslop rules apply to docs and commit messages).
- All four gates pass before a task is done: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.

## Review focus

Inputs the spec implies and no section of it names. Each has a test in the task that owns the code.

1. A scenario named like a gate (`test`): its red reads `scenario: test`, never `test`, so `fixPrompt` and the sheet cannot confuse the two (Task 2).
2. A repo with no set folder at all: the turn runs no scenario pass, writes no `scenarios` on the record, and the entry still lands with `noGates` when it has no gates either (Task 5).
3. A scenario file that cannot be parsed: it is a red result named by its file with the error as its output, listed before any scenario runs, so a broken holdout never passes in silence (Task 4).
4. A runner that throws mid-pass (the worktree vanished, `exec` failed): the temp copy is still removed and the entry holds with the error rather than landing (Task 4 for the copy, Task 5 for the hold).
5. A `name` in a route with `/` or `..` in it: refused by `GATE_NAME` before any path is joined, so `POST` and `DELETE` never reach outside the set folder (Task 6).

---

## File structure

- Create `src/core/scenario.ts` (pure): `Scenario`, `ScenarioSet`, `ScenarioSettings`, `parseScenario`, `parseScenarioSet`, `parseScenariosFile`, `scenarioTemplate`, `scoreOf`, the constants.
- Create `src/core/scenario.test.ts`.
- Modify `src/core/gates.ts`: export `GATE_NAME`.
- Modify `src/core/workflow.ts`: export `frontmatter`.
- Modify `src/core/types.ts`: `LandState` gains `scenarios`; `ScenarioResult`, `ScenarioRun`; `LandingRun.scenarios?`.
- Modify `src/core/landing.ts` and `src/core/landing.test.ts`: the `scenarios` state, two events, `landWord`, `fixPrompt`, `SCENARIO_GATE`, `scenarioOf`.
- Modify `src/core/check.ts` and `src/core/check.test.ts`: `runScenario`.
- Create `src/server/scenarios.ts`: `scenariosRoot`, `setDirOf`, `readScenarioSet`, `readScenarioSettings`, `copySet`, `runScenarioSet`, `ScenarioRunner`, the `Scenarios` route class.
- Create `src/server/scenarios.test.ts`.
- Modify `src/server/landing.ts` and `src/server/landing.test.ts`: `LandingDeps.scenario` and `scenariosRoot`, the pass in `turn`, `sortRun`'s flag.
- Modify `src/core/callers.ts` and `src/core/callers.test.ts`: two rules.
- Modify `src/server/index.ts`: `state.scenarios`, the handle chain, the hub's deps.
- Create `src/cli/scenarios.ts` and `src/cli/scenarios.test.ts`; modify `src/cli/index.ts`.
- Modify `ui/src/landing.ts`, `ui/src/landing.test.ts`, `ui/src/components/RunSheet.tsx`, `ui/src/styles.css`.
- Modify `docs/architecture.md`, `SPEC.md`, `README.md`, `FEATURES.md`, `docs/superpowers/plans/README.md`.

---

### Task 1: the parser

**Files:**
- Create: `src/core/scenario.ts`, `src/core/scenario.test.ts`
- Modify: `src/core/gates.ts:31` (export `GATE_NAME`), `src/core/workflow.ts:44` (export `frontmatter`)

**Interfaces:**
- Consumes: `frontmatter(text): { keys: Map<string, string>; body: string }` from `core/workflow.ts`, which throws its `Bad` error on a malformed block; `GATE_NAME` from `core/gates.ts`.
- Produces, all in `src/core/scenario.ts`:

```ts
export const SCENARIOS_FILE = ".canopy/scenarios.json";
export const SCENARIO_DIR_VAR = "SCENARIO_DIR";
export const DEFAULT_RUN = 'bun test "$SCENARIO_DIR"';
export const MAX_TIMEOUT = 1800;

export interface Scenario {
  name: string;
  kind: "command" | "judge";
  /** the shell line; a command scenario without one runs the set's default */
  run?: string;
  /** judge only: files the judge reads from the worktree, paths inside the repo */
  evidence: string[];
  /** judge only: the story */
  body: string;
}
export interface ScenarioSet {
  /** in file name order */
  scenarios: Scenario[];
  /** files that could not be read, named with why; a pass counts each as red */
  errors: { file: string; error: string }[];
}
export interface ScenarioSettings {
  run: string;
  judge: "jev" | "off";
  minimum: number;
  /** seconds */
  timeout: number;
}
export const DEFAULT_SETTINGS: ScenarioSettings;
export function parseScenario(file: string, text: string): Scenario | { error: string };
export function parseScenarioSet(files: readonly { file: string; text: string }[]): ScenarioSet;
export function parseScenariosFile(text: string): ScenarioSettings | { error: string };
/** the file `canopy scenarios add` writes */
export function scenarioTemplate(name: string, kind: Scenario["kind"], run?: string): string;
/** the mean satisfaction over `total` scenarios; a result not run counts 0; 1 when total is 0 */
export function scoreOf(results: readonly ScenarioResult[], total?: number): number;
```

`ScenarioResult` comes from `core/types.ts` (Task 2 adds it; add the type in this task so the file compiles, as `{ name: string; kind: "command" | "judge"; ok: boolean; p?: number; tail?: string }`).

Rules `parseScenario` applies, each with the error text the test pins:
- `frontmatter` throws: the error is that message.
- `name` missing or not `GATE_NAME`: `"<file>: name must be a short name of letters, digits, dots, dashes or underscores"`.
- `kind` absent is `command`; anything but `command` or `judge`: `"<file>: kind must be command or judge, not <v>"`.
- `run` containing `CANOPY_`: `"<file>: run must not name a CANOPY_ variable"`. An empty `run` is treated as absent.
- `evidence` on a command scenario: `"<file>: evidence is only read by kind: judge"`. A path starting with `/` or with a `..` segment: `"<file>: evidence must be paths inside the repo, not <p>"` (the same check as `evidenceKey` in `workflow.ts`, written here because that one's message names a step). Split on whitespace.
- a judge scenario with an empty body: `"<file>: a judge scenario needs a story below the frontmatter"`.

`parseScenarioSet` sorts by file name, parses each, and puts two scenarios with one `name` into `errors` for the second file: `"<file>: a scenario named <name> is in <first file> already"`.

`parseScenariosFile`: not JSON or not an object is an error naming `SCENARIOS_FILE` as `parseGatesFile` does; `run` must be a non-empty string without `CANOPY_`; `judge` must be `jev` or `off`; `minimum` a number from 0 to 1; `timeout` a positive whole number at most `MAX_TIMEOUT` (`"<SCENARIOS_FILE>: timeout must be at most 1800 seconds"`). Missing keys take `DEFAULT_SETTINGS`.

`scenarioTemplate("checkout-flow", "command")` is exactly:

```
---
name: checkout-flow
kind: command
---
```

with a `run: <run>` line after `kind` when `run` is given, and for `judge`:

```
---
name: refund-explains-itself
kind: judge
---
What a user does, and what they should see when it works.
```

- [ ] **Step 1: Export `GATE_NAME` from `src/core/gates.ts` and `frontmatter` from `src/core/workflow.ts`**

Add `export` to each `const`/`function`; nothing else changes. Run `bun run typecheck` to confirm.

- [ ] **Step 2: Write the failing tests in `src/core/scenario.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_RUN, DEFAULT_SETTINGS, parseScenario, parseScenarioSet, parseScenariosFile, scenarioTemplate, scoreOf } from "./scenario";

const cmd = `---\nname: checkout-flow\nkind: command\nrun: bun test "$SCENARIO_DIR/checkout.test.ts"\n---\n`;
const judge = `---\nname: refund\nkind: judge\nevidence: src/refund.ts src/mail.ts\n---\nA customer asks for a refund.\n`;

describe("parseScenario", () => {
  test("both kinds", () => {
    expect(parseScenario("checkout-flow.md", cmd)).toEqual({ name: "checkout-flow", kind: "command", run: 'bun test "$SCENARIO_DIR/checkout.test.ts"', evidence: [], body: "" });
    expect(parseScenario("refund.md", judge)).toEqual({ name: "refund", kind: "judge", evidence: ["src/refund.ts", "src/mail.ts"], body: "A customer asks for a refund." });
  });
  test("kind defaults to command and run is optional", () => {
    expect(parseScenario("a.md", "---\nname: a\n---\n")).toEqual({ name: "a", kind: "command", evidence: [], body: "" });
  });
  test("a missing or bad name", () => {
    expect(parseScenario("a.md", "---\nkind: command\n---\n")).toEqual({ error: "a.md: name must be a short name of letters, digits, dots, dashes or underscores" });
    expect(parseScenario("a.md", "---\nname: ../x\n---\n")).toEqual({ error: "a.md: name must be a short name of letters, digits, dots, dashes or underscores" });
  });
  test("a run line naming a CANOPY_ variable is refused", () => {
    expect(parseScenario("a.md", "---\nname: a\nrun: cat $CANOPY_CONFIG_DIR/callers.json\n---\n")).toEqual({ error: "a.md: run must not name a CANOPY_ variable" });
  });
  test("evidence outside the repo, or on a command scenario, is refused", () => {
    expect(parseScenario("a.md", "---\nname: a\nkind: judge\nevidence: /etc/passwd\n---\nstory\n")).toEqual({ error: "a.md: evidence must be paths inside the repo, not /etc/passwd" });
    expect(parseScenario("a.md", "---\nname: a\nkind: judge\nevidence: src/../../x\n---\nstory\n")).toEqual({ error: "a.md: evidence must be paths inside the repo, not src/../../x" });
    expect(parseScenario("a.md", "---\nname: a\nevidence: src/x.ts\n---\n")).toEqual({ error: "a.md: evidence is only read by kind: judge" });
  });
  test("a judge scenario needs a story", () => {
    expect(parseScenario("a.md", "---\nname: a\nkind: judge\n---\n\n")).toEqual({ error: "a.md: a judge scenario needs a story below the frontmatter" });
  });
  test("no frontmatter is the workflow parser's error", () => {
    expect(parseScenario("a.md", "name: a\n")).toEqual({ error: "no frontmatter: the file must start with a --- block" });
  });
});

describe("parseScenarioSet", () => {
  test("a bad file is named and the rest are kept, in file name order", () => {
    const set = parseScenarioSet([{ file: "b.md", text: cmd.replace("checkout-flow", "b") }, { file: "broken.md", text: "nope" }, { file: "a.md", text: cmd.replace("checkout-flow", "a") }]);
    expect(set.scenarios.map((s) => s.name)).toEqual(["a", "b"]);
    expect(set.errors).toEqual([{ file: "broken.md", error: "no frontmatter: the file must start with a --- block" }]);
  });
  test("two files with one name: the second is an error", () => {
    const set = parseScenarioSet([{ file: "a.md", text: cmd }, { file: "b.md", text: cmd }]);
    expect(set.scenarios).toHaveLength(1);
    expect(set.errors).toEqual([{ file: "b.md", error: "b.md: a scenario named checkout-flow is in a.md already" }]);
  });
});

describe("parseScenariosFile", () => {
  test("defaults and limits", () => {
    expect(parseScenariosFile("{}")).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({ run: DEFAULT_RUN, judge: "jev", minimum: 1, timeout: 600 });
    expect(parseScenariosFile('{"run": "make e2e", "judge": "off", "minimum": 0.8, "timeout": 1800}')).toEqual({ run: "make e2e", judge: "off", minimum: 0.8, timeout: 1800 });
    expect(parseScenariosFile('{"timeout": 1801}')).toEqual({ error: ".canopy/scenarios.json: timeout must be at most 1800 seconds" });
    expect(parseScenariosFile('{"minimum": 2}')).toEqual({ error: ".canopy/scenarios.json: minimum must be a number from 0 to 1" });
    expect(parseScenariosFile('{"judge": "claude"}')).toEqual({ error: ".canopy/scenarios.json: judge must be jev or off" });
    expect(parseScenariosFile('{"run": "echo $CANOPY_API"}')).toEqual({ error: ".canopy/scenarios.json: run must not name a CANOPY_ variable" });
    expect(parseScenariosFile("[]")).toEqual({ error: ".canopy/scenarios.json must be an object" });
    expect("error" in parseScenariosFile("{")).toBe(true);
  });
});

test("scenarioTemplate", () => {
  expect(scenarioTemplate("checkout-flow", "command")).toBe("---\nname: checkout-flow\nkind: command\n---\n");
  expect(scenarioTemplate("checkout-flow", "command", "make e2e")).toBe("---\nname: checkout-flow\nkind: command\nrun: make e2e\n---\n");
  expect(scenarioTemplate("refund", "judge")).toBe("---\nname: refund\nkind: judge\n---\nWhat a user does, and what they should see when it works.\n");
});

test("scoreOf is the mean over total, with unrun scenarios at 0", () => {
  const r = (ok: boolean, p?: number) => ({ name: "x", kind: "command" as const, ok, ...(p !== undefined ? { p } : {}) });
  expect(scoreOf([])).toBe(1);
  expect(scoreOf([r(true), r(false), r(true)])).toBeCloseTo(2 / 3);
  expect(scoreOf([r(true), r(true, 0.5)], 4)).toBeCloseTo(0.375);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/core/scenario.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 4: Write `src/core/scenario.ts`**

Header comment: the scenario file format, where a set lives, and that the file is pure and browser-safe. Import `frontmatter` from `./workflow` and `GATE_NAME` from `./gates` (both pure modules).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/core/scenario.test.ts src/core/workflow.test.ts src/core/gates.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/scenario.ts src/core/scenario.test.ts src/core/gates.ts src/core/workflow.ts
git commit -m "feat(scenarios): parse scenario files and .canopy/scenarios.json (FR-032)"
```

---

### Task 2: the queue's model

**Files:**
- Modify: `src/core/types.ts:1384` (`LandState`), `:1479` (`LandingRun`); `src/core/landing.ts`; `src/core/landing.test.ts`

**Interfaces:**
- Produces in `src/core/types.ts`:

```ts
export type LandState = "queued" | "rebasing" | "setup" | "gate" | "scenarios" | "landing" | "landed" | "waiting" | "conflict" | "red" | "moved";

export interface ScenarioResult {
  name: string;
  kind: "command" | "judge";
  ok: boolean;
  /** a judge scenario's P(yes) (plan 2) */
  p?: number;
  /** the output's last TAIL_CHARS */
  tail?: string;
}
/** what the set said about one head of a branch, written on its record */
export interface ScenarioRun {
  /** the branch head they ran against */
  head: string;
  at: number;
  total: number;
  passed: number;
  /** the mean satisfaction, 0 to 1 */
  score: number;
  results: ScenarioResult[];
}
```

and `LandingRun.scenarios?: ScenarioRun` with the comment "the set's latest pass over this branch; a rebase runs it again". Task 1's local `ScenarioResult` type is replaced by an import from `./types`.

- Produces in `src/core/landing.ts`:

```ts
/** the prefix a red entry's gate carries when a scenario sent it back */
export const SCENARIO_GATE = "scenario: ";
/** the scenario a red entry names, or null when a gate did */
export const scenarioOf = (gate: string | undefined): string | null;
export type LandEvent = ... | { t: "scenarios"; first: string } | { t: "scenario-ok"; next: string | null };
```

`WORKING` gains `"scenarios"`. `advance`: `scenarios` moves a `landing` entry to `scenarios` with `gate: first`; `scenario-ok` moves to `scenarios` with `gate: next`, or to `landing` when `next` is null. `landWord` says `scenario: <gate>` in the `scenarios` state. `fixPrompt` for a red entry whose gate starts with `SCENARIO_GATE` reads:

```
canopy's landing queue sent this branch (<branch>) back: scenario <name> failed after a rebase onto <target>. The scenario is kept outside the repository and is not shown; the end of what it observed is below:

<reason>

Rebase onto <target>, fix what the output shows, run the repo's checks, and commit. Do not push.
```

- [ ] **Step 1: Write the failing tests in `src/core/landing.test.ts`**

Add to the file, using its `run()` and `entry` helpers:

```ts
describe("scenarios", () => {
  test("after the last gate the entry moves through the scenarios, then lands", () => {
    let e = advance(enqueue([], run("s1"), 1)[0]!, { t: "begin" }, 2);
    e = advance(e, { t: "rebased", setup: false, first: "test", noGates: false }, 3);
    e = advance(e, { t: "gate-ok", next: null }, 4);
    expect(e.state).toBe("landing");
    e = advance(e, { t: "scenarios", first: "checkout-flow" }, 5);
    expect([e.state, e.gate, landWord(e, [e]), inQueue(e)]).toEqual(["scenarios", "checkout-flow", "scenario: checkout-flow", true]);
    e = advance(e, { t: "scenario-ok", next: "refund" }, 6);
    expect([e.state, e.gate]).toEqual(["scenarios", "refund"]);
    e = advance(e, { t: "scenario-ok", next: null }, 7);
    expect([e.state, e.gate]).toEqual(["landing", undefined]);
  });
  test("a red scenario reads as one, apart from a gate of the same name", () => {
    const base = advance(advance(enqueue([], run("s2"), 1)[0]!, { t: "begin" }, 2), { t: "scenarios", first: "test" }, 3);
    const e = advance(base, { t: "red", gate: `${SCENARIO_GATE}test`, output: "x".repeat(5000) + "\n2 fail" }, 4);
    expect([e.state, e.gate, landWord(e, [e]), scenarioOf(e.gate)]).toEqual(["red", "scenario: test", "red: scenario: test", "test"]);
    expect(e.reason?.length).toBe(TAIL_CHARS);
    expect(scenarioOf("test")).toBeNull();
    const p = fixPrompt(e);
    expect(p).toContain("scenario test failed after a rebase onto main");
    expect(p).toContain("is not shown");
    expect(p.endsWith("2 fail\n\nRebase onto main, fix what the output shows, run the repo's checks, and commit. Do not push.")).toBe(true);
    expect(p).not.toContain("the test gate failed");
  });
  test("a restart puts a mid-scenarios entry back in the queue", () => {
    const e = advance(advance(enqueue([], run("s3"), 1)[0]!, { t: "begin" }, 2), { t: "scenarios", first: "a" }, 3);
    expect(restartWorking([e], 9)[0]).toMatchObject({ state: "queued", gate: undefined });
  });
});
```

Import `SCENARIO_GATE` and `scenarioOf` with the rest.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/landing.test.ts -t scenarios`
Expected: FAIL (`SCENARIO_GATE` is not exported; the `scenarios` event is not handled).

- [ ] **Step 3: Add the types and the model**

`src/core/types.ts` as the Interfaces block says. `src/core/landing.ts`: the constants, the two `advance` cases, `WORKING`, `landWord`, `fixPrompt`. Update the file's header comment: "...run the gates one at a time, then the repo's scenarios, then fast-forward main".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/landing.test.ts src/cli/land.test.ts ui/src/landing.test.ts && bun run typecheck`
Expected: PASS; typecheck clean (the UI's `landWord` switch and the CLI's `backWords` need no change, since both fall through to `e.gate`).

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/landing.ts src/core/landing.test.ts src/core/scenario.ts
git commit -m "feat(scenarios): the queue's scenarios state, its events and the red scenario's fix prompt"
```

---

### Task 3: running one scenario line

**Files:**
- Modify: `src/core/check.ts:119` (beside `runGate`), `src/core/check.test.ts`

**Interfaces:**
- Produces in `src/core/check.ts`:

```ts
/** A scenario's line in a branch run's worktree: `runGate`'s environment
 *  with `SCENARIO_DIR` laid over it, pointing at the set's temp copy, under
 *  the set's own timeout. */
export async function runScenario(dir: string, command: string, setDir: string, timeoutMs: number): Promise<CheckResult>;
```

Implementation: `exec(ledLine(command), { cwd: dir, timeoutMs, base: gateEnv(process.env), env: { [SCENARIO_DIR_VAR]: setDir } })`, output through `capped`.

- [ ] **Step 1: Write the failing tests in `src/core/check.test.ts`**

Inside the existing `describe` that holds the `runGate` tests (reuse its `scratch` cleanup):

```ts
test("runScenario sees SCENARIO_DIR and none of canopy's settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canopy-scenario-"));
  scratch.push(dir);
  const saved = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = "/secret";
  try {
    const r = await runScenario(dir, 'echo "set=$SCENARIO_DIR"; env | grep -c "^CANOPY_CONFIG_DIR=" || true', "/tmp/set copy", 10_000);
    expect(r.exit).toBe(0);
    expect(r.output).toBe("set=/tmp/set copy\n0");
  } finally {
    if (saved === undefined) delete process.env["CANOPY_CONFIG_DIR"];
    else process.env["CANOPY_CONFIG_DIR"] = saved;
  }
});

test("runScenario stops at the set's timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canopy-scenario-"));
  scratch.push(dir);
  const r = await runScenario(dir, "echo started; sleep 5; echo done", "/tmp/x", 500);
  expect(r.exit).not.toBe(0);
  expect(r.output).toContain("started");
  expect(r.output).not.toContain("done");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/check.test.ts -t runScenario`
Expected: FAIL, `runScenario` is not exported.

- [ ] **Step 3: Implement `runScenario`**

Import `SCENARIO_DIR_VAR` from `./scenario`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/check.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/check.ts src/core/check.test.ts
git commit -m "feat(scenarios): runScenario lays SCENARIO_DIR over a gate's environment"
```

---

### Task 4: the set on disk and the pass

**Files:**
- Create: `src/server/scenarios.ts`, `src/server/scenarios.test.ts`

**Interfaces:**
- Consumes: Task 1's parsers and `DEFAULT_SETTINGS`; `repoKey` from `core/worktree.ts`; `configDir` from `core/store.ts`; `tail` from `core/landing.ts`; `ScenarioRun`, `ScenarioResult` from `core/types.ts`; `CheckOutcome` from `./landing` (a `type` import only, so the two modules never cycle at runtime).
- Produces in `src/server/scenarios.ts`:

```ts
export const scenariosRoot = (): string => join(configDir(), "scenarios");
/** a repo's set folder under a root */
export const setDirOf = (root: string, repoPath: string): string => join(root, repoKey(repoPath));
/** every `*.md` in the set folder, parsed; a missing folder is an empty set */
export async function readScenarioSet(root: string, repoPath: string): Promise<ScenarioSet>;
/** `.canopy/scenarios.json` in the main checkout, or the defaults; throws on a file that is there but wrong, like `readGates` */
export async function readScenarioSettings(mainPath: string): Promise<ScenarioSettings>;
/** the set folder copied to a fresh temp dir (`canopy-scenarios-` under tmpdir) */
export async function copySet(dir: string): Promise<string>;

export type ScenarioRunner = (cwd: string, line: string, setDir: string, timeoutMs: number) => Promise<CheckOutcome>;

export interface ScenarioPass {
  /** the worktree the lines run in */
  dir: string;
  /** the set folder on disk, copied before the first line runs */
  setDir: string;
  set: ScenarioSet;
  settings: ScenarioSettings;
  run: ScenarioRunner;
  head: string;
  now: number;
  /** after each scenario, with the next one's name or null */
  onDone?: (r: ScenarioResult, next: string | null) => void;
}
/** Runs the set's command scenarios in order and stops at the first red.
 *  A file in `errors` is a red result named by the file, listed first, and
 *  nothing runs after it. Judge scenarios are left out in plan 1. */
export async function runScenarioSet(p: ScenarioPass): Promise<ScenarioRun>;
```

`runScenarioSet` in detail: `results` begins with one `{ name: file, kind: "command", ok: false, tail: error }` per error; when there is one, return at once with `total` = errors plus command scenarios, `passed: 0`, no copy made. Else `copy = await copySet(p.setDir)`, then in `try`: for each command scenario `s`, `r = await p.run(p.dir, s.run ?? p.settings.run, copy, p.settings.timeout * 1000)`; result `{ name: s.name, kind: "command", ok: r.exit === 0, tail: tail(r.output || \`exited ${r.exit ?? "on a signal"}\`) }`; `onDone(result, nextName)`; stop at the first `!ok`. `finally`: `rm(copy, { recursive: true, force: true })`. Return `{ head, at: now, total: commands.length, passed, score: scoreOf(results, total), results }`.

The `Scenarios` route class is Task 6; this task ends with the pass.

- [ ] **Step 1: Write the failing tests in `src/server/scenarios.test.ts`**

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../core/scenario";
import { repoKey } from "../core/worktree";
import { copySet, readScenarioSet, readScenarioSettings, runScenarioSet, setDirOf, type ScenarioRunner } from "./scenarios";

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-scen-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const cmd = (name: string, run?: string) => `---\nname: ${name}\nkind: command\n${run ? `run: ${run}\n` : ""}---\n`;

async function setFor(repoPath: string, files: Record<string, string>): Promise<string> {
  const dir = setDirOf(root, repoPath);
  await mkdir(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) await writeFile(join(dir, f), text);
  return dir;
}

test("readScenarioSet reads the folder's md files and nothing else; a missing folder is empty", async () => {
  const repo = join(root, "r1");
  await setFor(repo, { "b.md": cmd("b"), "a.md": cmd("a", "make a"), "fixture.json": "{}", "bad.md": "x" });
  const set = await readScenarioSet(root, repo);
  expect(set.scenarios.map((s) => [s.name, s.run])).toEqual([["a", "make a"], ["b", undefined]]);
  expect(set.errors.map((e) => e.file)).toEqual(["bad.md"]);
  expect(await readScenarioSet(root, join(root, "none"))).toEqual({ scenarios: [], errors: [] });
  expect(setDirOf(root, repo)).toBe(join(root, repoKey(repo)));
});

test("readScenarioSettings: the defaults without a file, the file's values, a throw on a bad one", async () => {
  const main = join(root, "main1");
  await mkdir(join(main, ".canopy"), { recursive: true });
  expect(await readScenarioSettings(main)).toEqual(DEFAULT_SETTINGS);
  await writeFile(join(main, ".canopy", "scenarios.json"), '{"timeout": 30}');
  expect(await readScenarioSettings(main)).toEqual({ ...DEFAULT_SETTINGS, timeout: 30 });
  await writeFile(join(main, ".canopy", "scenarios.json"), '{"timeout": 9999}');
  await expect(readScenarioSettings(main)).rejects.toThrow("timeout must be at most 1800 seconds");
});

test("copySet copies the whole folder, fixtures included, somewhere new", async () => {
  const repo = join(root, "r2");
  const dir = await setFor(repo, { "a.md": cmd("a"), "a.test.ts": "export {};" });
  await mkdir(join(dir, "fixtures"));
  await writeFile(join(dir, "fixtures", "x.json"), "1");
  const copy = await copySet(dir);
  expect(copy.startsWith(dir)).toBe(false);
  expect(await readFile(join(copy, "fixtures", "x.json"), "utf8")).toBe("1");
  expect(existsSync(join(copy, "a.test.ts"))).toBe(true);
  await rm(copy, { recursive: true });
});

/** a runner that records its calls and answers by scenario line */
function runner(answers: Record<string, { exit: number | null; output: string } | (() => never)>) {
  const calls: [string, string, string, number][] = [];
  const seen: string[] = [];
  const run: ScenarioRunner = async (cwd, line, setDir, ms) => {
    calls.push([cwd, line, setDir, ms]);
    seen.push(existsSync(setDir) ? "copy there" : "copy gone");
    const a = answers[line];
    if (typeof a === "function") a();
    return a ?? { exit: 0, output: "" };
  };
  return { run, calls, seen };
}

test("the pass: order, the default line, SCENARIO_DIR is a copy that is gone after, the record", async () => {
  const repo = join(root, "r3");
  const dir = await setFor(repo, { "b.md": cmd("b"), "a.md": cmd("a", "make a") });
  const set = await readScenarioSet(root, repo);
  const r = runner({ "make a": { exit: 0, output: "a ok" } });
  const done: [string, string | null][] = [];
  const out = await runScenarioSet({ dir: "/wt", setDir: dir, set, settings: { ...DEFAULT_SETTINGS, timeout: 7 }, run: r.run, head: "h1", now: 5, onDone: (x, next) => done.push([x.name, next]) });
  expect(r.calls.map(([cwd, line, , ms]) => [cwd, line, ms])).toEqual([["/wt", "make a", 7000], ["/wt", DEFAULT_SETTINGS.run, 7000]]);
  expect(r.seen).toEqual(["copy there", "copy there"]);
  expect(existsSync(r.calls[0]![2])).toBe(false);
  expect(r.calls[0]![2]).not.toBe(dir);
  expect(done).toEqual([["a", "b"], ["b", null]]);
  expect(out).toEqual({ head: "h1", at: 5, total: 2, passed: 2, score: 1, results: [{ name: "a", kind: "command", ok: true, tail: "a ok" }, { name: "b", kind: "command", ok: true, tail: "exited 0" }] });
});

test("the pass stops at the first red and keeps its output tail", async () => {
  const repo = join(root, "r4");
  const dir = await setFor(repo, { "a.md": cmd("a", "make a"), "b.md": cmd("b", "make b"), "c.md": cmd("c", "make c") });
  const set = await readScenarioSet(root, repo);
  const r = runner({ "make b": { exit: 1, output: "x".repeat(5000) + "\n1 fail" } });
  const out = await runScenarioSet({ dir: "/wt", setDir: dir, set, settings: DEFAULT_SETTINGS, run: r.run, head: "h", now: 1 });
  expect(r.calls.map((c) => c[1])).toEqual(["make a", "make b"]);
  expect([out.total, out.passed, out.score]).toEqual([3, 1, 1 / 3]);
  expect(out.results[1]).toMatchObject({ name: "b", ok: false });
  expect(out.results[1]!.tail!.length).toBe(4000);
  expect(out.results[1]!.tail!.endsWith("1 fail")).toBe(true);
});

test("a file that cannot be read is a red result before anything runs, and no copy is made", async () => {
  const repo = join(root, "r5");
  const dir = await setFor(repo, { "a.md": cmd("a"), "broken.md": "x" });
  const set = await readScenarioSet(root, repo);
  const r = runner({});
  const out = await runScenarioSet({ dir: "/wt", setDir: dir, set, settings: DEFAULT_SETTINGS, run: r.run, head: "h", now: 1 });
  expect(r.calls).toEqual([]);
  expect(out).toMatchObject({ total: 2, passed: 0, score: 0, results: [{ name: "broken.md", kind: "command", ok: false, tail: "no frontmatter: the file must start with a --- block" }] });
});

test("judge scenarios are left out of the pass in plan 1", async () => {
  const repo = join(root, "r6");
  const dir = await setFor(repo, { "a.md": cmd("a"), "j.md": "---\nname: j\nkind: judge\n---\nstory\n" });
  const set = await readScenarioSet(root, repo);
  const r = runner({});
  const out = await runScenarioSet({ dir: "/wt", setDir: dir, set, settings: DEFAULT_SETTINGS, run: r.run, head: "h", now: 1 });
  expect(r.calls).toHaveLength(1);
  expect([out.total, out.passed]).toEqual([1, 1]);
});

test("a runner that throws still loses the copy, and the throw carries", async () => {
  const repo = join(root, "r7");
  const dir = await setFor(repo, { "a.md": cmd("a", "make a") });
  const set = await readScenarioSet(root, repo);
  const r = runner({ "make a": () => { throw new Error("worktree gone"); } });
  await expect(runScenarioSet({ dir: "/wt", setDir: dir, set, settings: DEFAULT_SETTINGS, run: r.run, head: "h", now: 1 })).rejects.toThrow("worktree gone");
  expect(existsSync(r.calls[0]![2])).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/server/scenarios.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Write `src/server/scenarios.ts` up to the pass**

Header: "The holdout scenarios: where a repo's set lives, the copy a pass hands a run as `SCENARIO_DIR`, and the pass itself. Bun-only." `readScenarioSet` lists the folder with `readdir`, keeps `*.md`, reads each, and hands `parseScenarioSet` the texts; `ENOENT` on the folder is the empty set. `copySet` uses `mkdtemp` then `cp(dir, copy, { recursive: true })` from `node:fs/promises`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/server/scenarios.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/scenarios.ts src/server/scenarios.test.ts
git commit -m "feat(scenarios): the set on disk, its temp copy and the pass over command scenarios"
```

---

### Task 5: the pass in the queue's turn

**Files:**
- Modify: `src/server/landing.ts:54-81` (`LandingDeps`), `:83-91` (`sortRun`), the `kick` that calls `turn` (around `:760-773`), `turn` (`:787-860`); `src/server/landing.test.ts`

**Interfaces:**
- Consumes: Task 4's `readScenarioSet`, `readScenarioSettings`, `runScenarioSet`, `ScenarioRunner`, `scenariosRoot`, `setDirOf`; Task 2's events and `SCENARIO_GATE`.
- Produces:

```ts
export interface LandingDeps {
  ...
  /** runs one scenario line in a worktree with the set's copy as SCENARIO_DIR (`runScenario`) */
  scenario: ScenarioRunner;
  /** where the sets live; `scenariosRoot()` unless a test says otherwise */
  scenariosRoot?: string;
}
export async function sortRun(rec: LandingRun, now: number, root = scenariosRoot()): Promise<RunReview>;
```

Behaviour:
- `kick`, after `readGates`: `settings = await readScenarioSettings(e.repoPath)` and `set = await readScenarioSet(root, e.repoPath)`, in the same `try`; a throw holds the whole queue with its message, as a broken gates file does. Pass both to `turn(e, gates, { set, settings })`.
- `turn`: `commands` is the set's command scenarios. The `rebased` event's `noGates` becomes `gates.source === "none" && commands.length === 0 && set.errors.length === 0`. After the gates loop, while `e.state === "landing"`, when `commands.length + set.errors.length > 0`:
  1. `first` is `set.errors[0]?.file ?? commands[0]!.name`; `e = this.step(e, { t: "scenarios", first })`.
  2. `pass = await runScenarioSet({ dir: e.dir, setDir: setDirOf(root, e.repoPath), set, settings, run: this.deps.scenario, head: after ?? "", now: this.now(), onDone: (r, next) => { if (r.ok) e = this.step(e, { t: "scenario-ok", next }); } })`, inside a `try`; a throw holds the entry: `this.step(e, { t: "hold", why: \`scenarios could not run: ${errText(err)}\` })` and `return`.
  3. The record: `rec = this.runs.get(e.id)`; when it exists, `this.runs.set(e.id, { ...rec, scenarios: pass })` and `void this.saveRun(...)`.
  4. `red = pass.results.find((r) => !r.ok)`; when found, `this.step(e, { t: "red", gate: SCENARIO_GATE + red.name, output: red.tail ?? "" })`, publish, and `return`.
  Then the existing `currentBranch` check and the rest follow unchanged.
- `sortRun`: `hasGates` is `g.source !== "none" || set.scenarios.some((s) => s.kind === "command")`, with `set = await readScenarioSet(root, rec.repoPath).catch(() => ({ scenarios: [], errors: [] }))`. The hub calls `(this.deps.sort ?? ((r, n) => sortRun(r, n, this.root)))` where `this.root` is `this.deps.scenariosRoot ?? scenariosRoot()`.

- [ ] **Step 1: Extend the test world in `src/server/landing.test.ts`**

In `World`: `scenRoot: string`, `scenarios: [string, string, string, number][]` (the runner's calls) and `scenAnswers: Map<string, CheckOutcome | (() => CheckOutcome | Promise<CheckOutcome>)>`. In `world()`: `scenRoot: join(root, \`scen${n}\`)`, and in the hub's deps:

```ts
scenario: async (cwd, line, setDir, ms) => {
  w.scenarios.push([cwd, line, setDir, ms]);
  const a = w.scenAnswers.get(line);
  return typeof a === "function" ? await a() : (a ?? { exit: 0, output: "" });
},
scenariosRoot: w.scenRoot,
```

`rehub` gets `scenario: async () => ({ exit: 0, output: "" })` and `scenariosRoot: w.scenRoot`. A helper:

```ts
async function addScenario(w: World, name: string, run?: string, text?: string): Promise<void> {
  const dir = setDirOf(w.scenRoot, w.repo.path);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), text ?? `---\nname: ${name}\nkind: command\n${run ? `run: ${run}\n` : ""}---\n`);
}
```

- [ ] **Step 2: Write the failing tests**

In a new `describe("scenarios (FR-032)")`:

```ts
test("the scenarios run after the last gate, in the worktree, with a copy of the set, then the branch lands", async () => {
  const w = await world();
  await addScenario(w, "checkout", "make checkout");
  await addScenario(w, "refund");
  const run = await readyRun(w, "sc11", "b.txt", "b\n");
  const states: string[] = [];
  w.scenAnswers.set("make checkout", () => {
    states.push(entryOf(w, "sc11")?.state + ":" + entryOf(w, "sc11")?.gate);
    return { exit: 0, output: "ok" };
  });
  await w.hub.land("sc11");
  await w.hub.idle();
  expect(w.checks.map((c) => c[1])).toEqual(["bun run lint", "bun run test"]);
  expect(w.scenarios.map(([cwd, line, , ms]) => [cwd, line, ms])).toEqual([[run.branch!.dir, "make checkout", 600_000], [run.branch!.dir, 'bun test "$SCENARIO_DIR"', 600_000]]);
  expect(states).toEqual(["scenarios:checkout"]);
  expect(w.scenarios[0]![2]).not.toBe(setDirOf(w.scenRoot, w.repo.path));
  expect(existsSync(w.scenarios[0]![2])).toBe(false);
  expect(entryOf(w, "sc11")?.state).toBe("landed");
  expect(entryOf(w, "sc11")?.noGates).toBeUndefined();
});

test("a red scenario comes back with its name and the output tail, never its text, and the record keeps the pass", async () => {
  const w = await world();
  await addScenario(w, "checkout", "make checkout", "---\nname: checkout\nkind: command\nrun: make checkout\n---\nSECRET STORY\n");
  await readyRun(w, "sc12", "b.txt", "b\n");
  w.scenAnswers.set("make checkout", { exit: 1, output: "x".repeat(5000) + "\n1 fail" });
  await w.hub.land("sc12");
  await w.hub.idle();
  const e = entryOf(w, "sc12")!;
  expect([e.state, e.gate]).toEqual(["red", "scenario: checkout"]);
  expect(e.reason?.length).toBe(4000);
  expect(JSON.stringify(w.hub.info())).not.toContain("SECRET STORY");
  const rec = w.hub.record("sc12")!;
  expect(rec.scenarios).toMatchObject({ total: 1, passed: 0, score: 0, results: [{ name: "checkout", ok: false }] });
  expect(rec.scenarios?.head).toBe(await revOf(runTreeDir(w.repo.path, "sc12", w.wts), "HEAD"));
  // the fix prompt carries the observation, not the story
  await w.hub.fix("sc12");
  expect(w.fixes).toHaveLength(1);
  const again = rehub(w);
  await again.adopt();
  expect(again.record("sc12")?.scenarios?.results[0]?.name).toBe("checkout");
});

test("main moving under the entry runs the scenarios again on the new head", async () => {
  const w = await world();
  await addScenario(w, "a", "make a");
  await readyRun(w, "sc13", "b.txt", "b\n");
  let moved = false;
  w.scenAnswers.set("make a", async () => {
    if (!moved) {
      moved = true;
      await commit(w.repo.path, "c.txt", "c\n");
    }
    return { exit: 0, output: "" };
  });
  await w.hub.land("sc13");
  await w.hub.idle();
  expect(entryOf(w, "sc13")?.state).toBe("landed");
  expect(w.scenarios.filter((c) => c[1] === "make a")).toHaveLength(2);
});

test("no set, or a set of judge scenarios only, runs no pass and leaves the record alone", async () => {
  const w = await world({ noPackage: true });
  await readyRun(w, "sc14", "b.txt", "b\n");
  await w.hub.land("sc14");
  await w.hub.idle();
  expect([entryOf(w, "sc14")?.state, entryOf(w, "sc14")?.noGates, w.scenarios]).toEqual(["landed", true, []]);
  const w2 = await world({ noPackage: true });
  await addScenario(w2, "j", undefined, "---\nname: j\nkind: judge\n---\nstory\n");
  await readyRun(w2, "sc15", "b.txt", "b\n");
  await w2.hub.land("sc15");
  await w2.hub.idle();
  expect([entryOf(w2, "sc15")?.state, entryOf(w2, "sc15")?.noGates, w2.scenarios]).toEqual(["landed", true, []]);
});

test("a docs run with scenarios and no gates joins on its own and lands", async () => {
  const w = await world({ noPackage: true });
  await rulesOn(w, RULES);
  await addScenario(w, "a", "make a");
  await readyRun(w, "sc16", "notes.md", "words\n");
  await w.hub.idle();
  expect(entryOf(w, "sc16")?.auto).toBe(true);
  expect(entryOf(w, "sc16")?.state).toBe("landed");
  expect(w.scenarios.map((c) => c[1])).toEqual(["make a"]);
});

test("a broken .canopy/scenarios.json holds the queue with its reason", async () => {
  const w = await world();
  await commit(w.repo.path, ".canopy/scenarios.json", '{"timeout": 5000}');
  await readyRun(w, "sc17", "b.txt", "b\n");
  await w.hub.land("sc17");
  await w.hub.idle();
  expect(entryOf(w, "sc17")?.state).toBe("waiting");
  expect(entryOf(w, "sc17")?.reason).toContain("timeout must be at most 1800 seconds");
});

test("a runner that throws holds the entry and nothing lands", async () => {
  const w = await world();
  await addScenario(w, "a", "make a");
  await readyRun(w, "sc18", "b.txt", "b\n");
  w.scenAnswers.set("make a", () => { throw new Error("no worktree"); });
  await w.hub.land("sc18");
  await w.hub.idle();
  expect(entryOf(w, "sc18")?.state).toBe("waiting");
  expect(entryOf(w, "sc18")?.reason).toBe("scenarios could not run: no worktree");
  expect(await revOf(w.repo.path, "HEAD")).not.toBe(await revOf(runTreeDir(w.repo.path, "sc18", w.wts), "HEAD"));
});
```

The "docs run joins on its own" test follows the shape of the existing one at `:375`; copy its setup for the README commit and the auto sort if it differs.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/server/landing.test.ts -t "FR-032"`
Expected: FAIL (`scenario` is not a known dep; the turn never calls it).

- [ ] **Step 4: Implement the deps, the pass in `turn`, and `sortRun`'s flag**

Update the module's header comment ("...the gates one at a time, then the repo's scenarios, then fast-forward"). Add the `scenario` dep to every `new LandingHub` in tests (`rehub` and the route tests) so typecheck holds.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/server/landing.test.ts src/server/prs.test.ts && bun run typecheck`
Expected: PASS; typecheck fails only in `src/server/index.ts` for the missing `scenario` dep, which Task 6 adds. If `prs.test.ts` builds a `LandingHub`, give it the stub runner too.

- [ ] **Step 6: Commit**

```bash
git add src/server/landing.ts src/server/landing.test.ts src/server/prs.test.ts
git commit -m "feat(scenarios): the queue runs a repo's scenarios after its gates and writes the pass on the record"
```

---

### Task 6: the routes, the rights and the wiring

**Files:**
- Modify: `src/server/scenarios.ts` (the `Scenarios` class), `src/server/scenarios.test.ts`; `src/core/callers.ts:40-85` (`RULES`), `src/core/callers.test.ts:147`; `src/server/index.ts:211` (import), `:331` (`ServerState`), `:3104` (the handle chain), `:5157` (the hub's deps)

**Interfaces:**
- Consumes: Task 4's functions; `scenarioTemplate`, `GATE_NAME`; `LandingHub.record(id)` for a run's worktree; `runScenario` from `core/check.ts`; `parseLocator` from `core/host.ts`.
- Produces in `src/server/scenarios.ts`:

```ts
export interface ScenarioDeps {
  root: string;
  /** the scan's repo by id */
  repo: (id: string) => Repo | undefined;
  /** a branch run's worktree by the run's id, else undefined */
  runDir: (run: string) => string | undefined;
  run: ScenarioRunner;
  now?: () => number;
}
export class Scenarios {
  constructor(deps: ScenarioDeps);
  /** null for a path outside /api/scenarios */
  handle(req: Request, url: URL): Promise<Response | null>;
}
```

Routes, each answering JSON (a local `json` helper as `server/health.ts:71` has):
- `GET /api/scenarios?repo=` → `{ dir, scenarios: { name, kind, run?, text }[], errors }`; `text` is the file as written.
- `GET /api/scenarios/names?repo=` → `{ names: { name, kind }[], errors }`.
- `POST /api/scenarios` body `{ repo, name, kind?, run? }` → writes `<dir>/<name>.md` from `scenarioTemplate`, making the folder; 400 when `name` fails `GATE_NAME` (`"name must be a short name of letters, digits, dots, dashes or underscores"`), 409 when the file exists (`"a scenario named <name> is there already"`); answers `{ path }` with 201.
- `DELETE /api/scenarios?repo=&name=` → removes the file; 404 when it is not there; `{ ok: true }`.
- `POST /api/scenarios/run` body `{ repo, run? }` → `runScenarioSet` against `runDir(run)` (404 `"no branch run by that id"` when unknown) else the repo's path, with the repo's settings (a bad file is a 409 with its message) and `head` from `git rev-parse HEAD` in that dir (`revOf` from `core/worktree.ts`); answers the `ScenarioRun`.
- Every route: `repo` missing → 400 `"repo is required"`; unknown → 404 `"no repo by that id"`; a repo whose locator has a host → 400 `"scenarios run only for a repo on this backend"`.

Rights in `core/callers.ts`, written out so the test pins them:

```ts
{ methods: ["GET"], paths: ["scenarios"], right: "admin" },
{ methods: POST_DEL, paths: ["scenarios"], right: "admin" },
{ methods: POST, paths: ["scenarios/run"], right: "operate" },
```

with the comment: "the set's text is the holdout: a page or the CLI reads it, a shell or the ranger does not; names and a run are for everyone who operates".

Wiring in `src/server/index.ts`: `scenarios: Scenarios` on `ServerState`, built after `landing` as

```ts
scenarios: new Scenarios({
  root: scenariosRoot(),
  repo: (id) => state.result.repos.find((r) => r.id === id),
  runDir: (id) => state.landing.record(id)?.dir,
  run: runScenario,
}),
```

(use whatever late-binding the file uses for `state` in other deps, as `landing`'s `repo` does); the hub's deps gain `scenario: runScenario`; the handle chain gets `const scenariosRes = await state.scenarios.handle(req, url); if (scenariosRes) return scenariosRes;` right after the landing line.

- [ ] **Step 1: Write the failing rights test in `src/core/callers.test.ts`**

```ts
test("scenario routes: the set's text needs admin, names read, a run operate", () => {
  expect(needs("GET", "/api/scenarios")).toBe("admin");
  expect(needs("GET", "/api/scenarios/names")).toBe("read");
  expect(needs("POST", "/api/scenarios")).toBe("admin");
  expect(needs("DELETE", "/api/scenarios")).toBe("admin");
  expect(needs("POST", "/api/scenarios/run")).toBe("operate");
  expect(allows("shell", needs("GET", "/api/scenarios"))).toBe(false);
  expect(allows("shell", needs("GET", "/api/scenarios/names"))).toBe(true);
  expect(allows("shell", needs("POST", "/api/scenarios/run"))).toBe(true);
  expect(allows("cli", needs("GET", "/api/scenarios"))).toBe(true);
});
```

- [ ] **Step 2: Write the failing route tests in `src/server/scenarios.test.ts`**

```ts
function hub(repoPath: string, runDir?: string, answers: Record<string, { exit: number; output: string }> = {}) {
  const repo: Repo = { id: "r", name: "r", path: repoPath, group: "", source: "root", status: null };
  const calls: string[] = [];
  const s = new Scenarios({
    root,
    repo: (id) => (id === "r" ? repo : undefined),
    runDir: (id) => (id === "run1" ? runDir : undefined),
    run: async (_cwd, line) => {
      calls.push(line);
      return answers[line] ?? { exit: 0, output: "" };
    },
    now: () => 42,
  });
  const call = (method: string, path: string, body?: unknown) =>
    s.handle(new Request(`http://x${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), new URL(`http://x${path}`));
  return { s, call, calls };
}

test("the routes: add writes a template, list and names, run against main and against a run, delete", async () => {
  const repo = join(root, "r8");
  await mkdir(repo, { recursive: true });
  const { call, calls } = hub(repo, "/wt/run1");
  const add = (await call("POST", "/api/scenarios", { repo: "r", name: "checkout", run: "make checkout" }))!;
  expect(add.status).toBe(201);
  const { path } = (await add.json()) as { path: string };
  expect(path).toBe(join(setDirOf(root, repo), "checkout.md"));
  expect(await readFile(path, "utf8")).toBe("---\nname: checkout\nkind: command\nrun: make checkout\n---\n");
  expect((await call("POST", "/api/scenarios", { repo: "r", name: "checkout" }))!.status).toBe(409);
  expect((await call("POST", "/api/scenarios", { repo: "r", name: "../x" }))!.status).toBe(400);
  expect((await call("POST", "/api/scenarios", { repo: "r", name: "a/b" }))!.status).toBe(400);
  const list = (await (await call("GET", "/api/scenarios?repo=r"))!.json()) as { scenarios: { name: string; text: string }[] };
  expect(list.scenarios.map((s) => s.name)).toEqual(["checkout"]);
  expect(list.scenarios[0]!.text).toContain("run: make checkout");
  expect(await (await call("GET", "/api/scenarios/names?repo=r"))!.json()).toEqual({ names: [{ name: "checkout", kind: "command" }], errors: [] });
  const onMain = (await (await call("POST", "/api/scenarios/run", { repo: "r" }))!.json()) as ScenarioRun;
  expect([onMain.total, onMain.passed, onMain.at]).toEqual([1, 1, 42]);
  await call("POST", "/api/scenarios/run", { repo: "r", run: "run1" });
  expect(calls).toEqual(["make checkout", "make checkout"]);
  expect((await call("POST", "/api/scenarios/run", { repo: "r", run: "nope" }))!.status).toBe(404);
  expect((await call("DELETE", "/api/scenarios?repo=r&name=checkout"))!.status).toBe(200);
  expect((await call("DELETE", "/api/scenarios?repo=r&name=checkout"))!.status).toBe(404);
  expect(existsSync(path)).toBe(false);
  expect((await call("GET", "/api/scenarios?repo=zzz"))!.status).toBe(404);
  expect((await call("GET", "/api/scenarios"))!.status).toBe(400);
  expect(await call("GET", "/api/other")).toBeNull();
});

test("a repo on another host is refused", async () => {
  const { call } = hub("ssh://mini/home/eric/dev/x");
  const res = (await call("GET", "/api/scenarios/names?repo=r"))!;
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "scenarios run only for a repo on this backend" });
});
```

The `run` against a run's worktree needs `revOf` to answer: use a real git repo for `runDir` in that test if `revOf` on `/wt/run1` makes the route fail; `head` may be `""` for a dir with no git, which is fine for the route.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/core/callers.test.ts src/server/scenarios.test.ts`
Expected: FAIL on the new tests only.

- [ ] **Step 4: Add the rules, the `Scenarios` class and the wiring**

- [ ] **Step 5: Run the tests and typecheck**

Run: `bun test src/core/callers.test.ts src/server/scenarios.test.ts src/server/landing.test.ts && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/scenarios.ts src/server/scenarios.test.ts src/core/callers.ts src/core/callers.test.ts src/server/index.ts
git commit -m "feat(scenarios): the scenario routes, their rights and the server wiring"
```

---

### Task 7: `canopy scenarios`

**Files:**
- Create: `src/cli/scenarios.ts`, `src/cli/scenarios.test.ts`
- Modify: `src/cli/index.ts:855` (a `case "scenarios"` beside `land`), its `HELP` text; `README.md:79` (after the `canopy queue` line)

**Interfaces:**
- Consumes: `ask`, `take`, `has`, `errText`, `Unreachable`, `Target` from `./health` as `src/cli/land.ts` does; `ScenarioRun` from `core/types.ts`.
- Produces in `src/cli/scenarios.ts`:

```ts
export const SCENARIOS_USAGE =
  "usage: canopy scenarios <repo> [--backend URL]\n       canopy scenarios <repo> add <name> [--judge] [--run CMD] [--backend URL]\n       canopy scenarios <repo> run [<run>] [--backend URL]";
/** the list: one line per scenario, `name  kind`; errors as `file  cannot be read: why`; a line that says how to add one when empty */
export function listLines(repo: string, got: { names: { name: string; kind: string }[]; errors: { file: string; error: string }[] }): string[];
/** `scenarios 2/3 · 0.67`, then `ok name` or `red name  <last line of its tail>` per result */
export function runLines(run: ScenarioRun): string[];
export async function scenariosCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void>;
```

`scenariosCommand`: `<repo>` is the repo id the backend knows (as `canopy land --all` takes it); no subcommand lists (`GET /api/scenarios/names`); `add` posts and prints `wrote <path>`; `run` posts `/api/scenarios/run` and prints `runLines`, exiting 1 when `passed < total` (`fail` with the lines joined). The README gets:

```
canopy scenarios <repo>                     # the repo's holdout scenarios, name and kind; the text never leaves the server's config dir
canopy scenarios <repo> add <name> [--judge] [--run CMD]   # a new scenario file under <configDir>/scenarios/<repo key>/; edit it there
canopy scenarios <repo> run [<run>]         # run the set against a branch run's worktree, else against the main checkout
```

- [ ] **Step 1: Write the failing tests in `src/cli/scenarios.test.ts`**

```ts
import { expect, test } from "bun:test";
import type { ScenarioRun } from "../core/types";
import { listLines, runLines } from "./scenarios";

test("listLines", () => {
  expect(listLines("dev-tools/canopy", { names: [{ name: "checkout", kind: "command" }, { name: "refund", kind: "judge" }], errors: [{ file: "x.md", error: "x.md: name must be a short name of letters, digits, dots, dashes or underscores" }] })).toEqual([
    "dev-tools/canopy",
    "  checkout         command",
    "  refund           judge",
    "  x.md             cannot be read: x.md: name must be a short name of letters, digits, dots, dashes or underscores",
  ]);
  expect(listLines("r", { names: [], errors: [] })).toEqual(["no scenarios for r; add one with canopy scenarios r add <name>"]);
});

test("runLines", () => {
  const run: ScenarioRun = { head: "h", at: 1, total: 3, passed: 1, score: 1 / 3, results: [{ name: "a", kind: "command", ok: true, tail: "fine" }, { name: "b", kind: "command", ok: false, tail: "lots\n1 fail" }] };
  expect(runLines(run)).toEqual(["scenarios 1/3 · 0.33", "  ok   a", "  red  b  1 fail"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/cli/scenarios.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/cli/scenarios.ts`, the `case`, the help and the README lines**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/cli/ && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/scenarios.ts src/cli/scenarios.test.ts src/cli/index.ts README.md
git commit -m "feat(scenarios): canopy scenarios lists, adds and runs a repo's set"
```

---

### Task 8: the sheet's line

**Files:**
- Modify: `ui/src/landing.ts:124-183` (`RunLanding`, `runLanding`), `ui/src/landing.test.ts`, `ui/src/components/RunSheet.tsx:617-630`, `ui/src/styles.css` (after `.run-branch-why` at `:4806`)

**Interfaces:**
- Consumes: `ScenarioRun` from `src/core/types.ts`.
- Produces in `ui/src/landing.ts`:

```ts
export interface RunLanding { ...; /** the set's latest pass over the branch */ scenarios?: ScenarioRun }
/** "scenarios 7/8 · 0.88" */
export const scenarioLine = (s: Pick<ScenarioRun, "total" | "passed" | "score">): string;
/** "rust" when a scenario went red, else "moss" */
export const scenarioTone = (s: Pick<ScenarioRun, "total" | "passed">): "moss" | "rust";
```

`runLanding` sets `scenarios` from the record (`info.runs.find((r) => r.id === b.origin)?.scenarios`) in both of its branches (an entry's and a ready run's), so a sent-back run and a landed one both show it.

In `RunSheet.tsx`, after the `l.entry?.reason` span inside `.run-branch`:

```tsx
{l.scenarios && (
  <details className="run-scenarios">
    <summary className={`run-branch-why ${scenarioTone(l.scenarios)}`} title="The repo's holdout scenarios over this branch; their text stays on the server">{scenarioLine(l.scenarios)}</summary>
    <ul>
      {l.scenarios.results.map((r) => (
        <li key={r.name} className={r.ok ? "" : "rust"}>
          <span>{r.ok ? "ok" : "red"}</span> <span>{r.name}</span> <span className="dim">{r.kind}</span>
          {r.tail && <pre>{r.tail}</pre>}
        </li>
      ))}
    </ul>
  </details>
)}
```

CSS: `.run-scenarios` is `font-size: inherit`; `.run-scenarios ul` has no bullets and the sheet's usual gap; `.run-scenarios pre` reuses the rules `.landing-why + pre` or the existing `pre` style in the landing section (`Landing.tsx:167` renders one) so a tail scrolls rather than widens the sheet. Read `.run-branch-why` and `.landing-state.rust` first and reuse their tokens; no new colors.

- [ ] **Step 1: Write the failing tests in `ui/src/landing.test.ts`**

```ts
test("scenarioLine and scenarioTone", () => {
  expect(scenarioLine({ total: 8, passed: 7, score: 0.875 })).toBe("scenarios 7/8 · 0.88");
  expect(scenarioLine({ total: 2, passed: 2, score: 1 })).toBe("scenarios 2/2 · 1.00");
  expect(scenarioTone({ total: 8, passed: 7 })).toBe("rust");
  expect(scenarioTone({ total: 2, passed: 2 })).toBe("moss");
});

test("runLanding carries the record's scenarios for a queued entry and a ready run", () => {
  const pass = { head: "h", at: 1, total: 1, passed: 1, score: 1, results: [] };
  const r = rec("a", { scenarios: pass });
  const entries = enqueue([], r, 1);
  const run = fakeRun("a") /* the file's helper for a branch run with origin "a" */;
  expect(runLanding(run, { runs: [r], entries, orphans: [] })?.scenarios).toEqual(pass);
  expect(runLanding(run, { runs: [r], entries: [], orphans: [] })?.scenarios).toEqual(pass);
});
```

Use the file's existing run-building helper in place of `fakeRun` (read the first `runLanding` test and copy its shape).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ui/src/landing.test.ts`
Expected: FAIL on the two new tests.

- [ ] **Step 3: Implement the helpers, the sheet block and the CSS**

- [ ] **Step 4: Run the tests, typecheck, lint and build**

Run: `bun test ui/src && bun run typecheck && bun run lint && bun run build`
Expected: PASS, clean, built. Then look at it: start a scratch server as the memory note "Scratch canopy server for UI checks" says, land a branch run in a repo with a scenario set, and open its sheet; the line reads `scenarios 1/1 · 1.00` and folds open to the result.

- [ ] **Step 5: Commit**

```bash
git add ui/src/landing.ts ui/src/landing.test.ts ui/src/components/RunSheet.tsx ui/src/styles.css
git commit -m "feat(scenarios): the run sheet shows the set's pass over the branch"
```

---

### Task 9: the docs and the gates

**Files:**
- Modify: `docs/architecture.md:150` (after the gates paragraph under "The landing queue"), `SPEC.md:57-58`, `README.md` (the landing queue feature paragraph), `FEATURES.md:75-78` and `:128`, `docs/superpowers/plans/README.md`

- [ ] **Step 1: `docs/architecture.md`**

One paragraph after the `core/gates.ts` paragraph, starting "Scenarios (FR-032, plan 1).", saying: where a set lives and that no checkout names it; `core/scenario.ts` parses a file (frontmatter `name`, `kind`, `run`, `evidence`, the body) and `.canopy/scenarios.json` (`run`, `judge`, `minimum`, `timeout`, read from the main checkout like gates); `server/scenarios.ts` reads the set, copies it to a temp dir the line sees as `SCENARIO_DIR`, runs the command scenarios in file order through `deps.scenario` (`runScenario`: a gate's environment plus that variable, under the set's timeout) and stops at the first red; the turn runs the pass after the last gate and before the moved check, the `scenarios` state and `landWord`'s "scenario: name"; a red entry's gate is `scenario: <name>`, its reason the output tail, `fixPrompt` hands the agent the observation and says the scenario is not shown; the pass is written on the record as `LandingRun.scenarios` and runs again after every rebase; a bad file is a red result named by the file; judge scenarios parse and are listed but wait for plan 2; `hasGates` for the sort counts command scenarios; the routes and their rights; the CLI. Add `SCENARIO_GATE` and `scenarioOf` where the paragraph names the red entry.

- [ ] **Step 2: `SPEC.md`**

Line 57: add `scenarios/<repo key>/` ("a repo's holdout scenarios, one markdown file each, written by hand and by `canopy scenarios add`; never synced with the repo") to the config dir list, before `landing/`. Line 58: add `.canopy/scenarios.json` ("the scenarios' default run line, judge, minimum and timeout") to the in-repo list.

- [ ] **Step 3: `README.md`**

In the features list, in the landing queue's bullet (find it with `grep -n "landing queue" README.md`), one sentence: after the gates, the queue runs the repo's holdout scenarios kept under the config dir, which a run never sees; a red one sends the branch back with the scenario's name and output. The CLI lines were added in Task 7.

- [ ] **Step 4: `FEATURES.md` and the plans README**

Move the `### FR-032` block from `## Open` to the top of `## In Progress` and append to its Spec line: `Plan 1 shipped <date> (command scenarios in the queue, the record, the sheet's line, canopy scenarios); plans 2 (judge scenarios) and 3 (the PR watch's pass, the repo panel's list) open.` In `docs/superpowers/plans/README.md`, add the first row: `| [Scenario gates, plan 1: command scenarios in the landing queue](2026-10-26-scenario-gates-1.md) | shipped | <date> | [scenario gates](../specs/2026-10-25-scenario-gates-design.md) |` and set this plan's Status line to shipped with the merge commit.

- [ ] **Step 5: Run every gate**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass. Then `~/.claude/skills/verify-build/clean-rebuild.sh verify "scenarioLine"` proves the served bundle is the new one.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md SPEC.md README.md FEATURES.md docs/superpowers/plans/README.md docs/superpowers/plans/2026-10-26-scenario-gates-1.md
git commit -m "docs(scenarios): architecture, SPEC, README and the feature list for plan 1"
```

---

## Live check, before the branch is called done

With a scratch canopy (the "Scratch canopy server for UI checks" memory note) pointed at a throwaway repo that has `package.json` scripts for `test` only:

1. `canopy scenarios <repo> add smoke --run 'test -f "$SCENARIO_DIR/smoke.md"'`, then `canopy scenarios <repo>` lists `smoke  command`.
2. `canopy scenarios <repo> run` prints `scenarios 1/1 · 1.00`.
3. A branch run that edits a file lands: the landing row reads `scenario: smoke` for a moment, the sheet shows the line, `~/.config/<scratch>/landing/runs/<id>.json` holds `scenarios`.
4. `canopy scenarios <repo> add fail --run 'echo observed; exit 1'`; the next branch run comes back `red: scenario: fail`, its reason is `observed`, "fix it" starts a run whose first message names the scenario and shows `observed` and nothing else about it.
5. A shell token's `curl .../api/scenarios?repo=` is a 403; `/api/scenarios/names` answers.

## Decisions this plan makes beyond the spec

- A scenario file that cannot be parsed is a red result named by its file, listed before anything runs. The spec says a bad file is named and the rest still run; failing closed keeps a broken holdout from passing in silence, and the rest are still listed, so Eric sees both at once.
- Judge scenarios parse and are listed but are left out of the pass and the record until plan 2. The alternative, holding the entry as `waiting`, would re-run the gates every `RETRY_EVERY` (30 s) because `retry()` requeues every waiting entry; plan 2 needs a hold that waits for Eric's "land anyway" and is the right place to add one.
- `score` in plan 1 is `passed / total`, with scenarios after a red counted 0 since they did not run. The sheet shows it beside the count as the spec draws it, so plan 2 changes the number and not the line.
- `readScenarioSet` lives in `server/scenarios.ts`, not `core/scenario.ts`, so the core file stays browser-safe for the UI.
- `/api/scenarios/run` never writes the record; only the queue's own pass does.
