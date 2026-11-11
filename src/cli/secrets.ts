/**
 * `canopy secrets`: the list, the status, unlocking this machine's key,
 * sending chosen values of this machine's files to the store for approval,
 * pinning the mini's signing key, and the break-glass recovery. There is no
 * `get`: a value leaves the store through the mini's page or a sink. The
 * lines, the propose and the recovery are pure enough to test
 * (secrets.test.ts).
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { newIdentity, newSigningKey, openValue, sealValue, signingKey } from "../core/secretcrypt";
import { parseSecretFile, recipientKeys, recipientsFor, serializeFile, signFile, type SecretFile } from "../core/secretfile";
import { localPaths, PIN, readLocalConfig, writeLocalConfig } from "../core/secretlocal";
import { LIMITS, skippedWords } from "../core/secretwire";
import type { BackendEntry, SecretProposalIn, SecretsInfo } from "../core/types";
import { apiBase, callerHeaders } from "./api";
import { ask as askAt, targetsOf, type Target } from "./health";
import { bold, dim, lichen, rust } from "./render";

export const SECRETS_USAGE = `usage: canopy secrets [list] [--json]
       canopy secrets status [--json]
       canopy secrets unlock
       canopy secrets propose (--match TEXT... | --all) [--to NAME] [--dry-run] [--json]
       canopy secrets pin <signing key> [--remote URL]
       canopy secrets recover <checkout> --breakglass FILE --out DIR
  list, status, unlock and propose speak to the home backend ($CANOPY_API, else 127.0.0.1:7850);
  unlock only from the machine itself
  propose scans this machine's import sources and sends the values whose key or file holds TEXT
  (any case, any of several --match) to the store's writer, each sealed to the mini's key; they wait
  there for an approval on its gate page. --all sends every value found, --dry-run sends none,
  --to names the writer among the backends the home one lists. It prints names, never a value
  pin keeps the mini's public signing key (and Forgejo's URL) in this machine's canopy config
  recover opens every value with the break-glass identity, puts a new mini key and signing key in DIR,
  reseals and signs secrets.json in the checkout, and prints the new public halves; it commits nothing
  there is no get: a value leaves the store through the mini's page or a sink`;

export function listLines(info: SecretsInfo): string[] {
  if (!info.ok) return [rust(`secrets: ${info.error ?? "unavailable"}`)];
  if (info.secrets.length === 0) return [dim("no secrets yet")];
  const w = Math.max(...info.secrets.map((s) => s.name.length));
  return info.secrets.map((s) => {
    const tags = s.tags.map((t) => `#${t}`).join(" ");
    const users = s.usedBy.length > 0 ? `  ${dim(`into ${s.usedBy.join(", ")}`)}` : "";
    const about = s.description ? `  ${dim(s.description)}` : "";
    return `${bold(s.name.padEnd(w))}  ${dim(s.rotated.slice(0, 10))}  ${tags}${users}${about}`;
  });
}

const LOCK_WORD: Record<SecretsInfo["lock"], string> = {
  open: "this machine's key is open",
  locked: "this machine's key is locked: run canopy secrets unlock",
  none: "no key on this machine",
};

export function statusLines(info: SecretsInfo): string[] {
  const out = [`${bold(info.backend)}: ${info.role === "writer" ? "the writer" : "a verified copy"}, commit ${info.head ?? "none"}`];
  if (info.error) out.push(rust(info.error));
  if (info.refused) out.push(rust(`refused: ${info.refused}`));
  out.push(info.lock === "open" && info.recipient ? `${LOCK_WORD.open}, recipient ${info.recipient}` : LOCK_WORD[info.lock]);
  if (info.unpushed > 0) out.push(lichen(`${info.unpushed} commit${info.unpushed === 1 ? "" : "s"} waiting for Forgejo`));
  if (info.firstPasskey) out.push(lichen("no passkey yet: the first-passkey code is in the secrets service's log"));
  for (const s of info.sinks) {
    const keys = Object.entries(s.state);
    if (keys.length === 0 && !s.error) continue;
    const words = keys.map(([k, st]) => (st === "drift" ? rust(`${k} drift`) : `${k} ${st}`)).join(", ");
    out.push(`sink ${s.id} (${s.machine}) ${dim(s.path)}: ${words}${s.error ? ` ${rust(s.error)}` : ""}`);
  }
  if (info.proposals.length > 0) out.push(`${info.proposals.length} import proposal${info.proposals.length === 1 ? "" : "s"} waiting on ${info.gate}`);
  return out;
}

export const statusExit = (info: SecretsInfo): number =>
  !info.ok || info.refused !== null || info.sinks.some((s) => s.error !== null || Object.values(s.state).includes("drift")) ? 1 : 0;

/** the AGE-SECRET-KEY line of an age identity file */
export function breakglassIdentity(text: string): string | null {
  return text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("AGE-SECRET-KEY-1")) ?? null;
}

