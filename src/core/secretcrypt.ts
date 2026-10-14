/**
 * age for the secret store. One value is sealed alone to its machines, and
 * the sealed record carries its name and rotation stamp, so a ciphertext
 * copied under another name, or an old one restored, fails to open. A
 * machine's identity can be wrapped by a passphrase (age's scrypt). The
 * file's signing keys are ed25519 through WebCrypto. Bun-side.
 *
 * No error here names a value: callers put these messages in routes and logs.
 */

import { timingSafeEqual } from "node:crypto";
import { armor, Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";

interface Sealed {
  name: string;
  value: string;
  rotated: string;
}

const isSealed = (v: unknown): v is Sealed =>
  typeof v === "object" && v !== null && typeof (v as Sealed).name === "string" && typeof (v as Sealed).value === "string" && typeof (v as Sealed).rotated === "string";

/** A fresh X25519 identity and its recipient. Not `generateIdentity`, which
 *  may move to a post-quantum key the file's key check does not take. */
export async function newIdentity(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

export async function sealValue(name: string, value: string, rotated: string, recipients: readonly string[]): Promise<string> {
  if (recipients.length === 0) throw new Error(`${name} needs at least one recipient`);
  const e = new Encrypter();
  for (const r of recipients) e.addRecipient(r);
  const inner: Sealed = { name, value, rotated };
  return armor.encode(await e.encrypt(JSON.stringify(inner)));
}

export async function openValue(armored: string, identity: string, expect: { name: string; rotated: string }): Promise<string> {
  const d = new Decrypter();
  d.addIdentity(identity);
  let text: string;
  try {
    text = await d.decrypt(armor.decode(armored), "text");
  } catch {
    throw new Error(`${expect.name} does not open with this key`);
  }
  let inner: unknown;
  try {
    inner = JSON.parse(text);
  } catch {
    throw new Error(`${expect.name} holds no sealed record`);
  }
  if (!isSealed(inner)) throw new Error(`${expect.name} holds no sealed record`);
  if (inner.name !== expect.name) throw new Error(`${expect.name} holds a value sealed under another name`);
  if (inner.rotated !== expect.rotated) throw new Error(`${expect.name} holds a value from another rotation`);
  return inner.value;
}

/** the same value and stamp, sealed to a new set of recipients */
export async function resealValue(armored: string, identity: string, expect: { name: string; rotated: string }, recipients: readonly string[]): Promise<string> {
  return sealValue(expect.name, await openValue(armored, identity, expect), expect.rotated, recipients);
}

/** An identity under a passphrase. `logN` is scrypt's work factor: 18 for
 *  real keys (about a second), lower only in tests. */
export async function wrapIdentity(identity: string, passphrase: string, logN = 18): Promise<string> {
  const e = new Encrypter();
  e.setPassphrase(passphrase);
  e.setScryptWorkFactor(logN);
  return armor.encode(await e.encrypt(identity));
}

export async function unwrapIdentity(armored: string, passphrase: string): Promise<string> {
  const d = new Decrypter();
  d.addPassphrase(passphrase);
  let identity: string;
  try {
    identity = await d.decrypt(armor.decode(armored), "text");
  } catch {
    throw new Error("wrong passphrase");
  }
  if (!identity.startsWith("AGE-SECRET-KEY-1")) throw new Error("the wrapped file holds no age identity");
  return identity;
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
const ED = { name: "Ed25519" };

/** pkcs8 private and raw public halves, base64 */
export async function newSigningKey(): Promise<{ privateB64: string; publicB64: string }> {
  const k = (await crypto.subtle.generateKey(ED, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    privateB64: b64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey))),
    publicB64: b64(new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey))),
  };
}

export const signingKey = (privateB64: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("pkcs8", new Uint8Array(Buffer.from(privateB64, "base64")), ED, false, ["sign"]);

/** Equal values, compared in memory without an early exit. The store never
 *  writes or reports a digest of a value: a plain hash of a short secret is
 *  an offline guessing oracle for anyone holding the file. */
export function sameValue(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface ProposalRef {
  from: string;
  source: string;
  key: string;
}

/** the name a proposal's value is sealed under, so it opens only as itself */
export const proposalName = (p: ProposalRef): string => `proposal:${p.from}:${p.source}#${p.key}`;

export const sealProposal = (p: ProposalRef, value: string, miniRecipient: string): Promise<string> =>
  sealValue(proposalName(p), value, "", [miniRecipient]);

export const openProposal = (sealed: string, identity: string, p: ProposalRef): Promise<string> =>
  openValue(sealed, identity, { name: proposalName(p), rotated: "" });
