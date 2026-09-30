import { describe, expect, test } from "bun:test";
import type { AgentCard, Repo } from "../../src/core/types";
import {
  ageWord,
  anyWaiting,
  cardName,
  cardOnRepo,
  cardsByRepoCard,
  cardsFor,
  groupCards,
  joinTarget,
  liveCount,
  mergeCards,
  orderCards,
  relPath,
  replaceCards,
  repoWord,
  splitRecent,
  stateWord,
  transcriptTarget,
  urlKey,
  whereWord,
} from "./agentcards";
import { split, qualify, type Reg } from "./backends";
import { joinRepos } from "./checkouts";

const reg: Reg = { home: "mini", names: ["mini", "mac"] };
const sp = (id: string) => split(reg, id);
const backendOf = (id: string) => sp(id)[0];
const qual = (b: string, id: string) => qualify(reg, b, id);

function repo(id: string, path: string, remotes: string[] = [], over: Partial<Repo> = {}): Repo {
  return { id, name: path.slice(path.lastIndexOf("/") + 1), path, group: "", source: "launch", status: null, remotes, ...over };
}

let n = 0;
function card(over: Partial<AgentCard> = {}): AgentCard {
  n++;
  return {
    id: `claude:s${n}`,
    handle: `app-${n}`,
    node: "macmini-2018",
    harness: "claude",
    session: `s${n}`,
    origin: "elsewhere",
    cwd: "/dev/app",
    repo: "https://github.com/Me/App",
    branch: "main",
    model: null,
    mode: null,
    state: "idle",
    waiting: null,
    caps: [],
    offers: [],
    notifyIdle: false,
    where: { os: "linux", container: false, pid: 40 + n, term: null, canopy: null },
    transcript: null,
    startedAt: 1_000,
    seenAt: 2_000,
    endedAt: null,
    ...over,
  };
}

const canopy = (backend: string, term?: string): AgentCard["where"] => ({ os: "linux", container: true, pid: 9, term: null, canopy: { backend, ...(term ? { term } : {}) } });

describe("joining cards to repo cards", () => {
  const mini = repo("app", "/home/bun/dev/app", ["git@github.com:me/app.git"], { link: "https://github.com/me/app" });
  const mac = repo("mac|app", "/Users/e/dev/app", ["https://github.com/me/app"]);
  const plain = repo("notes", "/home/bun/dev/notes");
  const [appCard, notesCard] = joinRepos([mini, mac, plain], reg.names, sp);

  test("a url key is the one repo cards use: host and path, lowercase, no .git", () => {
    expect(urlKey("https://GitHub.com/Me/App.git/")).toBe("github.com/me/app");
    expect(urlKey("https://forge.lan:3000/e/a")).toBe("forge.lan:3000/e/a");
    expect(urlKey(null)).toBeNull();
    expect(urlKey("not a url")).toBeNull();
  });

  test("by repo url, on either checkout; by folder only for a card with no repo", () => {
    const byUrl = card({ cwd: "/somewhere/else" });
    const byFolder = card({ repo: null, cwd: "/home/bun/dev/notes/src" });
    const otherRepo = card({ repo: "https://github.com/me/other", cwd: "/home/bun/dev/notes" });
    const onMac = card({ repo: null, cwd: "/home/bun/dev/notes", where: canopy("mac", "t1") });
    expect(cardOnRepo(byUrl, mac)).toBe(true);
    expect(cardOnRepo(byFolder, plain, "mini")).toBe(true);
    expect(cardOnRepo(otherRepo, plain)).toBe(false);
    expect(cardOnRepo(onMac, plain, "mini")).toBe(false);
    expect(cardOnRepo(card({ repo: null, cwd: "/home/bun/dev/notes-old" }), plain)).toBe(false);
    const all = [byUrl, byFolder, otherRepo, onMac];
    expect(cardsFor(appCard!, all, backendOf)).toEqual([byUrl]);
    expect(cardsFor(notesCard!, all, backendOf)).toEqual([byFolder]);
    // all at once, the same answer
    const map = cardsByRepoCard([appCard!, notesCard!], all, backendOf);
    expect(map.get(appCard!.key)).toEqual([byUrl]);
    expect(map.get(notesCard!.key)).toEqual([byFolder]);
  });
});

describe("words", () => {
  test("state, name, repo and where", () => {
    expect(stateWord(card({ state: "waiting", waiting: "your turn" }))).toBe("waiting: your turn");
    expect(stateWord(card({ state: "lost" }))).toBe("lost");
    expect(cardName(card({ handle: "app-1a2b" }))).toBe("app-1a2b");
    expect(cardName(card({ handle: "", harness: "codex", where: { ...card().where, pid: 77 } }))).toBe("codex pid 77");
    expect(repoWord(card({ repo: "https://github.com/me/app", branch: "main" }))).toBe("me/app · main");
    expect(repoWord(card({ repo: null, branch: null, cwd: "/tmp/scratch/" }))).toBe("scratch");
    expect(whereWord(card({ where: canopy("mini", "0123") }))).toBe("canopy shell on mini");
    expect(whereWord(card({ where: { ...canopy("mini"), canopy: { backend: "mini", run: "r1" } } }))).toBe("canopy run on mini");
    expect(whereWord(card({ node: "ericmac", where: { os: "darwin", container: false, pid: 1, term: "kitty", canopy: null } }))).toBe("kitty on ericmac");
    expect(whereWord(card({ node: "mini", where: { os: "linux", container: true, pid: 1, term: null, canopy: null } }))).toBe("container on mini");
    expect(whereWord(card({ node: "mini", origin: "scan", handle: "", where: { os: "linux", container: true, pid: 1, term: null, canopy: null } }))).toBe("scan on mini");
  });

  test("how long", () => {
    const now = 10_000_000;
    expect(ageWord(card({ startedAt: now - 12 * 60_000 }), now)).toBe("12m");
    expect(ageWord(card({ state: "ended", endedAt: now - 3 * 3_600_000 }), now)).toBe("ended 3h ago");
    expect(ageWord(card({ state: "lost", seenAt: now - 5 * 60_000 }), now)).toBe("lost 5m ago");
  });
});

