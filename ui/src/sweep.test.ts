import { describe, expect, test } from "bun:test";
import type { AgentCard, SweepItem, SweepLogEntry, SweepOutcome } from "../../src/core/types";
import { askCloses, askTitle, nextAuto, pickKeys, defaultPicks, dropPicks, endedCards, freshEntry, groupItems, outcomesOf, sheetRows, spanMs, spanParts, spanWord, sweepSummary } from "./sweep";

const item = (key: string, over: Partial<SweepItem> = {}): SweepItem => {
  const at = key.indexOf(":");
  const kind = key.slice(0, at) as SweepItem["kind"];
  return {
    key,
    kind,
    id: key.slice(at + 1),
    repoId: "app",
    where: "app",
    title: "app",
    idleSince: 0,
    why: "",
    closable: kind !== "outside",
    checked: kind !== "outside" && kind !== "pr",
    auto: false,
    ...over,
  };
};

const out = (key: string, result: SweepOutcome["result"], why?: string): SweepOutcome => ({ key, result, ...(why ? { why } : {}) });

describe("groupItems", () => {
  test("groups by kind in the sweep's order, empty kinds left out, outside last", () => {
    const items = [item("outside:o1"), item("run:r1"), item("shell:s1"), item("shell:s2"), item("chat:c1")];
    const groups = groupItems(items);
    expect(groups.map((g) => g.kind)).toEqual(["shell", "chat", "run", "outside"]);
    expect(groups[0]?.items.map((i) => i.key)).toEqual(["shell:s1", "shell:s2"]);
    expect(groups.at(-1)?.items.map((i) => i.key)).toEqual(["outside:o1"]);
  });

  test("nothing idle is no groups", () => {
    expect(groupItems([])).toEqual([]);
  });
});

describe("defaultPicks", () => {
  test("the checked keys", () => {
    const picks = defaultPicks([item("shell:s1"), item("chat:c1", { checked: false }), item("run:r1"), item("pr:p1")]);
    expect([...picks].sort()).toEqual(["run:r1", "shell:s1"]);
  });

  test("never an item that is listed only, even one marked checked", () => {
    expect(defaultPicks([item("outside:o1", { checked: true, closable: false })]).size).toBe(0);
  });
});

describe("sweepSummary", () => {
  test("closed shells and chats, dismissed runs, and what was left", () => {
    const outcomes = [
      ...Array.from({ length: 7 }, (_, i) => out(`shell:s${i}`, "closed")),
      out("chat:c1", "closed"),
      out("chat:c2", "closed"),
      ...Array.from({ length: 11 }, (_, i) => out(`run:r${i}`, "closed")),
      out("shell:busy", "in use now"),
    ];
    expect(sweepSummary(outcomes)).toBe("closed 7 shells, 2 chats, dismissed 11 runs; 1 in use now");
  });

  test("one of each reads singular", () => {
    expect(sweepSummary([out("shell:a", "closed"), out("run:b", "closed"), out("chat:c", "gone")])).toBe("closed 1 shell, dismissed 1 run; 1 gone");
  });

  test("only runs: dismissed, no closed", () => {
    expect(sweepSummary([out("run:a", "closed"), out("run:b", "closed")])).toBe("dismissed 2 runs");
  });

  test("nothing closed says what happened instead", () => {
    expect(sweepSummary([out("shell:a", "in use now"), out("chat:b", "failed", "no session"), out("run:c", "failed")])).toBe("closed nothing; 1 in use now, 2 failed");
  });

  test("no outcomes at all", () => {
    expect(sweepSummary([])).toBe("closed nothing");
  });
});

describe("freshEntry", () => {
  const entry = (at: number): SweepLogEntry => ({ at, by: "eric", outcomes: [], items: [] });

  test("a log entry newer than the one already seen is fresh", () => {
    expect(freshEntry(100, entry(200), 300)?.at).toBe(200);
    expect(freshEntry(null, entry(200), 300)?.at).toBe(200);
  });

  test("the same entry again, as a resume or a settings change carries it, is not", () => {
    expect(freshEntry(200, entry(200), 300)).toBeNull();
    expect(freshEntry(200, null, 300)).toBeNull();
  });

  test("with nothing seen yet, only an entry from the last minute counts", () => {
    expect(freshEntry(undefined, entry(1_000), 30_000)?.at).toBe(1_000);
    expect(freshEntry(undefined, entry(1_000), 1_000 + 120_000)).toBeNull();
  });
});

