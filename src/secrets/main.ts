/**
 * The secrets service (docs/superpowers/specs/2026-10-14-secrets-design.md),
 * bundled to /app/secrets-service.js by the Dockerfile's build stage and run
 * as root in a container of its own. It opens the store and the gate from
 * the secrets-data volume and answers one JSON line per connection on a
 * unix socket whose folder only the secretscaller group (canopy) enters.
 * `--health` asks the running service for its info and exits 0 when it
 * answers. Nothing secret comes in through the environment.
 */

import { chmod, chown, mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname } from "node:path";
import { readApplied, writeApplied } from "../core/applied";
import { AGE_RECIPIENT } from "../core/secretfile";
import { miniSources, scanFiles } from "../core/secretimport";
import { askSecrets } from "../core/secretsclient";
import { encodeLine, LIMITS, parseRequest, type SecretsReply, type SecretsRequest } from "../core/secretwire";
import { Audit } from "./audit";
import { Gate } from "./gate";
import { SecretsService } from "./service";
import { SecretStore, storePaths } from "./store";

/** the break-glass recipient from the spec; its identity is offline */
export const DEFAULT_BREAKGLASS = "age1xtc4cftnu55fn3enurt9jexnrenmru3w0xl93uz5q20e34mefs6stg2vra";

export interface ServiceEnv {
  socket: string;
  callerGid: number;
  data: string;
  remote: string | null;
  origin: string;
  rpID: string;
  gateUrl: string;
  breakglass: string;
  sinkRoots: string[];
  stacks: string;
  extra: string[];
}

const paths = (v: string): string[] => v.split(":").filter(Boolean);

export function serviceEnv(env: Record<string, string | undefined>): ServiceEnv | { refused: string } {
  const gid = env["CANOPY_SECRETS_CALLER_GID"] ?? "";
  if (!/^[1-9]\d{0,9}$/.test(gid)) return { refused: "CANOPY_SECRETS_CALLER_GID must be the group canopy reaches the socket with, set and not 0" };
  const origin = env["CANOPY_SECRETS_ORIGIN"] ?? "https://canopy.beric.ca";
  let rpID: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" || u.origin !== origin) return { refused: "CANOPY_SECRETS_ORIGIN must be an exact https origin" };
    rpID = u.hostname;
  } catch {
    return { refused: "CANOPY_SECRETS_ORIGIN must be an exact https origin" };
  }
  const breakglass = env["CANOPY_SECRETS_BREAKGLASS"] ?? DEFAULT_BREAKGLASS;
  if (!AGE_RECIPIENT.test(breakglass)) return { refused: "CANOPY_SECRETS_BREAKGLASS is not an X25519 age recipient" };
  const sinkRoots = paths(env["CANOPY_SECRETS_SINK_ROOTS"] ?? "/opt/stacks");
  if (sinkRoots.length === 0 || sinkRoots.some((r) => !r.startsWith("/") || r.split("/").includes(".."))) return { refused: "CANOPY_SECRETS_SINK_ROOTS must be absolute folders" };
  return {
    socket: env["CANOPY_SECRETS_SOCKET"] ?? "/run/canopy-secrets/secrets.sock",
    callerGid: Number(gid),
    data: env["CANOPY_SECRETS_DATA"] ?? "/data",
    remote: env["CANOPY_SECRETS_REMOTE"] || null,
    origin,
    rpID,
    gateUrl: `${origin}/?view=secrets`,
    breakglass,
    sinkRoots,
    stacks: env["CANOPY_SECRETS_STACKS"] ?? "/opt/stacks",
    extra: paths(env["CANOPY_SECRETS_IMPORT"] ?? "/import/canopy.env"),
  };
}

/** The socket's folder root:gid 0750 and the socket root:gid 0660, set at
 *  every start (a volume keeps whatever it was first made with). The stage
 *  runner has the same rule; this copy keeps the service's bundle free of
 *  the runner's code. */
export async function socketModes(
  dir: string,
  socket: string | null,
  gid: number,
  fs: { chown: (p: string, uid: number, gid: number) => Promise<void>; chmod: (p: string, mode: number) => Promise<void> } = { chown, chmod },
): Promise<void> {
  await fs.chown(dir, 0, gid);
  await fs.chmod(dir, 0o750);
  if (socket === null) return;
  await fs.chown(socket, 0, gid);
  await fs.chmod(socket, 0o660);
}

/** one request line in, one reply line out, per connection */
export function serve(svc: { handle(r: SecretsRequest): Promise<SecretsReply> }, socket: string): Promise<Server> {
  const server = createServer((conn) => {
    let buf = "";
    let done = false;
    const reply = (r: SecretsReply): void => void conn.end(encodeLine(r));
    conn.setEncoding("utf8");
    conn.setTimeout(30_000, () => conn.destroy());
    conn.on("error", () => {});
    conn.on("data", (chunk: string) => {
      if (done) return;
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1 && buf.length <= LIMITS.line) return;
      done = true;
      if (nl === -1) return reply({ ok: false, error: "the request is too long" });
      const req = parseRequest(buf.slice(0, nl));
      if ("error" in req) return reply({ ok: false, error: req.error });
      svc.handle(req).then(reply, () => reply({ ok: false, error: "failed" }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve(server));
  });
}

async function main(): Promise<void> {
  const env = serviceEnv(process.env);
  if ("refused" in env) {
    console.error(`secrets: ${env.refused}`);
    process.exit(2);
  }
  if (process.argv.includes("--health")) {
    const r = await askSecrets(env.socket, { t: "info", token: null }, 4_000);
    process.exit(r.ok ? 0 : 1);
  }
  const log = (line: string): void => console.log(line);
  if (process.getuid?.() !== 0) log("secrets: not root; sink files keep this user as owner and /opt/stacks may be unreadable");
  const p = storePaths(env.data);
  const store = await SecretStore.open({ data: env.data, remote: env.remote, breakglass: env.breakglass, log });
  const gate = await Gate.open({ file: p.passkeys, rpID: env.rpID, origin: env.origin, log });
  const svc = new SecretsService({
    store,
    gate,
    audit: new Audit(p.audit),
    machine: "mini",
    gateUrl: env.gateUrl,
    sinkRoots: env.sinkRoots,
    applied: { read: () => readApplied(p.applied), write: (a) => writeApplied(p.applied, a) },
    scan: async () => (await scanFiles(await miniSources(env.stacks, env.extra))).found,
    log,
  });
  await svc.tick();
  await mkdir(dirname(env.socket), { recursive: true });
  await rm(env.socket, { force: true });
  await socketModes(dirname(env.socket), null, env.callerGid);
  const server = await serve(svc, env.socket);
  await socketModes(dirname(env.socket), env.socket, env.callerGid);
  log(`secrets: listening on ${env.socket}`);
  const sync = setInterval(() => void svc.tick().catch((err: unknown) => log(`secrets: sink sync failed: ${err instanceof Error ? err.message : "failed"}`)), 60_000);
  const push = setInterval(() => void (store.unpushed > 0 ? store.push() : Promise.resolve()), 5 * 60_000);
  const stop = (): void => {
    clearInterval(sync);
    clearInterval(push);
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    // the message only: a stack can quote what it failed on
    console.error(`secrets: ${err instanceof Error ? err.message : "failed to start"}`);
    process.exit(1);
  });
}
