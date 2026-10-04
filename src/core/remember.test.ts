import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalFacts } from "./codexrun";
import { factsOf, parseRemembered, RememberedRules, rememberedFor, ruleCovers, scopeHolds, scopeOf, scopeWords } from "./remember";
import type { PermissionAsk, RememberedRule } from "./types";

const ROOT = "/home/me/dev/proj";
const bash = (command: string, cwd?: string): PermissionAsk => ({ kind: "permission", tool: "Bash", title: command, detail: command, command, ...(cwd ? { cwd } : {}) });
const tool = (name: string, paths?: string[]): PermissionAsk => ({ kind: "permission", tool: name, title: name, detail: "", ...(paths ? { paths } : {}) });
const covers = (rule: string, p: PermissionAsk, facts: ApprovalFacts = factsOf(p)) => ruleCovers(rule, p, facts, ROOT);

describe("ruleCovers", () => {
  test("a prefix rule covers one simple command starting with its words", () => {
    expect(covers("Bash(git status:*)", bash("git status --short"))).toBe(true);
    expect(covers("Bash(git status:*)", bash("git stash"))).toBe(false);
    expect(covers("Bash(git:*)", bash("/bin/sh -lc 'git log'"))).toBe(true);
  });

  test("an exact rule covers that command alone", () => {
    expect(covers("Bash(ls -la)", bash("ls -la"))).toBe(true);
    expect(covers("Bash(ls -la)", bash("ls -la src"))).toBe(false);
  });

  test("a compound command is never covered by a prefix rule, only by a bare Bash", () => {
    for (const c of ["git status && rm -rf /", "git status | sh", "git status; curl x", "git status > f", "git status $(rm x)"]) {
      expect(covers("Bash(git status:*)", bash(c))).toBe(false);
      expect(covers("Bash(git:*)", bash(c))).toBe(false);
      expect(covers("Bash", bash(c))).toBe(true);
    }
  });

  test("a command in a folder outside the project is never covered", () => {
    expect(covers("Bash(ls:*)", bash("ls", "/etc"))).toBe(false);
    expect(covers("Bash", bash("ls", "/etc"))).toBe(false);
    expect(covers("Bash(ls:*)", bash("ls", `${ROOT}/src`))).toBe(true);
  });

  test("a Bash rule never covers another tool, nor input to a running program", () => {
    expect(covers("Bash", tool("WebFetch"))).toBe(false);
    expect(covers("Bash", bash("y"), { kind: "other" })).toBe(false);
  });

  test("an edit rule covers its own tool inside the project, without a grant", () => {
    expect(covers("Edit", tool("Edit", [`${ROOT}/a.ts`]))).toBe(true);
    expect(covers("Edit", tool("Write", [`${ROOT}/a.ts`]))).toBe(false);
    expect(covers("Write", tool("Write", [`${ROOT}/a.ts`]))).toBe(true);
    expect(covers("Edit", tool("Edit", ["/etc/hosts"]))).toBe(false);
    expect(covers("Edit", tool("Edit", [`${ROOT}/a.ts`]), { kind: "fileChange", paths: [`${ROOT}/a.ts`], grantRoot: "/" })).toBe(false);
  });

  test("another tool's rule covers that tool; one with files only inside the project", () => {
    expect(covers("WebFetch", tool("WebFetch"))).toBe(true);
    expect(covers("WebFetch", tool("WebSearch"))).toBe(false);
    expect(covers("Read", tool("Read", [`${ROOT}/a.ts`]))).toBe(true);
    expect(covers("Read", tool("Read", ["/home/me/.ssh/id_rsa"]))).toBe(false);
  });

  test("sandbox escalation and unreadable rules never cover anything", () => {
    expect(covers("Permissions", tool("Permissions"))).toBe(false);
    expect(covers("Edit(src/**)", tool("Edit", [`${ROOT}/src/a.ts`]))).toBe(false);
    expect(covers("Bash(", bash("ls"))).toBe(false);
  });
});

