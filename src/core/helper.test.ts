import { describe, expect, test } from "bun:test";
import {
  HELPER_DEAD,
  helperOpeners,
  helperRefusal,
  parseDefaultGateway,
  parseHelperIntent,
  parseHelperQuery,
  parseHelperReply,
  reachFrom,
  staleHelpers,
} from "./helper";
import { helperUrl } from "./helperd";
import { DEFAULT_AGENT, type AgentSettings } from "./types";

describe("parseHelperQuery", () => {
  test("reads a registration off the query", () => {
    const q = new URLSearchParams("name=eric-mbp&platform=darwin&openers=kitty,terminal,code,finder,agent");
    expect(parseHelperQuery(q, "100.72.29.68", 5)).toEqual({
      name: "eric-mbp",
      platform: "darwin",
      openers: ["kitty", "terminal", "code", "finder", "agent"],
      since: 5,
      address: "100.72.29.68",
    });
  });

  test("a helper with nothing to open still registers", () => {
    const q = new URLSearchParams("name=box&platform=linux");
    expect(parseHelperQuery(q, "a", 1)).toEqual({ name: "box", platform: "linux", openers: [], since: 1, address: "a" });
  });

  test("drops a repeated opener and blank entries", () => {
    const q = new URLSearchParams("name=a&platform=linux&openers=kitty,,kitty, code ");
    const r = parseHelperQuery(q, "a", 0);
    expect("error" in r ? r.error : r.openers).toEqual(["kitty", "code"]);
  });

  test("the harnesses it can start; a helper older than harnesses says none, and an unknown one is passed over", () => {
    const q = (extra: string) => new URLSearchParams(`name=a&platform=darwin&openers=agent${extra}`);
    expect(parseHelperQuery(q("&harnesses=claude,codex"), "x", 1)).toMatchObject({ harnesses: ["claude", "codex"] });
    expect(parseHelperQuery(q("&harnesses=codex,gemini"), "x", 1)).toMatchObject({ harnesses: ["codex"] });
    expect(parseHelperQuery(q("&harnesses="), "x", 1)).toMatchObject({ harnesses: [] });
    expect(parseHelperQuery(q(""), "x", 1)).not.toHaveProperty("harnesses");
    // this helper says so when it dials
    expect(new URL(helperUrl("http://mini:7850", "mbp", "darwin", ["agent"])).searchParams.get("harnesses")).toBe("claude,codex");
  });

  test("refuses a bad name, platform or opener", () => {
    expect(parseHelperQuery(new URLSearchParams("platform=darwin"), "a")).toHaveProperty("error");
    expect(parseHelperQuery(new URLSearchParams("name=a%20b&platform=darwin"), "a")).toHaveProperty("error");
    expect(parseHelperQuery(new URLSearchParams(`name=${"x".repeat(65)}&platform=darwin`), "a")).toHaveProperty("error");
    expect(parseHelperQuery(new URLSearchParams("name=a&platform=Mac%20OS"), "a")).toHaveProperty("error");
    expect(parseHelperQuery(new URLSearchParams("name=a&platform=darwin&openers=emacs"), "a")).toEqual({
      error: "openers= names an opener canopy does not know: emacs",
    });
  });
});

describe("parseHelperReply", () => {
  test("ok and error frames", () => {
    expect(parseHelperReply('{"id":3,"ok":true}')).toEqual({ id: 3, ok: true });
    expect(parseHelperReply('{"id":4,"error":"no kitty"}')).toEqual({ id: 4, error: "no kitty" });
  });

  test("clips a long error", () => {
    const r = parseHelperReply(JSON.stringify({ id: 1, error: "e".repeat(900) }));
    expect(r && "error" in r ? r.error.length : 0).toBe(500);
  });

  test("null for anything else", () => {
    expect(parseHelperReply("nope")).toBeNull();
    expect(parseHelperReply("[]")).toBeNull();
    expect(parseHelperReply('{"id":"3","ok":true}')).toBeNull();
    expect(parseHelperReply('{"id":3}')).toBeNull();
    expect(parseHelperReply('{"id":1.5,"ok":true}')).toBeNull();
  });
});

describe("parseHelperIntent", () => {
  test("open, with the agent settings normalized", () => {
    const text = JSON.stringify({ id: 1, open: { app: "kitty", path: "ssh://mini/home/eric/dev/x", agent: { model: "opus", yolo: "yes" }, tab: true } });
    expect(parseHelperIntent(text)).toEqual({
      id: 1,
      open: { app: "kitty", path: "ssh://mini/home/eric/dev/x", agent: { ...DEFAULT_AGENT, model: "opus" }, tab: true },
    });
  });

  test("open without settings gets the defaults and tab off", () => {
    expect(parseHelperIntent('{"id":2,"open":{"app":"code","path":"/r"}}')).toEqual({
      id: 2,
      open: { app: "code", path: "/r", agent: { ...DEFAULT_AGENT }, tab: false },
    });
  });

  test("file, with a bad line falling to 1", () => {
    expect(parseHelperIntent('{"id":3,"file":{"path":"/r","file":"a.ts","line":12}}')).toEqual({
      id: 3,
      file: { path: "/r", file: "a.ts", line: 12 },
    });
    expect(parseHelperIntent('{"id":3,"file":{"path":"/r","file":"a.ts","line":-1}}')).toEqual({
      id: 3,
      file: { path: "/r", file: "a.ts", line: 1 },
    });
  });

  test("group, with each repo's settings normalized", () => {
    const text = JSON.stringify({
      id: 4,
      group: { app: "kitty", name: "web", repos: ["/a", "/b"], agents: { "/a": { effort: "high" }, "/b": 7 } },
    });
    expect(parseHelperIntent(text)).toEqual({
      id: 4,
      group: {
        app: "kitty",
        name: "web",
        repos: ["/a", "/b"],
        agents: { "/a": { ...DEFAULT_AGENT, effort: "high" }, "/b": { ...DEFAULT_AGENT } },
      },
    });
  });

  test("null for a malformed frame", () => {
    expect(parseHelperIntent("{")).toBeNull();
    expect(parseHelperIntent('{"open":{"app":"kitty","path":"/r"}}')).toBeNull();
    expect(parseHelperIntent('{"id":1,"open":{"app":"emacs","path":"/r"}}')).toBeNull();
    expect(parseHelperIntent('{"id":1,"file":{"path":"/r"}}')).toBeNull();
    expect(parseHelperIntent('{"id":1,"group":{"app":"kitty","name":"n","repos":["/a",1]}}')).toBeNull();
    expect(parseHelperIntent('{"id":1,"stop":true}')).toBeNull();
  });
});

