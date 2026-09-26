import { expect, test } from "bun:test";
import { CHAN_CAP, chanLine, convOf, convOrder, convTarget, isUnread, latestClip, mergeMessages, messageText } from "./chan";
import type { ChanChannel, ChanMessage } from "../../src/core/types";

const msg = (over: Partial<ChanMessage>): ChanMessage => ({
  id: 1,
  channel: "canopy",
  handle: "claude-1",
  node: "macmini-2018",
  kind: "text",
  body: "hi",
  meta: {},
  ts: 1,
  ...over,
});

const chan = (over: Partial<ChanChannel>): ChanChannel => ({
  name: "x",
  topic: "",
  private: false,
  members: [],
  count: 0,
  last_ts: null,
  expires_at: null,
  subscribed: false,
  ...over,
});

test("a conversation's target and id go both ways", () => {
  expect(convTarget("dm.claude-1+eric", "eric")).toBe("@claude-1");
  expect(convTarget("builds", "eric")).toBe("#builds");
  expect(convOf("@claude-1", "eric")).toBe("dm.claude-1+eric");
  expect(convOf("@alice", "eric")).toBe("dm.alice+eric");
  expect(convOf("#builds", "eric")).toBe("builds");
});

test("conversations newest first; a public channel only when subscribed or heard live", () => {
  const channels = [
    chan({ name: "old", subscribed: true, last_ts: 5 }),
    chan({ name: "dm.a+eric", private: true, last_ts: 50 }),
    chan({ name: "lurk", last_ts: 99 }),
    chan({ name: "empty", subscribed: true }),
  ];
  expect(convOrder(channels, { live: [msg({ ts: 70 })], old: [msg({ ts: 80 })] })).toEqual(["old", "live", "dm.a+eric", "empty"]);
});

test("merge by id, in order, capped", () => {
  const a = [msg({ id: 2 }), msg({ id: 1 })];
  expect(mergeMessages(a, [msg({ id: 2, body: "edited" }), msg({ id: 3 })]).map((m) => [m.id, m.body])).toEqual([
    [1, "hi"],
    [2, "edited"],
    [3, "hi"],
  ]);
  const many = Array.from({ length: CHAN_CAP + 5 }, (_, i) => msg({ id: i + 1 }));
  const kept = mergeMessages(undefined, many);
  expect(kept.length).toBe(CHAN_CAP);
  expect(kept[0]?.id).toBe(6);
});

test("unread is someone else's and not silent", () => {
  expect(isUnread(msg({}), "eric")).toBe(true);
  expect(isUnread(msg({ handle: "eric" }), "eric")).toBe(false);
  expect(isUnread(msg({ meta: { silent: true } }), "eric")).toBe(false);
});

test("the words for objects, clips and the feed", () => {
  expect(messageText(msg({ kind: "object", body: "Q3", meta: { name: "r.pdf" } }))).toBe("r.pdf: Q3");
  expect(messageText(msg({ kind: "object", body: "", meta: {} }))).toBe("a file");
  expect(messageText(msg({ kind: "clip", body: "secret" }))).toBe("clipboard, 6 chars");
  expect(chanLine(msg({ channel: "dm.claude-1+eric", body: "a\n b" }), "eric")).toBe("claude-1@macmini-2018 → @claude-1: a b");
  expect(chanLine(msg({ handle: "eric", body: "x".repeat(300) }), "eric")).toMatch(/^you → #canopy: x{159}…$/);
});

test("the latest clip, text or a clipboard file", () => {
  const live = {
    clipboard: [msg({ id: 3, kind: "clip", body: "a" })],
    "dm.claude-1+eric": [msg({ id: 9, kind: "object", body: "clipboard file" }), msg({ id: 10, kind: "object", body: "other" })],
  };
  expect(latestClip(live)?.id).toBe(9);
  expect(latestClip({})).toBeNull();
});
