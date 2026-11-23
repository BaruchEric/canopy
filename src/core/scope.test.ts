import { describe, expect, test } from "bun:test";
import { LANES, needs } from "./callers";
import type { ActivityLine, PeopleInfo, Team } from "./people";
import { cutActivity, cutPeople, cutScan, hasCut, inScope, SCOPE_LANE_CLOSED, SCOPED_REPO_READS, SCOPED_REPO_WRITES, SCOPED_ROUTES, scopeAnswer, scopeBodyRefusal, scopeEvent, scopeOf, scopeRule, type ScopeView } from "./scope";
import type { Repo, ScanResult, ServerEvent } from "./types";

const RIO: Team = { id: "t-rioriori", name: "Rio", folders: ["/srv/rio"], created: 1 };
const LAB: Team = { id: "t-lablabla", name: "Lab", folders: ["/srv/lab"], created: 1 };
const BARE: Team = { id: "t-barebare", name: "Bare", folders: [], created: 1 };
const teams = [RIO, LAB, BARE];

// a test's stand-in carries only the fields a cut reads
const repo = (id: string, path: string): Repo => ({ id, name: id, path }) as Repo;
const repos = [repo("app", "/srv/rio/app"), repo("site", "/srv/rio/web/site"), repo("tool", "/srv/lab/tool"), repo("riot", "/srv/riot")];

const view: ScopeView = {
  person: "p-averyave",
  teams: [RIO.id],
  folders: RIO.folders,
  repo: (id) => id === "app" || id === "site",
  named: (name) => name === "app" || name === "site",
};

describe("who is scoped", () => {
  test("a member or a viewer on a team with folders is held to them", () => {
    expect(scopeOf({ teams }, { role: "member", teams: [RIO.id] })).toEqual(["/srv/rio"]);
    expect(scopeOf({ teams }, { role: "viewer", teams: [RIO.id, LAB.id] })).toEqual(["/srv/rio", "/srv/lab"]);
  });

  test("an owner and an admin never are, whatever their teams", () => {
    expect(scopeOf({ teams }, { role: "owner", teams: [RIO.id] })).toBeNull();
    expect(scopeOf({ teams }, { role: "admin", teams: [RIO.id] })).toBeNull();
  });

  test("nor is a member on no team, or on teams that name no folder", () => {
    expect(scopeOf({ teams }, { role: "member", teams: [] })).toBeNull();
    expect(scopeOf({ teams }, { role: "viewer", teams: [BARE.id] })).toBeNull();
    expect(scopeOf({ teams }, { role: "member", teams: ["t-nosuchte"] })).toBeNull();
  });

  test("a folder holds itself and what is below it, never a sibling that starts the same", () => {
    expect(inScope(["/srv/rio"], "/srv/rio")).toBe(true);
    expect(inScope(["/srv/rio"], "/srv/rio/app")).toBe(true);
    expect(inScope(["/srv/rio"], "/srv/riot")).toBe(false);
    expect(inScope(["/srv/rio"], "ssh://box/srv/rio/app")).toBe(false);
    expect(inScope([], "/srv/rio")).toBe(false);
  });
});

