import { describe, expect, test } from "bun:test";
import type { TriggerEvent } from "../core/trigger";
import { Unreachable, type ask, type Target } from "./health";
import { ISSUES_USAGE, issueLines, issuesCommand } from "./issues";

const ev = (over: Partial<TriggerEvent>): TriggerEvent => ({
  id: "e1",
  rule: "gh",
  source: "github",
  service: "github",
  key: "12",
  short: "#12",
  title: "Login loops",
  note: "",
  repoId: "web/shop",
  workflow: "issue-fix",
  status: "working",
  count: 1,
  firstAt: 1,
  lastAt: 1,
  ...over,
});

describe("issueLines", () => {
  test("nothing taken is no lines", () => {
    expect(issueLines({ events: [] }, null)).toEqual([]);
  });

  test("GitHub and Forgejo rows, newest first under their repo: issue, state, branch, PR and reason", () => {
    const events = [
      ev({ id: "a", status: "review", branch: "br1", pr: { number: 3, url: "u" }, lastAt: 5 }),
      ev({ id: "b", service: "forgejo", source: "forgejo", key: "7", short: "#7", status: "ready", branch: "br2", reason: "main moved under it", lastAt: 9 }),
      ev({ id: "c", key: "13", short: "#13", status: "failed", reason: "no worktree", lastAt: 2, repoId: "web/api" }),
      ev({ id: "s", service: "sentry", source: "sentry", key: "4242", short: "SHOP-1A", status: "merged" }),
      ev({ id: "l", service: "linear", source: "linear", key: "ENG-7", short: "ENG-7", status: "working" }),
    ];
    expect(issueLines({ events }, null)).toEqual([
      "web/api",
      "  #13        failed   -            -      no worktree",
      "web/shop",
      "  #7         ready    br2          -      main moved under it",
      "  #12        review   br1          #3     -",
    ]);
    expect(issueLines({ events }, "web/api", "mini")).toEqual(["web/api on mini", "  #13        failed   -            -      no worktree"]);
    expect(issueLines({ events }, "web/none")).toEqual([]);
  });
});

describe("issuesCommand", () => {
  const lines: string[] = [];
  /** runs `fn` with console.log captured */
  const logging = async (fn: () => Promise<void>): Promise<string[]> => {
    lines.length = 0;
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      await fn();
    } finally {
      console.log = orig;
    }
    return [...lines];
  };
  const fail = (msg: string): never => {
    throw new Error(msg);
  };

  test("asks every backend the home one lists and prints each one's issues, or why it did not answer", async () => {
    const askFake: typeof ask = async <T,>(t: Target, _method: string, path: string): Promise<T> => {
      if (path === "/api/backends") return { self: "home", backends: [{ name: "mini", tailnet: "http://mini:7850" }] } as T;
      if (t.name === "mini") throw new Unreachable("http://mini:7850: ECONNREFUSED");
      return { events: [ev({ status: "working", branch: "br1" })] } as T;
    };
    expect(await logging(() => issuesCommand([], { fail, ask: askFake }))).toEqual([
      "web/shop on home",
      "  #12        working  br1          -      -",
      "mini: did not answer: http://mini:7850: ECONNREFUSED",
    ]);
    // --backend asks that one address alone
    expect(await logging(() => issuesCommand(["--backend", "http://x:1"], { fail, ask: askFake }))).toEqual(["web/shop", "  #12        working  br1          -      -"]);
  });

  test("a backend's refusal is printed as its own line, a repo nobody took says so, and a second word is the usage", async () => {
    const refusing: typeof ask = async <T,>(_t: Target, _method: string, path: string): Promise<T> => {
      if (path === "/api/backends") return { self: "home", backends: [] } as T;
      throw new Error("home refused: it needs the read right");
    };
    expect(await logging(() => issuesCommand([], { fail, ask: refusing }))).toEqual(["home: home refused: it needs the read right", "no GitHub or Forgejo issues taken"]);
    const empty: typeof ask = async <T,>(): Promise<T> => ({ events: [] }) as T;
    expect(await logging(() => issuesCommand(["web/none"], { fail, ask: empty }))).toEqual(["no GitHub or Forgejo issues taken in web/none"]);
    await expect(issuesCommand(["a", "b"], { fail, ask: empty })).rejects.toThrow(ISSUES_USAGE);
  });
});
