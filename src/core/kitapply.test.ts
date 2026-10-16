import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyKit, nextPlaced } from "./kitapply";
import type { KitSeen } from "./types";
import { exec } from "./exec";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function scratch(): { h: string; seen: KitSeen } {
  const h = mkdtempSync(join(tmpdir(), "kitapply-"));
  dirs.push(h);
  mkdirSync(join(h, ".claude/skills/ship"), { recursive: true });
  mkdirSync(join(h, ".codex/skills"), { recursive: true });
  mkdirSync(join(h, ".hermes"), { recursive: true });
  const seen: KitSeen = {
    machine: "mac", at: 1, away: null, home: h,
    store: { tracked: ["ship"], branch: "main", ahead: 0, behind: 0, dirty: 0, fetchFailed: false },
    targets: [
      { agent: "claude", dir: join(h, ".claude/skills"), exists: true, parentExists: true, entries: [], placed: {} },
      { agent: "codex", dir: join(h, ".codex/skills"), exists: true, parentExists: true, entries: [], placed: { old: "../../.claude/skills/old" } },
      { agent: "hermes", dir: join(h, ".hermes/skills"), exists: false, parentExists: true, entries: [], placed: {} },
    ],
    sources: {},
  };
  return { h, seen };
}

describe("applyKit on a scratch home", () => {
  test("mkdir, link, relink and remove, and the placed files follow", async () => {
    const { h, seen } = scratch();
    symlinkSync("../../.claude/skills/old", join(h, ".codex/skills/old"));
    const r = await applyKit(seen, null, [
      { kind: "link", agent: "codex", name: "ship", link: "../../.claude/skills/ship" },
      { kind: "remove", agent: "codex", name: "old" },
      { kind: "mkdir", agent: "hermes" },
      { kind: "link", agent: "hermes", name: "ship", link: "../../.claude/skills/ship" },
    ]);
    expect(r.failed).toEqual([]);
    expect(readlinkSync(join(h, ".codex/skills/ship"))).toBe("../../.claude/skills/ship");
    expect(existsSync(join(h, ".codex/skills/ship/."))).toBe(true);
    expect(existsSync(join(h, ".codex/skills/old"))).toBe(false);
    expect(lstatSync(join(h, ".hermes/skills/ship")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(h, ".codex/skills/.canopy-kit.json"), "utf8"))).toEqual({ placed: { ship: "../../.claude/skills/ship" } });
    expect(JSON.parse(readFileSync(join(h, ".hermes/skills/.canopy-kit.json"), "utf8"))).toEqual({ placed: { ship: "../../.claude/skills/ship" } });
  });
  test("never touches a real folder: link onto it and remove of it both fail (review focus 1 and 4)", async () => {
    const { h, seen } = scratch();
    mkdirSync(join(h, ".codex/skills/ship"));
    mkdirSync(join(h, ".codex/skills/old"));
    const r = await applyKit(seen, null, [
      { kind: "link", agent: "codex", name: "ship", link: "../../.claude/skills/ship" },
      { kind: "relink", agent: "codex", name: "ship", link: "../../.claude/skills/ship" },
      { kind: "remove", agent: "codex", name: "old" },
    ]);
    expect(r.done).toEqual([]);
    expect(r.failed.map((f) => f.why)).toEqual(["exists", "not a link", "not a link"]);
    expect(lstatSync(join(h, ".codex/skills/ship")).isDirectory()).toBe(true);
    expect(lstatSync(join(h, ".codex/skills/old")).isDirectory()).toBe(true);
  });
  test("pull: fast-forwards over unrelated local edits, and names git's refusal on an overlap (review focus 3)", async () => {
    const { h, seen } = scratch();
    const origin = join(h, "o.git");
    const store = join(h, ".claude");
    const other = join(h, "other");
    const g = (dir: string, ...a: string[]) => exec(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
    await exec(["git", "init", "-q", "--bare", "-b", "main", origin]);
    await exec(["git", "clone", "-q", origin, other]);
    await Bun.write(join(other, "a.md"), "1"); await Bun.write(join(other, "b.md"), "1");
    await g(other, "add", "."); await g(other, "commit", "-qm", "one"); await g(other, "push", "-q", "origin", "HEAD:main");
    rmSync(store, { recursive: true, force: true });
    await exec(["git", "clone", "-q", origin, store]);
    await Bun.write(join(other, "a.md"), "2");
    await g(other, "commit", "-qam", "two"); await g(other, "push", "-q", "origin", "HEAD:main");
    await Bun.write(join(store, "b.md"), "local");
    expect((await applyKit(seen, null, [{ kind: "pull" }])).failed).toEqual([]);
    expect(readFileSync(join(store, "a.md"), "utf8")).toBe("2");
    await Bun.write(join(other, "b.md"), "3");
    await g(other, "commit", "-qam", "three"); await g(other, "push", "-q", "origin", "HEAD:main");
    const r = await applyKit(seen, null, [{ kind: "pull" }]);
    expect(r.failed[0]!.why).toContain("b.md");
    expect(readFileSync(join(store, "b.md"), "utf8")).toBe("local");
  });
});

