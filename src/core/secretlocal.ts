/**
 * A backend that is not the secrets writer (the Mac today): a read-only
 * checkout of eric/secrets in canopy's config dir, moved only by a
 * fast-forward whose newest secrets.json the pinned mini key signed; any
 * other commit is refused and the last good one stays. On a machine with
 * its own age key, the key is wrapped by a passphrase and held in memory
 * only after an unlock; the reader then writes this machine's sinks, and
 * seals import proposals and "take this value" to the mini's key for the
 * mini's page to approve. Locked, the sinks keep their contents.
 */

import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { identityToRecipient } from "age-encryption";
import { readApplied, writeApplied } from "./applied";
import { exec, firstLine, type ExecResult } from "./exec";
import { newIdentity, sealProposal, unwrapIdentity, wrapIdentity } from "./secretcrypt";
import { metaList, parseSecretFile, verifyFile, type SecretFile } from "./secretfile";
import { scanFiles, type ImportSource } from "./secretimport";
import { LIMITS } from "./secretwire";
import { readKeys, repoRefusal } from "./sinks";
import { FILE_IO, mcpEnvKeep, pruneMcpEnv, syncSink, waitingState, type SinkIO, type SinkState } from "./sinksync";
import { configDir } from "./store";
import type { SecretKeyState, SecretProposalIn, SecretsInfo } from "./types";

export const localPaths = (dir: string = configDir()) => ({
  checkout: join(dir, "secrets"),
  config: join(dir, "secrets-config.json"),
  identity: join(dir, "secrets-key.age"),
  applied: join(dir, "secrets-applied.json"),
});

export interface LocalConfig {
  /** the mini's signing key, raw ed25519, base64 */
  pin: string | null;
  /** Forgejo's URL for eric/secrets, as this machine's git reaches it */
  remote: string | null;
}

/** a raw ed25519 public key in base64: 32 bytes */
export const PIN = /^[A-Za-z0-9+/]{43}=$/;

export async function readLocalConfig(path: string): Promise<LocalConfig> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as Partial<Record<keyof LocalConfig, unknown>>;
    return { pin: typeof v.pin === "string" && PIN.test(v.pin) ? v.pin : null, remote: typeof v.remote === "string" && v.remote ? v.remote : null };
  } catch {
    return { pin: null, remote: null };
  }
}

export async function writeLocalConfig(path: string, c: LocalConfig): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export interface ReaderOptions {
  paths: ReturnType<typeof localPaths>;
  /** this machine's name in the file */
  machine: string;
  gateUrl: string;
  /** this machine's import sources */
  sources: () => ImportSource[];
  /** the scanned repos: a sink inside one must be ignored there */
  repoRoots: () => readonly string[];
  io?: SinkIO;
  /** this machine's ~/.claude/mcp-env, pruned after each pass even while locked */
  mcpEnvDir?: string;
  sleep?: (ms: number) => Promise<void>;
  /** scrypt's work factor for a new key: 18 unless a test lowers it */
  scryptLogN?: number;
  log: (line: string) => void;
}

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

