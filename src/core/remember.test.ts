import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalFacts } from "./codexrun";
import { factsOf, parseRemembered, pathsInside, RememberedRules, rememberedFor, ruleCovers, scopeHolds, scopeOf, scopeWords } from "./remember";
import type { FlowStepName, PermissionAsk, RememberedRule } from "./types";

const ROOT = "/home/me/dev/proj";
const bash = (command: string, cwd?: string): PermissionAsk => ({ kind: "permission", tool: "Bash", title: command, detail: command, command, ...(cwd ? { cwd } : {}) });
const tool = (name: string, paths?: string[]): PermissionAsk => ({ kind: "permission", tool: name, title: name, detail: "", ...(paths ? { paths } : {}) });
const covers = (rule: string, p: PermissionAsk, facts: ApprovalFacts = factsOf(p)) => ruleCovers(rule, p, facts, ROOT);

describe("ruleCovers", () => {
  test("a prefix rule covers one simple command starting with its words", () => {
    expect(covers("Bash(git status:*)", bash("git status --short"))).toBe(true);
    expect(covers("Bash(git status:*)", bash("git stash"))).toBe(false);
    expect(covers("Bash(git log:*)", bash("/bin/sh -lc 'git log'"))).toBe(true);
  });

  test("an exact rule covers that command alone", () => {
    expect(covers("Bash(ls -la)", bash("ls -la"))).toBe(true);
    expect(covers("Bash(ls -la)", bash("ls -la src"))).toBe(false);
  });

  test("a compound command is never covered by a prefix rule, only by a bare Bash", () => {
    for (const c of ["git status && rm -rf build", "git status | sh", "git status; curl x", "git status > f", "git status $(rm x)"]) {
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

  test("a command that reaches outside the project by its words is never covered, a bare Bash included", () => {
    // Claude's prompts carry no folder: the command's own cd and paths are what say where it runs
    expect(covers("Bash", bash("cd ~ && rm -rf x"))).toBe(false);
    expect(covers("Bash", bash("cd /tmp; ls"))).toBe(false);
    expect(covers("Bash(ls:*)", bash("ls ~/x"))).toBe(false);
    expect(covers("Bash(cat:*)", bash("cat /etc/hosts"))).toBe(false);
    expect(covers("Bash(git -C /etc status)", bash("git -C /etc status"))).toBe(false);
    expect(covers("Bash(cat:*)", bash(`cat ${ROOT}/a.ts`))).toBe(true);
  });

  test("a prompt that no rule may answer is never covered", () => {
    expect(covers("Bash", { ...bash("ls"), noRule: "it asks to run outside codex's sandbox" })).toBe(false);
    expect(covers("Bash(ls:*)", { ...bash("ls"), noRule: "an incubator stage's run" })).toBe(false);
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

  test("another tool's rule covers that tool only with at least one file, every one inside the project", () => {
    expect(covers("Read", tool("Read", [`${ROOT}/a.ts`]))).toBe(true);
    expect(covers("Read", tool("Read", ["/home/me/.ssh/id_rsa"]))).toBe(false);
    // a Glob with no folder searches wherever its pattern says: /etc/** too
    expect(covers("Glob", tool("Glob"))).toBe(false);
    expect(covers("Glob", tool("Glob", [ROOT]))).toBe(true);
    expect(covers("WebFetch", tool("WebFetch"))).toBe(false);
    expect(covers("Read", tool("Grep", [`${ROOT}/a.ts`]))).toBe(false);
  });

  test("tools never remembered and unreadable rules never cover anything", () => {
    expect(covers("Permissions", tool("Permissions"))).toBe(false);
    expect(covers("Network", tool("Network"))).toBe(false);
    expect(covers("NotebookEdit", tool("NotebookEdit", [`${ROOT}/a.ipynb`]))).toBe(false);
    expect(covers("ExitPlanMode", tool("ExitPlanMode"))).toBe(false);
    expect(covers("Edit(src/**)", tool("Edit", [`${ROOT}/src/a.ts`]))).toBe(false);
    expect(covers("Bash(", bash("ls"))).toBe(false);
  });
});

describe("pathsInside", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  test("a file tool's paths are judged on disk: a link out of the project is outside", async () => {
    const d = await mkdtemp(join(tmpdir(), "canopy-inside-"));
    dirs.push(d);
    const root = join(d, "proj");
    const away = join(d, "away");
    await mkdir(root);
    await mkdir(away);
    await symlink(away, join(root, "link"));
    expect(await pathsInside([join(root, "a.ts")], root)).toBe(true);
    expect(await pathsInside([join(root, "new/dir/b.ts")], root)).toBe(true);
    expect(await pathsInside([join(root, "link/x.ts")], root)).toBe(false);
    expect(await pathsInside([join(root, "a.ts"), join(root, "link")], root)).toBe(false);
  });
});

describe("scopes", () => {
  const scout: FlowStepName = { workflow: "scout", step: "Eval", source: "bundled" };
  const step = { path: ROOT, flowStep: scout };
  test("scopeOf builds the scope a run offers, or null", () => {
    expect(scopeOf("step", step)).toEqual({ kind: "step", workflow: "scout", step: "Eval", source: "bundled" });
    expect(scopeOf("workflow", step)).toEqual({ kind: "workflow", workflow: "scout", source: "bundled" });
    expect(scopeOf("repo", step)).toEqual({ kind: "repo", path: ROOT });
    expect(scopeOf("step", { path: ROOT })).toBeNull();
  });

  test("a repo's own workflow has no step or workflow scope: a cloned repo could name its file scout", () => {
    const own = { path: ROOT, flowStep: { ...scout, source: "repo" as const } };
    expect(scopeOf("step", own)).toBeNull();
    expect(scopeOf("workflow", own)).toBeNull();
    expect(scopeOf("repo", own)).toEqual({ kind: "repo", path: ROOT });
    expect(scopeHolds({ kind: "step", workflow: "scout", step: "Eval", source: "bundled" }, own)).toBe(false);
    expect(scopeHolds({ kind: "workflow", workflow: "scout", source: "bundled" }, own)).toBe(false);
  });

  test("a step scope holds for that step of that workflow file in any repo; a repo scope for every run there", () => {
    expect(scopeHolds({ kind: "step", workflow: "scout", step: "Eval", source: "bundled" }, { ...step, path: "/other" })).toBe(true);
    expect(scopeHolds({ kind: "step", workflow: "scout", step: "Eval", source: "user" }, step)).toBe(false);
    expect(scopeHolds({ kind: "step", workflow: "scout", step: "Eval", source: "bundled" }, { path: ROOT, flowStep: { ...scout, step: "Build" } })).toBe(false);
    expect(scopeHolds({ kind: "workflow", workflow: "scout", source: "bundled" }, { path: "/x", flowStep: { ...scout, step: "Build" } })).toBe(true);
    expect(scopeHolds({ kind: "repo", path: ROOT }, step)).toBe(true);
    expect(scopeHolds({ kind: "repo", path: ROOT }, { path: `${ROOT}-2` })).toBe(false);
    expect(scopeHolds({ kind: "step", workflow: "scout", step: "Eval", source: "bundled" }, { path: ROOT })).toBe(false);
  });

  test("scopeWords", () => {
    expect(scopeWords({ kind: "step", workflow: "scout", step: "Eval", source: "bundled" })).toBe("scout · Eval, in every project");
    expect(scopeWords({ kind: "workflow", workflow: "scout", source: "user" })).toBe("every step of scout");
    expect(scopeWords({ kind: "repo", path: "/a/b/proj" })).toBe("runs in proj");
  });

  test("rememberedFor picks a rule whose scope holds and which covers the prompt", () => {
    const rules: RememberedRule[] = [
      { id: "1", rule: "Bash(ls:*)", scope: { kind: "repo", path: "/elsewhere" }, at: 1 },
      { id: "2", rule: "Bash(ls:*)", scope: { kind: "step", workflow: "scout", step: "Eval", source: "bundled" }, at: 2 },
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
        { id: "c", rule: "Bash", scope: { kind: "step", workflow: "w", source: "bundled" }, at: 1 },
        { id: "d", rule: "Bash", scope: { kind: "workflow", workflow: "w", source: "user" }, at: 1, by: "mac", from: "ls" },
        { id: "e", rule: "Bash", scope: { kind: "workflow", workflow: "w", source: "repo" }, at: 1 },
        { id: "f", rule: "Bash", scope: { kind: "workflow", workflow: "w" }, at: 1 },
        { id: "g", rule: "Network", scope: { kind: "repo", path: "/x" }, at: 1 },
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
    await store.add("Read", { kind: "workflow", workflow: "scout", source: "bundled" });
    expect(store.list().map((r) => r.rule)).toEqual(["Bash(ls:*)", "Read"]);
    expect(new RememberedRules(file).list()).toEqual(store.list());
    expect(await store.forget(a.id)).toBe(true);
    expect(await store.forget(a.id)).toBe(false);
    expect(new RememberedRules(file).list().map((r) => r.rule)).toEqual(["Read"]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // written through a rename: no temp file is left behind
    expect((await readdir(join(file, ".."))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("refuses a rule it cannot apply", async () => {
    const store = new RememberedRules(await fresh());
    await expect(store.add("Edit(src/**)", { kind: "repo", path: ROOT })).rejects.toThrow();
    await expect(store.add("Permissions", { kind: "repo", path: ROOT })).rejects.toThrow();
  });

  test("a rule is held only once it is on disk: a failed write leaves nothing in memory", async () => {
    const file = await fresh();
    // a folder where the file should be makes every write fail
    await mkdir(file);
    const store = new RememberedRules(file, () => {});
    await expect(store.add("Bash(pwd)", { kind: "repo", path: ROOT })).rejects.toThrow();
    expect(store.list()).toEqual([]);
  });

  test("a failed forget keeps the rule", async () => {
    const d = await mkdtemp(join(tmpdir(), "canopy-remember-"));
    dirs.push(d);
    const file = join(d, "remembered.json");
    const store = new RememberedRules(file);
    const a = await store.add("Bash(pwd)", { kind: "repo", path: ROOT });
    await rm(file);
    await mkdir(file);
    await expect(store.forget(a.id)).rejects.toThrow();
    expect(store.list().map((r) => r.id)).toEqual([a.id]);
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
    expect(store.list()).toHaveLength(2);
    expect(new RememberedRules(file).list()).toHaveLength(2);
  });
});
