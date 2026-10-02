/**
 * canopy's side of tailchan: the routes under /api/tailchan, one stream to
 * the broker as the UI's handle whose messages go out as `chan` events, and
 * the posts canopy makes about its own runs, flows and fleets while config
 * `tailchanNotify` is on. The broker's address comes from chanConfig; with
 * none, every route answers 503 and nothing else runs.
 */
import { Chan, ChanError, type ChanConfig } from "../core/chan";
import { loadConfig, setTailchanNotify } from "../core/store";
import { chanTarget, fleetNotice, flowNotice, runNotice, sproutNotice, type Notice } from "../core/tailchan";
import type { ChanMessage, Fleet, Flow, Run, ServerEvent, Sprout, SproutStatus, TailchanInfo } from "../core/types";

/** a posted file's cap, the broker's own default */
const PUT_MAX = 100 * 1024 * 1024;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export interface ChanHubDeps {
  broadcast: (ev: ServerEvent) => void;
  /** a repo's name by id, for what canopy posts */
  repoName: (id: string) => string;
  /** whether a run is one of a flow's steps, which the flow speaks for */
  isFlowRun: (runId: string) => boolean;
  /** whether a flow is one of the incubator's stages, which the sprout speaks for */
  isSproutFlow?: (flowId: string) => boolean;
  /** the client; tests pass one over a stand-in broker */
  chan?: Chan;
}

export class ChanHub {
  readonly chan: Chan | null;
  private stop: (() => void) | null = null;
  private notify = false;
  /** the last status each run, flow and fleet was seen in, so a notice goes
   *  out once per transition however often the thing is broadcast */
  private runs = new Map<string, Run["status"]>();
  private flows = new Map<string, Flow["status"]>();
  private fleets = new Map<string, Fleet["status"]>();
  private sprouts = new Map<string, { status: SproutStatus; asking: boolean }>();

  constructor(
    readonly cfg: ChanConfig | null,
    private readonly deps: ChanHubDeps,
  ) {
    this.chan = cfg ? (deps.chan ?? new Chan(cfg.url)) : null;
  }

  /** opens the stream, subscribes the UI's handle to canopy's channel, and
   *  reads the notify switch */
  async start(): Promise<void> {
    if (!this.cfg || !this.chan) return;
    const { cfg, chan } = this;
    // an unreadable config only costs the notify switch, never the stream
    this.notify = await loadConfig().then(
      (c) => c.tailchanNotify,
      (err) => {
        console.error("canopy: tailchan notify:", err instanceof Error ? err.message : err);
        return false;
      },
    );
    if (this.notify) this.subscribe();
    this.stop = chan.follow(cfg.as, (message) => this.deps.broadcast({ type: "chan", message }));
  }

  /** the UI's handle joins canopy's channel, so its lines reach the popover
   *  (and the handle's inbox elsewhere); only once notify is on, and best
   *  effort: the broker may be down, and it takes once for good */
  private subscribe(): void {
    if (this.cfg && this.chan) this.chan.sub(this.cfg.as, this.cfg.channel).catch(() => {});
  }

  close(): void {
    this.stop?.();
    this.stop = null;
  }

  onRun(run: Run): void {
    const prev = this.runs.get(run.id);
    this.runs.set(run.id, run.status);
    if (this.deps.isFlowRun(run.id)) return;
    this.say(runNotice(run, prev, this.deps.repoName(run.repoId)));
  }

  onFlow(flow: Flow): void {
    const prev = this.flows.get(flow.id);
    this.flows.set(flow.id, flow.status);
    if (this.deps.isSproutFlow?.(flow.id)) return;
    this.say(flowNotice(flow, prev, this.deps.repoName(flow.repoId)));
  }

  onFleet(fleet: Fleet): void {
    const prev = this.fleets.get(fleet.id);
    this.fleets.set(fleet.id, fleet.status);
    this.say(fleetNotice(fleet, prev));
  }

  onSprout(s: Sprout): void {
    const prev = this.sprouts.get(s.id);
    this.sprouts.set(s.id, { status: s.status, asking: (s.questions?.length ?? 0) > 0 });
    this.say(sproutNotice(s, prev));
  }

  /** keep running gave up on a task: a DM, since someone has to look */
  onTaskGaveUp(repo: string, task: string): void {
    this.say({ to: "human", text: `${repo}: task ${task} keeps failing; canopy stopped restarting it` });
  }

  /** a dismissed run, flow or fleet leaves the maps */
  forget(id: string): void {
    this.runs.delete(id);
    this.flows.delete(id);
    this.fleets.delete(id);
    this.sprouts.delete(id);
  }

