import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, onBackendSignal } from "./api";
import type { BackendSignal } from "./backends";
import { setBase, setRegistry } from "./registry";
import { isGateClosed } from "./secrets";

describe("the secrets calls", () => {
  const realFetch = globalThis.fetch;
  interface Call {
    url: string;
    init: RequestInit | undefined;
  }
  let calls: Call[] = [];
  let signals: [string, BackendSignal][] = [];
  let reply: (c: Call) => Response = () => new Response("{}");

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

  test("a closed passkey gate rejects with status 401 and never starts a sign-in", async () => {
    reply = () => json({ error: "open a passkey session first", gate: "passkey" }, 401);
    const err = await api.secretsAct("a", { a: "reveal", name: "cf_token" }).catch((e: unknown) => e);
    expect(isGateClosed(err)).toBe(true);
    expect(signals).toEqual([["a", { kind: "answered" }]]);
  });

  test("an act posts {act} to the backend named", async () => {
    reply = () => json(null);
    await api.secretsAct("a", { a: "edit", name: "cf_token", description: "DNS", tags: ["dns"] });
    expect(calls[0]?.url).toBe("/api/secrets/act");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ act: { a: "edit", name: "cf_token", description: "DNS", tags: ["dns"] } });
  });

  test("proposals to another backend go to its origin with credentials", async () => {
    reply = () => json({ added: 1, dropped: 0 });
    const item = { from: "mac", source: "~/dev/x/.env", key: "K", sealed: "", merges: null };
    expect(await api.secretsPropose("b", [item])).toEqual({ added: 1, dropped: 0 });
    expect(calls[0]?.url).toBe("http://b.test/api/secrets/proposals");
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ items: [item] });
  });

  test("a gate login posts kind and code, and the token never comes back in the body", async () => {
    reply = () => json({ ok: true });
    expect(await api.secretsFinish("a", "login", null, { id: "c" }, "")).toEqual({ ok: true });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ kind: "login", code: null, response: { id: "c" }, label: "" });
  });
});
