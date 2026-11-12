import { describe, expect, test } from "bun:test";
import { allows, isPerson, KIND_RIGHTS, LANES, needs, PAIR_KINDS, type CallerKind } from "./callers";

describe("needs", () => {
  test("a GET needs read, bar the two upgrades and the Library", () => {
    for (const p of ["/api/runs", "/api/repos", "/api/events", "/api/capacity"]) {
      expect(needs("GET", p)).toBe("read");
    }
    expect(needs("GET", "/api/term")).toBe("shell");
    expect(needs("GET", "/api/helper")).toBe("helper");
    expect(needs("GET", "/library/open")).toBe("admin");
  });

  test("the capacity routes: reading now and a release operate, the thresholds are the admin's (FR-036)", () => {
    expect([needs("POST", "/api/capacity/read"), needs("POST", "/api/capacity/release"), needs("POST", "/api/capacity")]).toEqual(["operate", "operate", "admin"]);
    expect(allows("shell", needs("POST", "/api/capacity/release"))).toBe(true);
    expect(allows("shell", needs("POST", "/api/capacity"))).toBe(false);
  });

  test("the push routes (FR-042): a browser subscribes with operate, the list and a test push are the admin's, the key is a read", () => {
    expect(needs("POST", "/api/push/subscribe")).toBe("operate");
    expect(needs("DELETE", "/api/push/subscribe")).toBe("operate");
    expect(needs("POST", "/api/push/test")).toBe("admin");
    expect(needs("GET", "/api/push")).toBe("admin");
    expect(needs("GET", "/api/push/key")).toBe("read");
    // the table lets a shell's operate through; the handler then wants the
    // token's kind to be page, the first route to look at the kind
    expect(allows("shell", needs("POST", "/api/push/subscribe"))).toBe(true);
    expect(allows("shell", needs("POST", "/api/push/test"))).toBe(false);
  });

  test("each read-only Library path is open, since a frame's load carries no token", () => {
    for (const p of [
      "/api/library",
      "/api/library/sync",
      "/api/library/sync/status",
      "/library",
      "/library/",
      "/library/index.html",
      "/library/ports",
      "/library/ping",
      "/library/manifest",
      "/library/api/dev/state",
      "/library/api/ports/state",
      "/library/api/files",
    ]) {
      expect(needs("GET", p)).toBe("open");
    }
  });

  test("a Library GET off the allowlist needs admin", () => {
    for (const p of ["/library/x", "/library/opener", "/library/api/git", "/library/api/library", "/api/library/x"]) {
      expect(needs("GET", p)).toBe("admin");
    }
  });

  test("a Library path that is not already in normal form needs admin", () => {
    for (const p of [
      "/library/open;x",
      "/library//open",
      "/library/open%3Bx",
      "/library/open/",
      "/library/ports;x",
      "/library//ports",
      "/library/ports/",
      "/library/api%2Fdev%2Fstate",
      "/library/%70ing",
      "/library/ping%zz",
    ]) {
      expect(needs("GET", p)).toBe("admin");
    }
  });

  test("a trailing slash is ignored", () => {
    expect(needs("POST", "/api/runs/answer/")).toBe("operate");
  });

  test("a fork of a run starts one, so it operates (FR-043 plan 3)", () => {
    expect(needs("POST", "/api/runs/fork")).toBe("operate");
  });

  test("repos actions key on the action", () => {
    for (const a of ["run", "pull", "commit", "dropstale", "flow", "refresh", "harness"]) {
      expect(needs("POST", `/api/repos/${a}`)).toBe("operate");
    }
    for (const a of ["peer", "launch", "archive", "build", "launcher"]) {
      expect(needs("POST", `/api/repos/${a}`)).toBe("admin");
    }
    expect(needs("POST", "/api/repos/agent")).toBe("shell");
    expect(needs("POST", "/api/repos/movein")).toBe("shell");
    expect(needs("POST", "/api/repos/movecheck")).toBe("read");
    expect(needs("POST", "/api/repos/tasks/def")).toBe("operate");
    expect(needs("DELETE", "/api/repos/health")).toBe("operate");
  });

  test("operate rows", () => {
    expect(needs("POST", "/api/runs/answer")).toBe("operate");
    expect(needs("DELETE", "/api/runs")).toBe("operate");
    expect(needs("PATCH", "/api/workspaces")).toBe("operate");
    expect(needs("POST", "/api/landing/anything")).toBe("operate");
    expect(needs("POST", "/api/prs/merge")).toBe("operate");
    expect(needs("DELETE", "/api/incubator")).toBe("operate");
    expect(needs("POST", "/api/voice/session")).toBe("operate");
    expect(needs("POST", "/api/voice/live")).toBe("operate");
    expect(needs("POST", "/api/voice/dictate")).toBe("operate");
    expect(needs("POST", "/api/voice/ended")).toBe("operate");
    expect(needs("GET", "/api/costs")).toBe("read");
    expect(needs("GET", "/api/voice")).toBe("read");
    expect(needs("POST", "/api/ranger/wakes")).toBe("plan");
    expect(needs("DELETE", "/api/ranger/wakes")).toBe("operate");
    expect(needs("POST", "/api/runs/say")).toBe("plan");
    // a person's stop of a run's turn, and words or Escape typed into a shell
    expect(needs("POST", "/api/runs/interrupt")).toBe("operate");
    expect(needs("POST", "/api/terms/say")).toBe("shell");
    expect(needs("POST", "/api/terms/keys")).toBe("shell");
    expect(needs("POST", "/api/runs/child")).toBe("plan");
    expect(needs("POST", "/api/work/note")).toBe("plan");
    expect(needs("POST", "/api/work/close")).toBe("operate");
    expect(needs("POST", "/api/tailchan/send")).toBe("operate");
    expect(needs("POST", "/api/presence/beat")).toBe("operate");
    expect(needs("POST", "/api/layouts/reset")).toBe("operate");
    expect(needs("POST", "/api/rescan")).toBe("operate");
    expect(needs("POST", "/api/preview")).toBe("operate");
  });

  test("shell rows", () => {
    expect(needs("POST", "/api/terms/restore")).toBe("shell");
    expect(needs("POST", "/api/terms/move/finish")).toBe("shell");
    expect(needs("DELETE", "/api/terms")).toBe("shell");
    expect(needs("DELETE", "/api/terms/kept")).toBe("shell");
  });

  test("a move's check needs a token; a hook's rule check is open, since a terminal outside canopy has none", () => {
    expect(needs("POST", "/api/repos/movecheck")).toBe("read");
    expect(needs("POST", "/api/remembered/check")).toBe("open");
  });

  test("the ticket route is open to the table because it checks its own right", () => {
    expect(needs("POST", "/api/auth/ticket")).toBe("open");
  });

  test("admin rows and the default", () => {
    expect(needs("POST", "/api/agents/role")).toBe("admin");
    expect(needs("POST", "/api/agents/profile")).toBe("admin");
    expect(needs("POST", "/api/peers/sync")).toBe("admin");
    // keep awake holds the machine out of sleep: never an agent's call
    expect(needs("POST", "/api/awake")).toBe("admin");
    expect(needs("GET", "/api/awake")).toBe("read");
    expect(needs("DELETE", "/api/sources")).toBe("admin");
    expect(needs("POST", "/api/kit/install")).toBe("admin");
    // a plugin op runs the agent's CLI and can start a marketplace's command; a catalog read runs it too
    expect(needs("POST", "/api/kit/plugins")).toBe("admin");
    expect(needs("GET", "/api/kit/plugins/catalog")).toBe("operate");
    expect(needs("GET", "/api/kit/plugins/details")).toBe("operate");
    // a commit's preview reads key names; the commit itself pushes dotclaude
    expect(needs("GET", "/api/kit/plugins/commit")).toBe("operate");
    expect(needs("POST", "/api/kit/plugins/commit")).toBe("admin");
    expect(needs("POST", "/api/secrets/set")).toBe("admin");
    expect(needs("POST", "/api/ranger/restart")).toBe("admin");
    expect(needs("PUT", "/api/guards")).toBe("admin");
    expect(needs("POST", "/api/auth/approve")).toBe("admin");
    expect(needs("POST", "/api/made-up")).toBe("admin");
    expect(needs("PUT", "/api/runs")).toBe("admin");
    expect(needs("POST", "/library/refresh")).toBe("admin");
    expect(needs("POST", "/api/library/refresh")).toBe("admin");
    // a join or a pull changes the Library's files
    expect(needs("POST", "/api/library/sync")).toBe("admin");
  });

  test("pairing routes are open", () => {
    for (const a of ["pair", "claim", "first"]) expect(needs("POST", `/api/auth/${a}`)).toBe("open");
  });

  test("a trigger's hook is open, since it checks the sender's signature itself", () => {
    expect(needs("POST", "/api/hooks/sentry/shop")).toBe("open");
    expect(needs("GET", "/api/hooks/sentry/shop")).toBe("read");
    expect(needs("POST", "/api/hooksx")).toBe("admin");
  });

  test("acting on a trigger's events operates", () => {
    for (const a of ["fire", "resume", "retry", "stop"]) expect(needs("POST", `/api/triggers/${a}`)).toBe("operate");
    expect(needs("DELETE", "/api/triggers/events")).toBe("operate");
  });

  test("scenario routes: the set's text needs admin, names read, a run operate", () => {
    expect(needs("GET", "/api/scenarios")).toBe("admin");
    expect(needs("GET", "/api/scenarios/names")).toBe("read");
    expect(needs("POST", "/api/scenarios")).toBe("admin");
    expect(needs("DELETE", "/api/scenarios")).toBe("admin");
    expect(needs("POST", "/api/scenarios/run")).toBe("operate");
    expect(allows("shell", needs("GET", "/api/scenarios"))).toBe(false);
    expect(allows("shell", needs("GET", "/api/scenarios/names"))).toBe(true);
    expect(allows("shell", needs("POST", "/api/scenarios/run"))).toBe(true);
    expect(allows("cli", needs("GET", "/api/scenarios"))).toBe(true);
  });

  test("sweep routes need admin", () => {
    // reads too: the plan names every shell and chat on the backend
    for (const m of ["GET", "POST"]) {
      for (const p of ["/api/sweep", "/api/sweep/", "/api/sweep/settings", "/api/sweep/resume", "/api/sweep/ask"]) expect([m, p, needs(m, p)]).toEqual([m, p, "admin"]);
    }
    expect(needs("DELETE", "/api/sweep/ask")).toBe("admin");
    expect(allows("shell", needs("GET", "/api/sweep"))).toBe(false);
    expect(allows("shell", needs("POST", "/api/sweep"))).toBe(false);
    expect(allows("ranger", needs("POST", "/api/sweep"))).toBe(false);
    expect(allows("cli", needs("POST", "/api/sweep"))).toBe(true);
    // a neighbour's name is not caught by the prefix
    expect(needs("GET", "/api/sweeping")).toBe("read");
  });
});