describe("the routes a scoped caller reaches", () => {
  test("a route nobody filed is closed", () => {
    for (const [m, p] of [
      ["GET", "/api/landing"],
      ["GET", "/api/notes"],
      ["GET", "/api/clips"],
      ["GET", "/api/kit"],
      ["GET", "/api/secrets"],
      ["GET", "/api/health"],
      ["GET", "/api/sources"],
      ["GET", "/api/work"],
      ["GET", "/api/sweep"],
      ["GET", "/api/browse"],
      ["POST", "/api/grep"],
      ["POST", "/api/coordinator/new"],
      ["POST", "/api/incubator"],
      ["POST", "/api/tailchan/send"],
      ["POST", "/api/people/add"],
      ["GET", "/library/manifest"],
      ["GET", "/api/library"],
      ["PUT", "/api/tree"],
    ] as const) {
      expect(scopeRule(m, p)).toBeNull();
    }
  });

  test("the board's lists are filters, and each has a cut", () => {
    expect(scopeRule("POST", "/api/rescan")).toEqual({ hold: "filter" });
    for (const p of ["/api/tree", "/api/runs", "/api/flows", "/api/fleets", "/api/jobs", "/api/terms", "/api/terms/kept", "/api/tasks", "/api/trees", "/api/people", "/api/people/activity", "/api/devices", "/api/helpers", "/api/events"]) {
      expect(scopeRule("GET", p)).toEqual({ hold: "filter" });
      expect(hasCut(p)).toBe(true);
    }
    for (const key of SCOPED_ROUTES) {
      const [m = "", p = ""] = key.split(" ");
      if (scopeRule(m, p)?.hold === "filter") expect(hasCut(p)).toBe(true);
    }
  });

  test("a HEAD is its GET, and a trailing slash changes nothing", () => {
    expect(scopeRule("HEAD", "/api/tree")).toEqual({ hold: "filter" });
    expect(scopeRule("GET", "/api/tree/")).toEqual({ hold: "filter" });
  });

  test("a repo's reads and writes name it in the query, and only the filed actions pass", () => {
    const held = { hold: "ids", from: "query", keys: ["id"], maybe: [], self: false, fresh: false } as const;
    expect(scopeRule("GET", "/api/repos/diff")).toEqual(held);
    expect(scopeRule("POST", "/api/repos/commit")).toEqual(held);
    // a read is not a write, and the other way round
    expect(scopeRule("POST", "/api/repos/diff")).toBeNull();
    expect(scopeRule("GET", "/api/repos/archive")).toBeNull();
    for (const a of ["archive", "movein", "elsewhere", "coordinate", "open", "openfile", "note", "launch", "install", "access", "understand"]) expect(scopeRule("POST", `/api/repos/${a}`)).toBeNull();
  });

  test("no filed repo action needs more than a member holds", () => {
    for (const a of SCOPED_REPO_READS) expect(["read", "operate"]).toContain(needs("GET", `/api/repos/${a}`));
    for (const a of SCOPED_REPO_WRITES) expect(["read", "operate", "shell"]).toContain(needs("POST", `/api/repos/${a}`));
    for (const key of SCOPED_ROUTES) {
      const [m = "", p = ""] = key.split(" ");
      expect(needs(m, p)).not.toBe("admin");
    }
  });

  test("a run read by its id carries the id in the path", () => {
    expect(scopeRule("GET", "/api/runs/r123")).toEqual({ hold: "ids", from: "path", id: "r123" });
    expect(scopeRule("GET", "/api/runs/r123/export")).toEqual({ hold: "ids", from: "path", id: "r123" });
    expect(scopeRule("POST", "/api/runs/r123")).toBeNull();
    expect(scopeRule("GET", "/api/runs/r123/else")).toBeNull();
  });

  test("a shell's socket names its repo, and a shell it joins only when canopy knows it", () => {
    expect(scopeRule("GET", "/api/term")).toEqual({ hold: "ids", from: "query", keys: ["id"], maybe: ["term"], self: false, fresh: false });
    // asking whether a shell runs an agent names one a panel has not started yet
    expect(scopeRule("GET", "/api/terms/agent")).toEqual({ hold: "ids", from: "query", keys: ["term"], maybe: [], self: false, fresh: true });
  });

  test("every route an agent's token reaches is filed, or closed on purpose", () => {
    for (const lane of Object.values(LANES)) {
      for (const key of lane) {
        const [m = "", p = ""] = key.split(" ");
        const filed = scopeRule(m, p) !== null || needs(m, p) === "open";
        expect([key, filed || SCOPE_LANE_CLOSED.includes(key)]).toEqual([key, true]);
      }
    }
    for (const key of SCOPE_LANE_CLOSED) {
      const [m = "", p = ""] = key.split(" ");
      expect(scopeRule(m, p)).toBeNull();
    }
  });

  test("a run that coordinates others is refused by its body", () => {
    expect(scopeBodyRefusal("POST", "/api/repos/run", { action: "coordinate" })).toContain("coordinator");
    expect(scopeBodyRefusal("POST", "/api/repos/run", { action: "fix" })).toBeNull();
    expect(scopeBodyRefusal("POST", "/api/repos/flow", { action: "coordinate" })).toBeNull();
    expect(scopeBodyRefusal("POST", "/api/repos/run", null)).toBeNull();
  });

  test("a run's token names its own run without saying it", () => {
    expect(scopeRule("POST", "/api/runs/say")).toEqual({ hold: "ids", from: "body", keys: ["id"], maybe: [], self: true, fresh: false });
    expect(scopeRule("POST", "/api/runs/child")).toEqual({ hold: "ids", from: "body", keys: ["parent"], maybe: ["repo"], self: true, fresh: false });
  });
});

