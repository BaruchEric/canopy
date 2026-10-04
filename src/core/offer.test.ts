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

  test("with no project folder (a remote repo) the outside is left to the server", () => {
    expect(rememberOffer(bash("cat /etc/hosts"))?.rules[0]).toBe("Bash(cat:*)");
  });
});
