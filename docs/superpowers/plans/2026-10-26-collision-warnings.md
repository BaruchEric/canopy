# Collision warnings: a live touched set per run and a chip when two overlap (FR-040)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** implemented and independently reviewed locally 2026-10-27 on `main`. Written on main at 1ac8fe7.

**Goal:** every run's tool calls carry the files they touch; the server folds
them into a set per live run and compares each run with the other runs, the
queued branches and the main checkout's uncommitted files of its repo; an
overlap is a note on the run's timeline, a word into an idle chat, a quiet
inbox line and an `⚠ overlaps` chip on the landing rows, and never a hold.

**Architecture:** `core/explain.ts` gains `writtenPaths`, the files a shell
line writes; the drivers put a tool call's paths on `RunTool.paths`; a pure
model (`core/touch.ts`) folds steps into a `Touched` set and finds overlaps;
`server/collisions.ts` keeps one set per live run from the runner's changes,
compares, and speaks through the runner and the landing hub; the queue marks
an entry's overlap at enqueue; the CLI and the page read it all off
`LandingInfo`. Nothing is written to disk but the inbox notice.

**Tech Stack:** Bun, TypeScript strict, React 19, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-collision-warnings-design.md`,
its "Plans" section's one plan. The index is
`docs/superpowers/specs/2026-10-25-software-factory-borrowings-design.md`.

## Global constraints

- At most `TOUCH_MAX` (500) distinct paths per run; past that the set reads "500 files and more" and matches nothing.
- A pair is spoken of once when it first collides and again only when its overlap gained `COLLISION_RESAY` (5) paths. A note lists at most 5 paths, then "and n more".
- Reads are not touches: `Read`, `Grep`, `Glob` and every other tool add nothing.
- A path outside the repo is kept absolute and never matched.
- Two `Touched` with the same `origin` or the same `group` never overlap.
- Never a hold: nothing here stops, delays or refuses a run or a landing.
- The chip's word is `⚠ overlaps`; the notice's kind is `collision`, kept in `landing/notices.json` and cleared by `POST /api/landing/seen`, outside the inbox's count.
- `LandingInfo.collisions` rides on `GET /api/landing` and the `landing` event; no new route, so no callers rule.
- `core/touch.ts` and `core/explain.ts` are imported by the page: no `node:` or `bun` import in either.
- Strict TypeScript with `noUncheckedIndexedAccess`; no `any`, no `as` casts.
- Plain words, no em dashes, sentence case headings (the unslop rules apply to docs and commit messages).
- All four gates pass before a task is done: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.

## Review focus

Inputs the spec implies and no section of it names. Each has a test in the task that owns the code.

1. A Bash line run from a subfolder (Codex names its cwd): `touch x.ts` with cwd `<root>/src` reads `src/x.ts`, so a path is never matched under the wrong name (Task 1).
2. A tool call on a file outside the repo (`/etc/hosts`): the path stays absolute on the step and `overlap` skips it, so two runs editing one file in `~` never collide and the set still shows it (Task 2).
3. A run rewriting the tree (a formatter over 600 files): the set stops at `TOUCH_MAX` and matches nothing, rather than pairing with every other run in the repo (Task 2).
4. The checkout's own run, whose edits are the checkout's uncommitted files: it is never compared with the checkout side, else every edit would collide with itself (Task 5).
5. A chat that goes from idle to working between the hub's check and its `say`: the runner's throw is caught, the say stays pending, and it is said at the next idle while the pair stands (Task 5).

---

## File structure

- Modify `src/core/explain.ts` and `src/core/explain.test.ts`: `WrittenPaths`, `writtenPaths`.
- Create `src/core/touch.ts` (pure, browser-safe) and `src/core/touch.test.ts`: `Touched`, `Collision`, `Side`, the constants, `touchedOf`, `addStep`, `fromFiles`, `fromStatus`, `overlap`, `collide`, `pairId`, `flipped`, `relPath`, `toolTouch`, the words. (`ui/src/touch.ts` is a different file, the shell's finger gestures; leave it alone.)
- Modify `src/core/types.ts`: `RunTool.paths`, `RunTool.touchesUnknown`, `LandEntry.overlap`, `LandNotice.kind`, `LandingInfo.collisions`, `RepoAgent.collisionSay`.
- Modify `src/core/claudedrive.ts`, `src/core/claudedrive.test.ts`, `src/core/testdata/fake-claude.ts`, `src/core/codexrun.ts`, `src/core/codexrun.test.ts`: paths at tool time.
- Modify `src/core/landing.ts` and `src/core/landing.test.ts`: `enqueue`'s working sets, `fixPrompt`'s line.
- Modify `src/core/route.ts` and `src/core/route.test.ts`: `collisionSay` through the normalizer.
- Modify `src/core/runner.ts`: `note`.
- Create `src/server/collisions.ts` and `src/server/collisions.test.ts`: `CollisionHub`.
- Modify `src/server/landing.ts`, `src/server/landing.test.ts`, `src/server/index.ts`: the hub's hooks and the wiring.
- Modify `src/cli/land.ts`, `src/cli/land.test.ts`, `src/cli/index.ts`, `README.md`: the queue line and `canopy collisions`.
- Modify `ui/src/landing.ts`, `ui/src/landing.test.ts`, `ui/src/waiting.ts`, `ui/src/waiting.test.ts`, `ui/src/store.ts`, `ui/src/components/Landing.tsx`, `ui/src/components/RunSheet.tsx`, `ui/src/styles.css`.
- Modify `docs/architecture.md`, `FEATURES.md`, `docs/superpowers/plans/README.md`. `SPEC.md` is read and left as it is (no file on disk changes shape).

---

### Task 1: the files a shell line writes

**Files:**
- Modify: `src/core/explain.ts:977` (beside `explainCommand`), `src/core/explain.test.ts`

**Interfaces:**
- Consumes, all private to `explain.ts` and reused in place: `splitShell` (`:225`), `reaches` (`:311`), `norm` (`:260`), `inside` (`:270`), `operands` (`:400`), `explainCommand` (`:977`).
- Produces in `src/core/explain.ts`:

```ts
export interface WrittenPaths {
  /** files the line writes, moves, removes or restores, as paths from `root`; one outside it is kept absolute */
  paths: string[];
  /** folders a command moved or removed whole, same form: `mv` and `git mv` operands, `rm -r`, `rmdir`, `git rm -r` */
  dirs: string[];
  /** `explainCommand` read the line as opaque or vague: canopy cannot say what it writes, and nothing is listed */
  unknown: boolean;
}
/** The files a shell line writes, for the touched set (FR-040). */
export function writtenPaths(command: string, root: string, cwd: string = root): WrittenPaths;
```

Rules: `explainCommand(command, root, cwd)` first; `opaque` or `vague` is `{ paths: [], dirs: [], unknown: true }`. Else, over each simple command of `splitShell`: every redirect target in `writes` (not `/dev/null` and the `/dev/std*`, `/dev/fd/*` and `/dev/tty` names `outsidePath` already lets through); by the program's base name: `tee` and `touch` operands; `cp` and `install` the last operand when there are two or more; `mv` operands to `dirs`; `rm`, `unlink`, `trash` operands, to `dirs` when a flag is `--recursive` or a short cluster holds `r` or `R`, else to `paths`; `rmdir` operands to `dirs`; `sed -i` and `perl -i` the files as the in-place block at `:805-809` picks them; `git mv` operands to `dirs`; `git rm` as `rm`; `git checkout -- <paths>` the operands after `--`; `git restore` its operands. Every operand goes through `reaches`, then `norm(p, cwd)`: inside `root` it is the path from the root (the root itself is left out), else the absolute path as normalised, and a `~` path as written. Distinct, in the order met.

- [ ] **Step 1: Write the failing tests in `src/core/explain.test.ts`**

A new `describe` after the `splitShell` one:

```ts
describe("writtenPaths", () => {
  const wp = (c: string, cwd = ROOT) => writtenPaths(c, ROOT, cwd);
  const none = { dirs: [], unknown: false };
  test("redirects, tee, touch, cp's last operand, sed -i", () => {
    expect(wp("echo hi > notes.md")).toEqual({ paths: ["notes.md"], ...none });
    expect(wp("ls src 2>/dev/null >> build.log")).toEqual({ paths: ["build.log"], ...none });
    expect(wp("ls src | tee -a out.txt")).toEqual({ paths: ["out.txt"], ...none });
    expect(wp("touch src/new.ts docs/x.md")).toEqual({ paths: ["src/new.ts", "docs/x.md"], ...none });
    expect(wp("cp a.ts b.ts src/c.ts")).toEqual({ paths: ["src/c.ts"], ...none });
    expect(wp("sed -i '' 's/a/b/' src/a.ts src/b.ts")).toEqual({ paths: ["src/a.ts", "src/b.ts"], ...none });
    expect(wp("sed -i -e s/a/b/ x.ts")).toEqual({ paths: ["x.ts"], ...none });
  });
  test("moves and removals, whole folders apart", () => {
    expect(wp("mv src/a src/b")).toEqual({ paths: [], dirs: ["src/a", "src/b"], unknown: false });
    expect(wp("rm src/a.ts")).toEqual({ paths: ["src/a.ts"], ...none });
    expect(wp("rm -rf docs/old build")).toEqual({ paths: [], dirs: ["docs/old", "build"], unknown: false });
    expect(wp("git mv src/a src/b && git rm -r docs/old && git rm x.ts")).toEqual({ paths: ["x.ts"], dirs: ["src/a", "src/b", "docs/old"], unknown: false });
    expect(wp("git checkout -- src/a.ts && git restore --staged src/b.ts")).toEqual({ paths: ["src/a.ts", "src/b.ts"], ...none });
  });
  test("a heredoc into a file, the cwd, and a path outside the repo kept absolute", () => {
    expect(wp("cat > notes.md <<'EOF'\nhi\nEOF")).toEqual({ paths: ["notes.md"], ...none });
    expect(wp("touch x.ts", `${ROOT}/src`)).toEqual({ paths: ["src/x.ts"], ...none });
    expect(wp("cp a.ts /tmp/a.ts")).toEqual({ paths: ["/tmp/a.ts"], ...none });
  });
  test("reads add nothing; an opaque or vague line adds nothing and says so", () => {
    expect(wp("cat a.ts && grep x src && git diff")).toEqual({ paths: [], ...none });
    expect(wp("sh -c 'touch x'")).toEqual({ paths: [], dirs: [], unknown: true });
    expect(wp("echo $(date) > out.txt")).toEqual({ paths: [], dirs: [], unknown: true });
    expect(wp("frobnicate --out x.ts")).toEqual({ paths: [], dirs: [], unknown: true });
  });
});
```

Import `writtenPaths` with the rest.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/explain.test.ts -t writtenPaths`
Expected: FAIL, `writtenPaths` is not exported.

- [ ] **Step 3: Implement `writtenPaths`**

Add one line to the file's header comment: it also lists the files a line writes, for the touched set.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/explain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/explain.ts src/core/explain.test.ts
git commit -m "feat(collisions): writtenPaths lists the files a shell line writes (FR-040)"
```

---

### Task 2: the touched set and the words

**Files:**
- Create: `src/core/touch.ts`, `src/core/touch.test.ts`
- Modify: `src/core/types.ts:1018-1026` (`RunTool`)

**Interfaces:**
- Consumes: `Run`, `RunStep`, `RunTool`, `ReviewFile`, `RepoFile` from `./types` (type imports only, so the two files never cycle at runtime); `WrittenPaths` from `./explain`.
- Produces in `src/core/types.ts`, on `RunTool`:

```ts
  /** the files the call touches, as paths from the run's folder (its
   *  worktree or checkout); one outside it is kept absolute. A path ending
   *  in `/` is a folder moved or removed whole. Set for Edit, Write,
   *  MultiEdit, NotebookEdit and what a Bash line writes (`writtenPaths`);
   *  reading is not touching (FR-040) */
  paths?: string[];
  /** a Bash line canopy could not read (opaque or vague): it may have written anything */
  touchesUnknown?: true;
