import { describe, expect, test } from "bun:test";
import type { Repo } from "../../src/core/types";
import { accept, complete, findRepo, helpEntries, parseCommand, recall, tokenize, underDir, VERBS, type CliEntry } from "./cli";

const repo = (id: string, branch = "main"): Repo =>
  ({ id, name: id.split(/[/:]/).pop() ?? id, group: id.includes("/") ? id.split("/")[0] : id, path: `/r/${id}`, status: { branch, files: [], ahead: 0, behind: 0 } }) as unknown as Repo;

const REPOS = [repo("web/ripe"), repo("web/tally"), repo("dev-tools/canopy", "feat"), repo("notes"), repo("mini:web/ripe")];
const ctx = { repos: REPOS, workspaces: ["daily", "deploys"], sources: ["mini"], peers: ["mac", "mini"] };
const parse = (line: string) => parseCommand(tokenize(line).words);

describe("tokenize", () => {
  test("splits on blanks and keeps quoted words whole", () => {
    expect(tokenize(`commit app -m "fix the thing" --push`).words).toEqual(["commit", "app", "-m", "fix the thing", "--push"]);
    expect(tokenize(`new 'it''s here'`).words).toEqual(["new", "its here"]);
    expect(tokenize(`a "say \\"hi\\""`).words).toEqual(["a", 'say "hi"']);
    expect(tokenize(`a\\ b`).words).toEqual(["a b"]);
  });

  test("says when a quote is open or the line ends in a blank", () => {
    expect(tokenize(`commit app -m "half`).open).toBe('"');
    expect(tokenize("push ").trailing).toBe(true);
    expect(tokenize("push").trailing).toBe(false);
  });
});

describe("help entries", () => {
  test("reads every verb off the CLI's help text", () => {
    for (const v of ["status", "commit", "push", "pull", "open", "ws", "launch", "source", "peers", "spec", "version", "library", "new"]) {
      expect(VERBS).toContain(v);
    }
    const tree = helpEntries().find((e) => e.verb === "");
    expect(tree?.usage).toBe("[dir]");
    const ui = helpEntries().find((e) => e.verb === "ui");
    expect(ui?.more[0]).toStartWith("--no-open");
  });
});

describe("parseCommand", () => {
  test("the tree, status and a dir", () => {
    expect(parse("")).toEqual({ kind: "tree", dir: null, dirtyOnly: false });
    expect(parse("status web")).toEqual({ kind: "tree", dir: "web", dirtyOnly: true });
    expect(parse("canopy web")).toEqual({ kind: "tree", dir: "web", dirtyOnly: false });
  });

  test("commit wants a message or --ai", () => {
    expect(parse(`commit ripe -m "msg" --push`)).toEqual({ kind: "commit", repo: "ripe", message: "msg", ai: false, all: false, push: true });
    expect(parse("commit ripe --ai --all")).toMatchObject({ kind: "commit", ai: true, all: true, message: null });
    expect(parse("commit ripe")).toMatchObject({ kind: "error", usage: expect.stringContaining("canopy commit") });
    expect(parse("commit")).toMatchObject({ kind: "error", text: "the repo is missing" });
  });

  test("open takes a known app only", () => {
    expect(parse("open ripe")).toEqual({ kind: "open", repo: "ripe", app: null });
    expect(parse("open ripe --app code")).toEqual({ kind: "open", repo: "ripe", app: "code" });
    expect(parse("open ripe --app vim")).toMatchObject({ kind: "error", text: expect.stringContaining("unknown app: vim") });
  });

  test("ws, source, peers and spec subcommands", () => {
    expect(parse("ws")).toEqual({ kind: "ws-list" });
    expect(parse("ws create daily ripe tally")).toEqual({ kind: "ws-add", name: "daily", repos: ["ripe", "tally"] });
    expect(parse("ws open daily")).toEqual({ kind: "ws-open", name: "daily", app: "code" });
    expect(parse("ws rm daily")).toEqual({ kind: "ws-rm", name: "daily", repo: null });
    expect(parse("source add ~/work --label work")).toEqual({ kind: "source-add", dir: "~/work", host: null, label: "work" });
    expect(parse("source add work")).toMatchObject({ kind: "error", text: expect.stringContaining("relative") });
    expect(parse("source add --forgejo https://git.example")).toEqual({ kind: "source-forgejo", url: "https://git.example", label: null });
    expect(parse("peers")).toEqual({ kind: "peers-status" });
    expect(parse("peers take ripe mini")).toEqual({ kind: "peers-take", repo: "ripe", peer: "mini", branch: null });
    expect(parse("peers track ripe mini")).toMatchObject({ kind: "error", text: "the branch is missing" });
    expect(parse("spec sync ripe --visual")).toEqual({ kind: "spec-sync", repo: "ripe", halves: ["doc", "visual"] });
    expect(parse("spec sync ripe --visual --doc")).toMatchObject({ kind: "error" });
    expect(parse("spec")).toEqual({ kind: "spec-status", dir: null });
  });

  test("machine-side commands point at a terminal, never run", () => {
    for (const l of ["peers init", "peers gate --root x", "ui", "helper", "source add --forgejo u --token f"]) {
      expect(parse(l).kind).toBe("terminal");
    }
  });

  test("views, help, and the unknown", () => {
    expect(parse("library doctor")).toEqual({ kind: "view", view: "library", sprout: null });
    expect(parse(`new "an idea" for laundry --url https://a.example --repo https://git.example/x`)).toEqual({
      kind: "view",
      view: "incubator",
      sprout: { text: "an idea for laundry", urls: ["https://a.example"], repo: "https://git.example/x" },
    });
    expect(parse("new")).toEqual({ kind: "view", view: "incubator", sprout: { text: "", urls: [], repo: "" } });
    expect(parse("new idea --file notes.md")).toMatchObject({ kind: "error", text: expect.stringContaining("drop the file") });
    expect(parse("new idea --url")).toMatchObject({ kind: "error", text: "--url needs a value" });
    expect(parse("help spec")).toEqual({ kind: "help", verb: "spec" });
    expect(parse("--bogus")).toMatchObject({ kind: "error" });
  });
});

