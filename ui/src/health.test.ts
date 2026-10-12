import { describe, expect, test } from "bun:test";
import type { HealthCheck } from "../../src/core/types";
import { badRepoIds, groupRows, healthRows, healthSummary, repoChecks, repoWord } from "./health";

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

const online = { status: { state: "online" } };

describe("healthRows", () => {
  test("every online backend's checks, in order", () => {
    const rows = healthRows({ mac: [check("a", "ok")], mini: [check("b", "down")] }, ["mini", "mac"], { mac: online, mini: online }, 0);
    expect(rows.map((r) => `${r.backend}:${r.check.id}`)).toEqual(["mini:b", "mac:a"]);
  });

  test("a backend the page cannot reach is one row saying so", () => {
    const rows = healthRows({ mini: [check("b", "ok")] }, ["mini"], { mini: { status: { state: "offline", reason: "timed out" } } }, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.check).toMatchObject({ id: "backend", state: "down", why: "offline: timed out" });
  });

  test("a backend still connecting is checking, not down", () => {
    const rows = healthRows({}, ["mini"], {}, 0);
    expect(rows[0]?.check.state).toBe("unknown");
  });
});

describe("groupRows", () => {
  test("canopy's pieces and each repo, the bad first", () => {
    const rows = healthRows(
      {
        mac: [
          check("canopy:b", "ok", { label: "b" }),
          check("canopy:a", "down", { label: "z" }),
          check("repo:app:site", "ok", { label: "site", scope: { kind: "repo", repoId: "app" } }),
        ],
      },
      ["mac"],
      { mac: online },
      0,
    );
    const groups = groupRows(rows, false, (_b, id) => `repo ${id}`);
    expect(groups.map((g) => g.title)).toEqual(["canopy", "repo app"]);
    expect(groups[0]?.rows.map((r) => r.check.label)).toEqual(["z", "b"]);
    expect(groups[1]?.repoId).toBe("app");
  });

  test("with several backends a group names its backend", () => {
    const rows = healthRows({ mac: [check("a", "ok")], mini: [check("a", "ok")] }, ["mac", "mini"], { mac: online, mini: online }, 0);
    expect(groupRows(rows, true).map((g) => g.title)).toEqual(["mac · canopy", "mini · canopy"]);
  });
});

test("healthSummary counts an offline backend as down", () => {
  const rows = healthRows({}, ["mini"], { mini: { status: { state: "offline" } } }, 0);
  expect(healthSummary(rows, 0).level).toBe("bad");
});

describe("repo checks on a card", () => {
  const repoCheck = (name: string, state: HealthCheck["state"], over: Partial<HealthCheck> = {}) =>
    check(`repo:app:${name}`, state, { label: name, scope: { kind: "repo", repoId: "app" }, ...over });

  test("one check speaks for itself", () => {
    expect(repoWord([repoCheck("site", "ok", { detail: "200 in 42ms" })], 0)).toMatchObject({ text: "up · 42ms", tone: "moss" });
    expect(repoWord([repoCheck("site", "down", { since: 0 })], 180_000)).toMatchObject({ text: "down 3m", tone: "rust" });
    expect(repoWord([repoCheck("site", "healing")], 0)).toMatchObject({ text: "healing", tone: "lichen" });
  });

  test("several count, the bad first", () => {
    expect(repoWord([repoCheck("a", "ok"), repoCheck("b", "ok"), repoCheck("c", "healing")], 0)).toMatchObject({ text: "2 of 3 up", tone: "lichen" });
    expect(repoWord([repoCheck("a", "ok"), repoCheck("b", "gave-up")], 0)).toMatchObject({ text: "1 of 2 down", tone: "rust" });
    expect(repoWord([repoCheck("a", "ok"), repoCheck("b", "ok")], 0)).toMatchObject({ text: "2 up", tone: "moss" });
  });

  test("a check that does not run here says nothing on the card", () => {
    expect(repoWord([repoCheck("smoke", "off")], 0)).toBeNull();
    expect(repoWord([], 0)).toBeNull();
  });

  test("repoChecks and badRepoIds read every backend", () => {
    const health = { mac: [repoCheck("a", "down"), check("canopy:x", "down")], mini: [check("repo:mini:web:b", "ok", { scope: { kind: "repo", repoId: "mini:web" } })] };
    expect(repoChecks(health, "app").map((c) => c.label)).toEqual(["a"]);
    expect([...badRepoIds(health)]).toEqual(["app"]);
  });
});
