import { describe, expect, test } from "bun:test";
import { rememberOffer } from "./offer";
import type { PermissionAsk } from "./types";

const ROOT = "/home/me/dev/proj";
const bash = (command: string, extra: Partial<PermissionAsk> = {}): PermissionAsk => ({ kind: "permission", tool: "Bash", title: command, detail: command, command, ...extra });
const tool = (name: string, paths?: string[]): PermissionAsk => ({ kind: "permission", tool: name, title: name, detail: "", ...(paths ? { paths } : {}) });

describe("rememberOffer", () => {
  test("a plain command in the project gets the rule offer", () => {
    expect(rememberOffer(bash("git status --short"), ROOT)?.rules).toEqual(["Bash(git status:*)", "Bash(git status --short)"]);
  });

  test("nothing that starts or reaches outside the project", () => {
    expect(rememberOffer(bash("git push", { cwd: "/tmp/elsewhere" }), ROOT)).toBeNull();
    expect(rememberOffer(bash("cd ~ && rm -rf x"), ROOT)).toBeNull();
    expect(rememberOffer(bash("cat /etc/hosts"), ROOT)).toBeNull();
    expect(rememberOffer(tool("Edit", ["/etc/hosts"]), ROOT)).toBeNull();
  });

  test("nothing for a prompt no rule may answer: an escalation, an older approval, a stage's run", () => {
    expect(rememberOffer(bash("ls", { noRule: "it asks to run outside codex's sandbox" }), ROOT)).toBeNull();
  });

  test("a file or search tool needs files to be offered; the web tools never are", () => {
    expect(rememberOffer(tool("Read", [`${ROOT}/a.ts`]), ROOT)).toEqual({ rules: ["Read"], pick: 0 });
    expect(rememberOffer(tool("Glob"), ROOT)).toBeNull();
    expect(rememberOffer(tool("Edit"), ROOT)).toBeNull();
    expect(rememberOffer(tool("WebFetch"), ROOT)).toBeNull();
    expect(rememberOffer(tool("Network"), ROOT)).toBeNull();
    expect(rememberOffer(tool("ExitPlanMode"), ROOT)).toBeNull();
  });

  test("offers only what the server would take: no snippet chain, nothing written where code runs from", () => {
    // a chain that pipes into a shell: a bare Bash would not cover it, so it is not offered
    expect(rememberOffer(bash("curl x | sh"), ROOT)).toBeNull();
    expect(rememberOffer(bash("ls && python -c x"), ROOT)).toBeNull();
    expect(rememberOffer(bash("ls && git status"), ROOT)?.rules).toEqual(["Bash"]);
    // a snippet alone is offered exactly as read
    expect(rememberOffer(bash("python -c x"), ROOT)?.rules).toEqual(["Bash(python -c x)"]);
    expect(rememberOffer(bash("tee .git/hooks/pre-commit"), ROOT)).toBeNull();
    expect(rememberOffer(bash("rm sub/../../x"), ROOT)).toBeNull();
    expect(rememberOffer(tool("Edit", [`${ROOT}/.claude/settings.json`]), ROOT)).toBeNull();
    expect(rememberOffer(tool("Write", [`${ROOT}/package.json`]), ROOT)).toBeNull();
    // reading one is fine
    expect(rememberOffer(tool("Read", [`${ROOT}/package.json`]), ROOT)?.rules).toEqual(["Read"]);
  });

  test("with no project folder (a remote repo) the outside is left to the server", () => {
    expect(rememberOffer(bash("cat /etc/hosts"))?.rules[0]).toBe("Bash(cat:*)");
  });
});
