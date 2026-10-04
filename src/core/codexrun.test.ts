import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_SETS } from "./actions";
import {
  appServerArgs,
  approvalFacts,
  approvalPrompt,
  allowsEdits,
  approvalReply,
  autoAnswer,
  canopyEnv,
  CodexDriver,
  codexVersion,
  commandWords,
  configFlags,
  escalationNote,
  itemTool,
  NOT_PLAIN,
  parseRule,
  questionPrompt,
  questionReply,
  runsInside,
  shellWords,
  threadParams,
  threadPolicy,
  tokensOf,
  turnParams,
  turnResult,
  unwrapShell,
  versionNote,
  within,
} from "./codexrun";
import { RunCtx, type DriveAgent, type DriveRun } from "./driver";

const GIT_READ = [...(TOOL_SETS["git-read"] ?? [])];
const AGENT: DriveAgent = { model: "default", effort: "default", yolo: false, extra: "" };

/* ---------- pure helpers ---------- */

describe("the version check", () => {
  test("reads codex --version and the app-server's user agent", () => {
    expect(codexVersion("codex-cli 0.158.0")).toBe("0.158.0");
    expect(codexVersion("WARNING: failed to clean up stale arg0 temp dirs\ncodex-cli 0.160.3\n")).toBe("0.160.3");
    expect(codexVersion("canopy/0.158.0 (Debian 13.0.0; x86_64) tmux-256color (canopy; 0)")).toBe("0.158.0");
    expect(codexVersion("something else")).toBeNull();
  });

  test("a note only outside the tested range", () => {
    expect(versionNote("0.158.0")).toBeNull();
    expect(versionNote("0.158.12")).toBeNull();
    expect(versionNote("0.157.4")).toContain("older than canopy is tested with");
    expect(versionNote("0.159.0")).toContain("newer than canopy is tested with");
    expect(versionNote("1.0.0")).toContain("codex 1.0.0 is newer");
    expect(versionNote(null)).toContain("did not say its version");
  });
});

describe("the process and the thread", () => {
  test("the app-server gets the config flags from the extra box and nothing else", () => {
    expect(configFlags("-c a=1 --search --enable x -m o3 --config=b=2 --disable")).toEqual([
      "-c",
      "a=1",
      "--enable",
      "x",
      "--config",
      "b=2",
    ]);
    expect(appServerArgs({ extra: "-c 'k=\"v w\"'" })).toEqual(["app-server", "--listen", "stdio://", "-c", 'k="v w"']);
  });

  test("ask mode asks for every command and edit canopy's rules have to judge; yolo is the bypass pair", () => {
    // untrusted: codex asks for everything but its own known-safe reads, and
    // for every patch, so the job's rules see each one (on-request would let
    // the sandbox run anything and never ask)
    const ask = threadParams("/r", AGENT, { askQuestions: false });
    expect(ask).toEqual({ cwd: "/r", approvalPolicy: "untrusted", sandbox: "read-only" });
    // rules that let the job edit let the sandbox write the workspace
    expect(threadParams("/r", AGENT, { askQuestions: false, rules: [...GIT_READ, "Edit"] })).toEqual({
      cwd: "/r",
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    });
    const yolo = threadParams("/r", { ...AGENT, yolo: true, model: "gpt-x" }, { askQuestions: false, rules: ["Edit"] });
    expect(yolo).toEqual({ cwd: "/r", model: "gpt-x", approvalPolicy: "never", sandbox: "danger-full-access" });
  });

  test("only a bare Edit, Write or MultiEdit rule opens the sandbox for writing", () => {
    expect(allowsEdits(GIT_READ)).toBe(false);
    expect(allowsEdits(["Write"])).toBe(true);
    expect(allowsEdits(["MultiEdit"])).toBe(true);
    // a rule scoped to paths is one canopy cannot honour, so it opens nothing
    expect(allowsEdits(["Edit(src/**)"])).toBe(false);
    expect(threadPolicy({ yolo: false }, ["Bash(bun test:*)"])).toEqual({ approvalPolicy: "untrusted", sandbox: "read-only" });
    expect(threadPolicy({ yolo: false })).toEqual({ approvalPolicy: "untrusted", sandbox: "read-only" });
  });

  test("questions ride in the thread's own config; a Claude model alias is left out", () => {
    const p = threadParams("/r", { ...AGENT, model: "opus" }, { askQuestions: true });
    expect(p["model"]).toBeUndefined();
    expect(p["config"]).toEqual({
      "features.default_mode_request_user_input": true,
      suppress_unstable_features_warning: true,
    });
    expect(String(p["developerInstructions"])).toContain("request_user_input");
  });

  test("a policy override replaces only what it names", () => {
    const p = threadParams("/r", AGENT, {
      askQuestions: false,
      policy: { sandbox: "danger-full-access", approvalPolicy: undefined },
    });
    expect(p["approvalPolicy"]).toBe("untrusted");
    expect(p["sandbox"]).toBe("danger-full-access");
  });

  test("canopy's own variables ride in the thread's config for the commands codex runs", () => {
    expect(canopyEnv({ CANOPY_RUN: "r1", CANOPY_BACKEND: "mini", FAKE_X: "y", "CANOPY_BAD-NAME": "z", CANOPY_NL: "a\nb" })).toEqual({
      CANOPY_RUN: "r1",
      CANOPY_BACKEND: "mini",
    });
    const p = threadParams("/r", AGENT, { askQuestions: true, env: { CANOPY_RUN: "r1", PATH: "/bin" } });
    expect(p["config"]).toEqual({
      "features.default_mode_request_user_input": true,
      suppress_unstable_features_warning: true,
      "shell_environment_policy.set.CANOPY_RUN": "r1",
    });
    expect(threadParams("/r", AGENT, { askQuestions: false, env: { CANOPY_REPO: "app" } })).toEqual({
      cwd: "/r",
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      config: { "shell_environment_policy.set.CANOPY_REPO": "app" },
    });
  });

  test("a turn carries the text and the effort unless it is the default", () => {
    expect(turnParams("t", "hi", AGENT)).toEqual({ threadId: "t", input: [{ type: "text", text: "hi", text_elements: [] }] });
    expect(turnParams("t", "hi", { ...AGENT, effort: "high" })["effort"]).toBe("high");
  });
});

