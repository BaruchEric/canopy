import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, type ExecOptions, type ExecResult } from "./exec";
import { claudeSuggestArgs, codexSuggestArgs, codexSuggestDir, heuristicMessage, suggestMessage } from "./suggest";
import { DEFAULT_AGENT, type AgentSettings, type RepoFile } from "./types";

const codex = (over: Partial<AgentSettings> = {}): AgentSettings => ({ ...DEFAULT_AGENT, harness: "codex", ...over });

describe("the suggestion's command lines", () => {
  test("claude at the defaults is the print-mode line with hooks off", () => {
    const noHooks = ["--settings", '{"disableAllHooks":true}'];
    expect(claudeSuggestArgs(DEFAULT_AGENT, "P")).toEqual(["-p", "P", "--output-format", "text", ...noHooks]);
    expect(claudeSuggestArgs({ ...DEFAULT_AGENT, model: "haiku", effort: "low", extra: "--x" }, "P")).toEqual([
      "-p",
      "P",
      "--output-format",
      "text",
      ...noHooks,
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
    const provider = codexSuggestArgs(codex({ model: "gpt-5.5", provider: "team_1" }), "/r", "/o", "P");
    expect(provider.slice(provider.indexOf("-o") + 2)).toEqual(["-m", "gpt-5.5", "-c", 'model_provider="team_1"', "P"]);
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

describe("a Claude provider on the suggestion", () => {
  test("its settings share the one --settings with hooks off, which wins", () => {
    const args = claudeSuggestArgs({ ...DEFAULT_AGENT, provider: "local" }, "P", { env: { ANTHROPIC_BASE_URL: "http://x" }, disableAllHooks: false });
    expect(args.filter((a) => a === "--settings")).toHaveLength(1);
    expect(args[args.indexOf("--settings") + 1]).toBe('{"env":{"ANTHROPIC_BASE_URL":"http://x"},"disableAllHooks":true}');
  });

  test("the file is read from this machine's providers folder; a missing or broken one leaves the login's line", async () => {
    const cfg = await mkdtemp(join(tmpdir(), "canopy-suggest-prov-"));
    const repo = await mkdtemp(join(tmpdir(), "canopy-suggest-repo-"));
    const saved = process.env["CANOPY_CONFIG_DIR"];
    process.env["CANOPY_CONFIG_DIR"] = cfg;
    const seen: string[][] = [];
    const run = async (argv: string[]): Promise<ExecResult> => {
      seen.push(argv);
      return { code: 0, stdout: "feat: x\n", stderr: "" };
    };
    const settingsOf = () => {
      const argv = seen.find((a) => a[0] === "/bin/claude");
      return argv?.[argv.indexOf("--settings") + 1];
    };
    try {
      await exec(["git", "init", "-q"], { cwd: repo });
      await mkdir(join(cfg, "providers"), { recursive: true });
      await writeFile(join(cfg, "providers", "local.json"), JSON.stringify({ env: { ANTHROPIC_MODEL: "m" } }));
      await writeFile(join(cfg, "providers", "bad.json"), "{");
      await suggestMessage(repo, [], { ...DEFAULT_AGENT, provider: "local" }, { run, which: () => "/bin/claude" });
      expect(settingsOf()).toBe('{"env":{"ANTHROPIC_MODEL":"m"},"disableAllHooks":true}');
      for (const provider of ["bad", "gone"]) {
        seen.length = 0;
        await suggestMessage(repo, [], { ...DEFAULT_AGENT, provider }, { run, which: () => "/bin/claude" });
        expect(settingsOf()).toBe('{"disableAllHooks":true}');
      }
    } finally {
      if (saved === undefined) delete process.env["CANOPY_CONFIG_DIR"];
      else process.env["CANOPY_CONFIG_DIR"] = saved;
      await rm(cfg, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
});
