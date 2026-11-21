import { expect, test } from "bun:test";
import {
  UNDERSTAND_VERSION,
  graphFolder,
  graphRun,
  isWait,
  parseGraph,
  parseMeta,
  parseServerState,
  startWord,
  understandHead,
  understandLine,
  understandSpec,
  understandTask,
  understandTools,
  withMeta,
  type UnderstandStart,
} from "./understand";

const graph = {
  version: "1.0.0",
  project: { name: "shop", languages: ["typescript"], frameworks: [], description: "", analyzedAt: "2026-11-20T09:00:00.000Z", gitCommitHash: "a".repeat(40) },
  nodes: [
    { id: "file:src/a.ts", type: "file", name: "a.ts" },
    { id: "file:src/b.ts", type: "file", name: "b.ts" },
    { id: "function:src/a.ts:add", type: "function", name: "add" },
  ],
  edges: [{ source: "file:src/b.ts", target: "file:src/a.ts", type: "imports" }],
  layers: [{ id: "core", name: "Core", nodeIds: [] }],
  tour: [{ order: 1 }, { order: 2 }],
};

test("parseGraph counts the nodes, files, edges, layers and tour, and reads the project block", () => {
  expect(parseGraph(graph)).toEqual({
    state: "graph",
    analyzedAt: "2026-11-20T09:00:00.000Z",
    commit: "a".repeat(40),
    nodes: 3,
    edges: 1,
    files: 2,
    layers: 1,
    tour: 2,
  });
  expect(parseGraph({ nodes: [], edges: [] })).toMatchObject({ state: "graph", nodes: 0, files: 0, analyzedAt: null, commit: null, layers: null, tour: null });
});

test("parseGraph calls anything else unreadable", () => {
  for (const raw of [null, "x", [], { nodes: [] }, { nodes: {}, edges: [] }]) {
    expect(parseGraph(raw)).toMatchObject({ state: "unknown", nodes: null, error: "knowledge-graph.json is not a graph canopy can read" });
  }
});

test("meta.json's commit and time win over the graph's project block", () => {
  const meta = parseMeta({ lastAnalyzedAt: "2026-11-21T10:00:00.000Z", gitCommitHash: "b".repeat(40), version: "1", analyzedFiles: 2 });
  expect(meta).toEqual({ analyzedAt: "2026-11-21T10:00:00.000Z", commit: "b".repeat(40) });
  expect(withMeta(parseGraph(graph), meta)).toMatchObject({ analyzedAt: "2026-11-21T10:00:00.000Z", commit: "b".repeat(40), nodes: 3 });
  expect(withMeta(parseGraph(graph), null)).toEqual(parseGraph(graph));
  expect(parseMeta({})).toBeNull();
  expect(parseMeta("x")).toBeNull();
  const unread = parseGraph(null);
  expect(withMeta(unread, meta)).toBe(unread);
});

test("graphFolder keeps the legacy folder where a checkout has it", () => {
  expect(graphFolder(() => false)).toBe(".ua");
  expect(graphFolder((n) => n === ".understand-anything")).toBe(".understand-anything");
  expect(graphFolder((n) => n === ".ua")).toBe(".ua");
});

test("graphRun: a rebuild when asked, else update where a graph is and make where none is", () => {
  expect(graphRun("none", false)).toBe("make");
  expect(graphRun("graph", false)).toBe("update");
  expect(graphRun("unknown", false)).toBe("update");
  expect(graphRun("none", true)).toBe("rebuild");
  expect(startWord("rebuild")).toBe("rebuild the graph");
  expect(startWord("make")).toBe("make the graph");
});

test("parseServerState takes only what canopy wrote", () => {
  const ok = { pid: 42, port: 5180, token: "0123456789abcdef0123456789abcdef", root: "/r/shop", key: "abc123def456" };
  expect(parseServerState(ok)).toEqual(ok);
  expect(parseServerState({ ...ok, pid: 0 })).toBeNull();
  expect(parseServerState({ ...ok, port: 70000 })).toBeNull();
  expect(parseServerState({ ...ok, token: "not hex" })).toBeNull();
  expect(parseServerState({ ...ok, root: "" })).toBeNull();
  expect(parseServerState({ ...ok, key: 3 })).toBeNull();
  expect(parseServerState(null)).toBeNull();
});

const start: UnderstandStart = {
  pluginDir: "/c/understand/plugin-2.9.8-abc",
  skillDir: "/c/understand/plugin-2.9.8-abc/skills/understand",
  scripts: ["compute-batches.mjs", "merge-batch-graphs.py"],
  root: "/r/shop",
  folder: ".ua",
  how: "make",
};

