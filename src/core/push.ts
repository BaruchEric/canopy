/**
 * Push's model (FR-042, docs/superpowers/specs/2026-10-25-pwa-push-design.md):
 * the server's own "needs you" list, a twin of what the page builds in the
 * browser, so a phone hears about an ask with no page open. Pure and
 * browser-safe; the keys, the file and the sending are server/push.ts's.
 *
 * - `pushSnapshot` keys every item that waits on Eric or failed, by the
 *   page's own namespaces, so a click lands where the page would show it.
 * - `pushTransitions` is notify.ts's `transitions` with no run-done notes.
 * - `pushGuard` is the burst guard: a new epoch (start, a stream back, the
 *   flows lock adopted) opens a quiet window in which nothing fires.
 * - the subscriptions list's rules: one entry per browser, a cap, and how a
 *   service's answer moves an entry.
 */

import { sentBack } from "./landing";
import type { TriggerEvent, TriggerStatus } from "./trigger";
import type { Ask, Flow, LandEntry, LandNotice, PrWatch, RangerInfo, Run } from "./types";
import type { PushOutcome, PushUrgency } from "./webpush";

/** browsers one backend pushes to, at most */
export const PUSH_SUBS = 20;
/** failures in a row before an entry reads stale */
export const PUSH_FAILS = 3;
/** ms between a change and the snapshot being read again */
export const PUSH_DEBOUNCE = 2_000;
/** ms a note waits while a page of Eric's is open, so the tab's note goes first */
export const PUSH_PRESENT_HOLD = 90_000;
/** a page's stream open, or a page's request, this recently is presence */
export const PUSH_PRESENT_WINDOW = 120_000;
/** an ask with less than this left goes at once, hold or not */
export const PUSH_SOON = 120_000;
/** the quiet window after an epoch change, notify.ts's `QUIET` */
export const PUSH_QUIET = 10_000;
/** the payload's cap; the services allow 4 KB */
export const PUSH_BYTES = 3072;
/** how long a service may hold a push for a sleeping phone, seconds */
export const PUSH_TTL = 3600;
/** a notification body's cap, notify.ts's line */
const LINE = 160;

export interface PushNote {
  key: string;
  title: string;
  body: string;
  /** a page route that exists; the click opens it */
  url: string;
  urgency: PushUrgency;
  /** unix ms when the item stops waiting on its own (an ask's `waitUntil`) */
  until?: number;
}

export type PushSnapshot = Record<string, PushNote>;

export interface PushInput {
  asks: readonly Ask[];
  runs: readonly Run[];
  flows: readonly Flow[];
  landing: readonly LandEntry[];
  notices: readonly LandNotice[];
  prs: readonly PrWatch[];
  triggers: readonly TriggerEvent[];
  ranger: Pick<RangerInfo, "state" | "backend" | "why"> | null;
  /** a repo's name by its id; "" when unknown */
  nameOf: (repoId: string) => string;
}

/** one line at most, short enough for a notification's body */
export const line = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > LINE ? `${one.slice(0, LINE - 1)}…` : one;
};

/** the trigger states the page files under "Needs you" (ui/src/triggers.ts) */
const TRIGGER_NEEDS: ReadonlySet<TriggerStatus> = new Set(["waiting", "stopped", "failed", "ready", "closed", "stalled"]);
export const triggerNeedsYou = (e: Pick<TriggerEvent, "status" | "needsYou">): boolean => e.needsYou !== undefined || TRIGGER_NEEDS.has(e.status);

const TRIGGER_WORD: Partial<Record<TriggerStatus, string>> = { waiting: "asking", stopped: "stopped", failed: "failed", ready: "committed, no PR", closed: "PR closed", stalled: "stalled" };

/** a PR whose red check has no fix coming: auto-fix off, or it gave up */
export function prRedNoFix(pr: Pick<PrWatch, "state" | "autoFix" | "gaveUp" | "fixing">): boolean {
  if (pr.state?.status !== "open" || pr.fixing !== undefined) return false;
  if (!pr.state.checks.some((c) => c.state === "fail")) return false;
  return !pr.autoFix || pr.gaveUp !== undefined;
}

