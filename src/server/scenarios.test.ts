import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../core/scenario";
import type { Repo, ScenarioRun } from "../core/types";
import { repoKey } from "../core/worktree";
import { copySet, readScenarioSet, readScenarioSettings, runScenarioSet, Scenarios, setDirOf, type ScenarioRunner } from "./scenarios";

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

test("a repo with no set folder runs the pass without a copy and without a throw", async () => {
  const repo = join(root, "r9");
  const setDir = setDirOf(root, repo);
  const set = await readScenarioSet(root, repo);
  const r = runner({});
  const out = await runScenarioSet({ dir: "/wt", setDir, set, settings: DEFAULT_SETTINGS, run: r.run, head: "h", now: 3 });
  expect(r.calls).toEqual([]);
  expect(existsSync(setDir)).toBe(false);
  expect(out).toEqual({ head: "h", at: 3, total: 0, passed: 0, score: 1, results: [] });
});

test("readScenarioSettings hands out a copy of the defaults, never the shared object", async () => {
  const a = await readScenarioSettings(join(root, "nowhere"));
  expect(a).toEqual(DEFAULT_SETTINGS);
  expect(a).not.toBe(DEFAULT_SETTINGS);
});

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
