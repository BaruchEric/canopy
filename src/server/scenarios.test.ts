import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../core/scenario";
import type { Repo, ScenarioAnswers, ScenarioRun } from "../core/types";
import { repoKey } from "../core/worktree";
import { copySet, readScenarioSet, readScenarioSettings, runScenarioSet, Scenarios, setDirOf, JUDGE_OFF, NO_JUDGE_KEY, OUT_OF_TIME, type ScenarioRunner } from "./scenarios";

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
    if (typeof a === "function") return a();
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
  const out = await runScenarioSet({ judge: null, dir: "/wt", setDir: dir, set, settings: { ...DEFAULT_SETTINGS, timeout: 7 }, run: r.run, head: "h1", now: 5, onDone: (x, next) => done.push([x.name, next]) });
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
  const out = await runScenarioSet({ judge: null, dir: "/wt", setDir: dir, set, settings: DEFAULT_SETTINGS, run: r.run, head: "h", now: 1 });
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
  const out = await runScenarioSet({ judge: null, dir: "/wt", setDir: dir, set, settings: DEFAULT_SETTINGS, run: r.run, head: "h", now: 1 });
  expect(r.calls).toEqual([]);
  expect(out).toMatchObject({ total: 2, passed: 0, score: 0, results: [{ name: "broken.md", kind: "command", ok: false, tail: "broken.md: no frontmatter: the file must start with a --- block" }] });
});

test("the set runs under one budget: each scenario gets what is left, and one reached with none left is red and not run", async () => {
  const repo = join(root, "r11");
  const dir = await setFor(repo, { "a.md": cmd("a", "make a"), "b.md": cmd("b", "make b"), "c.md": cmd("c", "make c") });
  const set = await readScenarioSet(root, repo);
  let clock = 1_000_000;
  const handed: [string, number][] = [];
  // a takes 1000 s of the 1800 s budget, b takes the 800 s left
  const spends: Record<string, number> = { "make a": 1_000_000, "make b": 800_000 };
  const run: ScenarioRunner = async (_cwd, line, _setDir, ms) => {
    handed.push([line, ms]);
    clock += spends[line] ?? 0;
    return { exit: 0, output: "" };
  };
  const done: [string, string | null][] = [];
  const out = await runScenarioSet({ judge: null,
    dir: "/wt",
    setDir: dir,
    set,
    settings: { ...DEFAULT_SETTINGS, timeout: 1800 },
    run,
    head: "h",
    now: 1,
    clock: () => clock,
    onDone: (x, next) => done.push([x.name, next]),
  });
  expect(handed).toEqual([["make a", 1_800_000], ["make b", 800_000]]);
  expect(out.results).toEqual([
    { name: "a", kind: "command", ok: true, tail: "exited 0" },
    { name: "b", kind: "command", ok: true, tail: "exited 0" },
    { name: "c", kind: "command", ok: false, tail: "the set's time ran out" },
  ]);
  expect([out.total, out.passed, out.score]).toEqual([3, 2, 2 / 3]);
  expect(done).toEqual([["a", "b"], ["b", "c"], ["c", null]]);
});

test("the budget stops the pass at the scenario it runs out on; later ones stay unrun", async () => {
  const repo = join(root, "r12");
  const dir = await setFor(repo, { "a.md": cmd("a", "make a"), "b.md": cmd("b", "make b"), "c.md": cmd("c", "make c") });
  const set = await readScenarioSet(root, repo);
  let clock = 0;
  const lines: string[] = [];
  const run: ScenarioRunner = async (_cwd, line) => {
    lines.push(line);
    clock += 1_800_000;
    return { exit: 0, output: "" };
  };
  const out = await runScenarioSet({ judge: null, dir: "/wt", setDir: dir, set, settings: DEFAULT_SETTINGS, run, head: "h", now: 1, clock: () => clock });
  expect(lines).toEqual(["make a"]);
  expect(out.results.map((r) => [r.name, r.ok, r.tail])).toEqual([["a", true, "exited 0"], ["b", false, "the set's time ran out"]]);
  expect([out.total, out.passed, out.score]).toEqual([3, 1, 1 / 3]);
});

test("a runner that throws still loses the copy, and the throw carries", async () => {
  const repo = join(root, "r7");
  const dir = await setFor(repo, { "a.md": cmd("a", "make a") });
  const set = await readScenarioSet(root, repo);
  const r = runner({ "make a": () => { throw new Error("worktree gone"); } });
  await expect(runScenarioSet({ judge: null, dir: "/wt", setDir: dir, set, settings: DEFAULT_SETTINGS, run: r.run, head: "h", now: 1 })).rejects.toThrow("worktree gone");
  expect(existsSync(r.calls[0]![2])).toBe(false);
});

