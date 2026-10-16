import { describe, expect, test } from "bun:test";
import { actionWord, kitApplyLines, kitCommand, kitStatusLines } from "./kit";
import type { KitInfo } from "../core/types";

const info: KitInfo = {
  ok: true, error: null,
  machines: [{
    machine: "mac",
    seen: { machine: "mac", at: 1, away: null, home: "/h", store: { tracked: [], branch: "main", ahead: 0, behind: 2, dirty: 3, fetchFailed: false }, targets: [], sources: {} },
    plan: [{ kind: "pull" }, { kind: "link", agent: "codex", name: "ship", link: "../../.claude/skills/ship" }],
  }],
  cells: [
    { machine: "mac", agent: "codex", skill: "ship", state: "missing", why: "" },
    { machine: "mac", agent: "codex", skill: "qnap", state: "foreign", why: "a dir canopy did not place" },
    { machine: "mac", agent: "claude", skill: "ship", state: "ok", why: "" },
  ],
};

describe("kit cli", () => {
  test("status: the store line, the problems, the plan", () => {
    expect(kitStatusLines(info, null)).toEqual([
      "mac  store main, 2 behind, 3 changed",
      "  codex  ship  missing",
      "  codex  qnap  foreign  a dir canopy did not place",
      "  plan: pull, link codex/ship",
    ]);
  });
  test("a tool's problem names it as a tool", () => {
    const withTool: KitInfo = { ...info, cells: [{ machine: "mac", agent: "", skill: "jq", state: "no-install", why: "missing, and kit.json has no install line for darwin", kind: "tool" }] };
    expect(kitStatusLines(withTool, null)).toContain("  tool  jq  no-install  missing, and kit.json has no install line for darwin");
  });
  test("an error reads as one line", () => {
    expect(kitStatusLines({ ok: false, error: "kit.json: bad", machines: [], cells: [] }, null)).toEqual(["kit.json: bad"]);
  });
  test("apply lines and words", () => {
    expect(actionWord({ kind: "remove", agent: "codex", name: "x" })).toBe("remove codex/x");
    expect(kitApplyLines({ machine: "mac", done: [{ kind: "pull" }], failed: [{ action: { kind: "mkdir", agent: "hermes" }, why: "cannot make /x" }] }))
      .toEqual(["mac: pull done", "mac: mkdir hermes failed: cannot make /x"]);
  });
  test("a dry run says what would run, not that it was done", () => {
    expect(kitApplyLines({ machine: "mini", done: [{ kind: "mcp-set", agent: "codex", name: "github" }], failed: [] }, true))
      .toEqual(["mini: mcp-set codex/github would run"]);
  });
});

describe("kit cli over several backends", () => {
  test("a backend with no kit (an older canopy) is named and skipped, and the rest still report", async () => {
    const older = Bun.serve({ port: 0, fetch: () => Response.json({ error: "not found" }, { status: 404 }) });
    const home = Bun.serve({
      port: 0,
      fetch: (req) => {
        const p = new URL(req.url).pathname;
        if (p === "/api/backends") return Response.json({ self: "mac", backends: [{ name: "mini", tailnet: `http://127.0.0.1:${older.port}` }] });
        if (p === "/api/kit") return Response.json(info);
        return new Response("no", { status: 404 });
      },
    });
    const lines: string[] = [];
    const log = console.log;
    console.log = (s: string) => { lines.push(s); };
    const before = process.exitCode;
    const api = process.env["CANOPY_API"];
    process.env["CANOPY_API"] = `http://127.0.0.1:${home.port}`;
    try {
      await kitCommand(["status"], { fail: (m) => { throw new Error(m); } });
    } finally {
      console.log = log;
      if (api === undefined) delete process.env["CANOPY_API"]; else process.env["CANOPY_API"] = api;
      home.stop(true);
      older.stop(true);
    }
    expect(lines[0]).toBe("mac  store main, 2 behind, 3 changed");
    expect(lines.at(-1)).toBe("mini: not found");
    expect(process.exitCode).toBe(1);
    process.exitCode = before ?? 0;
  });
  test("a backend whose kit.json cannot be read is named on its error line", async () => {
    const mini = Bun.serve({ port: 0, fetch: () => Response.json({ ok: false, error: "kit.json: ENOENT", machines: [], cells: [] }) });
    const home = Bun.serve({
      port: 0,
      fetch: (req) => {
        const p = new URL(req.url).pathname;
        if (p === "/api/backends") return Response.json({ self: "mac", backends: [{ name: "mini", tailnet: `http://127.0.0.1:${mini.port}` }] });
        return Response.json(info);
      },
    });
    const lines: string[] = [];
    const log = console.log;
    console.log = (s: string) => { lines.push(s); };
    const api = process.env["CANOPY_API"];
    process.env["CANOPY_API"] = `http://127.0.0.1:${home.port}`;
    try {
      await kitCommand(["status"], { fail: (m) => { throw new Error(m); } });
    } finally {
      console.log = log;
      if (api === undefined) delete process.env["CANOPY_API"]; else process.env["CANOPY_API"] = api;
      home.stop(true);
      mini.stop(true);
    }
    expect(lines.at(-1)).toBe("mini: kit.json: ENOENT");
  });

  test("server cells print like skills, with their why", () => {
    const info: KitInfo = { ok: true, error: null, cells: [{ machine: "mac", agent: "claude", skill: "github", state: "not-allowed", why: "not allowed; allow it from the kit view", kind: "mcp" }], machines: [{ machine: "mac", seen: { machine: "mac", at: 1, away: null, home: "/h", store: null, targets: [], sources: {} }, plan: [{ kind: "mcp-set", agent: "codex", name: "github" }] }] };
    expect(kitStatusLines(info, null)).toEqual(["  claude  github  not-allowed  not allowed; allow it from the kit view", "  plan: mcp-set codex/github"]);
  });
  test("every MCP problem state prints; ok, local and off do not", () => {
    const states = ["not-allowed", "stale-allowance", "no-sink", "adoptable", "unsupported", "unresolved", "ok", "local", "off"] as const;
    const info: KitInfo = {
      ok: true, error: null,
      cells: states.map((state) => ({ machine: "mac", agent: "codex", skill: state, state, why: "", kind: "mcp" as const })),
      machines: [{ machine: "mac", seen: { machine: "mac", at: 1, away: null, home: "/h", store: null, targets: [], sources: {} }, plan: [] }],
    };
    expect(kitStatusLines(info, null)).toEqual(states.slice(0, 6).map((s) => `  codex  ${s}  ${s}`));
  });
});
