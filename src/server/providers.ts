/** Providers from kit.json on this backend (FR-069): keeps
 *  `providers/<id>.json` in step with the kit's `providers` block, records
 *  what it wrote in `providers/.canopy-kit.json`, and moves a hand file aside
 *  for the kit's on an adopt. Every builder that passes `--settings` already
 *  reads the folder, so none of them change. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROVIDER_RE } from "../core/harness";
import { EMPTY_PROVIDERS_RECORD, parseProvidersRecord, planProviders, providerHere, resolveProvider, type ProvidersRecord } from "../core/providers";
import type { KitProvider, ProviderView } from "../core/types";

export const RECORD = ".canopy-kit.json";
export const ADOPTED = ".canopy-kit-adopted";

export const hashText = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Whether this process runs in a container: there the config folder is a
 *  volume the shells container mounts too. `KIT_CONTAINER` decides when set,
 *  as it does for the kit's tools. */
export function inContainer(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const set = env["KIT_CONTAINER"];
  if (set !== undefined && set !== "") return set === "1" || set === "true";
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

export class ProviderError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Writes through a temp file beside the target and a rename, at 0600. */
async function writePrivate(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await writeFile(tmp, text, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export interface ProviderSyncDeps {
  dir: string;
  machine: () => string | null;
  container: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

/** One backend's providers folder. Sync, adopt and put back run one at a
 *  time, so an adopt never lands between a sync's read and its write. */
export class ProviderSync {
  private chain: Promise<unknown> = Promise.resolve();
  private providers: KitProvider[] = [];
  private last: ProviderView[] = [];

  constructor(private readonly deps: ProviderSyncDeps) {}

  views(): ProviderView[] {
    return this.last;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async readRecord(): Promise<ProvidersRecord> {
    try {
      return parseProvidersRecord(JSON.parse(await readFile(join(this.deps.dir, RECORD), "utf8")));
    } catch {
      return { ...EMPTY_PROVIDERS_RECORD, written: {}, adopted: [] };
    }
  }

  private async saveRecord(r: ProvidersRecord): Promise<void> {
    await writePrivate(join(this.deps.dir, RECORD), `${JSON.stringify(r, null, 2)}\n`);
  }

  /** each `<id>.json` in the folder with the hash of its text */
  private async readFiles(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    let names: string[];
    try {
      names = await readdir(this.deps.dir);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const id = name.slice(0, -5);
      if (!PROVIDER_RE.test(id)) continue;
      const text = await readFile(join(this.deps.dir, name), "utf8").catch(() => null);
      if (text !== null) out[id] = hashText(text);
    }
    return out;
  }

  /** Bring the folder in step with kit.json's providers, and answer each
   *  one's state here. A write that fails reads as the provider's state with
   *  the error, and the rest go on. */
  sync(providers: readonly KitProvider[]): Promise<ProviderView[]> {
    return this.serial(async () => {
      this.providers = [...providers];
      const record = await this.readRecord();
      const files = await this.readFiles();
      const { actions, views } = planProviders({
        providers, machine: this.deps.machine(), container: this.deps.container, env: this.deps.env, files, record, hash: hashText,
      });
      const failed = new Map<string, string>();
      let changed = false;
      for (const a of actions) {
        try {
          if (a.kind === "write") {
            await mkdir(this.deps.dir, { recursive: true, mode: 0o700 });
            await writePrivate(join(this.deps.dir, `${a.id}.json`), a.text);
            record.written[a.id] = a.hash;
          } else if (a.kind === "remove") {
            await rm(join(this.deps.dir, `${a.id}.json`), { force: true });
            delete record.written[a.id];
          } else {
            delete record.written[a.id];
          }
          changed = true;
        } catch (err) {
          failed.set(a.id, err instanceof Error ? err.message : String(err));
        }
      }
      if (changed) await this.saveRecord(record);
      this.last = views.map((v) => (failed.has(v.id) ? { ...v, state: "unresolved" as const, why: `could not write providers/${v.id}.json: ${failed.get(v.id)}` } : v));
      return this.last;
    });
  }

  /** Move this machine's own file aside and write kit.json's in its place. */
  adopt(id: string): Promise<ProviderView[]> {
    return this.serial(async () => {
      const p = this.providers.find((x) => x.id === id);
      if (!p) throw new ProviderError(`no provider ${id} in kit.json`, 404);
      if (!providerHere(p, this.deps.machine())) throw new ProviderError(`provider ${id} is not for this machine`, 409);
      const view = this.last.find((v) => v.id === id);
      if (view?.state !== "hand" || !p.settings) throw new ProviderError(`provider ${id} has no hand file to adopt here, or kit.json carries no settings for it`, 409);
      if (this.deps.container && view.envNames.length > 0) throw new ProviderError(`provider ${id} reads the env, which this backend refuses`, 409);
      const got = resolveProvider(p, this.deps.env);
      if ("unresolved" in got) throw new ProviderError(`the backend's env does not set ${got.unresolved.join(", ")}`, 409);
      const aside = join(this.deps.dir, ADOPTED);
      const kept = join(aside, `${id}.json`);
      if (existsSync(kept)) throw new ProviderError(`${ADOPTED}/${id}.json is taken; put it back or remove it first`, 409);
      await mkdir(aside, { recursive: true, mode: 0o700 });
      const file = join(this.deps.dir, `${id}.json`);
      await rename(file, kept);
      try {
        await writePrivate(file, got.text);
      } catch (err) {
        await rename(kept, file).catch(() => {});
        throw err;
      }
      const record = await this.readRecord();
      record.written[id] = hashText(got.text);
      if (!record.adopted.includes(id)) record.adopted.push(id);
      await this.saveRecord(record);
      return this.resync();
    });
  }

  /** Put an adopted hand file back, over the kit's. */
  restore(id: string): Promise<ProviderView[]> {
    return this.serial(async () => {
      if (!PROVIDER_RE.test(id)) throw new ProviderError(`not a provider id: ${id}`, 400);
      const record = await this.readRecord();
      const kept = join(this.deps.dir, ADOPTED, `${id}.json`);
      if (!record.adopted.includes(id) || !existsSync(kept)) throw new ProviderError(`no adopted file for ${id}`, 409);
      await rename(kept, join(this.deps.dir, `${id}.json`));
      delete record.written[id];
      record.adopted = record.adopted.filter((x) => x !== id);
      await this.saveRecord(record);
      return this.resync();
    });
  }

  /** the states again after an adopt or a put back, inside the same turn of the line */
  private async resync(): Promise<ProviderView[]> {
    const record = await this.readRecord();
    const files = await this.readFiles();
    this.last = planProviders({ providers: this.providers, machine: this.deps.machine(), container: this.deps.container, env: this.deps.env, files, record, hash: hashText }).views;
    return this.last;
  }
}
