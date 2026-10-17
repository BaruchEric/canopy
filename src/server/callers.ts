/**
 * The callers this backend knows: `<config dir>/callers.json`, one entry per
 * token as `{hash, ...Caller}`. The token itself is never kept, only its
 * SHA-256 hex, so a copy of the file lets nobody in.
 *
 * Pair requests, tickets and the first code live in memory only; a restart
 * drops them, which is what they should do.
 */

import { readFileSync, renameSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { allows, kindOfLabel, needs, PAIR_KINDS, type CallerKind, type PairKind, type Right } from "../core/callers";
import { configDir } from "../core/store";
import type { PendingPair } from "../core/types";

export type Caller = { id: string; kind: CallerKind; label: string; term?: string; run?: string; created: number; used: number };

type Kept = Caller & { hash: string };
type Ticketed = "shell" | "helper";
type Pair = { id: string; label: string; addr: string; kind: PairKind; code: string; secret: string; at: number; state: "waiting" | "approved" | "denied" };

const KINDS: readonly CallerKind[] = ["page", "cli", "shell", "ranger", "coordinator", "helper", "none"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DAY = 24 * 60 * 60 * 1000;
/** a session of a person is over after this long unused */
const SESSION_IDLE = 30 * DAY;
const TICKET_LIFE = 60 * 1000;
const PAIR_LIFE = 10 * 60 * 1000;
const MOST_PAIRS = 3;
/** new pair requests the whole server takes in one rolling minute */
const MOST_NEW_PAIRS = 6;
const PAIR_RATE = 60 * 1000;
/** how often a bump of `used` is worth a write */
const SAVE_EVERY = 60 * 1000;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const b64 = (n: number): string => randomBytes(n).toString("base64url");
const code = (): string => Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
const isSession = (kind: CallerKind): boolean => kind === "page" || kind === "cli";

/** The file read back; an entry that does not check out is left out. Null
 *  when the file is not a JSON array at all. */
function parseKept(raw: string): Kept[] | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const out: Kept[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r["hash"] !== "string" || typeof r["id"] !== "string" || typeof r["label"] !== "string") continue;
    const kind = KINDS.find((k) => k === r["kind"]);
    if (!kind) continue;
    if (typeof r["created"] !== "number" || typeof r["used"] !== "number") continue;
    out.push({
      hash: r["hash"],
      id: r["id"],
      kind,
      label: r["label"],
      created: r["created"],
      used: r["used"],
      ...(typeof r["term"] === "string" ? { term: r["term"] } : {}),
      ...(typeof r["run"] === "string" ? { run: r["run"] } : {}),
    });
  }
  return out;
}

export class CallerBook {
  private callers: Kept[];
  private pairs = new Map<string, Pair>();
  private tickets = new Map<string, { callerId: string; right: Ticketed; at: number }>();
  /** when each recent new pair request came, for the per-minute cap */
  private pairTimes: number[] = [];
  /** the pairs a renewal replaced, with their secrets, so only their asker is told */
  private replacedPairs = new Map<string, { secret: string; at: number }>();
  private first: string | null = null;
  private lastSave = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly now: () => number;
  /** told the ids of the callers just dropped (a revoke, a shell or run
   *  ending, prune, expiry), so the server can close the sockets they hold */
  onDrop: (ids: readonly string[]) => void = () => {};

  constructor(opts: { file?: string; now?: () => number } = {}) {
    this.file = opts.file ?? join(configDir(), "callers.json");
    this.now = opts.now ?? Date.now;
    this.callers = this.load();
    this.lastSave = this.now();
  }

