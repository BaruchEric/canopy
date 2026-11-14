import { describe, expect, test } from "bun:test";
import { anchorWord, coordBackends, coordDefaults, goalLimitsWhy, goalRepoChoices, goalRepoRows, namedRepos, runRepo, runRepoId, runRepoName } from "./goals";
import { setRegistry } from "./registry";
import { NO_ROUTES } from "./agents";
import { withDefaultProfile } from "../../src/core/route";
import { DEFAULT_AGENT, type AgentRoutes, type Repo } from "../../src/core/types";
import type { Conn } from "./store";

const repo = (id: string, over: Partial<Repo> = {}): Repo => ({ id, name: id.split("|").pop()?.split("/").pop() ?? id, path: `/dev/${id}`, group: "", source: "", status: null, ...over });

describe("runRepoName", () => {
  setRegistry("mac", ["mac", "mini"]);
  const repos = [repo("app"), repo("mini|api")];
  test("the anchor is the goal, plain or qualified", () => {
    expect(runRepoName(repos, "~goal")).toBe("goal");
    expect(runRepoName(repos, "mini|~goal")).toBe("goal");
  });
  test("a known repo gives its name", () => {
    expect(runRepoName(repos, "app")).toBe("app");
    expect(runRepoName(repos, "mini|api")).toBe("api");
  });
  test("an unknown one gives the id as text", () => {
    expect(runRepoName(repos, "gone")).toBe("gone");
    expect(runRepoName(repos, "mini|gone")).toBe("gone on mini");
  });
});

describe("runRepoId", () => {
  setRegistry("mac", ["mac", "mini"]);
  test("the anchor is the goal, plain or qualified", () => {
    expect(runRepoId("~goal")).toBe("goal");
    expect(runRepoId("mini|~goal")).toBe("goal");
  });
  test("any other id keeps idText's words, its backend too, where runRepoName gives the name", () => {
    expect(runRepoId("app")).toBe("app");
    expect(runRepoId("mini|api")).toBe("api on mini");
    expect(runRepoId("mini|dev-tools/canopy")).toBe("dev-tools/canopy on mini");
    expect(runRepoName([repo("mini|api")], "mini|api")).toBe("api");
  });
});

describe("anchorWord", () => {
  test("the goal for the anchor, nothing for a repo", () => {
    expect(anchorWord("mini|~goal")).toBe("goal");
    expect(anchorWord("~goal")).toBe("goal");
    expect(anchorWord("mini|api")).toBeUndefined();
  });
});

describe("coordBackends", () => {
  const conn = (state: "online" | "offline", coordinator: boolean | undefined): Conn =>
    ({
      status: state === "online" ? { state } : { state, reason: "x" },
      about: coordinator === undefined ? null : { coordinator },
    }) as unknown as Conn;
  test("online backends with the coordinator, in order", () => {
    const conns = { a: conn("online", true), b: conn("offline", true), c: conn("online", false), d: conn("online", true), e: conn("online", undefined) };
    expect(coordBackends(conns, ["d", "a", "b", "c", "e", "zz"])).toEqual(["d", "a"]);
  });
});

describe("coordDefaults", () => {
  test("the coordinate role's model and effort when set", () => {
    const routes: AgentRoutes = {
      ...NO_ROUTES,
      profiles: withDefaultProfile({ big: { ...DEFAULT_AGENT, model: "opus", effort: "max" } }),
      roles: { coordinate: { profile: "big" } },
    };
    expect(coordDefaults(routes)).toEqual({ model: "opus", effort: "max" });
  });
  test("else the default route's", () => {
    const got = coordDefaults(NO_ROUTES);
    expect(got.model).toBe(DEFAULT_AGENT.model);
    expect(got.effort).toBeDefined();
  });
});

