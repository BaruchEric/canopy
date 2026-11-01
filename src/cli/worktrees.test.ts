import { expect, test } from "bun:test";
import type { BranchTree, BranchTreesInfo, WorktreesInfo } from "../core/types";
import { setHomeBase, setTokenFlag } from "./api";
import { main } from "./index";
import { ageWord, SHELL_INIT, sizeWord, worktreeLines, worktreesCommand } from "./worktrees";

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

const tree = (over: Partial<BranchTree>): BranchTree => ({
  slug: "feat-x",
  dir: "/t/canopy-abc/feat-x",
  branch: "feat/x",
  base: "main",
  port: 7912,
  madeAt: 0,
  caches: true,
  state: "ready",
  head: "abc1234",
  ahead: 0,
  behind: 0,
  files: 0,
  shells: 0,
  ...over,
});
const trees: BranchTreesInfo = {
  root: "/t",
  ports: "7900-7949",
  repos: [
    { repoId: "dev-tools/canopy", repoPath: "/dev/dev-tools/canopy", trees: [tree({ ahead: 2, files: 1, shells: 1 })] },
    { repoId: "x", repoPath: "/dev/x", trees: [] },
    { repoId: "quiet", repoPath: "/dev/quiet", trees: [tree({ slug: "fix", dir: "/t/quiet-abc/fix", branch: "fix", port: null, state: "preparing", head: "" })] },
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

test("worktreeLines lists the kept trees under their repo, and a repo with only trees", () => {
  expect(worktreeLines(info, null, 1000, trees)).toEqual([
    "dev-tools/canopy  2 warm wanted (the gates file says 1)",
    "  run     run/fix-x-ab12cd34  working  /w/canopy-abc/ab12cd34",
    "  tree    feat/x  ↑2 ●1 :7912 1 shell  /t/canopy-abc/feat-x",
    "  warm    warm-1  1ac8fe7  2h  312 MB",
    "  warm    warm-2  refilling",
    "  orphan  /w/canopy-abc/zz",
    "x  1 warm wanted",
    "  warm    warm-1  failed 2x: bun install exited 1",
    "quiet  1 tree kept",
    "  tree    fix  preparing  /t/quiet-abc/fix",
    "free 42.1 GB under /w",
  ]);
  expect(worktreeLines(info, "quiet", 1000, trees)).toEqual(["quiet  1 tree kept", "  tree    fix  preparing  /t/quiet-abc/fix", "free 42.1 GB under /w"]);
  // a repo the pool never listed
  const elsewhere: BranchTreesInfo = { ...trees, repos: [{ repoId: "y", repoPath: "/dev/y", trees: [tree({})] }] };
  expect(worktreeLines({ ...info, repos: [] }, null, 1000, elsewhere)).toEqual(["y  1 tree kept", "  tree    feat/x  clean :7912  /t/canopy-abc/feat-x", "free 42.1 GB under /w"]);
});

test("ageWord and sizeWord", () => {
  expect([ageWord(10_000), ageWord(5 * 60_000), ageWord(2 * H), ageWord(72 * H)]).toEqual(["now", "5m", "2h", "3d"]);
  expect([sizeWord(312 * 1048576), sizeWord(1.2 * GB)]).toEqual(["312 MB", "1.2 GB"]);
});

test("shell-init prints a cw function that cds by branch, and needs no backend", async () => {
  const oldLog = console.log;
  const written: string[] = [];
  const oldWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await worktreesCommand(["shell-init"], { fail: (m) => { throw new Error(m); } });
  } finally {
    process.stdout.write = oldWrite;
    console.log = oldLog;
  }
  expect(written.join("")).toBe(SHELL_INIT);
  expect(SHELL_INIT).toContain('cd "$dir" || return');
  expect(SHELL_INIT).toContain('canopy worktrees path "$(basename "$PWD")" "$1"');
  await expect(worktreesCommand(["shell-init", "extra"], { fail: (m) => { throw new Error(m); } })).rejects.toThrow("usage");
});

test("the worktrees CLI uses the home backend, resolves repo names, and sends exact bodies", async () => {
  const seen: { method: string; path: string; body?: unknown; token: string | null }[] = [];
  let treesKnown = false;
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
      // a backend from before the kept trees has no /api/trees
      if (url.pathname === "/api/trees" && request.method === "GET") return treesKnown ? Response.json(trees) : Response.json({ error: "not found" }, { status: 404 });
      if (url.pathname === "/api/trees/add") {
        const posted = body as { branch: string };
        return Response.json({ tree: tree({ branch: posted.branch, slug: "new", dir: "/t/canopy-abc/new", state: "preparing", port: 7903 }) }, { status: 201 });
      }
      if (url.pathname === "/api/trees/remove") {
        const posted = body as { tree: string; force?: boolean };
        if (posted.tree === "feat/x" && !posted.force) return Response.json({ error: "the tree holds 1 changed file; remove it with force to lose that" }, { status: 409 });
        return Response.json({ removed: "feat-x" });
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
  const throwing = (message: string): never => { throw new Error(message); };
  try {
    await main(["worktrees", "quiet", "--token", "flag-token"]);
    expect(output).toEqual(["quiet  nothing kept", "free 42.1 GB under /w"]);
    output.length = 0;

    await main(["worktrees", "--json", "--token", "flag-token"]);
    expect(output).toEqual([JSON.stringify(info, null, 2)]);
    output.length = 0;

    treesKnown = true;
    await main(["worktrees", "quiet", "--token", "flag-token"]);
    expect(output).toEqual(["quiet  1 tree kept", "  tree    fix  preparing  /t/quiet-abc/fix", "free 42.1 GB under /w"]);
    output.length = 0;

    await main(["worktrees", "--json", "--token", "flag-token"]);
    expect(output).toEqual([JSON.stringify({ ...info, trees }, null, 2)]);
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
    output.length = 0;

    await main(["worktrees", "add", "canopy", "feat/y", "--base", "v2", "--no-caches", "--token", "flag-token"]);
    expect(output).toEqual([
      "feat/y  /t/canopy-abc/new  :7903",
      "preparing: the setup line runs and the caches clone in the background; canopy worktrees shows when it is ready",
    ]);
    output.length = 0;

    await main(["worktrees", "path", "canopy", "feat/x", "--token", "flag-token"]);
    expect(output).toEqual(["/t/canopy-abc/feat-x"]);
    output.length = 0;

    await main(["worktrees", "path", "quiet", "fix", "--token", "flag-token"]);
    expect(output).toEqual(["/t/quiet-abc/fix"]);
    output.length = 0;

    await expect(worktreesCommand(["path", "canopy", "nope", "--backend", base], { fail: throwing })).rejects.toThrow("dev-tools/canopy keeps no tree on nope");
    await expect(worktreesCommand(["rm", "canopy", "feat/x", "--backend", base], { fail: throwing })).rejects.toThrow("remove it with force");

    await main(["worktrees", "rm", "canopy", "feat/x", "--force", "--delete-branch", "--token", "flag-token"]);
    expect(output).toEqual(["removed feat-x and the branch feat/x"]);
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
    { method: "GET", path: "/api/trees", token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "GET", path: "/api/trees", token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "GET", path: "/api/trees", token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "GET", path: "/api/trees", token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "POST", path: "/api/worktrees/warm", body: { repo: "dev-tools/canopy" }, token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "POST", path: "/api/worktrees/warm", body: { repo: "dev-tools/canopy", n: 2 }, token: "flag-token" },
    { method: "POST", path: "/api/worktrees/prune", body: {}, token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "POST", path: "/api/worktrees/prune", body: { repo: "dev-tools/canopy" }, token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "POST", path: "/api/trees/add", body: { repo: "dev-tools/canopy", branch: "feat/y", base: "v2", caches: false }, token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "GET", path: "/api/trees", token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "GET", path: "/api/trees", token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "GET", path: "/api/trees", token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "POST", path: "/api/trees/remove", body: { repo: "dev-tools/canopy", tree: "feat/x" }, token: "flag-token" },
    { method: "GET", path: "/api/worktrees", token: "flag-token" },
    { method: "POST", path: "/api/trees/remove", body: { repo: "dev-tools/canopy", tree: "feat/x", force: true, deleteBranch: true }, token: "flag-token" },
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
      ["add", "canopy", "--backend", base],
      ["add", "canopy", "feat", "--base", "--backend", base],
      ["add", "canopy", "feat", "extra", "--backend", base],
      ["rm", "canopy", "--backend", base],
      ["path", "canopy", "--backend", base],
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
