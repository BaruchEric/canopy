import { describe, expect, test } from "bun:test";
import { allows, needs } from "./callers";

describe("needs", () => {
  test("a GET needs read, bar the two upgrades and the Library's /open", () => {
    for (const p of ["/api/runs", "/api/repos", "/api/events", "/library/x", "/api/library", "/library/api/dev/state", "/library/opener"]) {
      expect(needs("GET", p)).toBe("read");
    }
    expect(needs("GET", "/api/term")).toBe("shell");
    expect(needs("GET", "/api/helper")).toBe("helper");
    expect(needs("GET", "/library/open")).toBe("admin");
    expect(needs("GET", "/library/open/")).toBe("admin");
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
    expect(needs("POST", "/api/auth/ticket")).toBe("read");
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
