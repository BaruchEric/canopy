/** A terminal session's call against canopy's remembered rules: the repo
 *  its folder is in, a rule that covers the call there, and a remember that
 *  takes only a rule canopy offers. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RememberedRules } from "./remember";
import { repoHolding, sessionAsk, sessionRemember, sessionRule } from "./sessionrules";
import type { RememberedRule } from "./types";

let scratch: string;
let proj: string;

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "canopy-sessionrules-")));
  proj = join(scratch, "proj");
  await mkdir(join(proj, "src"), { recursive: true });
  await mkdir(join(scratch, "elsewhere"), { recursive: true });
  // a link in the project that leads out of it
  await symlink(join(scratch, "elsewhere"), join(proj, "out"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const rule = (r: string, path = proj): RememberedRule => ({ id: r, rule: r, scope: { kind: "repo", path }, at: 0, keyed: true });

describe("repoHolding", () => {
  test("the deepest repo holding the folder, or none", () => {
    expect(repoHolding(["/a", "/a/b", "/c"], "/a/b/x")).toBe("/a/b");
    expect(repoHolding(["/a", "/a/b"], "/a/bc")).toBe("/a");
    expect(repoHolding(["/a"], "/a")).toBe("/a");
    expect(repoHolding(["/a"], "/z")).toBeNull();
    expect(repoHolding(["/a"], "a/b")).toBeNull();
  });
});

describe("sessionRule", () => {
  test("a repo rule covers a session's command in that repo, and only there", async () => {
    const rules = [rule("Bash(git status:*)")];
    expect(await sessionRule(rules, [proj], "Bash", { command: "git status -s" }, proj)).toBe("Bash(git status:*)");
    expect(await sessionRule(rules, [proj], "Bash", { command: "git status" }, join(proj, "src"))).toBe("Bash(git status:*)");
    expect(await sessionRule(rules, [proj], "Bash", { command: "git push" }, proj)).toBeNull();
    // a folder in no repo on this machine, or a rule kept for another repo
    expect(await sessionRule(rules, [proj], "Bash", { command: "git status" }, join(scratch, "elsewhere"))).toBeNull();
    expect(await sessionRule([rule("Bash(git status:*)", "/other")], [proj], "Bash", { command: "git status" }, proj)).toBeNull();
  });

  // a rule any shell could have kept through the loopback answers runs only
  test("a rule kept without an answer key answers no session", async () => {
    const { keyed: _, ...plain } = rule("Bash");
    expect(await sessionRule([plain], [proj], "Bash", { command: "ls" }, proj)).toBeNull();
  });

  test("a keyed keep of a rule held unkeyed marks it keyed", async () => {
    const kept = new RememberedRules(join(scratch, "remembered.json"), () => {});
    const first = await kept.add("Bash(ls)", { kind: "repo", path: proj });
    expect(first.keyed).toBeUndefined();
    expect((await kept.add("Bash(ls)", { kind: "repo", path: proj }, { keyed: true })).keyed).toBe(true);
    expect(kept.list().map((r) => [r.id, r.keyed])).toEqual([[first.id, true]]);
    // and kept so on disk
    expect(new RememberedRules(join(scratch, "remembered.json"), () => {}).list()[0]?.keyed).toBe(true);
  });

  test("a bare Bash stops at the project's edge, by its words and on disk", async () => {
    const rules = [rule("Bash")];
    expect(await sessionRule(rules, [proj], "Bash", { command: "ls src && wc -l src/a.ts" }, proj)).toBe("Bash");
    expect(await sessionRule(rules, [proj], "Bash", { command: "cat /etc/hosts" }, proj)).toBeNull();
    // the session sits in a link that leads out
    expect(await sessionRule(rules, [proj], "Bash", { command: "ls" }, join(proj, "out"))).toBeNull();
  });

  test("an edit inside the project, never through a link out of it", async () => {
    const rules = [rule("Edit")];
    const edit = (file: string) => ({ file_path: file, old_string: "a", new_string: "b" });
    expect(await sessionRule(rules, [proj], "Edit", edit(join(proj, "src/a.ts")), proj)).toBe("Edit");
    expect(await sessionRule(rules, [proj], "Edit", edit("src/a.ts"), proj)).toBe("Edit");
    expect(await sessionRule(rules, [proj], "Edit", edit(join(proj, "out/a.ts")), proj)).toBeNull();
    expect(await sessionRule(rules, [proj], "Edit", edit(join(proj, ".git/hooks/pre-commit")), proj)).toBeNull();
  });
});

describe("sessionRemember", () => {
  test("only a rule canopy offers for the call, and that covers it", () => {
    const p = sessionAsk("Bash", { command: "git status --short" }, proj);
    expect(sessionRemember("Bash(git status:*)", p, proj)).toEqual({ ok: true });
    expect(sessionRemember("Bash(git:*)", p, proj)).toEqual({ error: "canopy does not offer Bash(git:*) for this request" });
    const out = sessionAsk("Bash", { command: "cat /etc/hosts" }, proj);
    expect("error" in sessionRemember("Bash(cat:*)", out, proj)).toBe(true);
  });
});
