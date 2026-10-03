/**
 * The improvements list in the config dir (amendment 5 of the incubator
 * spec): `incubator/improvements.json` holds every key a retro gave, with
 * the sprouts that gave it and the user's answer, and
 * `incubator/improvements.md` is rendered from it for reading. Both are
 * written whole through a rename at 0600; every change goes one after
 * another, so two retros ending together never drop each other's advice.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdviceSink } from "./incubator";
import { decide, foldAdvice, improvementsMd, knownAdvice, offered, parseImprovements, type KnownAdvice } from "./retro";
import { incubatorDir } from "./sproutstore";
import type { Advice, AdviceEntry, AdviceOffer, Improvements } from "./types";

export class AdviceFiles implements AdviceSink {
  /** every write, one after another */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string = incubatorDir(),
    /** the offers, each time a write changes them */
    private readonly onChange: (offers: AdviceOffer[]) => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = (line) => console.error(`incubator: ${line}`),
  ) {}

  private get json(): string {
    return join(this.dir, "improvements.json");
  }

  /** the list as it is on disk; a missing file is empty, a broken one empty with a log line */
  async read(): Promise<Improvements> {
    const text = await readFile(this.json, "utf8").catch(() => null);
    if (text === null) return { entries: {} };
    const st = parseImprovements(text);
    if (st) return st;
    this.log(`${this.json} is not an improvements list; it is read as empty and written over at the next retro`);
    return { entries: {} };
  }

  private async write(st: Improvements): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const put = async (name: string, text: string): Promise<void> => {
      const tmp = join(this.dir, `.${name}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, join(this.dir, name));
    };
    await put("improvements.json", `${JSON.stringify(st, null, 2)}\n`);
    await put("improvements.md", improvementsMd(st));
  }

  /** a change read, made and written after every change before it */
  private change<T>(work: (st: Improvements) => { next: Improvements | null; out: T }): Promise<T> {
    const run = this.chain.catch(() => {}).then(async () => {
      const { next, out } = work(await this.read());
      if (next) {
        await this.write(next);
        this.onChange(offered(next));
      }
      return out;
    });
    this.chain = run;
    return run;
  }

  async known(): Promise<KnownAdvice[]> {
    return knownAdvice(await this.read());
  }

  async offers(): Promise<AdviceOffer[]> {
    return offered(await this.read());
  }

  /** a key on offer now, or undefined */
  async offer(key: string): Promise<AdviceEntry | undefined> {
    const st = await this.read();
    if (!Object.hasOwn(st.entries, key)) return undefined;
    return offered(st).some((o) => o.key === key) ? st.entries[key] : undefined;
  }

  fold(advice: readonly Advice[], from: { id: string; title: string }): Promise<void> {
    if (advice.length === 0) return Promise.resolve();
    return this.change((st) => ({ next: foldAdvice(st, advice, from, this.now()), out: undefined }));
  }

  /** the user's answer on a key; false for a key not on the list */
  decide(key: string, accept: boolean): Promise<boolean> {
    return this.change((st) => {
      const next = decide(st, key, accept, this.now());
      return { next, out: next !== null };
    });
  }
}