```

- Produces in `src/core/touch.ts`:

```ts
export const TOUCH_MAX = 500;
export const COLLISION_RESAY = 5;
export const PATHS_SHOWN = 5;

export interface Touched {
  run: string;
  /** the words chips and notes name the run by: its branch, else "<verb> run <id>" */
  name: string;
  /** the branch's id for a branch run, so the origin and its "fix it" runs read as one */
  origin?: string;
  /** FR-033's `Run.group`: members of one group never collide */
  group?: string;
  paths: Set<string>;
  /** directories a command moved or removed whole: `git mv src/a src/b`, `rm -r docs/old` */
  dirs: Set<string>;
  unknown: boolean;
}

export interface Collision {
  id: string;
  repoId: string;
  /** the run that just touched, and what it collided with */
  run: string;
  /** that run's name, as `Touched.name` */
  name: string;
  with: { kind: "run"; run: string; verb: string; name: string } | { kind: "branch"; origin: string; branch: string } | { kind: "checkout" };
  paths: string[];
  at: number;
}

/** one side a run is compared with */
export interface Side {
  touched: Touched;
  with: Collision["with"];
}

/** `p` from `root`: the path under it, else `p` as given */
export function relPath(p: string, root: string): string;
/** a Bash line's `WrittenPaths` as the step carries them: dirs with a trailing `/` */
export function toolTouch(w: WrittenPaths): Pick<RunTool, "paths" | "touchesUnknown">;
/** the set from every step so far; `group` is `Run.group` once FR-033 ships */
export function touchedOf(run: Pick<Run, "id" | "verb" | "steps" | "branch">, group?: string): Touched;
/** extends `t` with one step and returns it; a tool step's `paths` only, nothing past TOUCH_MAX */
export function addStep(t: Touched, step: RunStep): Touched;
/** a queued or ready branch's set from its sort: each file's `path` and `from` */
export function fromFiles(run: string, origin: string, name: string, files: readonly Pick<ReviewFile, "path" | "from">[]): Touched;
/** the main checkout's set: `RepoStatus.files`; `run` is "checkout", `name` "your uncommitted changes" */
export function fromStatus(files: readonly Pick<RepoFile, "path">[]): Touched;
/** "n files", or "500 files and more" once full */
export function touchedWords(t: Touched): string;
/** the paths both hold, plus any path of one under a dir of the other (a dir under
 *  a dir gives the deeper one with its `/`), sorted; [] for the same run, origin
 *  or group, for a full set on either side, and for absolute paths */
export function overlap(a: Touched, b: Touched): string[];
/** the pair's id, the same from either side: "a+b" sorted for two runs, "a+branch:q", "a+checkout" */
export function pairId(run: string, w: Collision["with"]): string;
/** the same collision from the other run's view (run kind only; `verb` is that run's) */
export function flipped(c: Collision, verb: string): Collision;
/** Folds `me` against each side into the live list: a new pair is added, a
 *  known one keeps its id, `at` and orientation and takes the paths as they are
 *  now, one with no overlap left goes. `fresh` are the new pairs; `grown` the
 *  known ones whose paths outnumber `saidAt`'s count for them by COLLISION_RESAY. */
export function collide(live: readonly Collision[], me: Touched, sides: readonly Side[], repoId: string, now: number, saidAt: ReadonlyMap<string, number>): { live: Collision[]; fresh: Collision[]; grown: Collision[] };

export function pathList(paths: readonly string[]): string;
/** "also being edited by <verb> run <id>: <paths>" */
export function noteLine(by: { verb: string; run: string }, paths: readonly string[]): string;
/** the note on the touching run's timeline */
export function collisionLine(c: Collision): string;
/** the other side's name: the run's, the branch's, or "your uncommitted changes" */
export function withName(w: Collision["with"]): string;
/** the inbox's line, and the attention row's for the checkout */
export function collisionNotice(c: Collision): string;
/** what an idle chat is told; `when` is "3m ago" */
export function collisionSay(c: Collision, when: string): string;
/** what a coordinator is told about two of its children */
export function childrenSay(a: string, b: string, paths: readonly string[]): string;
```

The words, exactly:
- `pathList`: the first `PATHS_SHOWN` joined by `, `, then ` and <n> more` when there are more.
- `noteLine`: `also being edited by <verb> run <run>: <pathList>` (a run id is 8 characters already, so it is the spec's short id).
- `collisionLine`: run kind is `noteLine` with the other side; branch kind `also in queued branch <branch>: <pathList>`; checkout `also changed in the main checkout, uncommitted: <pathList>`.
- `collisionNotice`: checkout kind `your uncommitted changes to <pathList> overlap <name>; the landing will wait for them`; else `<name> and <withName> both edit <pathList>`.
- `collisionSay`: run kind `canopy: another run (<verb>, started <when>) has edited these files since you started: <<< <paths joined by ", "> >>>. Carry on; the queue rebases when you land.`; branch kind the same with `a queued branch (<branch>)` in place of the parenthesised run; checkout `canopy: the main checkout has uncommitted changes to these files: <<< … >>>. Carry on; the landing waits for them.`
- `childrenSay`: `canopy: two of your runs (<a> and <b>) edit the same files: <<< … >>>. Carry on or re-plan; nothing is held.`
- `touchedOf`'s name: `run.branch?.name`, else `<verb> run <id>`.

- [ ] **Step 1: Add the two `RunTool` fields to `src/core/types.ts`**

Run `bun run typecheck`; it stays clean.

- [ ] **Step 2: Write the failing tests in `src/core/touch.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { addStep, childrenSay, collide, collisionLine, collisionNotice, collisionSay, COLLISION_RESAY, flipped, fromFiles, fromStatus, noteLine, overlap, pairId, pathList, relPath, toolTouch, touchedOf, touchedWords, TOUCH_MAX, withName, type Collision } from "./touch";
import type { Run, RunStep } from "./types";

const tool = (id: string, paths?: string[], unknown?: true): RunStep => ({ id, at: 1, kind: "tool", tool: { name: "Edit", title: "edit", status: "ok", ...(paths ? { paths } : {}), ...(unknown ? { touchesUnknown: true } : {}) } });
const run = (id: string, steps: RunStep[], over: Partial<Pick<Run, "verb" | "branch">> = {}): Pick<Run, "id" | "verb" | "steps" | "branch"> => ({ id, verb: "Plan, then build", steps, branch: { name: `run/x-${id}`, target: "main", base: "b0", dir: `/w/${id}`, state: "working", origin: id }, ...over });
const edits = (id: string, ...paths: string[]) => touchedOf(run(id, [tool("1", paths)]));