  /** Only a missing file is an empty book. A file that cannot be read or
   *  parsed is moved aside, not overwritten, and the book starts empty. */
  private load(): Kept[] {
    let reason: string;
    try {
      const parsed = parseKept(readFileSync(this.file, "utf8"));
      if (parsed) return parsed;
      reason = "not a JSON array";
    } catch (err) {
      if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") return [];
      reason = err instanceof Error ? err.message : String(err);
    }
    const aside = `${this.file}.corrupt-${Date.now()}`;
    let moved = aside;
    try {
      renameSync(this.file, aside);
    } catch (err) {
      moved = `${aside} (move failed: ${err instanceof Error ? err.message : String(err)})`;
    }
    console.error(`callers: ${this.file} could not be read (${reason}); moved to ${moved}; every page, CLI and helper must sign in again`);
    return [];
  }

  /** Resolves once every write queued so far has settled, failed or not. */
  async flush(): Promise<void> {
    await this.chain;
  }

  /** Queue a write of what the book holds when the write runs: one after
   *  another, through a temp file and a rename. Memory changes first, so a
   *  revoke bites at once even while the write waits. A failure is logged
   *  here and rejects the returned promise; `chain` itself never rejects. */
  private save(): Promise<void> {
    this.lastSave = this.now();
    const run = this.chain.then(async () => {
      const dir = dirname(this.file);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `.${basename(this.file)}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`);
      await writeFile(tmp, `${JSON.stringify(this.callers, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    this.chain = run.catch(() => {});
    return run.catch((err: unknown) => {
      console.error(`callers: could not write ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    });
  }

  private strip({ hash: _h, ...caller }: Kept): Caller {
    return caller;
  }

  mint(kind: CallerKind, opts: { label: string; term?: string; run?: string }): { token: string; caller: Caller } {
    const token = `cnp_${kind}_${b64(32)}`;
    const at = this.now();
    const kept: Kept = {
      hash: sha(token),
      id: b64(6),
      kind,
      label: opts.label,
      created: at,
      used: at,
      ...(opts.term !== undefined ? { term: opts.term } : {}),
      ...(opts.run !== undefined ? { run: opts.run } : {}),
    };
    this.callers.push(kept);
    this.save().catch(() => {});
    return { token, caller: this.strip(kept) };
  }

  /** The caller a token belongs to, or null. A use counts as the session's
   *  last; a page or cli session unused for 30 days is over. The bump is
   *  written at most once a minute, so a restart loses a minute of it. */
  check(token: string | null): Caller | null {
    if (!token) return null;
    const hash = sha(token);
    const kept = this.callers.find((c) => c.hash === hash);
    if (!kept) return null;
    const at = this.now();
    if (isSession(kept.kind) && at - kept.used > SESSION_IDLE) {
      this.remove((c) => c === kept).catch(() => {});
      return null;
    }
    kept.used = at;
    if (at - this.lastSave >= SAVE_EVERY) this.save().catch(() => {});
    return this.strip(kept);
  }

  /** Drops at once in memory; the promise settles with the write and
   *  rejects when it fails, so a route can say so. Nobody has to await it,
   *  but one that does not should add its own catch. */
  private remove(drop: (c: Kept) => boolean): Promise<boolean> {
    const gone = this.callers.filter(drop);
    if (gone.length === 0) return Promise.resolve(false);
    this.callers = this.callers.filter((c) => !drop(c));
    this.onDrop(gone.map((c) => c.id));
    return this.save().then(() => true);
  }

  /** resolves true when there was such a caller */
  revoke(id: string): Promise<boolean> {
    return this.remove((c) => c.id === id);
  }

  dropTerm(term: string): Promise<void> {
    return this.remove((c) => c.term === term).then(() => {});
  }

  dropRun(run: string): Promise<void> {
    return this.remove((c) => c.run === run).then(() => {});
  }

  /** drops shell callers whose terminal is gone */
  prune(liveTerms: ReadonlySet<string>): Promise<void> {
    return this.remove((c) => c.kind === "shell" && (c.term === undefined || !liveTerms.has(c.term))).then(() => {});
  }

  list(): Caller[] {
    return this.callers.map((c) => this.strip(c));
  }

