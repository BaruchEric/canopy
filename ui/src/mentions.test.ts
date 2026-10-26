import { describe, expect, test } from "bun:test";
import type { Mention } from "../../src/core/types";
import { applyPick, mentionAt, rankFiles, rankWords, sigilsFor, subsequence, withFolders } from "./mentions";

describe("sigilsFor", () => {
  test("@ for any box, $ for Codex, / for Claude Code only when the text is a message of its own", () => {
    expect(sigilsFor("claude", true)).toEqual(["@", "/"]);
    expect(sigilsFor("claude")).toEqual(["@"]);
    expect(sigilsFor("codex", true)).toEqual(["@", "$"]);
    expect(sigilsFor("codex")).toEqual(["@", "$"]);
    expect(sigilsFor(null, true)).toEqual(["@"]);
  });
});

describe("mentionAt", () => {
  const CLAUDE = sigilsFor("claude", true);
  const CODEX = sigilsFor("codex", true);
  test("a slash command only as the first character, and only where it is offered", () => {
    expect(mentionAt("/com", 4, CLAUDE)).toEqual({ sigil: "/", start: 0, end: 4, query: "com" });
    expect(mentionAt("/", 1, CLAUDE)).toEqual({ sigil: "/", start: 0, end: 1, query: "" });
    expect(mentionAt("fix /com", 8, CLAUDE)).toBeNull();
    expect(mentionAt("/com", 4, CODEX)).toBeNull();
    expect(mentionAt("/com", 4, sigilsFor("claude"))).toBeNull();
    expect(mentionAt("/commit now", 11, CLAUDE)).toBeNull();
  });
  test("a file at the start of any word, the caret inside it", () => {
    expect(mentionAt("read @src/a", 11, CLAUDE)).toEqual({ sigil: "@", start: 5, end: 11, query: "src/a" });
    expect(mentionAt("read @src/a.ts now", 8, CODEX)).toEqual({ sigil: "@", start: 5, end: 14, query: "sr" });
    expect(mentionAt("mail a@b.c", 10, CLAUDE)).toBeNull();
    expect(mentionAt("read @src/a now", 15, CLAUDE)).toBeNull();
    expect(mentionAt("see @README", 11, sigilsFor(null))).toEqual({ sigil: "@", start: 4, end: 11, query: "README" });
  });
  test("a Codex skill at $, in a note too", () => {
    expect(mentionAt("use $bu", 7, CODEX)).toEqual({ sigil: "$", start: 4, end: 7, query: "bu" });
    expect(mentionAt("use $bu", 7, sigilsFor("codex"))).toEqual({ sigil: "$", start: 4, end: 7, query: "bu" });
    expect(mentionAt("use $bu", 7, CLAUDE)).toBeNull();
  });
  test("a caret past the end is the end", () => {
    expect(mentionAt("@a", 9, CLAUDE)).toEqual({ sigil: "@", start: 0, end: 2, query: "a" });
  });
});

test("subsequence", () => {
  expect(subsequence("gt", "git.test.ts")).toBe(true);
  expect(subsequence("tg", "git")).toBe(false);
  expect(subsequence("", "x")).toBe(true);
});

const word = (name: string, from: string, description = "", alias?: string): Mention => ({
  name,
  kind: from === "builtin" ? "builtin" : "skill",
  harness: "claude",
  from,
  description,
  ...(alias ? { alias } : {}),
});

const WORDS = [
  word("ship", "user", "Run the gates, then commit and push"),
  word("redeploy", "project", "Redeploy the mini"),
  word("compact", "builtin", "Summarize so far"),
  word("superpowers:brainstorming", "plugin:superpowers", "Think first"),
  word("ripe", "user", "Drive ripe", "cli-anything-ripe"),
  word("commit", "user", "Commit the changes"),
];

describe("rankWords", () => {
  test("with no query, the repo's own, the user's, the CLI's, then the plugins', by name", () => {
    expect(rankWords(WORDS, "").map((w) => w.name)).toEqual(["redeploy", "commit", "ripe", "ship", "compact", "superpowers:brainstorming"]);
  });
  test("a name's start beats a part's start beats anywhere beats the description", () => {
    expect(rankWords(WORDS, "co").map((w) => w.name)).toEqual(["commit", "compact", "ship"]);
    expect(rankWords(WORDS, "brain").map((w) => w.name)).toEqual(["superpowers:brainstorming"]);
    expect(rankWords(WORDS, "mini").map((w) => w.name)).toEqual(["redeploy"]);
    expect(rankWords(WORDS, "anything").map((w) => w.name)).toEqual(["ripe"]);
    expect(rankWords(WORDS, "sp").map((w) => w.name)).toEqual(["ship", "superpowers:brainstorming"]);
    expect(rankWords(WORDS, "zzz")).toEqual([]);
  });
  test("caps the rows", () => {
    expect(rankWords(WORDS, "", 2)).toHaveLength(2);
  });
});

const FILES = [".github/workflows/ci.yml", ".gitignore", "README.md", "src/core/git.test.ts", "src/core/git.ts", "src/server/index.ts", "ui/src/store.ts", "package.json"];

describe("withFolders", () => {
  test("every folder as dir/, sorted, before the files", () => {
    expect(withFolders(FILES).slice(0, 6)).toEqual([".github/", ".github/workflows/", "src/", "src/core/", "src/server/", "ui/"]);
    expect(withFolders(FILES)).toHaveLength(FILES.length + 7);
  });
});

describe("rankFiles", () => {
  const paths = withFolders(FILES);
  test("with no query, the top level, folders first, dotfiles last", () => {
    expect(rankFiles(paths, "")).toEqual(["src/", "ui/", "package.json", "README.md", "src/core/", "src/server/", "ui/src/", "src/core/git.test.ts", "src/core/git.ts", "src/server/index.ts", "ui/src/store.ts", ".github/"]);
  });
  test("a name's start first, then anywhere in it, then the path, then the letters in order", () => {
    expect(rankFiles(paths, "git")).toEqual(["src/core/git.ts", "src/core/git.test.ts", ".github/", ".gitignore", ".github/workflows/", ".github/workflows/ci.yml"]);
    expect(rankFiles(paths, "src/core/g")).toEqual(["src/core/git.ts", "src/core/git.test.ts"]);
    expect(rankFiles(paths, "ui/")).toEqual(["ui/", "ui/src/", "ui/src/store.ts"]);
    expect(rankFiles(paths, "sidx")).toEqual(["src/server/index.ts"]);
    expect(rankFiles(paths, "zzz")).toEqual([]);
  });
  test("a dotted query brings the dotfiles up", () => {
    expect(rankFiles(paths, ".git").slice(0, 2)).toEqual([".github/", ".gitignore"]);
  });
});

describe("applyPick", () => {
  test("a word gets its sigil and a space, the caret after", () => {
    expect(applyPick("/com", { sigil: "/", start: 0, end: 4, query: "com" }, "commit")).toEqual({ text: "/commit ", caret: 8 });
    expect(applyPick("read @src/a now", { sigil: "@", start: 5, end: 11, query: "src/a" }, "src/core/a.ts")).toEqual({ text: "read @src/core/a.ts  now", caret: 20 });
  });
  test("a folder gets no space, so the menu goes on inside it", () => {
    expect(applyPick("see @s", { sigil: "@", start: 4, end: 6, query: "s" }, "src/")).toEqual({ text: "see @src/", caret: 9 });
  });
});
