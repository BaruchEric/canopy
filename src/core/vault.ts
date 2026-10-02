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

  /** the note's revision as the gateway has it now; undefined when there is none */
  private async headRev(path: string): Promise<string | undefined> {
    const res = await this.#fetcher(`${this.#url}/file?path=${encodeURIComponent(path)}`, {
      headers: this.auth(),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new VaultError(res.status, `${path}: reading it answered ${res.status}`);
    return str(res.headers.get("x-vault-rev"));
  }

  /** Writes the whole note. Answers the revision to replace it with next,
   *  or undefined when the gateway queued the write. */
  async put(path: string, text: string, rev: string | undefined): Promise<string | undefined> {
    let base = rev;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = base ? await this.write("replace", path, text, base) : await this.write("create", path, text);
      if (r.status === 200) return str(r.body["rev"]);
      if (r.status === 202) return undefined;
      if (r.status === 404 && base) {
        base = undefined;
        continue;
      }
      if (r.status === 409) {
        base = str(r.body["headRev"]) ?? (await this.headRev(path));
        if (!base) throw new VaultError(409, `${path}: in conflict, with no revision to replace yet`);
        continue;
      }
      throw this.refused(path, r);
    }
    throw new VaultError(409, `${path}: still in conflict after three tries`);
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