test("understandTools lets the run read, run the skill's scripts and write only the graph's folder", () => {
  const tools = understandTools(start);
  expect(tools).toContain("Read");
  expect(tools).toContain("Bash(git log:*)");
  expect(tools).toContain("Edit(//r/shop/.ua/**)");
  expect(tools).toContain("Bash(mkdir -p /r/shop/.ua:*)");
  expect(tools).toContain("Bash(node /c/understand/plugin-2.9.8-abc/skills/understand/compute-batches.mjs:*)");
  expect(tools).toContain("Bash(python /c/understand/plugin-2.9.8-abc/skills/understand/merge-batch-graphs.py:*)");
  expect(tools).toContain("Bash(python3 /c/understand/plugin-2.9.8-abc/skills/understand/merge-batch-graphs.py:*)");
  expect(tools.some((t) => t.startsWith("Edit(") && !t.includes("/.ua/"))).toBe(false);
  expect(tools.some((t) => t.includes("node /c/understand/plugin-2.9.8-abc/skills/understand/merge-batch-graphs.py"))).toBe(false);
});

test("understandTask names the skill, the root and where canopy differs", () => {
  const task = understandTask(start);
  expect(task).toContain("make a knowledge graph of this repository with the understand-anything:understand skill");
  expect(task).toContain(`Understand-Anything ${UNDERSTAND_VERSION}`);
  expect(task).toContain('Invoke the skill first with the arguments "/r/shop"');
  expect(task).toContain("There is no graph yet");
  expect(task).toContain("never install or build it");
  expect(task).toContain("Do not run /understand-dashboard");
  expect(task).toContain("Phase 0.5");
  expect(task).toContain("--auto-update");
  expect(task).toContain("Write only inside .ua/");
  const rebuild = understandTask({ ...start, how: "rebuild", folder: ".understand-anything" });
  expect(rebuild).toContain("rebuild this repository's knowledge graph");
  expect(rebuild).toContain('"/r/shop --full"');
  expect(rebuild).toContain("Write only inside .understand-anything/");
  expect(understandTask({ ...start, how: "update" })).toContain("A graph is there already");
});

test("understandSpec is an ask with the tools and the task", () => {
  const spec = understandSpec({ ...start, how: "update" });
  expect(spec).toMatchObject({ label: "update the graph", verb: "understand", mode: "ask", expectsChange: false, noteRequired: false, progress: "understanding" });
  expect(spec.allowedTools).toEqual(understandTools(start));
  expect(spec.task).toBe(understandTask({ ...start, how: "update" }));
});

const ago = (iso: string): string => (iso.startsWith("2026-11-20") ? "3h ago" : iso);

test("understandLine words each state", () => {
  const base = parseGraph(graph);
  expect(understandLine({ ...base, behind: 0, changed: 0 }, ago)).toBe("3 nodes in 2 files, 1 layer, made 3h ago");
  expect(understandLine({ ...base, behind: 4, changed: 9 }, ago)).toBe("3 nodes in 2 files, 1 layer, made 3h ago; 4 commits since, 9 files changed");
  expect(understandLine({ ...base, layers: 0, behind: 1, changed: 0 }, ago)).toBe("3 nodes in 2 files, made 3h ago; 1 commit since");
  expect(understandLine({ ...base, nodes: null, files: null, layers: null, analyzedAt: null, behind: null, changed: null }, ago)).toBe("a graph");
  expect(understandLine({ ...parseGraph(null), behind: null, changed: null }, ago)).toBe("could not read the graph: knowledge-graph.json is not a graph canopy can read");
  expect(understandLine({ state: "none", analyzedAt: null, nodes: null, edges: null, files: null, layers: null, behind: null, changed: null }, ago)).toBe("no graph yet");
});

test("understandHead puts the run and the prepare ahead of the graph's state", () => {
  const ready = { state: "ready" } as const;
  expect(understandHead(null)).toBe("");
  expect(understandHead({ state: "graph", behind: 0, run: "r1", plugin: ready })).toBe("understanding");
  expect(understandHead({ state: "none", behind: null, run: null, plugin: { state: "preparing" } })).toBe("getting ready");
  expect(understandHead({ state: "graph", behind: 0, run: null, plugin: ready })).toBe("current");
  expect(understandHead({ state: "graph", behind: 3, run: null, plugin: ready })).toBe("3 behind");
  expect(understandHead({ state: "unknown", behind: null, run: null, plugin: ready })).toBe("unreadable");
  expect(understandHead({ state: "none", behind: null, run: null, plugin: { state: "failed", error: "x" } })).toBe("");
});

test("isWait knows the route's 202", () => {
  expect(isWait({ preparing: true, plugin: { state: "preparing" } })).toBe(true);
  expect(isWait({ id: "r1" })).toBe(false);
  expect(isWait(null)).toBe(false);
});