describe("shell words", () => {
  test("split like a shell, quotes honoured", () => {
    expect(shellWords("git  status --short")).toEqual(["git", "status", "--short"]);
    expect(shellWords(`git commit -m "a; b | c" -m 'it''s'`)).toEqual(["git", "commit", "-m", "a; b | c", "-m", "its"]);
    expect(shellWords(`git log --format='%h $x'`)).toEqual(["git", "log", "--format=%h $x"]);
    expect(shellWords(`echo "a \\"b\\" \\$c" d\\ e`)).toEqual(["echo", 'a "b" $c', "d e"]);
    expect(shellWords(`git commit -m "one\ntwo"`)).toEqual(["git", "commit", "-m", "one\ntwo"]);
    expect(shellWords("")).toEqual([]);
  });

  test("anything more than one simple command is refused", () => {
    for (const s of [
      "git status; rm -rf x",
      "git status && rm -rf x",
      "git status | sh",
      "git status & rm x",
      "git log $(rm -rf /)",
      "git log `rm -rf /`",
      'git log "$(rm -rf /)"',
      'echo "$HOME"',
      "git log > out",
      "git log < in",
      "(git status)",
      "{ git status; }",
      "git status\nrm x",
      "git status # c",
      "echo 'unclosed",
      'echo "unclosed',
      "git status \\",
    ]) {
      expect(shellWords(s)).toBeNull();
    }
  });

  test("codex's shell wrapper comes off, including a script with quotes of its own", () => {
    expect(commandWords("/bin/sh -lc 'git status --short'")).toEqual(["git", "status", "--short"]);
    expect(commandWords("bash -c 'bun test'")).toEqual(["bun", "test"]);
    expect(commandWords("/usr/bin/zsh -lc 'git diff'")).toEqual(["git", "diff"]);
    // shlex quotes a script holding a single quote in pieces
    expect(commandWords(`/bin/sh -lc 'git commit -m "it'"'"'s"'`)).toEqual(["git", "commit", "-m", "it's"]);
    expect(commandWords("git status")).toEqual(["git", "status"]);
    expect(commandWords("/bin/sh -lc 'git status; rm -rf x'")).toBeNull();
    expect(commandWords("/bin/sh -lc ''")).toBeNull();
    expect(unwrapShell("/bin/sh -lc 'touch $HOME/x'")).toBe("touch $HOME/x");
    expect(unwrapShell("git status")).toBe("git status");
  });
});

