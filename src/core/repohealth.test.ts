import { describe, expect, test } from "bun:test";
import { checkTarget, healOf, mergeChecks, normalizeCheck, normalizeChecks, parseHealthFile, repoCheckId } from "./repohealth";
import type { RepoCheckDef } from "./types";

describe("normalizeCheck", () => {
  test("each kind with what it needs", () => {
    expect(normalizeCheck({ name: "site", kind: "http", url: "http://127.0.0.1:5173/", expect: 200 })).toEqual({ name: "site", kind: "http", url: "http://127.0.0.1:5173/", expect: 200 });
    expect(normalizeCheck({ name: "api", kind: "port", port: 7850 })).toEqual({ name: "api", kind: "port", port: 7850 });
    expect(normalizeCheck({ name: "dev", kind: "task", task: "dev", heal: "auto" })).toEqual({ name: "dev", kind: "task", task: "dev", heal: "auto" });
    expect(normalizeCheck({ name: "db", kind: "compose", service: "postgres", file: "compose.yml" })).toEqual({ name: "db", kind: "compose", service: "postgres", file: "compose.yml" });
    expect(normalizeCheck({ name: "smoke", kind: "command", run: "bun run smoke", every: 300 })).toEqual({ name: "smoke", kind: "command", run: "bun run smoke", every: 300 });
  });

  test("refuses what it cannot run", () => {
    expect(normalizeCheck({ name: "Bad Name", kind: "port", port: 1 })).toContain("bad check name");
    expect(normalizeCheck({ name: "x", kind: "ftp" })).toContain("kind is one of");
    expect(normalizeCheck({ name: "x", kind: "http", url: "file:///etc/passwd" })).toContain("http(s) url");
    expect(normalizeCheck({ name: "x", kind: "http", url: "http://a", expect: 42 })).toContain("expect");
    expect(normalizeCheck({ name: "x", kind: "port", port: 70000 })).toContain("1 to 65535");
    expect(normalizeCheck({ name: "x", kind: "task" })).toContain("task's name");
    expect(normalizeCheck({ name: "x", kind: "compose", service: "a b" })).toContain("service");
    expect(normalizeCheck({ name: "x", kind: "command", run: "  " })).toContain("needs run");
    expect(normalizeCheck({ name: "x", kind: "port", port: 1, heal: "sometimes" })).toContain("heal is");
    expect(normalizeCheck([1])).toContain("object");
  });

  test("every is at least five seconds", () => {
    expect(normalizeCheck({ name: "x", kind: "port", port: 1, every: 1 })).toMatchObject({ every: 5 });
  });
});

describe("normalizeChecks and parseHealthFile", () => {
  test("keeps the good, names the bad and the twice-named", () => {
    const { checks, errors } = normalizeChecks([
      { name: "a", kind: "port", port: 1 },
      { name: "a", kind: "port", port: 2 },
      { name: "b", kind: "nope" },
    ]);
    expect(checks.map((c) => c.name)).toEqual(["a"]);
    expect(errors).toHaveLength(2);
  });
  test("a file that is not JSON, or not the shape", () => {
    expect(parseHealthFile("{").errors[0]).toContain("not JSON");
    expect(parseHealthFile("[]").errors[0]).toContain("checks list");
    expect(parseHealthFile('{"checks":[{"name":"a","kind":"port","port":80}]}').checks).toHaveLength(1);
    expect(parseHealthFile("{}")).toEqual({ checks: [], errors: [] });
  });
});

describe("mergeChecks", () => {
  const own = { own: true, local: true, seed: false };
  const clone = { own: false, local: true, seed: false };
  const remote = { own: true, local: false, seed: false };
  const seed = { own: false, local: true, seed: true };
  const http: RepoCheckDef = { name: "site", kind: "http", url: "http://example.com/" };
  const cmd: RepoCheckDef = { name: "smoke", kind: "command", run: "touch /tmp/x" };
  const task: RepoCheckDef = { name: "dev", kind: "task", task: "dev", heal: "auto" };
  const fixed: RepoCheckDef = { name: "api", kind: "port", port: 9, fix: "make up" };

  test("canopy's layer replaces the repo's by name, keeping the repo's order", () => {
    const merged = mergeChecks([http, cmd], [{ name: "site", kind: "port", port: 80 }, task], own);
    expect(merged.map((c) => `${c.name}:${c.kind}:${c.source}`)).toEqual(["site:port:canopy", "smoke:command:repo", "dev:task:canopy"]);
  });

  test("an own local repo runs everything", () => {
    expect(mergeChecks([http, cmd, task, fixed], [], own).every((c) => !c.blocked)).toBe(true);
    expect(healOf(mergeChecks([task], [], own)[0]!)).toBe("auto");
  });

  test("a clone's file runs no code here, and its auto is a button", () => {
    const merged = mergeChecks([http, cmd, task, fixed], [], clone);
    expect(merged.find((c) => c.name === "site")?.blocked).toBeUndefined();
    expect(merged.find((c) => c.name === "smoke")?.blocked).toBe("not run: not your repo");
    expect(merged.find((c) => c.name === "api")?.blocked).toBe("not run: not your repo");
    expect(merged.find((c) => c.name === "dev")?.blocked).toBeUndefined();
    expect(merged.find((c) => c.name === "dev")?.heal).toBe("button");
  });

  test("canopy's own layer may say auto, and run code, on a clone: the user wrote it here", () => {
    expect(mergeChecks([], [task], clone)[0]?.heal).toBe("auto");
    expect(mergeChecks([], [cmd, fixed], clone).every((c) => !c.blocked)).toBe(true);
  });

  test("a repo on another host gets only what reaches out", () => {
    const merged = mergeChecks([http, cmd, task], [], remote);
    expect(merged.map((c) => Boolean(c.blocked))).toEqual([false, true, true]);
  });

  test("on another host a loopback target is this machine, so it does not run", () => {
    const merged = mergeChecks([{ name: "dev", kind: "http", url: "http://localhost:5173/" }, { name: "db", kind: "port", port: 5432 }, { name: "pub", kind: "http", url: "https://example.com/" }], [], remote);
    expect(merged.map((c) => c.blocked)).toEqual(["localhost is this machine, not where the repo lives", "127.0.0.1 is this machine, not where the repo lives", undefined]);
    expect(mergeChecks([{ name: "db", kind: "port", port: 5432 }], [], own)[0]?.blocked).toBeUndefined();
  });

  test("a seed runs none of its own", () => {
    expect(mergeChecks([task, cmd], [], seed).every((c) => c.blocked === "seeds run no checks of their own")).toBe(true);
    expect(healOf(mergeChecks([task], [], seed)[0]!)).toBe("none");
  });
});

test("ids and targets", () => {
  expect(repoCheckId("web/app", "site")).toBe("repo:web/app:site");
  expect(checkTarget({ name: "a", kind: "port", port: 80 })).toBe("127.0.0.1:80");
  expect(checkTarget({ name: "a", kind: "task", task: "dev" })).toBe("task dev");
});
