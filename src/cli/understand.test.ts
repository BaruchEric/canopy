import { expect, test } from "bun:test";
import { UNDERSTAND_USAGE, parseUnderstandArgs, understandLines } from "./understand";
import type { UnderstandInfo } from "../core/understand";

test("parseUnderstandArgs reads the repo, the act and the flags, and leaves the list alone", () => {
  const argv = ["shop", "rebuild", "-m", "the server matters", "--on", "mini"];
  expect(parseUnderstandArgs(argv)).toEqual({ repo: "shop", act: "rebuild", note: "the server matters", json: false, on: "mini" });
  expect(argv).toHaveLength(6);
  expect(parseUnderstandArgs(["shop"])).toMatchObject({ repo: "shop", act: "status", note: "" });
  expect(parseUnderstandArgs(["./shop", "--json"])).toMatchObject({ repo: "./shop", act: "status", json: true });
  for (const act of ["make", "update", "open", "stop", "prepare"]) expect(parseUnderstandArgs(["shop", act])).toMatchObject({ act });
});

test("parseUnderstandArgs refuses what it cannot run", () => {
  expect(parseUnderstandArgs([])).toBe(UNDERSTAND_USAGE);
  expect(parseUnderstandArgs(["shop", "draw"])).toBe(UNDERSTAND_USAGE);
  expect(parseUnderstandArgs(["shop", "open", "extra"])).toBe(UNDERSTAND_USAGE);
  expect(parseUnderstandArgs(["--json"])).toBe(UNDERSTAND_USAGE);
  expect(parseUnderstandArgs(["shop", "open", "-m", "hi"])).toContain("-m goes with make, update or rebuild");
  expect(parseUnderstandArgs(["shop", "--backend", "http://x:1", "--on", "mini"])).toBe("use either --backend URL or --on NAME");
});

const info: UnderstandInfo = {
  state: "graph",
  analyzedAt: "2026-11-20T09:00:00.000Z",
  commit: "a".repeat(40),
  nodes: 120,
  edges: 300,
  files: 40,
  layers: 4,
  tour: 8,
  folder: ".ua",
  behind: 2,
  changed: 5,
  domain: false,
  lessons: true,
  plugin: { state: "ready" },
  server: null,
  run: null,
};

test("understandLines says the graph, the plugin, its viewer and its run", () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  expect(understandLines(info, now)).toEqual(["120 nodes in 40 files, 4 layers, made 3h ago; 2 commits since, 5 files changed (in .ua/)", "with code lessons"]);
  expect(understandLines({ ...info, behind: 0, lessons: false, domain: true, server: { port: 5180 }, run: "r7" }, now)).toEqual([
    "120 nodes in 40 files, 4 layers, made 3h ago (in .ua/)",
    "with a domain graph",
    "its viewer is up on the backend's port 5180; the repo's map section shows it",
    "run r7 is making it now (canopy run show r7)",
  ]);
  const none = { ...info, state: "none" as const, analyzedAt: null, nodes: null, files: null, layers: null, behind: null, changed: null, lessons: false };
  expect(understandLines({ ...none, plugin: { state: "preparing" } }, now)).toEqual([
    "no graph yet",
    "getting Understand-Anything ready on this backend (the first time it installs and builds, a minute or two)…",
  ]);
  expect(understandLines({ ...none, plugin: { state: "failed", error: "bun install failed: no network" } }, now)[1]).toBe(
    "preparing Understand-Anything failed: bun install failed: no network (any start or open tries again)",
  );
});
