import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rangerDigest } from "../core/digest";
import type { TriggerEvent } from "../core/trigger";
import type { Repo, Run } from "../core/types";
import { TriggerHub, type TriggerDeps } from "./triggers";

const REPO = { id: "web/shop", name: "shop", path: "/dev/web/shop" } as Repo;
const HOUR = 3_600_000;
// Bun pins dates to UTC under test, so these are the hub's local times
const NOV2_0300 = Date.UTC(2026, 10, 2, 3, 0);
const NOV2_0400 = Date.UTC(2026, 10, 2, 4, 0);

let dir: string;
let now: number;
let made: TriggerHub[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-trigger-stall-"));
  now = NOV2_0300;
  made = [];
});

afterEach(async () => {
  for (const h of made) {
    h.detach();
    await h.idle();
  }
  await rm(dir, { recursive: true, force: true });
});

const event = (over: Partial<TriggerEvent>): TriggerEvent => ({
  id: "e1",
  rule: "shop",
  source: "github",
  service: "github",
  key: "12",
  short: "#12",
  title: "Login breaks",
  note: "",
  repoId: REPO.id,
  workflow: "issue-fix",
  status: "working",
  count: 1,
  firstAt: 1,
  lastAt: 1,
  ...over,
});

async function kept(events: TriggerEvent[]): Promise<void> {
  await mkdir(join(dir, "triggers"), { recursive: true });
  await writeFile(join(dir, "triggers", "events.json"), JSON.stringify({ events }));
}

function hub(over: Partial<TriggerDeps> = {}): TriggerHub {
  const h = new TriggerHub({
    broadcast: () => {},
    repo: (ref) => (ref === REPO.id ? REPO : undefined),
    workflowProblem: async () => null,
    start: async () => ({ busy: "no starts here" }),
    resume: async () => ({ run: { id: "r9", status: "working" } as Run }),
    stopRun: () => {},
    runKnown: () => true,
    env: () => undefined,
    listIssues: async () => [],
    readIssue: async (_rule, _repo, inc) => inc,
    reportPoll: () => {},
    writeIssue: async () => {},
    missingFrom: async () => null,
    file: join(dir, "triggers.json"),
    dir: join(dir, "triggers"),
    now: () => now,
    ...over,
  });
  made.push(h);
  return h;
}

describe("the stall watchdog's events", () => {
  test("a resumed run carries the event; a stall left for Eric reads stalled and stays so; resume clears it", async () => {
    await kept([event({ runId: "r1", branch: "b1" })]);
    const h = hub();
    await h.adopt();
    h.carried({ id: "r1" } as Run, { id: "r2" } as Run);
    expect(h.get("e1")).toMatchObject({ runId: "r2", status: "working" });

    h.stalled({ id: "r2" } as Run, "it went quiet twice");
    expect(h.get("e1")).toMatchObject({ status: "stalled", needsYou: "it went quiet twice", reason: "it went quiet twice" });
    // the stopped run's worktree read comes after: the event stays stalled
    h.onRun({ id: "r2", status: "stopped", stall: { warned: 1, stopped: 2 }, branch: { origin: "b1", state: "ready" } } as Run);
    expect(h.get("e1")?.status).toBe("stalled");

    const resumed = await h.resume("e1");
    expect(resumed).toMatchObject({ status: "working", runId: "r9" });
    expect(resumed.needsYou).toBeUndefined();
  });

  test("an event on a PR is the PR watch's to word", async () => {
    await kept([event({ runId: "r1", branch: "b1", status: "review", pr: { number: 7, url: "u" } })]);
    const h = hub();
    await h.adopt();
    h.stalled({ id: "r1" } as Run, "quiet");
    expect(h.get("e1")?.status).toBe("review");
  });
});

describe("the daily line", () => {
  const needy = [
    event({ id: "e1", short: "#12", status: "stalled", needsYou: "it went quiet twice", lastAt: 10 }),
    event({ id: "e2", short: "#13", key: "13", status: "review", needsYou: "it touches files that need your approval (infra/); merge it on GitHub yourself", lastAt: 20, pr: { number: 3, url: "u" } }),
    event({ id: "e3", short: "#14", key: "14", status: "merged", endedAt: Date.UTC(2026, 10, 1, 15, 0), lastAt: 5 }),
    event({ id: "e4", short: "#15", key: "15", status: "merged", endedAt: Date.UTC(2026, 9, 30, 15, 0), lastAt: 4 }),
  ];
  const LINE = "2 issues need you: #13 approval, #12 stalled; 1 merged yesterday";

  test("written once at the sweep's hour, broadcast, and DMed to the ranger", async () => {
    await kept(needy);
    const dms: string[] = [];
    const sent: unknown[] = [];
    const h = hub({ tellRanger: async (t) => (dms.push(t), true), broadcast: (ev) => sent.push(ev) });
    await h.adopt();
    await h.tick();
    expect((await h.info()).digest).toBeUndefined();
    now = NOV2_0400;
    await h.tick();
    expect((await h.info()).digest).toEqual({ at: NOV2_0400, text: LINE });
    expect(dms).toEqual([rangerDigest(LINE)]);
    expect(sent.some((ev) => (ev as { digest?: { text: string } }).digest?.text === LINE)).toBe(true);
    now += HOUR;
    await h.tick();
    expect(dms).toHaveLength(1);
    // the next day's, at the same hour
    now = NOV2_0400 + 24 * HOUR;
    await h.tick();
    expect(dms).toHaveLength(2);
    expect(dms[1]).toBe(rangerDigest("2 issues need you: #13 approval, #12 stalled; none merged yesterday"));
  });

  test("kept across a restart: the next hub shows the line and does not write it again that day", async () => {
    await kept(needy);
    const first = hub();
    await first.adopt();
    now = NOV2_0400;
    await first.tick();
    first.detach();
    const saved = JSON.parse(await readFile(join(dir, "triggers", "digest.json"), "utf8"));
    expect(saved).toEqual({ digested: NOV2_0400, digest: { at: NOV2_0400, text: LINE } });
    const dms: string[] = [];
    now = NOV2_0400 + 2 * HOUR;
    const second = hub({ tellRanger: async (t) => (dms.push(t), true) });
    await second.adopt();
    await second.tick();
    expect((await second.info()).digest?.text).toBe(LINE);
    expect(dms).toEqual([]);
  });

  test("a day with nothing to say writes no line and sends nothing; a DM that fails keeps the line", async () => {
    await kept([event({ status: "review" })]);
    const dms: string[] = [];
    const quiet = hub({ tellRanger: async (t) => (dms.push(t), true) });
    await quiet.adopt();
    now = NOV2_0400;
    await quiet.tick();
    expect((await quiet.info()).digest).toBeUndefined();
    expect(dms).toEqual([]);
    quiet.detach();

    await rm(join(dir, "triggers", "digest.json"), { force: true });
    await kept(needy);
    now = NOV2_0300;
    const failing = hub({ tellRanger: async () => { throw new Error("no tailchan broker"); } });
    await failing.adopt();
    now = NOV2_0400;
    await failing.tick();
    expect((await failing.info()).digest?.text).toBe(LINE);
  });

  test("a backend without the flows lock writes no line", async () => {
    await kept(needy);
    const h = hub();
    now = NOV2_0400 + HOUR;
    await h.tick();
    expect((await h.info()).digest).toBeUndefined();
  });
});
