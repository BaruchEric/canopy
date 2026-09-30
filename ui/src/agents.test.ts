import { describe, expect, test } from "bun:test";
import {
  effectiveRows,
  fromWord,
  harnessesOf,
  missingProfiles,
  overrideRows,
  pickLine,
  pickOf,
  pickValue,
  profileNames,
  profileUses,
  slotHarnesses,
  withPick,
} from "./agents";
import { withDefaultProfile } from "../../src/core/route";
import { DEFAULT_AGENT, type AgentRoutes, type AgentSettings } from "../../src/core/types";

const claude = (over: Partial<AgentSettings> = {}): AgentSettings => ({ ...DEFAULT_AGENT, ...over });
const codex = (over: Partial<AgentSettings> = {}): AgentSettings => ({ ...DEFAULT_AGENT, harness: "codex", ...over });
const P = "/dev/app";
const deep = claude({ model: "opus", effort: "max" });
const review = codex({ model: "gpt-5.5", yolo: false });

const routes = (): AgentRoutes => ({
  profiles: withDefaultProfile({ review, deep }),
  roles: { chat: { profile: "deep" } },
  repos: { [P]: { all: { profile: "review" } }, "/dev/other": { roles: { job: { profile: "gone" } } } },
});

describe("a pick in a select", () => {
  test("its value and back", () => {
    expect(pickValue(undefined)).toBe("");
    expect(pickValue({ profile: "deep" })).toBe("profile:deep");
    expect(pickValue(review)).toBe("custom");
    expect(pickOf("", review, deep)).toBeNull();
    expect(pickOf("profile:deep", undefined, deep)).toEqual({ profile: "deep" });
    // settings of its own keep what they held, and a new one starts from the seed
    expect(pickOf("custom", review, deep)).toBe(review);
    expect(pickOf("custom", { profile: "x" }, deep)).toEqual(deep);
  });

  test("one line for it", () => {
    expect(pickLine(undefined)).toBe("—");
    expect(pickLine({ profile: "deep" })).toBe("deep");
    expect(pickLine(review)).toBe("◇ gpt-5.5 · ask");
  });

  test("profile names: default first, then by name", () => {
    expect(profileNames(routes())).toEqual(["default", "deep", "review"]);
  });
});

describe("the effective table", () => {
  test("each role, its harness and settings, where they came from, and what to flag", () => {
    const rows = effectiveRows(routes(), P, ["claude", "codex"]);
    const shell = rows.find((r) => r.role === "shell")!;
    expect(shell).toMatchObject({ harness: "◇ codex", line: "gpt-5.5 · ask", from: "repo · review", flags: [] });
    // the repo beats the role, for a chat on codex too
    const chat = rows.find((r) => r.role === "chat")!;
    expect(chat.settings).toEqual(review);
    expect(chat.from).toBe("repo · review");
    expect(chat.flags).toEqual([]);
    expect(rows.find((r) => r.role === "job")!.from).toBe("repo · review");
    // a layer passed over is flagged
    const other = effectiveRows(routes(), "/dev/other", ["claude", "codex"]);
    const job = other.find((r) => r.role === "job")!;
    expect(job.from).toBe("default profile");
    expect(job.flags).toEqual(["repo, this role (gone) passed over: no profile named gone"]);
    expect(other.find((r) => r.role === "chat")!.from).toBe("role route · deep");
  });

  test("a harness the backend lacks is flagged, since a start on it is refused", () => {
    const shell = effectiveRows(routes(), P, ["claude"]).find((r) => r.role === "shell")!;
    expect(shell.flags).toEqual(["codex is not installed on this backend"]);
  });

  test("where resolved settings came from, in words", () => {
    expect(fromWord({ settings: DEFAULT_AGENT, from: "builtin" })).toBe("builtin");
    expect(fromWord({ settings: DEFAULT_AGENT, from: "default", profile: "default" })).toBe("default profile");
    expect(fromWord({ settings: DEFAULT_AGENT, from: "explicit", profile: "deep" })).toBe("picked at launch · deep");
  });

  test("a backend older than harnesses had claude alone, the same array each time", () => {
    expect(harnessesOf({ openers: false, sshHost: null })).toEqual(["claude"]);
    expect(harnessesOf({ openers: false, sshHost: null })).toBe(harnessesOf({ openers: true, sshHost: null }));
    expect(harnessesOf({ openers: false, sshHost: null, harnesses: ["codex"] })).toEqual(["codex"]);
  });
});

describe("the routing's bookkeeping", () => {
  test("routes naming a profile that is gone", () => {
    expect(missingProfiles(routes())).toEqual(["/dev/other (job): gone"]);
    // a name every object has is no profile, and the effective rows still draw
    const odd: AgentRoutes = { ...routes(), roles: { shell: { profile: "constructor" } } };
    expect(missingProfiles(odd)).toContain("role shell: constructor");
    expect(effectiveRows(odd, "/dev/none", ["claude"]).map((r) => r.harness)).toContain("✳ claude");
  });

  test("how many routes use a profile", () => {
    expect(profileUses(routes(), "deep")).toBe(1);
    expect(profileUses(routes(), "review")).toBe(1);
    expect(profileUses(routes(), "default")).toBe(0);
  });

  test("the overrides by the scan's names, and one the scan lost by its path", () => {
    const repos = [
      { id: "b", name: "beta", path: P },
      { id: "z", name: "zed", path: "/dev/z" },
    ];
    expect(overrideRows(routes(), repos).map((r) => [r.path, r.repo?.name ?? null])).toEqual([
      ["/dev/other", null],
      [P, "beta"],
    ]);
  });
});

describe("editing a repo's override", () => {
  test("a pick set and cleared, empty parts left out", () => {
    let a = withPick({}, "all", { profile: "deep" });
    expect(a).toEqual({ all: { profile: "deep" } });
    a = withPick(a, "shell", review);
    expect(a).toEqual({ all: { profile: "deep" }, roles: { shell: review } });
    a = withPick(a, "shell", null);
    expect(a).toEqual({ all: { profile: "deep" } });
    expect(withPick(a, "all", null)).toEqual({});
  });

  test("the whole repo and every role may be either harness", () => {
    expect(slotHarnesses("all")).toEqual(["claude", "codex"]);
    for (const role of ["shell", "chat", "job", "flow", "suggest"] as const) expect(slotHarnesses(role)).toEqual(["claude", "codex"]);
  });
});