describe("findRepo", () => {
  test("an id, then a name, then an id's tail", () => {
    expect(findRepo("web/tally", REPOS)).toEqual({ repo: REPOS[1]! });
    expect(findRepo("canopy", REPOS)).toEqual({ repo: REPOS[2]! });
    expect(findRepo("ripe", REPOS)).toMatchObject({ error: expect.stringContaining("names 2 repos") });
    expect(findRepo("nope", REPOS)).toEqual({ error: "no repo here is called nope" });
    expect(findRepo("tal", REPOS)).toEqual({ repo: REPOS[1]! });
    expect(findRepo("web/t", REPOS)).toEqual({ repo: REPOS[1]! });
    expect(findRepo("tal", REPOS, { prefix: false })).toEqual({ error: "no repo here is called tal: did you mean web/tally?" });
    expect(findRepo("tally", REPOS, { prefix: false })).toEqual({ repo: REPOS[1]! });
  });

  test("a dir keeps itself and what is under it", () => {
    expect(underDir("web", REPOS).map((r) => r.id)).toEqual(["web/ripe", "web/tally"]);
    expect(underDir(null, REPOS)).toHaveLength(REPOS.length);
  });
});

describe("complete", () => {
  test("an empty line lists verbs with no ghost", () => {
    const c = complete("", ctx);
    expect(c.options.length).toBeGreaterThan(0);
    expect(c.ghost).toBe("");
  });

  test("an empty line offers every verb, each with words", () => {
    const c = complete("", ctx);
    expect(c.options.map((o) => o.value)).toEqual([...VERBS]);
    for (const v of ["push", "pull", "open", "ws", "library", "spec", "version"]) {
      expect(c.options.find((o) => o.value === v)?.hint).not.toBe("");
    }
  });

  test("verbs first, with their words as hints", () => {
    const c = complete("sp", ctx);
    expect(c.options[0]?.value).toBe("spec");
    expect(c.ghost).toBe("ec");
    expect(c.options[0]?.hint).toBe("status, sync, check");
  });

  test("subcommands, then repos by id and by name", () => {
    expect(complete("peers t", ctx).options.map((o) => o.value)).toEqual(["take", "track"]);
    expect(complete("push web/r", ctx).options.map((o) => o.value)).toEqual(["web/ripe"]);
    expect(complete("push can", ctx)).toMatchObject({ ghost: "", options: [{ value: "dev-tools/canopy", hint: "feat" }] });
    expect(complete("ws open d", ctx).options.map((o) => o.value)).toEqual(["daily", "deploys"]);
    expect(complete("peers take ripe m", ctx).options.map((o) => o.value)).toEqual(["mac", "mini"]);
  });

  test("flags and their values", () => {
    expect(complete("commit ripe --", ctx).options.map((o) => o.value)).toEqual(["--ai", "--all", "--push"]);
    expect(complete("open ripe --app k", ctx).options.map((o) => o.value)).toEqual(["kitty"]);
    expect(complete(`commit ripe -m "wip`, ctx).options).toEqual([]);
  });

  test("accepting swaps the last word and leaves a blank", () => {
    expect(accept("push can", "dev-tools/canopy")).toBe("push dev-tools/canopy ");
    expect(accept("push ", "notes")).toBe("push notes ");
    expect(accept("new ", "two words")).toBe('new "two words" ');
  });
});

test("recall keeps each line once, newest first", () => {
  const e = (id: number, line: string): CliEntry => ({ id, line, at: 0, status: "ok", out: [] });
  expect(recall([e(1, "status"), e(2, "push a"), e(3, "status")])).toEqual(["status", "push a"]);
});
