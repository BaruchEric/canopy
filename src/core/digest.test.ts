import { describe, expect, test } from "bun:test";
import { DIGEST_CRON, DIGEST_LIST, digestLine, digestShown, needWord, rangerDigest, yesterday } from "./digest";
import { DEFAULT_SWEEP } from "./sweep";
import type { TriggerEvent } from "./trigger";

const NOV2_0400 = Date.UTC(2026, 10, 2, 4, 0);

let n = 0;
const event = (over: Partial<TriggerEvent>): TriggerEvent => ({
  id: `e${++n}`,
  rule: "shop",
  source: "github",
  key: String(n),
  short: `#${n}`,
  title: "t",
  note: "",
  repoId: "web/shop",
  workflow: "issue-fix",
  status: "review",
  count: 1,
  firstAt: 1,
  lastAt: n,
  ...over,
});

describe("needWord", () => {
  test("names what each needs-you sentence and state waits on", () => {
    expect(needWord({ status: "review", needsYou: "it touches files that need your approval (infra/); merge it on GitHub yourself" })).toBe("approval");
    expect(needWord({ status: "review", needsYou: "auto-fix gave up: could not rebase onto main after 3 tries" })).toBe("rebase");
    expect(needWord({ status: "review", needsYou: "auto-fix gave up: the branch moved on GitHub since canopy pushed; rebase it yourself" })).toBe("rebase");
    expect(needWord({ status: "review", needsYou: "auto-fix gave up: test still failing after its fixes" })).toBe("gave up");
    expect(needWord({ status: "review", needsYou: "a review comment by ann, who has no write access, waits for you" })).toBe("comment");
    expect(needWord({ status: "review", needsYou: "the branch has a commit canopy did not push; from here you rebase, fix and merge it yourself" })).toBe("pushed by hand");
    expect(needWord({ status: "stalled", needsYou: "it went quiet twice" })).toBe("stalled");
    expect(needWord({ status: "waiting" })).toBe("question");
    expect(needWord({ status: "ready", land: "queue" })).toBe("not landed");
    expect(needWord({ status: "ready" })).toBe("no PR");
    for (const status of ["queued", "working", "review", "merged", "no-fix", "ignored", "rebasing", "conflict"] as const) expect(needWord({ status })).toBeNull();
  });
});

describe("digestLine", () => {
  test("the newest that need Eric first, and what merged on the local day before", () => {
    const events = [
      event({ short: "#123", status: "review", needsYou: "it touches files that need your approval (infra/); merge it on GitHub yourself", lastAt: 30 }),
      event({ short: "#130", status: "review", needsYou: "auto-fix gave up: could not rebase onto main after 3 tries", lastAt: 20 }),
      event({ short: "ENG-4", status: "waiting", lastAt: 10 }),
      event({ status: "merged", endedAt: Date.UTC(2026, 10, 1, 0, 0) }),
      event({ status: "merged", endedAt: Date.UTC(2026, 10, 1, 23, 59) }),
      // today's and the day before yesterday's are not yesterday's
      event({ status: "merged", endedAt: Date.UTC(2026, 10, 2, 1, 0) }),
      event({ status: "merged", endedAt: Date.UTC(2026, 9, 31, 23, 59) }),
    ];
    expect(digestLine(events, NOV2_0400)).toBe("3 issues need you: #123 approval, #130 rebase, ENG-4 question; 2 merged yesterday");
  });

  test("one, none, and nothing at all", () => {
    expect(digestLine([event({ short: "#9", status: "stopped" })], NOV2_0400)).toBe("1 issue needs you: #9 stopped; none merged yesterday");
    expect(digestLine([event({ status: "merged", endedAt: Date.UTC(2026, 10, 1, 12, 0) })], NOV2_0400)).toBe("nothing needs you; 1 merged yesterday");
    expect(digestLine([event({ status: "review" })], NOV2_0400)).toBeNull();
    expect(digestLine([], NOV2_0400)).toBeNull();
  });

  test(`names at most ${DIGEST_LIST} and counts the rest`, () => {
    const events = Array.from({ length: DIGEST_LIST + 2 }, () => event({ status: "failed" }));
    const line = digestLine(events, NOV2_0400) ?? "";
    expect(line.startsWith(`${DIGEST_LIST + 2} issues need you: `)).toBe(true);
    expect(line).toContain(" and 2 more; none merged yesterday");
    expect(line.split(", ")).toHaveLength(DIGEST_LIST);
  });

  test("an issue with no short id goes by its key", () => {
    expect(digestLine([event({ short: undefined, key: "4242", status: "failed" })], NOV2_0400)).toBe("1 issue needs you: 4242 failed; none merged yesterday");
  });
});

test("the hour is the sweep's, the day is local, the DM is tagged and the line shows a day", () => {
  expect(DIGEST_CRON).toBe(DEFAULT_SWEEP.cron);
  expect(yesterday(NOV2_0400)).toEqual({ from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 10, 2) });
  expect(rangerDigest("x")).toBe("[digest] canopy's daily line on trigger issues: x");
  expect(digestShown({ at: NOV2_0400 }, NOV2_0400 + 23 * 3_600_000)).toBe(true);
  expect(digestShown({ at: NOV2_0400 }, NOV2_0400 + 24 * 3_600_000)).toBe(false);
});