describe("the coordinator's routes", () => {
  test("a plan needs plan; editing a card and start these need operate", () => {
    expect(needs("POST", "/api/coordinator/plan")).toBe("plan");
    expect(needs("POST", "/api/coordinator/tasks")).toBe("operate");
    expect(needs("POST", "/api/coordinator/start")).toBe("operate");
  });

  test("a coordinator may post a plan and read, and nothing that starts, stops or answers", () => {
    expect(allows("coordinator", needs("POST", "/api/coordinator/plan"))).toBe(true);
    expect(allows("coordinator", needs("GET", "/api/runs"))).toBe(true);
    const refused: [string, string][] = [
      ["POST", "/api/coordinator/tasks"],
      ["POST", "/api/coordinator/start"],
      ["POST", "/api/repos/run"],
      ["POST", "/api/runs/stop"],
      ["POST", "/api/runs/answer"],
      ["POST", "/api/runs/fork"],
      ["POST", "/api/asks/answer"],
      ["POST", "/api/landing/land"],
      ["POST", "/api/landing/fix"],
      ["POST", "/api/auth/approve"],
    ];
    for (const [m, p] of refused) expect([m, p, allows("coordinator", needs(m, p))]).toEqual([m, p, false]);
  });
});

describe("the work ledger's routes", () => {
  test("reads are read, a note plans and a close operates", () => {
    expect(needs("GET", "/api/work")).toBe("read");
    expect(needs("GET", "/api/work/one")).toBe("read");
    expect(needs("POST", "/api/work/note")).toBe("plan");
    expect(needs("POST", "/api/work/close")).toBe("operate");
    expect(allows("shell", needs("POST", "/api/work/note"))).toBe(true);
    expect(allows("coordinator", needs("POST", "/api/work/close"))).toBe(false);
  });
});

