import { describe, expect, test } from "bun:test";
import type { AgentCard, Repo } from "../../src/core/types";
import {
  ageWord,
  anyWaiting,
  cardName,
  cardOnRepo,
  cardsByRepoCard,
  cardsFor,
  durationWord,
  groupCards,
  joinTarget,
  liveCount,
  markTrail,
  mergeCards,
  orderCards,
  readerOf,
  registrySummary,
  relPath,
  replaceCards,
  repoWord,
  runMs,
  splitRecent,
  stateSince,
  stateWord,
  timelineOf,
  TRAIL_CAP,
  transcriptTarget,
  urlKey,
  whereWord,
  type TrailMark,
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
    expect(ageWord(card({ startedAt: now - 72 * 60_000, state: "working" }), now)).toBe("1h 12m");
    expect(ageWord(card({ startedAt: now - 3 * 3_600_000 - 42 * 60_000, state: "ended", endedAt: now - 3 * 3_600_000 }), now)).toBe("ran 42m, ended 3h ago");
    expect(ageWord(card({ startedAt: now - 2 * 3_600_000, state: "lost", seenAt: now - 5 * 60_000 }), now)).toBe("ran 1h 55m, lost 5m ago");
  });

  test("a run's length, to the minute", () => {
    expect(durationWord(-5)).toBe("0s");
    expect(durationWord(45_000)).toBe("45s");
    expect(durationWord(12 * 60_000 + 59_000)).toBe("12m");
    expect(durationWord(3_600_000)).toBe("1h");
    expect(durationWord(3_600_000 + 60_000)).toBe("1h 1m");
    expect(durationWord(2 * 86_400_000 + 3 * 3_600_000 + 60_000)).toBe("2d 3h");
    expect(durationWord(86_400_000)).toBe("1d");
  });

  test("a run stops at its end, its last beat once lost, else now", () => {
    const now = 100_000;
    expect(runMs(card({ startedAt: 10_000, state: "working" }), now)).toBe(90_000);
    expect(runMs(card({ startedAt: 10_000, state: "ended", endedAt: 40_000, seenAt: 39_000 }), now)).toBe(30_000);
    expect(runMs(card({ startedAt: 10_000, state: "ended", endedAt: null, seenAt: 25_000 }), now)).toBe(15_000);
    expect(runMs(card({ startedAt: 10_000, state: "lost", seenAt: 20_000 }), now)).toBe(10_000);
    // a clock that ran ahead on the agent's machine is no negative run
    expect(runMs(card({ startedAt: now + 5, state: "working" }), now)).toBe(0);
  });
});

describe("the day's summary and timeline", () => {
  const H = 3_600_000;
  const day = 20 * 86_400_000;
  const now = day + 15 * H;
  const cards = [
    card({ id: "w1", state: "working", node: "mini", startedAt: day + 9 * H, repo: "https://github.com/me/app" }),
    card({ id: "w2", state: "waiting", node: "mini", startedAt: day + 14 * H, harness: "codex", repo: "https://github.com/me/app" }),
    // started yesterday, still going: only today's part counts
    card({ id: "i1", state: "idle", node: "ericmac", startedAt: day - 2 * H, repo: null, cwd: "/Users/e/notes" }),
    card({ id: "e1", state: "ended", startedAt: day + 10 * H, endedAt: day + 11 * H }),
    card({ id: "l1", state: "lost", startedAt: day + 12 * H, seenAt: day + 12.5 * H }),
    // ended yesterday: not today's
    card({ id: "e0", state: "ended", startedAt: day - 5 * H, endedAt: day - 4 * H }),
  ];

  test("live ones by state, machines, repos, the day's starts and ends, and time since midnight", () => {
    const s = registrySummary(cards, now, day);
    expect([s.live, s.working, s.waiting, s.idle]).toEqual([3, 1, 1, 1]);
    expect([s.machines, s.repos]).toEqual([2, 2]);
    expect([s.startedToday, s.endedToday, s.lostToday]).toEqual([4, 1, 1]);
    // w1 6h, w2 1h, i1 15h (from midnight), e1 1h, l1 0.5h
    expect(s.todayMs).toBe(23.5 * H);
    expect(s.longest?.id).toBe("i1");
    expect(s.harnesses).toEqual([
      { harness: "claude", count: 2 },
      { harness: "codex", count: 1 },
    ]);
    expect(registrySummary([], now, day)).toMatchObject({ live: 0, longest: null, todayMs: 0 });
  });

  test("lanes from the earliest start today, a run from before cut at midnight, earliest first", () => {
    const t = timelineOf(cards, now, day);
    expect(t.from).toBe(day);
    expect(t.to).toBe(now);
    expect(t.lanes.map((l) => l.card.id)).toEqual(["i1", "w1", "e1", "l1", "w2"]);
    expect(t.lanes[0]).toMatchObject({ start: day, end: now, clipped: true });
    expect(t.lanes.find((l) => l.card.id === "l1")).toMatchObject({ start: day + 12 * H, end: day + 12.5 * H, clipped: false });
    // 15 hours in steps of two, on the clock
    expect(t.ticks.map((x) => x.label)).toEqual(["00:00", "02:00", "04:00", "06:00", "08:00", "10:00", "12:00", "14:00"]);
  });

  test("an hour at least, on the half hour; the live ones kept first when there are too many", () => {
    const fresh = card({ id: "f", state: "working", startedAt: now - 10 * 60_000 });
    const t = timelineOf([fresh], now, day);
    expect(t.from).toBe(now - H);
    expect(t.ticks.map((x) => x.label)).toEqual(["14:00", "14:15", "14:30", "14:45", "15:00"]);
    // three live ones, all running till now: by id among them
    expect(timelineOf(cards, now, day, 2).lanes.map((l) => l.card.id)).toEqual(["i1", "w1"]);
    expect(timelineOf(cards, now, day, 4).lanes.map((l) => l.card.id)).toEqual(["i1", "w1", "l1", "w2"]);
    expect(timelineOf([], now, day).lanes).toEqual([]);
  });
});

