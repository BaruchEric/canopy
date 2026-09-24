import { describe, expect, test } from "bun:test";
import { STREAM_STALE, streamAction } from "./api";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;
const now = 1_000_000;

describe("streamAction", () => {
  test("keeps an open stream that heard something recently", () => {
    expect(streamAction(OPEN, now - 30_000, now, false)).toBe("keep");
    expect(streamAction(OPEN, now - STREAM_STALE, now, false)).toBe("keep");
  });

  test("recycles an open stream that has gone quiet past two pings", () => {
    expect(streamAction(OPEN, now - STREAM_STALE - 1, now, false)).toBe("recycle");
    // a tab back from a night in the background
    expect(streamAction(OPEN, now - 12 * 3_600_000, now, false)).toBe("recycle");
  });

  test("leaves a connecting stream to the browser's own retry", () => {
    expect(streamAction(CONNECTING, now - 12 * 3_600_000, now, false)).toBe("keep");
  });

  test("reopens a stream the browser gave up on, once", () => {
    expect(streamAction(CLOSED, now, now, false)).toBe("reopen");
    expect(streamAction(CLOSED, now, now, true)).toBe("keep");
  });
});
