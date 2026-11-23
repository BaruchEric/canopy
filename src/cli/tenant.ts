/* `canopy tenant` (FR-074, plan 3): a canopy of its own on this host for a
   group that must not reach another's files. Run on the host itself, never
   inside canopy's container. On a Mac it is a launchd agent, which keeps the
   tenant's people, callers and state apart but runs as your own OS user, so
   its agents can read your files. On Linux it is a compose project
   (docker-compose.tenant.yml) that mounts only the tenant's folder and a home
   of its own, which is the wall. Either way this machine's own backend
   registry names it, so the page you already open here shows it. The pure
   half (names, ports, the files written, the registry) is core/tenant.ts. */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, saveConfig, configDir } from "../core/store";
import {
  composeEnv,
  composeProject,
  envRefusal,
  firstCodeIn,
  freePort,
  inTenantRange,
  launchdPlist,
  launchLabel,
  parseTenant,
  registryRefusal,
  tenantNameRefusal,
  tenantOrigins,
  withoutTenant,
  withTenant,
  type Tenant,
  type TenantHost,
} from "../core/tenant";

export const TENANT_USAGE = [
  "usage: canopy tenant add <name> --root <dir> [--port 7880-7899] [--origins <origin,...>] [--url <address the page dials>] [--dry-run]",
  "       canopy tenant list",
  "       canopy tenant up <name>",
  "       canopy tenant remove <name> [--purge]",
].join("\n");

type Fail = (msg: string) => never;

/** this checkout, where docker-compose.tenant.yml and bin/canopy.ts live */
const REPO = resolve(import.meta.dir, "..", "..");

/** where a tenant's own files sit on this host */
const stateRoot = (host: TenantHost): string => (host === "launchd" ? join(configDir(), "tenants") : join(homedir(), ".local", "share", "canopy-tenants"));
const stateDir = (host: TenantHost, name: string): string => join(stateRoot(host), name);
const plistPath = (name: string): string => join(homedir(), "Library", "LaunchAgents", `${launchLabel(name)}.plist`);

/** the main stack's container, whose config holds this host's registry */
const MAIN_CONTAINER = "canopy-canopy-1";

function take(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, v === undefined ? 1 : 2);
  return v;
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function run(cmd: string[], opts: { cwd?: string } = {}): { ok: boolean; out: string } {
  const p = Bun.spawnSync(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
}

const has = (bin: string): boolean => Bun.which(bin) !== null;

/** whether this process runs inside a container, where a tenant cannot be made */
const inContainer = (): boolean => existsSync("/.dockerenv") || existsSync("/run/.containerenv");

/** which kind of tenant this host makes, or why it makes none */
function hostKind(fail: Fail): TenantHost {
  if (inContainer()) return fail("canopy tenant runs on the host, not inside canopy's container: ssh to the host and run it there");
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux" && has("docker")) return "compose";
  return fail("a tenant needs launchd (a Mac) or docker (Linux) on this host");
}

/** the TCP ports something listens on here */
function listening(): Set<number> {
  const out = new Set<number>();
  const r = process.platform === "darwin" ? run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"]) : run(["ss", "-ltnH"]);
  for (const m of r.out.matchAll(/:(\d+)(?:\s|$)/g)) out.add(Number(m[1]));
  return out;
}

/** this host's MagicDNS name, or null off the tailnet */
function tailnetName(): string | null {
  if (!has("tailscale")) return null;
  const r = run(["tailscale", "status", "--json"]);
  if (!r.ok) return null;
  try {
    const parsed: unknown = JSON.parse(r.out);
    const self: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "Self") : null;
    const dns: unknown = typeof self === "object" && self !== null ? Reflect.get(self, "DNSName") : null;
    return typeof dns === "string" && dns !== "" ? dns.replace(/\.$/, "") : null;
  } catch {
    return null;
  }
}

/** whether this host lets us change tailscale serve without a password */
const canServe = (): boolean => has("tailscale") && has("sudo") && run(["sudo", "-n", "true"]).ok;

/** a .env's plain KEY=value lines, quotes taken off */
function readEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m?.[1]) continue;
    out[m[1]] = (m[2] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** every tenant this host keeps, of either kind */
function tenants(): Tenant[] {
  const out: Tenant[] = [];
  for (const host of ["launchd", "compose"] as const) {
    const dir = stateRoot(host);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, "tenant.json");
      if (!existsSync(file)) continue;
      try {
        const t = parseTenant(JSON.parse(readFileSync(file, "utf8")));
        if (t) out.push(t);
      } catch {
        // a file that is not one is no tenant
      }
    }
  }
  return out;
}

