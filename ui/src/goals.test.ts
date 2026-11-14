import { describe, expect, test } from "bun:test";
import { coordBackends, coordDefaults, goalRepoChoices, runRepo, runRepoName } from "./goals";
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
