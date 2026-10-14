import { describe, expect, test } from "bun:test";
import { cellsOf, expandHome, parseKit, planKit, relPath, skillNames, sourcePath, targetsFor, wanted } from "./kit";
import type { KitManifest, KitSeen, KitSeenTarget } from "./types";

const RAW = {
  version: 1,
  machines: {
    mac: { backend: "mac" },
    mini: { backend: "mini" },
    gpd: { ssh: "gpd", via: "mac", dev: "/home/eric/dev" },
  },
  targets: [
    { agent: "claude", skills: "~/.claude/skills", mode: "store" },
    { agent: "codex", skills: "~/.codex/skills", mode: "link" },
    { agent: "hermes", skills: "~/.hermes/skills", mode: "link", machines: ["mini"] },
  ],
  skills: {
    default: { agents: ["*"], machines: ["*"] },
    only: { desk: { agents: ["claude"] }, craft: { source: "dev:dev-tools/craft/skill" } },
    exclude: ["*-workspace", "synced"],
  },
};

function kit(): KitManifest {
  const r = parseKit(RAW);
  if ("errors" in r) throw new Error(r.errors.join("; "));
  return r.kit;
}

const tgt = (agent: string, dir: string, over: Partial<KitSeenTarget> = {}): KitSeenTarget => ({
  agent, dir, exists: true, parentExists: true, entries: [], placed: {}, ...over,
});

function seen(over: Partial<KitSeen> = {}): KitSeen {
  return {
    machine: "mac", at: 1, away: null, home: "/Users/e",
    store: { tracked: ["ship", "desk", "book-workspace"], branch: "main", ahead: 0, behind: 0, dirty: 0, fetchFailed: false },
    targets: [
      tgt("claude", "/Users/e/.claude/skills", { entries: [
        { name: "ship", kind: "dir", link: null },
        { name: "desk", kind: "dir", link: null },
        { name: "book-workspace", kind: "dir", link: null },
      ] }),
      tgt("codex", "/Users/e/.codex/skills"),
    ],
    sources: { craft: false },
    ...over,
  };
}

describe("parseKit", () => {
  test("reads machines, targets and rules", () => {
    const k = kit();
    expect(k.machines.map((m) => m.name)).toEqual(["mac", "mini", "gpd"]);
    expect(k.machines[2]).toEqual({ name: "gpd", backend: null, ssh: "gpd", via: "mac", dev: "/home/eric/dev" });
    expect(k.targets[2]!.machines).toEqual(["mini"]);
    expect(k.only["craft"]!.source).toBe("dev:dev-tools/craft/skill");
  });
  test("refuses a missing store target, a second store, and a repeated agent", () => {
    const bad = (targets: unknown) => parseKit({ ...RAW, targets });
    expect(bad([{ agent: "codex", skills: "~/x", mode: "link" }])).toEqual({ errors: ["targets: exactly one target has mode store"] });
    expect("errors" in bad([...RAW.targets, { agent: "codex", skills: "~/y", mode: "link" }])).toBe(true);
  });
  test("refuses an ssh machine without via or dev, and a non-object", () => {
    expect("errors" in parseKit({ ...RAW, machines: { gpd: { ssh: "gpd" } } })).toBe(true);
    expect(parseKit(null)).toEqual({ errors: ["kit.json is not an object"] });
    expect(parseKit({ ...RAW, version: 2 })).toEqual({ errors: ["version: only 1 is known"] });
  });
});

describe("paths", () => {
  test("expandHome", () => {
    expect(expandHome("~/.codex/skills", "/h")).toBe("/h/.codex/skills");
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("/opt/x", "/h")).toBe("/opt/x");
  });
  test("relPath from a target dir to the store", () => {
    expect(relPath("/h/.codex/skills", "/h/.claude/skills")).toBe("../../.claude/skills");
    expect(relPath("/h/.claude/skills", "/h/.claude/skills")).toBe(".");
    expect(relPath("/opt/stacks/x/skills", "/h/.claude/skills")).toBe("../../../../h/.claude/skills");
  });
  test("sourcePath takes dev: and absolute, nothing else", () => {
    expect(sourcePath("dev:dev-tools/craft/skill", "/home/eric/dev")).toBe("/home/eric/dev/dev-tools/craft/skill");
    expect(sourcePath("/abs/skill", "/d")).toBe("/abs/skill");
    expect(sourcePath("~/x", "/d")).toBeNull();
    expect(sourcePath("dev:../escape", "/d")).toBeNull();
  });
});

describe("rules", () => {
  test("targetsFor keeps the store first and drops targets for other machines", () => {
    expect(targetsFor(kit(), "mac").map((t) => t.agent)).toEqual(["claude", "codex"]);
    expect(targetsFor(kit(), "mini").map((t) => t.agent)).toEqual(["claude", "codex", "hermes"]);
  });
  test("skillNames: tracked, minus excluded, plus sources", () => {
    expect(skillNames(kit(), seen())).toEqual(["craft", "desk", "ship"]);
  });
  test("wanted follows only over default", () => {
    expect(wanted(kit(), "desk", "codex", "mac")).toBe(false);
    expect(wanted(kit(), "desk", "claude", "mac")).toBe(true);
    expect(wanted(kit(), "ship", "codex", "gpd")).toBe(true);
  });
});