describe("the notes' routes (FR-020)", () => {
  test("the list is read; adding, editing, done and delete operate", () => {
    expect(needs("GET", "/api/notes")).toBe("read");
    expect(needs("POST", "/api/notes")).toBe("operate");
    expect(needs("POST", "/api/notes/edit")).toBe("operate");
    expect(needs("POST", "/api/notes/done")).toBe("operate");
    expect(needs("DELETE", "/api/notes")).toBe("operate");
    expect(allows("cli", needs("POST", "/api/notes"))).toBe(true);
    expect(allows("shell", needs("DELETE", "/api/notes"))).toBe(true);
    expect(allows("coordinator", needs("POST", "/api/notes"))).toBe(false);
  });
});

describe("what a shell shows", () => {
  test("its screen, its text and its agent's transcript are a hand's to read, so a caller with no token never sees them", () => {
    for (const p of ["/api/terms/screen", "/api/terms/text", "/api/terms/transcript"]) {
      expect({ p, right: needs("GET", p) }).toEqual({ p, right: "operate" });
      for (const kind of ["page", "cli", "shell", "ranger"] as const) expect({ p, kind, may: allows(kind, needs("GET", p)) }).toEqual({ p, kind, may: true });
      for (const kind of ["none", "run", "coordinator", "helper"] as const) expect({ p, kind, may: allows(kind, needs("GET", p)) }).toEqual({ p, kind, may: false });
    }
  });

  test("a move's plan and transcript go with the move's writes: the page that moves a shell reads them, and no one else", () => {
    for (const p of ["/api/terms/move/plan", "/api/terms/move/transcript"]) {
      expect({ p, right: needs("GET", p) }).toEqual({ p, right: "shell" });
      expect({ p, may: allows("page", needs("GET", p)) }).toEqual({ p, may: true });
      for (const kind of ["none", "cli", "shell", "ranger", "run", "coordinator", "helper"] as const) expect({ p, kind, may: allows(kind, needs("GET", p)) }).toEqual({ p, kind, may: false });
    }
  });

  test("the list of shells and the facts about one are plain reads, which take a token", () => {
    for (const p of ["/api/terms", "/api/terms/kept", "/api/terms/agent"]) {
      expect({ p, right: needs("GET", p) }).toEqual({ p, right: "read" });
      expect({ p, none: allows("none", needs("GET", p)) }).toEqual({ p, none: false });
    }
  });

  test("whether someone is at a shell is one boolean, open to the hook that asks from inside it", () => {
    expect(needs("GET", "/api/terms/watched")).toBe("open");
  });
});

