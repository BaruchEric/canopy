import { describe, expect, test } from "bun:test";
import { mergeListeners, parseLsofCwd, parseLsofListen, parseProcNet, repoOfCwd } from "./ports";

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
