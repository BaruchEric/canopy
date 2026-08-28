import { describe, expect, test } from "bun:test";
import {
  fromJsonManifest,
  fromReadme,
  fromTomlManifest,
  MAX_DESCRIPTION,
  pickLink,
  tidy,
} from "./meta";

describe("tidy", () => {
  test("collapses whitespace and drops the empty case", () => {
    expect(tidy("  a\n  live   tree ")).toBe("a live tree");
    expect(tidy("   \n ")).toBeNull();
  });

  test("cuts long text at a word boundary", () => {
    const long = `${"word ".repeat(60)}end`;
    const out = tidy(long) as string;
    expect(out.length).toBeLessThanOrEqual(MAX_DESCRIPTION + 1);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("  ");
    expect(out.at(-2)).not.toBe(" ");
  });
});

describe("fromJsonManifest", () => {
  test("reads description, ignores everything else", () => {
    expect(fromJsonManifest('{"name":"x","description":"a git cockpit"}')).toBe(
      "a git cockpit",
    );
    expect(fromJsonManifest('{"name":"x"}')).toBeNull();
    expect(fromJsonManifest('{"description":42}')).toBeNull();
    expect(fromJsonManifest("not json at all")).toBeNull();
    expect(fromJsonManifest("[1,2,3]")).toBeNull();
  });
});

describe("fromTomlManifest", () => {
  test("reads a single-line description", () => {
    const cargo = `[package]\nname = "canopy"\ndescription = "a tiny engine"\nedition = "2021"\n`;
    expect(fromTomlManifest(cargo)).toBe("a tiny engine");
    expect(fromTomlManifest(`[project]\ndescription = 'single quotes'\n`)).toBe(
      "single quotes",
    );
  });

  test("skips a multi-line value rather than keeping its first line", () => {
    expect(fromTomlManifest('description = """\nlong\n"""\n')).toBeNull();
    expect(fromTomlManifest('[package]\nname = "x"\n')).toBeNull();
  });
});

describe("fromReadme", () => {
  test("takes the first prose line after the title", () => {
    expect(fromReadme("# canopy\n\nMulti-repo git cockpit.\n")).toBe(
      "Multi-repo git cockpit.",
    );
  });

  test("skips frontmatter, badges, HTML and rules", () => {
    const readme = [
      "---",
      "title: thing",
      "---",
      '<p align="center">',
      '  <img src="logo.png" />',
      "</p>",
      "",
      "[![build](https://img.shields.io/x)](https://ci) [![npm](https://b.svg)](https://npm)",
      "",
      "===",
      "",
      "The open-source design platform.",
    ].join("\n");
    expect(fromReadme(readme)).toBe("The open-source design platform.");
  });

  test("skips a setext heading, its underline, and link definitions", () => {
    const readme = [
      "penpot",
      "======",
      "",
      "[urilicense]: https://www.mozilla.org/en-US/MPL/2.0",
      "",
      "Design and prototype in the browser.",
    ].join("\n");
    expect(fromReadme(readme)).toBe("Design and prototype in the browser.");
  });

  test("skips a table of contents and a fenced install block", () => {
    const readme = [
      "# thing",
      "",
      "[Overview](#o) · [Principles](#p) · [Features](#f)",
      "",
      "```sh",
      "git clone https://github.com/o/thing.git",
      "```",
      "",
      "It captures what you care about.",
    ].join("\n");
    expect(fromReadme(readme)).toBe("It captures what you care about.");
  });

  test("joins a hard-wrapped paragraph instead of cutting at the margin", () => {
    const readme = "# devhub\n\nA self-evolving manager for the dev workspace.\nSorts projects into\ntopic folders.\n\nMore below.\n";
    expect(fromReadme(readme)).toBe(
      "A self-evolving manager for the dev workspace. Sorts projects into topic folders.",
    );
  });

  test("unwraps links and emphasis in the line it keeps", () => {
    expect(fromReadme("A **fast** [CLI](https://x) for `git`.\n")).toBe(
      "A fast CLI for git.",
    );
  });

  test("returns null when the file is nothing but chrome", () => {
    expect(fromReadme("# title\n\n## install\n\n- step one\n")).toBeNull();
    expect(fromReadme("")).toBeNull();
  });
});

describe("pickLink", () => {
  test("prefers origin, then upstream, then whatever is left", () => {
    expect(
      pickLink([
        { name: "fork", url: "git@github.com:me/x.git" },
        { name: "origin", url: "https://github.com/them/x.git" },
      ]),
    ).toBe("https://github.com/them/x");
    expect(
      pickLink([
        { name: "fork", url: "git@github.com:me/x.git" },
        { name: "upstream", url: "https://gitlab.com/them/x" },
      ]),
    ).toBe("https://gitlab.com/them/x");
  });

  test("skips remotes with no web address, and gives up on none", () => {
    expect(
      pickLink([
        { name: "origin", url: "ssh://git@192.168.1.10:2222/eric/x.git" },
        { name: "gh", url: "git@github.com:eric/x.git" },
      ]),
    ).toBe("https://github.com/eric/x");
    expect(pickLink([])).toBeUndefined();
  });
});
