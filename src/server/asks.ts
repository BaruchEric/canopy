/**
 * Asks for a human through canopy (agents spec, phase 4): a permission, a
 * question or a guard an agent's hook posted to tailchan's broker, which
 * waits for someone to answer before it falls back to the terminal.
 *
 * - The follow: the open asks listed at start and on every (re)connect of a
 *   stream pinned to the `asks` channel, where the broker posts every ask
 *   change, then kept by id and broadcast as `asks` events. A closed ask
 *   (answered, expired, withdrawn, or routed to the terminal at once) stays
 *   `CLOSED_KEEP` so the page can say how it ended, then leaves as `gone`.
 * - Answers, presence and guards go to the broker with the answering
 *   browser's own answer key: one device's named secret out of the broker's
 *   `ANSWER_TOKENS`, which the page keeps (Settings, "answer key") and sends
 *   as `X-Canopy-Answer-Key` on each of the four writes. canopy forwards it
 *   as the broker's Bearer token and never keeps or logs it. A write without
 *   one is refused (403), and so is one a browser says came from another
 *   site (`Sec-Fetch-Site`). The server holds no secret on purpose: its
 *   loopback API answers every shell on the machine (`CANOPY_API`), and on
 *   the mini any agent running as the same user can read canopy's
 *   environment through the shared pid namespace, so a key held here would
 *   let an agent approve its own ask.
 * - Presence: the page's own beat, on a pointer or key anywhere in it
 *   (xterm's keystrokes included), makes the human `here`.
 *
 * Every backend with a broker follows; the page reads only its home
 * backend's, as it does the registry (amendment 8).
 */
import { Chan, ChanError, type ChanConfig } from "../core/chan";
import { normalizeGuards } from "../core/guards";
import { ASKS_CHANNEL, askOf } from "../core/tailchan";
import type { Ask, AskAnswer, AsksInfo, ChanMessage, GuardsInfo, Presence, ServerEvent } from "../core/types";

/** how long a closed ask stays in the list, for the page to say how it went */
export const CLOSED_KEEP = 10 * 60_000;
/** how often the open list is read again, a net under the stream */
const RELIST_EVERY = 5 * 60_000;
/** how often closed asks past `CLOSED_KEEP` are dropped */
const SWEEP_EVERY = 30_000;
/** at most this many open asks that went missing from a list are read one
 *  by one to learn how they ended; the rest just leave */
const LOOKUP_MAX = 20;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const NO_BROKER = "tailchan is not set up on this backend: set CANOPY_TAILCHAN_URL or TAILCHAN_URL";

/** the header a browser's answer key rides in, to this backend alone */
export const ANSWER_KEY_HEADER = "x-canopy-answer-key";

/** The answer key a write carries, or why it is refused. A browser always
 *  says where a fetch came from (`Sec-Fetch-Site`), so anything but the
 *  page's own origin is refused; a request with no such header (curl, an
 *  agent) can claim anything, which is why the key, not this, is the gate. */
export function answerKeyOf(req: Request): { key: string } | { error: string } {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return { error: "answers, presence and guards are written from canopy's own page only" };
  const key = (req.headers.get(ANSWER_KEY_HEADER) ?? "").trim();
  if (!key) return { error: "no answer key: add this device's in canopy's Settings (a name:secret pair in the broker's ANSWER_TOKENS)" };
  if (!/^\S{1,512}$/.test(key)) return { error: "an answer key is one word, as the broker's ANSWER_TOKENS has it" };
  return { key };
}

/** what a follower cares about in an ask: everything, compared whole */
const sig = (a: Ask): string => JSON.stringify(a);

/** `by` as the broker keeps it: letters, digits, `.`, `_` and `-`, at most 40 */
export function answerer(name: string | null | undefined): string {
  const slug = (name ?? "").trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
  return slug || "canopy";
}

/** An answer as the page posts it, checked field by field; null for one the
 *  broker would refuse anyway. */
