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
 *  is refused here as well as on the page.
 *
 *  A file's bytes sit in `<config dir>/clips/<id>` (0600, the folder 0700),
 *  named by the clip's id and never by the file's own name. They are written
 *  first, through a temp file and a rename, and the record after; a clip
 *  that goes takes its bytes with it, and a sweep clears bytes no record
 *  names once they are a minute old (the other server in a redeploy's
 *  overlap may have just written some). They go back out only as a download
 *  behind a sandbox: nosniff, `Content-Security-Policy: sandbox`, and a type
 *  outside the few a browser shows sent as plain bytes, so a kept SVG or
 *  HTML file can never run in canopy's origin. Bun-only (fs). */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clipText,
  fileName,
  isClipId,
  looksSecret,
  looksSecretFile,
  mediaType,
  mintClipId,
  parseClips,
  parseDevice,
  pruneClips,
  putClip,
  servedType,
  sizeWord,
  sourceOf,
  takeClip,
  textHead,
  CLIP_FILE_MAX,
  CLIP_SOURCES,
  type Clip,
  type ClipIn,
  type ClipsInfo,
} from "../core/clips";
import { configDir } from "../core/store";
import type { ServerEvent } from "../core/types";

export const clipsFile = (dir: string = configDir()): string => join(dir, "clips.json");
/** the folder a clip's file sits in, under the clip's id */
export const clipsBlobDir = (dir: string = configDir()): string => join(dir, "clips");

/** how old bytes no record names must be before the sweep clears them */
const ORPHAN_AGE = 60_000;
/** how often the sweep runs at most */
const SWEEP_EVERY = 10 * 60_000;

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
export const SECRET_FILE_REFUSED = "a file that looks like a key or a password is never kept";

/** the Content-Disposition for a download of `name`: an ASCII stand-in for
 *  old clients and the name itself as RFC 5987 says */
