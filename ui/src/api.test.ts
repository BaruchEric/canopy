import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Repo, Run } from "../../src/core/types";
import { api, onBackendSignal, readFrame, socketUrl, STREAM_STALE, streamAction } from "./api";
import type { BackendSignal } from "./backends";
import { setBase, setRegistry } from "./registry";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;
const now = 1_000_000;

describe("streamAction", () => {
  test("keeps an open stream that heard something recently", () => {
    expect(streamAction(OPEN, now - 30_000, now, false)).toBe("keep");
    expect(streamAction(OPEN, now - STREAM_STALE, now, false)).toBe("keep");
  });

  test("recycles an open stream that has gone quiet past two pings", () => {
    expect(streamAction(OPEN, now - STREAM_STALE - 1, now, false)).toBe("recycle");
    // a tab back from a night in the background
    expect(streamAction(OPEN, now - 12 * 3_600_000, now, false)).toBe("recycle");
  });

  test("leaves a connecting stream to the browser's own retry", () => {
    expect(streamAction(CONNECTING, now - 12 * 3_600_000, now, false)).toBe("keep");
  });

  test("reopens a stream the browser gave up on, once", () => {
    expect(streamAction(CLOSED, now, now, false)).toBe("reopen");
    expect(streamAction(CLOSED, now, now, true)).toBe("keep");
  });
});

describe("a page with two backends", () => {
  const realFetch = globalThis.fetch;
  interface Call {
    url: string;
    init: RequestInit | undefined;
  }
  let calls: Call[] = [];
  let signals: [string, BackendSignal][] = [];
  /** answers by url: a function of the call, or a thrown error */
  let reply: (c: Call) => Response | Promise<Response> = () => new Response("{}");

  beforeEach(() => {
    calls = [];
    signals = [];
    setRegistry("a", ["a", "b"]);
    setBase("b", "http://b.test");
    onBackendSignal((b, sig) => signals.push([b, sig]));
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const c = { url: String(url), init };
      calls.push(c);
      return reply(c);
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    setRegistry("", [""]);
    setBase("b", "");
    onBackendSignal(() => {});
  });

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const header = (c: Call | undefined, name: string): string | null => new Headers(c?.init?.headers).get(name);
  const run = (id: string, repoId: string) => ({ id, repoId, action: "chat", status: "done" }) as unknown as Run;
  const repo = (id: string) => ({ id, name: id, path: `/x/${id}`, group: "", source: "launch", status: null }) as unknown as Repo;

  test("a foreign repo's call goes to its backend with the plain id, a home one stays relative", async () => {
    reply = () => json([]);
    await api.log("b|x/y");
    await api.log("x/y");
    expect(calls[0]?.url).toBe("http://b.test/api/repos/log?id=x%2Fy");
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(header(calls[0], "Content-Type")).toBeNull();
    expect(calls[1]?.url).toBe("/api/repos/log?id=x%2Fy");
    expect(calls[1]?.init?.credentials).toBeUndefined();
  });

  test("a backend's runs come back under its name, home's as they came", async () => {
    reply = () => json([run("r1", "x")]);
    const foreign = await api.runs("b");
    expect(calls[0]?.url).toBe("http://b.test/api/runs");
    expect(foreign.map((r) => [r.id, r.repoId])).toEqual([["b|r1", "b|x"]]);
    const home = await api.runs();
    expect(calls[1]?.url).toBe("/api/runs");
    expect(home.map((r) => [r.id, r.repoId])).toEqual([["r1", "x"]]);
  });

  test("staging on a foreign repo posts json there and answers its repo qualified", async () => {
    reply = () => json(repo("x"));
    const r = await api.stage("b|x", "f", false);
    expect(calls[0]?.url).toBe("http://b.test/api/repos/stage?id=x");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(header(calls[0], "Content-Type")).toBe("application/json");
    expect(r.id).toBe("b|x");
  });

  test("a search across backends is one request each, answered in the order asked", async () => {
    reply = (c) => {
      const { ids } = JSON.parse(String(c.init?.body)) as { ids: string[] };
      return json(ids.map((id) => ({ repo: id, hits: [], truncated: false })));
    };
    const rows = await api.grepAll("q", ["x", "b|y", "z"]);
    expect(calls.map((c) => [c.url, c.init?.body])).toEqual([
      ["/api/grep", JSON.stringify({ q: "q", ids: ["x", "z"] })],
      ["http://b.test/api/grep", JSON.stringify({ q: "q", ids: ["y"] })],
    ]);
    expect(rows.map((r) => r.repo)).toEqual(["x", "b|y", "z"]);
    expect(rows.every((r) => r.error === undefined)).toBe(true);
  });

  test("a backend that fails a search marks its own rows and no one else's", async () => {
    reply = (c) => {
      if (c.url.startsWith("http://b.test")) throw new TypeError("Failed to fetch");
      const { ids } = JSON.parse(String(c.init?.body)) as { ids: string[] };
      return json(ids.map((id) => ({ repo: id, hits: [], truncated: false })));
    };
    const rows = await api.grepAll("q", ["x", "b|y", "z"]);
    expect(rows.map((r) => [r.repo, r.error])).toEqual([
      ["x", undefined],
      ["b|y", "b did not answer"],
      ["z", undefined],
    ]);
    expect(rows[1]).toEqual({ repo: "b|y", hits: [], truncated: false, error: "b did not answer" });
  });

  test("a fleet over two backends is two fleets, the foreign one qualified", async () => {
    reply = (c) => {
      const { ids } = JSON.parse(String(c.init?.body)) as { ids: string[] };
      return json({ id: "f1", workflow: "w", repos: ids.map((repoId) => ({ repoId, status: "pending" })) });
    };
    const fleets = await api.startFleet("w", ["x", "b|y"], "");
    expect(calls.map((c) => c.url)).toEqual(["/api/fleet", "http://b.test/api/fleet"]);
    expect(fleets.map((f) => [f.id, f.repos.map((r) => r.repoId)])).toEqual([
      ["f1", ["x"]],
      ["b|f1", ["b|y"]],
    ]);
  });

  test("what came back, or did not, is signalled for the backend it came from", async () => {
    reply = () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(api.log("b|x")).rejects.toThrow("b did not answer");
    reply = () => json({ error: "unauthorized", login: "https://x/login" }, 401);
    await expect(api.log("b|x")).rejects.toThrow("unauthorized");
    reply = () => json({ error: "no such repo" }, 404);
    await expect(api.log("x")).rejects.toThrow("no such repo");
    expect(signals).toEqual([
      ["b", { kind: "unreachable", reason: "b did not answer" }],
      ["b", { kind: "signin", login: "https://x/login" }],
      ["a", { kind: "answered" }],
    ]);
  });

  test("a frame from a backend names its ids under that backend", () => {
    expect(readFrame("b", JSON.stringify({ type: "run-gone", id: "r" }))).toEqual({ type: "run-gone", id: "b|r" });
    expect(readFrame("a", JSON.stringify({ type: "run-gone", id: "r" }))).toEqual({ type: "run-gone", id: "r" });
    expect(readFrame("b", "nope")).toBeNull();
  });

  test("a foreign backend's socket is on its own host", () => {
    expect(socketUrl("b", "/api/term?id=x")).toBe("ws://b.test/api/term?id=x");
  });
});
