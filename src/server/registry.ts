/**
 * The agent registry through canopy (agents spec, phase 3). Two jobs, both
 * against tailchan's broker and both off with no broker address:
 *
 * - The scan: every `SCAN_EVERY` this backend posts the agents running on
 *   its own machine to `/v1/agents/scan` as canopy's bot handle, so an
 *   agent without the hooks is still on the registry. Every backend scans,
 *   since each is the only one that sees its machine's processes.
 * - The follow: the broker's cards, listed at start and on every
 *   (re)connect of a stream pinned to the `agents` channel, where the
 *   broker posts every card change (lost ones too, off its own timer), then
 *   kept by id and broadcast as `registry` events with the cards that
 *   changed. `GET /api/registry` answers them. Any backend with a broker
 *   follows, and the page reads only its home backend's, as it does
 *   tailchan (amendment 8).
 *
 * The cards are the broker's; canopy never writes one but through the scan.
 */
import { SCAN_EVERY, inContainer, scanBody, scanProcs, type AgentProc } from "../core/agentscan";
import { Chan, type ChanConfig } from "../core/chan";
import { AGENTS_CHANNEL, asAgentCard, registryCard } from "../core/tailchan";
import type { AgentCard, ChanMessage, RegistryInfo, Repo, ServerEvent } from "../core/types";

/** how often the whole list is read again, a net under the stream for
 *  cards the broker sweeps (it posts no event for a week-old deletion) */
export const RELIST_EVERY = 5 * 60_000;
/** the first scan after start, once the tree is up */
const FIRST_SCAN = 3_000;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** what a follower cares about in a card: a beat moves only `seenAt` */
const sig = (c: AgentCard): string => JSON.stringify({ ...c, seenAt: 0 });

export interface RegistryDeps {
  broadcast: (ev: ServerEvent) => void;
  /** the repos a scanned agent's folder is matched against */
  repos: () => Repo[];
  /** the client; tests pass one over a stand-in broker */
  chan?: Chan;
  /** the agents on this machine; tests pass a stand-in */
  lister?: () => Promise<AgentProc[]>;
  /** ms between scans, 0 for none */
  scanEvery?: number;
  /** ms between whole re-reads of the list, 0 for none */
  relistEvery?: number;
  /** the pid namespace the scan names; read off the machine when absent */
  container?: boolean;
}