describe("what is in a repo", () => {
  const hands = ["page", "cli", "shell", "ranger"] as const;
  const others = ["none", "run", "coordinator", "helper"] as const;
  const closed = (method: string, p: string): void => {
    expect({ p, right: needs(method, p) }).toEqual({ p, right: "operate" });
    for (const kind of hands) expect({ p, kind, may: allows(kind, needs(method, p)) }).toEqual({ p, kind, may: true });
    for (const kind of others) expect({ p, kind, may: allows(kind, needs(method, p)) }).toEqual({ p, kind, may: false });
  };

  test("a file's bytes, a diff, the log and a search are a hand's to read, so a caller with no token never sees them", () => {
    for (const a of ["raw", "diff", "commit", "log", "ls", "dir", "grep", "search", "mentions", "session", "sessions", "tasks", "tasks/log"]) closed("GET", `/api/repos/${a}`);
  });

  test("a repo read nobody has written yet is closed too, and a trailing slash opens nothing", () => {
    closed("GET", "/api/repos/whatever");
    closed("GET", "/api/repos/raw/");
  });

  test("a search across repos, a landing's diff and the host's folders go the same way", () => {
    closed("POST", "/api/grep");
    closed("GET", "/api/landing/diff");
    closed("GET", "/api/browse");
  });

  test("a run read by its id is its transcript, and so are its export and its replay", () => {
    for (const p of ["/api/runs/r-1a2b3c", "/api/runs/r-1a2b3c/export", "/api/runs/r-1a2b3c/replay"]) closed("GET", p);
  });

  test("the tree, the lists a page loads with and the event stream are plain reads: any token, and no caller without one", () => {
    const plain = ["/api/tree", "/api/runs", "/api/flows", "/api/fleets", "/api/landing", "/api/events", "/api/workspaces", "/api/agents", "/api/jobs", "/api/tasks", "/api/health", "/api/notes", "/api/work", "/api/backends", "/api/registry", "/api/asks", "/api/push/key", "/api/a-read-nobody-wrote-yet"];
    for (const p of plain) {
      expect({ p, right: needs("GET", p) }).toEqual({ p, right: "read" });
      expect({ p, none: allows("none", needs("GET", p)) }).toEqual({ p, none: false });
      expect({ p, helper: allows("helper", needs("GET", p)) }).toEqual({ p, helper: false });
      for (const kind of ["page", "cli", "shell", "ranger", "run", "coordinator"] as const) expect({ p, kind, ok: allows(kind, needs("GET", p)) }).toEqual({ p, kind, ok: true });
    }
  });

  test("no lane names one of them, so a run and a coordinator stay off them on either listener", () => {
    for (const kind of ["run", "coordinator"] as const) {
      const lane = [...(LANES[kind] ?? [])];
      expect({ kind, inside: lane.filter((r) => r.startsWith("GET /api/repos/") || r.startsWith("GET /api/runs/") || r === "POST /api/grep" || r === "GET /api/browse" || r === "GET /api/landing/diff") }).toEqual({ kind, inside: [] });
    }
  });
});

