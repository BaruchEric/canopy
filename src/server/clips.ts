/** The clipboard, the server half (FR-054): the file, the routes under
 *  /api/clips and the `clips` event. The rules are `core/clips.ts`.
 *
 *  The file is `<config dir>/clips.json`, one array, newest first, read again
 *  before every write and written whole through a temp file and a rename, as
 *  the notes' is, so two servers on one config dir during a redeploy's
 *  overlap keep each other's clips. A change broadcasts the ids of what
 *  changed (`put` and `gone`) and never the text: every event stream hears
 *  it, while reading a clip takes the operate right, so a page fetches the
 *  put ones with `GET /api/clips?ids=`. Text shaped like a key or a password
 *  is refused here as well as on the page. Bun-only (fs). */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clipText, isClipId, isClipSource, looksSecret, mintClipId, parseClips, parseDevice, pruneClips, putClip, takeClip, CLIP_SOURCES, type Clip, type ClipIn, type ClipsInfo } from "../core/clips";
import { configDir } from "../core/store";
import type { ServerEvent } from "../core/types";

export const clipsFile = (dir: string = configDir()): string => join(dir, "clips.json");

export interface ClipsDeps {
  broadcast: (ev: ServerEvent) => void;
  dir?: string;
  now?: () => number;
  mintId?: () => string;
}

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** a refusal the routes answer with its status */
class ClipRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** what a refused secret is told */
export const SECRET_REFUSED = "text that looks like a key or a password is never kept";

