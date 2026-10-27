import { describe, expect, test } from "bun:test";
import { addStep, childrenSay, collide, collisionLine, collisionNotice, collisionSay, COLLISION_RESAY, flipped, fromFiles, fromStatus, noteLine, overlap, pairId, pathList, relPath, toolTouch, touchedOf, touchedWords, TOUCH_MAX, withName, type Collision, type Side } from "./touch";
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
    expect(touchedWords(t)).toBe("4 files and ran commands canopy could not read");
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