const repoUrl = (repoId: string): string => `/?repo=${encodeURIComponent(repoId)}`;

/** A permission's line when the agent gave no description. The prompt's
 *  title is the tool's input (a Bash call's command, a file tool's path),
 *  which a push never carries, so only the tool's kind is named. */
const TOOL_WORDS: Readonly<Record<string, string>> = {
  Bash: "run a command",
  Read: "read a file",
  Edit: "change a file",
  MultiEdit: "change a file",
  Write: "write a file",
  NotebookEdit: "change a notebook",
  Network: "reach the network",
  Permissions: "widen its permissions",
};

function permissionLine(tool: string, description: string | undefined): string {
  if (description) return description;
  const known = TOOL_WORDS[tool];
  if (known) return `permission to ${known}`;
  return /^[A-Za-z][\w-]{0,63}$/.test(tool) ? `permission to use ${tool}` : "a permission";
}

/** what a run waits on, in the page's own words (ui/src/inbox.ts), less a
 *  permission's tool input */
function promptLine(run: Run): string {
  const p = run.prompt;
  if (!p) return "waiting for you";
  if (p.kind === "permission") return permissionLine(p.tool, p.description);
  if (p.kind === "proposal") return "plan to approve";
  return `question: ${p.questions[0]?.question ?? "a question"}`;
}

/** Everything that waits on Eric or failed, by key. Only what is live: a
 *  kept run (a snapshot shown after its run) never counts. */
export function pushSnapshot(input: PushInput): PushSnapshot {
  const out: PushSnapshot = {};
  const named = (repoId: string | null | undefined, fallback: string): string => (repoId ? input.nameOf(repoId) || fallback : fallback);
  for (const a of input.asks) {
    if (a.state !== "open") continue;
    const key = `inbox:ask:${a.id}`;
    out[key] = { key, title: `Waiting on you · ${a.agent || a.handle || "an agent"}`, body: line(a.title) || "an ask", url: `/?view=agents&ask=${encodeURIComponent(a.id)}`, urgency: "high", until: a.waitUntil };
  }
  for (const r of input.runs) {
    if (r.kept) continue;
    if (r.status === "waiting" && r.prompt) {
      const key = `inbox:run:${r.id}`;
      out[key] = { key, title: `Waiting on you · ${named(r.repoId, "a run")}`, body: line(promptLine(r)), url: repoUrl(r.repoId), urgency: "normal" };
    } else if (r.status === "failed") {
      const key = `failed:run:${r.id}`;
      out[key] = { key, title: `Failed · ${named(r.repoId, "a run")}`, body: line(r.error || r.action), url: repoUrl(r.repoId), urgency: "normal" };
    }
  }
  for (const f of input.flows) {
    if (f.status !== "gated") continue;
    const step = f.steps[f.current];
    const key = `inbox:flow:${f.id}`;
    out[key] = { key, title: `Waiting on you · ${named(f.repoId, "a workflow")}`, body: line(`${f.workflow} waits at a gate${step ? ` after "${step.name}"` : ""}`), url: repoUrl(f.repoId), urgency: "normal" };
  }
  for (const e of input.landing) {
    if (!sentBack(e)) continue;
    const key = `landing:${e.id}`;
    out[key] = { key, title: `Sent back · ${named(e.repoId, "a branch")}`, body: line(`${e.branch}: ${e.reason || e.gate || e.state}`), url: repoUrl(e.repoId), urgency: "normal" };
  }
  for (const n of input.notices) {
    if (n.kind !== "held") continue;
    const key = `landing:held:${n.entry}`;
    out[key] = { key, title: `Held · ${named(n.repoId, "a branch")}`, body: line(`${n.branch}: ${n.why || "held for you"}`), url: repoUrl(n.repoId), urgency: "normal" };
  }
  for (const pr of input.prs) {
    if (pr.swept !== undefined || pr.state?.status !== "open") continue;
    const red = prRedNoFix(pr);
    const held = pr.approve !== undefined;
    if (!red && !held) continue;
    const key = `pr:${pr.id}`;
    const body = red
      ? `${pr.state.checks.filter((c) => c.state === "fail").map((c) => c.name).join(", ")} failed; ${pr.gaveUp !== undefined ? `auto-fix gave up: ${pr.gaveUp}` : "auto-fix is off"}`
      : `waits for your approval: ${pr.approve?.why ?? ""}`;
    out[key] = { key, title: `PR #${pr.number} · ${named(pr.repoId, pr.slug)}`, body: line(body), url: repoUrl(pr.repoId), urgency: "normal" };
  }
  for (const e of input.triggers) {
    if (!triggerNeedsYou(e)) continue;
    const key = `trigger:${e.id}`;
    const what = e.needsYou ?? e.reason ?? TRIGGER_WORD[e.status] ?? e.status;
    out[key] = { key, title: `Needs you · ${e.rule}`, body: line(`${e.short ?? e.title}: ${what}`), url: "/?view=triggers", urgency: "normal" };
  }
  if (input.ranger?.state === "gave-up") {
    const key = `ranger:${input.ranger.backend}`;
    out[key] = { key, title: "ranger gave up", body: line(input.ranger.why ?? "it exited too often"), url: "/", urgency: "normal" };
  }
  return out;
}

