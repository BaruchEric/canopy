import { describe, expect, test } from "bun:test";
import { asksHelp, HELP_TEXT, verbHelp } from "./help";

describe("asksHelp", () => {
  test("--help or -h anywhere among the words", () => {
    expect(asksHelp(["--help"])).toBe(true);
    expect(asksHelp(["-h"])).toBe(true);
    expect(asksHelp(["add", "some words", "--help"])).toBe(true);
  });
  test("a word that only mentions the flag, or no flag, is not a request", () => {
    expect(asksHelp(["add", "run it with --help"])).toBe(false);
    expect(asksHelp(["help"])).toBe(false);
    expect(asksHelp([])).toBe(false);
  });
  test("words after -- belong to another program", () => {
    expect(asksHelp(["repo", "--", "claude", "--help"])).toBe(false);
    expect(asksHelp(["-h", "--", "x"])).toBe(true);
  });
});

describe("verbHelp", () => {
  test("every line of the verb with the indented lines under it, and nothing else", () => {
    const note = verbHelp("note") ?? "";
    const lines = note.split("\n");
    expect(lines[0]).toBe("usage:");
    expect(lines.slice(1).every((l) => l.startsWith("  canopy note ") || /^ {3,}\S/.test(l))).toBe(true);
    expect(note).toContain('canopy note add "<text>"');
    expect(note).toContain("--at <time>");
    expect(note).toContain("--backend URL");
    expect(note).not.toContain("canopy clip");
  });
  test("lines of one verb far apart in the help all come back", () => {
    const health = verbHelp("health") ?? "";
    expect(health).toContain("canopy health show <id>");
    expect(health).toContain("canopy health lint [dir]");
    expect(health).not.toContain("canopy spec");
  });
  test("run's flag lines stay under run, and runs has its own", () => {
    const run = verbHelp("run") ?? "";
    expect(run).toContain("--priority interactive|normal|low");
    expect(run).toContain("--backend URL | --on NAME");
    expect(run).not.toContain("canopy runs child");
    const runs = verbHelp("runs") ?? "";
    expect(runs).toContain("canopy runs child <repo>");
    expect(runs).toContain("--backend URL | --on NAME");
    expect(runs).not.toContain("--priority");
  });
  test("another word for a command gets that command's lines", () => {
    expect(verbHelp("notes")).toBe(verbHelp("note"));
    expect(verbHelp("clips")).toBe(verbHelp("clip"));
    expect(verbHelp("sources")).toBe(verbHelp("source"));
    expect(verbHelp("tree")).toContain("canopy [dir]");
  });
  test("a verb the help does not list has none", () => {
    expect(verbHelp("nope")).toBeUndefined();
    expect(verbHelp("[dir]", "usage:\n  canopy [dir]   tree\n")).toBe("usage:\n  canopy [dir]   tree");
  });
  test("the help still has a line for clip, which once kept --help as a clip", () => {
    expect(HELP_TEXT).toContain("canopy help <command>, or --help after one");
    expect(verbHelp("clip")).toContain("canopy clip list");
  });
});
