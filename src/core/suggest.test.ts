import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, type ExecOptions, type ExecResult } from "./exec";
import { claudeSuggestArgs, codexSuggestArgs, codexSuggestDir, heuristicMessage, suggestMessage } from "./suggest";
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

  test("codex runs in the repo when it is here, and in the scratch folder for one on another host", () => {
    expect(codexSuggestDir("/srv/dev/app", "/tmp/canopy-suggest-x")).toBe("/srv/dev/app");
    // an ssh:// locator is no folder on this machine: codex would fail to start there
    expect(codexSuggestDir("ssh://qnap/share/app", "/tmp/canopy-suggest-x")).toBe("/tmp/canopy-suggest-x");
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

describe("a seed's suggestion", () => {
  test("runs either harness from a scratch folder without canopy's tokens, so no seed setting is read", async () => {
    const repo = await mkdtemp(join(tmpdir(), "canopy-suggest-seed-"));
    await exec(["git", "init", "-q"], { cwd: repo });
    const seen: { argv: string[]; opts: ExecOptions }[] = [];
    const run = async (argv: string[], opts: ExecOptions = {}): Promise<ExecResult> => {
      seen.push({ argv, opts });
      const o = argv.indexOf("-o");
      if (o >= 0 && argv[o + 1]) await writeFile(argv[o + 1] ?? "", "feat: a message\n");
      return { code: 0, stdout: "feat: a message\n", stderr: "" };
    };
    const base = { ...process.env, GH_TOKEN: "gh_secret" };
    try {
      for (const harness of ["codex", "claude"] as const) {
        seen.length = 0;
        const got = await suggestMessage(repo, [], { ...DEFAULT_AGENT, harness }, { seed: true, run, which: () => `/bin/${harness}`, env: base });
        expect(got).toEqual({ message: "feat: a message", source: "ai" });
        const call = seen.find((c) => c.argv[0] === `/bin/${harness}`);
        expect(call?.opts.cwd).toBeDefined();
        expect(call?.opts.cwd).not.toBe(repo);
        expect(call?.opts.base?.["GH_TOKEN"]).toBeUndefined();
        if (harness === "codex") expect(call?.argv[(call?.argv.indexOf("-C") ?? 0) + 1]).toBe(call?.opts.cwd);
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
