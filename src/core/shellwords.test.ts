import { describe, expect, test } from "bun:test";
import { parseRule, quoteWord, ruleOf, ruleOffer, ruleWords } from "./shellwords";

describe("quoteWord and ruleOf", () => {
  test("plain words stay bare, the rest are single-quoted", () => {
    expect(quoteWord("status")).toBe("status");
    expect(quoteWord("src/a.ts")).toBe("src/a.ts");
    expect(quoteWord("a b")).toBe("'a b'");
    expect(quoteWord("it's")).toBe("'it'\\''s'");
    expect(quoteWord("")).toBe("''");
  });

  test("a rule built from words parses back to the same words", () => {
    for (const words of [["git", "status"], ["echo", "a; b"], ["printf", "it's $HOME"], ["ls", "-la", "my dir"]]) {
      for (const prefix of [true, false]) {
        expect(parseRule(ruleOf(words, prefix))).toEqual({ kind: "bash", words, prefix });
      }
    }
  });
});

describe("ruleOffer", () => {
  test("a plain command offers its leading words as prefixes and itself, one word by default", () => {
    expect(ruleOffer("Bash", "cat a.txt")).toEqual({ rules: ["Bash(cat:*)", "Bash(cat a.txt:*)", "Bash(cat a.txt)"], pick: 0 });
    expect(ruleOffer("Bash", "make build docs")).toEqual({
      rules: ["Bash(make build:*)", "Bash(make build docs:*)", "Bash(make build docs)"],
      pick: 0,
    });
  });

  test("a flag as the second word makes the offer exact only", () => {
    expect(ruleOffer("Bash", "ls -la workspace/src")).toEqual({ rules: ["Bash(ls -la workspace/src)"], pick: 0 });
    expect(ruleOffer("Bash", "git -C sub status")).toEqual({ rules: ["Bash(git -C sub status)"], pick: 0 });
    expect(ruleOffer("Bash", "git --version")).toEqual({ rules: ["Bash(git --version)"], pick: 0 });
    expect(ruleOffer("Bash", "bun -e 'console.log(1)'")).toEqual({ rules: ["Bash(bun -e 'console.log(1)')"], pick: 0 });
  });

  test("a leading assignment makes the offer exact only", () => {
    expect(ruleOffer("Bash", "FOO=1 bun test")).toEqual({ rules: ["Bash(FOO=1 bun test)"], pick: 0 });
  });

  test("a tool with subcommands offers two words at least and stops at a flag", () => {
    expect(ruleOffer("Bash", "git status --short")).toEqual({ rules: ["Bash(git status:*)", "Bash(git status --short)"], pick: 0 });
    expect(ruleOffer("Bash", "bun test src/a.test.ts")).toEqual({
      rules: ["Bash(bun test:*)", "Bash(bun test src/a.test.ts:*)", "Bash(bun test src/a.test.ts)"],
      pick: 0,
    });
    // never one word: git:* would cover git -c alias.x=... and git push --force
    for (const c of ["git status", "git push origin main", "bun test"]) {
      expect(ruleOffer("Bash", c)?.rules).not.toContain("Bash(git:*)");
      expect(ruleOffer("Bash", c)?.rules).not.toContain("Bash(bun:*)");
    }
    expect(ruleOffer("Bash", "git")).toEqual({ rules: ["Bash(git)"], pick: 0 });
  });

  test("whatever runs anything else is exact only", () => {
    for (const c of [
      "python3 scripts/count.py --all",
      "./build.sh",
      "command rm -rf x",
      "! true",
      "ssh host ls",
      "awk '{print}' a",
      "find . -name x",
      "sed s/a/b/ f",
      "docker run alpine sh",
      "docker exec box sh",
      "kubectl exec pod sh",
      "npm exec cowsay",
      "uv run anything",
      "gh api repos/x -X DELETE",
      "bunx some-tool",
      "xargs rm",
    ]) {
      expect(ruleOffer("Bash", c)?.rules, c).toHaveLength(1);
      expect(ruleOffer("Bash", c)?.rules[0]?.endsWith(":*)"), c).toBe(false);
    }
  });

  test("a one-word command offers the prefix and the exact word", () => {
    expect(ruleOffer("Bash", "pwd")).toEqual({ rules: ["Bash(pwd:*)", "Bash(pwd)"], pick: 0 });
  });

  test("never more than three words of prefix", () => {
    const o = ruleOffer("Bash", "a b c d e f");
    expect(o?.rules).toEqual(["Bash(a:*)", "Bash(a b:*)", "Bash(a b c:*)", "Bash(a b c d e f)"]);
  });

  test("a shell wrapper is read through", () => {
    expect(ruleOffer("Bash", "/bin/sh -lc 'git status'")?.rules[0]).toBe("Bash(git status:*)");
  });

  test("a chain, a pipe, a redirect or a heredoc can only be covered by a bare Bash", () => {
    for (const c of ["ls && cat a", "ls | head", "echo hi > out.txt", "python3 - <<'EOF'\nprint(1)\nEOF", "echo $HOME"]) {
      expect(ruleOffer("Bash", c)).toEqual({ rules: ["Bash"], pick: 0, chain: true });
    }
  });

  test("another tool offers its name; escalations, plan mode, the network, notebooks and odd names offer nothing", () => {
    expect(ruleOffer("Read")).toEqual({ rules: ["Read"], pick: 0 });
    expect(ruleOffer("Edit")).toEqual({ rules: ["Edit"], pick: 0 });
    for (const t of ["Permissions", "AskUserQuestion", "ExitPlanMode", "Network", "NotebookEdit", "item/unknown/requestApproval"]) {
      expect(ruleOffer(t), t).toBeNull();
    }
    expect(ruleOffer("Bash", "")).toBeNull();
    expect(ruleOffer("Bash")).toBeNull();
  });
});

describe("ruleWords", () => {
  test("says what a rule lets through", () => {
    expect(ruleWords("Bash")).toBe("any shell command");
    expect(ruleWords("Bash(git status:*)")).toBe("commands starting git status");
    expect(ruleWords("Bash(git status --short)")).toBe("exactly git status --short");
    expect(ruleWords("Edit")).toBe("any Edit inside the project");
    expect(ruleWords("Write")).toBe("any Write inside the project");
    expect(ruleWords("Read")).toBe("any Read inside the project");
    expect(ruleWords("WebFetch")).toBe("any WebFetch");
    expect(ruleWords("Edit(src/**)")).toBe("Edit(src/**)");
  });
});