/** Puts the tenant in, or takes it out of, this host's backend registry: the
 *  config here on a Mac, the main stack's through its container on Linux. */
async function registry(host: TenantHost, change: { add: { name: string; url: string } } | { remove: string }): Promise<{ changed: boolean; said: string }> {
  const done = "add" in change ? "names it" : "no longer names it";
  if (host === "compose") {
    const args = "add" in change ? ["register", change.add.name, change.add.url] : ["unregister", change.remove];
    const r = run(["docker", "exec", MAIN_CONTAINER, "bun", "bin/canopy.ts", "tenant", ...args]);
    return r.ok
      ? { changed: true, said: `the registry of ${MAIN_CONTAINER} ${done}` }
      : { changed: false, said: `the registry of ${MAIN_CONTAINER} was not changed (${r.out.split("\n").at(-1) ?? "docker exec failed"}); deploy this checkout's code to the main stack first` };
  }
  const why = await editRegistry(change);
  return why ? { changed: false, said: `this machine's registry was not changed: ${why}` } : { changed: true, said: `this machine's registry ${done}` };
}

/** Changes this machine's registry, or says why it will not: only a
 *  tenant's own entry is touched. */
async function editRegistry(change: { add: { name: string; url: string } } | { remove: string }): Promise<string | null> {
  const cfg = await loadConfig();
  const why = registryRefusal(cfg.backends, change);
  if (why) return why;
  cfg.backends = "add" in change ? withTenant(cfg.backends, { name: change.add.name, tailnet: change.add.url }) : withoutTenant(cfg.backends, change.remove);
  await saveConfig(cfg);
  return null;
}

async function waitUp(url: string, seconds: number): Promise<boolean> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const ok = await fetch(`${url}/api/about`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return true;
    await Bun.sleep(1000);
  }
  return false;
}

/** where this host reaches a tenant itself: loopback when tailscale serve
 *  fronts it, else the address the page dials */
const localOf = (t: Pick<Tenant, "url" | "port">): string => (t.url.startsWith("https://") ? `http://127.0.0.1:${t.port}` : t.url);

/** the tenant's log, for its first sign-in code */
function logOf(t: Pick<Tenant, "host" | "name">): string {
  if (t.host === "launchd") {
    const file = join(stateDir("launchd", t.name), "server.log");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }
  return run(["docker", "logs", `${composeProject(t.name)}-canopy-1`]).out;
}

function composeArgs(name: string, envFile: string): string[] {
  return ["docker", "compose", "-p", composeProject(name), "--env-file", envFile, "-f", join(REPO, "docker-compose.tenant.yml")];
}

