import { describe, expect, test } from "bun:test";
import {
  FLOORPLAN_SCRIPTS,
  floorplanHead,
  floorplanLine,
  floorplanSpec,
  floorplanTask,
  floorplanTools,
  isUpdate,
  parseFloorplanStatus,
  parseServerState,
  startWord,
} from "./floorplan";

const SKILL = "/app/lib/floorplan/skills/floorplan";
const ROOT = "/home/eric/dev/shop";

describe("parseFloorplanStatus", () => {
  test("a map sums its repos' changes and keeps the build's facts", () => {
    const st = parseFloorplanStatus({
      schema: "floorplan/status-result@1",
      ok: true,
      state: "map",
      builtAt: "2026-11-20T10:00:00.000Z",
      files: 412,
      nodes: 7,
      repos: [
        { path: "web", compared: true, sameCommit: false, changedFiles: 9, uncommitted: 2 },
        { path: "api", compared: true, sameCommit: true, changedFiles: 0, uncommitted: 1 },
        { path: "gone", compared: false },
      ],
    });
    expect(st).toEqual({ state: "map", builtAt: "2026-11-20T10:00:00.000Z", files: 412, nodes: 7, changed: 9, uncommitted: 3 });
  });

  test("no repo to compare leaves the counts unknown, not zero", () => {
    const st = parseFloorplanStatus({ schema: "floorplan/status-result@1", state: "none", text: "none" });
    expect(st).toEqual({ state: "none", builtAt: null, files: null, nodes: null, changed: null, uncommitted: null });
  });

  test("anything else is unknown, with the script's reason when it gave one", () => {
    expect(parseFloorplanStatus(null).state).toBe("unknown");
    expect(parseFloorplanStatus({ schema: "other", state: "map" }).state).toBe("unknown");
    expect(parseFloorplanStatus({ schema: "floorplan/status-result@1", state: "unknown", error: "bad json" })).toMatchObject({ state: "unknown", error: "bad json" });
    expect(parseFloorplanStatus({ schema: "floorplan/status-result@1", state: "sideways" })).toMatchObject({ state: "unknown", error: "status.mjs could not read the map" });
  });
});

test("parseServerState takes only what serve.mjs writes", () => {
  expect(parseServerState({ pid: 41, port: 4378, url: "http://127.0.0.1:4378", token: "abc", hash: "h1" })).toEqual({ pid: 41, port: 4378, token: "abc", hash: "h1" });
  expect(parseServerState({ pid: 41, port: 70000, token: "abc", hash: "h1" })).toBeNull();
  expect(parseServerState({ pid: 0, port: 4378, token: "abc", hash: "h1" })).toBeNull();
  expect(parseServerState({ pid: 41, port: 4378, token: "", hash: "h1" })).toBeNull();
  expect(parseServerState("server")).toBeNull();
});

describe("a map run", () => {
  test("may write floorplan/ by an absolute Edit rule, and run every script but open.mjs", () => {
    const tools = floorplanTools(SKILL, ROOT);
    expect(tools).toContain(`Edit(//home/eric/dev/shop/floorplan/**)`);
    // Claude matches file rules on Edit only: a Write rule would be refused
    expect(tools.some((t) => t.startsWith("Write("))).toBe(false);
    for (const name of FLOORPLAN_SCRIPTS) expect(tools).toContain(`Bash(node ${SKILL}/scripts/${name}.mjs:*)`);
    expect(tools.some((t) => t.includes("open.mjs"))).toBe(false);
    expect(tools).toContain("Bash(node floorplan/query.mjs:*)");
    expect(tools).toContain("Read");
    expect(tools).toContain("Bash(git status:*)");
  });

  test("its task names the skill, the root and where canopy differs from the skill", () => {
    const first = floorplanTask({ skillDir: SKILL, root: ROOT, update: false });
    expect(first).toContain("make a floorplan of this repository with the floorplan:floorplan skill");
    expect(first).toContain("first-run workflow");
    expect(first).toContain(`The codebase root is ${ROOT}.`);
    expect(first).toContain("Skip open.mjs");
    expect(first).toContain("without --claude-md");
    expect(first).not.toContain("audience");
    const again = floorplanTask({ skillDir: SKILL, root: ROOT, update: true, developers: true });
    expect(again).toContain("update this repository's floorplan");
    expect(again).toContain("A map already exists?");
    expect(again).toContain(`"audience": "developers"`);
  });

  test("is an ask that expects no change in git, since floorplan/ ignores itself", () => {
    const spec = floorplanSpec({ skillDir: SKILL, root: ROOT, update: false });
    expect(spec).toMatchObject({ verb: "map", mode: "ask", expectsChange: false, noteRequired: false, progress: "mapping" });
    expect(spec.maxTurns).toBeGreaterThanOrEqual(200);
    expect(spec.task).toBe(floorplanTask({ skillDir: SKILL, root: ROOT, update: false }));
  });
});

test("a start updates whatever is there and makes the first map otherwise", () => {
  expect(isUpdate("none")).toBe(false);
  expect(isUpdate("unknown")).toBe(false);
  for (const s of ["map", "blueprint", "unbuilt", "blueprint-started"] as const) expect(isUpdate(s)).toBe(true);
  expect(startWord("none")).toBe("make the map");
  expect(startWord("map")).toBe("update the map");
});

describe("words", () => {
  const ago = (iso: string) => `at ${iso.slice(11, 16)}`;
  const base = { builtAt: null, files: null, nodes: null, changed: null, uncommitted: null };

  test("a map says its size, its age and what changed since", () => {
    const map = { ...base, state: "map" as const, builtAt: "2026-11-20T10:00:00.000Z", files: 412, nodes: 7 };
    expect(floorplanLine({ ...map, changed: 0, uncommitted: 0 }, ago)).toBe("412 files in 7 parts, built at 10:00");
    expect(floorplanLine({ ...map, changed: 1, uncommitted: 3 }, ago)).toBe("412 files in 7 parts, built at 10:00; 1 file changed since, 3 uncommitted");
    expect(floorplanLine({ ...map, files: 1, nodes: 1 }, ago)).toBe("1 file in 1 part, built at 10:00");
  });

  test("the other states say what is there", () => {
    expect(floorplanLine({ ...base, state: "none" }, ago)).toBe("no map yet");
    expect(floorplanLine({ ...base, state: "blueprint", files: 30, nodes: 4, builtAt: "2026-11-20T09:30:00.000Z" }, ago)).toBe("a blueprint of 30 planned files in 4 parts, built at 09:30");
    expect(floorplanLine({ ...base, state: "unknown", error: "boom" }, ago)).toBe("could not read the map: boom");
    expect(floorplanLine({ ...base, state: "unbuilt" }, ago)).toContain("never built");
  });

  test("the head is short: mapping while a run goes, else the state", () => {
    expect(floorplanHead(null)).toBe("");
    expect(floorplanHead({ state: "map", changed: 4, run: "r1" })).toBe("mapping");
    expect(floorplanHead({ state: "map", changed: 4, run: null })).toBe("4 changed");
    expect(floorplanHead({ state: "map", changed: 0, run: null })).toBe("current");
    expect(floorplanHead({ state: "none", changed: null, run: null })).toBe("");
    expect(floorplanHead({ state: "unbuilt", changed: null, run: null })).toBe("unfinished");
  });
});