describe("goalRepoChoices", () => {
  setRegistry("mac", ["mac", "mini"]);
  test("drops hosts, forges, seeds, the anchor and other backends", () => {
    const repos = [
      repo("app"),
      repo("far", { host: "box" }),
      repo("forged", { forge: { kind: "forgejo" } as unknown as Repo["forge"] }),
      repo("_incubator/x"),
      repo("~goal"),
      repo("mini|api"),
    ];
    expect(goalRepoChoices(repos, "mac").map((r) => r.id)).toEqual(["app"]);
    expect(goalRepoChoices(repos, "mini").map((r) => r.id)).toEqual(["mini|api"]);
  });
});

describe("runRepo", () => {
  setRegistry("mac", ["mac", "mini"]);
  const repos = [repo("app")];
  test("the anchor stands in as the goal under its own id", () => {
    expect(runRepo(repos, "mini|~goal")).toMatchObject({ id: "mini|~goal", name: "goal" });
  });
  test("a known repo is itself, an unknown one is nothing", () => {
    expect(runRepo(repos, "app")).toBe(repos[0]);
    expect(runRepo(repos, "gone")).toBeUndefined();
  });
});

describe("namedRepos", () => {
  setRegistry("mac", ["mac", "mini"]);
  const choices = [repo("mini|demo"), repo("mini|dev-tools/canopy"), repo("mini|src:app"), repo("mini|.")];
  test("every @ token that is a choice's plain id, qualified, in order, once each", () => {
    expect(namedRepos("fix @dev-tools/canopy then @demo and @demo again", choices)).toEqual(["mini|dev-tools/canopy", "mini|demo"]);
    expect(namedRepos("@src:app first", choices)).toEqual(["mini|src:app"]);
    expect(namedRepos("the root @. too", choices)).toEqual(["mini|."]);
  });
  test("a word's trailing stop or comma does not hide the repo", () => {
    expect(namedRepos("in @demo, then (@src:app).", choices)).toEqual(["mini|demo"]);
    expect(namedRepos("in @demo. and @src:app!", choices)).toEqual(["mini|demo", "mini|src:app"]);
  });
  test("a token that is no choice, or an @ inside a word, names nothing", () => {
    expect(namedRepos("mail eric@demo or @dem or @twin", choices)).toEqual([]);
    expect(namedRepos("", choices)).toEqual([]);
  });
});

describe("goalRepoRows", () => {
  setRegistry("mac", ["mac", "mini"]);
  const choices = [repo("mini|demo"), repo("mini|twin"), repo("mini|dev-tools/canopy")];
  test("a query finds a repo by its id's start, its name, or its letters", () => {
    expect(goalRepoRows(choices, "de").map((r) => r.name)[0]).toBe("demo");
    expect(goalRepoRows(choices, "can").map((r) => r.name)).toEqual(["dev-tools/canopy"]);
    expect(goalRepoRows(choices, "zz")).toEqual([]);
  });
  test("no query lists them all, by id", () => {
    expect(goalRepoRows(choices, "").map((r) => r.name)).toEqual(["demo", "dev-tools/canopy", "twin"]);
  });
});

describe("goalLimitsWhy", () => {
  const file = (size: number) => ({ size });
  test("nothing over the limits says nothing", () => {
    expect(goalLimitsWhy({ text: "x", repos: 20, files: Array.from({ length: 10 }, () => file(1)) })).toBeNull();
    expect(goalLimitsWhy({ text: "x", repos: 0, files: [file(25 * 1024 * 1024)] })).toBeNull();
  });
  test("each limit says why when crossed", () => {
    expect(goalLimitsWhy({ text: "x".repeat(20001), repos: 0, files: [] })).toBe("The goal is over 20000 characters.");
    expect(goalLimitsWhy({ text: "x", repos: 21, files: [] })).toBe("A goal names at most 20 repos; this one names 21.");
    expect(goalLimitsWhy({ text: "x", repos: 0, files: Array.from({ length: 12 }, () => file(1)) })).toBe("At most 10 files go with a goal; remove 2.");
    expect(goalLimitsWhy({ text: "x", repos: 0, files: [file(20 * 1024 * 1024), file(10 * 1024 * 1024)] })).toBe("The files come to 30.0 MB; a goal takes 25 MB in all.");
  });
});