describe("endedCards", () => {
  const card = (id: string, canopy: { backend: string; term?: string; run?: string } | null): AgentCard =>
    ({ id, where: { os: "darwin", container: false, pid: null, term: null, canopy } }) as AgentCard;

  test("a closed shell's and chat's cards, made and registry; not a shell left in use", () => {
    const entry: SweepLogEntry = {
      at: 1,
      by: "eric",
      items: [],
      outcomes: [out("shell:s1", "closed"), out("chat:c1", "closed"), out("run:r1", "closed"), out("shell:s2", "in use now")],
    };
    const cards = [card("claude:a", { backend: "mac", term: "s1" }), card("claude:b", { backend: "mac", run: "c1" }), card("claude:c", { backend: "mac", term: "s2" }), card("claude:d", null)];
    expect([...endedCards(entry, cards)].sort()).toEqual(["claude:a", "claude:b", "run:c1", "run:r1", "shell:s1"]);
  });

  test("a card on another backend naming the same id is not this one's", () => {
    const entry: SweepLogEntry = { at: 1, by: "eric", items: [], outcomes: [out("shell:s1", "closed")] };
    expect([...endedCards(entry, [card("claude:a", { backend: "mini", term: "s1" })], "mac")]).toEqual(["shell:s1"]);
    expect([...endedCards(entry, [card("claude:a", { backend: "mac", term: "s1" })], "mac")].sort()).toEqual(["claude:a", "shell:s1"]);
  });
});

describe("sheetRows", () => {
  test("before a close, the plan as it is", () => {
    expect(sheetRows([item("shell:s1")], null)).toEqual([{ item: item("shell:s1") }]);
  });

  test("after a close, what it took stays in place with its outcome; what the plan kept shows as the plan has it", () => {
    const sent = [item("shell:s1"), item("shell:s2", { why: "old" })];
    const rows = sheetRows([item("shell:s2", { why: "new" }), item("run:r1")], { items: sent, outcomes: [out("shell:s1", "closed"), out("shell:s2", "failed", "no keep")] });
    expect(rows.map((r) => [r.item.key, r.item.why, r.outcome?.result])).toEqual([
      ["shell:s2", "new", "failed"],
      ["run:r1", "", undefined],
      ["shell:s1", "", "closed"],
    ]);
  });
});

describe("a log entry from a broken log", () => {
  // as a hand-edited or older log.json can send it
  const broken = { at: 1, by: "eric", items: [] } as unknown as SweepLogEntry;

  test("an entry with no outcomes reads as none, and its summary says so", () => {
    expect(outcomesOf(broken)).toEqual([]);
    expect(sweepSummary(outcomesOf(broken))).toBe("closed nothing");
  });

  test("an outcome that is not one is left out", () => {
    const mixed = { at: 1, by: "eric", items: [], outcomes: [null, { result: "closed" }, out("shell:s1", "closed")] } as unknown as SweepLogEntry;
    expect(outcomesOf(mixed)).toEqual([out("shell:s1", "closed")]);
  });

  test("endedCards finds nothing in it", () => {
    expect([...endedCards(broken, [])]).toEqual([]);
  });
});

describe("dropPicks", () => {
  test("what a close sent is no longer picked; the rest stays as it was", () => {
    expect([...dropPicks(new Set(["shell:a", "shell:b", "run:c"]), [], ["shell:a", "run:c"])]).toEqual(["shell:b"]);
  });

  test("with the defaults still in force, they are what it drops from", () => {
    const items = [item("shell:a"), item("shell:b"), item("chat:c", { checked: false })];
    expect([...dropPicks(null, items, ["shell:a"])]).toEqual(["shell:b"]);
  });
});