export function parseAskAnswer(b: unknown): (AskAnswer & { id: string; client: string | null }) | null {
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  if (typeof o.id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(o.id)) return null;
  if (o.behavior !== "allow" && o.behavior !== "deny") return null;
  const message = typeof o.message === "string" && o.message.trim() ? o.message.trim().slice(0, 2000) : null;
  let answers: Record<string, string> | null = null;
  if (o.answers !== undefined) {
    if (!o.answers || typeof o.answers !== "object" || Array.isArray(o.answers)) return null;
    answers = Object.fromEntries(Object.entries(o.answers as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
  }
  return {
    id: o.id,
    behavior: o.behavior,
    ...(message ? { message } : {}),
    ...(answers && Object.keys(answers).length ? { answers } : {}),
    ...(o.always === true ? { always: true } : {}),
    client: typeof o.client === "string" ? o.client : null,
  };
}

export interface AskHubDeps {
  broadcast: (ev: ServerEvent) => void;
  /** a browser's device name by its client id, for who answered */
  deviceName: (client: string | null) => string | null;
  /** the client; tests pass one over a stand-in broker */
  chan?: Chan;
  /** ms a closed ask is kept */
  closedKeep?: number;
  /** ms between whole re-reads of the open list, 0 for none */
  relistEvery?: number;
  /** ms between sweeps of closed asks, 0 for none */
  sweepEvery?: number;
}

export class AskHub {
  readonly chan: Chan | null;
  private asks = new Map<string, Ask>();
  /** when each held ask closed, or was first seen closed */
  private closedAt = new Map<string, number>();
  private presence: Presence | null = null;
  private listed = false;
  private listing: Promise<void> | null = null;
  private listFailing = false;
  private stopFollow: (() => void) | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    readonly cfg: ChanConfig | null,
    private readonly deps: AskHubDeps,
  ) {
    this.chan = cfg ? (deps.chan ?? new Chan(cfg.url)) : null;
  }

  start(): void {
    if (!this.cfg || !this.chan || this.stopFollow) return;
    const { cfg, chan } = this;
    this.stopFollow = chan.follow(
      cfg.bot,
      (m) => this.onMessage(m),
      (up) => {
        if (up) this.relist().catch(() => {});
      },
      [ASKS_CHANNEL],
    );
    const relist = this.deps.relistEvery ?? RELIST_EVERY;
    if (relist > 0) this.timers.push(setInterval(() => this.relist().catch(() => {}), relist));
    const sweep = this.deps.sweepEvery ?? SWEEP_EVERY;
    if (sweep > 0) this.timers.push(setInterval(() => this.sweep(), sweep));
  }

  close(): void {
    this.stopFollow?.();
    this.stopFollow = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** every ask held, oldest first */
  list(): Ask[] {
    return [...this.asks.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  /** One ask into the map; says whether a follower would see a change. An
   *  ask only ever leaves `open`, so an open reading of one held closed is a
   *  stream event that lagged behind a read, and is passed over. */
  private absorb(a: Ask, now = Date.now()): boolean {
    const prev = this.asks.get(a.id);
    if (prev && prev.state !== "open" && a.state === "open") return false;
    if (prev && sig(prev) === sig(a)) return false;
    this.asks.set(a.id, a);
    if (a.state !== "open" && !this.closedAt.has(a.id)) this.closedAt.set(a.id, Math.min(now, a.answeredAt ?? now));
    return true;
  }

  private onMessage(m: ChanMessage): void {
    const a = askOf(m);
    if (a && this.absorb(a)) this.deps.broadcast({ type: "asks", asks: [a] });
  }

  /** The open list again. An ask held open that the list no longer names
   *  closed while no one was listening: it is read on its own to learn how,
   *  and dropped when the broker has forgotten it. Concurrent callers share
   *  one read. */
  relist(): Promise<void> {
    if (!this.cfg || !this.chan) return Promise.resolve();
    if (this.listing) return this.listing;
    const { cfg, chan } = this;
    const pass = (async () => {
      const got = await chan.listAsks(cfg.bot, "open");
      const changed = got.filter((a) => this.absorb(a));
      const open = new Set(got.map((a) => a.id));
      const missing = [...this.asks.values()].filter((a) => a.state === "open" && !open.has(a.id));
      const gone: string[] = [];
      for (const [i, a] of missing.entries()) {
        const read = i < LOOKUP_MAX ? await chan.getAsk(cfg.bot, a.id).catch(() => null) : null;
        // still open by its own reading: an ask that opened as the list was read
        if (read?.state === "open") continue;
        if (read && this.absorb(read)) changed.push(read);
        else if (!read) {
          this.asks.delete(a.id);
          gone.push(a.id);
        }
      }
      this.listed = true;
      this.listFailing = false;
      if (changed.length || gone.length) this.deps.broadcast({ type: "asks", asks: changed, ...(gone.length ? { gone } : {}) });
    })()
      .catch((e: unknown) => {
        if (!this.listFailing) console.error(`canopy: asks list: ${e instanceof Error ? e.message : e}`);
        this.listFailing = true;
        throw e;
      })
      .finally(() => {
        this.listing = null;
      });
    this.listing = pass;
    return pass;
  }

  /** closed asks kept long enough leave, as one `gone` */
  sweep(now = Date.now()): void {
    const keep = this.deps.closedKeep ?? CLOSED_KEEP;
    const gone: string[] = [];
    for (const [id, at] of this.closedAt) {
      if (now - at < keep) continue;
      this.closedAt.delete(id);
      if (this.asks.delete(id)) gone.push(id);
    }
    if (gone.length) this.deps.broadcast({ type: "asks", asks: [], gone });
  }

  /** the presence the broker answered, broadcast when it moved */
  private tell(p: Presence): Presence {
    const moved = !this.presence || this.presence.state !== p.state || this.presence.pinned !== p.pinned;
    this.presence = p;
    if (moved) this.deps.broadcast({ type: "asks", asks: [], presence: p });
    return p;
  }

  /** the routes under /api/asks, /api/presence and /api/guards, or null */
  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    const method = req.method;
    const ours = path === "/api/asks" || path.startsWith("/api/asks/") || path === "/api/presence" || path === "/api/presence/beat" || path === "/api/guards";
    if (!ours) return null;
    if (!this.cfg || !this.chan) return json({ error: NO_BROKER }, 503);
    const { cfg, chan } = this;
    // the four writes take the browser's answer key, and only for this call
    const write =
      (path === "/api/asks/answer" && method === "POST") ||
      ((path === "/api/presence" || path === "/api/presence/beat") && method === "POST") ||
      (path === "/api/guards" && method === "PUT");
    const auth = write ? answerKeyOf(req) : null;
    if (auth && "error" in auth) return json({ error: auth.error }, 403);
    const key = auth?.key ?? "";
    try {
      if (path === "/api/asks" && method === "GET") {
        if (!this.listed) {
          try {
            await this.relist();
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 502);
          }
        }
        // presence decays at the broker without an event, so it is read fresh
        const presence = await chan.presence(cfg.bot).then(
          (p) => this.tell(p),
          () => this.presence,
        );
        // the broker answers, so an answer can go through; whether this page
        // can send one is whether it holds a key
        return json({ ready: true, canAnswer: true, asks: this.list(), presence } satisfies AsksInfo);
      }
      if (path === "/api/asks/one" && method === "GET") {
        const id = url.searchParams.get("id") ?? "";
        if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return json({ error: "id must be an ask's id" }, 400);
        const held = this.asks.get(id);
        if (held) return json(held);
        return json(await chan.getAsk(cfg.bot, id));
      }
      if (path === "/api/asks/answer" && method === "POST") {
        const b = parseAskAnswer(await req.json().catch(() => null));
        if (!b) return json({ error: "an answer is {id, behavior: allow|deny, message?, answers?, always?}" }, 400);
        const { id, client, ...answer } = b;
        const by = answerer(this.deps.deviceName(client));
        const ask = await chan.answerAsk(cfg.bot, key, id, { ...answer, by });
        if (this.absorb(ask)) this.deps.broadcast({ type: "asks", asks: [ask] });
        return json(ask);
      }
      if (path === "/api/presence" && method === "GET") {
        return json(this.tell(await chan.presence(cfg.bot)));
      }
      if (path === "/api/presence" && method === "POST") {
        const b = (await req.json().catch(() => null)) as { away?: unknown } | null;
        if (typeof b?.away !== "boolean") return json({ error: "away must be true or false" }, 400);
        // away pins until cleared; clearing it is being here now
        const p = await chan.setPresence(cfg.bot, key, b.away ? "away" : "here", b.away);
        return json(this.tell(p));
      }
      if (path === "/api/presence/beat" && method === "POST") {
        // the page throttles its own beats; a key's test is one, and must
        // reach the broker to say whether the key is good
        return json({ presence: this.tell(await chan.beatPresence(cfg.bot, key)) });
      }
      if (path === "/api/guards" && method === "GET") {
        return json({ rules: await chan.guards(cfg.bot), canEdit: true } satisfies GuardsInfo);
      }
      if (path === "/api/guards" && method === "PUT") {
        const b = (await req.json().catch(() => null)) as { rules?: unknown } | null;
        if (!Array.isArray(b?.rules) || !b.rules.every((r) => typeof r === "string")) return json({ error: "rules must be a list of strings" }, 400);
        const n = normalizeGuards(b.rules as string[]);
        if ("error" in n) return json({ error: n.error }, 400);
        return json({ rules: await chan.setGuards(cfg.bot, key, n.rules), canEdit: true } satisfies GuardsInfo);
      }
    } catch (e) {
      // a key the broker refuses is this page's to fix, not a sign-in (the
      // gate's 401), so it goes back as a 403
      if (e instanceof ChanError) return json({ error: e.message }, e.status >= 500 ? 502 : e.status === 401 ? 403 : e.status);
      throw e;
    }
    return json({ error: `no route: ${method} ${path}` }, 404);
  }
}