  /** a one-use ticket, good for 60 s, for a socket that cannot send a header */
  ticket(callerId: string, right: Ticketed): string {
    if (!this.callers.some((c) => c.id === callerId)) throw new Error("no such caller");
    const ticket = b64(32);
    this.tickets.set(ticket, { callerId, right, at: this.now() });
    return ticket;
  }

  redeem(ticket: string, right: Ticketed): Caller | null {
    const got = this.tickets.get(ticket);
    if (!got) return null;
    this.tickets.delete(ticket);
    const at = this.now();
    for (const [k, v] of this.tickets) if (at - v.at > TICKET_LIFE) this.tickets.delete(k);
    if (got.right !== right || at - got.at > TICKET_LIFE) return null;
    const kept = this.callers.find((c) => c.id === got.callerId);
    return kept ? this.strip(kept) : null;
  }

  private sweepPairs(): void {
    const at = this.now();
    for (const [id, p] of this.pairs) if (at - p.at > PAIR_LIFE) this.pairs.delete(id);
  }

  private waiting(): Pair[] {
    this.sweepPairs();
    return [...this.pairs.values()].filter((p) => p.state === "waiting");
  }

  /** A new request. The server takes at most 6 a minute, whoever they come
   *  from, since docker-proxy gives every client one address. `renew` is the
   *  id and secret of the asker's own waiting request: with both right, that
   *  one is replaced and its claim then says so. Anything else is a new
   *  request, so nobody can cancel another's by sending the same label.
   *  `kind` is what the asker says it signs in as; a caller that sends none
   *  (an older CLI) gets the one its label names. */
  pair(label: string, addr: string, kind?: PairKind, renew?: { id: string; secret: string }): { id: string; code: string; secret: string } | { error: string } {
    const at = this.now();
    this.pairTimes = this.pairTimes.filter((t) => at - t < PAIR_RATE);
    if (this.pairTimes.length >= MOST_NEW_PAIRS) return { error: `more than ${MOST_NEW_PAIRS} pair requests in a minute; deny the ones you do not recognize from a signed-in page's inbox, or wait for them to expire` };
    const old = renew ? this.pairs.get(renew.id) : undefined;
    if (renew && old && old.state === "waiting" && old.secret === renew.secret) {
      this.pairs.delete(old.id);
      this.replacedPairs.set(old.id, { secret: old.secret, at });
    }
    if (this.waiting().length >= MOST_PAIRS) return { error: `${MOST_PAIRS} pair requests already wait; deny the ones you do not recognize from a signed-in page's inbox, or wait for them to expire` };
    this.pairTimes.push(at);
    const name = label.slice(0, 80);
    const p: Pair = { id: b64(6), label: name, addr, kind: kind ?? kindOfLabel(name), code: code(), secret: b64(32), at, state: "waiting" };
    this.pairs.set(p.id, p);
    return { id: p.id, code: p.code, secret: p.secret };
  }

  /** Whether this pair was replaced by a renewal, told only to its own asker. */
  replaced(id: string, secret: string): boolean {
    const at = this.now();
    for (const [k, v] of this.replacedPairs) if (at - v.at > PAIR_LIFE) this.replacedPairs.delete(k);
    return this.replacedPairs.get(id)?.secret === secret;
  }

  pending(): PendingPair[] {
    return this.waiting().map(({ id, label, addr, code, at, kind }) => ({ id, label, addr, code, at, kind }));
  }

  approve(id: string): boolean {
    const p = this.waiting().find((x) => x.id === id);
    if (!p) return false;
    p.state = "approved";
    return true;
  }

  deny(id: string): boolean {
    const p = this.waiting().find((x) => x.id === id);
    if (!p) return false;
    p.state = "denied";
    return true;
  }

