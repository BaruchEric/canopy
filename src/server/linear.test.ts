import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { TriggerEvent, TriggerRule } from "../core/trigger";
import { firstDone, forgetAppToken, linearActivity, linearAppToken, linearAuth, linearComment, linearDone, LinearError, linearInstall, linearSessionLinks } from "./linear";

/** A stand-in for api.linear.app/graphql: it records each call and answers
 *  from `reply`, which a test sets. */
let calls: { auth: string | null; query: string; variables: Record<string, unknown> }[];
let reply: (query: string) => { status?: number; body: unknown };
/** what the token endpoint was sent, and what it answers */
let mints: URLSearchParams[];
let mintReply: () => { status?: number; body: unknown };
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/oauth/token") {
        mints.push(new URLSearchParams(await req.text()));
        const r = mintReply();
        return Response.json(r.body, { status: r.status ?? 200 });
      }
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
  mints = [];
  mintReply = () => ({ body: { access_token: `app-${mints.length}`, token_type: "Bearer", expires_in: 2591999 } });
});

const rule = (): TriggerRule => ({
  name: "lin",
  source: "linear",
  repo: "web/shop",
  land: "pr",
  only: [],
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

describe("linearAppToken", () => {
  const app = (): TriggerRule => ({ ...rule(), clientId: "cid", clientSecretEnv: "CANOPY_TRIGGER_LIN_APP" });

  test("mints with the client credentials grant and holds the token until near its end", async () => {
    forgetAppToken(app());
    expect(await linearAppToken(app(), "csecret", 0)).toBe("app-1");
    expect(mints[0]?.get("grant_type")).toBe("client_credentials");
    expect(mints[0]?.get("client_id")).toBe("cid");
    expect(mints[0]?.get("client_secret")).toBe("csecret");
    expect(mints[0]?.get("scope")).toBe("read,write,app:assignable,app:mentionable");
    expect(await linearAppToken(app(), "csecret", 1000)).toBe("app-1");
    expect(mints).toHaveLength(1);
    // 30 days less the hour's margin, then a new one
    expect(await linearAppToken(app(), "csecret", 2591999 * 1000)).toBe("app-2");
    forgetAppToken(app());
    expect(await linearAppToken(app(), "csecret", 0)).toBe("app-3");
  });

  test("a refused mint says why, with its status", async () => {
    forgetAppToken(app());
    mintReply = () => ({ status: 400, body: { error: "unsupported_grant_type", error_description: "Client does not support the client_credentials grant type" } });
    const err = await linearAppToken(app(), "csecret", 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinearError);
    expect((err as LinearError).status).toBe(400);
    expect((err as LinearError).message).toContain("does not support the client_credentials grant");
  });
});

describe("the agent session", () => {
  test("an activity goes to the session as its content", async () => {
    reply = () => ({ body: { data: { agentActivityCreate: { success: true } } } });
    await linearActivity(rule(), "app-tok", "ses-1", { type: "action", action: "Working", parameter: "web/shop" });
    expect(calls[0]?.auth).toBe("Bearer app-tok");
    expect(calls[0]?.query).toContain("agentActivityCreate");
    expect(calls[0]?.variables).toEqual({ input: { agentSessionId: "ses-1", content: { type: "action", action: "Working", parameter: "web/shop" } } });
  });

  test("links are added, never replacing the ones there", async () => {
    reply = () => ({ body: { data: { agentSessionUpdate: { success: true } } } });
    await linearSessionLinks(rule(), "app-tok", "ses-1", [{ label: "Pull request #9", url: "https://github.com/a/b/pull/9" }]);
    expect(calls[0]?.variables).toEqual({ id: "ses-1", data: { addedExternalUrls: [{ label: "Pull request #9", url: "https://github.com/a/b/pull/9" }] } });
    await linearSessionLinks(rule(), "app-tok", "ses-1", []);
    expect(calls).toHaveLength(1);
  });

  test("a 401 carries its status, so the hub can mint again", async () => {
    reply = () => ({ status: 401, body: { errors: [{ message: "Authentication required" }] } });
    const err = await linearActivity(rule(), "old", "ses-1", { type: "thought", body: "x" }).catch((e: unknown) => e);
    expect((err as LinearError).status).toBe(401);
  });
});

describe("linearInstall", () => {
  const app = (): TriggerRule => ({ ...rule(), clientId: "cid", clientSecretEnv: "CANOPY_TRIGGER_LIN_APP" });

  test("trades the code, then says which workspace and which app user", async () => {
    mintReply = () => ({ body: { access_token: "install-tok", token_type: "Bearer", expires_in: 86399, refresh_token: "r" } });
    reply = () => ({ body: { data: { viewer: { id: "app-user", name: "canopy" }, organization: { id: "org-1", name: "Acme", urlKey: "acme" } } } });
    const got = await linearInstall(app(), "csecret", "the-code", "https://c.example/api/linear/callback");
    expect(Object.fromEntries(mints[0] ?? [])).toEqual({ grant_type: "authorization_code", code: "the-code", redirect_uri: "https://c.example/api/linear/callback", client_id: "cid", client_secret: "csecret" });
    expect(calls[0]?.auth).toBe("Bearer install-tok");
    expect(got).toEqual({ organization: { id: "org-1", name: "Acme", urlKey: "acme" }, app: { id: "app-user", name: "canopy" } });
  });

  test("a refused code says why", async () => {
    mintReply = () => ({ status: 400, body: { error: "invalid_grant", error_description: "The code has expired" } });
    await expect(linearInstall(app(), "csecret", "old", "https://c.example/cb")).rejects.toThrow("Linear would not finish the install (400: The code has expired)");
  });
});
