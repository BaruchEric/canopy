/**
 * The writer's side of secrets.json: the checkout and keys in the
 * secrets-data volume. Opens (or on a first start makes) the mini's age
 * identity and signing key, refuses a file its own key did not sign,
 * signs and commits each change as canopy@mini, and pushes to Forgejo with
 * the volume's deploy key. A failed push keeps the commit and counts it.
 */

import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { identityToRecipient } from "age-encryption";
import { exec, type ExecResult } from "../core/exec";
import { newIdentity, newSigningKey, signingKey } from "../core/secretcrypt";
import { emptyFile, parseSecretFile, serializeFile, signFile, verifyFile, type SecretFile } from "../core/secretfile";

export const storePaths = (data: string) => ({
  repo: join(data, "repo"),
  file: join(data, "repo", "secrets.json"),
  keys: join(data, "keys"),
  identity: join(data, "keys", "mini.age"),
  signingKey: join(data, "keys", "signing.key"),
  signingPub: join(data, "keys", "signing.pub"),
  deployKey: join(data, "keys", "deploy"),
  knownHosts: join(data, "keys", "known_hosts"),
  audit: join(data, "audit.jsonl"),
  passkeys: join(data, "passkeys.json"),
  applied: join(data, "applied.json"),
});

export interface StoreOptions {
  data: string;
  /** Forgejo's URL for eric/secrets; null keeps the store local (tests, a first try) */
  remote: string | null;
  breakglass: string;
  log: (line: string) => void;
}

