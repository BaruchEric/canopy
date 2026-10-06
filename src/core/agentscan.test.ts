import { describe, expect, test } from "bun:test";
import { classify, inContainer, parseLstart, parsePsComm, parsePsLong, pickAgents, scanBody, type AgentProc } from "./agentscan";
import { parseBootTime, parseCmdline, parseStat, tickTime, type Proc } from "./procs";
import type { Repo } from "./types";

/* A slice of a Linux box's /proc, as the shells container shows it: a
   login bash, Claude Code in it, a bun-installed codex (node over its native
   child), a zombie claude, and things that only look like agents. */
const STAT: Record<number, string> = {
  1: "1 (tini) S 0 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 1500 2000000 100 18446744073709551615",
  40: "40 (bash) S 1 40 40 34816 40 4194304 0 0 0 0 0 0 0 0 20 0 1 0 2000 9000000 900 18446744073709551615",
  41: "41 (claude) S 40 41 40 34816 41 4194304 0 0 0 0 0 0 0 0 20 0 12 0 360000 900000000 90000 18446744073709551615",
  50: "50 (node) S 40 50 40 34817 50 4194304 0 0 0 0 0 0 0 0 20 0 11 0 400000 900000000 9000 18446744073709551615",
  51: "51 (codex) S 50 50 40 34817 50 4194304 0 0 0 0 0 0 0 0 20 0 9 0 400100 900000000 9000 18446744073709551615",
  60: "60 (claude) Z 40 60 40 34816 60 4194304 0 0 0 0 0 0 0 0 20 0 1 0 500000 0 0 18446744073709551615",
  70: "70 (vim) S 40 70 40 34816 70 4194304 0 0 0 0 0 0 0 0 20 0 1 0 600000 9000000 900 18446744073709551615",
  71: "71 (which) S 40 71 40 34816 71 4194304 0 0 0 0 0 0 0 0 20 0 1 0 600100 9000000 900 18446744073709551615",
  72: "72 (claude-history) S 40 72 40 34816 72 4194304 0 0 0 0 0 0 0 0 20 0 1 0 600200 9000000 900 18446744073709551615",
};
const CMDLINE: Record<number, string> = {
  1: "/sbin/tini\0--\0tmux\0",
  40: "-bash\0",
  41: "claude\0--dangerously-skip-permissions\0",
  50: "node\0/home/bun/.bun/bin/codex\0--no-daemon\0",
  51: "/home/bun/.bun/install/global/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex\0--no-daemon\0",
  60: "",
  70: "vim\0/home/bun/dev/codex/notes.md\0",
  71: "which\0claude\0",
  72: "claude-history\0--json\0",
};
const PROC_STAT = "cpu  1 2 3 4\nintr 99\nctxt 12\nbtime 1790000000\nprocesses 900\n";

function table(): Proc[] {
  const boot = parseBootTime(PROC_STAT)!;
  return Object.keys(STAT).map((k) => {
    const pid = Number(k);
    const f = parseStat(STAT[pid]!)!;
    return { pid, ppid: f.ppid, argv: parseCmdline(CMDLINE[pid]!), comm: f.comm, state: f.state, startedAt: tickTime(boot, f.start!) };
  });
}

describe("/proc", () => {
  test("a stat line's comm, state, ppid and start, whatever the comm holds", () => {
    expect(parseStat(STAT[41]!)).toEqual({ comm: "claude", state: "S", ppid: 40, start: 360000 });
    expect(parseStat("77 (my (odd) name) R 1 77 77 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 42 0 0")).toEqual({ comm: "my (odd) name", state: "R", ppid: 1, start: 42 });
    expect(parseStat("5 (short) S 1 5")?.start).toBeNull();
    expect(parseStat("garbage")).toBeNull();
  });

  test("the boot time, and a start in ticks as unix ms", () => {
    expect(parseBootTime(PROC_STAT)).toBe(1790000000);
    expect(parseBootTime("cpu 1 2\n")).toBeNull();
    expect(tickTime(1790000000, 360000)).toBe(1790000000_000 + 3_600_000);
  });

  test("the agents in the table: claude, and codex once by its node wrapper", () => {
    const hits = pickAgents(table());
    expect(hits.map((h) => [h.pid, h.harness])).toEqual([
      [41, "claude"],
      [50, "codex"],
    ]);
    expect(hits[0]?.startedAt).toBe(1790000000_000 + 3_600_000);
  });
});

