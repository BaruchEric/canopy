/**
 * Where a reader's key passphrase can wait between canopy starts: the macOS
 * login Keychain, through /usr/bin/security. Needs Bun (it runs a command).
 *
 * This is a trade the machine's owner makes with `canopy secrets unlock
 * --keep`, never a default. The passphrase exists so that an agent running
 * as the same user cannot open the machine's key from the key file alone.
 * An item `security` writes is one `security` reads back without a prompt,
 * for any process of that user, so a kept passphrase gives that up in return
 * for a key that opens itself when canopy starts.
 *
 * The passphrase goes to `security -i` on stdin, never on a command line,
 * where `ps` would show it. It is stored as base64 behind a tag: `security`
 * prints a value that is not plain ASCII as hex, and the tag tells canopy's
 * item from one typed into Keychain Access by hand.
 */

import { createHash } from "node:crypto";
import { exec, type ExecResult } from "./exec";

export interface PassKeeper {
  /** the kept passphrase, or null when none is kept; throws when the keychain does not answer */
  read(): Promise<string | null>;
  /** throws with the reason, and never with the passphrase in it */
  write(passphrase: string): Promise<void>;
  /** takes it out; none kept is no failure */
  drop(): Promise<void>;
}

export type KeeperRun = (argv: string[], input?: string) => Promise<ExecResult>;

export const KEYCHAIN_SERVICE = "ca.beric.canopy.secrets-key";
const SECURITY = "/usr/bin/security";
const TAG = "canopy1:";
/** `security`'s exit code for an item that is not there */
const NOT_FOUND = 44;
/** an account goes on a command line and into a line `security -i` splits on spaces */
const ACCOUNT = /^[A-Za-z0-9._-]{1,64}$/;

const spawnRun: KeeperRun = (argv, input) => exec(argv, { timeoutMs: 15_000, ...(input === undefined ? {} : { input }) });

const encode = (passphrase: string): string => TAG + Buffer.from(passphrase, "utf8").toString("base64url");

function decode(stored: string): string | null {
  const body = stored.startsWith(TAG) ? stored.slice(TAG.length) : null;
  if (body === null || !/^[A-Za-z0-9_-]+$/.test(body)) return null;
  return Buffer.from(body, "base64url").toString("utf8");
}

/** `security`'s own words for a failure, without anything canopy handed it */
function reason(r: ExecResult, hide: string | null): string {
  const line = r.stderr.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? `security ended with code ${r.code}`;
  return hide === null ? line : line.split(hide).join("…");
}

/** the login Keychain's item for one machine's key */
export function keychainKeeper(account: string, run: KeeperRun = spawnRun): PassKeeper {
  if (!ACCOUNT.test(account)) throw new Error(`${JSON.stringify(account)} cannot name a keychain item`);
  const item = ["-s", KEYCHAIN_SERVICE, "-a", account];
  const read = async (): Promise<string | null> => {
    const r = await run([SECURITY, "find-generic-password", ...item, "-w"]);
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0) throw new Error(reason(r, null));
    return decode(r.stdout.replace(/\r?\n$/, ""));
  };
  return {
    read,
    async write(passphrase) {
      const stored = encode(passphrase);
      const r = await run([SECURITY, "-i"], `add-generic-password -U ${item.join(" ")} -w ${stored}\n`);
      if (r.code !== 0) throw new Error(reason(r, stored));
      // `security -i` goes on after a line it could not run, so only a read says the item is there
      if ((await read()) !== passphrase) throw new Error("the keychain took the passphrase but it did not read back");
    },
    async drop() {
      const r = await run([SECURITY, "delete-generic-password", ...item]);
      if (r.code !== 0 && r.code !== NOT_FOUND) throw new Error(reason(r, null));
    },
  };
}

/** The item's account: the machine's name and a mark of its key file's
 *  path. A second canopy on the machine with its own config folder (a
 *  scratch server, a test) has its own key file, and so its own item: it can
 *  neither try this one's passphrase nor take it out when it makes a key. */
export const keeperAccount = (machine: string, identityPath: string): string =>
  `${machine}.${createHash("sha256").update(identityPath).digest("hex").slice(0, 8)}`;

/** the keeper for one machine's key file, or null where there is no login Keychain */
export function localKeeper(machine: string, identityPath: string, platform: string = process.platform): PassKeeper | null {
  const account = keeperAccount(machine, identityPath);
  return platform === "darwin" && ACCOUNT.test(account) ? keychainKeeper(account) : null;
}