test("a repo with no set folder runs the pass without a copy and without a throw", async () => {
  const repo = join(root, "r9");
  const setDir = setDirOf(root, repo);
  const set = await readScenarioSet(root, repo);
  const r = runner({});
  const out = await runScenarioSet({ judge: null, dir: "/wt", setDir, set, settings: DEFAULT_SETTINGS, run: r.run, head: "h", now: 3 });
  expect(r.calls).toEqual([]);
  expect(existsSync(setDir)).toBe(false);
  expect(out).toEqual({ head: "h", at: 3, total: 0, passed: 0, score: 1, results: [] });
});

test("readScenarioSettings hands out a copy of the defaults, never the shared object", async () => {
  const a = await readScenarioSettings(join(root, "nowhere"));
  expect(a).toEqual(DEFAULT_SETTINGS);
  expect(a).not.toBe(DEFAULT_SETTINGS);
});

/** `run1` is a branch run of `runRepo`, the repo itself unless a test says otherwise */
function hub(
  repoPath: string,
  runDir?: string,
  answers: Record<string, { exit: number; output: string }> = {},
  opts: { runRepo?: string; repo?: Partial<Repo>; judge?: (state: string) => Promise<ScenarioAnswers> } = {},
) {
  const repo: Repo = { id: "r", name: "r", path: repoPath, group: "", source: "root", status: null, ...opts.repo };
  const calls: string[] = [];
  const s = new Scenarios({
    root,
    judge: opts.judge ?? null,
    repo: (id) => (id === "r" ? repo : undefined),
    runDir: (id, rp) => (id === "run1" && rp === (opts.runRepo ?? repoPath) ? runDir : undefined),
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

test("names lists an unreadable file by its file name only, never the parser's message", async () => {
  const repo = join(root, "r13");
  await mkdir(repo, { recursive: true });
  await setFor(repo, { "a.md": cmd("a"), "story.md": "---\nname: story\nkind: judge\nThe customer gets the refund within a day.\n---\n" });
  const { call } = hub(repo);
  const res = (await call("GET", "/api/scenarios/names?repo=r"))!;
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ names: [{ name: "a", kind: "command" }], errors: [{ file: "story.md" }] });
  expect(text).not.toContain("customer");
  expect(text).not.toContain("frontmatter");
  // the admin list keeps the message
  const list = (await (await call("GET", "/api/scenarios?repo=r"))!.json()) as { errors: { file: string; error: string }[] };
  expect(list.errors).toEqual([{ file: "story.md", error: "story.md: frontmatter line is not key: value" }]);
});

test("a repo on another host is refused", async () => {
  const { call } = hub("ssh://mini/home/eric/dev/x");
  const res = (await call("GET", "/api/scenarios/names?repo=r"))!;
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "scenarios run only for a repo on this backend" });
});

test("a forge-only repo is refused", async () => {
  const forge = { kind: "forgejo", slug: "eric/x", clone: "ssh://git@forge/eric/x.git", branch: "main", updated: 0, private: false, empty: false } as const;
  const { call } = hub("https://git.beric.ca/eric/x", undefined, {}, { repo: { forge } });
  const res = (await call("POST", "/api/scenarios/run", { repo: "r" }))!;
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "scenarios run only for a repo on this backend" });
});

test("a branch run of another repo is no run here", async () => {
  const repo = join(root, "r10");
  await mkdir(repo, { recursive: true });
  const { call, calls } = hub(repo, "/wt/run1", {}, { runRepo: join(root, "other") });
  const res = (await call("POST", "/api/scenarios/run", { repo: "r", run: "run1" }))!;
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "no branch run by that id" });
  expect(calls).toEqual([]);
});

const judgeStory = (name: string, line?: string) => `---\nname: ${name}\nkind: judge\n${line ? `run: ${line}\n` : ""}evidence: src/refund.ts\n---\nSECRET STORY ${name}\n`;
const YES: ScenarioAnswers = { satisfied: { choice: "yes", probabilities: { yes: 0.9 } }, evidence: { probability: 0.8 } };

test("commands precede judges; nonzero observation, story and real evidence reach only the evaluator", async () => {
  const repo = join(root, "judge20");
  const dir = await setFor(repo, { "a.md": judgeStory("refund", "observe"), "z.md": cmd("command", "check") });
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "refund.ts"), "evidence file");
  const run = runner({ observe: { exit: 7, output: "refund granted" } });
  const states: string[] = [];
  const done: [string, string | null][] = [];
  const result = await runScenarioSet({ dir: repo, setDir: dir, set: await readScenarioSet(root, repo), settings: DEFAULT_SETTINGS, run: run.run, head: "h", now: 1, judge: async state => { states.push(state); return YES; }, onDone: (r,next) => {done.push([r.name,next]);} });
  expect(run.calls.map(c=>c[1])).toEqual(["check", "observe"]);
  expect(states[0]).toContain("SECRET STORY refund");
  expect(states[0]).toContain("<<<\nrefund granted\n>>>");
  expect(states[0]).toContain("File src/refund.ts:\nevidence file");
  expect(done).toEqual([["command", "refund"], ["refund", null]]);
  expect(result.results).toEqual([{ name: "command", kind: "command", ok: true, tail: "exited 0" }, { name: "refund", kind: "judge", ok: true, p: 0.9, tail: "refund granted" }]);
  expect(result.score).toBeCloseTo(0.95);
  expect(JSON.stringify(result)).not.toContain("SECRET STORY");
  expect(run.calls.every(c=>!existsSync(c[2]))).toBe(true);
});

