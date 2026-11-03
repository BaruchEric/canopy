import { describe, expect, test } from "bun:test";
import type { Repo } from "./types";
import { driftLines, glyphSeg, lineText, specLines, summarySegs, treeLines } from "./treelines";

const repo = (id: string, over: Partial<Repo> = {}): Repo =>
  ({
    id,
    name: id.split("/").pop() ?? id,
    group: id.includes("/") ? id.split("/")[0] : id,
    path: `/r/${id}`,
    status: { branch: "main", files: [], ahead: 0, behind: 0 },
    ...over,
  }) as unknown as Repo;

/** a repo whose status has `n` changed files and the given counts */
const at = (n: number, ahead: number, behind: number): Repo =>
  ({ ...repo("a"), status: { branch: "m", files: changed(n), ahead, behind } }) as unknown as Repo;

const changed = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `f${i}`, conflicted: false }));

describe("treelines", () => {
  test("glyphs follow the CLI's order: error, conflict, changes, ahead, clean", () => {
    expect(glyphSeg(repo("a", { error: "x" }))).toEqual({ text: "✗", tone: "rust" });
    expect(glyphSeg(at(2, 1, 0)).text).toBe("●");
    expect(glyphSeg(at(0, 1, 0)).text).toBe("◐");
    expect(glyphSeg(repo("a")).text).toBe("○");
  });

  test("a summary is its parts joined by single spaces", () => {
    const r = at(3, 2, 1);
    expect(summarySegs(r).map((s) => s.text).join("")).toBe("3 changed ↑2 ↓1");
    expect(summarySegs(repo("a")).map((s) => s.text).join("")).toBe("clean");
  });

  test("the tree groups repos and links each name to its repo", () => {
    const lines = treeLines("/root", [repo("web/app"), repo("web/site"), repo("tool")]);
    expect(lines.map(lineText).map((l) => l.trimEnd())).toEqual([
      "/root",
      "├─ ○ tool main clean",
      "└─ web",
      "   ├─ ○ app  main clean",
      "   └─ ○ site main clean",
    ]);
    expect(lines[3]?.find((s) => s.repo)?.repo).toBe("web/app");
  });

  test("status keeps only the repos that need attention", () => {
    const lines = treeLines("/root", [repo("a"), repo("b", { error: "boom" })], { dirtyOnly: true });
    expect(lines.map(lineText).join("\n")).toContain("b");
    expect(lines.some((l) => l.some((s) => s.repo === "a"))).toBe(false);
    expect(lineText(treeLines("/root", [repo("a")], { dirtyOnly: true })[1] ?? [])).toBe("everything is clean and pushed");
  });

  test("spec lines skip repos the scan read no spec of", () => {
    const lines = specLines(3, [repo("a", { spec: "drifted" }), repo("b")]);
    expect(lines.map(lineText)).toEqual(["shared repo spec v3", `${"drifted".padEnd(18)} a`]);
    expect(lines[1]?.[0]?.tone).toBe("rust");
  });
});

describe("driftLines", () => {
  const NOW = Date.parse("2026-11-02T12:00:00Z");
  const row = (repoId: string, summary: string, status: "ready" | "merged" | "no-fix", hoursAgo: number) => ({
    event: { id: repoId, rule: "w", source: "schedule", service: "schedule", key: "k", title: "t", note: "", repoId, workflow: "spec-converge", status, count: 1, firstAt: NOW - hoursAgo * 3_600_000, lastAt: NOW } as const,
    report: { drift: summary === "none" ? 0 : Number(summary), lines: summary === "none" ? [] : ["- stack: x"] },
  });
  test("stale first, then fixed, the clean ones only with all, items indented and dim", () => {
    const rows = [row("b/clean", "none", "no-fix", 1), row("a/fixed", "1", "merged", 30), row("c/stale", "2", "ready", 2)];
    const lines = driftLines(rows, NOW);
    expect(lines.map(lineText)).toEqual([`${"stale".padEnd(18)} c/stale  drift: 2, fix waiting to land  checked 2h ago`, "    - stack: x", `${"fixed".padEnd(18)} a/fixed  drift: 1, fix landed  checked 1d ago`, "    - stack: x"]);
    expect(lines[0]?.[0]?.tone).toBe("rust");
    expect(lines[0]?.[2]).toEqual({ text: "c/stale", repo: "c/stale" });
    expect(lines[1]?.[0]?.tone).toBe("dim");
    expect(lines[2]?.[0]?.tone).toBe("moss");
    expect(driftLines(rows, NOW, true).map(lineText)).toContain(`${"no drift".padEnd(18)} b/clean  drift: none  checked 1h ago`);
    expect(lineText(driftLines([rows[0]!], NOW, true, "mini")[0] ?? [])).toContain("b/clean on mini  drift");
  });
});