describe("cutting an answer", () => {
  const scan = {
    root: "/srv",
    scannedAt: 1,
    backend: {},
    repos,
    sources: [
      { kind: "local", path: "/srv", id: "launch", label: "srv", launch: true, repos: 4, scannedAt: 1 },
      { kind: "local", path: "/srv/rio/web", id: "web", label: "web", launch: false, repos: 1, scannedAt: 1 },
      { kind: "local", path: "/srv/lab", id: "lab", label: "lab", launch: false, repos: 1, scannedAt: 1 },
      { kind: "ssh", host: "box", path: "/srv/rio", id: "box", label: "box", launch: false, repos: 3, scannedAt: 1 },
    ],
  } as unknown as ScanResult;

  test("a scan keeps the scope's repos and the sources they sit in", () => {
    const cut = cutScan(scan, view);
    expect(cut.repos.map((r) => r.id)).toEqual(["app", "site"]);
    expect(cut.sources.map((s) => [s.id, s.repos])).toEqual([
      ["launch", 2],
      ["web", 1],
    ]);
  });

  test("a list keeps the records that name a repo of the scope", () => {
    const list = [{ id: "r1", repoId: "app" }, { id: "r2", repoId: "tool" }, { id: "k1", repo: "site" }, { id: "x" }, "junk", null];
    expect(scopeAnswer("/api/runs", list, view)).toEqual([
      { id: "r1", repoId: "app" },
      { id: "k1", repo: "site" },
    ]);
    expect(scopeAnswer("/api/flows", { not: "a list" }, view)).toEqual([]);
    // a fleet is theirs only when every repo it runs over is
    const fleets = [{ id: "f1", repos: [{ repoId: "app" }, { repoId: "site" }] }, { id: "f2", repos: [{ repoId: "app" }, { repoId: "tool" }] }, { id: "f3", repos: [] }];
    expect(scopeAnswer("/api/fleets", fleets, view)).toEqual([fleets[0]]);
    expect(scopeAnswer("/api/jobs", [{ id: "j1", repoId: "tool" }, { id: "j2", repoId: "site" }], view)).toEqual([{ id: "j2", repoId: "site" }]);
    // the machines that open things are an admin's to use
    expect(scopeAnswer("/api/helpers", [{ name: "mac", platform: "darwin", openers: [] }], view)).toEqual([]);
    expect(scopeAnswer("/api/rescan", { root: "/srv", repos, sources: [] }, view)).toMatchObject({ repos: [{ id: "app" }, { id: "site" }] });
    expect(scopeAnswer("/api/terms/kept", { keeping: true, kept: [{ id: "a", repoId: "tool" }, { id: "b", repoId: "app" }] }, view)).toEqual({ keeping: true, kept: [{ id: "b", repoId: "app" }] });
    expect(scopeAnswer("/api/trees", { root: "/t", ports: "", repos: [{ repoId: "tool", trees: [] }, { repoId: "site", trees: [] }] }, view)).toEqual({ root: "/t", ports: "", repos: [{ repoId: "site", trees: [] }] });
  });

  test("an answer of the wrong shape comes back empty or closed, never whole", () => {
    expect(scopeAnswer("/api/tree", { repos: "all of them" }, view)).toBeNull();
    expect(scopeAnswer("/api/people", "x", view)).toEqual({ people: [], teams: [], invites: [] });
    expect(scopeAnswer("/api/people/activity", [], view)).toEqual({ lines: [] });
    // a route with no cut answers nothing
    expect(scopeAnswer("/api/landing", { queue: [1] }, view)).toBeNull();
  });

  const info: PeopleInfo = {
    people: [
      { id: "owner", name: "Eric", role: "owner", teams: [], created: 0, devices: [{ id: "d1", name: "Mac", platform: "mac" }], at: ["tool", "app"], invited: 0 },
      { id: "p-averyave", name: "Avery", role: "member", teams: [RIO.id], created: 1, devices: [], at: ["site"], invited: 1 },
      { id: "p-emmaemma", name: "Emma", role: "member", teams: [LAB.id, RIO.id], created: 1, devices: [], at: ["tool"], invited: 2 },
    ],
    teams: [RIO, LAB],
  };

  test("the roster keeps everyone's name, and only the scope's places and teams", () => {
    const cut = cutPeople(info, view);
    expect(cut.teams).toEqual([RIO]);
    expect(cut.people.map((p) => [p.name, p.at, p.teams, p.invited])).toEqual([
      ["Eric", ["app"], [], 0],
      ["Avery", ["site"], [RIO.id], 1],
      ["Emma", [], [RIO.id], 0],
    ]);
    expect(scopeAnswer("/api/people", { ...info, invites: [{ person: "p-emmaemma" }] }, view)).toEqual({ ...cut, invites: [] });
  });

  test("who did what keeps the caller's own lines and those in their repos", () => {
    const lines: ActivityLine[] = [
      { at: 1, person: "owner", kind: "page", what: "pushed", repo: "tool" },
      { at: 2, person: "owner", kind: "page", what: "pushed", repo: "app" },
      { at: 3, person: "p-averyave", kind: "cli", what: "changed a setting" },
      { at: 4, person: "owner", kind: "page", what: "added a person" },
      // another team's repo that shares a name: the id decides
      { at: 5, person: "owner", kind: "page", what: "pushed", repo: "app", repoId: "app-lab" },
      { at: 6, person: "owner", kind: "page", what: "pushed", repo: "app", repoId: "app" },
    ];
    expect(cutActivity(lines, view).map((l) => l.at)).toEqual([2, 3, 6]);
    expect(scopeAnswer("/api/people/activity", { lines }, view)).toEqual({ lines: [lines[1], lines[2], lines[5]] });
  });
});