describe("order and groups", () => {
  const waiting = card({ state: "waiting", node: "mini" });
  const working = card({ state: "working", node: "ericmac", startedAt: 5 });
  const idleNew = card({ state: "idle", node: "ericmac", startedAt: 9, repo: null, cwd: "/x" });
  const lost = card({ state: "lost", node: "mini", seenAt: 90_000_000 });
  const ended = card({ state: "ended", node: "mini", endedAt: 95_000_000 });
  const old = card({ state: "ended", node: "mini", endedAt: 1 });

  test("waiting, working, idle, lost, ended; the counts", () => {
    expect(orderCards([ended, lost, idleNew, working, waiting])).toEqual([waiting, working, idleNew, lost, ended]);
    expect(liveCount([ended, lost, idleNew, working, waiting])).toBe(3);
    expect(anyWaiting([working, waiting])).toBe(true);
    expect(anyWaiting([working])).toBe(false);
  });

  test("the running ones, and the day's ended and lost; older ones left out", () => {
    const { live, past } = splitRecent([old, ended, lost, idleNew, working, waiting], 100_000_000);
    expect(live).toEqual([waiting, working, idleNew]);
    expect(past).toEqual([lost, ended]);
  });

  test("by machine, the busier first; by repo, no repo last", () => {
    const byMachine = groupCards([idleNew, working, waiting], "machine");
    expect(byMachine.map((g) => [g.label, g.live, g.cards.length])).toEqual([
      ["ericmac", 2, 2],
      ["mini", 1, 1],
    ]);
    // a canopy card is on its backend's name, not the tailnet node's
    expect(groupCards([card({ node: "macmini-2018", where: canopy("mini", "1") })], "machine")[0]?.label).toBe("mini");
    const byRepo = groupCards([idleNew, working, waiting], "repo");
    expect(byRepo.map((g) => [g.label, g.cards])).toEqual([
      ["Me/App", [waiting, working]],
      ["no repo", [idleNew]],
    ]);
  });
});

describe("actions", () => {
  test("join: a canopy shell on a shown backend, qualified", () => {
    expect(joinTarget(card({ where: canopy("mini", "0123") }), ["mini", "mac"], qual)).toBe("0123");
    expect(joinTarget(card({ where: canopy("mac", "0123") }), ["mini", "mac"], qual)).toBe("mac|0123");
    expect(joinTarget(card({ where: canopy("gpd", "0123") }), ["mini", "mac"], qual)).toBeNull();
    expect(joinTarget(card(), ["mini"], qual)).toBeNull();
  });

  test("transcript: through a home checkout, only for an agent on home", () => {
    const home = [repo("app", "/home/bun/dev/app"), repo("app/sub", "/home/bun/dev/app/sub")];
    const t = "/home/bun/.claude/projects/-home-bun-dev-app-sub/abc.jsonl";
    expect(relPath("/home/bun/dev/app", "/home/bun/.claude/x.jsonl")).toBe("../../.claude/x.jsonl");
    expect(transcriptTarget(card({ transcript: t, cwd: "/home/bun/dev/app/sub/src", where: canopy("mini", "0123") }), "mini", home)).toEqual({
      repoId: "app/sub",
      file: "../../../.claude/projects/-home-bun-dev-app-sub/abc.jsonl",
    });
    expect(transcriptTarget(card({ transcript: t, where: canopy("mac", "0123") }), "mini", home)).toBeNull();
    expect(transcriptTarget(card({ transcript: t }), "mini", home)).toBeNull();
    expect(transcriptTarget(card({ transcript: null, where: canopy("mini", "1") }), "mini", home)).toBeNull();
  });
});

describe("merging", () => {
  const a = card({ id: "a", seenAt: 10 });
  const b = card({ id: "b", seenAt: 10 });

  test("a change lands, an older reading does not, gone ids go; nothing moved is the same object", () => {
    const held = { a, b };
    const newer = { ...a, state: "working" as const, seenAt: 11 };
    expect(mergeCards(held, [newer])).toEqual({ a: newer, b });
    expect(mergeCards(held, [{ ...a, seenAt: 9 }])).toBe(held);
    expect(mergeCards(held, [a])).toBe(held);
    expect(mergeCards(held, [], ["b"])).toEqual({ a });
    expect(mergeCards(held, [], ["zzz"])).toBe(held);
  });

  test("a list replaces what is held but for a newer card", () => {
    const newer = { ...a, seenAt: 20 };
    expect(replaceCards({ a: newer, b }, [a])).toEqual({ a: newer });
  });

  test("a card an event told of while the list was on its way keeps what the event said, a tie of beats included", () => {
    // the broker marks a card lost without a new beat
    const lost = { ...a, state: "lost" as const };
    const c = card({ id: "c", seenAt: 10 });
    const since = (id: string) => id === "a" || id === "c" || id === "gone";
    // a stays lost, c (started since) stays though the list lacks it, and a
    // card an event said was gone stays gone
    const got = replaceCards({ a: lost, b, c }, [{ ...a, state: "idle" }, b, card({ id: "gone" })], since);
    expect(got).toEqual({ a: lost, b, c });
    // without an event since, the list is the news
    expect(replaceCards({ a: lost }, [{ ...a, state: "idle" }])).toEqual({ a: { ...a, state: "idle" } });
  });
});
