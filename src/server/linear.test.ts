import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { TriggerEvent, TriggerRule } from "../core/trigger";
import { firstDone, linearAuth, linearComment, linearDone } from "./linear";

/** A stand-in for api.linear.app/graphql: it records each call and answers
 *  from `reply`, which a test sets. */
let calls: { auth: string | null; query: string; variables: Record<string, unknown> }[];
let reply: (query: string) => { status?: number; body: unknown };
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const b = (await req.json()) as { query: string; variables: Record<string, unknown> };
      calls.push({ auth: req.headers.get("authorization"), query: b.query, variables: b.variables });
      const r = reply(b.query);
      return Response.json(r.body, { status: r.status ?? 200 });
    },
  });
});

afterAll(() => {
  void server.stop(true);
});

beforeEach(() => {
  calls = [];
  reply = () => ({ body: { data: {} } });
});

const rule = (): TriggerRule => ({
  name: "lin",
  source: "linear",
  repo: "web/shop",
  workflow: "linear-issue",
  secretEnv: "CANOPY_TRIGGER_LIN_SECRET",
  projects: [],
  levels: [],
  labels: ["canopy"],
  ignore: [],
  api: `http://127.0.0.1:${server.port}`,
});

const event = { key: "iss-7", short: "ENG-7", pr: { number: 9, url: "https://github.com/a/b/pull/9" } } as TriggerEvent;

describe("linearAuth", () => {
  test("a personal key bare, anything else as Bearer", () => {
    expect(linearAuth("lin_api_abc")).toBe("lin_api_abc");
    expect(linearAuth("oauth-token")).toBe("Bearer oauth-token");
  });
});

describe("linearComment", () => {
  test("comments the PR's link on the issue", async () => {
    reply = () => ({ body: { data: { commentCreate: { success: true } } } });
    await linearComment(rule(), event, "lin_api_k");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.auth).toBe("lin_api_k");
    expect(calls[0]?.query).toContain("commentCreate");
    expect(calls[0]?.variables).toEqual({ issueId: "iss-7", body: "canopy opened [pull request #9](https://github.com/a/b/pull/9) for this issue." });
  });

  test("an errors list in a 200, a bad status or no success throws", async () => {
    reply = () => ({ body: { errors: [{ message: "Entity not found" }] } });
    await expect(linearComment(rule(), event, "k")).rejects.toThrow("Linear answered 200: Entity not found");
    reply = () => ({ status: 401, body: { errors: [{ message: "Authentication required" }] } });
    await expect(linearComment(rule(), event, "k")).rejects.toThrow("Linear answered 401: Authentication required");
    reply = () => ({ body: { data: { commentCreate: { success: false } } } });
    await expect(linearComment(rule(), event, "k")).rejects.toThrow("did not take the comment");
  });
});

describe("linearDone", () => {
  const states = (type: string, nodes: unknown[]) => ({ body: { data: { issue: { state: { type }, team: { states: { nodes } } } } } });

  test("moves the issue to its team's first done state", async () => {
    reply = (q) =>
      q.includes("issueUpdate")
        ? { body: { data: { issueUpdate: { success: true } } } }
        : states("started", [
            { id: "st-shipped", name: "Shipped", position: 5 },
            { id: "st-done", name: "Done", position: 2 },
          ]);
    await linearDone(rule(), event, "lin_api_k");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.variables).toEqual({ id: "iss-7" });
    expect(calls[1]?.query).toContain("issueUpdate");
    expect(calls[1]?.variables).toEqual({ id: "iss-7", stateId: "st-done" });
  });

  test("an issue already done is left alone", async () => {
    reply = () => states("completed", [{ id: "st-done", name: "Done", position: 1 }]);
    await linearDone(rule(), event, "k");
    expect(calls).toHaveLength(1);
  });

  test("no issue, or a team with no done state, says so", async () => {
    reply = () => ({ body: { data: { issue: null } } });
    await expect(linearDone(rule(), event, "k")).rejects.toThrow("no such issue");
    reply = () => states("started", []);
    await expect(linearDone(rule(), event, "k")).rejects.toThrow("no done state");
  });
});

describe("firstDone", () => {
  test("the lowest position wins; junk is skipped", () => {
    expect(firstDone([{ id: "b", name: "B", position: 3 }, { name: "no id" }, { id: "a", name: "A", position: 1 }])).toEqual({ id: "a", name: "A" });
    expect(firstDone(undefined)).toBeNull();
  });
});