export function attachment(name: string): string {
  const flat = name.replace(/[\r\n"\\]/g, "_");
  const ascii = flat.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(flat)}`;
}

export class ClipsHub {
  private clips: readonly Clip[] = [];
  /** the writes, one after another, each on a fresh read of the file */
  private serial: Promise<void> = Promise.resolve();
  private loaded = false;
  private swept = 0;

  constructor(private deps: ClipsDeps) {}

  private get file(): string {
    return clipsFile(this.deps.dir);
  }

  private get blobs(): string {
    return clipsBlobDir(this.deps.dir);
  }

  /** where a clip's bytes sit; only ever a clip id under the folder */
  blobPath(id: string): string {
    if (!isClipId(id)) throw new ClipRefusal(400, "id must be a clip id");
    return join(this.blobs, id);
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
      // a clip that went takes its file's bytes with it
      await Promise.all(out.gone.map((id) => rm(this.blobPath(id), { force: true }).catch(() => undefined)));
      if (out.put.length > 0 || out.gone.length > 0) this.deps.broadcast({ type: "clips", put: out.put.map((c) => c.id), gone: out.gone });
      await this.sweep(out.clips);
    });
    this.serial = next.catch((err) => console.error(`clips: ${errText(err)}`));
    return next;
  }

  /** Clears bytes no record names: a clip's file left by a write that
   *  failed after its bytes went down, or a temp file a crash left. Only
   *  what is a minute old, since another server on this config dir may have
   *  just written bytes whose record this one has not read yet. */
  private async sweep(clips: readonly Clip[], force = false): Promise<void> {
    const now = this.now();
    if (!force && now - this.swept < SWEEP_EVERY) return;
    this.swept = now;
    const named = new Set(clips.filter((c) => c.file).map((c) => c.id));
    const names = await readdir(this.blobs).catch(() => [] as string[]);
    await Promise.all(
      names
        .filter((n) => !named.has(n))
        .map(async (n) => {
          const path = join(this.blobs, n);
          const st = await stat(path).catch(() => null);
          if (st && now - st.mtimeMs > ORPHAN_AGE) await rm(path, { force: true }).catch(() => undefined);
        }),
    );
  }

  /** sweeps now, whatever the time since the last; for the tests */
  sweepNow(): Promise<void> {
    return this.list().then((clips) => this.sweep(clips, true));
  }

  private idOf(v: unknown): string {
    if (!isClipId(v)) throw new ClipRefusal(400, "id must be a clip id");
    return v;
  }

  /** a copy kept: the same text already kept moves to the top */
  async add(body: Record<string, unknown>): Promise<Clip> {
    if (typeof body["text"] !== "string" || !clipText(body["text"]).text) throw new ClipRefusal(400, "text is required");
    const source = sourceOf(body["source"]);
    if (!source) throw new ClipRefusal(400, `source must be one of ${CLIP_SOURCES.join(", ")}`);
    if (looksSecret(body["text"])) throw new ClipRefusal(422, SECRET_REFUSED);
    const incoming: ClipIn = { text: body["text"], source };
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

  /**
   * A file kept: its bytes down first under a temp name, then the record.
   * The same bytes already kept are that clip, moved to the top, and the
   * new copy is dropped; new bytes take the new clip's id. When the record
   * cannot be written the bytes it would have named go too.
   */
  async addFile(bytes: Uint8Array, meta: { name: unknown; type: unknown; source: unknown; from?: unknown; device?: unknown }): Promise<Clip> {
    if (bytes.byteLength === 0) throw new ClipRefusal(400, "the file is empty");
    if (bytes.byteLength > CLIP_FILE_MAX) throw new ClipRefusal(413, `a file on the clipboard is at most ${sizeWord(CLIP_FILE_MAX)}`);
    const source = sourceOf(meta.source);
    if (!source) throw new ClipRefusal(400, `source must be one of ${CLIP_SOURCES.join(", ")}`);
    const name = fileName(meta.name);
    const head = textHead(bytes);
    if (looksSecretFile(name) || (head !== null && looksSecret(head))) throw new ClipRefusal(422, SECRET_FILE_REFUSED);
    const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const file = { name, type: mediaType(meta.type), size: bytes.byteLength, sha };
    const incoming: ClipIn = { text: name, source, file };
    if (typeof meta.from === "string") incoming.from = meta.from;
    const device = parseDevice(meta.device);
    if (device) incoming.device = device;

    // the bytes go down first, under the id a new clip would take, so a page
    // that hears the event finds them; a merge or a failed write takes them back
    await mkdir(this.blobs, { recursive: true, mode: 0o700 });
    const id = (this.deps.mintId ?? mintClipId)();
    const path = this.blobPath(id);
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      await writeFile(tmp, bytes, { mode: 0o600 });
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    let out: Clip | undefined;
    let kept = false;
    try {
      await this.change((clips) => {
        const r = putClip(clips, incoming, this.now(), id);
        out = r.clip;
        return { clips: r.clips, put: [r.clip], gone: r.gone };
      });
      kept = true;
    } finally {
      const into = kept ? out?.id : undefined;
      if (into !== undefined && into !== id) {
        // the same bytes were kept before: they stay, unless they went missing
        const there = this.blobPath(into);
        if (await Bun.file(there).exists()) await rm(path, { force: true }).catch(() => undefined);
        else await rename(path, there).catch(() => rm(path, { force: true }).catch(() => undefined));
      } else if (into === undefined) await rm(path, { force: true }).catch(() => undefined);
    }
    if (!out) throw new ClipRefusal(500, "the file was not kept");
    return out;
  }

  /** a kept file's bytes as a download behind the sandbox; 404 when the clip has none */
  async fileResponse(id: unknown): Promise<Response> {
    const want = this.idOf(id);
    const clip = (await this.list()).find((c) => c.id === want);
    if (!clip?.file) throw new ClipRefusal(404, "no file by that id");
    const blob = Bun.file(this.blobPath(want));
    if (!(await blob.exists())) throw new ClipRefusal(404, "that file's bytes are gone");
    return new Response(blob, {
      headers: {
        "content-type": servedType(clip.file.type),
        "content-length": String(blob.size),
        "content-disposition": attachment(clip.file.name),
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
        "cache-control": "private, max-age=3600",
      },
    });
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
      if (req.method === "GET" && path === "/api/clips/file") return await this.fileResponse(url.searchParams.get("id"));
      if (req.method === "POST" && path === "/api/clips/file") {
        // the bytes are the body; what they are rides in the query
        if (Number(req.headers.get("content-length") ?? 0) > CLIP_FILE_MAX) throw new ClipRefusal(413, `a file on the clipboard is at most ${sizeWord(CLIP_FILE_MAX)}`);
        const q = url.searchParams;
        let device: unknown;
        try {
          device = JSON.parse(q.get("device") ?? "null");
        } catch {
          device = null;
        }
        const bytes = new Uint8Array(await req.arrayBuffer());
        return json(await this.addFile(bytes, { name: q.get("name"), type: req.headers.get("content-type"), source: q.get("source"), from: q.get("from") ?? undefined, device }), 201);
      }
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