export class ClipsHub {
  private clips: readonly Clip[] = [];
  /** the writes, one after another, each on a fresh read of the file */
  private serial: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private deps: ClipsDeps) {}

  private get file(): string {
    return clipsFile(this.deps.dir);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async read(): Promise<readonly Clip[]> {
    try {
      const v: unknown = JSON.parse(await readFile(this.file, "utf8"));
      return parseClips(v);
    } catch {
      // no file yet, or one that is not JSON: no clips
      return [];
    }
  }

  private async write(clips: readonly Clip[]): Promise<void> {
    const dir = this.deps.dir ?? configDir();
    await mkdir(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      // 0600: a clipboard holds whatever was copied
      await writeFile(tmp, `${JSON.stringify(clips, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** the clips as last read, past their age left out; the file is read
   *  once, then kept in step by the writes */
  async list(): Promise<readonly Clip[]> {
    if (!this.loaded) {
      await this.serial;
      if (!this.loaded) {
        this.clips = await this.read();
        this.loaded = true;
      }
    }
    return pruneClips(this.clips, this.now()).clips;
  }

  /** One change: the file read again, `fn` applied, the result written and
   *  what changed broadcast. `fn` returns null to change nothing. */
  private change(fn: (clips: readonly Clip[]) => { clips: readonly Clip[]; put: Clip[]; gone: string[] } | null): Promise<void> {
    const next = this.serial.then(async () => {
      const fresh = await this.read();
      const out = fn(fresh);
      this.loaded = true;
      if (out === null) {
        this.clips = fresh;
        return;
      }
      await this.write(out.clips);
      this.clips = out.clips;
      if (out.put.length > 0 || out.gone.length > 0) this.deps.broadcast({ type: "clips", put: out.put.map((c) => c.id), gone: out.gone });
    });
    this.serial = next.catch((err) => console.error(`clips: ${errText(err)}`));
    return next;
  }

  private idOf(v: unknown): string {
    if (!isClipId(v)) throw new ClipRefusal(400, "id must be a clip id");
    return v;
  }

  /** a copy kept: the same text already kept moves to the top */
  async add(body: Record<string, unknown>): Promise<Clip> {
    if (typeof body["text"] !== "string" || !clipText(body["text"]).text) throw new ClipRefusal(400, "text is required");
    if (!isClipSource(body["source"])) throw new ClipRefusal(400, `source must be one of ${CLIP_SOURCES.join(", ")}`);
    if (looksSecret(body["text"])) throw new ClipRefusal(422, SECRET_REFUSED);
    const incoming: ClipIn = { text: body["text"], source: body["source"] };
    if (typeof body["from"] === "string") incoming.from = body["from"];
    const device = parseDevice(body["device"]);
    if (device) incoming.device = device;
    const id = (this.deps.mintId ?? mintClipId)();
    let out: Clip | undefined;
    await this.change((clips) => {
      const r = putClip(clips, incoming, this.now(), id);
      out = r.clip;
      return { clips: r.clips, put: [r.clip], gone: r.gone };
    });
    if (!out) throw new ClipRefusal(500, "the clip was not kept");
    return out;
  }

  /** a clip taken again from the list: to the top, its source as it was */
  async use(id: unknown): Promise<Clip> {
    const want = this.idOf(id);
    let out: Clip | undefined;
    await this.change((clips) => {
      const r = takeClip(clips, want, this.now());
      if (!r) return null;
      out = r.clip;
      return { clips: r.clips, put: [r.clip], gone: [] };
    });
    if (!out) throw new ClipRefusal(404, "no clip by that id");
    return out;
  }

  /** pinned clips are kept past the cap and the age */
  async pin(id: unknown, pinned: unknown): Promise<Clip> {
    const want = this.idOf(id);
    if (typeof pinned !== "boolean") throw new ClipRefusal(400, "pinned must be true or false");
    let out: Clip | undefined;
    await this.change((clips) => {
      const cur = clips.find((c) => c.id === want);
      if (!cur) return null;
      const next: Clip = { ...cur };
      if (pinned) next.pinned = true;
      else delete next.pinned;
      out = next;
      const all = clips.map((c) => (c.id === want ? next : c));
      // an unpinned clip past the cap or the age goes now
      const pruned = pruneClips(all, this.now());
      return { clips: pruned.clips, put: pruned.gone.includes(want) ? [] : [next], gone: pruned.gone };
    });
    if (!out) throw new ClipRefusal(404, "no clip by that id");
    return out;
  }

  async remove(id: unknown): Promise<void> {
    const want = this.idOf(id);
    let found = false;
    await this.change((clips) => {
      found = clips.some((c) => c.id === want);
      return found ? { clips: clips.filter((c) => c.id !== want), put: [], gone: [want] } : null;
    });
    if (!found) throw new ClipRefusal(404, "no clip by that id");
  }

  /** every unpinned clip dropped; the ids that went */
  async clear(): Promise<string[]> {
    let gone: string[] = [];
    await this.change((clips) => {
      gone = clips.filter((c) => !c.pinned).map((c) => c.id);
      return gone.length === 0 ? null : { clips: clips.filter((c) => c.pinned), put: [], gone };
    });
    return gone;
  }

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/clips" && !path.startsWith("/api/clips/")) return null;
    try {
      if (req.method === "GET" && path === "/api/clips") {
        // ?ids=a,b answers those alone: what a page fetches after an event
        const ids = url.searchParams.get("ids");
        const want = ids === null ? null : new Set(ids.split(",").filter(isClipId));
        const all = await this.list();
        const info: ClipsInfo = { clips: want ? all.filter((c) => want.has(c.id)) : [...all] };
        return json(info);
      }
      if (req.method === "POST" && path === "/api/clips") return json(await this.add(await this.body(req)));
      if (req.method === "POST" && path === "/api/clips/use") return json(await this.use((await this.body(req))["id"]));
      if (req.method === "POST" && path === "/api/clips/pin") {
        const body = await this.body(req);
        return json(await this.pin(body["id"], body["pinned"]));
      }
      if (req.method === "POST" && path === "/api/clips/clear") return json({ gone: await this.clear() });
      if (req.method === "DELETE" && path === "/api/clips") {
        await this.remove(url.searchParams.get("id"));
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof ClipRefusal) return json({ error: err.message }, err.status);
      return json({ error: errText(err) }, 500);
    }
  }

  private async body(req: Request): Promise<Record<string, unknown>> {
    try {
      const body: unknown = await req.json();
      return isRecord(body) ? body : {};
    } catch {
      return {};
    }
  }
}