test("missing, disabled and failed judges hold safely, while skipJudge excludes them entirely", async () => {
  const repo = join(root, "judge21");
  const dir = await setFor(repo, { "j.md": judgeStory("refund", "observe") });
  const run = runner({ observe: { exit: 1, output: "seen" } });
  const base = { dir: repo, setDir: dir, set: await readScenarioSet(root, repo), settings: DEFAULT_SETTINGS, run: run.run, head: "h", now: 1 };
  const noKey = await runScenarioSet({ ...base, judge: null });
  expect(noKey).toMatchObject({ total: 1, passed: 0, score: 0, results: [{ ok: false, unjudged: NO_JUDGE_KEY, tail: "seen" }] });
  const off = await runScenarioSet({ ...base, settings: { ...DEFAULT_SETTINGS, judge: "off" }, judge: async () => {throw Error("should not call");} });
  expect(off.results[0]?.unjudged).toBe(JUDGE_OFF);
  const failed = await runScenarioSet({ ...base, evidence: async () => [], judge: async state => { throw Error(state); } });
  expect(failed.results[0]?.unjudged).toBe("the judge did not answer");
  expect(JSON.stringify(failed)).not.toContain("SECRET STORY");
  const skipped = await runScenarioSet({ ...base, run: async () => {throw Error("must not run");}, judge: null, skipJudge: true });
  expect(skipped).toEqual({ head: "h", at: 1, total: 0, passed: 0, score: 1, results: [], skipped: ["refund"] });
});

test("a red command prevents judging but unrun judges still count zero", async () => {
  const repo = join(root, "judge22");
  const dir = await setFor(repo, { "a.md": cmd("check", "check"), "j.md": judgeStory("refund") });
  const result = await runScenarioSet({ dir: repo, setDir: dir, set: await readScenarioSet(root, repo), settings: DEFAULT_SETTINGS, run: runner({ check: { exit: 1, output: "red" } }).run, head: "h", now: 1, judge: async () => {throw Error("must not judge");} });
  expect([result.total, result.passed, result.score, result.results.length]).toEqual([2, 0, 0, 1]);
});

test("the set-wide deadline also bounds evidence and a judge that never settles", async () => {
  const repo = join(root, "judge23");
  const dir = await setFor(repo, { "j.md": judgeStory("refund") });
  let reads = 0;
  const result = await runScenarioSet({ dir: repo, setDir: dir, set: await readScenarioSet(root, repo), settings: DEFAULT_SETTINGS, run: runner({}).run, head: "h", now: 1, clock: () => reads++ === 0 ? 0 : 1_799_950, evidence: async () => [], judge: async () => new Promise<ScenarioAnswers>(() => {}) });
  expect(result.results[0]).toMatchObject({ ok: false, unjudged: OUT_OF_TIME });
});

test("the run route uses its injected evaluator without publishing the story", async () => {
  const repo = join(root, "judge24");
  await mkdir(repo, { recursive: true });
  await setFor(repo, { "j.md": judgeStory("refund") });
  const { call } = hub(repo, undefined, {}, { judge: async state => {expect(state).toContain("SECRET STORY refund"); return YES;} });
  const response = await call("POST", "/api/scenarios/run", { repo: "r" });
  if (!response) throw Error("run route was not handled");
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ results: [{ name: "refund", kind: "judge", ok: true, p: 0.9 }] });
  expect(JSON.stringify(body)).not.toContain("SECRET STORY");
});

test("an unsatisfied judge keeps its probability and does not prevent later judgments", async () => {
  const repo = join(root, "judge25");
  await mkdir(repo, { recursive: true });
  const dir = await setFor(repo, { "a.md": judgeStory("a"), "b.md": judgeStory("b") });
  const seen: string[] = [];
  const result = await runScenarioSet({ dir: repo, setDir: dir, set: await readScenarioSet(root, repo), settings: DEFAULT_SETTINGS, run: async () => {throw Error("no observation line");}, head: "h", now: 1, judge: async state => { seen.push(state); return state.includes("SECRET STORY a") ? { ...YES, satisfied: { choice: "partly", probabilities: { yes: 0.3 } } } : YES; } });
  expect(seen).toHaveLength(2);
  expect(result.results[0]).toMatchObject({ name: "a", ok: false, p: 0.3, why: "the judge says what was observed only partly satisfies the story" });
  expect(result.results[1]).toMatchObject({ name: "b", ok: true, p: 0.9 });
  expect(result.passed).toBe(1);
  expect(result.score).toBeCloseTo(0.6);
  expect(JSON.stringify(result)).not.toContain("SECRET STORY");
});
