import { describe, expect, test } from "bun:test";
import type { HealthCheck } from "../core/types";
import { changeLines, defLines, filterChecks, parseCheckArgs, showLines, starterFile, targetsOf } from "./health";

// colour codes off what the tests read, should a terminal turn them on
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const check = (id: string, state: HealthCheck["state"], over: Partial<HealthCheck> = {}): HealthCheck => ({
  id,
  label: id,
  scope: { kind: "canopy" },
  state,
  why: null,
  since: 0,
  lastOk: null,
  heal: "none",
  fails: 0,
  nextHeal: null,
  button: false,
  history: [],
  ...over,
});

describe("parseCheckArgs", () => {
  test("each kind from its flag, with the shared ones", () => {
    expect(parseCheckArgs("site", ["--http", "http://127.0.0.1:3000/", "--expect", "204"])).toEqual({ name: "site", kind: "http", url: "http://127.0.0.1:3000/", expect: 204 });
    expect(parseCheckArgs("db", ["--port", "5432", "--host", "db.local", "--heal", "none"])).toEqual({ name: "db", kind: "port", port: 5432, host: "db.local", heal: "none" });
    expect(parseCheckArgs("dev", ["--task", "dev", "--heal", "auto", "--every", "10"])).toEqual({ name: "dev", kind: "task", task: "dev", heal: "auto", every: 10 });
    expect(parseCheckArgs("pg", ["--compose", "postgres", "--file", "c.yml", "--fix", "make up"])).toEqual({ name: "pg", kind: "compose", service: "postgres", file: "c.yml", fix: "make up" });
    expect(parseCheckArgs("smoke", ["--command", "bun run smoke"])).toEqual({ name: "smoke", kind: "command", run: "bun run smoke" });
    expect(parseCheckArgs("site", ["--http", "http://a/", "--while", "dev"])).toEqual({ name: "site", kind: "http", url: "http://a/", while: "dev" });
  });

  test("exactly one kind, every flag understood, and the server's rules", () => {
    expect(parseCheckArgs("x", [])).toContain("name one kind");
    expect(parseCheckArgs("x", ["--port", "1", "--task", "dev"])).toContain("name one kind");
    expect(parseCheckArgs("x", ["--port"])).toContain("needs a value");
    expect(parseCheckArgs("x", ["--port", "1", "--nope"])).toContain("not understood");
    expect(parseCheckArgs("x", ["--port", "70000"])).toContain("1 to 65535");
    expect(parseCheckArgs("x", ["--http", "ftp://a"])).toContain("http(s) url");
    expect(parseCheckArgs("Bad Name", ["--port", "1"])).toContain("bad check name");
  });
});

describe("filterChecks", () => {
  const list = [check("canopy:a", "ok"), check("repo:app:site", "down", { scope: { kind: "repo", repoId: "app" } }), check("repo:web:dev", "ok", { scope: { kind: "repo", repoId: "web" } })];
  test("by bad, by repo, by canopy", () => {
    expect(filterChecks(list, { bad: true }).map((c) => c.id)).toEqual(["repo:app:site"]);
    expect(filterChecks(list, { repo: "web" }).map((c) => c.id)).toEqual(["repo:web:dev"]);
    expect(filterChecks(list, { canopy: true }).map((c) => c.id)).toEqual(["canopy:a"]);
    expect(filterChecks(list, {})).toHaveLength(3);
  });
});

test("showLines tells how it heals and what it has been through, newest first", () => {
  const c = check("repo:app:dev", "healing", { why: "exited 1", heal: "auto", button: true, fails: 2, nextHeal: 9_000, history: [{ at: 1, state: "ok", why: null }, { at: 2, state: "healing", why: "exited 1" }] });
  const lines = showLines(c, 4_000).map(plain);
  expect(lines[0]).toBe("repo:app:dev  healing  exited 1");
  expect(lines).toContain("heals      auto, and by hand (canopy health heal)");
  expect(lines).toContain("fails      2 heals that did not hold");
  expect(lines).toContain("next heal  in 5s");
  const hist = lines.slice(lines.indexOf("history") + 1);
  expect(hist[0]).toContain("healing");
  expect(hist[1]).toContain("ok");
});

test("defLines says where each check is from and why one does not run", () => {
  const lines = defLines({
    checks: [
      { name: "site", kind: "http", url: "http://a/", source: "canopy" },
      { name: "smoke", kind: "command", run: "true", source: "repo", blocked: "not run: not your repo" },
    ],
    errors: ["x: kind is one of http"],
  }).map(plain);
  expect(lines[0]).toContain("from canopy's config");
  expect(lines[0]).toContain("heal none");
  expect(lines[1]).toContain("heal none");
  expect(lines[1]).toContain("not run: not your repo");
  expect(lines[2]).toBe("x: kind is one of http");
  expect(defLines({ checks: [], errors: [] }).map(plain)[0]).toContain("no checks");
});

test("changeLines prints only what moved, and what left", () => {
  const before = new Map([
    ["a", check("a", "ok")],
    ["b", check("b", "ok")],
    ["c", check("c", "ok")],
  ]);
  const lines = changeLines(before, [check("a", "ok"), check("b", "down", { why: "nothing listening" }), check("d", "ok")]).map(plain);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain("down");
  expect(lines[1]).toContain("d");
  expect(lines[2]).toContain("gone");
});

test("starterFile checks the dev task when there is one", () => {
  expect(JSON.parse(starterFile({ pkg: JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }) }))).toEqual({ checks: [{ name: "dev", kind: "task", task: "dev", heal: "auto" }] });
  expect(JSON.parse(starterFile({ repoFile: JSON.stringify([{ name: "dev", cmd: "make run" }]) })).checks).toHaveLength(1);
  expect(JSON.parse(starterFile({}))).toEqual({ checks: [] });
});

test("targetsOf puts home first at its own address, then each other backend by tailnet, then public", () => {
  const ts = targetsOf("http://127.0.0.1:7850", "mac", [
    { name: "mac", public: "https://canopy-mac.example", tailnet: "https://mac.ts:7850" },
    { name: "mini", public: "https://canopy.example", tailnet: "https://mini.ts:7849" },
    { name: "gpd" },
  ]);
  expect(ts).toEqual([
    { name: "mac", urls: ["http://127.0.0.1:7850"] },
    { name: "mini", urls: ["https://mini.ts:7849", "https://canopy.example"] },
  ]);
});