/** Every value opened with the break-glass identity and sealed again under
 *  a new mini key, the file signed by a new signing key. The old signature
 *  is not checked: a recovery is for when that key is gone. */
export async function recoverFile(
  text: string,
  breakglass: string,
): Promise<{ file: SecretFile; identity: string; recipient: string; signing: { privateB64: string; publicB64: string } } | { error: string }> {
  const parsed = parseSecretFile(text);
  if ("error" in parsed) return parsed;
  const mini = await newIdentity();
  const signing = await newSigningKey();
  const next: SecretFile = { ...parsed.file, seq: parsed.file.seq + 1, keys: { ...parsed.file.keys, mini: mini.recipient }, secrets: { ...parsed.file.secrets }, signature: null };
  for (const [name, e] of Object.entries(parsed.file.secrets)) {
    let value: string;
    try {
      value = await openValue(e.value, breakglass, { name, rotated: e.rotated });
    } catch (err) {
      return { error: err instanceof Error ? err.message : `${name} does not open` };
    }
    const to = recipientsFor(next, name);
    const keyed = recipientKeys(next, to);
    if ("missing" in keyed) return { error: `${name} needs the ${keyed.missing.join(", ")} key in the file` };
    next.secrets[name] = { ...e, to, value: await sealValue(name, value, e.rotated, keyed.keys) };
  }
  return { file: await signFile(next, await signingKey(signing.privateB64), "mini"), identity: mini.identity, recipient: mini.recipient, signing };
}

/** a line from the terminal with no echo, or stdin's first line when piped */
async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ((await Bun.stdin.text()).split("\n")[0] ?? "").replace(/\r$/, "");
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          done();
          resolve(buf);
          return;
        }
        if (c === "\u0003") {
          done();
          reject(new Error("cancelled"));
          return;
        }
        buf = c === "\u007f" || c === "\b" ? buf.slice(0, -1) : buf + c;
      }
    };
    stdin.on("data", onData);
  });
}

function take(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
}

export interface ProposeArgs {
  /** texts a key or a file's path may hold, in any case */
  match: string[];
  all: boolean;
  /** the writer's name in the home backend's list */
  to: string | null;
  dry: boolean;
}

/** `propose`'s flags, or what is wrong with them */
export function parsePropose(flags: readonly string[]): ProposeArgs | string {
  const args = [...flags];
  const match: string[] = [];
  while (args.includes("--match")) {
    const text = take(args, "--match");
    if (!text || text.startsWith("--")) return "--match needs a text";
    match.push(text);
  }
  const flag = (name: string): boolean => {
    const i = args.indexOf(name);
    if (i !== -1) args.splice(i, 1);
    return i !== -1;
  };
  const all = flag("--all");
  const dry = flag("--dry-run");
  const hasTo = args.includes("--to");
  const to = take(args, "--to") ?? null;
  if (hasTo && (!to || to.startsWith("--"))) return "--to needs a backend's name";
  if (args.length > 0) return `not understood: ${args.join(" ")}`;
  if (all === (match.length > 0)) return "name what to send: --match TEXT (as often as needed), or --all for every value found";
  return { match, all, to, dry };
}

/** the scanned values a propose keeps: all of them, or those whose key or file holds one of the texts */
export function pickProposals(items: readonly SecretProposalIn[], o: Pick<ProposeArgs, "match" | "all">): SecretProposalIn[] {
  if (o.all) return [...items];
  const want = o.match.map((t) => t.toLowerCase());
  return items.filter((p) => want.some((t) => p.key.toLowerCase().includes(t) || p.source.toLowerCase().includes(t)));
}

interface ScanAnswer {
  items: SecretProposalIn[];
  missing: string[];
  left?: number;
  skipped?: { path: string; lines: number[] }[];
}