describe("what a caller with no token gets", () => {
  const bare = (method: string, p: string): boolean => allows("none", needs(method, p));

  test("the page's own files, which hold nothing a sign-in guards", () => {
    for (const p of ["/", "/index.html", "/assets/index-abc123.js", "/sw.js", "/manifest.webmanifest", "/icons/icon-192.png", "/some/route/the/page/owns"]) {
      expect({ p, right: needs("GET", p) }).toEqual({ p, right: "open" });
    }
    // anything but a GET outside the API is nobody's
    expect(needs("POST", "/")).toBe("admin");
    expect(needs("DELETE", "/index.html")).toBe("admin");
  });

  test("what signing in needs: who it is, and the three pairing routes", () => {
    expect(bare("GET", "/api/auth")).toBe(true);
    for (const p of ["/api/auth/pair", "/api/auth/claim", "/api/auth/first"]) expect({ p, ok: bare("POST", p) }).toEqual({ p, ok: true });
    for (const p of ["/api/auth/approve", "/api/auth/deny", "/api/auth/revoke"]) expect({ p, ok: bare("POST", p) }).toEqual({ p, ok: false });
  });

  test("the answers a script with no token asks for, and Linear's navigation", () => {
    for (const p of ["/api/about", "/api/going", "/api/terms/watched", "/api/linear/install", "/api/linear/callback"]) {
      expect({ p, right: needs("GET", p) }).toEqual({ p, right: "open" });
    }
    expect(needs("POST", "/api/remembered/check")).toBe("open");
    expect(needs("POST", "/api/hooks/sentry")).toBe("open");
  });

  test("nothing else: no board, no list, no stream, no note, no work item", () => {
    const closed = [
      "/api/tree", "/api/runs", "/api/runs?kept=1", "/api/flows", "/api/fleets", "/api/landing", "/api/events", "/api/notes", "/api/work", "/api/tasks", "/api/jobs",
      "/api/terms", "/api/terms/kept", "/api/terms/agent", "/api/workspaces", "/api/agents", "/api/backends", "/api/peers", "/api/registry", "/api/asks", "/api/ranger",
      "/api/health", "/api/history", "/api/costs", "/api/client", "/api/devices", "/api/helpers", "/api/hosts", "/api/ports", "/api/launchers", "/api/remembered",
      "/api/capacity", "/api/kit", "/api/kit/preview", "/api/secrets", "/api/secrets/audit", "/api/prs", "/api/groups", "/api/incubator", "/api/incubator/one",
      "/api/layouts", "/api/presence", "/api/guards", "/api/push/key", "/api/push", "/api/scenarios/names", "/api/voice", "/api/verdict", "/api/tailchan",
      "/api/tailchan/read", "/api/tailchan/blob", "/api/about/more", "/api/going/more", "/api/authx", "/api/a-read-nobody-wrote-yet",
    ];
    for (const p of closed) expect({ p, ok: bare("GET", p.split("?")[0] ?? p) }).toEqual({ p, ok: false });
    expect(bare("POST", "/api/repos/movecheck")).toBe(false);
    expect(bare("POST", "/api/a-write-nobody-wrote-yet")).toBe(false);
  });

  test("a helper's token reads nothing either: its right is its socket's alone", () => {
    for (const p of ["/api/tree", "/api/runs", "/api/events", "/api/notes"]) expect({ p, ok: allows("helper", needs("GET", p)) }).toEqual({ p, ok: false });
  });
});

