import { describe, expect, test } from "bun:test";
import { descendants, parseCmdline, parsePs, parseStatPpid, type Proc } from "./procs";

describe("reading the process table", () => {
  test("a stat line's ppid, whatever the command's name holds", () => {
    expect(parseStatPpid("4242 (node) S 4200 4242 4200 34816 4242 4194304 0 0")).toBe(4200);
    expect(parseStatPpid("77 (my (odd) name) R 1 77 77 0 -1")).toBe(1);
    expect(parseStatPpid("garbage")).toBeNull();
    expect(parseStatPpid("5 (x) S notanumber")).toBeNull();
  });

  test("a cmdline's words, and none for a kernel thread", () => {
    expect(parseCmdline("node\0/x/@openai/codex/bin/codex.js\0--no-daemon\0")).toEqual(["node", "/x/@openai/codex/bin/codex.js", "--no-daemon"]);
    expect(parseCmdline("")).toEqual([]);
  });

  test("ps lines on a Mac", () => {
    expect(parsePs("  101     1 /bin/zsh -l\n  202   101 node /usr/local/lib/node_modules/@openai/codex/bin/codex.js\nbad line\n")).toEqual([
      { pid: 101, ppid: 1, argv: ["/bin/zsh", "-l"] },
      { pid: 202, ppid: 101, argv: ["node", "/usr/local/lib/node_modules/@openai/codex/bin/codex.js"] },
    ]);
  });
});

describe("the processes under a pane", () => {
  const procs: Proc[] = [
    { pid: 1, ppid: 0, argv: ["init"] },
    { pid: 10, ppid: 1, argv: ["-bash"] },
    { pid: 11, ppid: 10, argv: ["node", "codex.js"] },
    { pid: 12, ppid: 11, argv: ["codex-native"] },
    { pid: 20, ppid: 1, argv: ["other"] },
  ];

  test("the root first, then each before its children, nothing from beside it", () => {
    expect(descendants(procs, 10).map((p) => p.pid)).toEqual([10, 11, 12]);
    expect(descendants(procs, 20).map((p) => p.pid)).toEqual([20]);
  });

  test("a root that has gone still has its children looked at, and the walk is capped", () => {
    expect(descendants(procs.filter((p) => p.pid !== 10), 10).map((p) => p.pid)).toEqual([11, 12]);
    expect(descendants(procs, 1, 2).map((p) => p.pid)).toEqual([1, 10]);
    expect(descendants(procs, 999)).toEqual([]);
  });
});