export interface ProposeDeps {
  /** the home backend's address, as the CLI reached it */
  homeUrl: string;
  /** one call to the home backend; it fails the command on a refusal */
  home: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  /** one call to another backend the home one lists */
  at: <T>(t: Target, method: string, path: string, body?: unknown) => Promise<T>;
  print: (line: string) => void;
  fail: (msg: string) => never;
}

/** Scan the home backend's sources, keep what was asked for, and post it
 *  to the writer a batch at a time. Every line it prints is a name, a count
 *  or an address: the sealed values go from one answer into the next
 *  request and nowhere else. Returns the exit code. */
export async function propose(o: ProposeArgs, asJson: boolean, d: ProposeDeps): Promise<number> {
  const mine = await d.home<SecretsInfo>("GET", "/api/secrets");
  if (mine.role === "writer") return d.fail(`${mine.backend} is the store's writer: it scans its own sources from the gate page, ${mine.gate}`);
  const scan = await d.home<ScanAnswer>("POST", "/api/secrets/scan", {});
  const picked = pickProposals(scan.items, o);
  const names = picked.map((p) => ({ from: p.from, source: p.source, key: p.key, partial: p.partial === true }));
  const notes = [
    ...(scan.skipped ?? []).map(skippedWords),
    ...(scan.missing.length > 0 ? [`not on this machine: ${scan.missing.join(", ")}`] : []),
    ...((scan.left ?? 0) > 0 ? [`${scan.left} more values did not fit in one scan; approve or reject what waits, then scan again`] : []),
  ];
  const say = (sent: { writer: string; added: number; dropped: number } | null): void => {
    if (asJson) return d.print(JSON.stringify({ found: scan.items.length, picked: names, sent, notes }, null, 2));
    for (const n of names) d.print(`${dim(n.source)}  ${bold(n.key)}`);
    for (const n of notes) d.print(lichen(n));
  };
  if (picked.length === 0) {
    say(null);
    if (!asJson) d.print(`nothing to send: ${scan.items.length} value${scan.items.length === 1 ? "" : "s"} found, none ${o.all ? "at all" : `with ${o.match.join(" or ")} in its key or file`}`);
    return 1;
  }
  if (o.dry) {
    say(null);
    if (!asJson) d.print(`${picked.length} of ${scan.items.length} would be sent; nothing was`);
    return 0;
  }
  const listed = await d.home<{ self?: string; backends?: BackendEntry[] }>("GET", "/api/backends");
  const others = targetsOf(d.homeUrl, listed.self ?? mine.backend, listed.backends ?? []).slice(1);
  let writer: Target | undefined;
  if (o.to !== null) {
    writer = others.find((t) => t.name === o.to);
    if (!writer) return d.fail(`no backend named ${o.to}; the home backend lists ${others.map((t) => t.name).join(", ") || "none"}`);
  } else {
    for (const t of others) {
      const info = await d.at<SecretsInfo>(t, "GET", "/api/secrets").catch(() => null);
      if (info?.role !== "writer") continue;
      writer = t;
      break;
    }
    if (!writer) return d.fail(`none of ${others.map((t) => t.name).join(", ") || "the backends the home one lists"} answered as the store's writer; name it with --to`);
  }
  const sent = { writer: writer.name, added: 0, dropped: 0 };
  // the store takes a batch at a time and refuses a longer one whole
  for (let i = 0; i < picked.length; i += LIMITS.proposals) {
    const r = await d.at<{ added: number; dropped: number }>(writer, "POST", "/api/secrets/proposals", { items: picked.slice(i, i + LIMITS.proposals) });
    sent.added += r.added;
    sent.dropped += r.dropped;
  }
  say(sent);
  if (!asJson) {
    d.print(`${picked.length} sent to ${writer.name}: ${sent.added} waiting for approval${sent.dropped > 0 ? `, ${sent.dropped} dropped` : ""}`);
    d.print(`approve them under import at ${mine.gate}; they wait a day`);
  }
  return sent.dropped > 0 ? 1 : 0;
}

export interface SecretsDeps {
  fail: (msg: string) => never;
}

