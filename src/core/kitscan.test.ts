import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKit, planKit } from "./kit";
import { parseScan, seeKit } from "./kitscan";
import { exec } from "./exec";

const RAW = {
  version: 1,
  machines: { mac: { backend: "mac" } },
  targets: [
    { agent: "claude", skills: "~/.claude/skills", mode: "store" },
    { agent: "codex", skills: "~/.codex/skills", mode: "link" },
    { agent: "hermes", skills: "~/.hermes/skills", mode: "link" },
  ],
  skills: { only: { craft: { source: "dev:tools/craft" } } },
};
const kit = () => { const r = parseKit(RAW); if ("errors" in r) throw new Error(); return r.kit; };

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

async function home(): Promise<string> {
  const h = mkdtempSync(join(tmpdir(), "kit-"));
  dirs.push(h);
  const origin = join(h, "origin.git");
  await exec(["git", "init", "-q", "--bare", "-b", "main", origin]);
  const store = join(h, ".claude");
  await exec(["git", "init", "-q", "-b", "main", store]);
  mkdirSync(join(store, "skills/ship"), { recursive: true });
  writeFileSync(join(store, "skills/ship/SKILL.md"), "x");
  await exec(["git", "-C", store, "add", "."]);
  await exec(["git", "-C", store, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  await exec(["git", "-C", store, "remote", "add", "origin", origin]);
  await exec(["git", "-C", store, "push", "-q", "-u", "origin", "main"]);
  mkdirSync(join(store, "skills/.hidden"));
  mkdirSync(join(h, ".codex/skills/.system"), { recursive: true });
  mkdirSync(join(h, ".codex/skills/qnap-nas-control"));
  symlinkSync("../../.claude/skills/ship", join(h, ".codex/skills/ship"));
  writeFileSync(join(h, ".codex/skills/.canopy-kit.json"), JSON.stringify({ placed: { ship: "../../.claude/skills/ship" } }));
  mkdirSync(join(h, "dev/tools/craft"), { recursive: true });
  return h;
}

describe("seeKit on a scratch home", () => {
  test("reads the store, the targets, the placed lists and the sources", async () => {
    const h = await home();
    const s = await seeKit(kit(), { name: "mac", host: null, dev: join(h, "dev") }, { env: { HOME: h }, now: () => 7 });
    expect(s.away).toBeNull();
    expect(s.home).toBe(h);
    expect(s.store).toMatchObject({ tracked: ["ship"], branch: "main", ahead: 0, behind: 0, fetchFailed: false });
    expect(s.targets.map((t) => t.agent)).toEqual(["claude", "codex", "hermes"]);
    const codex = s.targets[1]!;
    expect(codex.entries).toEqual([
      { name: "qnap-nas-control", kind: "dir", link: null },
      { name: "ship", kind: "link", link: "../../.claude/skills/ship" },
    ]);
    expect(codex.placed).toEqual({ ship: "../../.claude/skills/ship" });
    expect(s.targets[2]).toMatchObject({ exists: false, parentExists: false });
    expect(s.targets[0]!.entries.map((e) => e.name)).toEqual(["ship"]);
    expect(s.sources).toEqual({ craft: true });
  });
  test("an unreachable machine reads away with the reason (review focus 2)", async () => {
    const run = async () => ({ code: 255, stdout: "", stderr: "# Tailscale SSH requires an additional check.\n" });
    const s = await seeKit(kit(), { name: "gpd", host: "gpd", dev: "/d" }, { run, now: () => 1 });
    expect(s.away).toBe("Tailscale SSH requires an additional check.");
    expect(s.store).toBeNull();
  });
  test("a host ssh cannot reach is asked once, not fetched and then scanned", async () => {
    let calls = 0;
    const run = async () => { calls++; return { code: 255, stdout: "", stderr: "ssh: connect to host gpd port 22: Connection refused\n" }; };
    const s = await seeKit(kit(), { name: "gpd", host: "gpd", dev: "/d" }, { run, now: () => 1 });
    expect(calls).toBe(1);
    expect(s.away).toBe("ssh: connect to host gpd port 22: Connection refused");
  });
  test("a fetch that never reached the host reads away without a second try", async () => {
    let calls = 0;
    const run = async () => { calls++; return { code: 143, stdout: "", stderr: "" }; };
    const s = await seeKit(kit(), { name: "gpd", host: "gpd", dev: "/d" }, { run, now: () => 1 });
    expect(calls).toBe(1);
    expect(s.away).toMatch(/no answer/);
  });
  test("a store git cannot read reads away, so nothing is planned against an empty list", async () => {
    const h = await home();
    writeFileSync(join(h, ".claude/.git/HEAD"), "garbage\n");
    const s = await seeKit(kit(), { name: "mac", host: null, dev: join(h, "dev") }, { env: { HOME: h }, now: () => 7 });
    expect(s.away).toMatch(/^store: /);
    expect(planKit(kit(), s, join(h, "dev"))).toEqual([]);
  });
  test("the store path from the manifest is never evaluated by the shell", async () => {
    const h = await home();
    const raw = structuredClone(RAW);
    raw.targets[0]!.skills = `~/.claude$(touch ${h}/pwned)/skills`;
    const r = parseKit(raw);
    if ("errors" in r) throw new Error(r.errors.join());
    await seeKit(r.kit, { name: "mac", host: null, dev: join(h, "dev") }, { env: { HOME: h }, now: () => 7 });
    expect(existsSync(join(h, "pwned"))).toBe(false);
  });
});

describe("parseScan", () => {
  test("skips names that are not slugs and counts dirty lines", () => {
    const out = [
      "H\t/h",
      "K\tship",
      "K\tBad Name",
      "G\t# branch.head main",
      "G\t# branch.ab +1 -2",
      "G\t1 .M N... 100644 100644 100644 a b CLAUDE.md",
      "G\t? notes.md",
      "D\tclaude\t/h/.claude/skills\t1\t1",
      "E\tclaude\tship\tdir\t",
      "E\tclaude\tWeird One\tdir\t",
    ].join("\n");
    const s = parseScan("mac", out, 3);
    expect(s.store).toEqual({ tracked: ["ship"], branch: "main", ahead: 1, behind: 2, dirty: 2, fetchFailed: false });
    expect(s.targets[0]!.entries).toEqual([{ name: "ship", kind: "dir", link: null }]);
  });
});
