import { describe, expect, test } from "bun:test";
import { bodyUpTo } from "./body";

const post = (init: RequestInit): Request => new Request("http://x/api/clips/file", { method: "POST", ...init });

/** a body sent in chunks of `size`, at most `most` of them; counts what was asked for */
function chunks(size: number, most: number) {
  const seen = { sent: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (seen.sent >= most) return c.close();
      seen.sent++;
      c.enqueue(new Uint8Array(size).fill(seen.sent));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}

describe("bodyUpTo", () => {
  test("a body under the cap comes back whole, in order", async () => {
    const { body } = chunks(4, 3);
    const got = await bodyUpTo(post({ body }), 12);
    expect(got && [...got]).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
    expect((await bodyUpTo(post({ body: "hello" }), 5))?.byteLength).toBe(5);
  });

  test("no body is no bytes", async () => {
    expect((await bodyUpTo(post({}), 10))?.byteLength).toBe(0);
  });

  test("a length over the cap is refused before a byte is read", async () => {
    const { body, seen } = chunks(4, 3);
    expect(await bodyUpTo(post({ body, headers: { "content-length": "11" } }), 10)).toBeNull();
    expect(seen.sent).toBeLessThanOrEqual(1);
  });

  test("a body in chunks, which names no length, is read no further than the cap", async () => {
    const { body, seen } = chunks(1024, 1000);
    expect(await bodyUpTo(post({ body }), 10 * 1024)).toBeNull();
    expect(seen.cancelled).toBe(true);
    // the cap is ten chunks: the eleventh passes it, and a stream keeps one more ready
    expect(seen.sent).toBeLessThan(20);
  });
});
