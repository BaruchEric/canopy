import { expect, test } from "bun:test";
import type { WorktreesInfo } from "../core/types";
import { setHomeBase, setTokenFlag } from "./api";
import { main } from "./index";
import { ageWord, sizeWord, worktreeLines, worktreesCommand } from "./worktrees";

const H = 3_600_000;
const GB = 1024 ** 3;
const info: WorktreesInfo = {
  root: "/w",
  free: 42.1 * GB,
  repos: [
    {
      repoId: "dev-tools/canopy",
      repoPath: "/dev/dev-tools/canopy",
      want: 2,
      fileWarm: 1,
      runs: [{ dir: "/w/canopy-abc/ab12cd34", id: "ab12cd34", runId: "r1", branch: "run/fix-x-ab12cd34", state: "working" }],
      warm: [{ dir: "/w/canopy-abc/warm-1", name: "warm-1", base: "1ac8fe7deadbeef", madeAt: 1000 - 2 * H, size: 312 * 1048576, lockfile: null }],
      refilling: "warm-2",
      fails: [],
      orphans: ["/w/canopy-abc/zz"],
    },
    { repoId: "x", repoPath: "/dev/x", want: 1, runs: [], warm: [], refilling: null, fails: [{ name: "warm-1", why: "bun install exited 1", at: 5, fails: 2 }], orphans: [] },
    { repoId: "quiet", repoPath: "/dev/quiet", want: 0, runs: [], warm: [], refilling: null, fails: [], orphans: [] },
  ],
};

test("worktreeLines", () => {
  expect(worktreeLines(info, null, 1000)).toEqual([
    "dev-tools/canopy  2 warm wanted (the gates file says 1)",
    "  run     run/fix-x-ab12cd34  working  /w/canopy-abc/ab12cd34",
    "  warm    warm-1  1ac8fe7  2h  312 MB",
    "  warm    warm-2  refilling",
    "  orphan  /w/canopy-abc/zz",
    "x  1 warm wanted",
    "  warm    warm-1  failed 2x: bun install exited 1",
    "free 42.1 GB under /w",
  ]);
  expect(worktreeLines(info, "quiet", 1000)).toEqual(["quiet  nothing kept", "free 42.1 GB under /w"]);
  expect(worktreeLines(info, "canopy", 1000)[0]).toBe("dev-tools/canopy  2 warm wanted (the gates file says 1)");
});

test("ageWord and sizeWord", () => {
  expect([ageWord(10_000), ageWord(5 * 60_000), ageWord(2 * H), ageWord(72 * H)]).toEqual(["now", "5m", "2h", "3d"]);
  expect([sizeWord(312 * 1048576), sizeWord(1.2 * GB)]).toEqual(["312 MB", "1.2 GB"]);
});

test("the worktrees CLI uses the home backend, resolves repo names, and sends exact bodies", async () => {
  const seen: { method: string; path: string; body?: unknown; token: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() as unknown : undefined;
      seen.push({ method: request.method, path: url.pathname, ...(body === undefined ? {} : { body }), token: request.headers.get("x-canopy-token") });
      if (url.pathname === "/api/worktrees" && request.method === "GET") return Response.json(info);
      if (url.pathname === "/api/worktrees/warm") {
        const posted = body as { repo: string; n?: number };
        return Response.json({ repo: posted.repo, want: posted.n ?? 1 });
      }
      if (url.pathname === "/api/worktrees/prune") {
        const posted = body as { repo?: string };
        return Response.json({ removed: posted.repo ? [] : ["/w/orphan", "/w/stale-warm"] });
      }
      return Response.json({ error: "unexpected request" }, { status: 404 });
    },
  });
  const oldApi = process.env["CANOPY_API"];
  const oldToken = process.env["CANOPY_TOKEN"];
  const oldLog = console.log;
  const output: string[] = [];
  const base = `http://127.0.0.1:${server.port}`;
  setHomeBase(undefined);
  setTokenFlag(undefined);
  process.env["CANOPY_API"] = base;
  process.env["CANOPY_TOKEN"] = "environment-token";
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  try {
    await main(["worktrees", "quiet", "--token", "flag-token"]);
    expect(output).toEqual(["quiet  nothing kept", "free 42.1 GB under /w"]);
    output.length = 0;

    await main(["worktrees", "--json", "--token", "flag-token"]);
    expect(output).toEqual([JSON.stringify(info, null, 2)]);
    output.length = 0;

    await main(["worktrees", "warm", "canopy", "--token", "flag-token"]);
    expect(output).toEqual(["dev-tools/canopy: 1 warm"]);
    output.length = 0;

    await main(["worktrees", "warm", "dev-tools/canopy", "2", "--token", "flag-token"]);
    expect(output).toEqual(["dev-tools/canopy: 2 warm"]);
    output.length = 0;

    await main(["worktrees", "prune", "--token", "flag-token"]);
    expect(output).toEqual(["/w/orphan", "/w/stale-warm"]);
    output.length = 0;

    await main(["worktrees", "prune", "canopy", "--token", "flag-token"]);
    expect(output).toEqual(["nothing to prune"]);
  } finally {
    setHomeBase(undefined);
    setTokenFlag(undefined);
    console.log = oldLog;
    if (oldApi === undefined) delete process.env["CANOPY_API"];
    else process.env["CANOPY_API"] = oldApi;
    if (oldToken === undefined) delete process.env["CANOPY_TOKEN"];
    else process.env["CANOPY_TOKEN"] = oldToken;
    server.stop(true);
  }

  expect(seen).toEqual([
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "POST", path: "/api/worktrees/warm", body: { repo: "dev-tools/canopy" }, token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "POST", path: "/api/worktrees/warm", body: { repo: "dev-tools/canopy", n: 2 }, token: "flag-token" },
    { method: "POST", path: "/api/worktrees/prune", body: {}, token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "POST", path: "/api/worktrees/prune", body: { repo: "dev-tools/canopy" }, token: "flag-token" },
  ]);
});

test("invalid worktree arguments are refused before contacting the backend", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json(info); } });
  const base = `http://127.0.0.1:${server.port}`;
  const fail = (message: string): never => { throw new Error(message); };
  try {
    for (const args of [
      ["warm", "canopy", "3", "--backend", base],
      ["warm", "canopy", "0.5", "--backend", base],
      ["warm", "--backend", base],
      ["prune", "canopy", "extra", "--backend", base],
      ["--backend"],
      ["--backend", base, "--backend", base],
    ]) {
      await expect(worktreesCommand(args, { fail })).rejects.toThrow();
    }
  } finally {
    server.stop(true);
  }
  expect(requests).toBe(0);
});
