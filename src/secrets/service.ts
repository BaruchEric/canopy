/**
 * The secrets service's requests (src/core/secretwire.ts): info and audit
 * for any caller on the socket, the passkey gate, proposals from the Mac,
 * and the gated acts. The only process on the mini that opens a value. It
 * writes the mini's own sinks after each change and on a timer, never over
 * a drifted key. Errors it returns name secrets and paths, never values.
 */

import { randomBytes } from "node:crypto";
import type { Applied } from "../core/applied";
import { openProposal, openValue, resealValue, sameValue, sealProposal, sealValue } from "../core/secretcrypt";
import { DOTENV_KEY, JSON_PATH, metaList, nowStamp, recipientKeys, recipientsFor, usedBy, type SecretFile, type SinkDef } from "../core/secretfile";
import { formatOf, suggestName, type Found } from "../core/secretimport";
import { LIMITS, PASSKEY, type SecretAct, type SecretsReply, type SecretsRequest } from "../core/secretwire";
import { applyKeys, readKeys } from "../core/sinks";
import { FILE_IO, syncSink, type SinkIO, type SinkState } from "../core/sinksync";
import type { SecretKeyState, SecretProposalIn, SecretsInfo } from "../core/types";
import type { Audit } from "./audit";
import type { Gate } from "./gate";

export interface StoreLike {
  file: SecretFile;
  head: string | null;
  unpushed: number;
  recipient: string;
  identity(): string;
  commit(next: SecretFile, message: string): Promise<void>;
}

export interface ServiceDeps {
  store: StoreLike;
  gate: Gate;
  audit: Audit;
  /** this machine's name in the file */
  machine: string;
  /** the page where gated acts live */
  gateUrl: string;
  /** the only folders this service writes sinks in */
  sinkRoots: readonly string[];
  applied: { read(): Promise<Applied>; write(a: Applied): Promise<void> };
  /** this machine's import sources */
  scan: () => Promise<Found[]>;
  io?: SinkIO;
  now?: () => number;
  log: (line: string) => void;
}

interface Pending {
  id: string;
  p: SecretProposalIn;
  expires: number;
  suggested: string;
  same: string | null;
}

const fail = (error: string): SecretsReply => ({ ok: false, error });
const errText = (err: unknown): string => (err instanceof Error ? err.message : "failed");

/** what an act is about, for the audit line */
function subject(act: SecretAct): string | null {
  switch (act.a) {
    case "reveal":
    case "add":
    case "edit":
    case "rotate":
    case "delete":
    case "allow":
      return act.name;
    case "sink-set":
    case "sink-remove":
    case "passkey-remove":
      return act.id;
    case "sink-write":
    case "take":
      return `${act.id}:${act.key}`;
    case "approve":
      return act.name;
    case "reject":
      return act.proposal;
    case "machine-key":
      return act.machine;
    case "import-scan":
      return null;
  }
}

