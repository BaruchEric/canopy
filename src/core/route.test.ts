import { describe, expect, test } from "bun:test";
import {
  effectiveAgents,
  isProfileName,
  launchPick,
  normalizePick,
  normalizeProfiles,
  normalizeRepoAgent,
  normalizeRoles,
  normalizeRoutes,
  pickRefusal,
  repoAgentRefusal,
  resolveAgent,
  withDefaultProfile,
} from "./route";
import { DEFAULT_AGENT, type AgentRoutes, type AgentSettings } from "./types";

const claude = (over: Partial<AgentSettings> = {}): AgentSettings => ({ ...DEFAULT_AGENT, ...over });
const codex = (over: Partial<AgentSettings> = {}): AgentSettings => ({ ...DEFAULT_AGENT, harness: "codex", ...over });

const P = "/srv/dev/app";

const deep = claude({ model: "opus", effort: "max" });
const review = codex({ model: "gpt-5.5", effort: "high", yolo: false });
const quick = claude({ model: "haiku" });

/** a routing with every layer present for P's shell */
const full = (): AgentRoutes => ({
  profiles: withDefaultProfile({ deep, review, quick }),
  roles: { shell: { profile: "quick" }, chat: { profile: "deep" } },
  repos: { [P]: { all: { profile: "deep" }, roles: { shell: { profile: "review" } } } },
});

describe("resolving a role", () => {
  test("each layer wins when the ones above it are absent", () => {
    const r = full();
    expect(resolveAgent(r, P, "shell", { profile: "quick" })).toEqual({ settings: quick, from: "explicit", profile: "quick" });
    expect(resolveAgent(r, P, "shell")).toEqual({ settings: review, from: "repo-role", profile: "review" });
    delete r.repos[P]!.roles;
    expect(resolveAgent(r, P, "shell")).toEqual({ settings: deep, from: "repo", profile: "deep" });
    delete r.repos[P];
    expect(resolveAgent(r, P, "shell")).toEqual({ settings: quick, from: "role", profile: "quick" });
    delete r.roles.shell;
    expect(resolveAgent(r, P, "shell")).toEqual({ settings: DEFAULT_AGENT, from: "default", profile: "default" });
    expect(resolveAgent({ profiles: {}, roles: {}, repos: {} }, P, "shell")).toEqual({ settings: DEFAULT_AGENT, from: "builtin" });
  });

  test("the repo beats the role, and settings of its own need no profile", () => {
    const r: AgentRoutes = {
      profiles: withDefaultProfile({}),
      roles: { job: { profile: "default" } },
      repos: { [P]: { all: claude({ extra: "--verbose" }) } },
    };
    expect(resolveAgent(r, P, "job")).toEqual({ settings: claude({ extra: "--verbose" }), from: "repo" });
    expect(resolveAgent(r, "/elsewhere", "job")).toEqual({ settings: DEFAULT_AGENT, from: "role", profile: "default" });
  });

  test("a pick naming a missing profile falls through, and says so", () => {
    const r = full();
    r.repos[P] = { roles: { shell: { profile: "gone" } } };
    const got = resolveAgent(r, P, "shell");
    expect(got.settings).toEqual(quick);
    expect(got.from).toBe("role");
    expect(got.skipped).toEqual([{ from: "repo-role", profile: "gone", why: "no profile named gone" }]);
    expect(resolveAgent(r, P, "shell", { profile: "nope" }).skipped?.[0]).toMatchObject({ from: "explicit", profile: "nope" });
  });

  test("only a shell may be codex for now: other roles pass a codex pick over", () => {
    const r = full();
    r.repos[P] = { all: { profile: "review" } };
    expect(resolveAgent(r, P, "shell")).toMatchObject({ settings: review, from: "repo" });
    const chat = resolveAgent(r, P, "chat");
    expect(chat).toMatchObject({ settings: deep, from: "role", profile: "deep" });
    expect(chat.skipped?.[0]).toMatchObject({ from: "repo", profile: "review" });
    expect(chat.skipped?.[0]?.why).toContain("codex does not run chats yet");
    // a codex default profile leaves the others on the builtin
    const flow = resolveAgent({ profiles: { default: codex() }, roles: {}, repos: {} }, P, "flow");
    expect(flow.settings).toEqual(DEFAULT_AGENT);
    expect(flow.from).toBe("builtin");
  });

  test("every role at once, for the effective table", () => {
    const t = effectiveAgents(full(), P);
    expect(t.shell.from).toBe("repo-role");
    expect(t.chat).toMatchObject({ from: "repo", profile: "deep" });
    expect(t.job).toMatchObject({ from: "repo", profile: "deep" });
    expect(t.suggest).toMatchObject({ from: "repo", profile: "deep" });
  });
});