export class SecretsReader {
  file: SecretFile | null = null;
  head: string | null = null;
  /** the commit the last finished sink pass read */
  private sinksAt: string | null = null;
  refused: string | null = null;
  error: string | null = null;
  private ident: string | null = null;
  /** the open identity's public half, kept beside it so info() can stay synchronous */
  private recip: string | null = null;
  private hasKey = false;
  private failures = 0;
  private sinkState: Record<string, SinkState> = {};
  private pulling: Promise<void> | null = null;
  private readonly io: SinkIO;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: ReaderOptions) {
    this.io = o.io ?? FILE_IO;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async start(): Promise<void> {
    this.hasKey = await exists(this.o.paths.identity);
    await this.pull();
  }

  private git(args: string[]): Promise<ExecResult> {
    return exec(["git", "-C", this.o.paths.checkout, ...args], { timeoutMs: 60_000, env: { GIT_TERMINAL_PROMPT: "0" } });
  }

  /** one pull at a time; a second caller waits for the first */
  pull(): Promise<void> {
    this.pulling ??= this.pullNow().finally(() => {
      this.pulling = null;
    });
    return this.pulling;
  }

  private async pullNow(): Promise<void> {
    const cfg = await readLocalConfig(this.o.paths.config);
    if (!cfg.pin || !cfg.remote) {
      this.error = "no mini signing key pinned yet; run canopy secrets pin <key> --remote <url>";
      return;
    }
    this.error = null;
    if (!(await exists(join(this.o.paths.checkout, ".git")))) {
      const r = await exec(["git", "init", "-q", "-b", "main", this.o.paths.checkout]);
      if (r.code !== 0) {
        this.error = `the checkout could not be made: ${firstLine(r.stderr)}`;
        return;
      }
      await this.git(["remote", "add", "origin", cfg.remote]);
    } else {
      await this.git(["remote", "set-url", "origin", cfg.remote]);
    }
    if (!this.file) await this.loadHead(cfg.pin);
    const fetched = await this.git(["fetch", "-q", "origin", "main"]);
    if (fetched.code !== 0) {
      this.error = `Forgejo did not answer: ${firstLine(fetched.stderr)}`;
      return;
    }
    const tip = (await this.git(["rev-parse", "--short", "origin/main"])).stdout.trim();
    if (tip === this.head) return;
    if (this.head && (await this.git(["merge-base", "--is-ancestor", "HEAD", "origin/main"])).code !== 0) {
      this.refused = `Forgejo's main (${tip}) does not follow ${this.head}: not a fast-forward, so ${this.head} stays`;
      this.o.log(`secrets: ${this.refused}`);
      return;
    }
    const shown = await this.git(["show", "origin/main:secrets.json"]);
    const parsed = shown.code === 0 ? parseSecretFile(shown.stdout) : { error: "origin/main has no secrets.json" };
    if ("error" in parsed || !(await verifyFile(parsed.file, cfg.pin))) {
      const why = "error" in parsed ? `does not parse (${parsed.error})` : "is not signed by the pinned mini key";
      this.refused = `the newest commit (${tip}) ${why}; ${this.head ?? "nothing"} stays`;
      this.o.log(`secrets: ${this.refused}`);
      return;
    }
    if (this.file && parsed.file.seq <= this.file.seq) {
      this.refused = `the newest commit (${tip}) holds an older file (seq ${parsed.file.seq}, not after ${this.file.seq}); ${this.head ?? "nothing"} stays`;
      this.o.log(`secrets: ${this.refused}`);
      return;
    }
    const moved = this.head ? await this.git(["merge", "-q", "--ff-only", "origin/main"]) : await this.git(["checkout", "-q", "-B", "main", "origin/main"]);
    if (moved.code !== 0) {
      this.error = `the checkout did not move: ${firstLine(moved.stderr)}`;
      return;
    }
    this.file = parsed.file;
    this.head = tip;
    this.refused = null;
    await this.syncSinks();
  }

  /** the last good commit, read again after a restart (and verified again) */
  private async loadHead(pin: string): Promise<void> {
    const shown = await this.git(["show", "HEAD:secrets.json"]);
    if (shown.code !== 0) return;
    const parsed = parseSecretFile(shown.stdout);
    if ("error" in parsed || !(await verifyFile(parsed.file, pin))) {
      this.error = "the local checkout's secrets.json fails the pinned key; delete the checkout folder and let canopy fetch it again";
      return;
    }
    this.file = parsed.file;
    this.head = (await this.git(["rev-parse", "--short", "HEAD"])).stdout.trim();
  }

  lock(): "open" | "locked" | "none" {
    if (this.ident) return "open";
    return this.hasKey ? "locked" : "none";
  }

  async unlock(passphrase: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.failures > 0) await this.sleep(this.failures * 2000);
    let armored: string;
    try {
      armored = await readFile(this.o.paths.identity, "utf8");
    } catch {
      return { ok: false, error: "no key for this machine yet; create one first" };
    }
    try {
      this.ident = await unwrapIdentity(armored, passphrase);
      this.recip = await identityToRecipient(this.ident);
    } catch {
      this.failures += 1;
      return { ok: false, error: "wrong passphrase" };
    }
    this.failures = 0;
    await this.syncSinks();
    return { ok: true };
  }

  /** forget the identity; the sinks keep their contents */
  lockNow(): void {
    this.ident = null;
    this.recip = null;
    void this.syncSinks();
  }

  async createKey(passphrase: string, replace: boolean): Promise<{ recipient: string } | { error: string }> {
    if (passphrase.length < 12) return { error: "use a passphrase of at least 12 characters" };
    if (this.hasKey && !replace) return { error: "this machine has a key; replace it only when its passphrase is lost" };
    const { identity, recipient } = await newIdentity();
    const wrapped = await wrapIdentity(identity, passphrase, this.o.scryptLogN ?? 18);
    const tmp = `${this.o.paths.identity}.tmp-${process.pid}`;
    await writeFile(tmp, wrapped, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.o.paths.identity);
    this.hasKey = true;
    this.ident = identity;
    this.recip = recipient;
    this.failures = 0;
    return { recipient };
  }

  /** this machine's recipient, while unlocked */
  async recipient(): Promise<string | null> {
    return this.ident ? identityToRecipient(this.ident) : null;
  }

  async syncSinks(): Promise<void> {
    const f = this.file;
    if (!f) return;
    const at = this.head;
    const applied = await readApplied(this.o.paths.applied);
    const state: Record<string, SinkState> = {};
    for (const [id, sink] of Object.entries(f.sinks)) {
      if (sink.machine !== this.o.machine) continue;
      if (!this.ident) {
        state[id] = waitingState(sink);
        continue;
      }
      state[id] = await syncSink(f, id, sink, this.ident, applied, this.io, await repoRefusal(sink.path, this.o.repoRoots()));
    }
    if (this.ident) await writeApplied(this.o.paths.applied, Object.fromEntries(Object.entries(applied).filter(([id]) => state[id])));
    this.sinkState = state;
    this.sinksAt = at;
    const d = this.o.mcpEnvDir;
    if (d) for (const n of await pruneMcpEnv(d, mcpEnvKeep(f, this.o.machine, d))) this.o.log(`secrets: removed ${d}/${n}, which no sink names`);
  }

  /** this machine's sources, each value sealed to the mini alone */
  async proposals(): Promise<{ items: SecretProposalIn[]; missing: string[] } | { error: string }> {
    const mini = this.file?.keys["mini"];
    if (!mini) return { error: "no verified secrets.json here yet, so no mini key to seal to" };
    const { found, missing } = await scanFiles(this.o.sources());
    const items: SecretProposalIn[] = [];
    for (const x of found) {
      if (items.length >= LIMITS.proposals) break;
      // a value too large to seal under the proposal cap is left for a hand entry
      if (x.value !== null && x.value.length > LIMITS.sealed / 2) continue;
      const ref = { from: this.o.machine, source: x.source, key: x.key };
      items.push({ ...ref, sealed: x.value === null ? "" : await sealProposal(ref, x.value, mini), merges: null });
    }
    return { items, missing };
  }

  /** a drifted sink key's file value, sealed to the mini as an update of its secret */
  async take(id: string, key: string): Promise<SecretProposalIn | { error: string }> {
    const f = this.file;
    const sink = f?.sinks[id];
    const name = sink?.keys[key];
    const mini = f?.keys["mini"];
    if (!f || !sink || !name || !mini) return { error: `sink ${id} has no key ${key}` };
    if (sink.machine !== this.o.machine) return { error: `sink ${id} lives on ${sink.machine}` };
    const read = await this.io.read(sink.path);
    if ("error" in read) return read;
    if (read.text === null) return { error: `${sink.path} does not exist` };
    const have = readKeys(read.text, sink.format, [key]);
    if ("error" in have) return { error: `${sink.path}: ${have.error}` };
    const value = have.values[key];
    if (!value) return { error: `${sink.path} has no ${key}` };
    const ref = { from: this.o.machine, source: sink.path, key };
    return { ...ref, sealed: await sealProposal(ref, value, mini), merges: name };
  }

  info(backend: string): SecretsInfo {
    const f = this.file;
    const sinks = f
      ? Object.keys(f.sinks)
          .sort()
          .flatMap((id) => {
            const k = f.sinks[id];
            if (!k) return [];
            const own = k.machine === this.o.machine;
            const state: Record<string, SecretKeyState> = own
              ? (this.sinkState[id]?.state ?? {})
              : k.machine === "gpd" && this.o.machine === "mac"
                ? Object.fromEntries(Object.keys(k.keys).map((key) => [key, "phase 3" as const]))
                : {};
            return [{ id, machine: k.machine, path: k.path, format: k.format, keys: { ...k.keys }, state, error: own ? (this.sinkState[id]?.error ?? null) : null }];
          })
      : [];
    return {
      ok: f !== null,
      error: this.error ?? (f ? null : "no verified secrets.json here yet"),
      backend,
      role: "reader",
      head: this.head,
      sinksAt: this.sinksAt,
      refused: this.refused,
      lock: this.lock(),
      recipient: this.recip,
      secrets: f ? metaList(f) : [],
      sinks,
      proposals: [],
      passkeys: [],
      session: false,
      firstPasskey: false,
      gate: this.o.gateUrl,
      unpushed: 0,
    };
  }
}