describe("helperOpeners", () => {
  test("a bare Mac has Terminal, Finder and the agent through Terminal", () => {
    expect(helperOpeners("darwin", () => false)).toEqual(["terminal", "finder", "agent"]);
  });

  test("a full Mac has everything, in the menu's order", () => {
    expect(helperOpeners("darwin", () => true)).toEqual(["kitty", "terminal", "code", "finder", "agent", "herdr"]);
  });

  test("linux needs kitty for a shell and the agent, xdg-open for the folder", () => {
    expect(helperOpeners("linux", (n) => n === "kitty")).toEqual(["kitty", "agent"]);
    expect(helperOpeners("linux", (n) => n === "code" || n === "xdg-open")).toEqual(["code", "finder"]);
    expect(helperOpeners("linux", () => false)).toEqual([]);
  });

  test("an unknown platform offers nothing", () => {
    expect(helperOpeners("win32", () => true)).toEqual([]);
  });
});

describe("reachFrom", () => {
  test("a backend-local repo is reached over the backend's ssh alias", () => {
    expect(reachFrom("/home/eric/dev/x", "macmini-2018")).toBe("ssh://macmini-2018/home/eric/dev/x");
  });

  test("a repo on another host keeps its own locator", () => {
    expect(reachFrom("ssh://qnap/share/r", "macmini-2018")).toBe("ssh://qnap/share/r");
    expect(reachFrom("ssh://qnap/share/r", null)).toBe("ssh://qnap/share/r");
  });

  test("without an alias a local repo cannot be reached", () => {
    expect(reachFrom("/home/eric/dev/x", null)).toHaveProperty("error");
    expect(reachFrom("/home/eric/dev/x", "")).toHaveProperty("error");
  });
});

describe("parseDefaultGateway", () => {
  test("reads the default route's gateway out of /proc/net/route", () => {
    const text = [
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
      "eth0\t00000000\t0130A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0",
      "eth0\t0030A8C0\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0",
    ].join("\n");
    expect(parseDefaultGateway(text)).toBe("192.168.48.1");
  });

  test("null without a default route or with nothing to read", () => {
    expect(parseDefaultGateway("Iface\tDestination\tGateway\neth0\t0030A8C0\t00000000\t0001")).toBeNull();
    expect(parseDefaultGateway("")).toBeNull();
  });
});

describe("staleHelpers", () => {
  const peers = [
    { name: "mbp", seen: 1_000 },
    { name: "notebook", seen: 1_000 + HELPER_DEAD },
  ];

  test("names the peers not heard from inside the deadline", () => {
    expect(staleHelpers(peers, 1_000 + HELPER_DEAD)).toEqual([]);
    expect(staleHelpers(peers, 1_001 + HELPER_DEAD)).toEqual(["mbp"]);
    expect(staleHelpers(peers, 1_001 + HELPER_DEAD * 2)).toEqual(["mbp", "notebook"]);
  });

  test("takes its own deadline, and nothing is stale in an empty list", () => {
    expect(staleHelpers(peers, 1_100, 50)).toEqual(["mbp"]);
    expect(staleHelpers([], Date.now())).toEqual([]);
  });
});

describe("helperRefusal", () => {
  const codex: AgentSettings = { ...DEFAULT_AGENT, harness: "codex", extra: "--search" };
  const open = (app: "agent" | "herdr" | "kitty", agent: AgentSettings = codex) => ({ open: { app, path: "ssh://mini/r", agent, tab: false } });

  test("a helper older than harnesses is not sent a codex start: it would run claude with codex's flags", () => {
    const old = { name: "mbp" };
    expect(helperRefusal(old, open("agent"))).toBe(
      "the helper on mbp is older than codex support and would start claude in its place: update canopy there and restart canopy helper",
    );
    expect(helperRefusal(old, open("herdr"))).toContain("older than codex support");
    expect(helperRefusal(old, { group: { app: "agent", name: "w", repos: ["a", "b"], agents: { a: DEFAULT_AGENT, b: codex } } })).toContain("older");
    // claude it always ran, and an opener that starts no agent reads no harness
    expect(helperRefusal(old, open("agent", DEFAULT_AGENT))).toBeNull();
    expect(helperRefusal(old, open("kitty"))).toBeNull();
    expect(helperRefusal(old, { group: { app: "kitty", name: "w", repos: ["a"], agents: { a: codex } } })).toBeNull();
    expect(helperRefusal(old, { file: { path: "/r", file: "a.ts", line: 1 } })).toBeNull();
  });

  test("a helper that names the harness is sent it", () => {
    expect(helperRefusal({ name: "mbp", harnesses: ["claude", "codex"] }, open("agent"))).toBeNull();
    expect(helperRefusal({ name: "mbp", harnesses: ["claude"] }, open("agent"))).toBe("the helper on mbp cannot start codex");
  });
});
