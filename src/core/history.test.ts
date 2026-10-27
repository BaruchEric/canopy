import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyOverview, localDays, localMidnightIso } from "./history";
import type { Repo } from "./types";

describe("localDays", () => {
  test("ends today and walks back across a month boundary", () => {
    const days = localDays(5, new Date(2026, 8, 2, 15, 30));
    expect(days).toEqual([
      "2026-08-29",
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });
});

describe("localMidnightIso", () => {
  test("is midnight on the local clock, so it round-trips through a Date", () => {
    const iso = localMidnightIso("2026-08-24");
    const d = new Date(iso);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 7, 24, 0]);
  });
});

describe("historyOverview", () => {
  test("covers the requested days and asks the CLI from the first one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-history-"));
    const bin = join(dir, "claude-history");
    const project = JSON.stringify({
      id: "p1",
      name: "x",
      path: dir,
      sessions: 1,
      tokens: 1,
      cost: 1,
      first: null,
      last: null,
      commits: 0,
    });
    const activity = JSON.stringify([{ project: "p1", day: "2026-07-29", sessions: 1, cost: 1.5 }]);
    await writeFile(
      bin,
      `#!/bin/sh\ncase "$1" in\n  projects) printf '%s\\n' '[${project}]' ;;\n  activity) echo "$3" > "${dir}/since"; printf '%s\\n' '${activity}' ;;\nesac\n`,
      { mode: 0o755 },
    );
    const repos: Repo[] = [{ id: "x", name: "x", path: dir, group: "", source: "root", status: null }];
    const now = new Date(2026, 9, 26);
    try {
      const wide = await historyOverview(bin, repos, now, 90);
      if (!wide.available) throw new Error(wide.reason);
      expect([wide.days.length, wide.days[0], wide.repos["x"]?.days[0]]).toEqual([90, "2026-07-29", 1.5]);
      expect((await readFile(join(dir, "since"), "utf8")).trim()).toBe(localMidnightIso("2026-07-29"));
      const narrow = await historyOverview(bin, repos, now);
      if (!narrow.available) throw new Error(narrow.reason);
      expect([narrow.days.length, narrow.repos["x"]?.days.reduce((sum, amount) => sum + amount, 0)]).toEqual([30, 0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
