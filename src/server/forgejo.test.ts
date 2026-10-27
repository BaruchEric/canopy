import { beforeEach, describe, expect, test } from "bun:test";
import { forgejoListIssues, forgejoReadIssue, type Fetch } from "./forgejo";

const API = "https://git.example.com";

/** one issue as the API lists it, opened `day` days into October */
const issue = (number: number, day: number, labels = ["canopy"]) => ({
  number,
  title: `Issue ${number}`,
  body: "Steps.",
  state: "open",
  html_url: `${API}/o/r/issues/${number}`,
  labels: labels.map((name, id) => ({ id, name })),
  pull_request: null,
  created_at: `2026-10-${String(day).padStart(2, "0")}T10:00:00Z`,
});

let calls: { url: string; auth: string | null }[];
/** answers by the url's path and query */
let answers: Record<string, { status?: number; body: unknown }>;
const fetchFake: Fetch = async (url, init) => {
  calls.push({ url, auth: new Headers(init.headers).get("authorization") });
  const u = new URL(url);
  const a = answers[`${u.pathname}${u.search}`];
  if (!a) return new Response("not found", { status: 404 });
  return Response.json(a.body, { status: a.status ?? 200 });
};

beforeEach(() => {
  calls = [];
  answers = {};
});

describe("forgejoListIssues", () => {
  test("one list call per label, merged by number and oldest first, with the token", async () => {
    answers["/api/v1/repos/o/r/issues?labels=canopy&state=open&type=issues&sort=oldest&limit=50&page=1"] = { body: [issue(3, 3), issue(1, 1)] };
    answers["/api/v1/repos/o/r/issues?labels=fix-me&state=open&type=issues&sort=oldest&limit=50&page=1"] = { body: [issue(2, 2, ["fix-me"]), issue(1, 1, ["canopy", "fix-me"])] };
    const got = await forgejoListIssues(API, "o/r", ["canopy", "fix-me"], "tok", fetchFake);
    expect(got.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.auth).toBe("token tok");
  });

  test("a refusal names the token, another status the server, and a list that is not one its shape", async () => {
    answers["/api/v1/repos/o/r/issues?labels=canopy&state=open&type=issues&sort=oldest&limit=50&page=1"] = { status: 401, body: { message: "token is required" } };
    await expect(forgejoListIssues(API, "o/r", ["canopy"], "tok", fetchFake)).rejects.toThrow(`${API} rejected the token`);
    answers["/api/v1/repos/o/r/issues?labels=canopy&state=open&type=issues&sort=oldest&limit=50&page=1"] = { status: 500, body: {} };
    await expect(forgejoListIssues(API, "o/r", ["canopy"], "tok", fetchFake)).rejects.toThrow(`${API} answered 500`);
    answers["/api/v1/repos/o/r/issues?labels=canopy&state=open&type=issues&sort=oldest&limit=50&page=1"] = { body: { message: "odd" } };
    await expect(forgejoListIssues(API, "o/r", ["canopy"], "tok", fetchFake)).rejects.toThrow("list of issues");
    await expect(forgejoListIssues(API, "o/r", ["canopy"], "tok", async () => {
      throw new Error("ECONNREFUSED");
    })).rejects.toThrow(`cannot reach ${API}: ECONNREFUSED`);
  });
});

describe("forgejoReadIssue", () => {
  test("the issue and its comments, oldest first", async () => {
    answers["/api/v1/repos/o/r/issues/7"] = { body: issue(7, 7) };
    answers["/api/v1/repos/o/r/issues/7/comments"] = { body: [{ user: { login: "eric" }, body: "Still happens." }] };
    const got = await forgejoReadIssue(API, "o/r", 7, "tok", fetchFake);
    expect(got).toMatchObject({ number: 7, title: "Issue 7", comments: [{ author: "eric", body: "Still happens." }] });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/v1/repos/o/r/issues/7", "/api/v1/repos/o/r/issues/7/comments"]);
  });

  test("a pull request, or an issue the server has not got, is an error", async () => {
    answers["/api/v1/repos/o/r/issues/8"] = { body: { ...issue(8, 8), pull_request: { merged: false } } };
    await expect(forgejoReadIssue(API, "o/r", 8, "tok", fetchFake)).rejects.toThrow("#8 is not an issue");
    await expect(forgejoReadIssue(API, "o/r", 9, "tok", fetchFake)).rejects.toThrow(`${API} answered 404`);
  });
});
