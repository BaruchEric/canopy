/**
 * What a shell leaves behind, the pure half: telling an agent shell from a
 * plain one off what tmux says about the pane, capping a capture, reading a
 * record back, and which records are still worth offering.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_AGENT } from "./types";
import { agentIn, clip, continueLine, countLines, expiredShells, KEEP_DAYS, lostShells, parseKept, replayCommand, restoredBanner } from "./keep";
import type { KeptShell } from "./types";

const shell = (over: Partial<KeptShell> = {}): KeptShell => ({
  id: "0123456789abcdef0123456789abcdef",
  repoId: "app",
  path: "/dev/app",
  place: "strip",
  startedAt: 1_000,
  savedAt: 2_000,
  lines: 12,
  agent: null,
  ...over,
});

describe("agentIn", () => {
  test("reads the shapes this machine actually reports", () => {
    // measured on a canopy shell running each: Claude Code's process title
    // is its own version, codex reports its name and titles the pane after
    // the folder, a plain shell reports the shell
    expect(agentIn("2.1.278", "claude agents")).toBe("claude");
    expect(agentIn("codex", "canopy")).toBe("codex");
    expect(agentIn("zsh", "Erics-MacBook-Pro.local")).toBeNull();
  });

  test("either field naming the agent is enough", () => {
    expect(agentIn("claude", "")).toBe("claude");
    expect(agentIn("node", "Claude Code")).toBe("claude");
    expect(agentIn("codex-exec", "")).toBe("codex");
  });

  test("a plain shell is never an agent, whatever the folder is called", () => {
    expect(agentIn("zsh", "claude-history")).toBeNull();
    expect(agentIn("-bash", "codex")).toBeNull();
    expect(agentIn("", "")).toBeNull();
  });

  test("a version is Claude Code; anything else running is nobody canopy knows", () => {
    expect(agentIn("2.1.278", "canopy")).toBe("claude");
    expect(agentIn("vim", "README.md")).toBeNull();
    expect(agentIn("git", "")).toBeNull();
  });
});

describe("agentIn off the processes under the pane", () => {
  test("a bun-installed codex runs as node, which only its argv tells", () => {
    expect(agentIn("node", "app")).toBeNull();
    expect(agentIn("node", "fix the scan | app", [["-bash"], ["node", "/home/bun/.bun/install/global/node_modules/@openai/codex/bin/codex.js", "--no-daemon"]])).toBe("codex");
    expect(agentIn("node", "app", [["/home/bun/.bun/bin/codex", "resume"]])).toBe("codex");
    expect(agentIn("node", "app", [["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"]])).toBe("claude");
  });

  test("Claude Code on Linux: its own name and its asterisk title", () => {
    expect(agentIn("claude", "✳ Claude Code")).toBe("claude");
    expect(agentIn("node", "✳ Claude Code")).toBe("claude");
  });

  test("an argument that only mentions an agent is not one, and a shell is never one", () => {
    expect(agentIn("vim", "notes", [["vim", "/tmp/codex/notes.md"]])).toBeNull();
    expect(agentIn("node", "app", [["node", "server.js", "/srv/codex/x"]])).toBeNull();
    expect(agentIn("bash", "app", [["node", "/x/@openai/codex/bin/codex.js"]])).toBeNull();
  });
});

describe("continueLine", () => {
  test("either harness is offered a continue, a shell with no agent none", () => {
    expect(continueLine("claude")).toBe("claude --continue");
    expect(continueLine("codex")).toBe("codex resume --last --no-daemon");
    expect(continueLine(null)).toBeNull();
  });

  test("a codex continue hands its commands the shell's handle", () => {
    expect(continueLine("codex", undefined, { TAILCHAN_AS: "app-1a2b" })).toBe(
      `codex resume --last --no-daemon -c 'shell_environment_policy.set.TAILCHAN_AS="app-1a2b"'`,
    );
  });

  test("the repo's settings ride along when they are the same harness's", () => {
    expect(continueLine("claude", DEFAULT_AGENT)).toBe("claude --dangerously-skip-permissions --continue");
    expect(continueLine("codex", { ...DEFAULT_AGENT, harness: "codex", effort: "high", yolo: false })).toBe(
      "codex resume --last -c model_reasoning_effort=high -a on-request -s workspace-write --no-daemon",
    );
    expect(continueLine("codex", DEFAULT_AGENT)).toBe("codex resume --last --no-daemon");
  });
});

describe("replayCommand", () => {
  test("prints the banner and the history, drops the file, then becomes the shell", () => {
    const cmd = replayCommand("/cfg/shells/a.replay.txt", "[restored]", ["/bin/zsh", "-l", "-i"]);
    expect(cmd[0]).toBe("sh");
    expect(cmd[1]).toBe("-c");
    expect(cmd[2]).toBe(
      String.raw`printf '%s\n' '[restored]'; cat '/cfg/shells/a.replay.txt' 2>/dev/null; rm -f '/cfg/shells/a.replay.txt'; exec '/bin/zsh' '-l' '-i'`,
    );
  });

  test("a banner or a path with a quote in it cannot break out of the script", () => {
    const cmd = replayCommand("/tmp/it's here.txt", "don't", ["sh"]);
    expect(cmd[2]).toContain(String.raw`'/tmp/it'\''s here.txt'`);
    expect(cmd[2]).toContain(String.raw`'don'\''t'`);
  });
});

describe("clip", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

  test("keeps the last lines, which is what was on screen most recently", () => {
    expect(clip(lines(10), 3)).toBe("line 7\nline 8\nline 9");
    expect(clip(lines(3), 10)).toBe("line 0\nline 1\nline 2");
    expect(clip("", 10)).toBe("");
  });

  test("and never more than the byte cap, whole lines first", () => {
    const fat = ["x".repeat(40), "y".repeat(40), "z".repeat(10)].join("\n");
    expect(clip(fat, 100, 60)).toBe(`${"y".repeat(40)}\n${"z".repeat(10)}`);
    // one line longer than the cap is cut to its tail rather than dropped
    expect(clip("q".repeat(100), 100, 10)).toBe("q".repeat(10));
  });

  test("countLines counts what was kept", () => {
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("")).toBe(0);
  });
});

describe("parseKept", () => {
  test("reads a record back", () => {
    expect(parseKept(JSON.stringify(shell({ agent: "claude" })))).toEqual(shell({ agent: "claude" }));
  });

  test("an unknown place is the strip, a missing start is when it was saved", () => {
    const raw = JSON.stringify({ ...shell(), place: "nowhere", startedAt: undefined, agent: "emacs" });
    expect(parseKept(raw)).toEqual(shell({ place: "strip", startedAt: 2_000, agent: null }));
  });

  test("null for anything that is not a record", () => {
    expect(parseKept("{")).toBeNull();
    expect(parseKept("[]")).toBeNull();
    expect(parseKept(JSON.stringify(shell({ id: "not-a-shell-name" })))).toBeNull();
    expect(parseKept(JSON.stringify(shell({ repoId: "" })))).toBeNull();
    expect(parseKept(JSON.stringify(shell({ path: "" })))).toBeNull();
  });
});

describe("lostShells", () => {
  const a = shell({ id: "a".repeat(32), savedAt: 1 });
  const b = shell({ id: "b".repeat(32), savedAt: 3 });
  const c = shell({ id: "c".repeat(32), savedAt: 2 });

  test("the ones no live session answers for, newest first", () => {
    expect(lostShells([a, b, c], [a.id]).map((k) => k.id)).toEqual([b.id, c.id]);
    expect(lostShells([a, b, c], [a.id, b.id, c.id])).toEqual([]);
    expect(lostShells([], ["whatever"])).toEqual([]);
  });
});

describe("expiredShells", () => {
  test("the ones past the retention window", () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const old = shell({ id: "a".repeat(32), savedAt: now - (KEEP_DAYS + 1) * 24 * 60 * 60 * 1000 });
    const fresh = shell({ id: "b".repeat(32), savedAt: now - 60_000 });
    expect(expiredShells([old, fresh], now)).toEqual([old.id]);
    expect(expiredShells([old, fresh], now, 365)).toEqual([]);
  });
});

describe("restoredBanner", () => {
  test("says what it is and how old what follows is", () => {
    expect(restoredBanner("22/09/2026, 07:31")).toContain("[restored by canopy]");
    expect(restoredBanner("22/09/2026, 07:31")).toContain("22/09/2026, 07:31");
  });
});