describe("planKit", () => {
  test("links what is missing, relatively", () => {
    expect(planKit(kit(), seen(), "/Users/e/dev")).toEqual([
      { kind: "link", agent: "codex", name: "ship", link: "../../.claude/skills/ship" },
    ]);
  });
  test("leaves a foreign entry alone (review focus 1)", () => {
    const s = seen();
    s.targets[1]!.entries = [{ name: "ship", kind: "dir", link: null }];
    expect(planKit(kit(), s, "/d")).toEqual([]);
  });
  test("relinks a placed link still as placed whose wanted text moved, never a placed name that became a folder (review focus 4)", () => {
    const s = seen();
    s.targets[1]!.placed = { ship: "../old/skills/ship", gone: "../../.claude/skills/gone" };
    s.targets[1]!.entries = [{ name: "ship", kind: "link", link: "../old/skills/ship" }, { name: "gone", kind: "dir", link: null }];
    expect(planKit(kit(), s, "/d")).toEqual([
      { kind: "relink", agent: "codex", name: "ship", link: "../../.claude/skills/ship" },
    ]);
  });
  test("a placed link someone pointed elsewhere by hand is drift, left for a person: never relinked or removed", () => {
    const s = seen();
    s.targets[1]!.placed = { ship: "../../.claude/skills/ship", desk: "../../.claude/skills/desk" };
    s.targets[1]!.entries = [
      { name: "desk", kind: "link", link: "/mine/desk" },
      { name: "ship", kind: "link", link: "/elsewhere" },
    ];
    expect(planKit(kit(), s, "/d")).toEqual([]);
    expect(cellsOf(kit(), [{ seen: s, dev: "/d" }]).find((c) => c.agent === "codex" && c.skill === "ship")?.state).toBe("drift");
  });
  test("removes a placed link no longer wanted", () => {
    const s = seen();
    s.targets[1]!.placed = { desk: "../../.claude/skills/desk", ship: "../../.claude/skills/ship" };
    s.targets[1]!.entries = [
      { name: "desk", kind: "link", link: "../../.claude/skills/desk" },
      { name: "ship", kind: "link", link: "../../.claude/skills/ship" },
    ];
    expect(planKit(kit(), s, "/d")).toEqual([{ kind: "remove", agent: "codex", name: "desk" }]);
  });
  test("makes a missing target dir only when its parent exists", () => {
    const s = seen();
    s.targets[1] = tgt("codex", "/Users/e/.codex/skills", { exists: false });
    expect(planKit(kit(), s, "/d")[0]).toEqual({ kind: "mkdir", agent: "codex" });
    s.targets[1] = tgt("codex", "/Users/e/.codex/skills", { exists: false, parentExists: false });
    expect(planKit(kit(), s, "/d")).toEqual([]);
  });
  test("links a present source into the store, absolutely", () => {
    const s = seen({ sources: { craft: true } });
    expect(planKit(kit(), s, "/Users/e/dev")).toContainEqual(
      { kind: "link", agent: "claude", name: "craft", link: "/Users/e/dev/dev-tools/craft/skill" },
    );
  });
  test("offers a pull when behind and not ahead, nothing for an away machine", () => {
    const s = seen();
    s.store!.behind = 5;
    expect(planKit(kit(), s, "/d")[0]).toEqual({ kind: "pull" });
    s.store!.ahead = 1;
    expect(planKit(kit(), s, "/d").some((a) => a.kind === "pull")).toBe(false);
    expect(planKit(kit(), seen({ away: "ssh: needs a browser check", targets: [], store: null }), "/d")).toEqual([]);
  });
});

describe("cellsOf", () => {
  test("states per machine and agent", () => {
    const s = seen();
    s.targets[1]!.entries = [{ name: "desk", kind: "dir", link: null }];
    s.targets[0]!.entries.push({ name: "omarchy", kind: "link", link: "/usr/share/omarchy/x" });
    const cells = cellsOf(kit(), [{ seen: s, dev: "/d" }]);
    const at = (agent: string, skill: string) => cells.find((c) => c.agent === agent && c.skill === skill)?.state;
    expect(at("claude", "ship")).toBe("ok");
    expect(at("codex", "ship")).toBe("missing");
    expect(at("codex", "desk")).toBe("local");
    expect(at("claude", "omarchy")).toBe("local");
    expect(at("claude", "craft")).toBe("no-source");
  });
  test("an entry that is no kit skill reads local, never foreign (Omarchy's own links, Codex's own skills)", () => {
    const s = seen();
    s.targets[1]!.entries = [{ name: "diagnose-crash", kind: "link", link: "/usr/share/omarchy/x" }, { name: "qnap-nas-control", kind: "dir", link: null }];
    const cells = cellsOf(kit(), [{ seen: s, dev: "/d" }]);
    const at = (skill: string) => cells.find((c) => c.agent === "codex" && c.skill === skill);
    expect(at("diagnose-crash")).toMatchObject({ state: "local", why: "not in the store; canopy leaves it alone" });
    expect(at("qnap-nas-control")?.state).toBe("local");
  });
  test("an away machine is one away cell per agent", () => {
    const cells = cellsOf(kit(), [{ seen: seen({ machine: "gpd", away: "ssh exited 255", targets: [], store: null }), dev: "/d" }]);
    expect(cells.every((c) => c.state === "away" && c.skill === "*")).toBe(true);
    expect(cells.map((c) => c.agent)).toEqual(["claude", "codex"]);
  });
});
