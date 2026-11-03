/**
 * Web push to Eric's browsers when no page is open (FR-042,
 * docs/superpowers/specs/2026-10-25-pwa-push-design.md). The hub keeps the
 * VAPID pair in `<configDir>/push/vapid.json` and one subscription per
 * browser in `subscriptions.json` (both 0600, written through a temp file
 * and a rename), reads the server's own "needs you" list (core/push.ts)
 * again at most every `PUSH_DEBOUNCE` after a change, and sends each new
 * note to every browser on one serial queue.
 *
 * - A note holds `PUSH_PRESENT_HOLD` while a page of Eric's is about (an
 *   event stream open, or a page's request within `PUSH_PRESENT_WINDOW`),
 *   and goes at once when an ask has under two minutes left. An item that
 *   is gone by the time its note is due is dropped, not sent.
 * - A 404 or 410 removes the browser; `PUSH_FAILS` other failures in a row
 *   mark it stale; a 413 sends the title alone; a 429 waits `Retry-After`
 *   once. The payload never carries a token or an answer key.
 * - `POST /api/push/subscribe` wants the caller's kind to be `page`: shells
 *   and the ranger hold operate too, and must not subscribe a stranger.
 * - The `canopy:push` health check is fed after start and every pass.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ProbeResult } from "../core/health";
import {
  afterSend,
  entryView,
  isStale,
  parseSubscribe,
  PUSH_DEBOUNCE,
  PUSH_PRESENT_HOLD,
  PUSH_PRESENT_WINDOW,
  PUSH_QUIET,
  PUSH_SUBS,
  PUSH_TTL,
  pushDue,
  pushGuard,
  pushPayload,
  pushSnapshot,
  TEST_NOTE,
  withSubscription,
  type PushGuard,
  type PushInput,
  type PushKeyInfo,
  type PushListInfo,
  type PushNote,
  type PushSubscription,
  type PushTestResult,
} from "../core/push";
import { b64url, buildPush, generateVapid, outcomeOf, rawPublicKey, type PushOutcome, type VapidPair } from "../core/webpush";
import type { Caller } from "./callers";

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** the longest a 429's Retry-After is honoured, ms */
const RETRY_MAX = 60_000;

/** what the hub needs of a push service: fetch's shape, narrowed */
export type PushFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: Uint8Array }) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

export interface PushHubDeps {
  /** `<configDir>/push` */
  dir: string;
  /** the `mailto:` the services are given, `config.push.subject` */
  subject: string;
  /** this backend's name, kept on every entry */
  backend: string;
  /** the server's own state, read on every pass */
  snapshot: () => PushInput;
  /** how many event streams pages hold open right now */
  streams: () => number;
  fetch?: PushFetch;
  now?: () => number;
  /** the health check hears this after start and every pass */
  onHealth?: (r: ProbeResult) => void;
  log?: (line: string) => void;
  /** timings, shrunk by tests */
  debounce?: number;
  hold?: number;
  quiet?: number;
  cap?: number;
}

export type { PushKeyInfo, PushListInfo, PushTestResult };

interface VapidFile extends VapidPair {
  subject: string;
  createdAt: number;
}

const defaultFetch: PushFetch = async (url, init) => {
  const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  // the body is read so the connection is released; a service's words are
  // not kept, the status says what the hub needs
  await r.arrayBuffer().catch(() => undefined);
  return r;
};