/** every note in `next` that `prev` did not hold; nothing for what went away */
export function pushTransitions(prev: PushSnapshot, next: PushSnapshot): PushNote[] {
  return Object.entries(next)
    .filter(([key]) => !(key in prev))
    .map(([, note]) => note);
}

/** the guard's state between reads: the last snapshot, the epoch it was
 *  taken in, and until when nothing fires */
export interface PushGuard {
  snap: PushSnapshot;
  epoch: number;
  quietUntil: number;
}

/** The burst guard: the first read, and any read in a new epoch, seed the
 *  snapshot and open a quiet window; inside it the snapshot follows along
 *  and nothing fires. Only after it do new items turn into notes. */
export function pushGuard(prev: PushGuard | null, snap: PushSnapshot, epoch: number, now: number, quiet = PUSH_QUIET): { guard: PushGuard; notes: PushNote[] } {
  if (!prev || prev.epoch !== epoch) return { guard: { snap, epoch, quietUntil: now + quiet }, notes: [] };
  const guard = { ...prev, snap };
  if (now < prev.quietUntil) return { guard, notes: [] };
  return { guard, notes: pushTransitions(prev.snap, snap) };
}

/** When a note may go: now while no page of Eric's is about, or when the
 *  item will stop waiting before the hold would end; else after the hold. */
export function pushDue(note: Pick<PushNote, "until">, present: boolean, now: number, hold = PUSH_PRESENT_HOLD): number {
  if (!present) return now;
  if (note.until !== undefined && note.until - now < PUSH_SOON) return now;
  return now + hold;
}

export interface PushPayload {
  key: string;
  title: string;
  body: string;
  url: string;
  /** how many things wait, for the badge (plan 3) */
  count: number;
}

const bytesOf = (s: string): number => new TextEncoder().encode(s).length;

/** the payload as JSON, the body cut until it fits `PUSH_BYTES` */
export function pushPayload(note: PushNote, count: number, cap = PUSH_BYTES): string {
  let body = note.body;
  const make = (): string => JSON.stringify({ key: note.key, title: note.title, body, url: note.url, count } satisfies PushPayload);
  let text = make();
  while (bytesOf(text) > cap && body.length > 0) {
    body = body.slice(0, Math.max(0, body.length - Math.ceil((bytesOf(text) - cap) / 2) - 1));
    text = make();
  }
  return text;
}

/** a subscription as the file keeps it: one per browser (its client id) */
export interface PushSubscription {
  client: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  device: string;
  /** the backend it was posted to, which is the one that pushes */
  backend: string;
  createdAt: number;
  usedAt: number;
  /** failures in a row */
  failures: number;
}

/** an entry as `GET /api/push` shows it: never the keys or the endpoint */
export interface PushEntryView {
  client: string;
  device: string;
  backend: string;
  createdAt: number;
  usedAt: number;
  failures: number;
  stale: boolean;
}

