/** Library sync, the server half (docs/superpowers/specs/2026-10-24-library-sync-design.md):
 *  the stamping passes, the pulls from the other backends, the merge's
 *  write through the adapter, the status, the health row and the routes.
 *  The rules are core/libsync.ts.
 *
 *  Every pass runs through one queue, so a stamp, a pull and a join never
 *  read and write the state dir at the same time. Only this hub writes
 *  sync.json: directly when no Library file changes, else in the adapter's
 *  locked `__sync-write` with the files.
 *
 *    GET  /api/library/sync         this backend's doc, for the others' pulls
 *    GET  /api/library/sync/status  LibrarySyncStatus
 *    POST /api/library/sync         { action: "pull" | "seed" | "adopt" | "accept", backend? }
 */

import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProbeResult } from "../core/health";
import {
  adoptDoc,
  docOf,
  type Entries,
  flatten,
  LIB_FILE_NAMES,
  LIB_FILES,
  type LibFile,
  type LibFiles,
  type LibraryPeerStatus,
  type LibrarySyncMode,
  type LibrarySyncStatus,
  merge,
  parseSyncDoc,
  parseSyncState,
  type SyncDoc,
  type SyncState,
  seedState,
  stampPass,
  unflatten,
} from "../core/libsync";
import type { BackendEntry } from "../core/types";

/** how often the other backends are pulled */
export const PULL_EVERY = 60_000;
/** how long a pull may take */
const PULL_TIMEOUT = 10_000;
/** how long after a file changes its stamping pass runs */
const STAMP_DEBOUNCE = 1_000;
const SYNC_FILE = "sync.json";

export interface LibrarySyncSettings {
  mode: LibrarySyncMode;
  self: string | null;
  backends: BackendEntry[];
}

export interface LibrarySyncDeps {
  /** the workspace root the Library files its projects under */
  root: string;
  /** the Library's state folder */
  dir: string;
  /** read on every pass, so a config edit takes without a restart */
  settings(): Promise<LibrarySyncSettings>;
  /** the adapter's locked compare-and-swap write: "changed" when a file
   *  moved since `expect` was read */
  write(expect: Record<string, string | null>, files: Record<string, string>): Promise<"ok" | "changed">;
  /** rebuilds the Library's manifest when its worker is up */
  refresh(): Promise<void>;
  report(r: ProbeResult): void;
  fetch?: typeof fetch;
  now?: () => number;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
/** a Library file the way the engine writes one */
const fileText = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** a refusal the routes answer with its status */
export class LibrarySyncError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** the state dir as one pass read it */
interface Read {
  files: LibFiles;
  /** each file's sha256 as read, null when missing */
  hashes: Record<string, string | null>;
  /** the files that were there and parsed */
  scope: Set<LibFile>;
  mtimes: Partial<Record<LibFile, number>>;
  values: Entries;
}

/** a read with the stamps brought up to date */
interface Stamped extends Read {
  state: SyncState;
  self: string;
}

export class LibrarySync {
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private stampTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly peers = new Map<string, LibraryPeerStatus>();
  /** backends whose next merge may go through a mass deletion */
  private readonly accepting = new Set<string>();
  private error: string | null = null;
  private last: { mode: LibrarySyncMode; self: string | null; joined: SyncState["joined"] | null } = { mode: "off", self: null, joined: null };
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly deps: LibrarySyncDeps) {
    this.now = deps.now ?? Date.now;
    this.fetcher = deps.fetch ?? fetch;
  }

