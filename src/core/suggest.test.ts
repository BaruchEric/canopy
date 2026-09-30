import { describe, expect, test } from "bun:test";
import { claudeSuggestArgs, codexSuggestArgs, heuristicMessage } from "./suggest";
import { DEFAULT_AGENT, type AgentSettings, type RepoFile } from "./types";

const codex = (over: Partial<AgentSettings> = {}): AgentSettings => ({ ...DEFAULT_AGENT, harness: "codex", ...over });

describe("the suggestion's command lines", () => {
  test("claude at the defaults is the print-mode line it always was", () => {
    expect(claudeSuggestArgs(DEFAULT_AGENT, "P")).toEqual(["-p", "P", "--output-format", "text"]);
    expect(claudeSuggestArgs({ ...DEFAULT_AGENT, model: "haiku", effort: "low", extra: "--x" }, "P")).toEqual([
      "-p",
      "P",
      "--output-format",
      "text",
      "--model",
      "haiku",
      "--effort",
      "low",
    ]);
  });

  test("codex exec: read-only, off disk, from the repo, the last message into a file, the prompt last", () => {
    expect(codexSuggestArgs(codex(), "/r", "/tmp/o.txt", "P")).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--skip-git-repo-check",
      "--color",
      "never",
      "-C",
      "/r",
      "-o",
      "/tmp/o.txt",
      "P",
    ]);
    const tuned = codexSuggestArgs(codex({ model: "gpt-5.5", effort: "high", extra: "-c a=1 --search" }), "/r", "/o", "P");
    expect(tuned.slice(-7)).toEqual(["-m", "gpt-5.5", "-c", "model_reasoning_effort=high", "-c", "a=1", "P"]);
    // yolo never reaches a suggestion: it needs no tools
    expect(codexSuggestArgs(codex({ yolo: true }), "/r", "/o", "P")).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
});

describe("the heuristic", () => {
  test("names the busiest areas", () => {
    const f = (path: string, untracked = false): RepoFile => ({ path, index: ".", worktree: "M", untracked }) as RepoFile;
    expect(heuristicMessage([])).toBe("update");
    expect(heuristicMessage([f("src/a.ts"), f("src/b.ts"), f("README.md")])).toBe("update src (2), root (1)");
    expect(heuristicMessage([f("docs/x.md", true)])).toBe("add docs (1)");
  });
});
