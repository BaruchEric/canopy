/**
 * The incubator's writes to the memory vault, through the gateway's write
 * API (the one `vault write` uses) with a token of canopy's own,
 * `CANOPY_VAULT_TOKEN`. Only the token in the env is read, never the
 * vault CLI's token file, and nothing under `bun test`: the tests pass a
 * stand-in.
 */

export interface VaultConfig {
  url: string;
  token: string;
}

export function vaultConfig(env: Record<string, string | undefined> = process.env): VaultConfig | null {
  if (env["NODE_ENV"] === "test") return null;
  const token = env["CANOPY_VAULT_TOKEN"]?.trim();
  if (!token) return null;
  const url = (env["CANOPY_VAULT_URL"]?.trim() || "https://mem.beric.ca").replace(/\/+$/, "");
  return { url, token };
}

export class VaultError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

const TIMEOUT = 20_000;
/** a put's writes at most: its path, the owner's other path, and a race at each */
const PUT_TRIES = 5;

/** Whose a note is: a line only its owner's notes carry in their
 *  frontmatter, and the path the owner writes to instead when another's
 *  note holds the one asked for. */
export interface NoteOwner {
  mark: string;
  elsewhere: string;
  /** Lines the owner's notes carried in their frontmatter before marks
   *  existed. A note with every one of them and no mark of anyone's (no line
   *  starting with the mark's own `name:`) is the owner's too, so a note
   *  written before marks is replaced in place, not left behind. */
  legacy?: readonly string[];
}

/** a note's frontmatter lines (from its opening `---` to the next, or to the end), trimmed; null when it has none */
function frontmatter(text: string): string[] | null {
  const lines = text.split("\n").map((l) => l.trim());
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  return end === -1 ? lines.slice(1) : lines.slice(1, end);
}

/** whether a note's frontmatter (between its opening `---` and the next) has the line `mark` */
export function marked(text: string, mark: string): boolean {
  return frontmatter(text)?.includes(mark) ?? false;
}

/** whether the note is the owner's: its mark, or every legacy line and no mark at all */
function owns(text: string, owner: NoteOwner): boolean {
  const fm = frontmatter(text);
  if (!fm) return false;
  if (fm.includes(owner.mark)) return true;
  const legacy = owner.legacy ?? [];
  if (legacy.length === 0) return false;
  const name = owner.mark.slice(0, owner.mark.indexOf(":") + 1);
  return name !== "" && !fm.some((l) => l.startsWith(name)) && legacy.every((l) => fm.includes(l));
}

export class VaultNotes {
  /** in private fields, so neither JSON.stringify nor a console.log of
   *  this object ever shows the token */
  readonly #url: string;
  readonly #token: string;
  readonly #fetcher: typeof fetch;

  constructor(cfg: VaultConfig, fetcher: typeof fetch = fetch) {
    this.#url = cfg.url;
    this.#token = cfg.token;
    this.#fetcher = fetcher;
  }

  toJSON(): { url: string } {
    return { url: this.#url };
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.#token}` };
  }

  private async write(op: "create" | "append" | "replace", path: string, content: string, baseRev?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.#fetcher(`${this.#url}/write`, {
      method: "POST",
      headers: { ...this.auth(), "content-type": "application/json" },
      body: JSON.stringify({ op, path, content, ...(baseRev ? { base_rev: baseRev } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const body: unknown = await res.json().catch(() => ({}));
    return { status: res.status, body: isObj(body) ? body : {} };
  }

  private refused(path: string, r: { status: number; body: Record<string, unknown> }): VaultError {
    return new VaultError(r.status, `${path}: ${str(r.body["error"]) ?? `the gateway answered ${r.status}`}`);
  }

  /** the note as the gateway has it now, with its revision; null when there is none */
  private async head(path: string): Promise<{ text: string; rev: string | undefined } | null> {
    const res = await this.#fetcher(`${this.#url}/file?path=${encodeURIComponent(path)}`, {
      headers: this.auth(),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const text = await res.text().catch(() => "");
    if (res.status === 404) return null;
    if (!res.ok) throw new VaultError(res.status, `${path}: reading it answered ${res.status}`);
    return { text, rev: str(res.headers.get("x-vault-rev")) };
  }

  /** Writes the whole note, at `path` or, when another's note holds that,
   *  at `owner.elsewhere`. A conflict reads the note in the way and writes
   *  over it only when its frontmatter carries `owner.mark`, or, for a note
   *  written before marks, every line of `owner.legacy` and no mark: two
   *  backends can pick the same slug, and each must keep its own note. Answers where
   *  the note went and the revision to replace it with next, undefined when
   *  the gateway queued the write. */
  async put(path: string, text: string, rev: string | undefined, owner: NoteOwner): Promise<{ rev: string | undefined; path: string }> {
    let at = path;
    let base = rev;
    for (let attempt = 0; attempt < PUT_TRIES; attempt++) {
      const r = base ? await this.write("replace", at, text, base) : await this.write("create", at, text);
      if (r.status === 200) return { rev: str(r.body["rev"]), path: at };
      if (r.status === 202) return { rev: undefined, path: at };
      if (r.status === 404 && base) {
        base = undefined;
        continue;
      }
      if (r.status === 409) {
        const there = await this.head(at);
        if (there === null) {
          // gone since the write: made again
          base = undefined;
          continue;
        }
        if (owns(there.text, owner)) {
          if (!there.rev) throw new VaultError(409, `${at}: in conflict, with no revision to replace yet`);
          base = there.rev;
          continue;
        }
        if (at === owner.elsewhere) throw new VaultError(409, `${at}: another note is there, and it is not this one's`);
        at = owner.elsewhere;
        base = undefined;
        continue;
      }
      throw this.refused(at, r);
    }
    throw new VaultError(409, `${at}: still in conflict after ${PUT_TRIES} tries`);
  }

  /** Adds a line at the end; a note that is not there yet is made from `head`. */
  async append(path: string, line: string, head: string): Promise<void> {
    const r = await this.write("append", path, line);
    if (r.status === 200 || r.status === 202) return;
    if (r.status !== 404) throw this.refused(path, r);
    const c = await this.write("create", path, `${head}${line}`);
    if (c.status === 200 || c.status === 202) return;
    if (c.status !== 409) throw this.refused(path, c);
    // made by someone else a moment ago
    const again = await this.write("append", path, line);
    if (again.status !== 200 && again.status !== 202) throw this.refused(path, again);
  }
}

export const vaultNotes = (cfg: VaultConfig | null): VaultNotes | null => (cfg ? new VaultNotes(cfg) : null);
