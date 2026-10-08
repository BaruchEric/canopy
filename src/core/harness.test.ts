import { describe, expect, test } from "bun:test";
import { agentArgs, agentArgv, continueArgv, HARNESS, presentHarnesses, resumeArgv, takesEffort, takesModel } from "./harness";
import { AGENT_EFFORTS, DEFAULT_AGENT, type AgentEffort, type AgentSettings } from "./types";

const claude = (over: Partial<AgentSettings> = {}): AgentSettings => ({ ...DEFAULT_AGENT, ...over });
const codex = (over: Partial<AgentSettings> = {}): AgentSettings => ({ ...DEFAULT_AGENT, harness: "codex", ...over });
const U = "01a0938a-afea-7710-9c30-f6d510a9d23e";

describe("the argv table", () => {
  test("claude: flags only for what is set; yolo is set by default", () => {
    expect(agentArgs(claude())).toEqual(["--dangerously-skip-permissions"]);
    expect(agentArgs(claude({ yolo: false }))).toEqual([]);
    expect(agentArgs(claude({ model: "fable", effort: "xhigh", extra: "--add-dir '../my lib'" }))).toEqual([
      "--model",
      "fable",
      "--effort",
      "xhigh",
      "--dangerously-skip-permissions",
      "--add-dir",
      "../my lib",
    ]);
    expect(agentArgv(claude({ yolo: false }))).toEqual(["claude"]);
  });

  test("codex: -m, the effort as config, yolo or ask spelled out, and --no-daemon always", () => {
    expect(agentArgs(codex())).toEqual(["--dangerously-bypass-approvals-and-sandbox", "--no-daemon"]);
    expect(agentArgs(codex({ yolo: false }))).toEqual(["-a", "on-request", "-s", "workspace-write", "--no-daemon"]);
    expect(agentArgv(codex({ model: "gpt-5.5", effort: "high", extra: "--search" }))).toEqual([
      "codex",
      "-m",
      "gpt-5.5",
      "-c",
      "model_reasoning_effort=high",
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-daemon",
      "--search",
    ]);
  });

  test("a launch's folders come last, one --add-dir each, in both harnesses", () => {
    const dirs = ["/a b", "/c"];
    expect(agentArgs({ ...claude({ extra: "--verbose" }), dirs })).toEqual([
      "--dangerously-skip-permissions",
      "--verbose",
      "--add-dir",
      "/a b",
      "--add-dir",
      "/c",
    ]);
    expect(agentArgs({ ...codex(), dirs }).slice(-4)).toEqual(["--add-dir", "/a b", "--add-dir", "/c"]);
    expect(agentArgs({ ...claude(), dirs: [] })).toEqual(agentArgs(claude()));
  });

  test("every effort a harness takes maps to its flag, default to none", () => {
    for (const e of HARNESS.claude.efforts) {
      expect(agentArgs(claude({ effort: e, yolo: false }))).toEqual(e === "default" ? [] : ["--effort", e]);
    }
    for (const e of HARNESS.codex.efforts) {
      expect(agentArgs(codex({ effort: e, yolo: false })).slice(0, 2)).toEqual(
        e === "default" ? ["-a", "on-request"] : ["-c", `model_reasoning_effort=${e}`],
      );
    }
    // ultra is codex's alone; every other effort both take
    const both = AGENT_EFFORTS.filter((e: AgentEffort) => takesEffort("claude", e));
    expect(both).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    expect(takesEffort("codex", "ultra")).toBe(true);
    expect(takesEffort("claude", "ultra")).toBe(false);
  });

  test("resume: claude's --resume after the flags, codex's subcommand ahead of them", () => {
    expect(resumeArgv(claude(), U)).toEqual(["claude", "--dangerously-skip-permissions", "--resume", U]);
    expect(resumeArgv(codex({ model: "gpt-5.5" }), U)).toEqual([
      "codex",
      "resume",
      "-m",
      "gpt-5.5",
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-daemon",
      U,
    ]);
  });

  test("continue: the folder's last conversation, with the flags only when the settings are that harness's", () => {
    expect(continueArgv("claude")).toEqual(["claude", "--continue"]);
    expect(continueArgv("claude", claude({ model: "opus" }))).toEqual(["claude", "--model", "opus", "--dangerously-skip-permissions", "--continue"]);
    expect(continueArgv("codex")).toEqual(["codex", "resume", "--last", "--no-daemon"]);
    expect(continueArgv("codex", claude({ model: "opus" }))).toEqual(["codex", "resume", "--last", "--no-daemon"]);
    expect(continueArgv("codex", codex({ yolo: false }))).toEqual(["codex", "resume", "--last", "-a", "on-request", "-s", "workspace-write", "--no-daemon"]);
  });

  test("the environment canopy means the agent's commands to have: codex's policy set table, nothing for claude", () => {
    const env = { TAILCHAN_AS: "app-1a2b" };
    expect(agentArgs(claude(), env)).toEqual(["--dangerously-skip-permissions"]);
    expect(agentArgs(codex(), env)).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-daemon",
      "-c",
      'shell_environment_policy.set.TAILCHAN_AS="app-1a2b"',
    ]);
    // more variables ride the same way; a bad name or a control character is left out, quotes escaped
    expect(agentArgs(codex({ yolo: false }), { CANOPY_TERM: 'a"b\\c', "bad-name": "x", CANOPY_API: "x\ny" }).slice(-2)).toEqual([
      "-c",
      'shell_environment_policy.set.CANOPY_TERM="a\\"b\\\\c"',
    ]);
    expect(resumeArgv(codex(), U, env)).toEqual([
      "codex",
      "resume",
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-daemon",
      "-c",
      'shell_environment_policy.set.TAILCHAN_AS="app-1a2b"',
      U,
    ]);
    expect(continueArgv("codex", undefined, env)).toEqual([
      "codex",
      "resume",
      "--last",
      "--no-daemon",
      "-c",
      'shell_environment_policy.set.TAILCHAN_AS="app-1a2b"',
    ]);
  });

  test("which models each takes", () => {
    expect(takesModel("claude", "opus")).toBe(true);
    expect(takesModel("claude", "gpt-5.5")).toBe(false);
    expect(takesModel("codex", "gpt-5.5")).toBe(true);
    expect(takesModel("codex", "some/other-model:2")).toBe(true);
    expect(takesModel("codex", "-x")).toBe(false);
    expect(takesModel("codex", "sonnet")).toBe(false);
    expect(takesModel("codex", "default")).toBe(true);
    expect(takesModel("codex", 5)).toBe(false);
  });

  test("the harnesses a machine has, off a lookup by binary", () => {
    expect(presentHarnesses((b) => b === "claude")).toEqual(["claude"]);
    expect(presentHarnesses(() => true)).toEqual(["claude", "codex"]);
    expect(presentHarnesses(() => false)).toEqual([]);
  });
});
