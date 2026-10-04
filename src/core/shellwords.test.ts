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
  test("a plain command offers its prefixes and itself, one word by default", () => {
    expect(ruleOffer("Bash", "ls -la workspace/src")).toEqual({
      rules: ["Bash(ls:*)", "Bash(ls -la:*)", "Bash(ls -la workspace/src:*)", "Bash(ls -la workspace/src)"],
      pick: 0,
    });
  });

  test("a tool with subcommands picks two words", () => {
    expect(ruleOffer("Bash", "git status --short")).toEqual({
      rules: ["Bash(git:*)", "Bash(git status:*)", "Bash(git status --short:*)", "Bash(git status --short)"],
      pick: 1,
    });
    // a flag is not a subcommand
    expect(ruleOffer("Bash", "git --version")?.pick).toBe(0);
  });

  test("an interpreter or a script path picks the exact command", () => {
    const py = ruleOffer("Bash", "python3 scripts/count.py --all");
    expect(py?.rules[py.pick]).toBe("Bash(python3 scripts/count.py --all)");
    const sh = ruleOffer("Bash", "./build.sh");
    expect(sh?.rules[sh.pick]).toBe("Bash(./build.sh)");
  });

  test("a one-word command offers the prefix and the exact word", () => {
    expect(ruleOffer("Bash", "pwd")).toEqual({ rules: ["Bash(pwd:*)", "Bash(pwd)"], pick: 0 });
  });

  test("never more than three words of prefix", () => {
    const o = ruleOffer("Bash", "a b c d e f");
    expect(o?.rules).toEqual(["Bash(a:*)", "Bash(a b:*)", "Bash(a b c:*)", "Bash(a b c d e f)"]);
  });

  test("a shell wrapper is read through", () => {
    expect(ruleOffer("Bash", "/bin/sh -lc 'git status'")?.rules[1]).toBe("Bash(git status:*)");
  });

  test("a chain, a pipe, a redirect or a heredoc can only be covered by a bare Bash", () => {
    for (const c of ["ls && cat a", "ls | head", "echo hi > out.txt", "python3 - <<'EOF'\nprint(1)\nEOF", "echo $HOME"]) {
      expect(ruleOffer("Bash", c)).toEqual({ rules: ["Bash"], pick: 0, chain: true });
    }
  });

  test("another tool offers its name; sandbox escalation and odd names offer nothing", () => {
    expect(ruleOffer("WebFetch")).toEqual({ rules: ["WebFetch"], pick: 0 });
    expect(ruleOffer("Edit")).toEqual({ rules: ["Edit"], pick: 0 });
    expect(ruleOffer("Permissions")).toBeNull();
    expect(ruleOffer("AskUserQuestion")).toBeNull();
    expect(ruleOffer("item/unknown/requestApproval")).toBeNull();
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