describe("scopes", () => {
  const step = { path: ROOT, flowStep: { workflow: "scout", step: "Eval" } };
  test("scopeOf builds the scope a run offers, or null", () => {
    expect(scopeOf("step", step)).toEqual({ kind: "step", workflow: "scout", step: "Eval" });
    expect(scopeOf("workflow", step)).toEqual({ kind: "workflow", workflow: "scout" });
    expect(scopeOf("repo", step)).toEqual({ kind: "repo", path: ROOT });
    expect(scopeOf("step", { path: ROOT })).toBeNull();
  });

  test("a step scope holds for that step in any repo; a repo scope for every run there", () => {
    expect(scopeHolds({ kind: "step", workflow: "scout", step: "Eval" }, { ...step, path: "/seeds/other" })).toBe(true);
    expect(scopeHolds({ kind: "step", workflow: "scout", step: "Eval" }, { path: ROOT, flowStep: { workflow: "scout", step: "Build" } })).toBe(false);
    expect(scopeHolds({ kind: "workflow", workflow: "scout" }, { path: "/x", flowStep: { workflow: "scout", step: "Build" } })).toBe(true);
    expect(scopeHolds({ kind: "repo", path: ROOT }, step)).toBe(true);
    expect(scopeHolds({ kind: "repo", path: ROOT }, { path: `${ROOT}-2` })).toBe(false);
    expect(scopeHolds({ kind: "step", workflow: "scout", step: "Eval" }, { path: ROOT })).toBe(false);
  });

  test("scopeWords", () => {
    expect(scopeWords({ kind: "step", workflow: "scout", step: "Eval" })).toBe("scout · Eval, in every project");
    expect(scopeWords({ kind: "workflow", workflow: "scout" })).toBe("every step of scout");
    expect(scopeWords({ kind: "repo", path: "/a/b/proj" })).toBe("runs in proj");
  });

  test("rememberedFor picks a rule whose scope holds and which covers the prompt", () => {
    const rules: RememberedRule[] = [
      { id: "1", rule: "Bash(ls:*)", scope: { kind: "repo", path: "/elsewhere" }, at: 1 },
      { id: "2", rule: "Bash(ls:*)", scope: { kind: "step", workflow: "scout", step: "Eval" }, at: 2 },
    ];
    const p = bash("ls -la");
    expect(rememberedFor(rules, step, p, factsOf(p), ROOT)?.id).toBe("2");
    expect(rememberedFor(rules, { path: ROOT }, p, factsOf(p), ROOT)).toBeNull();
  });
});

describe("parseRemembered", () => {
  test("keeps well-formed rules and drops the rest", () => {
    const text = JSON.stringify({
      rules: [
        { id: "a", rule: "Bash(ls:*)", scope: { kind: "repo", path: "/x" }, at: 1 },
        { id: "b", rule: "Edit(src/**)", scope: { kind: "repo", path: "/x" }, at: 1 },
        { id: "c", rule: "Bash", scope: { kind: "step", workflow: "w" }, at: 1 },
        { id: "d", rule: "Bash", scope: { kind: "workflow", workflow: "w" }, at: 1, by: "mac", from: "ls" },
        "junk",
      ],
    });
    expect(parseRemembered(text).map((r) => r.id)).toEqual(["a", "d"]);
    expect(parseRemembered("{not json")).toEqual([]);
    expect(parseRemembered("[]")).toEqual([]);
  });
});

describe("RememberedRules", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const fresh = async () => {
    const d = await mkdtemp(join(tmpdir(), "canopy-remember-"));
    dirs.push(d);
    return join(d, "remembered.json");
  };

  test("adds, keeps one per rule and scope, forgets, and reads back what it wrote", async () => {
    const file = await fresh();
    const store = new RememberedRules(file);
    expect(store.list()).toEqual([]);
    const a = await store.add("Bash(ls:*)", { kind: "repo", path: ROOT }, { by: "mac", from: "ls -la" });
    const again = await store.add("Bash(ls:*)", { kind: "repo", path: ROOT });
    expect(again.id).toBe(a.id);
    await store.add("WebFetch", { kind: "workflow", workflow: "scout" });
    expect(store.list().map((r) => r.rule)).toEqual(["Bash(ls:*)", "WebFetch"]);
    expect(new RememberedRules(file).list()).toEqual(store.list());
    expect(await store.forget(a.id)).toBe(true);
    expect(await store.forget(a.id)).toBe(false);
    expect(new RememberedRules(file).list().map((r) => r.rule)).toEqual(["WebFetch"]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // written through a rename: no temp file is left behind
    expect((await readdir(join(file, ".."))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("refuses a rule it cannot apply", async () => {
    const store = new RememberedRules(await fresh());
    await expect(store.add("Edit(src/**)", { kind: "repo", path: ROOT })).rejects.toThrow();
    await expect(store.add("Permissions", { kind: "repo", path: ROOT })).rejects.toThrow();
  });

  test("a broken file reads as empty and is written over on the next change", async () => {
    const file = await fresh();
    await writeFile(file, "{oops");
    const store = new RememberedRules(file, () => {});
    expect(store.list()).toEqual([]);
    await store.add("Bash(pwd)", { kind: "repo", path: ROOT });
    expect(JSON.parse(await readFile(file, "utf8")).rules).toHaveLength(1);
  });

  test("two adds at once both land", async () => {
    const file = await fresh();
    const store = new RememberedRules(file);
    await Promise.all([store.add("Bash(a:*)", { kind: "repo", path: ROOT }), store.add("Bash(b:*)", { kind: "repo", path: ROOT })]);
    expect(new RememberedRules(file).list()).toHaveLength(2);
  });
});
