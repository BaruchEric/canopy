/**
 * Web push as RFC 8030, 8291 and 8292 describe it, on Web Crypto alone
 * (FR-042): the VAPID key pair and its ES256 token, the aes128gcm content
 * encoding of a payload, and the request that carries both. Pure over the
 * subscription's keys and the sender's; the key file and the sending are
 * server/push.ts's. Not for the UI: the private half never reaches a page.
 *
 * Web Crypto's ECDSA signature is already the raw r||s form JWS wants, so
 * no DER conversion happens here (node's `crypto.sign` would need one).
 */

/** bytes over their own buffer, what Web Crypto takes */
export type Bytes = Uint8Array<ArrayBuffer>;

/** a JSON Web Key as Web Crypto exports and imports it; the DOM's
 *  `JsonWebKey` is not a global name without that lib */
export interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  ext?: boolean;
  key_ops?: string[];
}

const enc = new TextEncoder();
export const utf8 = (s: string): Bytes => new Uint8Array(enc.encode(s));

export const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function unb64url(s: string): Bytes {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export function concat(...parts: readonly Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** the key pair as the file keeps it: two JWKs */
export interface VapidPair {
  publicKey: Jwk;
  privateKey: Jwk;
}

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

export async function generateVapid(): Promise<VapidPair> {
  const pair = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  return { publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey), privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

/** the 65-byte uncompressed point a browser subscribes with and `k=` carries */
export function rawPublicKey(jwk: Jwk): Bytes {
  if (!jwk.x || !jwk.y) throw new Error("the VAPID key has no public point");
  return concat(new Uint8Array([4]), unb64url(jwk.x), unb64url(jwk.y));
}

/** a raw public point back into the JWK shape `importKey` takes */
export function pointJwk(raw: Uint8Array, d?: string): Jwk {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("a P-256 public key is 65 bytes, uncompressed");
  return { kty: "EC", crv: "P-256", x: b64url(raw.slice(1, 33)), y: b64url(raw.slice(33, 65)), ...(d ? { d } : {}) };
}

/** the push service a subscription lives on, the token's audience */
export const vapidAudience = (endpoint: string): string => new URL(endpoint).origin;

/** a VAPID token's life, 12 hours; the services allow 24 */
export const VAPID_LIFE = 12 * 3600;

export interface VapidClaims {
  aud: string;
  sub: string;
  /** unix seconds */
  exp: number;
}

/** an ES256 JWT over the claims, signed with the private JWK */
export async function vapidToken(privateKey: Jwk, claims: VapidClaims): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", privateKey, ECDSA, false, ["sign"]);
  const head = b64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64url(utf8(JSON.stringify(claims)));
  const signed = `${head}.${body}`;
  const sig = new Uint8Array(await crypto.subtle.sign(SIGN, key, utf8(signed)));
  return `${signed}.${b64url(sig)}`;
}

/** the token's claims and signature checked against the public JWK, as a
 *  push service does; null for one that does not hold */
export async function verifyVapidToken(publicKey: Jwk, token: string): Promise<VapidClaims | null> {
  const [head, body, sig] = token.split(".");
  if (!head || !body || !sig) return null;
  const key = await crypto.subtle.importKey("jwk", publicKey, ECDSA, false, ["verify"]);
  const ok = await crypto.subtle.verify(SIGN, key, unb64url(sig), utf8(`${head}.${body}`));
  if (!ok) return null;
  const claims: unknown = JSON.parse(new TextDecoder().decode(unb64url(body)));
  if (claims === null || typeof claims !== "object") return null;
  const aud = "aud" in claims ? claims.aud : undefined;
  const sub = "sub" in claims ? claims.sub : undefined;
  const exp = "exp" in claims ? claims.exp : undefined;
  return typeof aud === "string" && typeof sub === "string" && typeof exp === "number" ? { aud, sub, exp } : null;
}

async function hkdf(ikm: Bytes, salt: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** the sender's one-time key and salt; tests pass the RFC's, a send draws fresh ones */
export interface Sender {
  privateKey: Jwk;
  /** the 65-byte raw public point */
  publicKey: Bytes;
  /** 16 bytes */
  salt: Bytes;
}

export async function freshSender(): Promise<Sender> {
  const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  return {
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
    publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    salt: crypto.getRandomValues(new Uint8Array(16)),
  };
}

/** the record size the header names; one record holds any payload we send */
const RECORD_SIZE = 4096;

/** RFC 8291: the plaintext as one aes128gcm record, with the header RFC
 *  8188 puts in front (salt, record size, the sender's public key). */
export async function encryptPayload(plaintext: Bytes, keys: { p256dh: string; auth: string }, sender?: Sender): Promise<Bytes> {
  const s = sender ?? (await freshSender());
  const uaPublic = unb64url(keys.p256dh);
  const auth = unb64url(keys.auth);
  if (uaPublic.length !== 65) throw new Error("the subscription's p256dh is not a P-256 point");
  if (auth.length !== 16) throw new Error("the subscription's auth secret is not 16 bytes");
  const asKey = await crypto.subtle.importKey("jwk", s.privateKey, ECDH, false, ["deriveBits"]);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, ECDH, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKey, 256));
  const ikm = await hkdf(ecdh, auth, concat(utf8("WebPush: info\0"), uaPublic, s.publicKey), 32);
  const cek = await hkdf(ikm, s.salt, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, s.salt, utf8("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // the last (and only) record ends in the 0x02 delimiter, no padding after
  const record = concat(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record));
  const rs = new Uint8Array([(RECORD_SIZE >>> 24) & 255, (RECORD_SIZE >>> 16) & 255, (RECORD_SIZE >>> 8) & 255, RECORD_SIZE & 255]);
  return concat(s.salt, rs, new Uint8Array([s.publicKey.length]), s.publicKey, ciphertext);
}

export type PushUrgency = "high" | "normal";

/** what the service answered, in the words the hub acts on */
export type PushOutcome = "sent" | "gone" | "retry" | "too-big" | "failed";

/** 201 (and any 2xx) is sent; 404 and 410 say the subscription is gone;
 *  429 asks for a wait; 413 wants a smaller body; the rest is a failure */
export function outcomeOf(status: number): PushOutcome {
  if (status >= 200 && status < 300) return "sent";
  if (status === 404 || status === 410) return "gone";
  if (status === 429) return "retry";
  if (status === 413) return "too-big";
  return "failed";
}

export interface PushRequest {
  url: string;
  headers: Record<string, string>;
  body: Bytes;
}

/** One push, ready to POST: the VAPID token for the endpoint's origin in
 *  `Authorization`, the payload encrypted to the subscription. `now` is unix
 *  ms. The sender is fresh per push unless a test passes one. */
export async function buildPush(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  vapid: VapidPair & { subject: string },
  opts: { ttl: number; urgency: PushUrgency; now: number; sender?: Sender },
): Promise<PushRequest> {
  const token = await vapidToken(vapid.privateKey, { aud: vapidAudience(sub.endpoint), sub: vapid.subject, exp: Math.floor(opts.now / 1000) + VAPID_LIFE });
  const body = await encryptPayload(utf8(payload), sub.keys, opts.sender);
  return {
    url: sub.endpoint,
    headers: {
      authorization: `vapid t=${token}, k=${b64url(rawPublicKey(vapid.publicKey))}`,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
      ttl: String(opts.ttl),
      urgency: opts.urgency,
    },
    body,
  };
}
