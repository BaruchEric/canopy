import { describe, expect, test } from "bun:test";
import { commandParts, describeGuard, guardHit, normalizeGuards, parseGuardRule } from "./guards";

describe("parseGuardRule", () => {
  test("reads the kinds a Bash rule comes in", () => {
    const kind = (r: string) => {
      const p = parseGuardRule(r);
      return p.ok ? p.rule.kind : p.error;
    };
    expect(kind("Bash")).toBe("every");
    expect(kind("Bash(git push --force:*)")).toBe("prefix");
    expect(kind("Bash(rm -rf *)")).toBe("glob");
    expect(kind("Bash(bun run redeploy)")).toBe("exact");
  });

  test("trims, and keeps the rule as the broker will", () => {
    const p = parseGuardRule("  Bash(git push --force:*)  ");
    expect(p.ok && p.rule).toEqual({ text: "Bash(git push --force:*)", tool: "Bash", spec: "git push --force:*", kind: "prefix" });
  });

  test("refuses what the broker refuses, and a prefix with no command", () => {
    for (const bad of ["", "   ", "git push", "Bash()", "Bash(x", "(x)", "Bash(a)\nBash(b)", `Bash(${"x".repeat(600)})`, "Bash(:*)", "Bash(  :*)"]) {
      expect(parseGuardRule(bad).ok).toBe(false);
    }
  });

  test("another tool is kept but marked as matching nothing", () => {
    const p = parseGuardRule("Edit(src/**)");
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.rule.inert).toContain("only Bash rules");
  });
});

test("describeGuard says what a rule stops", () => {
  const words = (r: string) => {
    const p = parseGuardRule(r);
    return p.ok ? describeGuard(p.rule) : p.error;
  };
  expect(words("Bash")).toBe("every shell command");
  expect(words("Bash(git push --force:*)")).toBe("commands starting with git push --force");
  expect(words("Bash(rm -rf *)")).toBe("commands matching rm -rf *");
  expect(words("Bash(make deploy)")).toBe("exactly make deploy");
});

test("normalizeGuards trims, drops blanks and repeats, and names the first bad rule", () => {
  expect(normalizeGuards([" Bash(a:*) ", "", "Bash(a:*)", "Bash(b)"])).toEqual({ rules: ["Bash(a:*)", "Bash(b)"] });
  expect(normalizeGuards(["Bash(a)", "nope!"])).toEqual({ error: expect.stringContaining("nope!") });
  expect(normalizeGuards(Array.from({ length: 201 }, (_, i) => `Bash(c${i})`))).toEqual({ error: "at most 200 rules" });
});

describe("guardHit, as the tailchan hook matches (checked against its jq)", () => {
  const rules = ["Read(x)", "Bash(git push --force:*)", "Bash(rm -rf *)", "Bash(bun run redeploy:*)", "Bash(exact thing)"];
  const cases: [string, string | null][] = [
    ["git push --force", "Bash(git push --force:*)"],
    ["git push --force origin main", "Bash(git push --force:*)"],
    ["git push --forced", null],
    ["echo hi && git push --force", "Bash(git push --force:*)"],
    ["cd x; rm -rf /tmp/y", "Bash(rm -rf *)"],
    ["rm -rf", null],
    ["FOO=1 BAR=2 bun run redeploy --pull", "Bash(bun run redeploy:*)"],
    ["sudo git push --force", "Bash(git push --force:*)"],
    ["bash -lc 'git push --force'", "Bash(git push --force:*)"],
    ["(git push --force)", "Bash(git push --force:*)"],
    ["exact thing", "Bash(exact thing)"],
    ["exact  thing", "Bash(exact thing)"],
    ["  exact thing ", "Bash(exact thing)"],
    ["ls | grep x", null],
    ['sh -c "rm -rf /"', "Bash(rm -rf *)"],
    ["git push  --force   x", "Bash(git push --force:*)"],
    ["env git push --force", "Bash(git push --force:*)"],
    // one prefix word is dropped, not two, the same as the hook
    ["time exec git push --force", null],
  ];
  for (const [cmd, hit] of cases) test(JSON.stringify(cmd), () => expect(guardHit(rules, cmd)).toBe(hit));

  test("a bare Bash hits everything, and the first matching rule wins", () => {
    expect(guardHit(["Bash(ls:*)", "Bash"], "ls -la")).toBe("Bash(ls:*)");
    expect(guardHit(["Bash"], "anything")).toBe("Bash");
    expect(guardHit([], "rm -rf /")).toBeNull();
  });

  test("commandParts splits a compound command the way the hook does", () => {
    expect(commandParts("a && b || c; d | e & f\ng")).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(commandParts("{ X=1 nohup make; }")).toEqual(["make"]);
  });
});
