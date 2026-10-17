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
import type { CallerKind } from "../core/callers";
import { configDir } from "../core/store";

export type Caller = { id: string; kind: CallerKind; label: string; term?: string; run?: string; created: number; used: number };

type Kept = Caller & { hash: string };
type Ticketed = "shell" | "helper";
type Pair = { id: string; label: string; addr: string; code: string; secret: string; at: number; state: "waiting" | "approved" | "denied" };

const KINDS: readonly CallerKind[] = ["page", "cli", "shell", "ranger", "coordinator", "helper", "none"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DAY = 24 * 60 * 60 * 1000;
/** a session of a person is over after this long unused */
const SESSION_IDLE = 30 * DAY;
const TICKET_LIFE = 60 * 1000;
const PAIR_LIFE = 10 * 60 * 1000;
const MOST_PAIRS = 3;
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
  private first: string | null = null;
  private lastSave = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly now: () => number;

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
    const before = this.callers.length;
    this.callers = this.callers.filter((c) => !drop(c));
    if (this.callers.length === before) return Promise.resolve(false);
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

  pair(label: string, addr: string): { id: string; code: string; secret: string } | { error: string } {
    if (this.waiting().length >= MOST_PAIRS) return { error: `${MOST_PAIRS} pair requests already wait; answer one or try again in a few minutes` };
    const p: Pair = { id: b64(6), label: label.slice(0, 80), addr, code: code(), secret: b64(32), at: this.now(), state: "waiting" };
    this.pairs.set(p.id, p);
    return { id: p.id, code: p.code, secret: p.secret };
  }

  pending(): { id: string; label: string; addr: string; code: string; at: number }[] {
    return this.waiting().map(({ id, label, addr, code, at }) => ({ id, label, addr, code, at }));
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
   *  unknown or expired pair. The kind comes from the label it sent. */
  claim(id: string, secret: string): string | "waiting" | null {
    this.sweepPairs();
    const p = this.pairs.get(id);
    if (!p || p.secret !== secret) return null;
    if (p.state === "waiting") return "waiting";
    this.pairs.delete(id);
    if (p.state === "denied") return null;
    const kind: CallerKind = p.label.startsWith("cli ") ? "cli" : p.label.startsWith("helper ") ? "helper" : "page";
    return this.mint(kind, { label: p.label }).token;
  }

  /** The code shown in the server's own log while nobody can approve a pair:
   *  there is one only while the book holds no page or cli caller. */
  firstCode(): string | null {
    if (this.callers.some((c) => isSession(c.kind))) return null;
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