const words = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class PushHub {
  private vapid: VapidFile | null = null;
  /** why the key could not be read or made */
  private keyError: string | null = null;
  private subs: PushSubscription[] = [];
  private guard: PushGuard | null = null;
  private epoch = 0;
  private pokeTimer: ReturnType<typeof setTimeout> | null = null;
  /** notes due later, by key */
  private due = new Map<string, { note: PushNote; timer: ReturnType<typeof setTimeout> }>();
  /** sends and writes, one after another */
  private chain: Promise<void> = Promise.resolve();
  private lastError: string | null = null;
  private pageAt = 0;
  private stopped = false;
  private readonly now: () => number;
  private readonly fetch: PushFetch;

  constructor(private readonly deps: PushHubDeps) {
    this.now = deps.now ?? Date.now;
    this.fetch = deps.fetch ?? defaultFetch;
  }

  private get vapidFile(): string {
    return join(this.deps.dir, "vapid.json");
  }

  private get subsFile(): string {
    return join(this.deps.dir, "subscriptions.json");
  }

  /** the key pair (made on first use) and the subscriptions, off the files */
  async start(): Promise<void> {
    try {
      await mkdir(this.deps.dir, { recursive: true, mode: 0o700 });
      this.vapid = await this.loadVapid();
      this.keyError = null;
    } catch (err) {
      this.vapid = null;
      this.keyError = `the push key could not be kept: ${words(err)}`;
      this.deps.log?.(`push: ${this.keyError}`);
    }
    try {
      const text = await readFile(this.subsFile, "utf8");
      const read: unknown = JSON.parse(text);
      this.subs = Array.isArray(read) ? read.filter(isSubscription) : [];
    } catch {
      this.subs = [];
    }
    this.report();
  }

  private async loadVapid(): Promise<VapidFile> {
    try {
      const read: unknown = JSON.parse(await readFile(this.vapidFile, "utf8"));
      if (isVapidFile(read)) return { ...read, subject: this.deps.subject };
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
    }
    const pair = await generateVapid();
    const file: VapidFile = { ...pair, subject: this.deps.subject, createdAt: this.now() };
    await this.write(this.vapidFile, file);
    this.deps.log?.("push: made a VAPID key pair");
    return file;
  }

  private async write(file: string, data: unknown): Promise<void> {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  private saveSubs(): Promise<void> {
    const snapshot = this.subs;
    return this.write(this.subsFile, snapshot).catch((err: unknown) => {
      this.lastError = `the subscriptions could not be written: ${words(err)}`;
      this.deps.log?.(`push: ${this.lastError}`);
    });
  }

  /** the public key a browser subscribes with, base64url, or null without one */
  publicKey(): string | null {
    return this.vapid ? b64url(rawPublicKey(this.vapid.publicKey)) : null;
  }

  /** a page of Eric's made a request: presence for `PUSH_PRESENT_WINDOW` */
  sawPage(): void {
    this.pageAt = this.now();
  }

  private present(): boolean {
    return this.deps.streams() > 0 || this.now() - this.pageAt < PUSH_PRESENT_WINDOW;
  }

  /** a start, a stream back, the flows lock adopted: the next read re-seeds */
  reseed(): void {
    this.epoch++;
  }

  /** something the snapshot reads changed; a pass runs once the burst settles */
  poke(): void {
    if (this.stopped || this.pokeTimer) return;
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null;
      this.pass();
    }, this.deps.debounce ?? PUSH_DEBOUNCE);
  }

  /** the snapshot again; every new note is scheduled for when it is due */
  pass(): void {
    if (this.stopped) return;
    const now = this.now();
    const snap = pushSnapshot(this.deps.snapshot());
    const step = pushGuard(this.guard, snap, this.epoch, now, this.deps.quiet ?? PUSH_QUIET);
    this.guard = step.guard;
    // a note that is already due keeps its time; a hold's end is never pushed back
    for (const note of step.notes) {
      if (this.due.has(note.key)) continue;
      const at = pushDue(note, this.present(), now, this.deps.hold ?? PUSH_PRESENT_HOLD);
      const timer = setTimeout(() => void this.fire(note.key), Math.max(0, at - now));
      this.due.set(note.key, { note, timer });
    }
  }

  /** a due note goes if its item still waits, to every browser */
  private async fire(key: string): Promise<void> {
    const held = this.due.get(key);
    this.due.delete(key);
    if (!held || this.stopped) return;
    const snap = pushSnapshot(this.deps.snapshot());
    const live = snap[key];
    if (!live) return;
    await this.sendAll(live, Object.keys(snap).length);
  }

  /** one push to every browser, the device tab's and the CLI's test */
  test(): Promise<PushTestResult> {
    const count = Object.keys(pushSnapshot(this.deps.snapshot())).length;
    return this.sendAll(TEST_NOTE, count);
  }

  private sendAll(note: PushNote, count: number): Promise<PushTestResult> {
    const run = this.chain.then(async () => {
      const tally = { sent: 0, failed: 0, gone: 0 };
      if (!this.vapid || this.subs.length === 0) return { ...tally, entries: this.subs.map(entryView) };
      for (const sub of this.subs.slice()) {
        const outcome = await this.sendOne(sub, note, count);
        this.subs = afterSend(this.subs, sub.client, outcome, this.now());
        if (outcome === "sent") tally.sent++;
        else if (outcome === "gone") tally.gone++;
        else tally.failed++;
      }
      await this.saveSubs();
      this.report();
      return { ...tally, entries: this.subs.map(entryView) };
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** one POST, with the title alone after a 413 and one wait after a 429 */
  private async sendOne(sub: PushSubscription, note: PushNote, count: number, retried = false): Promise<PushOutcome> {
    if (!this.vapid) return "failed";
    try {
      const req = await buildPush(sub, pushPayload(note, count), this.vapid, { ttl: PUSH_TTL, urgency: note.urgency, now: this.now() });
      const res = await this.fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
      const outcome = outcomeOf(res.status);
      if (outcome === "too-big" && note.body !== "") return this.sendOne(sub, { ...note, body: "" }, count, retried);
      if (outcome === "retry" && !retried) {
        const after = Number(res.headers.get("retry-after") ?? "1");
        await new Promise((r) => setTimeout(r, Math.min(RETRY_MAX, Number.isFinite(after) ? after * 1000 : 1000)));
        return this.sendOne(sub, note, count, true);
      }
      if (outcome !== "sent" && outcome !== "gone") this.lastError = `${sub.device || sub.client}: the push service answered ${res.status}`;
      if (outcome === "gone") this.deps.log?.(`push: ${sub.device || sub.client} is gone (${res.status}), dropped`);
      return outcome === "retry" ? "failed" : outcome;
    } catch (err) {
      this.lastError = `${sub.device || sub.client}: ${words(err)}`;
      return "failed";
    }
  }

  /** the check's reading: no key is down, no browser is off, all stale is down */
  probe(): ProbeResult {
    if (this.keyError) return { state: "down", why: this.keyError, ...(this.lastError ? { detail: this.lastError } : {}) };
    if (this.subs.length === 0) return { state: "off", why: "no browser has turned push on" };
    const stale = this.subs.filter(isStale).length;
    if (stale === this.subs.length) return { state: "down", why: `every subscribed browser is stale: the last ${this.subs.length === 1 ? "pushes to it" : "pushes"} failed`, ...(this.lastError ? { detail: this.lastError } : {}) };
    const detail = `${this.subs.length} browser${this.subs.length === 1 ? "" : "s"}${stale ? `, ${stale} stale` : ""}`;
    return { state: "ok", detail };
  }

  private report(): void {
    try {
      this.deps.onHealth?.(this.probe());
    } catch (err) {
      this.deps.log?.(`push: health ${words(err)}`);
    }
  }

  list(): PushListInfo {
    return { vapid: this.vapid !== null, subject: this.deps.subject, ...(this.keyError ? { why: this.keyError } : {}), entries: this.subs.map(entryView) };
  }

  /** the routes under /api/push, or null */
  async handle(req: Request, url: URL, caller: Caller | null): Promise<Response | null> {
    const path = url.pathname;
    const method = req.method;
    if (path === "/api/push/key" && method === "GET") {
      const client = url.searchParams.get("client");
      const mine = client ? (this.subs.find((s) => s.client === client) ?? null) : undefined;
      const info: PushKeyInfo = { key: this.publicKey(), subject: this.deps.subject, ...(this.keyError ? { why: this.keyError } : {}), ...(mine !== undefined ? { mine: mine ? entryView(mine) : null } : {}) };
      return json(info);
    }
    if (path === "/api/push" && method === "GET") return json(this.list());
    if (path === "/api/push/test" && method === "POST") return json(await this.test());
    if (path === "/api/push/subscribe" && method === "POST") {
      // a shell's or the ranger's token holds operate too; only a page may
      // subscribe, and only its own browser
      if (caller && caller.kind !== "page") return json({ error: "only canopy's page subscribes itself to push" }, 403);
      if (!this.vapid) return json({ error: this.keyError ?? "this backend has no push key" }, 503);
      const b = parseSubscribe(await req.json().catch(() => null));
      if ("error" in b) return json({ error: b.error }, 400);
      const held = this.subs.find((s) => s.client === b.client);
      if (held && held.endpoint !== b.endpoint && !b.replace) return json({ error: "this browser already holds a different subscription; send replace: true to take its place" }, 409);
      const now = this.now();
      const entry: PushSubscription = { client: b.client, endpoint: b.endpoint, keys: b.keys, device: b.device, backend: this.deps.backend, createdAt: held?.endpoint === b.endpoint ? held.createdAt : now, usedAt: now, failures: 0 };
      await this.replace(withSubscription(this.subs, entry, this.deps.cap ?? PUSH_SUBS));
      return json({ ok: true, entry: entryView(entry) });
    }
    if (path === "/api/push/subscribe" && method === "DELETE") {
      const client = url.searchParams.get("client") ?? "";
      if (!/^[0-9a-f]{16}$/.test(client)) return json({ error: "client must be a browser's 16-hex id" }, 400);
      const had = this.subs.some((s) => s.client === client);
      if (had) await this.replace(this.subs.filter((s) => s.client !== client));
      return json({ ok: true, removed: had });
    }
    return null;
  }

  /** a new list, written behind any send in flight */
  private replace(subs: PushSubscription[]): Promise<void> {
    const run = this.chain.then(async () => {
      this.subs = subs;
      await this.saveSubs();
      this.report();
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  stop(): void {
    this.stopped = true;
    if (this.pokeTimer) clearTimeout(this.pokeTimer);
    this.pokeTimer = null;
    for (const { timer } of this.due.values()) clearTimeout(timer);
    this.due.clear();
  }
}

const isSubscription = (v: unknown): v is PushSubscription => {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const keys = o.keys;
  return (
    typeof o.client === "string" &&
    typeof o.endpoint === "string" &&
    !!keys &&
    typeof keys === "object" &&
    typeof (keys as Record<string, unknown>).p256dh === "string" &&
    typeof (keys as Record<string, unknown>).auth === "string" &&
    typeof o.device === "string" &&
    typeof o.backend === "string" &&
    typeof o.createdAt === "number" &&
    typeof o.usedAt === "number" &&
    typeof o.failures === "number"
  );
};

const isVapidFile = (v: unknown): v is VapidFile => {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const jwk = (k: unknown): boolean => !!k && typeof k === "object" && (k as Record<string, unknown>).kty === "EC" && typeof (k as Record<string, unknown>).x === "string";
  return jwk(o.publicKey) && jwk(o.privateKey) && typeof (o.privateKey as Record<string, unknown>).d === "string" && typeof o.createdAt === "number";
};
