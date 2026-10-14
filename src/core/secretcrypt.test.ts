import { describe, expect, test } from "bun:test";
import {
  newIdentity,
  newSigningKey,
  openProposal,
  openValue,
  resealValue,
  sameValue,
  sealProposal,
  sealValue,
  signingKey,
  unwrapIdentity,
  wrapIdentity,
} from "./secretcrypt";
import { emptyFile, signFile, verifyFile } from "./secretfile";

const V = "fixture-value-0x5eed";
const T1 = "2026-10-14T12:00:00.000Z";
const T2 = "2026-10-15T12:00:00.000Z";

describe("values", () => {
  test("each recipient opens a value; another key does not", async () => {
    const mini = await newIdentity();
    const mac = await newIdentity();
    const other = await newIdentity();
    const sealed = await sealValue("cf_token", V, T1, [mini.recipient, mac.recipient]);
    expect(sealed.startsWith("-----BEGIN AGE ENCRYPTED FILE-----")).toBe(true);
    expect(sealed).not.toContain(V);
    expect(await openValue(sealed, mini.identity, { name: "cf_token", rotated: T1 })).toBe(V);
    expect(await openValue(sealed, mac.identity, { name: "cf_token", rotated: T1 })).toBe(V);
    await expect(openValue(sealed, other.identity, { name: "cf_token", rotated: T1 })).rejects.toThrow("does not open with this key");
  });

  test("a value moved under another name does not open, and the error holds no value", async () => {
    const mini = await newIdentity();
    const sealed = await sealValue("cf_token", V, T1, [mini.recipient]);
    const err = await openValue(sealed, mini.identity, { name: "github_token", rotated: T1 }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("another name");
    expect((err as Error).message).not.toContain(V);
  });

  test("an older ciphertext put back after a rotation does not open", async () => {
    const mini = await newIdentity();
    const old = await sealValue("cf_token", V, T1, [mini.recipient]);
    await expect(openValue(old, mini.identity, { name: "cf_token", rotated: T2 })).rejects.toThrow("another rotation");
  });

  test("resealing keeps the value and stamp and changes who opens it", async () => {
    const mini = await newIdentity();
    const mac = await newIdentity();
    const sealed = await sealValue("cf_token", V, T1, [mini.recipient]);
    const again = await resealValue(sealed, mini.identity, { name: "cf_token", rotated: T1 }, [mini.recipient, mac.recipient]);
    expect(await openValue(again, mac.identity, { name: "cf_token", rotated: T1 })).toBe(V);
  });

  test("a proposal opens only under its own source and key", async () => {
    const mini = await newIdentity();
    const p = { from: "mac", source: "~/dev/.env", key: "CF" };
    const sealed = await sealProposal(p, V, mini.recipient);
    expect(await openProposal(sealed, mini.identity, p)).toBe(V);
    await expect(openProposal(sealed, mini.identity, { ...p, key: "OTHER" })).rejects.toThrow("another name");
  });
});

describe("identities", () => {
  test("a passphrase-wrapped identity unwraps with the passphrase and only with it", async () => {
    const { identity } = await newIdentity();
    const wrapped = await wrapIdentity(identity, "correct horse", 10);
    expect(wrapped).not.toContain(identity);
    expect(await unwrapIdentity(wrapped, "correct horse")).toBe(identity);
    await expect(unwrapIdentity(wrapped, "wrong horse")).rejects.toThrow("wrong passphrase");
  });

  test("identities are X25519", async () => {
    const { identity, recipient } = await newIdentity();
    expect(identity.startsWith("AGE-SECRET-KEY-1")).toBe(true);
    expect(recipient).toMatch(/^age1[02-9ac-hj-np-z]{58}$/);
  });
});

describe("signing keys", () => {
  test("a new key signs a file its public half verifies", async () => {
    const k = await newSigningKey();
    const f = await signFile(emptyFile({}), await signingKey(k.privateB64), "mini");
    expect(await verifyFile(f, k.publicB64)).toBe(true);
  });
});

test("sameValue compares by content", () => {
  expect(sameValue("abc", "abc")).toBe(true);
  expect(sameValue("abc", "abd")).toBe(false);
  expect(sameValue("abc", "abcd")).toBe(false);
});