export const isStale = (s: Pick<PushSubscription, "failures">): boolean => s.failures >= PUSH_FAILS;

export const entryView = (s: PushSubscription): PushEntryView => ({ client: s.client, device: s.device, backend: s.backend, createdAt: s.createdAt, usedAt: s.usedAt, failures: s.failures, stale: isStale(s) });

export interface SubscribeBody {
  client: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  device: string;
  replace: boolean;
}

const CLIENT = /^[0-9a-f]{16}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** the subscribe body checked field by field, or why it is refused */
export function parseSubscribe(b: unknown): SubscribeBody | { error: string } {
  if (!b || typeof b !== "object") return { error: "a subscription is {subscription: {endpoint, keys: {p256dh, auth}}, client, device}" };
  const o = b as Record<string, unknown>;
  if (typeof o.client !== "string" || !CLIENT.test(o.client)) return { error: "client must be this browser's 16-hex id" };
  const sub = o.subscription;
  if (!sub || typeof sub !== "object") return { error: "subscription must be the browser's PushSubscription" };
  const s = sub as Record<string, unknown>;
  if (typeof s.endpoint !== "string" || !/^https:\/\/\S{1,2048}$/.test(s.endpoint)) return { error: "the subscription's endpoint must be an https URL" };
  const keys = s.keys;
  if (!keys || typeof keys !== "object") return { error: "the subscription has no keys" };
  const k = keys as Record<string, unknown>;
  if (typeof k.p256dh !== "string" || !B64URL.test(k.p256dh) || typeof k.auth !== "string" || !B64URL.test(k.auth)) return { error: "the subscription's keys must be base64url p256dh and auth" };
  const device = typeof o.device === "string" ? o.device.trim().slice(0, 60) : "";
  return { client: o.client, endpoint: s.endpoint, keys: { p256dh: k.p256dh, auth: k.auth }, device, replace: o.replace === true };
}

/** The list with `entry` in it: in place of the client's old entry, else
 *  appended, the oldest `usedAt` dropped past the cap. */
export function withSubscription(list: readonly PushSubscription[], entry: PushSubscription, cap = PUSH_SUBS): PushSubscription[] {
  const kept = list.filter((s) => s.client !== entry.client);
  kept.push(entry);
  while (kept.length > cap) {
    let oldest = 0;
    for (let i = 1; i < kept.length; i++) if ((kept[i]?.usedAt ?? 0) < (kept[oldest]?.usedAt ?? 0)) oldest = i;
    kept.splice(oldest, 1);
  }
  return kept;
}

/** The list after a service answered a push to `client`: gone removes the
 *  entry, sent clears its failures, a failure counts one; a retry or a
 *  too-big answer says nothing about the browser and changes nothing. */
export function afterSend(list: readonly PushSubscription[], client: string, outcome: PushOutcome, now: number): PushSubscription[] {
  if (outcome === "gone") return list.filter((s) => s.client !== client);
  return list.map((s) => {
    if (s.client !== client) return s;
    if (outcome === "sent") return { ...s, failures: 0, usedAt: now };
    if (outcome === "failed") return { ...s, failures: s.failures + 1 };
    return s;
  });
}

/** `GET /api/push`: the entries less their keys and endpoints */
export interface PushListInfo {
  vapid: boolean;
  subject: string;
  /** why there is no key, when there is none */
  why?: string;
  entries: PushEntryView[];
}

/** `GET /api/push/key`: the public half, and this browser's own entry when it asked (`?client=`) */
export interface PushKeyInfo {
  key: string | null;
  subject: string;
  why?: string;
  mine?: PushEntryView | null;
}

/** `POST /api/push/test`: how the test push went, per outcome */
export interface PushTestResult {
  sent: number;
  failed: number;
  gone: number;
  entries: PushEntryView[];
}

/** the test push every entry gets from `canopy push test` and the device tab */
export const TEST_NOTE: PushNote = { key: "test", title: "canopy", body: "A test push. The page is closed and you still heard this.", url: "/", urgency: "normal" };