export class RegistryHub {
  readonly chan: Chan | null;
  private cards = new Map<string, AgentCard>();
  /** Which event last told of each card, numbered in the order they came.
   *  A list asked for before then is older news about that card even when
   *  its beat is the same: the broker marks a card lost without a new
   *  beat. */
  private heard = new Map<string, number>();
  private events = 0;
  /** whether a list has answered since start */
  private listed = false;
  private listing: Promise<void> | null = null;
  private scanning: Promise<void> | null = null;
  /** the last scan failed, so the next failure says nothing */
  private scanFailing = false;
  private listFailing = false;
  private stopFollow: (() => void) | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private firstScan: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly cfg: ChanConfig | null,
    private readonly deps: RegistryDeps,
  ) {
    this.chan = cfg ? (deps.chan ?? new Chan(cfg.url)) : null;
  }

  /** opens the follow and starts the scan timer; nothing without a broker */
  start(): void {
    if (!this.cfg || !this.chan || this.stopFollow) return;
    const { cfg, chan } = this;
    // A (re)connect lists again: the first dial has nothing to resume
    // after, and a later one may have missed a sweep.
    this.stopFollow = chan.follow(
      cfg.bot,
      (m) => this.onMessage(m),
      (up) => {
        if (up) this.relist().catch(() => {});
      },
      [AGENTS_CHANNEL],
    );
    const relist = this.deps.relistEvery ?? RELIST_EVERY;
    if (relist > 0) this.timers.push(setInterval(() => this.relist().catch(() => {}), relist));
    const every = this.deps.scanEvery ?? SCAN_EVERY;
    if (every > 0) {
      this.firstScan = setTimeout(() => void this.scan(), Math.min(FIRST_SCAN, every));
      this.timers.push(setInterval(() => void this.scan(), every));
    }
  }

  close(): void {
    this.stopFollow?.();
    this.stopFollow = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.firstScan) clearTimeout(this.firstScan);
    this.firstScan = null;
  }

  /** every card held, newest beat first */
  list(): AgentCard[] {
    return [...this.cards.values()].sort((a, b) => b.seenAt - a.seenAt);
  }

  /** One card into the map, unless an older reading of it (a stream event
   *  that lagged behind a list); says whether a follower would see a
   *  change, since a beat alone moves only `seenAt`. */
  private absorb(card: AgentCard): boolean {
    const prev = this.cards.get(card.id);
    if (prev && prev.seenAt > card.seenAt) return false;
    this.cards.set(card.id, card);
    return !prev || sig(prev) !== sig(card);
  }

  private onMessage(m: ChanMessage): void {
    const card = registryCard(m);
    if (!card) return;
    this.heard.set(card.id, ++this.events);
    if (this.absorb(card)) this.deps.broadcast({ type: "registry", cards: [card] });
  }

  /** The whole list again, what changed broadcast, and a card the broker no
   *  longer has dropped. A card an event told of while the list was on its
   *  way keeps what the event said, whatever the list says of it (a `lost`
   *  and the `idle` before it carry the same beat). Concurrent callers
   *  share one read. */
  relist(): Promise<void> {
    if (!this.cfg || !this.chan) return Promise.resolve();
    if (this.listing) return this.listing;
    const { cfg, chan } = this;
    const asked = Date.now();
    const mark = this.events;
    const pass = chan
      .listAgents(cfg.bot, { state: "all" })
      .then((raw) => {
        const got = (Array.isArray(raw) ? raw : []).map(asAgentCard).filter((c): c is AgentCard => c !== null);
        const since = (id: string): boolean => (this.heard.get(id) ?? 0) > mark;
        const changed = got.filter((c) => !since(c.id) && this.absorb(c));
        const ids = new Set(got.map((c) => c.id));
        const gone: string[] = [];
        for (const [id, c] of this.cards) {
          if (!ids.has(id) && c.seenAt < asked && !since(id)) {
            this.cards.delete(id);
            this.heard.delete(id);
            gone.push(id);
          }
        }
        this.listed = true;
        this.listFailing = false;
        if (changed.length || gone.length) this.deps.broadcast({ type: "registry", cards: changed, ...(gone.length ? { gone } : {}) });
      })
      .catch((e: unknown) => {
        if (!this.listFailing) console.error(`canopy: registry list: ${e instanceof Error ? e.message : e}`);
        this.listFailing = true;
        throw e;
      })
      .finally(() => {
        this.listing = null;
      });
    this.listing = pass;
    return pass;
  }

  /** One scan of this machine posted to the broker; one at a time, and a
   *  broker that does not answer is said once, not every 30 seconds. */
  scan(): Promise<void> {
    if (!this.cfg || !this.chan) return Promise.resolve();
    if (this.scanning) return this.scanning;
    const { cfg, chan } = this;
    const lister = this.deps.lister ?? (() => scanProcs());
    const pass = (async () => {
      const procs = await lister();
      const body = scanBody(procs, this.deps.repos(), this.deps.container ?? inContainer(), process.platform);
      await chan.scanAgents(cfg.bot, body);
      this.scanFailing = false;
    })()
      .catch((e: unknown) => {
        if (!this.scanFailing) console.error(`canopy: agent scan: ${e instanceof Error ? e.message : e}`);
        this.scanFailing = true;
      })
      .finally(() => {
        this.scanning = null;
      });
    this.scanning = pass;
    return pass;
  }

  /** `GET /api/registry`, or null for any other path */
  async handle(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== "/api/registry") return null;
    if (req.method !== "GET") return json({ error: `no route: ${req.method} ${url.pathname}` }, 404);
    if (!this.cfg || !this.chan) return json({ error: "tailchan is not set up on this backend: set CANOPY_TAILCHAN_URL or TAILCHAN_URL" }, 503);
    if (!this.listed) {
      try {
        await this.relist();
      } catch (e) {
        // the broker's own refusal or silence, either way not this route's
        return json({ error: e instanceof Error ? e.message : String(e) }, 502);
      }
    }
    return json({ ready: true, cards: this.list() } satisfies RegistryInfo);
  }
}