describe("allowed tools, enforced by canopy", () => {
  test("rules as canopy reads them", () => {
    expect(parseRule("Bash(git status:*)")).toEqual({ kind: "bash", words: ["git", "status"], prefix: true });
    expect(parseRule("Bash(bun install)")).toEqual({ kind: "bash", words: ["bun", "install"], prefix: false });
    expect(parseRule("Edit")).toEqual({ kind: "tool", name: "Edit" });
    expect(parseRule("Edit(src/**)")).toBeNull();
    expect(parseRule("Bash($(x):*)")).toBeNull();
  });

  const cmd = (script: string, cwd: string | null = null) => ({ kind: "command" as const, command: `/bin/sh -lc '${script}'`, cwd });

  test("one simple command matching a rule's words is accepted", () => {
    expect(autoAnswer(GIT_READ, cmd("git status --short"), "/r")).toBe(true);
    expect(autoAnswer(GIT_READ, cmd("git log -3 --oneline"), "/r")).toBe(true);
    expect(autoAnswer(GIT_READ, { kind: "command", command: "git diff", cwd: null }, "/r")).toBe(true);
    expect(autoAnswer(["Bash(bun install)"], cmd("bun install"), "/r")).toBe(true);
    // in the repo or a folder under it
    expect(autoAnswer(GIT_READ, cmd("git status", "/r"), "/r")).toBe(true);
    expect(autoAnswer(GIT_READ, cmd("git status", "/r/sub/"), "/r/")).toBe(true);
    expect(autoAnswer(GIT_READ, cmd("git status", "sub"), "/r")).toBe(true);
  });

  test("a bare Bash covers any command in the repo, compound ones too, and none outside it", () => {
    expect(autoAnswer(["Bash"], cmd("bun --version && cat .canopy/eval.md | head -60"), "/r")).toBe(true);
    expect(autoAnswer(["Bash"], { kind: "command", command: null, cwd: null }, "/r")).toBe(true);
    expect(autoAnswer(["Bash"], cmd("ls", "/elsewhere"), "/r")).toBe(false);
    expect(autoAnswer(["Read"], cmd("ls"), "/r")).toBe(false);
  });

  test("a covered command that would run outside the repo goes to the human", () => {
    expect(autoAnswer(GIT_READ, cmd("git status", "/elsewhere"), "/r")).toBe(false);
    expect(autoAnswer(GIT_READ, cmd("git status", "/r/../etc"), "/r")).toBe(false);
    expect(autoAnswer(GIT_READ, cmd("git status", "/rx"), "/r")).toBe(false);
    expect(autoAnswer(GIT_READ, cmd("git status", ".."), "/r")).toBe(false);
    expect(within("/r/a", "/r")).toBe(true);
    expect(within("/r", "/r/")).toBe(true);
    expect(within("/r2", "/r")).toBe(false);
    expect(within("/anything", "/")).toBe(true);
  });

  test("a command's folder is judged on disk too: a symlink out of the repo is outside", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-codex-cwd-"));
    try {
      const repo = join(dir, "repo");
      await mkdir(join(repo, "sub"), { recursive: true });
      await mkdir(join(dir, "out"));
      await symlink(join(dir, "out"), join(repo, "link"));
      const at = (cwd: string | null) => ({ kind: "command" as const, command: "git status", cwd });
      expect(await runsInside(at(null), repo)).toBe(true);
      expect(await runsInside(at(join(repo, "sub")), repo)).toBe(true);
      expect(await runsInside(at(join(repo, "link")), repo)).toBe(false);
      // a folder that is not there yet is judged by its words
      expect(await runsInside(at(join(repo, "new")), repo)).toBe(true);
      expect(await runsInside(at(join(dir, "gone")), repo)).toBe(false);
      expect(await runsInside({ kind: "other" }, repo)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("anything chained, substituted or piped, or off the rules, goes to the human", () => {
    expect(autoAnswer(GIT_READ, cmd("git status; rm -rf x"), "/r")).toBe(false);
    expect(autoAnswer(GIT_READ, cmd("git status && rm -rf x"), "/r")).toBe(false);
    expect(autoAnswer(GIT_READ, { kind: "command", command: "/bin/sh -lc 'git log $(rm -rf /)'", cwd: null }, "/r")).toBe(false);
    expect(autoAnswer(GIT_READ, cmd("git status | sh"), "/r")).toBe(false);
    expect(autoAnswer(GIT_READ, cmd("git push"), "/r")).toBe(false);
    expect(autoAnswer(GIT_READ, cmd("git statusx"), "/r")).toBe(false);
    expect(autoAnswer(GIT_READ, cmd("FOO=1 git status"), "/r")).toBe(false);
    expect(autoAnswer(["Bash(bun install)"], cmd("bun install left-pad"), "/r")).toBe(false);
    expect(autoAnswer(GIT_READ, { kind: "command", command: null, cwd: null }, "/r")).toBe(false);
    expect(autoAnswer(GIT_READ, { kind: "other" }, "/r")).toBe(false);
  });

  test("a file change is accepted when the rules edit and every path is in the repo", () => {
    const change = (paths: string[] | null, grantRoot: string | null = null) => ({
      kind: "fileChange" as const,
      paths,
      grantRoot,
    });
    expect(autoAnswer(["Edit"], change(["/r/a.ts", "b/c.ts"]), "/r")).toBe(true);
    expect(autoAnswer(["Write"], change(["/r/a.ts"]), "/r/")).toBe(true);
    expect(autoAnswer(["Edit"], change(["/r/../etc/passwd"]), "/r")).toBe(false);
    expect(autoAnswer(["Edit"], change(["/rx/a.ts"]), "/r")).toBe(false);
    expect(autoAnswer(["Edit"], change(["/r/a.ts"], "/"), "/r")).toBe(false);
    expect(autoAnswer(["Edit"], change(null), "/r")).toBe(false);
    expect(autoAnswer(["Edit(src/**)"], change(["/r/src/a.ts"]), "/r")).toBe(false);
    expect(autoAnswer(GIT_READ, change(["/r/a.ts"]), "/r")).toBe(false);
  });

  test("what an approval is judged by", () => {
    expect(approvalFacts("item/commandExecution/requestApproval", { command: "git status" }, null)).toEqual({
      kind: "command",
      command: "git status",
      cwd: null,
    });
    expect(approvalFacts("item/commandExecution/requestApproval", { command: "git status", cwd: "/r/sub" }, null)).toEqual({
      kind: "command",
      command: "git status",
      cwd: "/r/sub",
    });
    expect(
      approvalFacts("item/commandExecution/requestApproval", { networkApprovalContext: { host: "x" } }, null).kind,
    ).toBe("other");
    expect(approvalFacts("item/commandExecution/requestApproval", { kind: "writeStdin", command: "cat" }, null).kind).toBe(
      "other",
    );
    const item = { changes: [{ path: "/r/a", kind: { type: "update", move_path: "/r/b" }, diff: "" }] };
    expect(approvalFacts("item/fileChange/requestApproval", {}, item)).toEqual({
      kind: "fileChange",
      paths: ["/r/a", "/r/b"],
      grantRoot: null,
    });
  });
});

describe("items as steps", () => {
  const command = (extra: Record<string, unknown>) => ({
    type: "commandExecution",
    id: "c",
    command: "/bin/sh -lc 'git status --short'",
    status: "inProgress",
    aggregatedOutput: null,
    exitCode: null,
    ...extra,
  });

  test("a command is Bash, titled by its script, its exit judging it", () => {
    expect(itemTool(command({}), "started", "/r")).toEqual({ name: "Bash", title: "git status --short", status: "running" });
    expect(itemTool(command({ status: "completed", exitCode: 0, aggregatedOutput: " M a\n" }), "completed", "/r")).toEqual(
      { name: "Bash", title: "git status --short", status: "ok", output: "M a" },
    );
    expect(itemTool(command({ status: "completed", exitCode: 2 }), "completed", "/r")?.status).toBe("error");
    expect(itemTool(command({ status: "declined" }), "completed", "/r")).toMatchObject({ status: "error", output: "declined" });
    const long = itemTool(command({ status: "failed", aggregatedOutput: "x".repeat(2500) }), "completed", "/r");
    expect(long?.output?.startsWith("x".repeat(2000) + "\n… (500 more characters)")).toBe(true);
  });

  test("a file change is Edit, named by its paths, its diff as the output", () => {
    const fc = (changes: unknown[], status = "completed") => ({ type: "fileChange", id: "f", changes, status });
    const upd = (path: string, move: string | null = null) => ({ path, kind: { type: "update", move_path: move }, diff: "-a\n+b" });
    expect(itemTool(fc([upd("/r/src/a.ts")]), "completed", "/r")).toEqual({
      name: "Edit",
      title: "edit src/a.ts",
      status: "ok",
      output: "src/a.ts\n-a\n+b",
    });
    expect(itemTool(fc([{ path: "/r/n.ts", kind: { type: "add" }, diff: "+x" }]), "completed", "/r")?.title).toBe("write n.ts");
    expect(itemTool(fc([{ path: "/r/n.ts", kind: { type: "delete" }, diff: "" }]), "completed", "/r")?.title).toBe("delete n.ts");
    expect(itemTool(fc([upd("/r/a", "/r/b")]), "completed", "/r")?.title).toBe("move a to b");
    expect(itemTool(fc([upd("/r/a"), upd("/r/b"), upd("/r/c"), upd("/r/d")]), "completed", "/r")?.title).toBe(
      "edit a, b and 2 more",
    );
    expect(itemTool(fc([upd("/r/a")], "inProgress"), "started", "/r")).toEqual({ name: "Edit", title: "edit a", status: "running" });
  });

  test("MCP calls, searches and the rest", () => {
    expect(
      itemTool(
        {
          type: "mcpToolCall",
          id: "m",
          server: "gh",
          tool: "get_issue",
          status: "completed",
          arguments: { repo: "o/r" },
          result: { content: [{ type: "text", text: "issue body" }] },
          error: null,
        },
        "completed",
        "/r",
      ),
    ).toEqual({ name: "mcp__gh__get_issue", title: "gh get_issue o/r", status: "ok", output: "issue body" });
    expect(itemTool({ type: "webSearch", id: "w", query: "bun spawn" }, "started", "/r")).toEqual({
      name: "WebSearch",
      title: "web search bun spawn",
      status: "running",
    });
    expect(itemTool({ type: "webSearch", id: "w", query: "q" }, "completed", "/r")?.status).toBe("ok");
    expect(itemTool({ type: "reasoning", id: "x", summary: [], content: [] }, "completed", "/r")).toBeNull();
    expect(itemTool({ type: "agentMessage", id: "x", text: "hi" }, "completed", "/r")).toBeNull();
  });
});

describe("approvals and questions", () => {
  test("a command's prompt shows the script, where it runs when elsewhere, and why", () => {
    const p = approvalPrompt(
      "item/commandExecution/requestApproval",
      { command: "/bin/sh -lc 'git push'", cwd: "/other", reason: "needs the network" },
      null,
      "/r",
    );
    expect(p).toEqual({
      kind: "permission",
      tool: "Bash",
      title: "git push",
      detail: "git push\n\nin /other\n\nneeds the network",
      command: "git push",
      cwd: "/other",
      description: "needs the network",
      noRule: NOT_PLAIN,
    });
    // the sandbox's retry line is not the agent's reason
    expect(
      approvalPrompt("item/commandExecution/requestApproval", { command: "ls", reason: "command failed; retry without sandbox?" }, null, "/r"),
    ).not.toHaveProperty("description");
    expect(
      approvalPrompt("item/commandExecution/requestApproval", { networkApprovalContext: { host: "npmjs.org", protocol: "https" } }, null, "/r"),
    ).toMatchObject({ tool: "Network", title: "network access to npmjs.org" });
  });

  test("a file change's prompt takes its paths and diff from the item seen before it", () => {
    const item = { changes: [{ path: "/r/a.ts", kind: { type: "update", move_path: null }, diff: "-a\n+b" }] };
    expect(approvalPrompt("item/fileChange/requestApproval", { grantRoot: "/etc" }, item, "/r")).toEqual({
      kind: "permission",
      tool: "Edit",
      title: "edit a.ts, and write access under /etc",
      detail: "a.ts\n-a\n+b\n\nalso asks to write anywhere under /etc for the rest of the run",
      paths: ["/r/a.ts"],
      noRule: NOT_PLAIN,
    });
    expect(
      approvalPrompt("item/permissions/requestApproval", { permissions: { network: { enabled: true }, fileSystem: { write: ["/r/out"] } } }, null, "/r"),
    ).toMatchObject({ tool: "Permissions", title: "more access: network, write out" });
  });

  test("a sandbox escalation and an older approval are marked: no remembered rule answers them", () => {
    const esc = approvalPrompt("item/commandExecution/requestApproval", { command: "ls", reason: "command failed; retry without sandbox?" }, null, "/r");
    expect(esc).toMatchObject({ tool: "Bash", command: "ls" });
    expect(esc.kind === "permission" && esc.noRule).toContain("sandbox");
    const legacy = approvalPrompt("execCommandApproval", { command: ["ls"], cwd: "/r" }, null, "/r");
    expect(legacy.kind === "permission" && legacy.noRule).toBeTruthy();
    const patch = approvalPrompt("applyPatchApproval", { fileChanges: { "/r/a.ts": { type: "update", unified_diff: "" } } }, null, "/r");
    expect(patch.kind === "permission" && patch.noRule).toBeTruthy();
    const plain = approvalPrompt("item/commandExecution/requestApproval", { command: "ls", cwd: "/r" }, null, "/r");
    expect(plain).not.toHaveProperty("noRule");
  });

  test("a remembered rule answers only what codex plainly asks inside its sandbox; anything else fails closed", () => {
    const m = "item/commandExecution/requestApproval";
    const noRule = (method: string, params: Record<string, unknown>, item: Record<string, unknown> | null = null) => {
      const p = approvalPrompt(method, params, item, "/r");
      return p.kind === "permission" ? (p.noRule ?? null) : "a question";
    };
    expect(noRule(m, { command: "ls", cwd: "/r" })).toBeNull();
    expect(noRule(m, { command: "ls", kind: "command", reason: null, approvalId: null })).toBeNull();
    // any reason: a retry line in other words, a model's justification for running unsandboxed
    expect(noRule(m, { command: "ls", reason: "needs to write outside the workspace" })).toBe(NOT_PLAIN);
    expect(noRule(m, { command: "ls", reason: "Command failed; RETRY WITHOUT SANDBOX?" })).toContain("sandbox");
    expect(noRule(m, { command: "ls", approvalId: "u-1" })).toBe(NOT_PLAIN);
    expect(noRule(m, { command: "ls", kind: "writeStdin" })).toBe(NOT_PLAIN);
    expect(noRule(m, { command: "ls", kind: "somethingNew" })).toBe(NOT_PLAIN);
    expect(noRule(m, { command: "ls", proposedNetworkPolicyAmendments: [{ host: "a.com" }] })).toBe(NOT_PLAIN);
    expect(noRule(m, { command: "ls", additionalPermissions: { network: null } })).toBe(NOT_PLAIN);
    const item = { changes: [{ path: "/r/a.ts", kind: { type: "update", move_path: null }, diff: "" }] };
    expect(noRule("item/fileChange/requestApproval", {}, item)).toBeNull();
    expect(noRule("item/fileChange/requestApproval", { reason: "extra write access" }, item)).toBe(NOT_PLAIN);
  });

  test("a command asking to leave the sandbox gets a note; nothing else does", () => {
    const m = "item/commandExecution/requestApproval";
    expect(escalationNote(m, { reason: "command failed; retry without sandbox?" })).toContain("asks to run outside it");
    expect(escalationNote(m, { reason: "needs the network" })).toBeNull();
    expect(escalationNote(m, {})).toBeNull();
    expect(escalationNote("item/fileChange/requestApproval", { reason: "command failed; retry without sandbox?" })).toBeNull();
  });

  test("answers as decisions", () => {
    const m = "item/commandExecution/requestApproval";
    expect(approvalReply(m, {}, { kind: "allow" }, false)).toEqual({ decision: "accept" });
    expect(approvalReply(m, {}, { kind: "allow-all" }, false)).toEqual({ decision: "acceptForSession" });
    // measured: a sandbox escalation offers accept and cancel, not acceptForSession
    expect(approvalReply(m, { availableDecisions: ["accept", "cancel"] }, { kind: "allow-all" }, false)).toEqual({
      decision: "accept",
    });
    expect(approvalReply(m, {}, { kind: "deny" }, false)).toEqual({ decision: "decline" });
    expect(approvalReply(m, {}, { kind: "deny" }, true)).toEqual({ decision: "cancel" });
    expect(approvalReply("item/fileChange/requestApproval", {}, { kind: "allow" }, false)).toEqual({ decision: "accept" });
    expect(
      approvalReply("item/permissions/requestApproval", { permissions: { network: { enabled: true }, fileSystem: null } }, { kind: "allow-all" }, false),
    ).toEqual({ permissions: { network: { enabled: true } }, scope: "session" });
    expect(approvalReply("item/permissions/requestApproval", {}, { kind: "deny" }, false)).toEqual({ permissions: {}, scope: "turn" });
    expect(approvalReply("execCommandApproval", {}, { kind: "allow-all" }, false)).toEqual({ decision: "approved_for_session" });
    expect(approvalReply("applyPatchApproval", {}, { kind: "deny" }, false)).toEqual({
      decision: { denied: { rejection: "The user declined this in canopy." } },
    });
  });

  test("questions keep their ids; answers go back under them", () => {
    const { prompt, ids } = questionPrompt({
      questions: [
        { id: "a", header: "Pick", question: "Which?", isOther: false, isSecret: false, options: [{ label: "x", description: "" }] },
        { id: "b", header: "Again", question: "Which?", isOther: true, isSecret: false, options: null },
        { id: "c", header: "Key", question: "Token?", isOther: true, isSecret: true, options: null },
      ],
    });
    expect(ids).toEqual(["a", "b", "c"]);
    expect(prompt.questions.map((q) => q.question)).toEqual([
      "Which?",
      "Which? (2)",
      "Token? (the answer will show in canopy's timeline)",
    ]);
    expect(prompt.questions[1]?.options).toEqual([]);
    const answers = { "Which?": "x", "Which? (2)": "y", "Token? (the answer will show in canopy's timeline)": "t" };
    expect(questionReply(prompt.questions, ids, { kind: "answers", answers })).toEqual({
      answers: { a: { answers: ["x"] }, b: { answers: ["y"] }, c: { answers: ["t"] } },
    });
    const dismissed = questionReply(prompt.questions, ids, { kind: "deny" }) as { answers: Record<string, { answers: string[] }> };
    expect(dismissed.answers["a"]?.answers[0]).toContain("closed the question without answering");
  });

  test("a deny with its own message says it, to a question and to an approval", () => {
    const { prompt, ids } = questionPrompt({ questions: [{ id: "a", header: "Pick", question: "Which?", isOther: true, isSecret: false, options: null }] });
    expect(questionReply(prompt.questions, ids, { kind: "deny", message: "finish within your tools" })).toEqual({ answers: { a: { answers: ["finish within your tools"] } } });
    expect(approvalReply("applyPatchApproval", {}, { kind: "deny", message: "finish within your tools" }, false)).toEqual({
      decision: { denied: { rejection: "finish within your tools" } },
    });
  });
});

describe("the result", () => {
  test("a completed turn, a failed one and an interrupted one", () => {
    const tokens = tokensOf({ totalTokens: 9, inputTokens: 7, cachedInputTokens: 3, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1 });
    expect(tokens).toEqual({ input: 7, cachedInput: 3, output: 2, reasoning: 1, total: 9 });
    const ok = turnResult({ status: "completed", durationMs: 42 }, { final: "done", last: "x" }, 1, tokens, 5);
    // a zero cost rides along for pages older than harnesses (costUsd.toFixed)
    expect(ok).toEqual({
      result: { text: "done", costUsd: 0, durationMs: 42, turns: 1, tokens: { input: 7, cachedInput: 3, output: 2, reasoning: 1, total: 9 } },
      problem: null,
    });
    const failed = turnResult(
      { status: "failed", durationMs: null, error: { message: "usage limit reached", additionalDetails: "try later" } },
      { final: "", last: "" },
      2,
      undefined,
      5,
    );
    expect(failed.problem).toBe("usage limit reached\ntry later");
    expect(failed.result.durationMs).toBe(5);
    expect(turnResult({ status: "interrupted" }, { final: "", last: "" }, 1, undefined, 0).problem).toBe("the turn was interrupted");
    // no message seen: the completed turn's own summary still has one
    const fromItems = turnResult(
      { status: "completed", items: [{ type: "agentMessage", id: "m", text: "ok" }] },
      { final: "", last: "" },
      1,
      undefined,
      0,
    );
    expect(fromItems.result.text).toBe("ok");
  });
});

/* ---------- the driver against the stand-in server ---------- */

const FAKE = join(import.meta.dir, "testdata", "fake-codex-app-server.ts");
const scratch: string[] = [];
afterAll(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

type Step = Record<string, unknown>;
interface Scenario {
  userAgent?: string;
  threadStartError?: { code: number; message: string };
  ignoreEof?: boolean;
  turns?: Step[][];
}

interface DriveOpts {
  chat?: boolean;
  agent?: Partial<DriveAgent>;
  allowedTools?: string[];
  message?: string;
  graceMs?: number;
  maxTurns?: number;
}

/** A run on a CodexDriver whose "codex" is the stand-in, with the Runner's
 *  half played by RunCtx. `scenario` gets the repo's path, for items that
 *  name files in it. */
async function drive(scenario: (repo: string) => Scenario, opts: DriveOpts = {}) {
  const dir = await mkdtemp(join(tmpdir(), "canopy-codex-"));
  scratch.push(dir);
  const repo = join(dir, "repo");
  await mkdir(repo);
  const scenarioPath = join(dir, "scenario.json");
  const logPath = join(dir, "log.jsonl");
  await writeFile(scenarioPath, JSON.stringify(scenario(repo)));
  const chat = opts.chat ?? false;
  const run: DriveRun = {
    id: "r1",
    repoId: "repo",
    action: chat ? "chat" : "ask",
    verb: chat ? "chat" : "ask",
    progress: "working",
    expectsChange: false,
    chat,
    note: "",
    status: "working",
    startedAt: Date.now(),
    steps: [],
    prompt: null,
    harness: "codex",
  };
  const ctx = new RunCtx(
    run,
    {
      cwd: repo,
      agent: { ...AGENT, ...opts.agent },
      spec: { allowedTools: opts.allowedTools ?? [], maxTurns: opts.maxTurns ?? 10 },
      env: { FAKE_CODEX_SCENARIO: scenarioPath, FAKE_CODEX_LOG: logPath },
      label: "Codex",
    },
    { emit: () => {} },
  );
  const driver = new CodexDriver({ command: [process.execPath, FAKE], graceMs: opts.graceMs ?? 3_000 });
  driver.start(ctx, opts.message ?? "do the thing");
  const until = async (pred: (r: DriveRun) => boolean, what: string, ms = 8_000): Promise<DriveRun> => {
    const deadline = Date.now() + ms;
    while (!pred(run)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; run is ${run.status}: ${JSON.stringify(run.steps.slice(-3))} ${run.error ?? ""}`);
      await Bun.sleep(10);
    }
    return run;
  };
  const sent = async (): Promise<Record<string, unknown>[]> => {
    const text = await readFile(logPath, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  /** the Runner's stop(): a chat between turns ends, anything else stops */
  const stop = () => {
    if (run.status === "idle") ctx.ending = true;
    else {
      ctx.stopping = true;
      ctx.denyAll();
    }
    driver.stop();
  };
  const ended = (r: DriveRun) => r.status === "done" || r.status === "failed" || r.status === "stopped";
  return { run, ctx, driver, repo, until, sent, stop, ended };
}

const replyTo = (log: Record<string, unknown>[], id: number) =>
  log.find((m) => m["id"] === id && m["method"] === undefined) as { result?: unknown; error?: unknown } | undefined;
const requests = (log: Record<string, unknown>[], method: string) => log.filter((m) => m["method"] === method);

const agentMessage = (id: string, text: string, phase = "final_answer") => ({
  notify: "item/completed",
  params: { threadId: "$THREAD", turnId: "$TURN", item: { type: "agentMessage", id, text, phase } },
});
const commandItem = (method: "item/started" | "item/completed", id: string, script: string, extra: Record<string, unknown> = {}) => ({
  notify: method,
  params: {
    threadId: "$THREAD",
    turnId: "$TURN",
    item: {
      type: "commandExecution",
      id,
      command: `/bin/sh -lc '${script}'`,
      status: method === "item/started" ? "inProgress" : "completed",
      aggregatedOutput: null,
      exitCode: method === "item/started" ? null : 0,
      ...extra,
    },
  },
});
const approval = (id: string, script: string, extra: Record<string, unknown> = {}) => ({
  request: "item/commandExecution/requestApproval",
  params: {
    kind: "command",
    threadId: "$THREAD",
    turnId: "$TURN",
    itemId: id,
    startedAtMs: 1,
    environmentId: "local",
    command: `/bin/sh -lc '${script}'`,
    ...extra,
  },
});

describe("a Codex run", () => {
  test("handshakes, runs a turn into steps and a result, and closes the server after a job", async () => {
    const d = await drive(
      (repo) => ({
        turns: [
          [
            agentMessage("m1", "Looking first.", "commentary"),
            commandItem("item/started", "c1", "git status --short"),
            commandItem("item/completed", "c1", "git status --short", { aggregatedOutput: " M a.ts\n" }),
            {
              notify: "item/started",
              params: {
                threadId: "$THREAD",
                turnId: "$TURN",
                item: { type: "fileChange", id: "f1", status: "inProgress", changes: [{ path: `${repo}/a.ts`, kind: { type: "update", move_path: null }, diff: "@@\n-a\n+b" }] },
              },
            },
            {
              notify: "item/completed",
              params: {
                threadId: "$THREAD",
                turnId: "$TURN",
                item: { type: "fileChange", id: "f1", status: "completed", changes: [{ path: `${repo}/a.ts`, kind: { type: "update", move_path: null }, diff: "@@\n-a\n+b" }] },
              },
            },
            { notify: "item/completed", params: { threadId: "$THREAD", turnId: "$TURN", item: { type: "reasoning", id: "r1", summary: [], content: [] } } },
            // another thread's item (a sub-agent's) is not this run's
            agentMessage("m-other", "not mine"),
            { notify: "item/completed", params: { threadId: "thr-other", turnId: "x", item: { type: "agentMessage", id: "mx", text: "sub-agent", phase: "final_answer" } } },
            agentMessage("m2", "Done: edited a.ts."),
            {
              notify: "thread/tokenUsage/updated",
              params: {
                threadId: "$THREAD",
                turnId: "$TURN",
                tokenUsage: {
                  total: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5 },
                  last: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5 },
                  modelContextWindow: 1000,
                },
              },
            },
            { complete: "completed", durationMs: 1234 },
          ],
        ],
      }),
      { agent: { model: "gpt-x", effort: "high", extra: "-c foo=1 --search" }, message: "edit a.ts" },
    );
    const run = await d.until(d.ended, "the end");
    expect(run.status).toBe("done");
    expect(run.session).toBe("thr-1");
    expect(run.result).toEqual({
      text: "Done: edited a.ts.",
      costUsd: 0,
      durationMs: 1234,
      turns: 1,
      tokens: { input: 100, cachedInput: 40, output: 20, reasoning: 5, total: 120 },
    });
    expect(run.steps.map((s) => (s.kind === "tool" ? `${s.tool?.name}:${s.tool?.title}:${s.tool?.status}` : `${s.kind}:${s.text}`))).toEqual([
      "text:Looking first.",
      "Bash:git status --short:ok",
      "Edit:edit a.ts:ok",
      "text:not mine",
      "text:Done: edited a.ts.",
    ]);
    expect(run.steps[1]?.tool?.output).toBe("M a.ts");
    expect(run.steps[2]?.tool?.output).toBe("a.ts\n@@\n-a\n+b");

    // the server is closed once the job's turn is over
    let log = await d.sent();
    for (let i = 0; i < 100 && !log.some((m) => m["eof"]); i++) {
      await Bun.sleep(20);
      log = await d.sent();
    }
    expect(log.some((m) => m["eof"])).toBe(true);
    expect(log[0]).toEqual({ argv: ["app-server", "--listen", "stdio://", "-c", "foo=1"] });
    const init = requests(log, "initialize")[0] as { params: { clientInfo: { name: string }; capabilities: { optOutNotificationMethods: string[] } } };
    expect(init.params.clientInfo.name).toBe("canopy");
    expect(init.params.capabilities.optOutNotificationMethods).toContain("item/agentMessage/delta");
    expect(requests(log, "initialized")).toHaveLength(1);
    const thread = requests(log, "thread/start")[0]?.["params"] as Record<string, unknown>;
    expect(thread).toMatchObject({ cwd: d.repo, model: "gpt-x", approvalPolicy: "untrusted", sandbox: "read-only" });
    const turn = requests(log, "turn/start")[0]?.["params"] as Record<string, unknown>;
    expect(turn).toEqual({ threadId: "thr-1", input: [{ type: "text", text: "edit a.ts", text_elements: [] }], effort: "high" });
    // the tested version says nothing
    expect(run.steps.filter((s) => s.kind === "note")).toEqual([]);
  });

  test("an approval parks the run; allow goes back as accept", async () => {
    const d = await drive(() => ({
      turns: [
        [
          commandItem("item/started", "c1", "git push"),
          approval("c1", "git push", { reason: "needs the network", cwd: "/elsewhere" }),
          commandItem("item/completed", "c1", "git push"),
          agentMessage("m", "pushed"),
          { complete: "completed" },
        ],
      ],
    }));
    const run = await d.until((r) => r.status === "waiting", "the prompt");
    expect(run.prompt).toEqual({
      id: "p1",
      kind: "permission",
      tool: "Bash",
      title: "git push",
      detail: "git push\n\nin /elsewhere\n\nneeds the network",
      command: "git push",
      cwd: "/elsewhere",
      description: "needs the network",
      // it gives a reason: not a plain request inside the sandbox
      noRule: NOT_PLAIN,
    });
    d.ctx.answer("p1", { kind: "allow" });
    await d.until(d.ended, "the end");
    expect(run.status).toBe("done");
    expect(replyTo(await d.sent(), 0)?.result).toEqual({ decision: "accept" });
    expect(run.steps.some((s) => s.text === "allowed: git push")).toBe(true);
  });

  test("deny goes back as decline, and the declined command shows as such", async () => {
    const d = await drive(() => ({
      turns: [
        [
          commandItem("item/started", "c1", "touch $HOME/x"),
          approval("c1", "touch $HOME/x"),
          commandItem("item/completed", "c1", "touch $HOME/x", { status: "declined", exitCode: null }),
          agentMessage("m", "could not"),
          { complete: "completed" },
        ],
      ],
    }));
    await d.until((r) => r.status === "waiting", "the prompt");
    d.ctx.answer("p1", { kind: "deny" });
    const run = await d.until(d.ended, "the end");
    expect(replyTo(await d.sent(), 0)?.result).toEqual({ decision: "decline" });
    expect(run.steps.find((s) => s.kind === "tool")?.tool).toMatchObject({ status: "error", output: "declined" });
  });

  test("allow all accepts for the session, and later approvals pass without a prompt", async () => {
    const d = await drive(() => ({
      turns: [
        [
          approval("c1", "git push", { availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] }),
          approval("c2", "git push --tags"),
          agentMessage("m", "pushed both"),
          { complete: "completed" },
        ],
      ],
    }));
    await d.until((r) => r.status === "waiting", "the prompt");
    d.ctx.answer("p1", { kind: "allow-all" });
    const run = await d.until(d.ended, "the end");
    const log = await d.sent();
    expect(replyTo(log, 0)?.result).toEqual({ decision: "acceptForSession" });
    expect(replyTo(log, 1)?.result).toEqual({ decision: "accept" });
    expect(run.steps.filter((s) => s.kind === "note").map((s) => s.text)).toEqual(["allowed everything from here: git push"]);
  });

  test("the job's rules accept a plain read by themselves and park a chained one", async () => {
    const d = await drive(
      () => ({
        turns: [
          [
            approval("c1", "git status --short"),
            approval("c2", "git status; rm -rf x"),
            agentMessage("m", "ok"),
            { complete: "completed" },
          ],
        ],
      }),
      { allowedTools: GIT_READ },
    );
    const run = await d.until((r) => r.status === "waiting", "the prompt");
    // the first never showed: the one waiting is the chained command
    expect(run.prompt).toMatchObject({ id: "p1", title: "git status; rm -rf x" });
    d.ctx.answer("p1", { kind: "deny" });
    await d.until(d.ended, "the end");
    const log = await d.sent();
    expect(replyTo(log, 0)?.result).toEqual({ decision: "accept" });
    expect(replyTo(log, 1)?.result).toEqual({ decision: "decline" });
  });

  test("a command the rules cover still asks when it would run outside the repo", async () => {
    const d = await drive(
      (repo) => ({
        turns: [
          [
            approval("c1", "git status", { cwd: repo }),
            approval("c2", "git status", { cwd: "/" }),
            agentMessage("m", "ok"),
            { complete: "completed" },
          ],
        ],
      }),
      { allowedTools: GIT_READ },
    );
    const run = await d.until((r) => r.status === "waiting", "the prompt");
    // the first ran in the repo and never showed; the one waiting is outside it
    expect(run.prompt).toMatchObject({ id: "p1", title: "git status", detail: "git status\n\nin /" });
    d.ctx.answer("p1", { kind: "deny" });
    await d.until(d.ended, "the end");
    const log = await d.sent();
    expect(replyTo(log, 0)?.result).toEqual({ decision: "accept" });
    expect(replyTo(log, 1)?.result).toEqual({ decision: "decline" });
  });

  test("a sub-agent's prompt cleared on its own thread is withdrawn", async () => {
    const d = await drive(() => ({
      turns: [
        [
          { ...approval("c1", "git push", { threadId: "thr-sub" }), wait: false },
          { sleep: 150 },
          // the clearing names the sub-agent's thread, not the run's
          { notify: "serverRequest/resolved", params: { threadId: "thr-sub", requestId: "$REQ" } },
          { sleep: 150 },
          agentMessage("m", "moved on"),
          { complete: "completed" },
        ],
      ],
    }));
    await d.until((r) => r.status === "waiting", "the prompt");
    await d.until((r) => r.status === "working", "the withdrawal");
    const run = await d.until(d.ended, "the end");
    expect(run.status).toBe("done");
    expect(run.steps.some((s) => s.text === "denied: git push")).toBe(true);
    await Bun.sleep(50);
    expect(replyTo(await d.sent(), 0)).toBeUndefined();
  });

  test("a chat that goes idle drops a prompt its turn left waiting, and a late answer cannot wake it", async () => {
    const d = await drive(
      () => ({
        turns: [
          [
            // a sub-agent's request the server never clears
            { ...approval("c1", "git push", { threadId: "thr-sub" }), wait: false },
            { sleep: 150 },
            agentMessage("m", "done here"),
            { complete: "completed" },
          ],
        ],
      }),
      { chat: true, message: "hi" },
    );
    await d.until((r) => r.status === "waiting", "the prompt");
    const run = await d.until((r) => r.status === "idle", "the reply");
    expect(run.prompt).toBeNull();
    expect(run.steps.some((s) => s.text === "denied: git push")).toBe(true);
    expect(() => d.ctx.answer("p1", { kind: "allow" })).toThrow("no longer waiting");
    expect(run.status).toBe("idle");
    d.stop();
    expect((await d.until(d.ended, "the end")).status).toBe("done");
  });

  test("a turn that runs past the job's maxTurns in commands and edits is interrupted and fails in words", async () => {
    const d = await drive(
      () => ({
        turns: [
          [
            commandItem("item/completed", "c1", "ls"),
            commandItem("item/completed", "c2", "ls -a"),
            commandItem("item/completed", "c3", "ls -la"),
            { waitInterrupt: true },
            { complete: "interrupted" },
          ],
        ],
      }),
      { maxTurns: 2 },
    );
    const run = await d.until(d.ended, "the end");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("stopped after 3 commands and file changes without finishing (the limit is 2)");
    expect(run.steps.some((s) => s.kind === "note" && s.text?.includes("reached the limit of 2"))).toBe(true);
    expect(requests(await d.sent(), "turn/interrupt")[0]?.["params"]).toEqual({ threadId: "thr-1", turnId: "turn-1" });
  });

  test("a turn within maxTurns is never interrupted", async () => {
    const d = await drive(
      () => ({ turns: [[commandItem("item/completed", "c1", "ls"), commandItem("item/completed", "c2", "ls -a"), agentMessage("m", "ok"), { complete: "completed" }]] }),
      { maxTurns: 2 },
    );
    const run = await d.until(d.ended, "the end");
    expect(run.status).toBe("done");
    expect(requests(await d.sent(), "turn/interrupt")).toEqual([]);
  });

  test("a question from request_user_input is answered under its ids", async () => {
    const d = await drive(() => ({
      turns: [
        [
          {
            request: "item/tool/requestUserInput",
            params: {
              threadId: "$THREAD",
              turnId: "$TURN",
              itemId: "call1",
              isBlocking: false,
              autoResolutionMs: null,
              questions: [
                {
                  id: "color",
                  header: "Color",
                  question: "Which color?",
                  isOther: true,
                  isSecret: false,
                  options: [
                    { label: "red", description: "warm" },
                    { label: "blue", description: "cool" },
                  ],
                },
              ],
            },
          },
          agentMessage("m", "blue it is"),
          { complete: "completed" },
        ],
      ],
    }));
    const run = await d.until((r) => r.status === "waiting", "the question");
    expect(run.prompt).toEqual({
      id: "p1",
      kind: "question",
      questions: [
        {
          question: "Which color?",
          header: "Color",
          options: [
            { label: "red", description: "warm" },
            { label: "blue", description: "cool" },
          ],
          multiSelect: false,
        },
      ],
    });
    d.ctx.answer("p1", { kind: "answers", answers: { "Which color?": "blue" } });
    await d.until(d.ended, "the end");
    expect(run.result?.text).toBe("blue it is");
    expect(replyTo(await d.sent(), 0)?.result).toEqual({ answers: { color: { answers: ["blue"] } } });
  });

  test("a chat takes its next message as another turn on the same thread, and ends politely", async () => {
    const d = await drive(
      () => ({
        turns: [
          [agentMessage("m1", "hello"), { complete: "completed" }],
          [agentMessage("m2", "again"), { complete: "completed" }],
        ],
      }),
      { chat: true, message: "hi" },
    );
    const run = await d.until((r) => r.status === "idle", "the first reply");
    expect(run.result?.text).toBe("hello");
    // what the Runner's say() does before it hands the text on
    d.ctx.step({ kind: "user", text: "more" });
    run.status = "working";
    d.driver.say("more");
    await d.until((r) => r.status === "idle" && r.result?.text === "again", "the second reply");
    expect(run.result?.turns).toBe(2);
    const turns = requests(await d.sent(), "turn/start").map((m) => m["params"] as Record<string, unknown>);
    expect(turns.map((p) => p["threadId"])).toEqual(["thr-1", "thr-1"]);
    const input = (turns[1]?.["input"] ?? []) as { text: string }[];
    expect(input[0]?.text).toBe("more");
    d.stop();
    const end = await d.until(d.ended, "the end");
    expect(end.status).toBe("done");
    expect((await d.sent()).some((m) => m["eof"])).toBe(true);
  });

  test("a chat whose server lingers after stdin closes is still done, not failed", async () => {
    const d = await drive(() => ({ ignoreEof: true, turns: [[agentMessage("m1", "hello"), { complete: "completed" }]] }), {
      chat: true,
      graceMs: 200,
    });
    await d.until((r) => r.status === "idle", "the reply");
    d.stop();
    const run = await d.until(d.ended, "the end");
    expect(run.status).toBe("done");
  });

  test("stop interrupts the running turn, then the server goes and the run is stopped", async () => {
    const d = await drive(() => ({
      turns: [[commandItem("item/started", "c1", "sleep 100"), { waitInterrupt: true }, { complete: "interrupted" }]],
    }));
    await d.until((r) => r.steps.some((s) => s.tool?.status === "running"), "the command");
    d.stop();
    const run = await d.until(d.ended, "the stop");
    expect(run.status).toBe("stopped");
    const log = await d.sent();
    expect(requests(log, "turn/interrupt")[0]?.["params"]).toEqual({ threadId: "thr-1", turnId: "turn-1" });
  });

  test("a stop while an approval waits cancels it and interrupts", async () => {
    const d = await drive(() => ({
      turns: [[approval("c1", "git push"), { waitInterrupt: true }, { complete: "interrupted" }]],
    }));
    await d.until((r) => r.status === "waiting", "the prompt");
    d.stop();
    const run = await d.until(d.ended, "the stop");
    expect(run.status).toBe("stopped");
    const log = await d.sent();
    expect(replyTo(log, 0)?.result).toEqual({ decision: "cancel" });
    expect(requests(log, "turn/interrupt")).toHaveLength(1);
  });

  test("a prompt the server clears itself is withdrawn and never answered", async () => {
    const d = await drive(() => ({
      turns: [
        [
          { ...approval("c1", "git push"), wait: false },
          { sleep: 150 },
          { notify: "serverRequest/resolved", params: { threadId: "$THREAD", requestId: "$REQ" } },
          agentMessage("m", "moved on"),
          { complete: "completed" },
        ],
      ],
    }));
    await d.until((r) => r.status === "waiting", "the prompt");
    const run = await d.until(d.ended, "the end");
    expect(run.status).toBe("done");
    await Bun.sleep(50);
    expect(replyTo(await d.sent(), 0)).toBeUndefined();
  });

  test("requests canopy cannot show are declined or refused, never left waiting", async () => {
    const d = await drive(() => ({
      turns: [
        [
          { request: "mcpServer/elicitation/request", params: { threadId: "$THREAD", turnId: "$TURN", serverName: "gh", mode: "url", message: "sign in", url: "https://x", elicitationId: "e", _meta: null } },
          { request: "item/tool/call", params: { threadId: "$THREAD", turnId: "$TURN", callId: "c", tool: "t", arguments: {} } },
          agentMessage("m", "fine"),
          { complete: "completed" },
        ],
      ],
    }));
    const run = await d.until(d.ended, "the end");
    const log = await d.sent();
    expect(replyTo(log, 0)?.result).toEqual({ action: "decline", content: null, _meta: null });
    expect(replyTo(log, 1)?.error).toEqual({ code: -32601, message: "canopy does not handle item/tool/call" });
    expect(run.steps.some((s) => s.text?.includes("declined gh's request for input"))).toBe(true);
  });

  test("a server that dies without a result fails the run with its stderr", async () => {
    const d = await drive(() => ({
      turns: [[agentMessage("m", "working on it", "commentary"), { sleep: 50 }, { exit: 3, stderr: "fatal: boom\n" }]],
    }));
    const run = await d.until(d.ended, "the failure");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Codex exited (code 3) without a result: fatal: boom");
  });

  test("a refused thread fails the run with codex's reason", async () => {
    const d = await drive(() => ({ threadStartError: { code: -32600, message: "model gpt-9 is not available" } }));
    const run = await d.until(d.ended, "the failure");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("could not start the codex thread: model gpt-9 is not available");
  });

  test("a failed turn fails a job with codex's error", async () => {
    const d = await drive(() => ({
      turns: [[{ complete: "failed", error: { message: "usage limit reached", codexErrorInfo: null, additionalDetails: null } }]],
    }));
    const run = await d.until(d.ended, "the failure");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("usage limit reached");
  });

  test("a codex outside the tested range says so in the run's first note", async () => {
    const d = await drive(() => ({ userAgent: "canopy/0.170.2 (Fake; x86_64) fake (canopy; 0)" }));
    const run = await d.until(d.ended, "the end");
    expect(run.status).toBe("done");
    expect(run.steps[0]?.kind).toBe("note");
    expect(run.steps[0]?.text).toContain("codex 0.170.2 is newer than canopy is tested with");
  });

  test("check() names a missing binary before a run exists", () => {
    expect(new CodexDriver({ command: ["/x"] }).check()).toBeNull();
    const bare = new CodexDriver();
    const why = bare.check();
    expect(why === null || why.includes("codex CLI is not on PATH")).toBe(true);
  });
});

/** config.toml with every `[projects."<path>"]` table `drop` says yes to
 *  taken out, and every other line as it was. Codex records a folder it ran
 *  a thread in as trusted there, and a test's scratch folder must not stay
 *  behind in the user's own config. */
function dropProjectTables(toml: string, drop: (path: string) => boolean): string {
  const out: string[] = [];
  let skipping = false;
  let dropped = false;
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) {
      const m = /^\s*\[projects\.(["'])(.+)\1\]\s*$/.exec(line);
      const wasSkipping = skipping;
      skipping = !!m && drop(m[2] ?? "");
      if (skipping) {
        dropped = true;
        // the blank line that set the dropped table off goes with it
        while (out.length && out[out.length - 1]?.trim() === "") out.pop();
        continue;
      }
      if (wasSkipping && out.length) out.push("");
    }
    if (!skipping) out.push(line);
  }
  if (!dropped) return toml;
  const text = out.join("\n");
  return toml.endsWith("\n") && !text.endsWith("\n") ? `${text}\n` : text;
}

describe("a real codex run leaves no trust behind", () => {
  test("only the scratch folders' project tables come out", () => {
    const toml = [
      'model = "x"',
      "",
      '[projects."/home/u/Work"]',
      'trust_level = "trusted"',
      "",
      '[projects."/tmp/canopy-codex-it-abc"]',
      'trust_level = "trusted"',
      "",
      "[tui]",
      "a = 1",
      "",
      "[projects.'/tmp/canopy-codex-it-def']",
      'trust_level = "trusted"',
      "",
    ].join("\n");
    const it = (p: string) => p.includes("canopy-codex-it-");
    expect(dropProjectTables(toml, it)).toBe(
      ['model = "x"', "", '[projects."/home/u/Work"]', 'trust_level = "trusted"', "", "[tui]", "a = 1", ""].join("\n"),
    );
    expect(dropProjectTables(toml, () => false)).toBe(toml);
  });
});

/* One real turn against the installed codex, opt-in: it signs in with the
 * user's own login and spends a few tokens. CANOPY_CODEX_IT=1 bun test
 * src/core/codexrun.test.ts. Codex records the scratch repo as a trusted
 * project in the user's config.toml; the test takes that table out again. */
describe.skipIf(!process.env["CANOPY_CODEX_IT"])("a real codex", () => {
  test("answers a one-word turn, with a session and token counts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-codex-it-"));
    scratch.push(dir);
    await Bun.$`git init -q ${dir}`.quiet();
    const run: DriveRun = {
      id: "it",
      repoId: "it",
      action: "ask",
      harness: "codex",
      verb: "ask",
      progress: "working",
      expectsChange: false,
      chat: false,
      note: "",
      status: "working",
      startedAt: Date.now(),
      steps: [],
      prompt: null,
    };
    const ctx = new RunCtx(
      run,
      // canopy's CANOPY_* go into the thread's config, which a real codex has to take
      { cwd: dir, agent: { ...AGENT, effort: "low" }, spec: { allowedTools: GIT_READ, maxTurns: 5 }, env: { CANOPY_RUN: "it" }, label: "Codex" },
      { emit: () => {} },
    );
    const driver = new CodexDriver();
    expect(driver.check()).toBeNull();
    const config = join(process.env["CODEX_HOME"] || join(homedir(), ".codex"), "config.toml");
    try {
      driver.start(ctx, "Reply with the word ok and nothing else. Do not run any commands or tools.");
      const deadline = Date.now() + 150_000;
      while (run.status === "working" || run.status === "waiting") {
        if (run.status === "waiting" && run.prompt) ctx.answer(run.prompt.id, { kind: "deny" });
        if (Date.now() > deadline) break;
        await Bun.sleep(100);
      }
    } finally {
      // whatever codex wrote about this scratch folder (or an earlier run's)
      // comes out; everything else in the file stays as it is
      const before = await readFile(config, "utf8").catch(() => null);
      if (before !== null) {
        const after = dropProjectTables(before, (p) => p.includes("canopy-codex-it-"));
        if (after !== before) await writeFile(config, after);
      }
    }
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("done");
    expect(run.result?.text.toLowerCase()).toContain("ok");
    expect(run.session).toBeTruthy();
    expect(run.result?.tokens?.total ?? 0).toBeGreaterThan(0);
  }, 180_000);
});