  private say(n: Notice | null): void {
    if (!n || !this.notify || !this.cfg || !this.chan) return;
    const { cfg, chan } = this;
    const target = n.to === "human" ? { to: cfg.as } : { channel: cfg.channel };
    // a channel line is marked silent so a mention in a repo's name never pings
    // The UI's stream hears it from the broker, being in the channel and the
    // DM; only a bot that is the UI's own handle is never handed it back.
    chan
      .send(cfg.bot, target, "text", n.text, n.to === "human" ? {} : { silent: true })
      .then((message) => {
        if (cfg.bot === cfg.as) this.echo(message);
      })
      .catch((e) => console.error(`tailchan post failed: ${e instanceof Error ? e.message : e}`));
  }

  /** the /api/tailchan routes, or null for a path that is not one */
  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/tailchan" && !path.startsWith("/api/tailchan/")) return null;
    const method = req.method;
    if (!this.cfg || !this.chan) {
      if (path === "/api/tailchan" && method === "GET") {
        return json({ ready: false, reason: "no tailchan address: set CANOPY_TAILCHAN_URL or TAILCHAN_URL" } satisfies TailchanInfo);
      }
      return json({ error: "tailchan is not set up on this backend" }, 503);
    }
    const { cfg, chan } = this;
    try {
      if (path === "/api/tailchan" && method === "GET") {
        const [who, channels] = await Promise.all([chan.who(cfg.as), chan.channels(cfg.as)]);
        const info: TailchanInfo = { ready: true, as: cfg.as, bot: cfg.bot, channel: cfg.channel, notify: this.notify, who, channels };
        return json(info);
      }
      if (path === "/api/tailchan/read" && method === "GET") {
        const target = url.searchParams.get("target") ?? "";
        const n = Number(url.searchParams.get("n") ?? 50);
        return json(await chan.read(cfg.as, target, Number.isFinite(n) ? n : 50));
      }
      if (path === "/api/tailchan/send" && method === "POST") {
        const b = (await req.json()) as { target?: unknown; body?: unknown; kind?: unknown };
        const target = typeof b.target === "string" ? chanTarget(b.target) : null;
        if (!target) return json({ error: "target must be #channel or @handle" }, 400);
        if (typeof b.body !== "string" || !b.body.trim()) return json({ error: "nothing to send" }, 400);
        const kind = b.kind === "clip" ? "clip" : "text";
        const message = await chan.send(cfg.as, target, kind, b.body);
        this.echo(message);
        return json(message, 201);
      }
      if (path === "/api/tailchan/put" && method === "POST") {
        const target = chanTarget(url.searchParams.get("target") ?? "");
        if (!target) return json({ error: "target must be #channel or @handle" }, 400);
        const name = (url.searchParams.get("name") ?? "file").replace(/[/\\]/g, "_").slice(0, 200) || "file";
        const data = new Uint8Array(await req.arrayBuffer());
        if (data.byteLength === 0) return json({ error: "empty file" }, 400);
        if (data.byteLength > PUT_MAX) return json({ error: "over 100 MB" }, 413);
        const type = req.headers.get("content-type") || "application/octet-stream";
        const blob = await chan.putBlob(cfg.as, data, type, name);
        const note = url.searchParams.get("note") ?? "";
        const message = await chan.send(cfg.as, target, "object", note, { blob: blob.id, name: blob.name, mime: blob.mime, size: blob.size });
        this.echo(message);
        return json(message, 201);
      }
      if (path === "/api/tailchan/blob" && method === "GET") {
        const id = url.searchParams.get("id") ?? "";
        if (!/^[0-9a-f]{32}$/.test(id)) return json({ error: "id must be a blob id" }, 400);
        const res = await chan.getBlob(cfg.as, id);
        const headers = new Headers();
        for (const h of ["content-type", "content-length", "content-disposition"]) {
          const v = res.headers.get(h);
          if (v) headers.set(h, v);
        }
        return new Response(res.body, { headers });
      }
      if (path === "/api/tailchan/notify" && method === "POST") {
        const b = (await req.json()) as { on?: unknown };
        if (typeof b.on !== "boolean") return json({ error: "on must be true or false" }, 400);
        await setTailchanNotify(b.on);
        this.notify = b.on;
        if (b.on) this.subscribe();
        return json({ notify: b.on });
      }
    } catch (e) {
      if (e instanceof ChanError) return json({ error: e.message }, e.status >= 500 ? 502 : e.status);
      throw e;
    }
    return json({ error: `no route: ${method} ${path}` }, 404);
  }

  /** the broker never hands a sender its own post, so the server tells
   *  every browser, this one included, about what the UI just sent */
  private echo(message: ChanMessage): void {
    this.deps.broadcast({ type: "chan", message });
  }
}