describe("the touched set", () => {
  test("touchedOf folds tool steps: files, folders, unknown lines, an outside path kept and never matched", () => {
    const t = touchedOf(run("a", [tool("1", ["src/a.ts"]), { id: "2", at: 1, kind: "text", text: "hi" }, tool("3", ["docs/x.md", "src/old/", "/etc/hosts"]), tool("4", undefined, true), tool("5")]));
    expect([t.run, t.name, t.origin, t.group, t.unknown]).toEqual(["a", "run/x-a", "a", undefined, true]);
    expect([...t.paths]).toEqual(["src/a.ts", "docs/x.md", "/etc/hosts"]);
    expect([...t.dirs]).toEqual(["src/old"]);
    expect(overlap(t, edits("b", "/etc/hosts"))).toEqual([]);
    expect(touchedOf(run("k", [], { branch: undefined })).name).toBe("Plan, then build run k");
    expect(touchedOf(run("g", []), "g-1").group).toBe("g-1");
    expect([...addStep(edits("c", "x.ts"), tool("2", ["y.ts"])).paths]).toEqual(["x.ts", "y.ts"]);
  });
  test("TOUCH_MAX: past 500 distinct paths the set is full, says so, and matches nothing", () => {
    const t = edits("a", ...Array.from({ length: 600 }, (_, i) => `f${i}.ts`));
    expect(t.paths.size).toBe(TOUCH_MAX);
    expect(touchedWords(t)).toBe("500 files and more");
    expect(touchedWords(edits("b", "x"))).toBe("1 file");
    expect(overlap(t, edits("b", "f1.ts"))).toEqual([]);
  });
  test("overlap: shared paths, a path under the other's folder, a folder under a folder, sorted, either way round", () => {
    const a = edits("a", "src/a.ts", "src/b.ts", "docs/old/x.md", "lib/");
    const b = edits("b", "src/b.ts", "src/c.ts", "docs/old/", "lib/util/");
    expect(overlap(a, b)).toEqual(["docs/old/x.md", "lib/util/", "src/b.ts"]);
    expect(overlap(b, a)).toEqual(overlap(a, b));
    expect(overlap(a, edits("c", "q.ts"))).toEqual([]);
  });
  test("the same run, origin or group never overlaps", () => {
    const a = edits("a", "x.ts");
    const fix = touchedOf(run("f1", [tool("1", ["x.ts"])], { branch: { name: "run/x-a", target: "main", base: "b0", dir: "/w/a", state: "working", origin: "a" } }));
    expect(overlap(a, fix)).toEqual([]);
    expect(overlap(a, a)).toEqual([]);
    expect(overlap(touchedOf(run("g1", [tool("1", ["x.ts"])]), "g-1"), touchedOf(run("g2", [tool("1", ["x.ts"])]), "g-1"))).toEqual([]);
    expect(overlap(touchedOf(run("g1", [tool("1", ["x.ts"])]), "g-1"), touchedOf(run("g3", [tool("1", ["x.ts"])]), "g-2"))).toEqual(["x.ts"]);
  });
  test("a branch's sort and the checkout's status as sets; relPath and toolTouch", () => {
    const q = fromFiles("r-q", "q", "run/x-q", [{ path: "b.ts", from: "a.ts" }, { path: "c.ts" }]);
    expect([q.run, q.origin, q.name, [...q.paths]]).toEqual(["r-q", "q", "run/x-q", ["b.ts", "a.ts", "c.ts"]]);
    const k = fromStatus([{ path: "x.ts" }]);
    expect([k.run, k.name, [...k.paths]]).toEqual(["checkout", "your uncommitted changes", ["x.ts"]]);
    expect([relPath("/r/src/a.ts", "/r"), relPath("/etc/hosts", "/r"), relPath("/r", "/r")]).toEqual(["src/a.ts", "/etc/hosts", "."]);
    expect(toolTouch({ paths: ["x.ts"], dirs: ["src/a"], unknown: false })).toEqual({ paths: ["x.ts", "src/a/"] });
    expect(toolTouch({ paths: [], dirs: [], unknown: true })).toEqual({ touchesUnknown: true });
    expect(toolTouch({ paths: [], dirs: [], unknown: false })).toEqual({});
  });
});

describe("collide", () => {
  const side = (t: ReturnType<typeof edits>): Side => ({ touched: t, with: { kind: "run", run: t.run, verb: "Plan, then build", name: t.name } });
  test("one collision per pair, kept from either side, grown, said again after COLLISION_RESAY more paths, gone with its overlap", () => {
    const me = edits("a", "x.ts", "y.ts");
    const first = collide([], me, [side(edits("b", "x.ts"))], "canopy", 5, new Map());
    expect(first.fresh).toEqual([{ id: "a+b", repoId: "canopy", run: "a", name: "run/x-a", with: { kind: "run", run: "b", verb: "Plan, then build", name: "run/x-b" }, paths: ["x.ts"], at: 5 }]);
    expect([first.live, first.grown]).toEqual([first.fresh, []]);
    const said = new Map([["a+b", 1]]);
    const second = collide(first.live, me, [side(edits("b", "x.ts", "y.ts", "z.ts"))], "canopy", 6, said);
    expect([second.fresh, second.grown]).toEqual([[], []]);
    expect(second.live[0]).toMatchObject({ id: "a+b", run: "a", paths: ["x.ts", "y.ts"], at: 5 });
    const six = ["x.ts", "y.ts", "p1", "p2", "p3", "p4"];
    const third = collide(second.live, edits("a", ...six), [side(edits("b", ...six))], "canopy", 7, said);
    expect(third.grown.map((c) => [c.id, c.paths.length])).toEqual([["a+b", 6]]);
    expect(collide(third.live, me, [side(edits("b", "q.ts"))], "canopy", 8, said).live).toEqual([]);
    // from b's side the pair is the same, kept as first recorded
    const fromB = collide(first.live, edits("b", "x.ts", "y.ts"), [side(me)], "canopy", 9, said);
    expect([fromB.fresh, fromB.live[0]?.run, fromB.live[0]?.paths]).toEqual([[], "a", ["x.ts", "y.ts"]]);
    expect(pairId("b", { kind: "run", run: "a", verb: "", name: "" })).toBe("a+b");
    expect([pairId("a", { kind: "branch", origin: "q", branch: "" }), pairId("a", { kind: "checkout" })]).toEqual(["a+branch:q", "a+checkout"]);
  });
  test("a pair not involving me is left alone", () => {
    const other: Collision = { id: "c+d", repoId: "canopy", run: "c", name: "run/x-c", with: { kind: "checkout" }, paths: ["z.ts"], at: 1 };
    expect(collide([other], edits("a", "x.ts"), [], "canopy", 2, new Map()).live).toEqual([other]);
  });
});

