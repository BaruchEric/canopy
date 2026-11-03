import { describe, expect, test } from "bun:test";
import { b64url, buildPush, encryptPayload, generateVapid, outcomeOf, pointJwk, rawPublicKey, unb64url, utf8, vapidAudience, vapidToken, verifyVapidToken, type Sender } from "./webpush";

/** RFC 8291, section 5 and appendix A: the published example. */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const rfcSender = (): Sender => {
  const publicKey = unb64url(RFC.asPublic);
  return { privateKey: pointJwk(publicKey, RFC.asPrivate), publicKey, salt: unb64url(RFC.salt) };
};

describe("base64url", () => {
  test("round-trips without padding", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const s = b64url(bytes);
    expect(s).not.toContain("=");
    expect(s).not.toMatch(/[+/]/);
    expect([...unb64url(s)]).toEqual([...bytes]);
  });
});

describe("aes128gcm", () => {
  test("the RFC 8291 example encrypts to the published body", async () => {
    const body = await encryptPayload(utf8(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, rfcSender());
    expect(body.length).toBe(144);
    expect(b64url(body)).toBe(RFC.body);
  });

  test("a fresh sender gives a different body every time, with the same header shape", async () => {
    const keys = { p256dh: RFC.uaPublic, auth: RFC.auth };
    const a = await encryptPayload(utf8("hi"), keys);
    const b = await encryptPayload(utf8("hi"), keys);
    expect(b64url(a)).not.toBe(b64url(b));
    // salt(16) rs(4) idlen(1) key(65) then ciphertext: 2 bytes, the delimiter, the 16-byte tag
    expect(a.length).toBe(16 + 4 + 1 + 65 + 3 + 16);
    expect(Array.from(a.slice(16, 21))).toEqual([0, 0, 16, 0, 65]);
  });

  test("a subscription with a bad key is refused before anything is derived", async () => {
    await expect(encryptPayload(new Uint8Array(1), { p256dh: "AAAA", auth: RFC.auth })).rejects.toThrow("p256dh");
    await expect(encryptPayload(new Uint8Array(1), { p256dh: RFC.uaPublic, auth: "AAAA" })).rejects.toThrow("auth");
  });
});

describe("VAPID", () => {
  test("a generated pair signs a token the public half verifies, in raw r||s form", async () => {
    const pair = await generateVapid();
    const claims = { aud: "https://fcm.googleapis.com", sub: "mailto:canopy@localhost", exp: 1_800_000_000 };
    const token = await vapidToken(pair.privateKey, claims);
    const [head, body, sig] = token.split(".");
    expect(JSON.parse(new TextDecoder().decode(unb64url(head ?? "")))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(new TextDecoder().decode(unb64url(body ?? "")))).toEqual(claims);
    expect(unb64url(sig ?? "").length).toBe(64);
    expect(await verifyVapidToken(pair.publicKey, token)).toEqual(claims);
    const other = await generateVapid();
    expect(await verifyVapidToken(other.publicKey, token)).toBeNull();
  });

  test("the raw public key is the uncompressed point and maps back to the JWK", async () => {
    const pair = await generateVapid();
    const raw = rawPublicKey(pair.publicKey);
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(4);
    const back = pointJwk(raw);
    expect(back.x).toBe(pair.publicKey.x);
    expect(back.y).toBe(pair.publicKey.y);
  });

  test("the audience is the endpoint's origin", () => {
    expect(vapidAudience("https://fcm.googleapis.com/fcm/send/abc:def")).toBe("https://fcm.googleapis.com");
  });
});

describe("buildPush", () => {
  test("carries the vapid authorization, aes128gcm and no Crypto-Key header", async () => {
    const pair = await generateVapid();
    const req = await buildPush({ endpoint: "https://push.example.net/push/abc", keys: { p256dh: RFC.uaPublic, auth: RFC.auth } }, JSON.stringify({ key: "x" }), { ...pair, subject: "mailto:a@b" }, { ttl: 3600, urgency: "high", now: 1_700_000_000_000, sender: rfcSender() });
    expect(req.url).toBe("https://push.example.net/push/abc");
    expect(req.headers["content-encoding"]).toBe("aes128gcm");
    expect(req.headers["content-type"]).toBe("application/octet-stream");
    expect(req.headers["ttl"]).toBe("3600");
    expect(req.headers["urgency"]).toBe("high");
    expect(req.headers["content-length"]).toBe(String(req.body.length));
    expect(Object.keys(req.headers)).not.toContain("crypto-key");
    const auth = req.headers["authorization"] ?? "";
    const m = /^vapid t=([^,]+), k=(\S+)$/.exec(auth);
    expect(m).not.toBeNull();
    expect(m?.[2]).toBe(b64url(rawPublicKey(pair.publicKey)));
    const claims = await verifyVapidToken(pair.publicKey, m?.[1] ?? "");
    expect(claims?.aud).toBe("https://push.example.net");
    expect(claims?.sub).toBe("mailto:a@b");
    expect(claims?.exp).toBe(1_700_000_000 + 12 * 3600);
  });
});

describe("outcomeOf", () => {
  test("names each status the hub acts on", () => {
    expect(outcomeOf(201)).toBe("sent");
    expect(outcomeOf(200)).toBe("sent");
    expect(outcomeOf(404)).toBe("gone");
    expect(outcomeOf(410)).toBe("gone");
    expect(outcomeOf(429)).toBe("retry");
    expect(outcomeOf(413)).toBe("too-big");
    expect(outcomeOf(500)).toBe("failed");
    expect(outcomeOf(400)).toBe("failed");
  });
});
