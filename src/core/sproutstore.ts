/**
 * The incubator's files under the config dir: one folder per sprout with
 * its record, its inputs index and its raw inputs. Raw inputs live here and
 * never in the seed, which is peer-synced and whose WIP snapshots take
 * untracked files.
 *
 * The config dir is shared by every launch root canopy serves, so each
 * sprout.json carries the root of the server that wrote it (a property of
 * the file, not of the Sprout) and a server lists only its own.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSproutId, parseSproutRecord } from "./sprout";
import { configDir } from "./store";
import type { RunAnswerRecord, Sprout } from "./types";

const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** one stored record, or null for one that is not */
function runAnswerOf(v: unknown): RunAnswerRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const items = r["items"];
  if (typeof r["where"] !== "string" || typeof r["at"] !== "number" || !Array.isArray(items)) return null;
  const ok = items.every((i: unknown) => {
    if (typeof i !== "object" || i === null) return false;
    const x = i as Record<string, unknown>;
    return typeof x["question"] === "string" && isStrs(x["offered"]) && isStrs(x["picked"]) && typeof x["text"] === "string" && typeof x["answered"] === "boolean";
  });
  return ok ? (v as RunAnswerRecord) : null;
}

export const incubatorDir = (): string => join(configDir(), "incubator");

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** the root a record was written for, or null when it has none */
function rootOf(text: string): string | null {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null) return null;
    const root = (v as Record<string, unknown>)["root"]; // v is a non-null object here
    return typeof root === "string" ? root : null;
  } catch {
    return null;
  }
}

export class SproutFiles {
  /** `root` is the launch root every record is written for and read back by */
  constructor(
    private readonly root: string,
    private readonly dir: string = incubatorDir(),
  ) {}

  private home(id: string): string {
    if (!isSproutId(id)) throw new Error(`not a sprout id: ${id}`);
    return join(this.dir, id);
  }

  inputsDir(id: string): string {
    return join(this.home(id), "inputs");
  }

  private input(id: string, name: string): string {
    if (!NAME.test(name)) throw new Error(`not an input name: ${name}`);
    return join(this.inputsDir(id), name);
  }

  /** This root's sprouts. A record written for another root, or for none, is
   *  left on disk as it is. */
  async list(): Promise<Sprout[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: Sprout[] = [];
    for (const name of names.filter(isSproutId).sort()) {
      const text = await readFile(join(this.dir, name, "sprout.json"), "utf8").catch(() => null);
      const s = text === null ? null : parseSproutRecord(text);
      if (text === null || !s || s.id !== name) {
        console.error(`incubator: skipped ${name}/sprout.json, which is missing or unreadable`);
        continue;
      }
      if (rootOf(text) !== this.root) continue;
      // the root belongs to the file, so it does not travel on the Sprout
      const { root: _root, ...sprout } = s as Sprout & { root?: unknown };
      out.push(sprout);
    }
    return out;
  }

  /** each sprout's saves, one after another */
  private readonly saving = new Map<string, Promise<void>>();

  /** Whole, through a rename, so a crash leaves the old record or the new
   *  one. The record is taken as it is now, and written after the saves
   *  before it, so two saves close together never land out of order. */
  save(s: Sprout): Promise<void> {
    const text = `${JSON.stringify({ ...s, root: this.root }, null, 2)}\n`;
    const id = s.id;
    // one that failed does not hold up the next
    const next = (this.saving.get(id) ?? Promise.resolve()).catch(() => {}).then(() => this.write(id, text));
    this.saving.set(id, next);
    next
      .finally(() => {
        if (this.saving.get(id) === next) this.saving.delete(id);
      })
      .catch(() => {});
    return next;
  }

  private async write(id: string, text: string): Promise<void> {
    const home = this.home(id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const tmp = join(home, `.sprout.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, join(home, "sprout.json"));
  }

  /** once: an input is never overwritten */
  async writeInput(id: string, name: string, data: Uint8Array | string): Promise<void> {
    const file = this.input(id, name);
    await mkdir(this.inputsDir(id), { recursive: true, mode: 0o700 });
    await writeFile(file, data, { mode: 0o600, flag: "wx" });
  }

  async removeInput(id: string, name: string): Promise<void> {
    await rm(this.input(id, name), { force: true });
  }

  async readInput(id: string, name: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.input(id, name)));
  }

  async writeIndex(id: string, text: string): Promise<void> {
    const home = this.home(id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "inputs.md"), text, { mode: 0o600 });
  }

  /** the answers given inside stages' runs, in the sprout's folder beside
   *  its record, never under inputs/, which every stage reads a copy of */
  async readRunAnswers(id: string): Promise<RunAnswerRecord[]> {
    const text = await readFile(join(this.home(id), "run-answers.json"), "utf8").catch(() => null);
    if (text === null) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return [];
    }
    return Array.isArray(raw) ? raw.map(runAnswerOf).filter((r): r is RunAnswerRecord => r !== null) : [];
  }

  /** whole, through a rename */
  async writeRunAnswers(id: string, records: RunAnswerRecord[]): Promise<void> {
    const home = this.home(id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const tmp = join(home, `.run-answers.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, join(home, "run-answers.json"));
  }

  async dismiss(id: string): Promise<void> {
    const away = join(this.dir, ".dismissed");
    await mkdir(away, { recursive: true, mode: 0o700 });
    await rename(this.home(id), join(away, id));
  }
}