describe("cutting the event stream", () => {
  // each stand-in carries only what the cut reads
  const ev = (e: unknown): ServerEvent => e as ServerEvent;

  test("a repo's, a run's, a flow's and a task list's event passes only for a repo of the scope", () => {
    expect(scopeEvent(ev({ type: "repo", repo: repos[0] }), view)).not.toBeNull();
    expect(scopeEvent(ev({ type: "repo", repo: repos[2] }), view)).toBeNull();
    expect(scopeEvent(ev({ type: "run", run: { id: "r", repoId: "site" } }), view)).not.toBeNull();
    expect(scopeEvent(ev({ type: "run", run: { id: "r", repoId: "tool" } }), view)).toBeNull();
    expect(scopeEvent(ev({ type: "flow", flow: { id: "f", repoId: "tool" } }), view)).toBeNull();
    expect(scopeEvent(ev({ type: "tasks", repoId: "tool", tasks: [] }), view)).toBeNull();
    expect(scopeEvent(ev({ type: "tasks", repoId: "app", tasks: [] }), view)).not.toBeNull();
    expect(scopeEvent(ev({ type: "run-gone", id: "r" }), view)).toEqual(ev({ type: "run-gone", id: "r" }));
    expect(scopeEvent(ev({ type: "job", job: { id: "j", repoId: "tool" } }), view)).toBeNull();
    expect(scopeEvent(ev({ type: "job", job: { id: "j", repoId: "app" } }), view)).not.toBeNull();
    expect(scopeEvent(ev({ type: "fleet", fleet: { id: "f", repos: [{ repoId: "app" }, { repoId: "tool" }] } }), view)).toBeNull();
    expect(scopeEvent(ev({ type: "fleet", fleet: { id: "f", repos: [{ repoId: "app" }] } }), view)).not.toBeNull();
  });

  test("a whole list is cut down", () => {
    expect(scopeEvent(ev({ type: "terms", terms: [{ id: "a", repoId: "tool" }, { id: "b", repoId: "app" }] }), view)).toEqual(ev({ type: "terms", terms: [{ id: "b", repoId: "app" }] }));
    expect(scopeEvent(ev({ type: "kept", kept: [{ id: "a", repoId: "tool" }] }), view)).toEqual(ev({ type: "kept", kept: [] }));
    expect(scopeEvent(ev({ type: "trees", trees: { root: "/t", ports: "", repos: [{ repoId: "tool" }, { repoId: "app" }] } }), view)).toEqual(ev({ type: "trees", trees: { root: "/t", ports: "", repos: [{ repoId: "app" }] } }));
    expect(scopeEvent(ev({ type: "devices", devices: [{ id: "d1" }, { id: "d2", person: "p-averyave" }, { id: "d3", person: "p-emmaemma" }] }), view)).toEqual(ev({ type: "devices", devices: [{ id: "d2", person: "p-averyave" }] }));
    const scanned = scopeEvent(ev({ type: "scan", result: { root: "/srv", repos, sources: [] } }), view);
    expect(scanned?.type === "scan" ? scanned.result.repos.map((r) => r.id) : null).toEqual(["app", "site"]);
    const people = scopeEvent(ev({ type: "people", people: [], teams: [RIO, LAB] }), view);
    expect(people?.type === "people" ? people.teams : null).toEqual([RIO]);
  });

  test("every other event is closed to a scoped stream", () => {
    for (const type of ["workspaces", "agents", "incubator", "advice", "landing", "worktrees", "prs", "scenarios", "work", "notes", "clips", "triggers", "auth", "stages", "builds", "launchers", "remembered", "helpers", "peers", "chan", "registry", "asks", "ranger", "sweep", "health", "capacity", "kit", "secrets", "awake", "pulse"]) {
      expect(scopeEvent(ev({ type }), view)).toBeNull();
    }
  });
});