  /** What the asker holding the secret gets: its token once approved (once
   *  only), "waiting" until then, null for a wrong secret, a denial or an
   *  unknown or expired pair. The kind is the one the request asked for. */
  claim(id: string, secret: string): string | "waiting" | null {
    this.sweepPairs();
    const p = this.pairs.get(id);
    if (!p || p.secret !== secret) return null;
    if (p.state === "waiting") return "waiting";
    this.pairs.delete(id);
    if (p.state === "denied") return null;
    return this.mint(p.kind, { label: p.label }).token;
  }

  /** Whether a claim with this secret is a wrong guess at a live pair, the
   *  one kind of failed claim worth counting: a page still polling a pair
   *  that was denied, claimed or has expired is not guessing. */
  wrongSecret(id: string, secret: string): boolean {
    this.sweepPairs();
    const p = this.pairs.get(id);
    return p !== undefined && p.secret !== secret;
  }

  /** The code shown in the server's own log while nobody can approve a pair:
   *  there is one only while the book holds no live page or cli session. One
   *  unused for 30 days counts for nothing, since its token no longer works. */
  firstCode(): string | null {
    const at = this.now();
    if (this.callers.some((c) => isSession(c.kind) && at - c.used <= SESSION_IDLE)) return null;
    this.first ??= code();
    return this.first;
  }

  /** The first code approves a waiting pair, once; the code is burned. */
  useFirst(given: string, pairId: string): boolean {
    const have = this.firstCode();
    if (have === null || given !== have) return false;
    if (!this.approve(pairId)) return false;
    this.first = null;
    return true;
  }
}

export type CallersMode = "off" | "log" | "enforce";

/** `CANOPY_CALLERS`, log unless it says off or enforce. Anything else is a
 *  typo, said once and read as log. */
export function callersMode(env: Record<string, string | undefined> = process.env): CallersMode {
  const raw = env["CANOPY_CALLERS"]?.trim() ?? "";
  if (raw === "off" || raw === "log" || raw === "enforce") return raw;
  if (raw) console.warn(`callers: CANOPY_CALLERS=${raw} is not off, log or enforce; checking in log mode`);
  return "log";
}

/** The two sockets a browser opens cannot carry a header, so each takes a
 *  ticket in the query instead, for the right it needs. */
const upgradeRight = (path: string): Ticketed | null => (path === "/api/term" ? "shell" : path === "/api/helper" ? "helper" : null);

/** Who is calling: the `X-Canopy-Token` header, else a ticket on one of the
 *  two upgrades. Null for nobody known. A ticket is spent here, so this runs
 *  once per request. */
export function callerOf(book: CallerBook, req: Request, url: URL): Caller | null {
  const token = req.headers.get("x-canopy-token");
  if (token) return book.check(token);
  const right = upgradeRight(url.pathname);
  const ticket = url.searchParams.get("ticket");
  return right && ticket ? book.redeem(ticket, right) : null;
}

export type Refused = { kind: CallerKind; route: string; origin: string; ua: string; at: number };

const RECENT = 20;
const GUESS_WINDOW = 10 * 60 * 1000;
const MOST_GUESSES = 10;

const isAuth = (path: string): boolean => path === "/api/auth" || path.startsWith("/api/auth/");

/** A 401 for nobody known, a 403 for a caller without the right. Never a
 *  `login` key: the page reads that as the edge gate's sign-in. */
function refusal(right: Right, caller: Caller | null): Response {
  return Response.json(
    { error: `this call needs the ${right} right; run canopy auth login, or open a new shell`, need: right },
    { status: caller ? 403 : 401 },
  );
}

/** The check at the top of route(), what it refused, the guesses at the
 *  pairing routes, and the first code as last printed. */
