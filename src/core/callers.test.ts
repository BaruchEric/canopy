import { describe, expect, test } from "bun:test";
import { allows, needs } from "./callers";

describe("needs", () => {
  test("a GET needs read, bar the two upgrades and the Library", () => {
    for (const p of ["/api/runs", "/api/repos", "/api/events"]) {
      expect(needs("GET", p)).toBe("read");
    }
    expect(needs("GET", "/api/term")).toBe("shell");
    expect(needs("GET", "/api/helper")).toBe("helper");
    expect(needs("GET", "/library/open")).toBe("admin");
  });

  test("each read-only Library path is read", () => {
    for (const p of [
      "/api/library",
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
      expect(needs("GET", p)).toBe("read");
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

  test("repos actions key on the action", () => {
    for (const a of ["run", "pull", "commit", "flow", "refresh"]) {
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
    expect(needs("POST", "/api/ranger/wakes")).toBe("operate");
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

  test("POSTs that change nothing need read", () => {
    expect(needs("POST", "/api/grep")).toBe("read");
    expect(needs("POST", "/api/remembered/check")).toBe("read");
  });

  test("the ticket route is open to the table because it checks its own right", () => {
    expect(needs("POST", "/api/auth/ticket")).toBe("open");
  });

  test("admin rows and the default", () => {
    expect(needs("POST", "/api/agents/role")).toBe("admin");
    expect(needs("POST", "/api/agents/profile")).toBe("admin");
    expect(needs("POST", "/api/peers/sync")).toBe("admin");
    expect(needs("DELETE", "/api/sources")).toBe("admin");
    expect(needs("POST", "/api/kit/install")).toBe("admin");
    expect(needs("POST", "/api/secrets/set")).toBe("admin");
    expect(needs("POST", "/api/ranger/restart")).toBe("admin");
    expect(needs("PUT", "/api/guards")).toBe("admin");
    expect(needs("POST", "/api/auth/approve")).toBe("admin");
    expect(needs("POST", "/api/made-up")).toBe("admin");
    expect(needs("PUT", "/api/runs")).toBe("admin");
    expect(needs("POST", "/library/refresh")).toBe("admin");
    expect(needs("POST", "/api/library/refresh")).toBe("admin");
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
      ["POST", "/api/runs/say"],
      ["POST", "/api/runs/stop"],
      ["POST", "/api/runs/answer"],
      ["POST", "/api/asks/answer"],
      ["POST", "/api/landing/land"],
      ["POST", "/api/landing/fix"],
      ["POST", "/api/auth/approve"],
    ];
    for (const [m, p] of refused) expect([m, p, allows("coordinator", needs(m, p))]).toEqual([m, p, false]);
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
    expect(allows("none", "read")).toBe(true);
    expect(allows("none", "operate")).toBe(false);
    expect(allows("helper", "helper")).toBe(true);
    expect(allows("helper", "read")).toBe(false);
  });

  test("open is allowed to every kind", () => {
    expect(allows("none", "open")).toBe(true);
  });
});
