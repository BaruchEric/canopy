/**
 * The passkey gate, inside the secrets service: WebAuthn registration and
 * login checked against the mini's page origin and rp id, the passkeys
 * file, the first-passkey code, and the sessions a login opens (15 minutes
 * idle, an hour at most). canopy relays the messages and carries the token
 * between its cookie and the socket; it keeps nothing.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { LIMITS, PASSKEY, type GateKind } from "../core/secretwire";
import type { SecretPasskeyInfo } from "../core/types";

export interface Passkey {
  id: string;
  /** base64url */
  publicKey: string;
  counter: number;
  transports: string[];
  label: string;
  created: string;
  lastUsed: string | null;
}

export interface WebAuthn {
  genReg: typeof generateRegistrationOptions;
  verifyReg: typeof verifyRegistrationResponse;
  genAuth: typeof generateAuthenticationOptions;
  verifyAuth: typeof verifyAuthenticationResponse;
}

export const REAL_WEBAUTHN: WebAuthn = {
  genReg: generateRegistrationOptions,
  verifyReg: verifyRegistrationResponse,
  genAuth: generateAuthenticationOptions,
  verifyAuth: verifyAuthenticationResponse,
};

export interface GateOptions {
  file: string;
  rpID: string;
  origin: string;
  log: (line: string) => void;
  now?: () => number;
  wa?: WebAuthn;
}

export type GateResult = { ok: true; data: unknown } | { ok: false; error: string; gate?: typeof PASSKEY };

interface Session {
  label: string;
  opened: number;
  seen: number;
}

const CHALLENGE_MS = 2 * 60_000;
const WRONG_CODES = 5;
const closed: GateResult = { ok: false, error: "open the passkey gate first", gate: PASSKEY };

export class Gate {
  private keys: Passkey[] = [];
  private readonly sessions = new Map<string, Session>();
  private readonly challenges = new Map<GateKind, { value: string; until: number }>();
  private code: string | null = null;
  private wrong = 0;
  private readonly now: () => number;
  private readonly wa: WebAuthn;

  private constructor(private readonly opts: GateOptions) {
    this.now = opts.now ?? Date.now;
    this.wa = opts.wa ?? REAL_WEBAUTHN;
  }

  static async open(opts: GateOptions): Promise<Gate> {
    const g = new Gate(opts);
    try {
      const v: unknown = JSON.parse(await readFile(opts.file, "utf8"));
      if (Array.isArray(v)) g.keys = v as Passkey[];
    } catch {
      // no passkeys yet
    }
    if (g.keys.length === 0) g.newCode();
    return g;
  }

  /** the one-time code for the first passkey, to this process's stdout only */
  private newCode(): void {
    this.code = randomBytes(5).toString("hex");
    this.wrong = 0;
    this.opts.log(`secrets: no passkey yet; first passkey code ${this.code} (enter it on the Secrets view of ${this.opts.origin})`);
  }

  firstPasskey(): boolean {
    return this.keys.length === 0;
  }