describe("a harness picked at launch", () => {
  test("the route's own settings when they are that harness's", () => {
    expect(resolveAgent(full(), P, "shell", { harness: "codex" })).toMatchObject({ settings: review, from: "explicit", profile: "review" });
  });

  test("a lower layer of that harness beats a profile hunt, so a repo's own settings win", () => {
    const own = codex({ model: "gpt-6-sol" });
    const r: AgentRoutes = { profiles: withDefaultProfile({ review }), roles: {}, repos: { [P]: { all: own } } };
    expect(resolveAgent(r, P, "shell", { harness: "codex" })).toEqual({ settings: own, from: "explicit" });
  });

  test("else the first profile of it, default first, then by name", () => {
    const r: AgentRoutes = { profiles: withDefaultProfile({ zeta: codex({ model: "z" }), alpha: codex({ model: "a" }) }), roles: {}, repos: {} };
    expect(resolveAgent(r, P, "shell", { harness: "codex" })).toMatchObject({ profile: "alpha" });
    r.profiles["default"] = codex({ model: "d" });
    expect(resolveAgent(r, P, "shell", { harness: "codex" })).toMatchObject({ profile: "default" });
  });

  test("else the harness's own defaults", () => {
    expect(resolveAgent(normalizeRoutes({}), P, "shell", { harness: "codex" })).toEqual({ settings: codex(), from: "explicit" });
    expect(resolveAgent(normalizeRoutes({}), P, "shell", { harness: "claude" })).toEqual({ settings: DEFAULT_AGENT, from: "explicit", profile: "default" });
  });

  test("a harness the role cannot run is ignored with a note", () => {
    const got = resolveAgent(normalizeRoutes({}), P, "chat", { harness: "codex" });
    expect(got.settings.harness).toBe("claude");
    expect(got.skipped?.[0]?.from).toBe("explicit");
  });

  test("off a query string: a profile wins over a harness, junk is nothing", () => {
    expect(launchPick("deep", "codex")).toEqual({ profile: "deep" });
    expect(launchPick(null, "codex")).toEqual({ harness: "codex" });
    expect(launchPick("../x", "gemini")).toBeUndefined();
    expect(launchPick(null, null)).toBeUndefined();
  });
});

describe("what is stored", () => {
  test("an entry from before roles reads as the repo's whole pick", () => {
    expect(normalizeRepoAgent({ model: "opus", effort: "high", yolo: true, extra: "" })).toEqual({
      all: claude({ model: "opus", effort: "high" }),
    });
    expect(normalizeRepoAgent({})).toEqual({});
    expect(normalizeRepoAgent(null)).toEqual({});
  });

  test("the new shape keeps valid picks and drops the rest", () => {
    expect(
      normalizeRepoAgent({
        all: { profile: "deep" },
        roles: { shell: { harness: "codex", model: "gpt-5.5" }, chat: { profile: "Bad Name" }, nope: { profile: "x" } },
      }),
    ).toEqual({ all: { profile: "deep" }, roles: { shell: codex({ model: "gpt-5.5" }) } });
    expect(normalizeRoles({ job: 3, flow: { profile: "x" } })).toEqual({ flow: { profile: "x" } });
    expect(normalizePick({ profile: "ok" })).toEqual({ profile: "ok" });
    expect(normalizePick({ profile: "-no" })).toBeNull();
    expect(normalizePick("deep")).toBeNull();
  });

  test("profiles: bad names out, and default only when it differs from the builtin", () => {
    expect(normalizeProfiles({ default: DEFAULT_AGENT, "Deep!": deep, deep, review: { harness: "codex", model: "opus" } })).toEqual({
      deep,
      review: codex(),
    });
    expect(normalizeProfiles({ default: quick })).toEqual({ default: quick });
    expect(isProfileName("a-b_1")).toBe(true);
    expect(isProfileName("A")).toBe(false);
  });

  test("an older backend's plain map reads as whole-repo picks, with a default profile", () => {
    expect(normalizeRoutes({ [P]: { model: "opus", effort: "default", yolo: false, extra: "" } })).toEqual({
      profiles: { default: DEFAULT_AGENT },
      roles: {},
      repos: { [P]: { all: claude({ model: "opus", yolo: false }) } },
    });
    const now = normalizeRoutes({ profiles: { deep }, roles: { chat: { profile: "deep" } }, repos: {} });
    expect(Object.keys(now.profiles)).toEqual(["default", "deep"]);
    expect(now.roles).toEqual({ chat: { profile: "deep" } });
  });

  test("codex settings of their own are refused for a role that cannot run them; a profile pick is let through", () => {
    expect(pickRefusal("chat", codex())).toContain("codex does not run chats yet");
    expect(pickRefusal("shell", codex())).toBeNull();
    expect(pickRefusal("job", { profile: "review" })).toBeNull();
    expect(repoAgentRefusal({ all: codex(), roles: { shell: codex() } })).toBeNull();
    expect(repoAgentRefusal({ roles: { flow: codex() } })).toContain("workflow steps");
  });
});
