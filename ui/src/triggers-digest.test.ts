import { describe, expect, test } from "bun:test";
import { needWord } from "../../src/core/digest";
import { TRIGGER_STATUSES, type TriggerEvent, type TriggersInfo } from "../../src/core/trigger";
import { digestRows, eventActs, STATUS_WORD, triggerSections } from "./triggers";

const event = (over: Partial<TriggerEvent>): TriggerEvent => ({
  id: "e1",
  rule: "shop",
  source: "github",
  key: "12",
  title: "t",
  note: "",
  repoId: "web/shop",
  workflow: "issue-fix",
  status: "working",
  count: 1,
  firstAt: 1,
  lastAt: 1,
  ...over,
});

const info = (over: Partial<TriggersInfo> = {}): TriggersInfo => ({ rules: [], problems: [], events: [], keeping: true, ...over });

describe("the digest and the page agree", () => {
  test("the line counts exactly what the page puts under Needs you, in every state", () => {
    for (const status of TRIGGER_STATUSES) {
      for (const needsYou of [undefined, "auto-fix gave up: x"]) {
        const e = event({ status, ...(needsYou ? { needsYou } : {}) });
        const section = triggerSections({ mac: info({ events: [e] }) }, ["mac"])[0]?.key;
        expect({ status, needsYou, needs: section === "needs" }).toEqual({ status, needsYou, needs: needWord(e) !== null });
      }
    }
  });

  test("a stalled event sits in Needs you, can be resumed and dismissed, and says so", () => {
    const e = event({ status: "stalled", branch: "b1", needsYou: "it went quiet twice" });
    expect(triggerSections({ mac: info({ events: [e] }) }, ["mac"])[0]?.key).toBe("needs");
    expect(eventActs(e)).toEqual(["resume", "dismiss"]);
    expect(STATUS_WORD.stalled).toBe("stalled");
  });
});

describe("digestRows", () => {
  const NOW = Date.UTC(2026, 10, 2, 9, 0);
  test("each shown backend's line under a day old and not seen, newest first", () => {
    const triggers = {
      mac: info({ digest: { at: NOW - 3_600_000, text: "mac line" } }),
      mini: info({ digest: { at: NOW - 60_000, text: "mini line" } }),
      old: info({ digest: { at: NOW - 25 * 3_600_000, text: "stale" } }),
      hidden: info({ digest: { at: NOW, text: "not shown" } }),
      none: info(),
    };
    const rows = digestRows(triggers, ["mac", "mini", "old", "none"], NOW, []);
    expect(rows.map((r) => [r.backend, r.digest.text])).toEqual([["mini", "mini line"], ["mac", "mac line"]]);
    expect(digestRows(triggers, ["mac", "mini"], NOW, [rows[0]?.key ?? ""]).map((r) => r.backend)).toEqual(["mac"]);
  });

  test("a line goes once none of the events it counted still waits on Eric", () => {
    const digest = { at: NOW - 60_000, text: "1 issue needs you: MANUAL stopped; none merged yesterday", ids: ["e1"] };
    const shown = (events: TriggerEvent[]) => digestRows({ mini: info({ digest, events }) }, ["mini"], NOW, []).length;
    expect(shown([event({ status: "stopped" })])).toBe(1);
    expect(shown([event({ status: "working" })])).toBe(0);
    expect(shown([])).toBe(0);
    expect(digestRows({ mini: info({ digest: { at: NOW, text: "nothing needs you; 2 merged yesterday", ids: [] } }) }, ["mini"], NOW, []).length).toBe(1);
  });
});
