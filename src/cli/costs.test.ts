import { describe, expect, test } from "bun:test";
import type { CostLine, CostSheet } from "../core/costsheet";
import type { HarnessShare, HarnessWeek } from "../core/harnessshare";
import type { HistoryOverview, Repo, ScanResult } from "../core/types";
import { costLines, costsCommand, COSTS_USAGE, daysOf, shareLine, shareLines } from "./costs";
import { main } from "./index";

// colour codes off what the tests read, should a terminal turn them on
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const line = (key: string, label: string, over: Partial<CostLine> = {}): CostLine => ({ key, label, detail: "", usd: 0, est: 0, tokens: 0, seconds: 0, unpriced: 0, at: 0, ...over });

test("daysOf", () => {
  expect([daysOf(undefined), daysOf("1"), daysOf("7"), daysOf("30"), daysOf("5"), daysOf("x")]).toEqual([7, 1, 7, 30, null, null]);
});

test("costLines: the total, by service, by repo", () => {
  const sheet: CostSheet = {
    usd: 41.2,
    est: 0.25,
    unpriced: 2,
    archive: true,
    services: [
      line("claude:anthropic", "Claude Code", { usd: 38.1, tokens: 1_200_000 }),
      line("codex:openai", "Codex · openai", { est: 0.25, tokens: 1000 }),
      line("speech:speech", "Dictation · speech", { unpriced: 2, seconds: 30 }),
    ],
    repos: [line("github.com/e/api", "api", { usd: 3, seconds: 120 })],
    runs: [],
  };
  expect(costLines(sheet, 7)).toEqual([
    "7 days: $41.20 + ≈ $0.25 + 2 unpriced",
    "by service",
    "  Claude Code                    $38.10  1.2M tokens",
    "  Codex · openai                ≈ $0.25  1.0k tokens",
    "  Dictation · speech            unpriced  30 s",
    "by repo",
    "  api                             $3.00  2.0 min",
  ]);
  expect(costLines({ ...sheet, services: [], repos: [] }, 1).slice(0, 3)).toEqual(["today: $41.20 + ≈ $0.25 + 2 unpriced", "by service", "  nothing"]);
  expect(costLines({ ...sheet, repos: [sheet.repos[0]!, line("b", "b"), line("c", "c")] }, 30, 2).at(-1)).toBe("  … and 1 more");
});

describe("the share", () => {
  const share: HarnessShare = { usd: { harness: 9.48, rest: 31.72 }, sessions: { harness: 15, rest: 33 }, share: 9.48 / 41.2, sessionShare: 15 / 48 };
  const weeks: HarnessWeek[] = [
    { from: "2026-10-05", harness: 0, rest: 0, share: null },
    { from: "2026-10-12", harness: 7, rest: 7, share: 0.5 },
    { from: "2026-10-19", harness: 21, rest: 7, share: 0.75 },
    { from: "2026-10-26", harness: 2, rest: 2, share: 0.5 },
  ];
  test("shareLine", () => {
    expect(plain(shareLine(share))).toBe("harness 23% of $41.20 · 31% of 48 sessions");
    expect(plain(shareLine({ usd: { harness: 0, rest: 0 }, sessions: { harness: 0, rest: 0 }, share: null, sessionShare: null }))).toBe("harness — of $0.00 · — of 0 sessions");
  });
  test("shareLines: the figure with the names, then the weeks", () => {
    expect(shareLines(share, weeks, ["canopy", "devhub"], 25).map(plain)).toEqual([
      "harness 23% of $41.20 · 31% of 48 sessions  (canopy, devhub)",
      "week          harness      rest  share",
      "2026-10-05      $0.00     $0.00      —",
      "2026-10-12      $7.00     $7.00    50%",
      "2026-10-19     $21.00     $7.00    75%",
      "2026-10-26      $2.00     $2.00    50%  so far",
    ]);
    expect(shareLines(share, [], [], 25).map(plain)).toEqual([
      "harness 23% of $41.20 · 31% of 48 sessions  (no repo is marked as the harness)",
      "  no week to show: claude-history has no spend in these repos",
    ]);
  });
});

const failWith = (msg: string): never => {
  throw new Error(msg);
};

test("costsCommand rejects a day count outside 1, 7, and 30", async () => {
  await expect(costsCommand(["--days", "5"], { fail: failWith })).rejects.toThrow(COSTS_USAGE);
  await expect(costsCommand(["--days"], { fail: failWith })).rejects.toThrow(COSTS_USAGE);
  await expect(costsCommand(["--share", "stray"], { fail: failWith })).rejects.toThrow(COSTS_USAGE);
});

function repo(id: string, name: string, remote: string, harness = false): Repo {
  return {
    id,
    name,
    path: `/${name}`,
    group: "",
    source: "launch",
    status: null,
    remotes: [remote],
    ...(harness ? { harness: true as const } : {}),
  };
}

function tree(repos: Repo[]): ScanResult {
  return { root: "/", sources: [], repos, scannedAt: 0, backend: {} as ScanResult["backend"] };
}

function archive(id: string, amount: number, sessions: number): Extract<HistoryOverview, { available: true }> {
  return {
    available: true,
    days: ["2026-10-26"],
    maxDay: amount,
    fetchedAt: 0,
    repos: {
      [id]: {
        project: id,
        sessions,
        costUsd: amount,
        tokens: 0,
        commits: 0,
        first: null,
        last: null,
        days: [amount],
        daySessions: [sessions],
      },
    },
  };
}

function costRow(service: "codex" | "voice" | "speech", repoId: string, repoName: string, usd: number) {
  return {
    at: 1,
    service,
    provider: service === "codex" ? "openai" : service,
    model: null,
    repo: `/${repoName}`,
    repoName,
    run: null,
    label: null,
    session: null,
    usd,
    tokens: { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 },
    seconds: null,
    repoId,
    estUsd: null,
  };
}

