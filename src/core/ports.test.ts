import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lsofBin, mayServeHttp, mergeListeners, parseLsofCwd, parseLsofListen, parseProcNet, repoOfCwd, portUnder, treeOfPort } from "./ports";

const HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const row = (addr: string, st: string, inode: string) =>
  `   0: ${addr} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;

describe("parseProcNet", () => {
  test("keeps loopback and wildcard listeners, drops the rest", () => {
    const text = [
      HEAD,
      row("0100007F:1435", "0A", "111"), // 127.0.0.1:5173
      row("00000000:0BB8", "0A", "222"), // 0.0.0.0:3000
      row("0A00000A:1F90", "0A", "333"), // 10.0.0.10:8080, not reachable on loopback
      row("0100007F:1436", "01", "444"), // established, not listening
    ].join("\n");
    expect(parseProcNet(text, 4)).toEqual([
      { port: 5173, family: 4, inode: "111" },
      { port: 3000, family: 4, inode: "222" },
    ]);
  });

  test("reads v6 loopback, wildcard and v4-mapped loopback", () => {
    const text = [
      HEAD,
      row("00000000000000000000000001000000:1435", "0A", "1"),
      row("00000000000000000000000000000000:0050", "0A", "2"),
      row("0000000000000000FFFF00000100007F:1F90", "0A", "3"),
      row("B80D0120000000000000000001000000:1F91", "0A", "4"),
    ].join("\n");
    expect(parseProcNet(text, 6).map((l) => l.port)).toEqual([5173, 80, 8080]);
  });
});

describe("lsof", () => {
  test("listening sockets by process", () => {
    const text = ["p501", "cnode", "n127.0.0.1:5173", "n[::1]:5173", "n192.168.1.4:9", "p77", "cbun", "n*:3000", ""].join("\n");
    expect(parseLsofListen(text)).toEqual([
      { port: 5173, family: 4, pid: 501, command: "node" },
      { port: 5173, family: 6, pid: 501, command: "node" },
      { port: 3000, family: 4, pid: 77, command: "bun" },
    ]);
  });

  test("working folders by pid", () => {
    expect(parseLsofCwd("p501\nfcwd\nn/Users/e/dev/app\np77\nfcwd\nn/tmp\n")).toEqual(
      new Map([
        [501, "/Users/e/dev/app"],
        [77, "/tmp"],
      ]),
    );
  });

  test("the program by its path: where PATH finds it, else a Mac's own /usr/sbin, which a short PATH leaves out", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "canopy-lsof-"));
    try {
      await writeFile(join(scratch, "lsof"), "#!/bin/sh\n", { mode: 0o755 });
      expect(lsofBin(`/nowhere-at-all:${scratch}`)).toBe(join(scratch, "lsof"));
      expect(lsofBin("/nowhere-at-all")).toBe("/usr/sbin/lsof");
      expect(lsofBin("")).toBe("/usr/sbin/lsof");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

test("mergeListeners: one per port, v4 first, process filled from either", () => {
  expect(
    mergeListeners([
      { port: 5173, family: 6, pid: 9, command: "node", cwd: "/r" },
      { port: 5173, family: 4 },
      { port: 80, family: 6 },
    ]),
  ).toEqual([
    { port: 80, host: "[::1]" },
    { port: 5173, host: "127.0.0.1", pid: 9, command: "node", cwd: "/r" },
  ]);
});

test("repoOfCwd: the deepest repo holding the folder", () => {
  const repos = [
    { id: "app", path: "/dev/app" },
    { id: "app/sub", path: "/dev/app/sub" },
    { id: "apple", path: "/dev/apple" },
  ];
  expect(repoOfCwd("/dev/app", repos)).toBe("app");
  expect(repoOfCwd("/dev/app/web", repos)).toBe("app");
  expect(repoOfCwd("/dev/app/sub/x", repos)).toBe("app/sub");
  expect(repoOfCwd("/dev/apple2", repos)).toBeUndefined();
  expect(repoOfCwd(undefined, repos)).toBeUndefined();
});

test("mayServeHttp: adb and the databases never do, anything else or unknown may", () => {
  // adb forks its server with the caller's cwd, so a shell in a repo makes
  // 5037 the repo's lowest port and its default preview
  expect(mayServeHttp("adb")).toBe(false);
  expect(mayServeHttp("postgres")).toBe(false);
  expect(mayServeHttp("redis-server")).toBe(false);
  expect(mayServeHttp("bun")).toBe(true);
  expect(mayServeHttp("node")).toBe(true);
  expect(mayServeHttp(undefined)).toBe(true);
});

describe("ports in worktrees", () => {
  const ls = [
    { port: 3000, host: "127.0.0.1", cwd: "/w/a-other" },
    { port: 5174, host: "127.0.0.1", cwd: "/w/a/ui", command: "node" },
    { port: 5173, host: "127.0.0.1", cwd: "/w/a", command: "node" },
    { port: 5037, host: "127.0.0.1", cwd: "/w/a", command: "adb" },
  ];

  test("a task's own port is the lowest web port under its folder", () => {
    expect(portUnder(ls, "/w/a")).toBe(5173);
    expect(portUnder(ls, "/w/none")).toBeUndefined();
  });

  test("a held port names its task and branch, a folder its branch, and anything else nothing", () => {
    const trees = [
      { repoId: "r", dir: "/w/a", branch: "run/a", task: "dev", ports: [7901] },
      { repoId: "r", dir: "/w/b", branch: "run/b" },
    ];
    expect(treeOfPort({ port: 7901 }, trees)).toEqual({ repo: "r", name: "dev · run/a" });
    expect(treeOfPort({ port: 5173, cwd: "/w/a/ui" }, trees)).toEqual({ repo: "r", name: "dev · run/a" });
    expect(treeOfPort({ port: 5173, cwd: "/w/b" }, trees)).toEqual({ repo: "r", name: "run/b" });
    expect(treeOfPort({ port: 5173, cwd: "/w/bb" }, trees)).toBeUndefined();
    expect(treeOfPort({ port: 22 }, trees)).toBeUndefined();
  });
});