async function add(args: string[], fail: Fail): Promise<void> {
  const dry = flag(args, "--dry-run");
  const rootArg = take(args, "--root");
  const portArg = take(args, "--port");
  const originsArg = take(args, "--origins");
  const urlArg = take(args, "--url");
  const [name, ...more] = args;
  if (!name || !rootArg || more.length > 0) return fail(TENANT_USAGE);
  const host = hostKind(fail);
  const cfg = await loadConfig();
  const nameWhy = tenantNameRefusal(name, [...cfg.backends.map((b) => b.name), ...tenants().map((t) => t.name)]);
  if (nameWhy) return fail(nameWhy);
  const root = resolve(rootArg);
  if (!existsSync(root)) return fail(`no folder ${root}`);
  if (root === homedir() || root === "/") return fail(`a tenant's folder is the one its group works in, never ${root}`);

  const taken = listening();
  for (const t of tenants()) taken.add(t.port);
  let port: number;
  if (portArg !== undefined) {
    port = Number(portArg);
    if (!inTenantRange(port)) return fail("--port is one of 7880 to 7899");
    if (taken.has(port)) return fail(`port ${port} is taken here`);
  } else {
    const free = freePort(taken);
    if (free === null) return fail("every port from 7880 to 7899 is taken here");
    port = free;
  }

  const dir = stateDir(host, name);
  const home = join(dir, "home");
  const mainEnv = host === "compose" ? readEnv(join(REPO, ".env")) : {};
  // On the mini the tenant listens on loopback and tailscale serve puts it
  // on the tailnet over https, as the main stack's 7849 is, so an https page
  // can call it. Without serve it listens where the main stack does, plain.
  // A Mac's tenant stays on loopback: it is no wall, so it stays off the tailnet.
  const dns = host === "compose" ? tailnetName() : null;
  const serve = host === "compose" && dns !== null && canServe();
  const listen = host === "compose" && !serve ? (mainEnv["CANOPY_LISTEN"] ?? "127.0.0.1") : "127.0.0.1";
  const plainName = listen === "127.0.0.1" ? "127.0.0.1" : (hostname().split(".")[0] ?? listen);
  const url = urlArg ?? (serve && dns ? `https://${dns}:${port}` : `http://${plainName}:${port}`);
  const local = `http://${listen}:${port}`;
  const origins = tenantOrigins([
    // the pages that call it: this host's own page at the addresses it is
    // opened at, and every page the main stack already answers
    "http://127.0.0.1:7850",
    "http://localhost:7850",
    ...(mainEnv["CANOPY_ORIGINS"] ?? "").split(","),
    mainEnv["CANOPY_PUBLIC_ORIGIN"] ?? "",
    ...(originsArg ?? "").split(","),
  ]);
  const tenant: Tenant = { name, root, port, host, url, created: Date.now() };

  if (host === "launchd") {
    const plist = launchdPlist({
      name,
      bun: process.execPath,
      entry: join(REPO, "bin", "canopy.ts"),
      root,
      port,
      configDir: join(dir, "config"),
      home,
      origins,
      log: join(dir, "server.log"),
      path: process.env["PATH"] ?? "/usr/bin:/bin",
    });
    if (dry) {
      console.log(`would write ${plistPath(name)}:\n${plist}`);
      console.log(`would run launchctl bootstrap gui/${process.getuid?.() ?? 0} ${plistPath(name)}, and name ${name} at ${url} in this machine's registry`);
      return;
    }
    mkdirSync(join(dir, "config"), { recursive: true, mode: 0o700 });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "tenant.json"), JSON.stringify(tenant, null, 2) + "\n", { mode: 0o600 });
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath(name), plist);
    const uid = process.getuid?.() ?? 0;
    run(["launchctl", "bootout", `gui/${uid}/${launchLabel(name)}`]);
    const boot = run(["launchctl", "bootstrap", `gui/${uid}`, plistPath(name)]);
    if (!boot.ok) return fail(`launchctl did not start it: ${boot.out}`);
  } else {
    for (const [k, v] of [["TENANT_ROOT", root], ["TENANT_HOME", home], ["TENANT_LISTEN", listen], ["TENANT_ORIGINS", origins.join(",")]] as const) {
      const why = envRefusal(k, v);
      if (why) return fail(why);
    }
    const env = composeEnv({ root, port, listen, home, origins, ...(mainEnv["TZ"] ? { tz: mainEnv["TZ"] } : {}) });
    const envFile = join(dir, ".env");
    const start = [...composeArgs(name, envFile), "up", "-d"];
    if (dry) {
      console.log(`would write ${envFile}:\n${env}`);
      console.log(`would run ${start.join(" ")}${serve ? `, serve https ${port} on the tailnet` : ""}, and name ${name} at ${url} in ${MAIN_CONTAINER}'s registry`);
      return;
    }
    for (const missing of ["canopy-shells:latest", "canopy-backend:latest"].filter((img) => !run(["docker", "image", "inspect", img]).ok)) {
      return fail(`no ${missing} image here: the main stack builds it (bun run redeploy)`);
    }
    // the tenant's own home: docker would make a missing mount point as
    // root, and a missing file as a folder
    for (const d of [".claude", ".codex", join(".config", "git")]) mkdirSync(join(home, d), { recursive: true, mode: 0o700 });
    if (!existsSync(join(home, ".claude.json"))) writeFileSync(join(home, ".claude.json"), "{}\n", { mode: 0o600 });
    writeFileSync(join(dir, "tenant.json"), JSON.stringify(tenant, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(envFile, env, { mode: 0o600 });
    const r = run(start, { cwd: REPO });
    if (!r.ok) return fail(`docker compose did not start it:\n${r.out}`);
    if (serve) {
      const s = run(["sudo", "-n", "tailscale", "serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`]);
      if (!s.ok) console.log(`  tailscale serve did not take ${port}: ${s.out.split("\n").at(-1) ?? ""}; it answers on loopback only until it does`);
    }
  }

  const upNow = await waitUp(local, 90);
  const listed = await registry(host, { add: { name, url } });
  // the code is printed just after the server first answers
  let code: string | null = null;
  for (let i = 0; i < 10 && code === null && upNow; i++) {
    code = firstCodeIn(logOf(tenant));
    if (code === null) await Bun.sleep(500);
  }
  console.log(`tenant ${name} ${upNow ? "is up" : "did not answer in 90 s; its log says why"} at ${url} (${host === "launchd" ? launchLabel(name) : composeProject(name)})`);
  console.log(`  its folder, the only one it scans: ${root}`);
  console.log(listed.changed ? `  ${listed.said}, so the page here lists it after a reload` : `  ${listed.said}; until it does, add ${url} to the page's backends by hand`);
  console.log(code ? `  sign in as its owner: open ${url} and type the first code ${code}` : `  sign in as its owner with the first code in its log (canopy tenant list says where)`);
  console.log("  it has no claude login of its own: give it a provider file (providers/<id>.json in its config) or sign claude in from one of its shells");
  if (host === "launchd") console.log("  on a Mac it runs as your own OS user: its people, callers and state are its own, your files are not walled off. The mini's tenant is the wall.");
}

async function list(): Promise<void> {
  const all = tenants();
  if (all.length === 0) {
    console.log("no tenants on this host");
    return;
  }
  for (const t of all) {
    const alive = await fetch(`${localOf(t)}/api/about`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false);
    const log = t.host === "launchd" ? join(stateDir("launchd", t.name), "server.log") : `docker logs ${composeProject(t.name)}-canopy-1`;
    console.log(`${t.name}\t${alive ? "up" : "down"}\t${t.url}\t${t.host}\t${t.root}\tlog: ${log}`);
  }
}

/** Starts a tenant again on what this host has now: the images a deploy
 *  just built, or the checkout's code under launchd. */
async function up(args: string[], fail: Fail): Promise<void> {
  const [name, ...more] = args;
  if (!name || more.length > 0) return fail(TENANT_USAGE);
  const host = hostKind(fail);
  const t = tenants().find((x) => x.name === name && x.host === host);
  if (!t) return fail(`no tenant ${name} on this host`);
  const r =
    host === "launchd"
      ? run(["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${launchLabel(name)}`])
      : run([...composeArgs(name, join(stateDir(host, name), ".env")), "up", "-d"], { cwd: REPO });
  if (!r.ok) return fail(`${name} did not start again:\n${r.out}`);
  const back = await waitUp(localOf(t), 90);
  console.log(`tenant ${name} ${back ? "is up" : "did not answer in 90 s"} at ${t.url}`);
}

async function remove(args: string[], fail: Fail): Promise<void> {
  const purge = flag(args, "--purge");
  const [name, ...more] = args;
  if (!name || more.length > 0) return fail(TENANT_USAGE);
  const host = hostKind(fail);
  const t = tenants().find((x) => x.name === name && x.host === host);
  if (!t) return fail(`no tenant ${name} on this host`);
  const dir = stateDir(host, name);
  if (host === "launchd") {
    run(["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/${launchLabel(name)}`]);
    rmSync(plistPath(name), { force: true });
  } else {
    const r = run([...composeArgs(name, join(dir, ".env")), "down", ...(purge ? ["-v"] : [])], { cwd: REPO });
    if (!r.ok) return fail(`docker compose did not take it down:\n${r.out}`);
    // off the tailnet too; a tenant that was never served answers no handler
    if (has("tailscale") && t.url.startsWith("https://")) run(["sudo", "-n", "tailscale", "serve", `--https=${t.port}`, "off"]);
  }
  const { said } = await registry(host, { remove: name });
  if (purge) rmSync(dir, { recursive: true, force: true });
  console.log(`tenant ${name} is stopped and gone from ${host === "launchd" ? "launchd" : "docker"}; ${said}`);
  console.log(purge ? "  its people, callers, state and home are deleted" : `  its people, callers, state and home are kept in ${dir}${host === "compose" ? ` and the volume ${composeProject(name)}_config` : ""}; --purge deletes them`);
}

export async function tenantCommand(argv: string[], { fail }: { fail: Fail }): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "add":
      return add(rest, fail);
    case "list":
    case undefined:
      return list();
    case "up":
      return up(rest, fail);
    case "remove":
      return remove(rest, fail);
    // what `add` and `remove` run inside the main stack's container to edit
    // its registry; plain config edits, so they need no host
    case "register": {
      const [name, url] = rest;
      if (!name || !url || !/^https?:\/\/[^/\s]+$/.test(url)) return fail("usage: canopy tenant register <name> <url>");
      const why = await editRegistry({ add: { name, url } });
      if (why) return fail(why);
      console.log(`the registry names ${name} at ${url}`);
      return;
    }
    case "unregister": {
      const [name] = rest;
      if (!name) return fail("usage: canopy tenant unregister <name>");
      const why = await editRegistry({ remove: name });
      if (why) return fail(why);
      console.log(`the registry no longer names ${name}`);
      return;
    }
    default:
      return fail(TENANT_USAGE);
  }
}