describe("who reads a card's transcript", () => {
  const shown = ["mini", "mac"];
  test("the canopy backend it ran under, else one on its machine, else none", () => {
    const inShell = card({ node: "macmini-2018", where: canopy("mini", "t1") });
    const kitty = card({ node: "macmini-2018" });
    const mac = card({ node: "Mac" });
    const away = card({ node: "gpd" });
    const all = [inShell, kitty, mac, away];
    expect(readerOf(inShell, shown, all)).toBe("mini");
    // learned from the shell card on the same node
    expect(readerOf(kitty, shown, all)).toBe("mini");
    // a backend named as the node is
    expect(readerOf(mac, shown, all)).toBe("mac");
    expect(readerOf(away, shown, all)).toBeNull();
    // a backend the page does not show reads nothing
    expect(readerOf(card({ node: "x", where: canopy("lab", "t2") }), shown, [])).toBeNull();
    // no session, no transcript
    expect(readerOf(card({ session: null, origin: "scan", where: canopy("mini") }), shown, all)).toBeNull();
    expect(readerOf(card({ harness: "other", where: canopy("mini") }), shown, all)).toBeNull();
  });
});

describe("the trail of states the page saw", () => {
  test("a mark on each change and each new wait, none for a beat or a reading passed over", () => {
    const a = card({ id: "a", state: "working", startedAt: 0, seenAt: 10 });
    const waiting = { ...a, state: "waiting" as const, waiting: "permission", seenAt: 20 };
    let trail = markTrail({}, { a }, { a: waiting }, [waiting], 100);
    expect(trail).toEqual({ a: [{ state: "waiting", at: 100, waiting: "permission" }] });
    const other = { ...waiting, waiting: "a question", seenAt: 30 };
    trail = markTrail(trail, { a: waiting }, { a: other }, [other], 200);
    expect(trail["a"]).toHaveLength(2);
    const beat = { ...other, seenAt: 40 };
    expect(markTrail(trail, { a: other }, { a: beat }, [beat], 300)).toBe(trail);
    // older than the card held: mergeCards kept the held one
    const stale = { ...a, state: "idle" as const, seenAt: 5 };
    expect(markTrail(trail, { a: other }, { a: other }, [stale], 400)).toBe(trail);
    expect(stateSince(other, trail["a"])).toBe(200);
    expect(stateSince({ ...other, state: "working" }, trail["a"])).toBeNull();
    expect(markTrail(trail, {}, {}, [], 500, ["a", "nope"])).toEqual({});
  });

  test("a card met at its start is marked; one met long after is not, its state's start unknown", () => {
    const now = 10 * 60_000;
    const fresh = card({ id: "f", state: "working", startedAt: now - 30_000 });
    const old = card({ id: "o", state: "working", startedAt: 0 });
    const done = card({ id: "d", state: "ended", startedAt: now - 1000 });
    const trail = markTrail({}, {}, { f: fresh, o: old, d: done }, [fresh, old, done], now);
    expect(Object.keys(trail)).toEqual(["f"]);
  });

  test("keeps the latest TRAIL_CAP marks", () => {
    let trail: Record<string, TrailMark[]> = {};
    let held = card({ id: "a", state: "working", startedAt: 0 });
    for (let i = 0; i < TRAIL_CAP + 5; i++) {
      const next = { ...held, state: i % 2 ? ("working" as const) : ("idle" as const) };
      trail = markTrail(trail, { a: held }, { a: next }, [next], i);
      held = next;
    }
    expect(trail["a"]).toHaveLength(TRAIL_CAP);
    expect(trail["a"]?.at(-1)?.at).toBe(TRAIL_CAP + 4);
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