export class SecretsService {
  private readonly proposals = new Map<string, Pending>();
  private sinkState: Record<string, SinkState> = {};
  private readonly io: SinkIO;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: ServiceDeps) {
    this.io = d.io ?? FILE_IO;
    this.now = d.now ?? Date.now;
  }

  /** one change at a time: two acts would each sign over the other's base */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async handle(req: SecretsRequest): Promise<SecretsReply> {
    try {
      switch (req.t) {
        case "info":
          return { ok: true, data: this.info(req.token) };
        case "audit":
          return { ok: true, data: await this.d.audit.last(req.limit) };
        case "begin":
          return await this.d.gate.begin(req.kind, req.token, req.code);
        case "finish": {
          const r = await this.d.gate.finish(req.kind, req.token, req.code, req.response, req.label);
          await this.d.audit.add({ action: req.kind === "login" ? "login" : "passkey-add", name: null, ok: r.ok, by: req.kind === "register" && r.ok ? req.label || null : null, detail: r.ok ? null : r.error });
          return r;
        }
        case "logout":
          this.d.gate.logout(req.token);
          return { ok: true, data: null };
        case "propose":
          return await this.serial(() => this.propose(req.items));
        case "act":
          return await this.act(req.token, req.act);
      }
    } catch (err) {
      // the message, never a stack: a stack can quote what it failed on
      this.d.log(`secrets: ${req.t} failed: ${errText(err)}`);
      return fail(errText(err));
    }
  }

  private async act(token: string | null, act: SecretAct): Promise<SecretsReply> {
    const s = this.d.gate.session(token);
    if (!s) {
      await this.d.audit.add({ action: act.a, name: subject(act), ok: false, by: null, detail: "no passkey session" });
      return { ok: false, error: "open the passkey gate first", gate: PASSKEY };
    }
    let r: SecretsReply;
    try {
      r = await this.serial(() => this.run(act));
    } catch (err) {
      r = fail(errText(err));
    }
    await this.d.audit.add({ action: act.a, name: subject(act), ok: r.ok, by: s.label, detail: r.ok ? null : r.error });
    return r;
  }

  private async run(act: SecretAct): Promise<SecretsReply> {
    const f = this.d.store.file;
    switch (act.a) {
      case "reveal": {
        const e = f.secrets[act.name];
        if (!e) return fail(`no secret named ${act.name}`);
        const value = await openValue(e.value, this.d.store.identity(), { name: act.name, rotated: e.rotated });
        return { ok: true, data: { value, hideAfterMs: LIMITS.revealHideMs } };
      }
      case "add":
        if (f.secrets[act.name]) return fail(`${act.name} exists; rotate it instead`);
        return this.change(await this.withValue(f, act.name, act.value, { description: act.description, tags: act.tags }), `secrets: add ${act.name}`);
      case "edit": {
        const e = f.secrets[act.name];
        if (!e) return fail(`no secret named ${act.name}`);
        return this.change({ ...f, secrets: { ...f.secrets, [act.name]: { ...e, description: act.description, tags: act.tags } } }, `secrets: describe ${act.name}`);
      }
      case "rotate":
        if (!f.secrets[act.name]) return fail(`no secret named ${act.name}`);
        return this.change(await this.withValue(f, act.name, act.value, null), `secrets: rotate ${act.name}`);
      case "delete": {
        if (!f.secrets[act.name]) return fail(`no secret named ${act.name}`);
        const users = usedBy(f, act.name);
        if (users.length > 0) return fail(`${act.name} is used by ${users.join(", ")}; take it out of those sinks first`);
        const secrets = Object.fromEntries(Object.entries(f.secrets).filter(([n]) => n !== act.name));
        return this.change({ ...f, secrets }, `secrets: delete ${act.name}`);
      }
      case "allow": {
        const e = f.secrets[act.name];
        if (!e) return fail(`no secret named ${act.name}`);
        const still = usedBy(f, act.name).map((id) => `sink:${id}`).filter((a) => !act.allow.includes(a));
        if (still.length > 0) return fail(`${still.join(", ")} still use ${act.name}; take it out of those sinks first`);
        return this.change({ ...f, secrets: { ...f.secrets, [act.name]: { ...e, allow: [...new Set(act.allow)].sort() } } }, `secrets: allowlist ${act.name}`);
      }
      case "sink-set":
        return this.setSink(f, act.id, { machine: act.machine, path: act.path, format: act.format, keys: act.keys }, `secrets: sink ${act.id}`);
      case "sink-remove":
        if (!f.sinks[act.id]) return fail(`no sink named ${act.id}`);
        return this.setSink(f, act.id, null, `secrets: remove sink ${act.id}`);
      case "sink-write":
        return this.forceWrite(act.id, act.key);
      case "take":
        return this.take(act.id, act.key);
      case "import-scan": {
        const found = await this.d.scan();
        const items: SecretProposalIn[] = [];
        for (const x of found) {
          const ref = { from: this.d.machine, source: x.source, key: x.key };
          items.push({ ...ref, sealed: x.value === null ? "" : await sealProposal(ref, x.value, this.d.store.recipient), merges: null });
        }
        return this.propose(items);
      }
      case "approve":
        return this.approve(act);
      case "reject":
        return this.proposals.delete(act.proposal) ? { ok: true, data: null } : fail("no such proposal; it may have expired");
      case "machine-key":
        return this.change({ ...f, keys: { ...f.keys, [act.machine]: act.recipient } }, `secrets: key for ${act.machine}`);
      case "passkey-remove":
        return this.d.gate.remove(act.id);
    }
  }

  /** `name` holding `value`, sealed now; the stamp always moves forward */
  private async withValue(f: SecretFile, name: string, value: string, meta: { description: string; tags: string[] } | null): Promise<SecretFile> {
    const old = f.secrets[name];
    const stamp = nowStamp(Math.max(this.now(), old ? Date.parse(old.rotated) + 1 : 0));
    const to = recipientsFor(f, name);
    const keyed = recipientKeys(f, to);
    if ("missing" in keyed) throw new Error(`${name} needs the ${keyed.missing.join(", ")} key in the file first`);
    return {
      ...f,
      secrets: {
        ...f.secrets,
        [name]: {
          description: meta?.description ?? old?.description ?? "",
          tags: meta?.tags ?? old?.tags ?? [],
          created: old?.created ?? stamp,
          rotated: stamp,
          to,
          allow: old?.allow ?? [],
          value: await sealValue(name, value, stamp, keyed.keys),
        },
      },
    };
  }

  /** every value whose machines, or whose machines' keys, changed, sealed again */
  private async reseal(next: SecretFile): Promise<SecretFile> {
    const before = this.d.store.file;
    const secrets = { ...next.secrets };
    for (const [name, e] of Object.entries(next.secrets)) {
      const want = recipientsFor(next, name);
      const keyed = recipientKeys(next, want);
      if ("missing" in keyed) throw new Error(`${name} would be sealed to ${keyed.missing.join(", ")}, which has no key in the file yet`);
      const same = want.join() === [...e.to].sort().join() && want.every((m) => before.keys[m] === next.keys[m]);
      if (same) continue;
      secrets[name] = { ...e, to: want, value: await resealValue(e.value, this.d.store.identity(), { name, rotated: e.rotated }, keyed.keys) };
    }
    return { ...next, secrets };
  }

  private async change(next: SecretFile, message: string): Promise<SecretsReply> {
    await this.d.store.commit(await this.reseal(next), message);
    await this.syncSinks();
    return { ok: true, data: { head: this.d.store.head } };
  }

  private rootRefusal(path: string): string | null {
    const inside = this.d.sinkRoots.some((r) => path.startsWith(r.endsWith("/") ? r : `${r}/`));
    return inside ? null : `${path} is outside ${this.d.sinkRoots.join(", ")}, the only folders the secrets service writes`;
  }

  private setSink(f: SecretFile, id: string, def: SinkDef | null, message: string): Promise<SecretsReply> {
    if (def) {
      for (const [k, n] of Object.entries(def.keys)) if (!f.secrets[n]) return Promise.resolve(fail(`${k} maps to ${n}, which the store does not hold`));
      if (def.machine === this.d.machine) {
        const refused = this.rootRefusal(def.path);
        if (refused) return Promise.resolve(fail(refused));
      }
      const clash = Object.entries(f.sinks).find(([other, s]) => other !== id && s.machine === def.machine && s.path === def.path);
      if (clash) return Promise.resolve(fail(`sink ${clash[0]} already writes ${def.path} on ${def.machine}`));
    }
    const sinks: Record<string, SinkDef> = Object.fromEntries(Object.entries(f.sinks).filter(([k]) => k !== id));
    if (def) sinks[id] = def;
    const tag = `sink:${id}`;
    const uses = new Set(def ? Object.values(def.keys) : []);
    const secrets = Object.fromEntries(
      Object.entries(f.secrets).map(([n, e]) => {
        const has = e.allow.includes(tag);
        if (uses.has(n) && !has) return [n, { ...e, allow: [...e.allow, tag].sort() }];
        if (!uses.has(n) && has) return [n, { ...e, allow: e.allow.filter((a) => a !== tag) }];
        return [n, e];
      }),
    );
    return this.change({ ...f, sinks, secrets }, message);
  }

  /** the store's value over one drifted key of a sink on this machine */
  private async forceWrite(id: string, key: string): Promise<SecretsReply> {
    const f = this.d.store.file;
    const sink = f.sinks[id];
    const name = sink?.keys[key];
    const e = name ? f.secrets[name] : undefined;
    if (!sink || !name || !e) return fail(`sink ${id} has no key ${key}`);
    if (sink.machine !== this.d.machine) return fail(`sink ${id} lives on ${sink.machine}; its own canopy writes it`);
    const refused = this.rootRefusal(sink.path);
    if (refused) return fail(refused);
    const read = await this.io.read(sink.path);
    if ("error" in read) return fail(read.error);
    const value = await openValue(e.value, this.d.store.identity(), { name, rotated: e.rotated });
    const next = applyKeys(read.text, sink.format, { [key]: value });
    if ("error" in next) return fail(`${sink.path}: ${next.error}`);
    await this.io.write(sink.path, next.text);
    const applied = await this.d.applied.read();
    applied[id] = { ...applied[id], [key]: e.rotated };
    await this.d.applied.write(applied);
    await this.syncSinks();
    return { ok: true, data: null };
  }

  /** one drifted key's file value into the store */
  private async take(id: string, key: string): Promise<SecretsReply> {
    const f = this.d.store.file;
    const sink = f.sinks[id];
    const name = sink?.keys[key];
    if (!sink || !name || !f.secrets[name]) return fail(`sink ${id} has no key ${key}`);
    if (sink.machine !== this.d.machine) return fail(`sink ${id} lives on ${sink.machine}; take it from that machine's page`);
    const read = await this.io.read(sink.path);
    if ("error" in read) return fail(read.error);
    if (read.text === null) return fail(`${sink.path} does not exist`);
    const have = readKeys(read.text, sink.format, [key]);
    if ("error" in have) return fail(`${sink.path}: ${have.error}`);
    const value = have.values[key];
    if (value === undefined || value === "") return fail(`${sink.path} has no ${key}`);
    return this.change(await this.withValue(f, name, value, null), `secrets: take ${name} from sink ${id}`);
  }

  private expire(): void {
    const t = this.now();
    for (const [id, p] of this.proposals) if (p.expires < t) this.proposals.delete(id);
  }

  /** every value this process can open now, labelled, for `same` */
  private async known(): Promise<[string, string][]> {
    const out: [string, string][] = [];
    const id = this.d.store.identity();
    for (const [name, e] of Object.entries(this.d.store.file.secrets)) {
      try {
        out.push([name, await openValue(e.value, id, { name, rotated: e.rotated })]);
      } catch {
        // a value this key cannot open matches nothing
      }
    }
    for (const q of this.proposals.values()) {
      if (!q.p.sealed) continue;
      try {
        out.push([`${q.p.key} from ${q.p.source}`, await openProposal(q.p.sealed, id, q.p)]);
      } catch {
        // dropped at intake already
      }
    }
    return out;
  }

  private async propose(items: SecretProposalIn[]): Promise<SecretsReply> {
    this.expire();
    if (this.proposals.size + items.length > LIMITS.pending) return fail(`at most ${LIMITS.pending} proposals wait at once; approve or reject some first`);
    const id = this.d.store.identity();
    const known = await this.known();
    let added = 0;
    let dropped = 0;
    for (const p of items) {
      for (const [pid, q] of this.proposals) if (q.p.from === p.from && q.p.source === p.source && q.p.key === p.key) this.proposals.delete(pid);
      let value: string | null = null;
      if (p.sealed) {
        try {
          value = await openProposal(p.sealed, id, p);
        } catch {
          dropped += 1;
          continue;
        }
      }
      if (p.merges && !this.d.store.file.secrets[p.merges]) {
        dropped += 1;
        continue;
      }
      const v = value;
      const same = v === null ? null : (known.find(([, k]) => sameValue(k, v))?.[0] ?? null);
      const pid = randomBytes(9).toString("base64url");
      this.proposals.set(pid, { id: pid, p, expires: this.now() + LIMITS.proposalTtlMs, suggested: suggestName(p.source, p.key), same });
      if (v !== null) known.push([`${p.key} from ${p.source}`, v]);
      added += 1;
    }
    return { ok: true, data: { added, dropped } };
  }

  private async approve(act: Extract<SecretAct, { a: "approve" }>): Promise<SecretsReply> {
    this.expire();
    const q = this.proposals.get(act.proposal);
    if (!q) return fail("no such proposal; it may have expired");
    const f = this.d.store.file;
    const ident = this.d.store.identity();
    let value: string;
    if (q.p.sealed) value = await openProposal(q.p.sealed, ident, q.p);
    else if (act.value !== null) value = act.value;
    else return fail("this source can only be listed; type its value to approve it");
    const target = q.p.merges ?? act.name;
    const existing = f.secrets[target];
    let next = f;
    if (q.p.merges) {
      if (!existing) return fail(`${target} is gone`);
      next = await this.withValue(f, target, value, null);
    } else if (existing) {
      const cur = await openValue(existing.value, ident, { name: target, rotated: existing.rotated });
      if (!sameValue(cur, value)) return fail(`${target} exists with another value; pick another name, or rotate it`);
    } else {
      next = await this.withValue(f, target, value, { description: act.description, tags: act.tags });
    }
    if (act.sink) {
      const format = formatOf(q.p.source);
      if (!format) return fail(`${q.p.source} cannot be a sink; only dotenv and json files can`);
      if (!(format === "dotenv" ? DOTENV_KEY : JSON_PATH).test(q.p.key)) return fail(`${q.p.key} cannot be a ${format} sink key`);
      const old = next.sinks[act.sink.id];
      if (old && (old.machine !== q.p.from || old.path !== q.p.source)) return fail(`sink ${act.sink.id} writes another file`);
      const def: SinkDef = { machine: q.p.from, path: q.p.source, format, keys: { ...old?.keys, [q.p.key]: target } };
      const r = await this.setSink(next, act.sink.id, def, `secrets: import ${target} into sink ${act.sink.id}`);
      if (r.ok) this.proposals.delete(q.id);
      return r;
    }
    this.proposals.delete(q.id);
    if (next === f) return { ok: true, data: { head: this.d.store.head } };
    return this.change(next, q.p.merges ? `secrets: take ${target} from ${q.p.from}` : `secrets: import ${target}`);
  }

  /** the timer's sync, queued behind any act in flight */
  tick(): Promise<void> {
    return this.serial(() => this.syncSinks());
  }

  /** Write the sinks this machine owns where the store changed, and read
   *  the rest as same, drift or missing. */
  async syncSinks(): Promise<void> {
    const f = this.d.store.file;
    const applied = await this.d.applied.read();
    const state: Record<string, SinkState> = {};
    for (const [id, sink] of Object.entries(f.sinks)) {
      if (sink.machine !== this.d.machine) continue;
      state[id] = await syncSink(f, id, sink, this.d.store.identity(), applied, this.io, this.rootRefusal(sink.path));
    }
    for (const id of Object.keys(applied)) if (!state[id]) delete applied[id];
    await this.d.applied.write(applied);
    this.sinkState = state;
  }

  info(token: string | null): SecretsInfo {
    this.expire();
    const s = this.d.store;
    const f = s.file;
    return {
      ok: true,
      error: null,
      backend: this.d.machine,
      role: "writer",
      head: s.head,
      refused: null,
      lock: "open",
      secrets: metaList(f),
      sinks: Object.keys(f.sinks)
        .sort()
        .flatMap((id) => {
          const k = f.sinks[id];
          if (!k) return [];
          const own = k.machine === this.d.machine;
          const state: Record<string, SecretKeyState> = own
            ? (this.sinkState[id]?.state ?? {})
            : k.machine === "gpd"
              ? Object.fromEntries(Object.keys(k.keys).map((key) => [key, "phase 3" as const]))
              : {};
          return [{ id, machine: k.machine, path: k.path, format: k.format, keys: { ...k.keys }, state, error: own ? (this.sinkState[id]?.error ?? null) : null }];
        }),
      proposals: [...this.proposals.values()].map((q) => ({
        id: q.id,
        from: q.p.from,
        source: q.p.source,
        key: q.p.key,
        suggested: q.suggested,
        merges: q.p.merges,
        same: q.same,
        namesOnly: q.p.sealed === "",
        expires: q.expires,
      })),
      passkeys: this.d.gate.passkeys(),
      session: this.d.gate.session(token) !== null,
      firstPasskey: this.d.gate.firstPasskey(),
      gate: this.d.gateUrl,
      unpushed: s.unpushed,
    };
  }
}