describe("what was said on tailchan", () => {
  test("reading it and its files is a hand's, as sending is", () => {
    for (const p of ["/api/tailchan", "/api/tailchan/read", "/api/tailchan/blob"]) {
      expect({ p, right: needs("GET", p) }).toEqual({ p, right: "operate" });
      for (const kind of ["page", "cli", "shell", "ranger"] as const) expect({ p, kind, ok: allows(kind, needs("GET", p)) }).toEqual({ p, kind, ok: true });
      for (const kind of ["none", "run", "coordinator", "helper"] as const) expect({ p, kind, ok: allows(kind, needs("GET", p)) }).toEqual({ p, kind, ok: false });
    }
  });
});

describe("the clipboard's routes (FR-054)", () => {
  test("reading and every change operate, so a caller with no token never sees a clip", () => {
    expect(needs("GET", "/api/clips")).toBe("operate");
    // a read under the prefix is gated too, so a later route there never ships open
    expect(needs("GET", "/api/clips/c-aaaaaaaa")).toBe("operate");
    for (const p of ["/api/clips", "/api/clips/use", "/api/clips/pin", "/api/clips/clear"]) expect(needs("POST", p)).toBe("operate");
    expect(needs("DELETE", "/api/clips")).toBe("operate");
    expect(allows("page", needs("GET", "/api/clips"))).toBe(true);
    expect(allows("shell", needs("POST", "/api/clips"))).toBe(true);
    expect(allows("none", needs("GET", "/api/clips"))).toBe(false);
    expect(allows("run", needs("GET", "/api/clips"))).toBe(false);
    expect(allows("coordinator", needs("POST", "/api/clips"))).toBe(false);
  });
});