export class CallerGate {
  readonly book: CallerBook;
  readonly mode: CallersMode;
  /** every refusal since start, would-refuse ones in log mode included; the newest 20, newest first */
  readonly refused: { count: number; recent: Refused[] } = { count: 0, recent: [] };
  private readonly log: (line: string) => void;
  private readonly onPairs: (pending: PendingPair[]) => void;
  private readonly onRefused: () => void;
  private readonly now: () => number;
  /** the would-refuse lines already logged, by kind, method and path */
  private readonly said = new Set<string>();
  /** failed guesses by route and address, as times */
  private readonly misses = new Map<string, number[]>();
  private shown: string | null = null;

  constructor(opts: {
    book: CallerBook;
    mode: CallersMode;
    log: (line: string) => void;
    onPairs?: (pending: PendingPair[]) => void;
    onRefused?: () => void;
    now?: () => number;
  }) {
    this.book = opts.book;
    this.mode = opts.mode;
    this.log = opts.log;
    this.onPairs = opts.onPairs ?? (() => {});
    this.onRefused = opts.onRefused ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  /** Null lets the request through, anything else is the answer. The auth
   *  routes are checked in every mode, so a token nobody approved while
   *  nothing was enforced cannot be one later. */
  gate(req: Request, url: URL, caller: Caller | null): Response | null {
    const auth = isAuth(url.pathname);
    if (this.mode === "off" && !auth) return null;
    // a HEAD is a GET without the body
    const right = needs(req.method === "HEAD" ? "GET" : req.method, url.pathname);
    if (right === "open") return null;
    const kind = caller?.kind ?? "none";
    if (allows(kind, right)) return null;
    this.refused.count++;
    this.refused.recent.unshift({
      kind,
      route: `${req.method} ${url.pathname}`,
      origin: req.headers.get("origin") ?? "",
      ua: req.headers.get("user-agent") ?? "",
      at: this.now(),
    });
    if (this.refused.recent.length > RECENT) this.refused.recent.length = RECENT;
    this.onRefused();
    if (this.mode === "log" && !auth) {
      const key = `${kind} ${req.method} ${url.pathname}`;
      if (!this.said.has(key)) {
        this.said.add(key);
        this.log(`callers: would refuse ${key} (needs ${right})`);
      }
      return null;
    }
    return refusal(right, caller);
  }

  /** whether `addr` has missed at `route` ten times in the last ten minutes */
  locked(route: string, addr: string): boolean {
    const at = this.now();
    for (const [key, times] of this.misses) {
      const recent = times.filter((t) => at - t < GUESS_WINDOW);
      if (recent.length) this.misses.set(key, recent);
      else this.misses.delete(key);
    }
    return (this.misses.get(`${route} ${addr}`)?.length ?? 0) >= MOST_GUESSES;
  }

  missed(route: string, addr: string): void {
    const key = `${route} ${addr}`;
    this.misses.set(key, [...(this.misses.get(key) ?? []), this.now()]);
  }

  pairsChanged(): void {
    this.onPairs(this.book.pending());
  }

  /** Prints the first sign-in code when there is one not printed yet. */
  announce(): void {
    const code = this.book.firstCode();
    if (code && code !== this.shown) this.log(`canopy: first sign-in code ${code} (good until a page or the CLI signs in)`);
    this.shown = code;
  }
}

type Body = Record<string, unknown>;

const isBody = (v: unknown): v is Body => typeof v === "object" && v !== null && !Array.isArray(v);

const field = (b: Body, k: string): string | null => {
  const v = b[k];
  return typeof v === "string" && v !== "" ? v : null;
};

const ticketRight = (v: unknown): Ticketed | null => (v === "term" ? "shell" : v === "helper" ? "helper" : null);

/** `/api/auth` and below, after the gate has passed the request; null for
 *  any other path. `addr` is the client's address, which a pair request
 *  shows and the guess limit counts by. */
export async function authRoute(book: CallerBook, gate: CallerGate, req: Request, url: URL, caller: Caller | null, addr: string): Promise<Response | null> {
  if (!isAuth(url.pathname)) return null;
  const json = (body: unknown, status = 200): Response => Response.json(body, { status });
  if (url.pathname === "/api/auth") {
    if (req.method !== "GET") return json({ error: "/api/auth only answers a GET" }, 405);
    return json({ mode: gate.mode, refused: gate.refused, callers: book.list(), pending: book.pending(), you: caller?.kind ?? "none", youId: caller?.id ?? null });
  }
  if (req.method !== "POST") return json({ error: "the auth routes take a POST" }, 405);
  const raw: unknown = await req.json().catch(() => null);
  const b: Body = isBody(raw) ? raw : {};
  const route = url.pathname.slice("/api/auth/".length);
  const tooMany = (): Response => json({ error: "too many wrong tries from this address; try again in ten minutes" }, 429);
  switch (route) {
    case "pair": {
      const label = field(b, "label");
      if (!label) return json({ error: "a pair request needs a label" }, 400);
      const kind = b["kind"] === undefined ? undefined : PAIR_KINDS.find((k) => k === b["kind"]);
      if (b["kind"] !== undefined && !kind) return json({ error: `kind is one of ${PAIR_KINDS.join(", ")}` }, 400);
      const renew = field(b, "id") && field(b, "secret") ? { id: field(b, "id") as string, secret: field(b, "secret") as string } : undefined;
      const got = book.pair(label, addr, kind, renew);
      if ("error" in got) return json({ error: got.error }, 429);
      gate.pairsChanged();
      gate.announce();
      return json(got);
    }
    case "claim": {
      if (gate.locked(route, addr)) return tooMany();
      const id = field(b, "id");
      const secret = field(b, "secret");
      if (!id || !secret) return json({ error: "id and secret are required" }, 400);
      const guess = book.wrongSecret(id, secret);
      const got = book.claim(id, secret);
      if (got === "waiting") return json({ waiting: true });
      if (got === null) {
        if (guess) gate.missed(route, addr);
        if (book.replaced(id, secret)) return json({ error: "this request was replaced by a newer one from the same asker" }, 404);
        return json({ error: "no such pair request: it was denied, claimed, or has expired" }, 404);
      }
      gate.announce();
      return json({ token: got });
    }
    case "first": {
      if (gate.locked(route, addr)) return tooMany();
      const id = field(b, "id");
      const given = field(b, "code");
      if (!id || !given) return json({ error: "id and code are required" }, 400);
      if (!book.useFirst(given.trim().toUpperCase(), id)) {
        gate.missed(route, addr);
        return json({ error: "that is not the first sign-in code, or the pair request is not waiting" }, 403);
      }
      gate.pairsChanged();
      return json({ ok: true });
    }
    case "approve":
    case "deny": {
      const id = field(b, "id");
      if (!id) return json({ error: "id is required" }, 400);
      if (!(route === "approve" ? book.approve(id) : book.deny(id))) return json({ error: "no such pair request waiting" }, 404);
      gate.pairsChanged();
      return json({ ok: true });
    }
    case "revoke": {
      const id = field(b, "id");
      if (!id) return json({ error: "id is required" }, 400);
      let had: boolean;
      try {
        had = await book.revoke(id);
      } catch (err) {
        gate.announce();
        const why = err instanceof Error ? err.message : String(err);
        return json({ error: `revoked until canopy restarts, but callers.json could not be written (${why})` }, 500);
      }
      if (!had) return json({ error: "no such caller" }, 404);
      gate.announce();
      return json({ ok: true });
    }
    case "ticket": {
      const right = ticketRight(b["for"]);
      if (!right) return json({ error: `for is "term" or "helper"` }, 400);
      if (!caller || !allows(caller.kind, right)) return refusal(right, caller);
      try {
        return json({ ticket: book.ticket(caller.id, right) });
      } catch {
        // revoked since the check
        return refusal(right, null);
      }
    }
    default:
      return json({ error: `no such auth route: ${route}` }, 404);
  }
}
