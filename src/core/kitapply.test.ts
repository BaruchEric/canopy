import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
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
    ])).toEqual({ codex: { ship: "L" } });
  });
});