test("the words", () => {
  const c: Collision = { id: "a+b", repoId: "canopy", run: "a", name: "run/x-a", with: { kind: "run", run: "b", verb: "Plan, then build", name: "run/x-b" }, paths: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"], at: 1 };
  expect(pathList(c.paths)).toBe("a.ts, b.ts, c.ts, d.ts, e.ts and 2 more");
  expect(pathList(["a.ts"])).toBe("a.ts");
  expect(noteLine({ verb: "Ask", run: "1a2b3c4d" }, ["x.ts"])).toBe("also being edited by Ask run 1a2b3c4d: x.ts");
  expect(collisionLine(c)).toBe("also being edited by Plan, then build run b: a.ts, b.ts, c.ts, d.ts, e.ts and 2 more");
  expect(collisionNotice(c)).toBe("run/x-a and run/x-b both edit a.ts, b.ts, c.ts, d.ts, e.ts and 2 more");
  expect(collisionSay(c, "3m ago")).toBe("canopy: another run (Plan, then build, started 3m ago) has edited these files since you started: <<< a.ts, b.ts, c.ts, d.ts, e.ts, f.ts, g.ts >>>. Carry on; the queue rebases when you land.");
  const f = flipped(c, "Ask");
  expect([f.id, f.run, f.name, f.with, f.paths]).toEqual(["a+b", "b", "run/x-b", { kind: "run", run: "a", verb: "Ask", name: "run/x-a" }, c.paths]);
  const q: Collision = { ...c, with: { kind: "branch", origin: "q", branch: "run/x-q" }, paths: ["a.ts"] };
  expect(collisionLine(q)).toBe("also in queued branch run/x-q: a.ts");
  expect(collisionNotice(q)).toBe("run/x-a and run/x-q both edit a.ts");
  expect(collisionSay(q, "")).toBe("canopy: a queued branch (run/x-q) has edited these files since you started: <<< a.ts >>>. Carry on; the queue rebases when you land.");
  const k: Collision = { ...c, with: { kind: "checkout" }, paths: ["a.ts"] };
  expect(collisionLine(k)).toBe("also changed in the main checkout, uncommitted: a.ts");
  expect(collisionNotice(k)).toBe("your uncommitted changes to a.ts overlap run/x-a; the landing will wait for them");
  expect(collisionSay(k, "")).toBe("canopy: the main checkout has uncommitted changes to these files: <<< a.ts >>>. Carry on; the landing waits for them.");
  expect([withName(c.with), withName(q.with), withName(k.with)]).toEqual(["run/x-b", "run/x-q", "your uncommitted changes"]);
  expect(childrenSay("run/x-a", "run/x-b", ["a.ts"])).toBe("canopy: two of your runs (run/x-a and run/x-b) edit the same files: <<< a.ts >>>. Carry on or re-plan; nothing is held.");
  expect(COLLISION_RESAY).toBe(5);
});
```

Import `Side` with the types.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/core/touch.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 4: Write `src/core/touch.ts`**

Header comment: the touched set per run, how overlaps are found, that nothing here holds anything, and that the file is pure and browser-safe (the page draws the chips from it). `addStep` reads a tool step's `paths`: a path ending in `/` goes to `dirs` without it; the step's `touchesUnknown` sets `unknown`; once `paths.size + dirs.size` reaches `TOUCH_MAX` nothing more is added. `overlap` skips a path that starts with `/`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/core/touch.test.ts && bun run typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/touch.ts src/core/touch.test.ts src/core/types.ts
git commit -m "feat(collisions): the touched set per run, overlaps and the words (FR-040)"
```

---

### Task 3: paths on the step, from both drivers

**Files:**
- Modify: `src/core/claudedrive.ts:97-118` (beside `permissionAsk` and `absolutePath`), `:601-609` (the `tool_use` branch); `src/core/claudedrive.test.ts:316-321`; `src/core/testdata/fake-claude.ts` (the job mode's assistant message, around `:193-200`); `src/core/codexrun.ts:373-389` (`itemTool`'s `commandExecution` and `fileChange` cases); `src/core/codexrun.test.ts:316-340`

**Interfaces:**
- Consumes: Task 1's `writtenPaths`; Task 2's `relPath`, `toolTouch`.
- Produces in `src/core/claudedrive.ts`:

```ts
/** What a tool call touches, for the step (FR-040): a file tool's path from the
 *  run's folder, a Bash line's `writtenPaths`, nothing for a read. */
export function toolPaths(tool: string, input: Record<string, unknown>, cwd: string): Pick<RunTool, "paths" | "touchesUnknown">;
```

`Edit`, `Write`, `MultiEdit`, `NotebookEdit`: `file_path` or `notebook_path` through `absolutePath(file, cwd)` then `relPath(abs, cwd)`; `Bash`: `toolTouch(writtenPaths(command, cwd))`; anything else `{}`. `paths` is present only when it has an entry. The `tool_use` branch spreads it into the step's `tool`.

In `codexrun.ts`: the `fileChange` case adds `paths` from `fileChanges(item)`, each change's `path` and its `movePath` through `relPath(resolve(root, p), root)`, present only when non-empty; the `commandExecution` case spreads `toolTouch(writtenPaths(script, root))`.

- [ ] **Step 1: Write the failing tests**

In `src/core/claudedrive.test.ts`, a new `describe`:

```ts
describe("toolPaths", () => {
  test("file tools, a Bash line, reads", () => {
    expect(toolPaths("Edit", { file_path: "/r/src/a.ts" }, "/r")).toEqual({ paths: ["src/a.ts"] });
    expect(toolPaths("Write", { file_path: "docs/x.md" }, "/r")).toEqual({ paths: ["docs/x.md"] });
    expect(toolPaths("MultiEdit", { file_path: "/r/a.ts", edits: [] }, "/r")).toEqual({ paths: ["a.ts"] });
    expect(toolPaths("NotebookEdit", { notebook_path: "/r/n.ipynb" }, "/r")).toEqual({ paths: ["n.ipynb"] });
    expect(toolPaths("Edit", { file_path: "/etc/hosts" }, "/r")).toEqual({ paths: ["/etc/hosts"] });
    expect(toolPaths("Bash", { command: "git mv src/a src/b && touch c.ts" }, "/r")).toEqual({ paths: ["c.ts", "src/a/", "src/b/"] });
    expect(toolPaths("Bash", { command: "sh -c 'rm x'" }, "/r")).toEqual({ touchesUnknown: true });
    expect(toolPaths("Read", { file_path: "/r/a.ts" }, "/r")).toEqual({});
  });
});
```

In the fake's job mode (`fake-claude.ts`, the assistant message whose content holds `Looking.` and the `git status` tool_use), add a second block after it: `{ type: "tool_use", id: "tu2", name: "Write", input: { file_path: "src/a.ts", content: "x" } }`, and send `toolResult("tu2", "written")` right after the `toolResult("tu1", "clean")` the job mode sends (find it with `grep -n '"clean"' src/core/testdata/fake-claude.ts`). In the test at `:316`, the pinned list gains `"tool:write src/a.ts:ok:written"` after `"tool:git status:ok:clean"`, and after it:

```ts
expect(run.steps.find((s) => s.tool?.name === "Write")?.tool?.paths).toEqual(["src/a.ts"]);
expect(run.steps.find((s) => s.tool?.name === "Bash")?.tool?.paths).toBeUndefined();
```

In `src/core/codexrun.test.ts`, "items as steps": the `toEqual` at `:331` gains `paths: ["src/a.ts"]`, and the test gains:

```ts
expect(itemTool(fc([upd("/r/a", "/r/b")]), "completed", "/r")?.paths).toEqual(["a", "b"]);
expect(itemTool(command({ command: "/bin/sh -lc 'touch x.ts'" }), "started", "/r")?.paths).toEqual(["x.ts"]);
expect(itemTool(command({ command: "/bin/sh -lc 'bash -c ls'" }), "started", "/r")?.touchesUnknown).toBe(true);
```

(`git status --short` at `:318` keeps its exact `toEqual`: a read adds nothing.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/claudedrive.test.ts src/core/codexrun.test.ts`
Expected: FAIL on the new assertions only.

- [ ] **Step 3: Implement `toolPaths`, the fake's Write, and the Codex cases**

Any other pinned step list in `claudedrive.test.ts` the new step moves is updated to include it.

- [ ] **Step 4: Run the tests, typecheck and lint**

Run: `bun test src/core/claudedrive.test.ts src/core/codexrun.test.ts src/core/actions.test.ts && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/claudedrive.ts src/core/claudedrive.test.ts src/core/testdata/fake-claude.ts src/core/codexrun.ts src/core/codexrun.test.ts
git commit -m "feat(collisions): a tool step carries the files it touches, from both drivers"
```

---

### Task 4: the queue's model

**Files:**
- Modify: `src/core/types.ts:1386-1424` (`LandEntry`), `:1462-1477` (`LandNotice`), `:1523-1530` (`LandingInfo`), `:875-878` (`RepoAgent`); `src/core/landing.ts:116-125` (`enqueue`), `:257-269` (`fixPrompt`); `src/core/landing.test.ts`; `src/core/route.ts:110-124`; `src/core/route.test.ts:200-206`

**Interfaces:**
- Consumes: Task 2's `Touched`, `Collision`, `fromFiles`, `overlap`.
- Produces in `src/core/types.ts`:

```ts
// LandEntry
  /** set at enqueue when the branch's files meet a working run's set (FR-040):
   *  that run's name and the shared paths. A word, never a hold */
  overlap?: { with: string; paths: string[] };
// LandNotice: the doc comment gains "or two pieces of work editing one file"
  kind: "landed" | "held" | "collision";
  /** why it was held; a collision's line */
  why?: string;
// LandingInfo
  /** the live collisions on this backend (FR-040); an older backend has none */
  collisions?: Collision[];
// RepoAgent
  /** FR-040: the chat's collision say is off for this repo; absent means on */
  collisionSay?: false;
```

with `import type { Collision } from "./touch"` at the top of `types.ts` (a type import, so no runtime cycle).

- Produces in `src/core/landing.ts`:

```ts
export function enqueue(entries: readonly LandEntry[], run: LandingRun, now: number, flags?: QueueFlags, working: readonly Touched[] = []): LandEntry[];
```

The entry's set is `fromFiles(run.runId, run.id, run.branch, run.review?.files ?? [])`; the first working set with a non-empty `overlap` sets `overlap: { with: w.name, paths }`; no sort, no overlap. `advance` keeps `overlap` already (it drops only `gate`, `reason` and `files`). `fixPrompt` adds, for a `conflict`, `red` or `moved` entry with an `overlap`, one sentence before the final instruction: `canopy saw <with> editing these files while you worked: <paths joined by ", ">.`

- Produces in `src/core/route.ts`: `normalizeRepoAgent` keeps `collisionSay: false` when the entry has it (anything else is dropped); `isEmptyRepoAgent` is false when it is set.

- [ ] **Step 1: Write the failing tests**

In `src/core/landing.test.ts`, inside the `enqueue` describe:

```ts
test("an entry is marked when a working run's set holds its files, by that run's name, through to the fix prompt", () => {
  const working = [touchedOf({ id: "w", verb: "Plan, then build", steps: [{ id: "1", at: 1, kind: "tool", tool: { name: "Edit", title: "", status: "ok", paths: ["src/a.ts", "docs/"] } }], branch: { name: "run/x-w", target: "main", base: "b0", dir: "/w/w", state: "working", origin: "w" } })];
  const review: RunReview = { verdict: "land", files: [{ path: "src/a.ts", cls: "logic" }, { path: "docs/x.md", cls: "docs" }, { path: "z.ts", cls: "logic" }], base: "b", head: "h", at: 1 };
  const e = enqueue([], run("a", { review }), 1, undefined, working)[0]!;
  expect(e.overlap).toEqual({ with: "run/x-w", paths: ["docs/x.md", "src/a.ts"] });
  expect(enqueue([], run("b", { review: { ...review, files: [{ path: "q.ts", cls: "logic" }] } }), 1, undefined, working)[0]?.overlap).toBeUndefined();
  expect(enqueue([], run("w", { review }), 1, undefined, working)[0]?.overlap).toBeUndefined();
  expect(enqueue([], run("c"), 1, undefined, working)[0]?.overlap).toBeUndefined();
  const back = advance(advance(e, { t: "begin" }, 2), { t: "conflict", files: ["src/a.ts"] }, 3);
  expect(back.overlap).toEqual(e.overlap);
  expect(fixPrompt(back)).toContain("canopy saw run/x-w editing these files while you worked: docs/x.md, src/a.ts.");
  expect(fixPrompt(back).endsWith("Do not push.")).toBe(true);
  expect(fixPrompt(advance(advance(run("a") && enqueue([], run("a"), 1)[0]!, { t: "begin" }, 2), { t: "conflict", files: ["x"] }, 3))).not.toContain("canopy saw");
});
```

Import `touchedOf` from `./touch` and `RunReview` is imported already. In `src/core/route.test.ts`, beside the `normalizeRepoAgent` test at `:202`:

```ts
expect(normalizeRepoAgent({ collisionSay: false })).toEqual({ collisionSay: false });
expect(normalizeRepoAgent({ collisionSay: true })).toEqual({});
expect(normalizeRepoAgent({ all: { profile: "fast" }, collisionSay: false })).toEqual({ all: { profile: "fast" }, collisionSay: false });
expect(isEmptyRepoAgent({ collisionSay: false })).toBe(false);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/landing.test.ts src/core/route.test.ts`
Expected: FAIL on the new tests (`enqueue` ignores its fifth argument; `collisionSay` is dropped).

- [ ] **Step 3: Add the types, `enqueue`'s sets, `fixPrompt`'s line and the normalizer**

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/core/landing.test.ts src/core/route.test.ts src/cli/land.test.ts ui/src/landing.test.ts && bun run typecheck`
Expected: PASS, clean (`LandingInfo.collisions` is optional, so every literal still types).

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/landing.ts src/core/landing.test.ts src/core/route.ts src/core/route.test.ts
git commit -m "feat(collisions): the queue marks an entry's overlap at enqueue and the fix prompt names it"
```

---

### Task 5: the hub

**Files:**
- Create: `src/server/collisions.ts`, `src/server/collisions.test.ts`
- Modify: `src/core/runner.ts:414` (a `note` beside `say`); `src/server/landing.ts:54-81` (`LandingDeps`), `:145-151` (`info`), `:243-246` (`notify`, which becomes public `notice`), the `enqueue` calls at `:415`, `:430`, `:608`, `:629`; `src/server/landing.test.ts:44-97` (`world`); `src/server/index.ts:332` (`ServerState`), `:4735-4744` (the runner's `onChange`), `:5162-5178` (the hub's deps), the repo broadcasts at `:2150`, `:2674` and `:2853`

**Interfaces:**
- Consumes: Task 2's model and words; `ago` from `core/treelines.ts`; `isRunActive`, `stoppedWhole`, `inQueue` from core; `Runner.say` (`:414`, throws when the run is not idle).
- Produces in `src/core/runner.ts`:

```ts
  /** a one-line remark from canopy on a live run's timeline; nothing for an unknown or ended run */
  note(id: string, text: string): void;
```

- Produces in `src/server/landing.ts`:

```ts
export interface LandingDeps {
  ...
  /** the live collisions, for the info (FR-040) */
  collisions?: () => Collision[];
  /** the touched sets of a repo's live runs, for the mark at enqueue */
  working?: (repoId: string) => readonly Touched[];
}
  /** a quiet line for the inbox's foot (the former private notify) */
  notice(n: Omit<LandNotice, "id" | "at">): void;
  /** sends the info again: a collision came or went */
  republish(): void;
```

`info()` adds `collisions: this.deps.collisions?.() ?? []`; every `enqueue` passes `this.deps.working?.(<record>.repoId) ?? []` as its fifth argument.

- Produces in `src/server/collisions.ts`:

```ts
export interface CollisionDeps {
  /** this backend's live runs */
  runs: () => Run[];
  /** the scan's repo by id, for its checkout's uncommitted files */
  repo: (id: string) => Repo | undefined;
  /** the queue: queued and ready branches' sorted files */
  landing: () => LandingInfo;
  /** `Runner.note` */
  note: (id: string, text: string) => void;
  /** `Runner.say`; throws when the chat is not idle */
  say: (id: string, text: string) => void;
  /** `LandingHub.notice` */
  notify: (n: Omit<LandNotice, "id" | "at">) => void;
  /** `LandingHub.republish` */
  publish: () => void;
  /** whether the chat's say is off for a repo (`RepoAgent.collisionSay`) */
  sayOff?: (repoPath: string) => boolean | Promise<boolean>;
  /** FR-033 wires this as `(run) => run.group`: members of one group never collide */
  groupOf?: (run: Run) => string | undefined;
  now?: () => number;
}

export class CollisionHub {
  constructor(deps: CollisionDeps);
  /** the live collisions, newest first */
  list(): Collision[];
  /** the sets of a repo's live runs (the queue's mark; FR-033's compare sheet) */
  working(repoId: string): Touched[];
  /** a run changed: first sight builds its set from every step, later ones add the
   *  new steps (by step id); it is compared; an ended run's set and pairs go */
  onRun(run: Run): void;
  /** a repo's status changed: its uncommitted files against its live branch runs */
  onRepo(repo: Repo): void;
  /** the queue changed: pairs whose branch left it go */
  onLanding(info: LandingInfo): void;
}
```

How it behaves, the parts the signatures leave open:
- The sides for a run: every other live run of the repo (`kind: "run"`, its verb and `Touched.name`); every record of the repo in `landing().runs` whose `id` is not the run's own origin, whose `runId` is not a live run, that is `ready` or `stoppedWhole`, and whose entry (if any) is not `landed` (`fromFiles`, `kind: "branch"`); and, only when the run has a `branch`, the repo's `status.files` (`fromStatus`, `kind: "checkout"`).
- `onRepo` compares each live branch run of the repo with the checkout side alone, an empty status giving an empty set so the pair goes.
- A collision in `fresh` or `grown` is noted on both live runs of the pair, each from its own view (`collisionLine` of the collision, or of `flipped(c, verb)` when the run is the `with` side). A `fresh` one is also a notice: `{ entry: <origin or run id>, repoId, branch: <name>, note: run.note, kind: "collision", why: collisionNotice(c) }`, and, once per pair, a say to each run of the pair that is a chat: `collisionSay(view, when)` with `when` as `<ago(startedAt seconds, now)> ago` of the other run (an empty `ago` reads `0m`), unless `sayOff(repo.path)` holds. A chat that is not idle, or whose `say` throws, keeps the pair in `pending`; `onRun` for a chat that is idle says every pending pair still live. When both runs share a `parent` that is a live idle chat, it hears `childrenSay(a.name, b.name, paths)` the same way.
- `saidAt` holds the paths count of the last word per pair id. `prune` drops a pair whose run or `with.run` is not live, whose branch side is no longer in `landing()` as above, and runs after each `onRun` end and in `onLanding`. `publish()` is called when the list changed, and only then (`onLanding` publishes only after a prune that dropped something, so the landing event does not loop).

Wiring in `src/server/index.ts`: `collisions: CollisionHub` on `ServerState` after `landing`, built after the landing hub as

```ts
collisions: new CollisionHub({
  runs: () => state.runner.list(),
  repo: (id) => state.result.repos.find((r) => r.id === id),
  landing: () => state.landing.info(),
  note: (id, text) => state.runner.note(id, text),
  say: (id, text) => void state.runner.say(id, text),
  notify: (n) => state.landing.notice(n),
  publish: () => state.landing.republish(),
  sayOff: async (path) => (await loadConfig()).agents[path]?.collisionSay === false,
}),
```

the landing hub's deps gain `collisions: () => state.collisions.list()` and `working: (repoId) => state.collisions.working(repoId)`, its `broadcast` gains `if (ev.type === "landing") state.collisions.onLanding(ev.landing)`, the runner's `onChange` calls `state.collisions.onRun(run)` after `state.landing.onRun(run)`, and `state.collisions.onRepo(repo)` follows each of the three repo broadcasts named above.

- [ ] **Step 1: Add `Runner.note` and the landing hub's hooks**

The former `notify` becomes public `notice` (rename its callers in the file). Add `republish`, the two deps, the `collisions` on `info()` and the fifth `enqueue` argument. In `src/server/landing.test.ts`, `World` gains `working: Touched[]` (empty) and the hub's deps `working: () => w.working`; add to the file:

```ts
test("an entry joining the queue is marked when a working run's set holds its files (FR-040)", async () => {
  const w = await world();
  await readyRun(w, "ov1", "b.txt", "b\n");
  w.working = [touchedOf({ id: "k", verb: "Ask", steps: [{ id: "1", at: 1, kind: "tool", tool: { name: "Write", title: "", status: "ok", paths: ["b.txt"] } }] })];
  await w.hub.land("ov1");
  expect(entryOf(w, "ov1")?.overlap).toEqual({ with: "Ask run k", paths: ["b.txt"] });
  expect(w.hub.info().collisions).toEqual([]);
});
```

Run: `bun test src/server/landing.test.ts src/core/runner.test.ts && bun run typecheck`
Expected: PASS, clean.

- [ ] **Step 2: Write the failing tests in `src/server/collisions.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import type { LandingInfo, LandNotice, Repo, RepoFile, Run, RunStep } from "../core/types";
import { enqueue } from "../core/landing";
import { CollisionHub } from "./collisions";

const edit = (id: string, ...paths: string[]): RunStep => ({ id, at: 1, kind: "tool", tool: { name: "Edit", title: `edit ${paths[0] ?? ""}`, status: "ok", ...(paths.length ? { paths } : {}) } });
const branch = (id: string) => ({ name: `run/x-${id}`, target: "main", base: "b0", dir: `/w/${id}`, state: "working" as const, origin: id });
const run = (id: string, steps: RunStep[], over: Partial<Run> = {}): Run => ({ id, repoId: "canopy", action: "propose", verb: "Plan, then build", progress: "", expectsChange: true, chat: false, harness: "claude", note: `work ${id}`, status: "working", startedAt: 1_000, steps, prompt: null, branch: branch(id), ...over });
const file = (path: string): RepoFile => ({ path, index: ".", worktree: "M", untracked: false, conflicted: false });

function world(opts: { groupOf?: (r: Run) => string | undefined } = {}) {
  const runs = new Map<string, Run>();
  const w = {
    notes: [] as [string, string][],
    says: [] as [string, string][],
    notices: [] as Omit<LandNotice, "id" | "at">[],
    published: 0,
    off: false,
    refuse: 0,
    landing: { runs: [], entries: [], orphans: [] } as LandingInfo,
    repo: { id: "canopy", name: "canopy", path: "/r/canopy", group: "", source: "root", status: null } as Repo,
  };
  const hub = new CollisionHub({
    runs: () => [...runs.values()],
    repo: (id) => (id === "canopy" ? w.repo : undefined),
    landing: () => w.landing,
    note: (id, text) => w.notes.push([id, text]),
    say: (id, text) => {
      if (w.refuse > 0) {
        w.refuse -= 1;
        throw new Error("still replying");
      }
      w.says.push([id, text]);
    },
    notify: (n) => w.notices.push(n),
    publish: () => {
      w.published += 1;
    },
    sayOff: () => w.off,
    ...(opts.groupOf ? { groupOf: opts.groupOf } : {}),
    now: () => 61_000,
  });
  const see = (r: Run): Run => {
    runs.set(r.id, r);
    hub.onRun(r);
    return r;
  };
  return { w, hub, see };
}

describe("two live runs", () => {
  test("a note on each from its own side, one notice, the list, and a second note only after five more paths", () => {
    const { w, hub, see } = world();
    see(run("a", [edit("1", "x.ts")]));
    see(run("b", [edit("1", "x.ts", "y.ts")]));
    expect(w.notes).toEqual([
      ["b", "also being edited by Plan, then build run a: x.ts"],
      ["a", "also being edited by Plan, then build run b: x.ts"],
    ]);
    expect(w.notices).toEqual([{ entry: "b", repoId: "canopy", branch: "run/x-b", note: "work b", kind: "collision", why: "run/x-b and run/x-a both edit x.ts" }]);
    expect(hub.list()).toEqual([{ id: "a+b", repoId: "canopy", run: "b", name: "run/x-b", with: { kind: "run", run: "a", verb: "Plan, then build", name: "run/x-a" }, paths: ["x.ts"], at: 61_000 }]);
    expect(w.published).toBe(1);
    see(run("a", [edit("1", "x.ts"), edit("2", "y.ts")]));
    expect([w.notes.length, hub.list()[0]?.paths]).toEqual([2, ["x.ts", "y.ts"]]);
    see(run("a", [edit("1", "x.ts"), edit("2", "y.ts"), edit("3", "p1", "p2", "p3", "p4")]));
    see(run("b", [edit("1", "x.ts", "y.ts"), edit("2", "p1", "p2", "p3", "p4")]));
    expect(w.notes.slice(2)).toEqual([
      ["b", "also being edited by Plan, then build run a: x.ts, y.ts, p1, p2, p3 and 1 more"],
      ["a", "also being edited by Plan, then build run b: x.ts, y.ts, p1, p2, p3 and 1 more"],
    ]);
    expect([w.notices.length, w.says]).toEqual([1, []]);
    expect(hub.working("canopy").map((t) => t.run).sort()).toEqual(["a", "b"]);
  });
  test("a pair goes when a run ends; a run first seen with many steps starts whole", () => {
    const { hub, see } = world();
    see(run("a", [edit("1", "x.ts"), edit("2", "y.ts"), edit("3", "z.ts")]));
    expect([...hub.working("canopy")[0]!.paths]).toEqual(["x.ts", "y.ts", "z.ts"]);
    see(run("b", [edit("1", "z.ts")]));
    expect(hub.list()).toHaveLength(1);
    see(run("a", [], { status: "done", endedAt: 2_000 }));
    expect([hub.list(), hub.working("canopy").map((t) => t.run)]).toEqual([[], ["b"]]);
  });
  test("the group hook: two runs of one group never collide", () => {
    const { hub, see } = world({ groupOf: (r) => (r.note === "work a" || r.note === "work b" ? "g-1" : undefined) });
    see(run("a", [edit("1", "x.ts")]));
    see(run("b", [edit("1", "x.ts")]));
    see(run("c", [edit("1", "x.ts")]));
    expect(hub.list().map((c) => c.id).sort()).toEqual(["a+c", "b+c"]);
  });
});

describe("chats", () => {
  const chat = (id: string, steps: RunStep[], status: Run["status"], over: Partial<Run> = {}) => run(id, steps, { chat: true, verb: "chat", branch: undefined, status, ...over });
  test("an idle chat hears it once, a working one at its next idle while the pair stands, and a refused say stays pending", () => {
    const { w, see } = world();
    see(chat("c", [edit("1", "x.ts")], "idle"));
    see(run("a", [edit("1", "x.ts")]));
    expect(w.says).toEqual([["c", "canopy: another run (Plan, then build, started 1m ago) has edited these files since you started: <<< x.ts >>>. Carry on; the queue rebases when you land."]]);
    see(run("a", [edit("1", "x.ts"), edit("2", "y.ts")]));
    expect(w.says).toHaveLength(1);
    see(chat("d", [edit("1", "q.ts")], "working"));
    see(run("b", [edit("1", "q.ts")]));
    expect(w.says).toHaveLength(1);
    w.refuse = 1;
    see(chat("d", [edit("1", "q.ts")], "idle"));
    expect(w.says).toHaveLength(1);
    see(chat("d", [edit("1", "q.ts")], "idle"));
    expect(w.says[1]?.[0]).toBe("d");
    see(chat("e", [edit("1", "r.ts")], "working"));
    see(run("f", [edit("1", "r.ts")]));
    see(run("f", [], { status: "done", endedAt: 2_000 }));
    see(chat("e", [edit("1", "r.ts")], "idle"));
    expect(w.says).toHaveLength(2);
  });
  test("collisionSay off: the notes and the notice stay, the say goes", () => {
    const { w, see } = world();
    w.off = true;
    see(chat("c", [edit("1", "x.ts")], "idle"));
    see(run("a", [edit("1", "x.ts")]));
    expect([w.notes.length, w.notices.length, w.says]).toEqual([2, 1, []]);
  });
  test("a coordinator hears that two of its children collide", () => {
    const { w, see } = world();
    see(chat("p", [], "idle", { action: "coordinate", verb: "coordinate" }));
    see(run("a", [edit("1", "x.ts")], { parent: "p" }));
    see(run("b", [edit("1", "x.ts")], { parent: "p" }));
    expect(w.says).toEqual([["p", "canopy: two of your runs (run/x-b and run/x-a) edit the same files: <<< x.ts >>>. Carry on or re-plan; nothing is held."]]);
  });
});

describe("the queue and the checkout", () => {
  test("a queued branch's sorted files, never a fix-it run's own branch, and the pair goes when the branch lands", () => {
    const { w, hub, see } = world();
    const rec = { id: "q", runId: "r-q", repoId: "canopy", repoPath: "/r/canopy", branch: "run/x-q", target: "main", base: "b0", dir: "/w/q", note: "n", verb: "Ask", harness: "claude" as const, state: "ready" as const, startedAt: 1, review: { verdict: "land" as const, files: [{ path: "x.ts", cls: "logic" as const }], base: "b", head: "h", at: 1 } };
    w.landing = { runs: [rec], entries: enqueue([], rec, 1), orphans: [] };
    see(run("a", [edit("1", "x.ts")]));
    expect(hub.list()).toEqual([{ id: "a+branch:q", repoId: "canopy", run: "a", name: "run/x-a", with: { kind: "branch", origin: "q", branch: "run/x-q" }, paths: ["x.ts"], at: 61_000 }]);
    expect(w.notes).toEqual([["a", "also in queued branch run/x-q: x.ts"]]);
    expect(w.notices[0]?.why).toBe("run/x-a and run/x-q both edit x.ts");
    see(run("fix1", [edit("1", "x.ts")], { branch: { ...branch("q"), name: "run/x-q" } }));
    expect(hub.list().map((c) => c.id)).toEqual(["a+branch:q"]);
    w.landing = { ...w.landing, entries: [{ ...w.landing.entries[0]!, state: "landed" }] };
    hub.onLanding(w.landing);
    expect([hub.list(), w.published]).toEqual([[], 2]);
  });
  test("the checkout's uncommitted files against a branch run, never against the checkout's own run", () => {
    const { w, hub, see } = world();
    w.repo = { ...w.repo, status: { branch: "main", upstream: null, ahead: 0, behind: 0, files: [file("x.ts")], lastCommit: null, user: null } };
    see(run("a", [edit("1", "x.ts")]));
    expect(hub.list()).toEqual([{ id: "a+checkout", repoId: "canopy", run: "a", name: "run/x-a", with: { kind: "checkout" }, paths: ["x.ts"], at: 61_000 }]);
    expect(w.notes).toEqual([["a", "also changed in the main checkout, uncommitted: x.ts"]]);
    expect(w.notices[0]?.why).toBe("your uncommitted changes to x.ts overlap run/x-a; the landing will wait for them");
    see(run("k", [edit("1", "x.ts")], { branch: undefined, verb: "Ask" }));
    expect(hub.list().map((c) => c.id).sort()).toEqual(["a+checkout", "a+k"]);
    w.repo = { ...w.repo, status: { ...w.repo.status!, files: [] } };
    hub.onRepo(w.repo);
    expect(hub.list().map((c) => c.id)).toEqual(["a+k"]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/server/collisions.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 4: Write `src/server/collisions.ts` and wire it in `src/server/index.ts`**

Header: what the hub holds (sets per live run, the live pairs, what was said), that it writes nothing to disk, and that nothing here holds a run. Bun-side (it may import `node:` modules, though it needs none).

- [ ] **Step 5: Run the tests, typecheck and lint**

Run: `bun test src/server/collisions.test.ts src/server/landing.test.ts src/server/landing-run.test.ts && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/runner.ts src/server/collisions.ts src/server/collisions.test.ts src/server/landing.ts src/server/landing.test.ts src/server/index.ts
git commit -m "feat(collisions): the hub compares live runs, queued branches and the checkout, and says so"
```

---

### Task 6: `canopy queue`'s line and `canopy collisions`

**Files:**
- Modify: `src/cli/land.ts:10-11` (`LAND_USAGE`), `:24-50` (`queueLines`), `:71` (`landCommand`); `src/cli/land.test.ts`; `src/cli/index.ts:100-112` (`COMMANDS`), `:855-857` (the `case`); `README.md:79`

**Interfaces:**
- Consumes: `withName` from `core/touch.ts`; `LandingInfo.collisions`.
- Produces in `src/cli/land.ts`:

```ts
export const LAND_USAGE = "usage: canopy land <run> [--approve <id>] [--backend URL]\n       canopy land --all [repo] [--backend URL]\n       canopy queue [repo] [--backend URL]\n       canopy collisions [repo] [--backend URL]";
/** a repo at a time: "<name> and <other side>: <paths>" per live collision */
export function collisionLines(info: LandingInfo, repo: string | null, backend = ""): string[];
export async function landCommand(cmd: "land" | "queue" | "collisions", argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void>;
```

`queueLines` prints, under a queued entry that has an `overlap`, `    overlaps with <with>: <paths joined by ", ">`. `collisions` walks the backends as `queue` does and prints `no collisions` (or `no collisions in <repo>`) when every list is empty. `README.md` gets, after the `canopy queue` line:

```
canopy collisions [repo]           # runs on one repo editing the same files right now, and what they share; a word, never a hold
```

- [ ] **Step 1: Write the failing test in `src/cli/land.test.ts`**

After the `sorted` helper:

```ts
test("a queued entry's overlap under its line, and canopy collisions", () => {
  const working = [touchedOf({ id: "k", verb: "Ask", steps: [{ id: "1", at: 1, kind: "tool", tool: { name: "Edit", title: "", status: "ok", paths: ["a.ts"] } }] })];
  const entries = enqueue([], rec("a", { review: sorted("land", { files: [{ path: "a.ts", cls: "logic" }, { path: "b.ts", cls: "logic" }] }) }), 1, undefined, working);
  const c: Collision = { id: "x+checkout", repoId: "dev-tools/canopy", run: "x", name: "run/x-x", with: { kind: "checkout" }, paths: ["c.ts"], at: 1 };
  const info: LandingInfo = { runs: [rec("a")], entries, orphans: [], collisions: [c] };
  expect(queueLines(info, null)).toEqual(["dev-tools/canopy", "  queued 1st       run/x-a", "    overlaps with Ask run k: a.ts"]);
  expect(collisionLines(info, null)).toEqual(["dev-tools/canopy", "  run/x-x and your uncommitted changes: c.ts"]);
  expect(collisionLines(info, "canopy", "mini")).toEqual(["dev-tools/canopy on mini", "  run/x-x and your uncommitted changes: c.ts"]);
  expect(collisionLines(info, "other")).toEqual([]);
});
```

Import `touchedOf` and `Collision` from `../core/touch`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/cli/land.test.ts`
Expected: FAIL, `collisionLines` is not exported.

- [ ] **Step 3: Implement the lines, the command, the `case` and the README line**

`COMMANDS` gains `"collisions"`; the `case "collisions":` joins `land` and `queue`.

- [ ] **Step 4: Run the tests, typecheck and lint**

Run: `bun test src/cli/ && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/land.ts src/cli/land.test.ts src/cli/index.ts README.md
git commit -m "feat(collisions): canopy queue shows an entry's overlap and canopy collisions lists the live ones"
```

---

### Task 7: the chips, the sheet, the inbox's foot and the attention row

**Files:**
- Modify: `ui/src/landing.ts:9` (`EMPTY_LANDING`), `:12-22` (`mergeLanding`), `:51-53` (`noticeLine`), `:124-142` (`RunLanding`), `:155-183` (`runLanding`); `ui/src/landing.test.ts`; `ui/src/waiting.ts:60-90` (`AttentionRow`, `detailOf`, `attentionRepos`); `ui/src/waiting.test.ts`; `ui/src/store.ts:4944-4952` (`attentionItems`); `ui/src/components/Landing.tsx:131-141` (the queue rows), `:253-262` (the working rows), `:441-464` (`LandingNotices`); `ui/src/components/RunSheet.tsx:621-640` (`BranchBlock`); `ui/src/styles.css` (after `.landing-why` at `:5127`)

**Interfaces:**
- Consumes: `Collision`, `withName`, `collisionNotice` from `src/core/touch.ts`; `LandEntry.overlap`, `LandingInfo.collisions`.
- Produces in `ui/src/landing.ts`:

```ts
export const OVERLAP_WORD = "⚠ overlaps";
/** the chip's words: "⚠ overlaps <name>", and a title that says it is a word, not a hold */
export function overlapChip(name: string, paths: readonly string[]): { text: string; title: string };
/** the live collisions a run is the touching side of */
export const runOverlaps = (info: LandingInfo, runId: string): Collision[];
export interface RunLanding { ...; /** the chips: an entry's mark, then the run's live collisions */ overlaps?: { name: string; paths: string[] }[] }
```

`overlapChip`'s title is `Both touch <n> file(s); the queue rebases and reports a conflict if it finds one. Nothing is held`. `mergeLanding` concatenates `collisions`. `noticeLine` returns `n.why ?? ""` for the `collision` kind. `runLanding` fills `overlaps` on both of its paths from `entry?.overlap` (as `{ name: with, paths }`) and `runOverlaps(info, run.id)` mapped through `withName`; absent when empty.

- Produces in `ui/src/waiting.ts`:

```ts
export function attentionRepos(repos: readonly Repo[], collisions: readonly Collision[] = []): AttentionRow[];
```

A repo with a `checkout`-kind collision gets ` · <collisionNotice(c)>` appended to its `detail` (the first such collision). `attentionItems` in the store passes `landingAll(s).collisions ?? []` and adds `s.landing` to its memo's inputs.

- In `ui/src/components/Landing.tsx`: an exported `OverlapChip({ name, paths })` rendering `<details className="landing-overlap"><summary className="landing-state lichen" title={title}>{text}</summary><ul>{paths as <li className="landing-branch">}</ul></details>`; used in a queue row after the `noGates` span (for `e.overlap`, and for `runOverlaps(info, <the entry's run id>)` where the row already resolves its run through `entryRun(e)`), and in a working row after its state span (for `runOverlaps(info, r.runId)`). `LandingNotices`' heading becomes `from the landing queue`, and a `collision` line takes the `landing-held` class like a held one.
- In `RunSheet.tsx`'s `BranchBlock`, after the `l.entry?.reason` span: one `OverlapChip` per `l.overlaps` entry (imported from `./Landing`, as `Inbox.tsx` imports `LandingNotices`).
- CSS: `.landing-overlap` (flex-basis 100%, font-size 11px), `.landing-overlap summary` (cursor pointer, no marker), `.landing-overlap ul` (no bullets, a 12px left margin, the mono token), and a `lichen` tone on `.landing-state` beside the `moss` and `rust` ones the rows use (find them with `grep -n 'landing-state' ui/src/styles.css`); no new colours.

- [ ] **Step 1: Write the failing tests**

In `ui/src/landing.test.ts`:

```ts
test("overlap chips: an entry's mark and a run's live collisions; the notice line; merged across backends", () => {
  expect(overlapChip("run/x-b", ["a.ts", "b.ts"])).toEqual({ text: "⚠ overlaps run/x-b", title: "Both touch 2 files; the queue rebases and reports a conflict if it finds one. Nothing is held" });
  expect(overlapChip("x", ["a.ts"]).title.startsWith("Both touch 1 file;")).toBe(true);
  const c: Collision = { id: "r-a+r-b", repoId: "canopy", run: "r-a", name: "run/x-a", with: { kind: "run", run: "r-b", verb: "Ask", name: "run/x-b" }, paths: ["a.ts"], at: 1 };
  const info: LandingInfo = { runs: [rec("a")], entries: [], orphans: [], collisions: [c] };
  expect(runOverlaps(info, "r-a")).toEqual([c]);
  expect(runOverlaps(info, "r-b")).toEqual([]);
  expect(runLanding(run("a"), info)?.overlaps).toEqual([{ name: "run/x-b", paths: ["a.ts"] }]);
  expect(runLanding(run("b"), info)?.overlaps).toBeUndefined();
  const working = [touchedOf({ id: "w", verb: "Ask", steps: [{ id: "1", at: 1, kind: "tool", tool: { name: "Edit", title: "", status: "ok", paths: ["q.ts"] } }] })];
  const entries = enqueue([], rec("q", { review: { verdict: "land", files: [{ path: "q.ts", cls: "logic" }], base: "b", head: "h", at: 1 } }), 1, undefined, working);
  expect(runLanding(run("q"), { ...info, entries })?.overlaps).toEqual([{ name: "Ask run w", paths: ["q.ts"] }]);
  expect(noticeLine({ id: "n", entry: "a", repoId: "canopy", branch: "run/x-a", note: "", kind: "collision", why: "run/x-a and run/x-b both edit a.ts", at: 1 })).toBe("run/x-a and run/x-b both edit a.ts");
  expect(mergeLanding({ mac: info, mini: { runs: [], entries: [], orphans: [], collisions: [{ ...c, id: "m" }] } }).collisions?.map((x) => x.id)).toEqual(["r-a+r-b", "m"]);
  expect(OVERLAP_WORD).toBe("⚠ overlaps");
});
```

Import `touchedOf` and `Collision` from `../../src/core/touch`. In `ui/src/waiting.test.ts`, inside the `attentionRepos` describe (its `repo` and `file` helpers; match the id the `repo` helper gives):

```ts
test("a repo whose uncommitted files overlap a branch run says so in its detail (FR-040)", () => {
  const c: Collision = { id: "a+checkout", repoId: "beta", run: "a", name: "run/x-a", with: { kind: "checkout" }, paths: ["x.ts"], at: 1 };
  const rows = attentionRepos([repo("beta", { files: [file()] })], [c]);
  expect(rows[0]?.detail).toBe("1 file · your uncommitted changes to x.ts overlap run/x-a; the landing will wait for them");
  expect(attentionRepos([repo("beta", { files: [file()] })], [{ ...c, repoId: "other" }])[0]?.detail).toBe("1 file");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ui/src/landing.test.ts ui/src/waiting.test.ts`
Expected: FAIL on the two new tests.

- [ ] **Step 3: Implement the helpers, the chips, the sheet's line, the notices' heading, the attention detail and the CSS**

- [ ] **Step 4: Run the tests, typecheck, lint and build**

Run: `bun test ui/src && bun run typecheck && bun run lint && bun run build`
Expected: PASS, clean, built. Then look at it: start a scratch server as the memory note "Scratch canopy server for UI checks" says, start two branch runs in a throwaway repo that both edit one file, and see the `⚠ overlaps` chip on the working rows and the run sheet, folding to the path; the inbox's foot reads the notice under "from the landing queue".

- [ ] **Step 5: Commit**

```bash
git add ui/src/landing.ts ui/src/landing.test.ts ui/src/waiting.ts ui/src/waiting.test.ts ui/src/store.ts ui/src/components/Landing.tsx ui/src/components/RunSheet.tsx ui/src/styles.css
git commit -m "feat(collisions): the overlaps chip on landing rows and the run sheet, the inbox line, the attention row"
```

---

### Task 8: the docs and the gates

**Files:**
- Modify: `docs/architecture.md:154` (a paragraph after the "Issue start" one, before "## The PR watch"), `FEATURES.md:35-38` and `:135`, `docs/superpowers/plans/README.md`; read `SPEC.md:57-58` and `README.md:79`

**Interfaces:**
- Consumes: the completed interfaces from Tasks 1 to 7, the source spec, and the live-check results.
- Produces: documentation and feature status that describe the implemented scope, with later phases still marked open. No new runtime interface.

- [ ] **Step 1: `docs/architecture.md`**

One paragraph starting "Collision warnings (FR-040)." saying: a run's tool step carries the files it touches (`RunTool.paths`, from `toolPaths` in `claudedrive.ts` and `itemTool` in `codexrun.ts`; a Bash line through `writtenPaths` in `explain.ts`, which lists redirects and the writers it names and marks an opaque or vague line `touchesUnknown`; a folder moved or removed whole ends in `/`; reads add nothing; a path outside the repo stays absolute and never matches); `core/touch.ts` folds steps into a `Touched` per run (`TOUCH_MAX` 500, past which the set reads "500 files and more" and matches nothing), `overlap` finds shared paths and paths under a moved folder and never pairs the same origin or the same FR-033 group, `collide` keeps one `Collision` per pair and says when it is new or grew by `COLLISION_RESAY`; `server/collisions.ts`'s `CollisionHub` keeps a set per live run from the runner's `onChange`, compares each change with the repo's other live runs, its queued and ready branches' sorted files and the main checkout's uncommitted files (branch runs only), notes both runs of a pair (`Runner.note`), tells an idle chat once per pair (`Runner.say`, at its next idle when it is working, a coordinator about its children, off with `RepoAgent.collisionSay: false`), writes a `collision` notice through `LandingHub.notice`, and carries the list on `LandingInfo.collisions`; `enqueue` marks `LandEntry.overlap` against the working sets and `fixPrompt` names it; the page's chips (`overlapChip`), the attention row's line, `canopy queue`'s line and `canopy collisions`. Never a hold.

- [ ] **Step 2: `SPEC.md` and `README.md`**

Read `SPEC.md`'s "Data and state": `landing/notices.json` ("the queue's quiet lines") already covers the new kind and `config.json` ("agent and launch settings") the `collisionSay` key, so the file stays as it is. `README.md`'s CLI line was added in Task 6.

- [ ] **Step 3: `FEATURES.md` and the plans README**

Move the `### FR-040` block from `## Open` to the top of `## Shipped`, its second line gaining ` · shipped <date>` and a line after the spec line: `Built <date>: src/core/touch.ts (pure, tested) holds the set per run, the overlaps and the words; writtenPaths in explain.ts reads a shell line's writes; both drivers put a call's paths on the step; server/collisions.ts compares and speaks through the runner and the landing hub; the queue marks an entry's overlap at enqueue; chips on the landing rows and the run sheet, a collision notice at the inbox's foot, the attention row's line, canopy queue's line and canopy collisions.` In `docs/superpowers/plans/README.md`, add the first row: `| [Collision warnings: a live touched set per run and a chip when two overlap](2026-10-26-collision-warnings.md) | shipped | <date> | [collision warnings](../specs/2026-10-25-collision-warnings-design.md) |`, and set this plan's Status line to shipped with the merge commit.

- [ ] **Step 4: Run every gate**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass. Then `~/.claude/skills/verify-build/clean-rebuild.sh verify "overlapChip"` proves the served bundle is the new one.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md FEATURES.md docs/superpowers/plans/README.md docs/superpowers/plans/2026-10-26-collision-warnings.md
git commit -m "docs(collisions): architecture, the feature list and the plans index for FR-040"
```

---

## Live check, before the branch is called done

With a scratch canopy (the "Scratch canopy server for UI checks" memory note) pointed at a throwaway repo with one file `notes.md`:

1. Start two branch runs, each told to "add a line to notes.md and commit". When the second edits, its timeline shows `also being edited by Plan, then build run <id>: notes.md` and the first's shows the mirror; the inbox's foot reads `run/… and run/… both edit notes.md` under "from the landing queue", outside the count; `seen` clears it.
2. The landing section's working rows and both run sheets show `⚠ overlaps run/…`, folding to `notes.md`. `canopy collisions` prints the pair; `canopy queue` prints nothing for it yet.
3. Land the first once it is ready while the second still works: its queued row reads `overlaps with run/…: notes.md` in `canopy queue` and the chip on the page; the queue runs as before (no hold). When the second lands and comes back `conflict`, "fix it" starts a run whose first message names the other run.
4. Edit `notes.md` in the main checkout by hand while a branch run edits it: the "waiting on you" panel's row for the repo ends with `your uncommitted changes to notes.md overlap run/…; the landing will wait for them`; commit or revert and the line goes.
5. Open a chat on the repo, let it go idle, then start a branch run that edits a file the chat touched: the chat's next turn is canopy's line. Put `"collisionSay": false` on the repo's entry under `agents` in the scratch config and repeat: the note and the notice come, the say does not.
6. Both runs end: `canopy collisions` prints `no collisions`.

## Decisions this plan makes beyond the spec

- `Touched.name`, `Collision.name` and a `name` on the run-kind `with` ride on the model, so the chip, the CLI and the inbox name a run by its branch (else `<verb> run <id>`) without looking it up on a page that holds ids under another backend's prefix.
- A folder a command moved or removed whole travels on `RunTool.paths` with a trailing `/`, rather than a field the spec does not name; `addStep` sorts it into `dirs`.
- Both live runs of a pair get the note, each from its own side, when the pair is new or grew. The spec says the touching run; the other would otherwise hear only when it next touched a shared file.
- The inbox notice and the chat's say come once per pair; only the timeline note repeats, at `COLLISION_RESAY`.
- The checkout side is compared with branch runs alone: the checkout's own run's edits are the checkout's uncommitted files.
- Spec call 7 (the say) takes the spec's recommendation: on by default, `collisionSay: false` on the repo's entry under `agents` in `config.json` turns it off, kept by the normalizer and hand-edited; no setting in the page.
- Spec call 6 (a coordinator hold) takes the spec's recommendation: the coordinator is told through `childrenSay` and never held; a `paths` hint on a card is left for later.
- `fixPrompt`'s "canopy saw run <id>" names the other side the way the chip does; a branch run's name starts with `run/`, so the word is not doubled.
- FR-033 wires `CollisionDeps.groupOf` as `(run) => run.group` and reads `CollisionHub.working(repoId)` for the compare sheet's shared and single lists; `touchedOf`'s second argument is the hook.
- The hub is a file of its own (`server/collisions.ts`), the spec's first option, since `server/landing.ts` is already 953 lines; the notice and the republish go through two small public methods on `LandingHub`.
- `LandingNotices`' heading reads "from the landing queue" so a collision line sits under it as well as a held one.
- `canopy collisions` reads `GET /api/landing`; no route and no callers rule.
- The say's `<when>` is `ago` from `core/treelines.ts` plus "ago", the same clock the CLI's listings use.