describe("a Mac's ps and lsof", () => {
  const LONG = [
    "    1     0 Tue Sep 29 08:00:01 2026     /sbin/launchd",
    "  880   870 Wed Sep 30 10:11:12 2026     claude --model opus",
    "  990   870 Wed Sep  3 09:05:00 2026     node /opt/homebrew/bin/codex",
    "  991   990 Wed Sep  3 09:05:01 2026     /opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex",
    "  995   870 Wed Sep 30 11:00:00 2026     /Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=renderer",
    "not a line",
  ].join("\n");
  const COMM = [
    "    1 /sbin/launchd",
    "  880 /Users/eric/.local/share/claude/versions/2.1.286",
    "  990 node",
    "  991 /opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex",
    "  995 /Applications/Visual Studio Code.app/Contents/MacOS/Electron",
  ].join("\n");

  test("lstart is local time", () => {
    expect(parseLstart("Wed Sep 30 10:11:12 2026")).toBe(new Date(2026, 8, 30, 10, 11, 12).getTime());
    expect(parseLstart("Wed Sep  3 09:05:00 2026")).toBe(new Date(2026, 8, 3, 9, 5, 0).getTime());
    expect(parseLstart("Wed Foo 30 10:11:12 2026")).toBeNull();
  });

  test("the long lines and the comms, joined by pid", () => {
    const procs = parsePsLong(LONG);
    expect(procs.map((p) => [p.pid, p.ppid, p.argv[0]])).toEqual([
      [1, 0, "/sbin/launchd"],
      [880, 870, "claude"],
      [990, 870, "node"],
      [991, 990, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex"],
      [995, 870, "/Applications/Visual"],
    ]);
    const comms = parsePsComm(COMM);
    expect(comms.get(995)).toBe("/Applications/Visual Studio Code.app/Contents/MacOS/Electron");
    const hits = pickAgents(procs.map((p) => ({ ...p, comm: comms.get(p.pid) })));
    expect(hits.map((h) => [h.pid, h.harness, h.startedAt])).toEqual([
      [880, "claude", new Date(2026, 8, 30, 10, 11, 12).getTime()],
      [990, "codex", new Date(2026, 8, 3, 9, 5, 0).getTime()],
    ]);
  });
});

describe("classify", () => {
  test("by comm, by version file, by an interpreter's script, and nothing else", () => {
    expect(classify("claude", ["claude"])).toBe("claude");
    expect(classify("/Users/e/.local/share/claude/versions/2.1.286", ["claude"])).toBe("claude");
    expect(classify("2.1.286", ["2.1.286"])).toBe("claude");
    expect(classify("2.1.286", ["ruby", "x"])).toBeNull();
    expect(classify("codex", ["/x/codex"])).toBe("codex");
    expect(classify("node", ["node", "/x/@openai/codex/bin/codex.js"])).toBe("codex");
    expect(classify("bun", ["bun", "/x/node_modules/@anthropic-ai/claude-code/cli.js"])).toBe("claude");
    expect(classify("which", ["which", "claude"])).toBeNull();
    expect(classify("vim", ["vim", "/tmp/codex"])).toBeNull();
    expect(classify("claude-history", ["claude-history"])).toBeNull();
  });

  test("Claude's helpers are no agent, and a pty host's session counts once", () => {
    expect(classify("/Users/e/.local/bin/claude", ["/Users/e/.local/bin/claude", "--chrome-native-host"])).toBeNull();
    expect(classify("/Users/e/.local/bin/claude", ["/Users/e/.local/bin/claude", "daemon", "run", "--origin", "transient"])).toBeNull();
    expect(classify("claude bg-pty-host", ["claude", "bg-pty-host", "--bg-pty-host", "/tmp/x.sock"])).toBeNull();
    expect(classify("claude bg-spare", ["claude", "bg-spare", "--bg-spare", "/tmp/x.sock"])).toBeNull();
    const ver = "/Users/e/.local/share/claude/versions/2.1.290";
    const procs = [
      { pid: 10, ppid: 1, comm: "/Users/e/.local/bin/claude", argv: ["/Users/e/.local/bin/claude", "daemon", "run"], state: "S" },
      { pid: 11, ppid: 10, comm: "/x/ClaudeCode.app/Contents/MacOS/claude", argv: ["/x/claude", "--bg-pty-host", "/tmp/a.sock", "--", ver], state: "S" },
      { pid: 12, ppid: 11, comm: ver, argv: [ver, "--session-id", "s"], state: "S" },
      { pid: 13, ppid: 10, comm: "claude bg-spare", argv: ["claude", "bg-spare", "--bg-spare", "/tmp/b.sock"], state: "S" },
    ];
    expect(pickAgents(procs).map((p) => p.pid)).toEqual([12]);
  });
});

describe("the post", () => {
  const repo = (over: Partial<Repo>): Repo => ({ id: "app", name: "app", path: "/dev/app", group: "", source: "root", status: null, ...over });
  const repos: Repo[] = [
    repo({ id: "app", path: "/dev/app", link: "https://github.com/me/app", status: { branch: "main" } as Repo["status"] }),
    repo({ id: "app/sub", name: "sub", path: "/dev/app/sub", link: "https://github.com/me/sub" }),
    repo({ id: "far", path: "ssh://mini/dev/far", host: "mini", link: "https://github.com/me/far" }),
  ];
  const procs: AgentProc[] = [
    { pid: 41, ppid: 40, harness: "claude", cwd: "/dev/app/src", startedAt: 5 },
    { pid: 42, ppid: 40, harness: "codex", cwd: "/dev/app/sub", startedAt: 6 },
    { pid: 43, ppid: 40, harness: "claude", cwd: "/dev/far", startedAt: 7 },
    { pid: 44, ppid: 40, harness: "claude", cwd: "", startedAt: 8 },
  ];

  test("each agent with the deepest local repo its folder is in", () => {
    expect(scanBody(procs, repos, true, "linux")).toEqual({
      container: true,
      os: "linux",
      procs: [
        { pid: 41, harness: "claude", cwd: "/dev/app/src", startedAt: 5, repo: "https://github.com/me/app", branch: "main" },
        { pid: 42, harness: "codex", cwd: "/dev/app/sub", startedAt: 6, repo: "https://github.com/me/sub" },
        { pid: 43, harness: "claude", cwd: "/dev/far", startedAt: 7 },
        { pid: 44, harness: "claude", cwd: "", startedAt: 8 },
      ],
    });
  });

  test("a container is told by docker's or podman's marker", () => {
    expect(inContainer((p) => p === "/.dockerenv")).toBe(true);
    expect(inContainer((p) => p === "/run/.containerenv")).toBe(true);
    expect(inContainer(() => false)).toBe(false);
  });
});
