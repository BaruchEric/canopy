import { describe, expect, test } from "bun:test";
import { closedBody, fixedComment, forgejoCommentsPath, forgejoIssuePath, forgejoIssuesPath, openedComment, parseIssueComments, parseIssueList, parseIssueView } from "./forgejoissues";

/** One issue as Forgejo's issues API answers it, the fields canopy reads. */
const issue = (over: Record<string, unknown> = {}) => ({
  id: 91,
  number: 7,
  title: "Show the last sync time",
  body: "On the settings page, under the sync toggle.",
  state: "open",
  html_url: "https://git.example.com/acme/shop/issues/7",
  labels: [{ id: 3, name: "canopy", color: "5e6ad2" }],
  pull_request: null,
  created_at: "2026-10-20T10:00:00Z",
  ...over,
});

describe("the API paths", () => {
  test("the list asks for open issues with the label, oldest first, one page of fifty", () => {
    const u = new URL(forgejoIssuesPath("https://git.example.com", "acme/shop", "canopy"));
    expect(u.origin + u.pathname).toBe("https://git.example.com/api/v1/repos/acme/shop/issues");
    expect(Object.fromEntries(u.searchParams)).toEqual({ labels: "canopy", state: "open", type: "issues", sort: "oldest", limit: "50", page: "1" });
  });

  test("one issue, and its comments", () => {
    expect(forgejoIssuePath("https://git.example.com", "acme/shop", 7)).toBe("https://git.example.com/api/v1/repos/acme/shop/issues/7");
    expect(forgejoCommentsPath("https://git.example.com", "acme/shop", 7)).toBe("https://git.example.com/api/v1/repos/acme/shop/issues/7/comments");
  });

  test("a trailing slash on the api, or odd characters in the slug, do not break the path", () => {
    expect(forgejoIssuePath("https://git.example.com/", "acme/my shop", 7)).toBe("https://git.example.com/api/v1/repos/acme/my%20shop/issues/7");
  });
});

describe("parseIssueList", () => {
  test("keeps the open issues that carry the label", () => {
    const list = parseIssueList([issue(), issue({ number: 8, title: "Second" })], "canopy");
    expect(list.map((i) => i.number)).toEqual([7, 8]);
    expect(list[0]).toEqual({
      number: 7,
      title: "Show the last sync time",
      body: "On the settings page, under the sync toggle.",
      url: "https://git.example.com/acme/shop/issues/7",
      labels: ["canopy"],
      comments: [],
      createdAt: "2026-10-20T10:00:00Z",
    });
  });

  test("the label matches by name, ignoring case", () => {
    expect(parseIssueList([issue({ labels: [{ id: 3, name: "Canopy" }] })], "canopy")).toHaveLength(1);
  });

  test("drops a closed issue, a pull request, another label and anything that is not an issue", () => {
    const list = parseIssueList(
      [
        issue({ number: 1, state: "closed" }),
        issue({ number: 2, pull_request: { merged: false } }),
        issue({ number: 3, labels: [{ id: 4, name: "bug" }] }),
        { number: "4", title: "no number" },
        null,
        issue({ number: 5 }),
      ],
      "canopy",
    );
    expect(list.map((i) => i.number)).toEqual([5]);
  });

  test("not a list says so", () => {
    expect(() => parseIssueList({ message: "token is required" }, "canopy")).toThrow("list of issues");
  });
});

describe("parseIssueView", () => {
  test("maps an issue, with no comments until they are read", () => {
    expect(parseIssueView(issue({ labels: [{ name: "canopy" }, { name: "bug" }] }))).toEqual({
      number: 7,
      title: "Show the last sync time",
      body: "On the settings page, under the sync toggle.",
      url: "https://git.example.com/acme/shop/issues/7",
      labels: ["canopy", "bug"],
      comments: [],
      createdAt: "2026-10-20T10:00:00Z",
    });
  });

  test("a missing body, url or created_at reads as empty", () => {
    expect(parseIssueView(issue({ body: null, html_url: undefined, created_at: 5 }))).toMatchObject({ body: "", url: "", createdAt: "" });
  });

  test("a pull request, or anything without a number and a title, is null", () => {
    expect(parseIssueView(issue({ pull_request: { merged: false } }))).toBeNull();
    expect(parseIssueView({ number: 7 })).toBeNull();
    expect(parseIssueView("7")).toBeNull();
  });
});

describe("parseIssueComments", () => {
  test("each comment's author and body, with someone for a user the API left out", () => {
    const list = parseIssueComments([
      { id: 1, user: { login: "eric", username: "eric" }, body: "Still happens on main." },
      { id: 2, user: { username: "bot" }, body: "Triaged." },
      { id: 3, body: "" },
      "not a comment",
    ]);
    expect(list).toEqual([
      { author: "eric", body: "Still happens on main." },
      { author: "bot", body: "Triaged." },
      { author: "someone", body: "" },
    ]);
  });

  test("not a list says so", () => {
    expect(() => parseIssueComments({ message: "not found" })).toThrow("list of comments");
  });
});

describe("the words written back", () => {
  test("the comment when the PR opens, the one when it merges, and the close", () => {
    expect(openedComment(12, "run/fix")).toBe("Opened #12 from run/fix.");
    expect(fixedComment(12)).toBe("Fixed by #12.");
    expect(closedBody()).toEqual({ state: "closed" });
  });
});
