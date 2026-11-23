import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../core/exec";
import { frRef } from "../core/fr";
import { frCheck, frHolderHere, frList, frNextHere, frReserve, frRoot, parseFrArgs } from "./fr";

// Real git throughout: a bare origin, two clones of it standing for two
// machines, and a second worktree of the first clone. The suite runs on
// macOS and Linux, so only flags both gits take.
let scratch = "";
let origin = "";
let mac = "";
let mini = "";
let tree = "";

const git = async (cwd: string, ...args: string[]) => {
  const r = await exec(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const list = (highest: number) => `# Feature requests: shop\n\n## Open\n\n### FR-${String(highest).padStart(3, "0")} · The newest\n\n## In Progress\n\n## Shipped\n\n## Declined\n`;
const holder = (by: string) => ({ title: `what ${by} builds`, by, branch: "main", backend: "" });

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "canopy-fr-")));
  origin = join(scratch, "origin.git");
  mac = join(scratch, "mac");
  mini = join(scratch, "mini");
  tree = join(scratch, "mac-tree");
  await git(scratch, "init", "-q", "--bare", "-b", "main", origin);
  await git(scratch, "clone", "-q", origin, mac);
  writeFileSync(join(mac, "FEATURES.md"), list(5));
  await git(mac, "add", "-A");
  await git(mac, "commit", "-qm", "the list");
  await git(mac, "push", "-q", "origin", "HEAD:main");
  await git(scratch, "clone", "-q", origin, mini);
  await git(mac, "worktree", "add", "-q", "-b", "side", tree);
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("the command's words", () => {
  test("list is the default, and each word takes only its own flags", () => {
    expect(parseFrArgs([])).toEqual({ dir: null, json: false, act: "list", all: false });
    expect(parseFrArgs(["--all", "--json", "-C", "/repo"])).toEqual({ dir: "/repo", json: true, act: "list", all: true });
    expect(parseFrArgs(["reserve", "-m", "A cart"])).toEqual({ dir: null, json: false, act: "reserve", title: "A cart" });
    expect(parseFrArgs(["next"])).toMatchObject({ act: "next" });
    expect(parseFrArgs(["check"])).toMatchObject({ act: "check" });
    for (const bad of [["next", "-m", "x"], ["reserve", "--all"], ["take"], ["reserve", "extra"]]) expect(typeof parseFrArgs(bad)).toBe("string");
  });

  test("a folder outside git is refused, and one inside names its root", async () => {
    expect(frRoot(scratch)).rejects.toThrow("not in a git repository");
    mkdirSync(join(mac, "src"), { recursive: true });
    expect(await frRoot(join(mac, "src"))).toBe(mac);
  });

  test("who holds a reservation comes from the session, then the person", async () => {
    expect(await frHolderHere(mac, "A cart", { TAILCHAN_AS: "canopy-3d13", CLAUDE_CODE_SESSION_ID: "f0351fe1-bc47", CANOPY_BACKEND: "mac" })).toEqual({ title: "A cart", by: "canopy-3d13", branch: "main", backend: "mac" });
    expect((await frHolderHere(mac, "", { CLAUDE_CODE_SESSION_ID: "f0351fe1-bc47" })).by).toBe("claude-f0351f");
    expect((await frHolderHere(mac, "", { CODEX_THREAD_ID: "9f8e7d6c5b" })).by).toBe("codex-9f8e7d");
    expect((await frHolderHere(tree, "", { USER: "eric" })).by).toBe("eric");
    expect((await frHolderHere(tree, "", {})).branch).toBe("side");
  });
});