function fakeBackend(
  data: { repos: Repo[]; history: HistoryOverview; rows: ReturnType<typeof costRow>[] },
  requests: string[],
  failedPath?: string,
) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      if (url.pathname === failedPath) return Response.json({ error: "archive offline" }, { status: 503 });
      if (url.pathname === "/api/tree") return Response.json(tree(data.repos));
      if (url.pathname === "/api/history") return Response.json(data.history);
      if (url.pathname === "/api/costs") return Response.json({ since: 0, rows: data.rows, priced: false });
      return new Response("not found", { status: 404 });
    },
  });
}

test("main dispatches costs across listed backends and merges qualified repos", async () => {
  const canopyRemote = "https://github.com/eric/canopy";
  const apiRemote = "https://github.com/eric/api";
  const devhubRemote = "https://github.com/eric/devhub";
  const miniRequests: string[] = [];
  const devhubRequests: string[] = [];
  const mini = fakeBackend(
    {
      repos: [repo("repo", "canopy on mini", canopyRemote), repo("api", "api", apiRemote), repo("runner", "runner", "https://github.com/eric/runner", true)],
      history: {
        ...archive("repo", 3, 3),
        repos: { ...archive("repo", 3, 3).repos, api: archive("api", 2, 1).repos["api"]! },
      },
      rows: [costRow("codex", "repo", "canopy", 5)],
    },
    miniRequests,
  );
  const devhub = fakeBackend(
    {
      repos: [repo("dev", "devhub", devhubRemote, true)],
      history: archive("dev", 4, 1),
      rows: [costRow("voice", "dev", "devhub", 2)],
    },
    devhubRequests,
  );
  const homeRequests: string[] = [];
  const home = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      homeRequests.push(`${request.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/api/backends") {
        return Response.json({
          self: "mac",
          backends: [
            { name: "mini", tailnet: `http://127.0.0.1:${mini.port}` },
            { name: "devhub", tailnet: `http://127.0.0.1:${devhub.port}` },
          ],
        });
      }
      if (url.pathname === "/api/tree") return Response.json(tree([repo("repo", "canopy", canopyRemote, true), repo("api", "api", apiRemote)]));
      if (url.pathname === "/api/history") {
        const canopy = archive("repo", 1, 2);
        const api = archive("api", 2, 1);
        return Response.json({ ...canopy, repos: { ...canopy.repos, ...api.repos } });
      }
      if (url.pathname === "/api/costs") return Response.json({ since: 0, rows: [costRow("codex", "repo", "canopy", 3), costRow("speech", "api", "api", 4)], priced: false });
      return new Response("not found", { status: 404 });
    },
  });
  const oldApi = process.env["CANOPY_API"];
  const oldLog = console.log;
  const output: string[] = [];
  process.env["CANOPY_API"] = `http://127.0.0.1:${home.port}`;
  console.log = (...parts: unknown[]) => output.push(parts.join(" "));
  try {
    await main(["costs", "--days", "30", "--share"]);
  } finally {
    console.log = oldLog;
    if (oldApi === undefined) delete process.env["CANOPY_API"];
    else process.env["CANOPY_API"] = oldApi;
    home.stop(true);
    mini.stop(true);
    devhub.stop(true);
  }

  expect(homeRequests).toContain("GET /api/backends");
  expect(homeRequests).toContain("GET /api/costs?days=30");
  expect(miniRequests).toContain("GET /api/tree");
  expect(miniRequests).toContain("GET /api/history?window=90d");
  expect(miniRequests).toContain("GET /api/costs?days=30");
  expect(devhubRequests).toContain("GET /api/costs?days=30");
  expect(output.join("\n")).toContain("30 days: $23.00");
  expect(output.join("\n")).toContain("harness 74% of $23.00 · 80% of 5 sessions  (canopy, runner, devhub)");
  expect(output.join("\n")).toContain("  canopy                         $11.00");
  expect(output.filter((line) => line.includes("  canopy "))).toHaveLength(1);
});

test("costs names a backend after excluding it when any required endpoint fails", async () => {
  const peerRequests: string[] = [];
  const peer = fakeBackend({ repos: [], history: archive("unused", 0, 0), rows: [] }, peerRequests, "/api/history");
  const homeRequests: string[] = [];
  const home = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      homeRequests.push(`${request.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/api/backends") {
        return Response.json({ self: "mac", backends: [{ name: "mini", tailnet: `http://127.0.0.1:${peer.port}` }] });
      }
      if (url.pathname === "/api/tree") return Response.json(tree([]));
      if (url.pathname === "/api/history") return Response.json({ available: false, reason: "no archive", fetchedAt: 0 } satisfies HistoryOverview);
      if (url.pathname === "/api/costs") return Response.json({ since: 0, rows: [], priced: false });
      return new Response("not found", { status: 404 });
    },
  });
  const oldApi = process.env["CANOPY_API"];
  const oldLog = console.log;
  const output: string[] = [];
  process.env["CANOPY_API"] = `http://127.0.0.1:${home.port}`;
  console.log = (...parts: unknown[]) => output.push(parts.join(" "));
  try {
    await main(["costs", "--days", "1", "--share"]);
  } finally {
    console.log = oldLog;
    if (oldApi === undefined) delete process.env["CANOPY_API"];
    else process.env["CANOPY_API"] = oldApi;
    home.stop(true);
    peer.stop(true);
  }

  expect(homeRequests).toContain("GET /api/costs?days=1");
  expect(peerRequests).toContain("GET /api/history?window=90d");
  expect(output.at(-1)).toBe("not counted: mini: archive offline");
});
