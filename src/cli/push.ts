/** `canopy push test | ls` (FR-042): one push to every browser subscribed
 *  on a backend, and the list of those browsers, over the backend's API
 *  (server/push). `canopy push <repo>` is git's push and lives in index.ts;
 *  a repo folder named test or ls is pushed as ./test or ./ls. */

import type { PushEntryView } from "../core/push";
import { ask, errText, take, Unreachable, type Target } from "./health";

export const PUSH_USAGE = "usage: canopy push test [--backend URL] | ls [--backend URL]";

/** the words push's subcommands answer to */
export const PUSH_WORDS: ReadonlySet<string> = new Set(["test", "ls"]);

interface PushList {
  vapid: boolean;
  subject: string;
  why?: string;
  entries: PushEntryView[];
}

interface PushTest {
  sent: number;
  failed: number;
  gone: number;
  entries: PushEntryView[];
}

const when = (ms: number, now: number): string => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};

/** one line per browser: device, backend, when it last heard a push, its standing */
export function pushLines(list: PushList, now: number): string[] {
  const head = list.vapid ? `push key: ready (${list.subject})` : `push key: none${list.why ? ` (${list.why})` : ""}`;
  if (list.entries.length === 0) return [head, "no browser has turned push on"];
  const rows = list.entries.map((e) => `${(e.device || e.client).padEnd(24)} ${e.backend.padEnd(10)} used ${when(e.usedAt, now).padEnd(8)} ${e.stale ? `stale (${e.failures} failures)` : e.failures ? `${e.failures} failure${e.failures === 1 ? "" : "s"}` : "ok"}`);
  return [head, ...rows];
}

export function testLine(t: PushTest): string {
  const total = t.sent + t.failed + t.gone;
  if (total === 0) return "no browser has turned push on";
  const parts = [`sent to ${t.sent} of ${total}`];
  if (t.failed) parts.push(`${t.failed} failed`);
  if (t.gone) parts.push(`${t.gone} gone (dropped)`);
  return parts.join(", ");
}

export async function pushCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const home = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  const target: Target = { name: "home", urls: [home] };
  const failed = (err: unknown): never => fail(err instanceof Unreachable ? `the backend did not answer: ${err.message}` : errText(err));
  const word = args.shift();
  if (args.length > 0 || word === undefined || !PUSH_WORDS.has(word)) return fail(PUSH_USAGE);
  if (word === "ls") {
    const list = await ask<PushList>(target, "GET", "/api/push").catch(failed);
    for (const line of pushLines(list, Date.now())) console.log(line);
    return;
  }
  const got = await ask<PushTest>(target, "POST", "/api/push/test").catch(failed);
  console.log(testLine(got));
  if (got.failed > 0) process.exitCode = 1;
}