describe("the ask's words", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const spans = { shell: DAY, chat: 12 * HOUR, run: 3 * DAY, pr: 14 * DAY, outside: DAY };

  test("spanWord reads days from two whole days up, hours below, minutes under an hour", () => {
    expect(spanWord(14 * DAY)).toBe("14+ days");
    expect(spanWord(2 * DAY)).toBe("2+ days");
    expect(spanWord(DAY)).toBe("24+ hours");
    expect(spanWord(36 * HOUR)).toBe("36+ hours");
    expect(spanWord(HOUR)).toBe("1+ hour");
    expect(spanWord(90 * MIN)).toBe("1.5+ hours");
    expect(spanWord(2 * MIN)).toBe("2+ minutes");
    expect(spanWord(MIN)).toBe("1+ minute");
    expect(spanWord(1_000)).toBe("1+ minute");
  });

  test("askTitle counts the ask a kind at a time, each with its own span", () => {
    expect(askTitle([item("pr:1"), item("pr:2"), item("pr:3")], spans)).toBe("Sweep: 3 PRs idle 14+ days");
    expect(askTitle([item("pr:1"), item("shell:s1", { checked: false })], spans)).toBe("Sweep: 1 shell idle 24+ hours, 1 PR idle 14+ days");
    expect(askTitle([item("run:r1"), item("run:r2")], spans)).toBe("Sweep: 2 finished runs idle 3+ days");
  });

  test("askCloses is the ask's ticked keys it may close, in its order", () => {
    const ask = [item("shell:s1", { checked: false }), item("chat:c1"), item("pr:1", { checked: true }), item("outside:o1", { checked: true })];
    expect(askCloses(ask)).toEqual(["chat:c1", "pr:1"]);
    expect(askCloses([item("shell:s1", { checked: false })])).toEqual([]);
  });
});

describe("pick", () => {
  test("starts the sheet on the ask's ticked items alone: a shell running a program stays unticked", () => {
    const ask = [item("shell:busy", { checked: false, why: "running vim, no input or output for 30h" }), item("shell:idle"), item("chat:c1")];
    expect(pickKeys(ask)).toEqual(["shell:idle", "chat:c1"]);
    expect(pickKeys(ask)).not.toContain("shell:busy");
  });
});

describe("nextAuto", () => {
  test("adds or drops one kind over the auto kinds given, in the sweep's order", () => {
    expect(nextAuto(["shell", "chat", "run"], "pr", true)).toEqual(["shell", "chat", "run", "pr"]);
    expect(nextAuto(["shell", "chat", "run", "pr"], "chat", false)).toEqual(["shell", "run", "pr"]);
    expect(nextAuto(["run"], "shell", true)).toEqual(["shell", "run"]);
    expect(nextAuto(["shell"], "shell", true)).toEqual(["shell"]);
  });

  test("two quick toggles, each over the one before, keep both", () => {
    const first = nextAuto(["shell", "chat", "run", "pr"], "pr", false);
    expect(nextAuto(first, "chat", false)).toEqual(["shell", "run"]);
  });
});

describe("a span in the settings row", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  test("whole days read as days, anything else as hours", () => {
    expect(spanParts(14 * DAY)).toEqual({ value: "14", unit: "days" });
    expect(spanParts(DAY)).toEqual({ value: "1", unit: "days" });
    expect(spanParts(12 * HOUR)).toEqual({ value: "12", unit: "hours" });
    expect(spanParts(36 * HOUR)).toEqual({ value: "36", unit: "hours" });
  });

  test("a span under an hour is a fraction of one, never rounded to nothing", () => {
    expect(spanParts(120_000)).toEqual({ value: "0.0333", unit: "hours" });
    expect(Number(spanParts(1_000).value)).toBeGreaterThan(0);
  });

  test("a unit the row picked holds, whatever the span", () => {
    expect(spanParts(DAY, "hours")).toEqual({ value: "24", unit: "hours" });
    expect(spanParts(36 * HOUR, "days")).toEqual({ value: "1.5", unit: "days" });
  });

  test("spanMs turns what was typed back into ms; nothing positive is null", () => {
    expect(spanMs("3", "days")).toBe(3 * DAY);
    expect(spanMs("1.5", "hours")).toBe(1.5 * HOUR);
    expect(spanMs(" 12 ", "hours")).toBe(12 * HOUR);
    expect(spanMs("0", "hours")).toBeNull();
    expect(spanMs("-2", "days")).toBeNull();
    expect(spanMs("", "days")).toBeNull();
    expect(spanMs("soon", "days")).toBeNull();
    // a span that rounds to nothing, or runs past what a number holds
    expect(spanMs("1e-10", "hours")).toBeNull();
    expect(spanMs("1e306", "days")).toBeNull();
    expect(spanMs("Infinity", "hours")).toBeNull();
  });
});
