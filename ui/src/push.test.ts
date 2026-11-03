import { describe, expect, test } from "bun:test";
import { isOpenMessage, notificationUrl, parsePushPayload, pickClient, PUSH_WORDS, pushTarget, pushWhyNot, type PushPlace } from "./push";

const ok: PushPlace = { on: true, secure: true, dev: false, hasPush: true, ios: false, standalone: false, permission: "granted", key: "BPub", keyWhy: null, mine: { stale: false } };

describe("pushWhyNot", () => {
  test("nothing to say when the setting is off, or when everything is in place", () => {
    expect(pushWhyNot({ ...ok, on: false, secure: false })).toBeNull();
    expect(pushWhyNot(ok)).toBeNull();
    expect(pushWhyNot({ ...ok, mine: null })).toBeNull();
    expect(pushWhyNot({ ...ok, key: undefined })).toBeNull();
  });

  test("each case in the spec's words, worst first", () => {
    expect(pushWhyNot({ ...ok, secure: false })).toBe(PUSH_WORDS.http);
    expect(pushWhyNot({ ...ok, dev: true })).toBe(PUSH_WORDS.dev);
    expect(pushWhyNot({ ...ok, ios: true })).toBe(PUSH_WORDS.ios);
    expect(pushWhyNot({ ...ok, ios: true, standalone: true })).toBeNull();
    expect(pushWhyNot({ ...ok, hasPush: false })).toBe(PUSH_WORDS.none);
    expect(pushWhyNot({ ...ok, permission: "none" })).toBe(PUSH_WORDS.none);
    expect(pushWhyNot({ ...ok, permission: "denied" })).toBe(PUSH_WORDS.denied);
    expect(pushWhyNot({ ...ok, permission: "default" })).toBe(PUSH_WORDS.asked);
    expect(pushWhyNot({ ...ok, key: null })).toBe(PUSH_WORDS.noKey);
    expect(pushWhyNot({ ...ok, key: null, keyWhy: "EACCES on vapid.json" })).toBe(`${PUSH_WORDS.noKey}. EACCES on vapid.json`);
    expect(pushWhyNot({ ...ok, mine: { stale: true } })).toBe(PUSH_WORDS.stale);
  });
});

describe("parsePushPayload", () => {
  test("canopy's JSON comes through whole", () => {
    const text = JSON.stringify({ key: "inbox:ask:a1", title: "Waiting on you · ripe", body: "deploy?", url: "/?view=agents&ask=a1", count: 3 });
    expect(parsePushPayload(text)).toEqual({ key: "inbox:ask:a1", title: "Waiting on you · ripe", body: "deploy?", url: "/?view=agents&ask=a1", count: 3 });
  });

  test("anything else becomes a plain note, with a safe url and count", () => {
    expect(parsePushPayload(null)).toEqual({ key: "push", title: "canopy", body: "", url: "/", count: 0 });
    expect(parsePushPayload("hello there")).toEqual({ key: "push", title: "canopy", body: "hello there", url: "/", count: 0 });
    expect(parsePushPayload("[1,2]")).toMatchObject({ title: "canopy", url: "/" });
    expect(parsePushPayload(JSON.stringify({ title: "x", url: "https://evil.example/", count: -2 }))).toEqual({ key: "push", title: "x", body: "", url: "/", count: 0 });
    expect(parsePushPayload(JSON.stringify({ url: "//evil.example/", count: 1.5 }))).toMatchObject({ url: "/", count: 0 });
  });

  test("a notification's data gives back its url, or the root", () => {
    expect(notificationUrl({ url: "/?repo=r1" })).toBe("/?repo=r1");
    expect(notificationUrl({ url: "https://x/" })).toBe("/");
    expect(notificationUrl(null)).toBe("/");
    expect(notificationUrl("nope")).toBe("/");
  });
});

describe("a click's target", () => {
  const origin = "https://canopy.example";
  test("an ask opens in the inbox, a repo pins its panel, the rest loads", () => {
    expect(pushTarget("/?view=agents&ask=a1", origin)).toEqual({ kind: "ask", id: "a1" });
    expect(pushTarget("/?repo=r%201", origin)).toEqual({ kind: "repo", id: "r 1" });
    expect(pushTarget("/?view=triggers", origin)).toEqual({ kind: "page", url: "/?view=triggers" });
    expect(pushTarget("/", origin)).toEqual({ kind: "page", url: "/" });
  });

  test("the worker's message is told from anything else a page hears", () => {
    expect(isOpenMessage({ type: "canopy:open", url: "/" })).toBe(true);
    expect(isOpenMessage({ type: "canopy:open" })).toBe(false);
    expect(isOpenMessage({ type: "other", url: "/" })).toBe(false);
    expect(isOpenMessage("canopy:open")).toBe(false);
  });

  test("a focused window of ours wins, then the first of ours, else none", () => {
    const w = (url: string, focused = false) => ({ url, focused });
    expect(pickClient([w("https://other.example/"), w(`${origin}/?view=agents`), w(`${origin}/`, true)], origin)).toBe(2);
    expect(pickClient([w("https://other.example/", true), w(`${origin}/?view=agents`)], origin)).toBe(1);
    expect(pickClient([w("https://other.example/")], origin)).toBe(-1);
    expect(pickClient([], origin)).toBe(-1);
  });
});