  /** the open session for `token`, touched; null when there is none */
  session(token: string | null): Session | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    const t = this.now();
    if (t - s.seen > LIMITS.idleMs || t - s.opened > LIMITS.maxMs) {
      this.sessions.delete(token);
      return null;
    }
    s.seen = t;
    return s;
  }

  /** who may register: anyone holding a session, or the first-code holder */
  private mayRegister(token: string | null, code: string | null): GateResult | null {
    if (this.session(token)) return null;
    if (this.keys.length > 0 || this.code === null) return closed;
    const a = Buffer.from(code ?? "");
    const b = Buffer.from(this.code);
    if (a.length === b.length && timingSafeEqual(a, b)) return null;
    this.wrong += 1;
    if (this.wrong >= WRONG_CODES) this.newCode();
    return { ok: false, error: "the first-passkey code does not match" };
  }

  async begin(kind: GateKind, token: string | null, code: string | null): Promise<GateResult> {
    let options: { challenge: string };
    if (kind === "register") {
      const refused = this.mayRegister(token, code);
      if (refused) return refused;
      options = await this.wa.genReg({
        rpName: "canopy secrets",
        rpID: this.opts.rpID,
        userName: "eric",
        userID: new TextEncoder().encode("canopy-secrets"),
        attestationType: "none",
        excludeCredentials: this.keys.map((k) => ({ id: k.id })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      });
    } else {
      if (this.keys.length === 0) return { ok: false, error: "no passkey yet; register the first one with the printed code" };
      options = await this.wa.genAuth({ rpID: this.opts.rpID, allowCredentials: this.keys.map((k) => ({ id: k.id })), userVerification: "required" });
    }
    this.challenges.set(kind, { value: options.challenge, until: this.now() + CHALLENGE_MS });
    return { ok: true, data: options };
  }

  async finish(kind: GateKind, token: string | null, code: string | null, response: unknown, label: string): Promise<GateResult> {
    const ch = this.challenges.get(kind);
    this.challenges.delete(kind);
    if (!ch || ch.until < this.now()) return { ok: false, error: "start the passkey prompt again" };
    const common = { expectedChallenge: ch.value, expectedOrigin: this.opts.origin, expectedRPID: this.opts.rpID, requireUserVerification: true };
    if (kind === "register") {
      const refused = this.mayRegister(token, code);
      if (refused) return refused;
      try {
        const r = await this.wa.verifyReg({ response: response as RegistrationResponseJSON, ...common });
        if (!r.verified || !r.registrationInfo) return { ok: false, error: "the passkey did not verify" };
        const c = r.registrationInfo.credential;
        this.keys.push({
          id: c.id,
          publicKey: Buffer.from(c.publicKey).toString("base64url"),
          counter: c.counter,
          transports: c.transports ?? [],
          label: label.trim() || `passkey ${this.keys.length + 1}`,
          created: new Date(this.now()).toISOString(),
          lastUsed: null,
        });
        this.code = null;
        await this.save();
        return { ok: true, data: { registered: true } };
      } catch {
        return { ok: false, error: "the passkey did not verify" };
      }
    }
    const id = typeof response === "object" && response !== null ? (response as { id?: unknown }).id : undefined;
    const key = this.keys.find((k) => k.id === id);
    if (!key) return { ok: false, error: "that passkey is not registered here" };
    try {
      const r = await this.wa.verifyAuth({
        response: response as AuthenticationResponseJSON,
        ...common,
        credential: { id: key.id, publicKey: new Uint8Array(Buffer.from(key.publicKey, "base64url")), counter: key.counter, transports: key.transports },
      });
      if (!r.verified) return { ok: false, error: "the passkey did not verify" };
      key.counter = r.authenticationInfo.newCounter;
      key.lastUsed = new Date(this.now()).toISOString();
      await this.save();
    } catch {
      return { ok: false, error: "the passkey did not verify" };
    }
    const t = this.now();
    const session = randomBytes(32).toString("base64url");
    this.sessions.set(session, { label: key.label, opened: t, seen: t });
    return { ok: true, data: { token: session, maxAgeS: LIMITS.maxMs / 1000 } };
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }

  passkeys(): SecretPasskeyInfo[] {
    return this.keys.map((k) => ({ id: k.id, label: k.label, created: k.created, lastUsed: k.lastUsed }));
  }

  async remove(id: string): Promise<GateResult> {
    if (!this.keys.some((k) => k.id === id)) return { ok: false, error: "no such passkey" };
    if (this.keys.length === 1) return { ok: false, error: "keep at least one passkey; register another first" };
    this.keys = this.keys.filter((k) => k.id !== id);
    await this.save();
    return { ok: true, data: { removed: id } };
  }

  private async save(): Promise<void> {
    const tmp = `${this.opts.file}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(this.keys, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.opts.file);
  }
}