const exists = async (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

async function writeKey(path: string, text: string): Promise<void> {
  await writeFile(path, text, { mode: 0o400, flag: "wx" });
  await chmod(path, 0o400);
}

export class SecretStore {
  file!: SecretFile;
  head: string | null = null;
  unpushed = 0;
  recipient = "";
  publicB64 = "";
  private ident = "";
  private signer!: CryptoKey;
  private readonly paths: ReturnType<typeof storePaths>;

  private constructor(private readonly opts: StoreOptions) {
    this.paths = storePaths(opts.data);
  }

  static async open(opts: StoreOptions): Promise<SecretStore> {
    const s = new SecretStore(opts);
    await s.keys();
    await s.checkout();
    return s;
  }

  /** the mini's age identity; never leaves this process */
  identity(): string {
    return this.ident;
  }

  private git(args: string[]): Promise<ExecResult> {
    const p = this.paths;
    return exec(["git", "-C", p.repo, ...args], {
      timeoutMs: 60_000,
      env: {
        GIT_AUTHOR_NAME: "canopy",
        GIT_AUTHOR_EMAIL: "canopy@mini",
        GIT_COMMITTER_NAME: "canopy",
        GIT_COMMITTER_EMAIL: "canopy@mini",
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: `ssh -i ${p.deployKey} -o IdentitiesOnly=yes -o UserKnownHostsFile=${p.knownHosts} -o StrictHostKeyChecking=accept-new -o BatchMode=yes`,
      },
    });
  }

  private async keys(): Promise<void> {
    const p = this.paths;
    await mkdir(p.keys, { recursive: true, mode: 0o700 });
    if (!(await exists(p.identity))) {
      const { identity } = await newIdentity();
      await writeKey(p.identity, `${identity}\n`);
    }
    if (!(await exists(p.signingKey))) {
      const k = await newSigningKey();
      await writeKey(p.signingKey, `${k.privateB64}\n`);
      await writeFile(p.signingPub, `${k.publicB64}\n`, { mode: 0o444 });
    }
    if (this.opts.remote?.startsWith("ssh://") && !(await exists(p.deployKey))) {
      const r = await exec(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "canopy-secrets@mini", "-f", p.deployKey], { timeoutMs: 30_000 });
      if (r.code !== 0) throw new Error(`ssh-keygen failed: ${r.stderr.trim()}`);
      await chmod(p.deployKey, 0o400);
      this.opts.log(`secrets: new deploy key for Forgejo (add it to eric/secrets with write access): ${(await readFile(`${p.deployKey}.pub`, "utf8")).trim()}`);
    }
    this.ident = (await readFile(p.identity, "utf8")).trim();
    this.signer = await signingKey((await readFile(p.signingKey, "utf8")).trim());
    this.publicB64 = (await readFile(p.signingPub, "utf8")).trim();
    this.recipient = await identityToRecipient(this.ident);
    // public halves only: what Eric pins on the Mac and what the file names
    this.opts.log(`secrets: mini recipient ${this.recipient}, signing key ${this.publicB64}`);
  }

  private async checkout(): Promise<void> {
    const p = this.paths;
    if (!(await exists(join(p.repo, ".git")))) {
      const r = this.opts.remote
        ? await exec(["git", "clone", "-q", this.opts.remote, p.repo], { timeoutMs: 120_000, env: { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: `ssh -i ${p.deployKey} -o IdentitiesOnly=yes -o UserKnownHostsFile=${p.knownHosts} -o StrictHostKeyChecking=accept-new -o BatchMode=yes` } })
        : await exec(["git", "init", "-q", "-b", "main", p.repo]);
      if (r.code !== 0) throw new Error(`the checkout could not be made: ${r.stderr.trim()}`);
      // an empty clone's unborn branch follows the client's default; pin it
      await this.git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    } else if (this.opts.remote) {
      // a checkout made before the remote was set, or with another URL
      const url = await this.git(["remote", "get-url", "origin"]);
      if (url.code !== 0) await this.git(["remote", "add", "origin", this.opts.remote]);
      else if (url.stdout.trim() !== this.opts.remote) {
        await this.git(["remote", "set-url", "origin", this.opts.remote]);
        // the old remote's main says nothing about what the new one holds
        await this.git(["update-ref", "-d", "refs/remotes/origin/main"]);
      }
      await this.fastForward();
    }
    if (!(await exists(p.file))) {
      await this.commit(emptyFile({ mini: this.recipient, breakglass: this.opts.breakglass }), "secrets: start the store");
      return;
    }
    const parsed = parseSecretFile(await readFile(p.file, "utf8"));
    if ("error" in parsed) throw new Error(`secrets.json does not parse: ${parsed.error}`);
    if (!(await verifyFile(parsed.file, this.publicB64))) {
      throw new Error("secrets.json is not signed by this mini's key; restore the key or run canopy secrets recover");
    }
    if (parsed.file.keys["mini"] !== this.recipient) throw new Error("secrets.json names another mini key; restore the key or run canopy secrets recover");
    this.file = parsed.file;
    await this.refreshHead();
    // commits made while Forgejo was away or not set yet go up now
    if (this.opts.remote && this.unpushed > 0) await this.push();
  }

  /** take Forgejo's commits when they only add to ours (a recovery pushed from elsewhere) */
  private async fastForward(): Promise<void> {
    const f = await this.git(["fetch", "-q", "origin"]);
    if (f.code !== 0) {
      this.opts.log(`secrets: fetch failed, going on with the local checkout: ${f.stderr.trim().split("\n")[0] ?? ""}`);
      return;
    }
    // an empty Forgejo repo has no main yet: nothing to take, nothing split
    if ((await this.git(["rev-parse", "-q", "--verify", "refs/remotes/origin/main"])).code !== 0) return;
    const ahead = await this.git(["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
    if (ahead.code === 0) {
      const why = await this.refusal("origin/main");
      if (why) this.opts.log(`secrets: Forgejo's main is not taken: ${why}; pushes will fail until it is reset`);
      else await this.git(["merge", "-q", "--ff-only", "origin/main"]);
      return;
    }
    const behind = await this.git(["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
    if (behind.code !== 0) this.opts.log("secrets: Forgejo's history and this checkout have split; pushes will fail until one is reset");
  }

  /** why `rev`'s file may not replace HEAD's: unsigned by this key, or not
   *  newer. Null when it may. Checked before a merge, never after. */
  private async refusal(rev: string): Promise<string | null> {
    const ours = await this.git(["show", "HEAD:secrets.json"]);
    const theirs = await this.git(["show", `${rev}:secrets.json`]);
    if (theirs.code !== 0) return ours.code === 0 ? "it has no secrets.json" : null;
    const parsed = parseSecretFile(theirs.stdout);
    if ("error" in parsed) return `its secrets.json does not parse (${parsed.error})`;
    if (!(await verifyFile(parsed.file, this.publicB64))) return "its secrets.json is not signed by this mini's key";
    const mine = ours.code === 0 ? parseSecretFile(ours.stdout) : null;
    if (mine && "file" in mine && parsed.file.seq <= mine.file.seq) return `it holds an older file (seq ${parsed.file.seq}, not after ${mine.file.seq})`;
    return null;
  }

  private async refreshHead(): Promise<void> {
    const h = await this.git(["rev-parse", "--short", "HEAD"]);
    this.head = h.code === 0 ? h.stdout.trim() : null;
    if (!this.opts.remote) {
      this.unpushed = 0;
      return;
    }
    const n = await this.git(["rev-list", "--count", "origin/main..HEAD"]);
    // no origin/main yet (an empty remote): every local commit waits
    this.unpushed = n.code === 0 ? Number(n.stdout.trim()) : Number((await this.git(["rev-list", "--count", "HEAD"])).stdout.trim() || 0);
  }

  /** Sign `next`, write it, commit it with `message` (names only, never a
   *  value), and push. */
  async commit(next: SecretFile, message: string): Promise<void> {
    const signed = await signFile({ ...next, seq: next.seq + 1, signature: null }, this.signer, "mini");
    const tmp = `${this.paths.file}.tmp-${process.pid}`;
    await writeFile(tmp, serializeFile(signed), { mode: 0o644 });
    await rename(tmp, this.paths.file);
    const add = await this.git(["add", "secrets.json"]);
    const c = add.code === 0 ? await this.git(["commit", "-q", "-m", message]) : add;
    if (c.code !== 0) throw new Error(`the commit failed: ${c.stderr.trim()}`);
    this.file = signed;
    await this.push();
  }

  async push(): Promise<void> {
    if (this.opts.remote) {
      const r = await this.git(["push", "-q", "origin", "HEAD:main"]);
      if (r.code !== 0) this.opts.log(`secrets: push failed, the commit waits: ${r.stderr.trim().split("\n")[0] ?? ""}`);
      else await this.git(["fetch", "-q", "origin"]);
    }
    await this.refreshHead();
  }
}
