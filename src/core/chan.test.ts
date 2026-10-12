import { expect, test } from "bun:test";
import { Chan } from "./chan";

const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in broker: each dial gets a stream `feed` writes into, which
 *  errors when the dial's signal aborts, as a real fetch body does. */
function broker(feed: (write: (s: string) => void, dial: number) => void) {
  const urls: string[] = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    urls.push(url);
    const dial = urls.length;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        init?.signal?.addEventListener("abort", () => ctrl.error(new Error("aborted")));
        feed((s) => {
          try {
            ctrl.enqueue(enc.encode(s));
          } catch {
            // the stream is gone
          }
        }, dial);
      },
    });
    return new Response(body, { status: 200 });
  };
  return { urls, fetcher };
}

const message = (id: number) => `id: ${id}\nevent: message\ndata: ${JSON.stringify({ id, channel: "x", handle: "a", node: "n", kind: "text", body: "hi", ts: 1 })}\n\n`;

test("a stream that goes silent is dropped and dialed again after the last id", async () => {
  const b = broker((write, dial) => {
    if (dial === 1) write(message(7));
  });
  const states: boolean[] = [];
  const chan = new Chan("http://broker", b.fetcher, 50);
  const stop = chan.follow("me", () => {}, (up) => states.push(up));
  // silent for 50 ms, then the first redial waits a second
  await sleep(1200);
  stop();
  expect(states.slice(0, 2)).toEqual([true, false]);
  expect(b.urls.length).toBeGreaterThanOrEqual(2);
  expect(b.urls[1]).toContain("since=7");
});

test("the broker's ping comments keep a quiet stream open", async () => {
  const timers: ReturnType<typeof setInterval>[] = [];
  const b = broker((write) => {
    timers.push(setInterval(() => write(": ping\n\n"), 15));
  });
  const states: boolean[] = [];
  const chan = new Chan("http://broker", b.fetcher, 50);
  const stop = chan.follow("me", () => {}, (up) => states.push(up));
  await sleep(200);
  stop();
  for (const t of timers) clearInterval(t);
  expect(states).toEqual([true]);
  expect(b.urls).toHaveLength(1);
});