describe("reserving a number", () => {
  test("takes the one after the list's highest and shares it through origin", async () => {
    expect(await frNextHere(mac)).toBe(6);
    const got = await frReserve(mac, holder("claude-aaaaaa"));
    expect(got).toEqual({ n: 6, id: "FR-006", ref: "refs/canopy/fr/006", shared: true, note: null });
    expect(await git(origin, "for-each-ref", "--format=%(refname)", "refs/canopy/fr")).toBe("refs/canopy/fr/006");
    // looking takes nothing
    expect(await frNextHere(mac)).toBe(7);
    expect(await frNextHere(mac)).toBe(7);
  });

  test("another machine gets the number after, having never seen the first's worktree", async () => {
    const got = await frReserve(mini, holder("claude-bbbbbb"));
    expect(got).toMatchObject({ id: "FR-007", shared: true });
    const all = await frList(mini);
    expect(all.map((r) => [r.id, r.holder.by, r.where, r.listed])).toEqual([
      ["FR-006", "claude-aaaaaa", "shared", false],
      ["FR-007", "claude-bbbbbb", "shared", false],
    ]);
  });

  test("an entry written in another worktree and not yet committed counts", async () => {
    writeFileSync(join(tree, "FEATURES.md"), list(30));
    expect(await frReserve(mac, holder("claude-aaaaaa"))).toMatchObject({ id: "FR-031" });
    // and so does one committed on a branch with no worktree here
    await git(tree, "add", "-A");
    await git(tree, "commit", "-qm", "an entry on a side branch");
    writeFileSync(join(tree, "FEATURES.md"), list(40));
    await git(tree, "commit", "-qam", "a later one");
    await git(mac, "branch", "-q", "parked", "side");
    writeFileSync(join(tree, "FEATURES.md"), list(5));
    await git(tree, "commit", "-qam", "taken back on side");
    expect(await frNextHere(mac)).toBe(41);
  });

  test("sessions that ask at the same moment, in one repo and across machines, all get their own", async () => {
    const got = await Promise.all([
      frReserve(mac, holder("s1")),
      frReserve(tree, holder("s2")),
      frReserve(mac, holder("s3")),
      frReserve(mini, holder("s4")),
      frReserve(mini, holder("s5")),
      frReserve(tree, holder("s6")),
    ]);
    const numbers = got.map((g) => g.n);
    expect(new Set(numbers).size).toBe(6);
    // the first clone counts its own unpushed branch (FR-040); the second
    // cannot see that branch and counts from the reservations (FR-031)
    for (const i of [0, 1, 2, 5]) expect(got[i]?.n).toBeGreaterThan(40);
    for (const i of [3, 4]) expect(got[i]?.n).toBeGreaterThan(31);
    expect(got.every((g) => g.shared)).toBe(true);
    // each machine ends up knowing all six
    for (const repo of [mac, mini]) {
      const held = (await frList(repo)).map((r) => r.n);
      for (const n of numbers) expect(held).toContain(n);
    }
  }, 120_000);

  test("a number whose entry reached the default branch says so", async () => {
    await git(mini, "pull", "-q", "origin", "main");
    writeFileSync(join(mini, "FEATURES.md"), list(7));
    await git(mini, "commit", "-qam", "FR-007 ships");
    await git(mini, "push", "-q", "origin", "HEAD:main");
    const all = await frList(mac);
    expect(all.find((r) => r.n === 7)?.listed).toBe(true);
    expect(all.find((r) => r.n === 6)?.listed).toBe(false);
  });
});

describe("with origin away", () => {
  test("a reservation stands on this machine, says so, and is shared once origin is back", async () => {
    const url = await git(mini, "remote", "get-url", "origin");
    await git(mini, "remote", "set-url", "origin", join(scratch, "gone.git"));
    const got = await frReserve(mini, holder("offline"));
    expect(got.shared).toBe(false);
    expect(got.note).toContain("did not answer");
    expect(await git(origin, "for-each-ref", "--format=%(refname)", frRef(got.n))).toBe("");
    await git(mini, "remote", "set-url", "origin", url);
    expect((await frList(mini)).find((r) => r.n === got.n)?.where).toBe("shared");
    expect(await git(origin, "for-each-ref", "--format=%(refname)", frRef(got.n))).toBe(frRef(got.n));
  });

  test("a number origin gave to someone else in the meantime reads as a clash, and neither is replaced", async () => {
    const url = await git(mini, "remote", "get-url", "origin");
    await git(mini, "remote", "set-url", "origin", join(scratch, "gone.git"));
    const offline = await frReserve(mini, holder("offline"));
    const online = await frReserve(mac, holder("online"));
    expect(online.n).toBe(offline.n);
    await git(mini, "remote", "set-url", "origin", url);
    const mine = (await frList(mini)).find((r) => r.n === offline.n);
    expect(mine).toMatchObject({ where: "clash", holder: { by: "offline" } });
    expect((await frList(mac)).find((r) => r.n === online.n)).toMatchObject({ where: "shared", holder: { by: "online" } });
    // the next one here is past both
    expect((await frReserve(mini, holder("offline"))).n).toBe(offline.n + 1);
  });

  test("a repo with no origin reserves for itself", async () => {
    const alone = join(scratch, "alone");
    await git(scratch, "init", "-q", "-b", "main", alone);
    const first = await frReserve(alone, holder("solo"));
    expect(first).toMatchObject({ id: "FR-001", shared: false });
    expect(first.note).toContain("no origin");
    expect((await frReserve(alone, holder("solo"))).id).toBe("FR-002");
    expect((await frList(alone)).map((r) => r.where)).toEqual(["here", "here"]);
  });
});

describe("the check", () => {
  test("names a number two entries share, and passes a list without one or no list", () => {
    expect(frCheck(mac)).toEqual([]);
    const twice = join(scratch, "twice");
    mkdirSync(twice);
    expect(frCheck(twice)).toEqual([]);
    writeFileSync(join(twice, "FEATURES.md"), `${list(5)}\n### FR-005 · The same number again\n`);
    expect(frCheck(twice)).toEqual([5]);
  });
});