  /** the pull timer and the watcher; never under `bun test` (the caller's rule) */
  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), PULL_EVERY);
    try {
      this.watcher = watch(this.deps.dir, (_event, name) => {
        if (!name || !LIB_FILE_NAMES.includes(String(name))) return;
        if (this.stampTimer) clearTimeout(this.stampTimer);
        this.stampTimer = setTimeout(() => void this.run(() => this.stamped()).catch(() => {}), STAMP_DEBOUNCE);
      });
    } catch {
      // no state dir yet: the Library has never run here, and the timer's passes stamp instead
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.stampTimer) clearTimeout(this.stampTimer);
    this.watcher?.close();
    this.timer = null;
    this.stampTimer = null;
    this.watcher = null;
  }

  /** runs `job` after every job queued before it */
  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }

  /** one timer pass: pull from every other backend when the mode says so */
  async tick(): Promise<void> {
    try {
      const s = await this.deps.settings();
      this.last.mode = s.mode;
      this.last.self = s.self;
      if (s.mode !== "off") await this.pullAll();
      else await this.run(async () => {
        this.last.joined = (await this.loadState())?.joined ?? null;
      });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.reportHealth();
  }

  private async readState(): Promise<Read> {
    const files: LibFiles = {};
    const hashes: Record<string, string | null> = {};
    const scope = new Set<LibFile>();
    const mtimes: Partial<Record<LibFile, number>> = {};
    for (const [file, name] of Object.entries(LIB_FILES) as [LibFile, string][]) {
      const path = join(this.deps.dir, name);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (err) {
        if (isRecord(err) && err["code"] === "ENOENT") {
          hashes[name] = null;
          continue;
        }
        throw err;
      }
      hashes[name] = sha256(text);
      try {
        files[file] = JSON.parse(text);
      } catch {
        throw new LibrarySyncError(409, `${name} does not parse, so no pass runs until it does`);
      }
      scope.add(file);
      mtimes[file] = (await stat(path)).mtimeMs;
    }
    return { files, hashes, scope, mtimes, values: flatten(files) };
  }

  private async loadState(): Promise<SyncState | null> {
    try {
      return parseSyncState(JSON.parse(await readFile(join(this.deps.dir, SYNC_FILE), "utf8")));
    } catch {
      return null;
    }
  }

  private async saveState(state: SyncState): Promise<void> {
    const path = join(this.deps.dir, SYNC_FILE);
    const tmp = join(this.deps.dir, `.${SYNC_FILE}.tmp`);
    await writeFile(tmp, fileText(state));
    await rename(tmp, path);
  }

  /** Reads the state dir and stamps what changed since the last pass;
   *  null when this backend has no name or has not joined. Queued callers only. */
  private async stamped(): Promise<Stamped | null> {
    const s = await this.deps.settings();
    this.last.mode = s.mode;
    this.last.self = s.self;
    const prev = await this.loadState();
    this.last.joined = prev?.joined ?? null;
    if (!s.self || !prev) return null;
    const read = await this.readState();
    this.error = null;
    const { state, changed } = stampPass(prev, read.values, read.scope, this.now(), s.self);
    if (changed.length) await this.saveState(state);
    return { ...read, state, self: s.self };
  }

  /** this backend's doc for another backend's pull */
  doc(): Promise<SyncDoc> {
    return this.run(async () => {
      const st = await this.stamped();
      if (!st) return { backend: this.last.self ?? "", ready: false };
      return docOf(st.self, st.state, st.values);
    });
  }

  /** the other backends a pull reads, by the tailnet URL each lists */
  private others(s: LibrarySyncSettings): BackendEntry[] {
    return s.backends.filter((b) => b.name !== s.self);
  }

  private peer(b: BackendEntry): LibraryPeerStatus {
    let p = this.peers.get(b.name);
    if (!p) {
      p = { name: b.name, url: b.tailnet ?? null, at: null, ok: null, away: null, held: null, taken: 0, deleted: 0, kept: [], dry: false };
      this.peers.set(b.name, p);
    }
    p.url = b.tailnet ?? null;
    return p;
  }

  private async fetchDoc(b: BackendEntry): Promise<SyncDoc> {
    if (!b.tailnet) throw new Error("no tailnet URL in its backends entry");
    let res: Response;
    try {
      res = await this.fetcher(`${b.tailnet}/api/library/sync`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(PULL_TIMEOUT) });
    } catch (err) {
      throw new Error(`not answering (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const doc = parseSyncDoc(await res.json().catch(() => null));
    if (!doc) throw new Error("answered with something that is not a Library sync doc");
    if (doc.backend !== b.name) throw new Error(`answered as "${doc.backend}"`);
    return doc;
  }

  /** the categories among `names` whose folder here still has a project in it */
  private async busyCategories(names: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const name of names) {
      if (name.includes("/") || name.startsWith(".")) continue;
      try {
        const kids = await readdir(join(this.deps.root, name), { withFileTypes: true });
        if (kids.some((k) => k.isDirectory() && !k.name.startsWith("."))) out.add(name);
      } catch {
        // no folder: nothing to keep it for
      }
    }
    return out;
  }

  /** Pulls from every other backend, one after another. */
  async pullAll(): Promise<void> {
    const s = await this.deps.settings();
    for (const b of this.others(s)) await this.pull(b, s.mode === "dry");
  }

  private pull(b: BackendEntry, dry: boolean): Promise<void> {
    return this.run(async () => {
      const p = this.peer(b);
      p.at = this.now();
      let st: Stamped | null;
      try {
        st = await this.stamped();
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        return;
      }
      if (!st) return;
      let doc: SyncDoc;
      try {
        doc = await this.fetchDoc(b);
      } catch (err) {
        p.away = err instanceof Error ? err.message : String(err);
        return;
      }
      p.ok = this.now();
      if (!doc.ready) {
        p.away = "has not joined (canopy library sync --seed or --adopt there)";
        return;
      }
      p.away = null;
      const tombed = Object.keys(doc.tombs).filter((k) => k.startsWith("cat:")).map((k) => k.slice("cat:".length));
      const busy = await this.busyCategories(tombed);
      const accept = this.accepting.delete(b.name);
      const r = merge({ state: st.state, values: st.values }, doc, { keepCategory: (n) => busy.has(n), accept });
      p.kept = r.keptCategories;
      p.dry = dry;
      p.taken = r.taken.length;
      p.deleted = r.deleted.length;
      if (r.held) {
        p.held = `${r.held}; canopy library sync --accept ${b.name} lets it through`;
        return;
      }
      p.held = null;
      if (dry) return;
      await this.apply(st, r.state, r.values);
    });
  }

  /** Writes a merge's outcome: the changed files and sync.json through the
   *  adapter, or sync.json alone when no file changed. Queued callers only. */
  private async apply(st: Stamped, state: SyncState, values: Entries): Promise<void> {
    const next = unflatten(values, st.files);
    const names = Object.keys(next) as LibFile[];
    if (!names.length) {
      if (JSON.stringify(state) !== JSON.stringify(st.state)) await this.saveState(state);
      return;
    }
    const expect: Record<string, string | null> = {};
    const files: Record<string, string> = {};
    for (const file of names) {
      const name = LIB_FILES[file];
      expect[name] = st.hashes[name] ?? null;
      files[name] = fileText(next[file]);
    }
    files[SYNC_FILE] = fileText(state);
    if ((await this.deps.write(expect, files)) === "changed") {
      // the stamping pass the change set off takes it; the next pull merges again
      this.error = null;
      return;
    }
    await this.deps.refresh().catch(() => {});
  }

  /** `--seed`: this copy is where the others start */
  seed(): Promise<void> {
    return this.run(async () => {
      const s = await this.deps.settings();
      if (!s.self) throw new LibrarySyncError(409, "set self in the config first: a seed is stamped with this backend's name");
      const prev = await this.loadState();
      if (prev) throw new LibrarySyncError(409, `already joined (${prev.joined.how}${prev.joined.from ? ` from ${prev.joined.from}` : ""}); remove sync.json to join again`);
      const read = await this.readState();
      const state = seedState(read.values, read.mtimes, s.self, this.now());
      await mkdir(this.deps.dir, { recursive: true });
      await this.saveState(state);
      this.last.joined = state.joined;
    });
  }

  /** `--adopt <backend>`: back up this copy, then take that backend's whole */
  adopt(name: string): Promise<void> {
    return this.run(async () => {
      const s = await this.deps.settings();
      if (!s.self) throw new LibrarySyncError(409, "set self in the config first");
      const b = this.others(s).find((x) => x.name === name);
      if (!b) throw new LibrarySyncError(404, `no other backend named ${name} in the config's backends`);
      let doc: SyncDoc;
      try {
        doc = await this.fetchDoc(b);
      } catch (err) {
        throw new LibrarySyncError(502, `${name} ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!doc.ready) throw new LibrarySyncError(409, `${name} has not joined: seed it first`);
      const read = await this.readState();
      const { values, state } = adoptDoc(doc, this.now());
      const next = unflatten(values, read.files);
      const expect: Record<string, string | null> = {};
      const files: Record<string, string> = {};
      for (const file of Object.keys(next) as LibFile[]) {
        const fname = LIB_FILES[file];
        expect[fname] = read.hashes[fname] ?? null;
        files[fname] = fileText(next[file]);
      }
      files[SYNC_FILE] = fileText(state);
      if ((await this.deps.write(expect, files)) === "changed") throw new LibrarySyncError(409, "a Library file changed during the adopt; run it again");
      this.last.joined = state.joined;
      await this.deps.refresh().catch(() => {});
    });
  }

  /** `--accept <backend>`: its next merge may delete en masse, and it runs now */
  async accept(name: string): Promise<void> {
    const s = await this.deps.settings();
    const b = this.others(s).find((x) => x.name === name);
    if (!b) throw new LibrarySyncError(404, `no other backend named ${name} in the config's backends`);
    this.accepting.add(name);
    await this.pull(b, s.mode === "dry");
  }

  async status(): Promise<LibrarySyncStatus> {
    const s = await this.deps.settings();
    const joined = (await this.loadState())?.joined ?? null;
    this.last = { mode: s.mode, self: s.self, joined };
    const peers = this.others(s).map((b) => ({ ...this.peer(b) }));
    return { mode: s.mode, self: s.self, joined, peers, error: this.error };
  }

  private reportHealth(): void {
    const { mode, self, joined } = this.last;
    if (mode === "off") return this.deps.report({ state: "off", why: "librarySync is off" });
    if (!self) return this.deps.report({ state: "off", why: "no self in the config" });
    if (!joined) return this.deps.report({ state: "off", why: "not joined: canopy library sync --seed, or --adopt <backend>" });
    if (this.error) return this.deps.report({ state: "down", why: this.error });
    const peers = [...this.peers.values()];
    const held = peers.find((p) => p.held);
    if (held) return this.deps.report({ state: "down", why: held.held ?? "" });
    const words = peers.map((p) => (p.away ? `${p.name} ${p.away}` : `${p.name} pulled${p.dry ? " (dry)" : ""}`));
    this.deps.report(words.length ? { state: "ok", detail: words.join(", ") } : { state: "ok" });
  }

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/library/sync" && path !== "/api/library/sync/status") return null;
    try {
      if (path === "/api/library/sync" && req.method === "GET") return json(await this.doc());
      if (path === "/api/library/sync/status" && req.method === "GET") return json(await this.status());
      if (path === "/api/library/sync" && req.method === "POST") {
        const b: unknown = await req.json().catch(() => null);
        const action = isRecord(b) ? b["action"] : undefined;
        const backend = isRecord(b) && typeof b["backend"] === "string" ? b["backend"] : "";
        if (action === "pull") await this.pullAll();
        else if (action === "seed") await this.seed();
        else if (action === "adopt" && backend) await this.adopt(backend);
        else if (action === "accept" && backend) await this.accept(backend);
        else return json({ error: 'action is "pull", "seed", or "adopt" or "accept" with a backend' }, 400);
        this.reportHealth();
        return json(await this.status());
      }
      return json({ error: "Method not allowed" }, 405);
    } catch (err) {
      const status = err instanceof LibrarySyncError ? err.status : 500;
      return json({ error: err instanceof Error ? err.message : String(err) }, status);
    }
  }
}