export async function secretsCommand(argv: string[], { fail }: SecretsDeps): Promise<void> {
  const args = [...argv];
  const home = apiBase();
  const asJson = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const sub = rest[0] ?? "list";
  const ask = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let r: Response;
    try {
      r = await fetch(home + path, { method, redirect: "manual", headers: callerHeaders(home, undefined, body === undefined ? undefined : { "content-type": "application/json" }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      return fail(`${home} did not answer`);
    }
    const text = await r.text();
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      return fail(`${home} answered ${r.status} with something other than JSON`);
    }
    if (!r.ok) return fail((v as { error?: string }).error ?? `${home} answered ${r.status}`);
    return v as T;
  };

  switch (sub) {
    case "list":
    case "status": {
      const info = await ask<SecretsInfo>("GET", "/api/secrets");
      if (asJson) console.log(JSON.stringify(sub === "list" ? info.secrets : info, null, 2));
      else console.log((sub === "list" ? listLines(info) : statusLines(info)).join("\n"));
      if (sub === "status") process.exitCode = statusExit(info);
      return;
    }
    case "unlock": {
      const pass = await readHidden("passphrase for this machine's secrets key: ");
      await ask("POST", "/api/secrets/unlock", { passphrase: pass });
      console.log("unlocked; this machine's sinks are written now");
      return;
    }
    case "propose": {
      const o = parsePropose(rest.slice(1));
      if (typeof o === "string") return fail(`${o}\n${SECRETS_USAGE}`);
      process.exitCode = await propose(o, asJson, { homeUrl: home, home: ask, at: askAt, print: (line) => console.log(line), fail });
      return;
    }
    case "pin": {
      const key = rest[1];
      if (!key || !PIN.test(key)) return fail("the signing key is the 44-character base64 key the secrets service prints at its start");
      const remote = take(rest, "--remote");
      const p = localPaths();
      await mkdir(dirname(p.config), { recursive: true });
      const cur = await readLocalConfig(p.config);
      await writeLocalConfig(p.config, { pin: key, remote: remote ?? cur.remote });
      console.log(`pinned the mini's signing key; Forgejo: ${remote ?? cur.remote ?? "not set, add --remote URL"}`);
      // a pull now, when the home backend runs; the pin stands either way
      const info = await fetch(`${home}/api/secrets/pull`, { method: "POST", redirect: "manual", headers: callerHeaders(home) })
        .then((r) => (r.ok ? (r.json() as Promise<SecretsInfo>) : null))
        .catch(() => null);
      if (info) console.log(statusLines(info).join("\n"));
      return;
    }
    case "recover": {
      const checkout = rest[1];
      const bgFile = take(rest, "--breakglass");
      const out = take(rest, "--out");
      if (!checkout || !bgFile || !out) return fail(SECRETS_USAGE);
      const identity = breakglassIdentity(await readFile(bgFile, "utf8"));
      if (!identity) return fail(`${bgFile} holds no AGE-SECRET-KEY line`);
      const r = await recoverFile(await readFile(join(checkout, "secrets.json"), "utf8"), identity);
      if ("error" in r) return fail(`recovery stopped: ${r.error}`);
      await mkdir(out, { recursive: true, mode: 0o700 });
      for (const [name, text, mode] of [
        ["mini.age", `${r.identity}\n`, 0o400],
        ["signing.key", `${r.signing.privateB64}\n`, 0o400],
        ["signing.pub", `${r.signing.publicB64}\n`, 0o444],
      ] as const) {
        await writeFile(join(out, name), text, { mode, flag: "wx" });
        await chmod(join(out, name), mode);
      }
      await writeFile(join(checkout, "secrets.json"), serializeFile(r.file));
      console.log(
        [
          `new mini recipient   ${r.recipient}`,
          `new signing key      ${r.signing.publicB64}`,
          "",
          "next:",
          `  1. put ${out}/mini.age, signing.key and signing.pub in the secrets-data volume's keys/ folder, replacing the old ones`,
          `  2. commit and push ${checkout}/secrets.json to eric/secrets from this machine`,
          "  3. restart the secrets service; it fast-forwards to that commit",
          `  4. on every other backend: canopy secrets pin ${r.signing.publicB64}`,
          "  5. if the volume was lost, the service prints a first-passkey code: register a passkey again",
          `  6. delete ${out} once the files are in place`,
        ].join("\n"),
      );
      return;
    }
    default:
      return fail(SECRETS_USAGE);
  }
}