describe("allows", () => {
  test("each kind holds what the table gives it", () => {
    expect(allows("page", "shell")).toBe(true);
    expect(allows("page", "admin")).toBe(true);
    expect(allows("cli", "shell")).toBe(false);
    expect(allows("cli", "admin")).toBe(true);
    expect(allows("shell", "admin")).toBe(false);
    expect(allows("shell", "operate")).toBe(true);
    expect(allows("ranger", "operate")).toBe(true);
    expect(allows("coordinator", "plan")).toBe(true);
    expect(allows("coordinator", "operate")).toBe(false);
    expect(allows("none", "read")).toBe(false);
    expect(allows("none", "operate")).toBe(false);
    expect(allows("helper", "helper")).toBe(true);
    expect(allows("helper", "read")).toBe(false);
  });

  test("plan is the coordinator's, and comes with operate", () => {
    for (const kind of ["coordinator", "page", "cli", "shell", "ranger"] as const) expect([kind, allows(kind, "plan")]).toEqual([kind, true]);
    for (const kind of ["none", "helper"] as const) expect([kind, allows(kind, "plan")]).toEqual([kind, false]);
  });

  test("open is allowed to every kind", () => {
    expect(allows("none", "open")).toBe(true);
  });
});

test("group mutations require operate while the group list requires read", () => {
  expect(needs("GET", "/api/groups")).toBe("read");
  for (const action of ["pick", "review", "drop"]) expect(needs("POST", `/api/groups/${action}`)).toBe("operate");
});

test("worktree routes: the listing reads, warm is admin, prune operates", () => {
  expect(needs("GET", "/api/worktrees")).toBe("read");
  expect(needs("POST", "/api/worktrees/warm")).toBe("admin");
  expect(needs("POST", "/api/worktrees/prune")).toBe("operate");
  expect(allows("shell", needs("POST", "/api/worktrees/warm"))).toBe(false);
  expect(allows("shell", needs("POST", "/api/worktrees/prune"))).toBe(true);
  expect(needs("GET", "/api/trees")).toBe("read");
  expect(needs("POST", "/api/trees/add")).toBe("operate");
  expect(needs("POST", "/api/trees/remove")).toBe("operate");
  expect(allows("shell", needs("POST", "/api/trees/add"))).toBe(true);
  expect(allows("cli", needs("POST", "/api/worktrees/warm"))).toBe(true);
});


test("kept runs: the list is open, reading one takes a token, pruning is admin", () => {
  expect(needs("GET", "/api/runs")).toBe("read");
  for (const path of ["/api/runs/ab12cd34", "/api/runs/ab12cd34/export", "/api/runs/ab12cd34/replay"]) expect({ path, right: needs("GET", path) }).toEqual({ path, right: "operate" });
  expect(needs("POST", "/api/runs/prune")).toBe("admin");
  expect(allows("shell", needs("POST", "/api/runs/prune"))).toBe(false);
  expect(allows("cli", needs("POST", "/api/runs/prune"))).toBe(true);
});

describe("a run's token (FR-038)", () => {
  test("holds read and plan, never operate, and is not a kind a pair may ask for", () => {
    expect(KIND_RIGHTS.run).toEqual(["read", "plan"]);
    for (const right of ["operate", "shell", "admin", "helper"] as const) expect([right, allows("run", right)]).toEqual([right, false]);
    expect(PAIR_KINDS).not.toContain("run" as never);
  });
  test("reaches none of what lands, pushes, answers, stops or configures, by the table alone", () => {
    for (const [method, path] of [
      ["POST", "/api/landing/land"],
      ["POST", "/api/prs/open"],
      ["POST", "/api/runs/answer"],
      ["POST", "/api/runs/stop"],
      ["POST", "/api/repos/push"],
      ["POST", "/api/repos/run"],
      ["POST", "/api/agents/profile"],
    ] as const) {
      expect([path, allows("run", needs(method, path))]).toEqual([path, false]);
    }
  });
});

describe("who is a person (FR-066)", () => {
  test("a page and the CLI are; a shell's, the ranger's, a coordinator's, a run's and a helper's tokens are not", () => {
    const kinds: CallerKind[] = ["page", "cli", "shell", "ranger", "coordinator", "run", "helper", "none"];
    expect(kinds.filter((kind) => isPerson({ kind }))).toEqual(["page", "cli"]);
  });

  test("no caller at all counts as one, as it does for every route outside enforce", () => {
    expect(isPerson(null)).toBe(true);
  });
});
