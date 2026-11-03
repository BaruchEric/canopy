import { expect, test } from "bun:test";
import type { LandEntry, PrWatch, Repo, RepoStatus, Run } from "../../src/core/types";
import { copyOf, copyableOfOrigin, copyableOfRepo, copyableOfRun } from "./kbcopy";

const status = (branch: string): RepoStatus => ({ branch }) as RepoStatus;

const repo = (over: Partial<Repo> = {}): Repo => ({ id: "/dev/canopy", name: "canopy", path: "/dev/canopy", group: "", source: "root", status: status("main"), ...over });

const run = (id: string, over: Partial<Run> = {}): Pick<Run, "id" | "branch" | "startedAt"> => ({ id, startedAt: 1, ...over });

const onBranch = (id: string, origin: string, startedAt = 1): Pick<Run, "id" | "branch" | "startedAt"> =>
  run(id, { startedAt, branch: { name: `run/${origin}-fix`, target: "main", base: "b0", dir: `/w/${origin}`, state: "ready", origin } });

const watch = (id: string, over: Partial<PrWatch> = {}): PrWatch =>
  ({ id, repoId: "/dev/canopy", branch: `run/${id}-fix`, runId: `r-${id}`, number: 7, url: `https://github.com/o/canopy/pull/${id}`, ...over }) as PrWatch;

const prs = [watch("a"), watch("b", { state: { status: "merged" } as PrWatch["state"] }), watch("c", { repoId: "/dev/other" })];

test("a card copies its checkout branch, its run's id, and the open PR on its branch first", () => {
  const r = repo({ status: status("run/a-fix") });
  expect(copyableOfRepo(r, run("x"), prs)).toEqual({ branch: "run/a-fix", pr: "https://github.com/o/canopy/pull/a", run: "x" });
});

test("a card off any PR's branch takes its run's PR, else the one open PR canopy watches on the repo", () => {
  const byRun = copyableOfRepo(repo(), onBranch("x", "a"), [...prs, watch("d")]);
  expect(byRun.pr).toBe("https://github.com/o/canopy/pull/a");
  // one open watch on this repo (b is merged, c is another repo's)
  expect(copyableOfRepo(repo(), undefined, prs).pr).toBe("https://github.com/o/canopy/pull/a");
  // two open: neither on the branch, no run to tell them apart
  expect(copyableOfRepo(repo(), undefined, [...prs, watch("d")]).pr).toBeNull();
});

test("a card with no watched PR falls back to its open pull requests page, and has none otherwise", () => {
  const pulls = { open: 2, url: "https://github.com/o/canopy/pulls" };
  expect(copyableOfRepo(repo({ pulls }), undefined, []).pr).toBe(pulls.url);
  expect(copyableOfRepo(repo({ pulls: { open: 0, url: pulls.url } }), undefined, []).pr).toBeNull();
  expect(copyableOfRepo(repo({ status: null }), undefined, [])).toEqual({ branch: null, pr: null, run: null });
});

test("a forge repo copies the forge's default branch", () => {
  const r = repo({ status: null, forge: { branch: "trunk" } as Repo["forge"] });
  expect(copyableOfRepo(r, undefined, []).branch).toBe("trunk");
});

test("a run copies its own branch and its PR, open or merged, else the checkout's branch", () => {
  expect(copyableOfRun(onBranch("r-b", "b"), prs)).toEqual({ branch: "run/b-fix", pr: "https://github.com/o/canopy/pull/b", run: "r-b" });
  expect(copyableOfRun(run("plain"), prs, "main")).toEqual({ branch: "main", pr: null, run: "plain" });
  expect(copyableOfRun(run("plain"), prs)).toEqual({ branch: null, pr: null, run: "plain" });
});

test("a branch id reads its watch first, then its landing record, then the newest run on it", () => {
  const entries: Pick<LandEntry, "id" | "branch">[] = [{ id: "e", branch: "run/e-fix" }];
  const runs = [onBranch("old", "z", 1), onBranch("new", "z", 2), run("other")];
  expect(copyableOfOrigin("a", prs, entries, runs)).toEqual({ branch: "run/a-fix", pr: "https://github.com/o/canopy/pull/a", run: "r-a" });
  expect(copyableOfOrigin("e", prs, entries, runs)).toEqual({ branch: "run/e-fix", pr: null, run: null });
  expect(copyableOfOrigin("z", prs, entries, runs)).toEqual({ branch: "run/z-fix", pr: null, run: "new" });
  expect(copyableOfOrigin("none", prs, entries, runs)).toEqual({ branch: null, pr: null, run: null });
});

test("copyOf names the part and gives its text, or null where the item has none", () => {
  const c = { branch: "main", pr: null, run: "r1" };
  expect(copyOf(c, "b")).toEqual({ name: "branch", text: "main" });
  expect(copyOf(c, "p")).toEqual({ name: "PR link", text: null });
  expect(copyOf(c, "r")).toEqual({ name: "run id", text: "r1" });
});