describe("pull under pull.rebase", () => {
  test("still fast-forwards over a local edit when the machine sets pull.rebase=true (the mini does)", async () => {
    const { h, seen } = scratch();
    const origin = join(h, "o.git");
    const store = join(h, ".claude");
    const other = join(h, "other");
    const g = (dir: string, ...a: string[]) => exec(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
    await exec(["git", "init", "-q", "--bare", "-b", "main", origin]);
    await exec(["git", "clone", "-q", origin, other]);
    await Bun.write(join(other, "a.md"), "1"); await Bun.write(join(other, "b.md"), "1");
    await g(other, "add", "."); await g(other, "commit", "-qm", "one"); await g(other, "push", "-q", "origin", "HEAD:main");
    rmSync(store, { recursive: true, force: true });
    await exec(["git", "clone", "-q", origin, store]);
    await g(store, "config", "pull.rebase", "true");
    await Bun.write(join(other, "a.md"), "2");
    await g(other, "commit", "-qam", "two"); await g(other, "push", "-q", "origin", "HEAD:main");
    await Bun.write(join(store, "b.md"), "local");
    expect((await applyKit(seen, null, [{ kind: "pull" }])).failed).toEqual([]);
    expect(readFileSync(join(store, "a.md"), "utf8")).toBe("2");
    expect(readFileSync(join(store, "b.md"), "utf8")).toBe("local");
  });
});

describe("nextPlaced", () => {
  test("adds links, drops removes, keeps the rest", () => {
    const { seen } = scratch();
    expect(nextPlaced(seen, [
      { kind: "link", agent: "codex", name: "ship", link: "L" },
      { kind: "remove", agent: "codex", name: "old" },
    ])).toEqual({ codex: { placed: { ship: "L" } } });
  });
  test("adopt records where the entry went, put back drops it, and a later link keeps the record", () => {
    const { h, seen } = scratch();
    expect(nextPlaced(seen, [{ kind: "skill-adopt", agent: "codex", name: "ship", link: "L" }])).toEqual({
      codex: { placed: { old: "../../.claude/skills/old", ship: "L" }, adoptedFrom: { ship: join(h, ".codex/.canopy-kit-adopted/ship") } },
    });
    seen.targets[1]!.adoptedFrom = { ship: "/x" };
    seen.targets[1]!.placed = { ship: "L" };
    expect(nextPlaced(seen, [{ kind: "link", agent: "codex", name: "desk", link: "D" }])).toEqual({ codex: { placed: { ship: "L", desk: "D" }, adoptedFrom: { ship: "/x" } } });
    expect(nextPlaced(seen, [{ kind: "skill-restore", agent: "codex", name: "ship" }])).toEqual({ codex: { placed: {} } });
  });
});

describe("skill adopt and put back on a scratch target", () => {
  const L = "../../.claude/skills/ship";
  const adopted = (h: string) => join(h, ".codex/.canopy-kit-adopted/ship");
  const kitFile = (h: string) => JSON.parse(readFileSync(join(h, ".codex/skills/.canopy-kit.json"), "utf8")) as unknown;
  test("adopt moves a real folder aside (0700) and links; put back brings it back and drops the record", async () => {
    const { h, seen } = scratch();
    mkdirSync(join(h, ".codex/skills/ship"));
    writeFileSync(join(h, ".codex/skills/ship/SKILL.md"), "mine");
    const r = await applyKit(seen, null, [{ kind: "skill-adopt", agent: "codex", name: "ship", link: L }]);
    expect(r.failed).toEqual([]);
    expect(readlinkSync(join(h, ".codex/skills/ship"))).toBe(L);
    expect(readFileSync(join(adopted(h), "SKILL.md"), "utf8")).toBe("mine");
    expect(statSync(join(h, ".codex/.canopy-kit-adopted")).mode & 0o777).toBe(0o700);
    expect(kitFile(h)).toEqual({ placed: { old: "../../.claude/skills/old", ship: L }, adoptedFrom: { ship: adopted(h) } });
    seen.targets[1]!.placed = { old: "../../.claude/skills/old", ship: L };
    seen.targets[1]!.adoptedFrom = { ship: adopted(h) };
    const back = await applyKit(seen, null, [{ kind: "skill-restore", agent: "codex", name: "ship" }]);
    expect(back.failed).toEqual([]);
    expect(lstatSync(join(h, ".codex/skills/ship")).isDirectory()).toBe(true);
    expect(readFileSync(join(h, ".codex/skills/ship/SKILL.md"), "utf8")).toBe("mine");
    expect(existsSync(adopted(h))).toBe(false);
    expect(kitFile(h)).toEqual({ placed: { old: "../../.claude/skills/old" } });
  });
  test("adopt takes a file and a foreign link as they are", async () => {
    const { h, seen } = scratch();
    writeFileSync(join(h, ".codex/skills/ship"), "a file");
    symlinkSync("/elsewhere/desk", join(h, ".codex/skills/desk"));
    const r = await applyKit(seen, null, [
      { kind: "skill-adopt", agent: "codex", name: "ship", link: L },
      { kind: "skill-adopt", agent: "codex", name: "desk", link: "../../.claude/skills/desk" },
    ]);
    expect(r.failed).toEqual([]);
    expect(readFileSync(adopted(h), "utf8")).toBe("a file");
    expect(readlinkSync(join(h, ".codex/.canopy-kit-adopted/desk"))).toBe("/elsewhere/desk");
    expect(readlinkSync(join(h, ".codex/skills/desk"))).toBe("../../.claude/skills/desk");
  });
  test("adopt never moves over a folder already set aside", async () => {
    const { h, seen } = scratch();
    mkdirSync(join(h, ".codex/skills/ship"));
    mkdirSync(adopted(h), { recursive: true });
    const r = await applyKit(seen, null, [{ kind: "skill-adopt", agent: "codex", name: "ship", link: L }]);
    expect(r.failed[0]!.why).toBe(`${adopted(h)} is taken; move it away first`);
    expect(lstatSync(join(h, ".codex/skills/ship")).isDirectory()).toBe(true);
    expect(existsSync(join(h, ".codex/skills/.canopy-kit.json"))).toBe(false);
  });
  test("put back refuses a link pointed elsewhere by hand, and a folder gone missing, and moves nothing", async () => {
    const { h, seen } = scratch();
    mkdirSync(adopted(h), { recursive: true });
    symlinkSync("/hand/edited", join(h, ".codex/skills/ship"));
    seen.targets[1]!.placed = { ship: L };
    seen.targets[1]!.adoptedFrom = { ship: adopted(h) };
    const r = await applyKit(seen, null, [{ kind: "skill-restore", agent: "codex", name: "ship" }]);
    expect(r.failed[0]!.why).toContain("pointed elsewhere by hand");
    expect(readlinkSync(join(h, ".codex/skills/ship"))).toBe("/hand/edited");
    expect(existsSync(adopted(h))).toBe(true);
    rmSync(adopted(h), { recursive: true });
    rmSync(join(h, ".codex/skills/ship"));
    symlinkSync(L, join(h, ".codex/skills/ship"));
    const gone = await applyKit(seen, null, [{ kind: "skill-restore", agent: "codex", name: "ship" }]);
    expect(gone.failed[0]!.why).toBe(`${adopted(h)} is gone`);
    expect(readlinkSync(join(h, ".codex/skills/ship"))).toBe(L);
  });
});
