import { expect, test } from "bun:test";
import { EXPORT_OUTPUT, exportRun } from "./export";
import type { Run } from "./types";

const tok = `cnp_shell_${"c".repeat(43)}`;

const run: Run = {
  id: "ab12cd34",
  repoId: "dev-tools/canopy",
  action: "build",
  verb: "Build",
  progress: "",
  expectsChange: true,
  chat: false,
  harness: "claude",
  note: "add the thing",
  status: "done",
  startedAt: Date.UTC(2026, 9, 26, 10, 0, 0),
  endedAt: Date.UTC(2026, 9, 26, 10, 2, 5),
  steps: [
    { id: "1", at: 1, kind: "text", text: "I will look first." },
    {
      id: "2",
      at: 2,
      kind: "tool",
      tool: {
        name: "Bash",
        title: "git status",
        status: "ok",
        output: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"),
      },
    },
    { id: "3", at: 3, kind: "note", text: "allowed: Bash git push" },
    {
      id: "4",
      at: 4,
      kind: "tool",
      tool: { name: "Agent", title: "find the tests", status: "ok" },
    },
    { id: "5", at: 5, kind: "text", text: "Found two.", parent: "4" },
    {
      id: "6",
      at: 6,
      kind: "tool",
      tool: { name: "Read", title: "src/a.ts", status: "ok", output: `token ${tok}` },
      parent: "4",
    },
    { id: "7", at: 7, kind: "user", text: "thanks" },
  ],
  prompt: null,
  result: {
    text: "Done, two tests added.",
    costUsd: 0.4219,
    durationMs: 125_000,
    turns: 3,
    model: "claude-opus-5-5",
  },
  branch: {
    name: "run/add-ab12cd34",
    target: "main",
    base: "deadbeef",
    dir: "/w",
    state: "ready",
    origin: "ab12cd34",
  },
};

test("the head, the ordered timeline, the result and the redaction count", () => {
  const md = exportRun(run, [{ name: "CANOPY_TOKEN", value: tok }], {
    repoName: "canopy",
    where: "landed on main",
  });
  const lines = md.split("\n");
  expect(lines.slice(0, 9)).toEqual([
    "# Build in canopy",
    "",
    "- run: ab12cd34",
    "- action: build",
    "- agent: Claude Code, model claude-opus-5-5",
    "- when: 2026-10-26T10:00:00.000Z to 2026-10-26T10:02:05.000Z, 2:05",
    "- cost: $0.42",
    "- note: add the thing",
    "- branch: run/add-ab12cd34 onto main, landed on main",
  ]);

  expect(md).toContain("\n## Timeline\n\nI will look first.\n\n<details>\n<summary>Bash: git status (ok)</summary>\n\n```\nline 1\n");
  expect(md).toContain(`line ${EXPORT_OUTPUT}\n\`\`\`\n\n… 10 more lines\n\n</details>\n`);
  expect(md).not.toContain("line 41");
  expect(md).toContain("\n> allowed: Bash git push\n");

  const agentStart = md.indexOf("<details>\n<summary>Agent: find the tests (ok)</summary>");
  const agentEnd = md.indexOf("\n</details>", agentStart);
  expect(agentStart).toBeGreaterThan(-1);
  expect(agentEnd).toBeGreaterThan(agentStart);
  expect(md.slice(agentStart, agentEnd)).not.toContain("```");
  expect(md).toContain("\n  Found two.\n");
  expect(md).toContain("\n  <details>\n  <summary>Read: src/a.ts (ok)</summary>\n");
  expect(md).toContain("\n  <summary>Read: src/a.ts (ok)</summary>\n");

  const timelinePositions = [
    "I will look first.",
    "<summary>Bash: git status (ok)</summary>",
    "> allowed: Bash git push",
    "<summary>Agent: find the tests (ok)</summary>",
    "Found two.",
    "<summary>Read: src/a.ts (ok)</summary>",
    "**you:** thanks",
  ].map((marker) => md.indexOf(marker));
  expect(timelinePositions.every((position) => position >= 0)).toBe(true);
  expect(timelinePositions).toEqual([...timelinePositions].sort((a, b) => a - b));

  expect(md).toContain("\n**you:** thanks\n");
  expect(md).toContain("\n## Result\n\nDone, two tests added.\n");
  expect(md.endsWith("\n---\n1 value redacted\n")).toBe(true);
  expect(md).not.toContain(tok);
  expect(md).toContain("<redacted:CANOPY_TOKEN>");
});

test("a Codex run uses grouped token cost and falls back to branch state", () => {
  const codexRun: Run = {
    ...run,
    harness: "codex",
    note: "",
    steps: [],
    result: {
      text: "ok",
      durationMs: 1_000,
      turns: 1,
      tokens: { input: 1_000, cachedInput: 0, output: 234, reasoning: 0, total: 1_234 },
    },
  };
  const md = exportRun(codexRun, [], { repoName: "canopy" });
  expect(md).toContain("- agent: Codex, model unknown\n");
  expect(md).toContain("- cost: 1,234 tokens\n");
  expect(md).toContain("- branch: run/add-ab12cd34 onto main, ready\n");
  expect(md).toContain("\n## Timeline\n\n## Result\n");
  expect(md).not.toContain("- note:");
  expect(md.endsWith("\n---\nnothing redacted\n")).toBe(true);
});

test("a stopped run with no result or end uses the supplied current time", () => {
  const stoppedRun: Run = {
    ...run,
    status: "stopped",
    endedAt: undefined,
    result: undefined,
    branch: undefined,
    steps: [{ id: "trim", at: 0, kind: "note", text: "earlier steps trimmed" }],
  };
  const md = exportRun(stoppedRun, [], {
    repoName: "canopy",
    now: Date.UTC(2026, 9, 26, 10, 1, 0),
  });
  expect(md).toContain("- when: 2026-10-26T10:00:00.000Z to now, 1:00\n");
  expect(md).toContain("- cost: unknown\n");
  expect(md).toContain("\n> earlier steps trimmed\n");
  expect(md).toContain("\n## Result\n\nNo result: the run stopped.\n");
});

test("USD cost takes precedence over tokens and formats to two decimals", () => {
  const pricedRun: Run = {
    ...run,
    result: {
      text: "ok",
      costUsd: 1.5,
      durationMs: 0,
      turns: 0,
      tokens: { input: 1, cachedInput: 0, output: 1, reasoning: 0, total: 2 },
    },
  };
  const md = exportRun(pricedRun, [], { repoName: "canopy" });
  expect(md).toContain("- cost: $1.50\n");
});
