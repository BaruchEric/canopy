/* A tenant (FR-074, plan 3): a canopy of its own on a host, with its own
   config dir, port, callers and people, for a group that must not reach
   another's files. On the mini it is a compose project with the tenant's
   folder and its own home mounted and nothing of the owner's, which is the
   wall. On a Mac it is a launchd agent under the owner's OS user, which
   keeps the roster, the callers and the state apart and not the files.
   `canopy tenant` (cli/tenant.ts) does the host's side; everything here is
   pure: the names, the ports, the files it writes and the registry entry. */

import type { BackendEntry } from "./types";

/** the ports a tenant takes, clear of canopy's own (7850, 7851, 7855, 7859,
 *  the previews' 7860-7869) and the mini's 7871 */
export const TENANT_PORTS = { first: 7880, last: 7899 } as const;

/** where a tenant runs: a launchd agent on a Mac, a compose project on Linux */
export type TenantHost = "launchd" | "compose";

/** what `canopy tenant add` keeps in `<config dir>/tenants/<name>/tenant.json` */
export interface Tenant {
  name: string;
  /** the folder its repos are under, the only one of the host's it sees */
  root: string;
  port: number;
  host: TenantHost;
  /** the address the host's own page dials it at */
  url: string;
  created: number;
}

const NAME = /^[a-z][a-z0-9-]{1,23}$/;

/** Why a name will not do for a tenant, or null: lowercase letters, digits
 *  and hyphens, 2 to 24 long, starting with a letter, and not a backend the
 *  registry already names. It is a launchd label, a compose project and a
 *  backend's name in every id the page holds. */
export function tenantNameRefusal(name: string, taken: readonly string[]): string | null {
  if (!NAME.test(name)) return `a tenant's name is 2 to 24 lowercase letters, digits and hyphens, starting with a letter (not "${name}")`;
  if (name.endsWith("-")) return `a tenant's name does not end in a hyphen (not "${name}")`;
  if (name === "home" || taken.includes(name)) return `${name} already names a backend here`;
  return null;
}

/** the first port of the tenants' range nothing holds, or null when all are taken */
export function freePort(taken: ReadonlySet<number>): number | null {
  for (let p = TENANT_PORTS.first; p <= TENANT_PORTS.last; p++) if (!taken.has(p)) return p;
  return null;
}

/** whether a port asked for by hand is one a tenant may take */
export const inTenantRange = (port: number): boolean => Number.isInteger(port) && port >= TENANT_PORTS.first && port <= TENANT_PORTS.last;

export const launchLabel = (name: string): string => `canopy.tenant.${name}`;
export const composeProject = (name: string): string => `canopy-t-${name}`;

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The launchd agent's plist. bun runs canopy straight, not through the
 *  owner's mac-server.sh, so none of the owner's keys reach the tenant.
 *  HOME is the tenant's own, so its agents read no CLAUDE.md, skills,
 *  settings or claude login of the owner's. GIT_CONFIG_NOSYSTEM keeps git
 *  off Homebrew's system gitconfig, whose osxkeychain helper would hand a
 *  push the owner's GitHub login. ssh still reads the OS user's ~/.ssh
 *  whatever HOME says: a Mac tenant is no wall. */
export function launchdPlist(p: {
  name: string;
  bun: string;
  entry: string;
  root: string;
  port: number;
  configDir: string;
  home: string;
  origins: readonly string[];
  log: string;
  path: string;
}): string {
  const env: [string, string][] = [
    ["CANOPY_CONFIG_DIR", p.configDir],
    ["CANOPY_CALLERS", "enforce"],
    ["CANOPY_ORIGINS", p.origins.join(",")],
    // no previews, no tailchan (a value that is no URL turns it off), and
    // none of the desktop openers, which would act on the owner's screen
    ["CANOPY_PREVIEW_PORTS", "0"],
    ["CANOPY_TAILCHAN_URL", "off"],
    ["CANOPY_NO_DESKTOP", "1"],
    ["GIT_CONFIG_NOSYSTEM", "1"],
    ["HOME", p.home],
    ["PATH", p.path],
  ];
  const args = [p.bun, "run", p.entry, "ui", p.root, "--port", String(p.port), "--no-open"];
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key><string>${xml(launchLabel(p.name))}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...args.map((a) => `    <string>${xml(a)}</string>`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...env.map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`),
    `  </dict>`,
    `  <key>WorkingDirectory</key><string>${xml(p.root)}</string>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>KeepAlive</key><true/>`,
    `  <key>ThrottleInterval</key><integer>10</integer>`,
    `  <key>StandardOutPath</key><string>${xml(p.log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(p.log)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** A compose .env value: one line, no quotes, no `$` for compose to expand. */
export function envRefusal(key: string, value: string): string | null {
  if (/[\n\r"'$`\\]/.test(value)) return `${key} may not hold a newline, a quote, a backslash, a backtick or a $ (${JSON.stringify(value)})`;
  return null;
}

/** The compose project's .env, read by docker-compose.tenant.yml. */
export function composeEnv(p: { root: string; port: number; listen: string; home: string; origins: readonly string[]; tz?: string }): string {
  const lines: [string, string][] = [
    ["TENANT_ROOT", p.root],
    ["TENANT_PORT", String(p.port)],
    ["TENANT_LISTEN", p.listen],
    ["TENANT_HOME", p.home],
    ["TENANT_ORIGINS", p.origins.join(",")],
  ];
  if (p.tz) lines.push(["TZ", p.tz]);
  return lines.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

/** The origins a tenant answers besides its own page: the host's pages,
 *  so the page Eric already opens there lists the tenant and calls it.
 *  Each is an exact origin, deduplicated, order kept. */
export function tenantOrigins(given: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of given) {
    const o = raw.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^/\s]+$/.test(o)) continue;
    if (!out.includes(o)) out.push(o);
  }
  return out;
}

/** The registry with the tenant in it, replacing an entry of the same name. */
export function withTenant(backends: readonly BackendEntry[], entry: BackendEntry): BackendEntry[] {
  return [...backends.filter((b) => b.name !== entry.name), entry];
}

/** The registry without the tenant. */
export const withoutTenant = (backends: readonly BackendEntry[], name: string): BackendEntry[] => backends.filter((b) => b.name !== name);

/** the port an address names, or null for one that names none */
function portOf(url: string): number | null {
  try {
    const u = new URL(url);
    return u.port === "" ? null : Number(u.port);
  } catch {
    return null;
  }
}

/** whether a registry entry is a tenant's: every address it has is on a tenant port */
export function isTenantEntry(b: BackendEntry): boolean {
  const addrs = [b.tailnet, b.public].filter((a): a is string => a !== undefined);
  return addrs.length > 0 && addrs.every((a) => {
    const p = portOf(a);
    return p !== null && inTenantRange(p);
  });
}

/** Why a registry change is refused, or null. `tenant register` and
 *  `unregister` run inside the main stack's container and touch only a
 *  tenant's own entry, so a slip of the name never drops or rewrites the
 *  mini, the Mac or De Soto. */
export function registryRefusal(backends: readonly BackendEntry[], change: { add: { name: string; url: string } } | { remove: string }): string | null {
  const name = "add" in change ? change.add.name : change.remove;
  const was = backends.find((b) => b.name === name);
  if (was && !isTenantEntry(was)) return `${name} is a backend of its own, not a tenant; the registry keeps it`;
  if ("add" in change) {
    const p = portOf(change.add.url);
    if (p === null || !inTenantRange(p)) return `a tenant's address is on a port from ${TENANT_PORTS.first} to ${TENANT_PORTS.last}, not ${change.add.url}`;
  }
  return null;
}

/** what a tenant.json holds, or null for a file that is not one */
export function parseTenant(v: unknown): Tenant | null {
  if (typeof v !== "object" || v === null) return null;
  const name: unknown = Reflect.get(v, "name");
  const root: unknown = Reflect.get(v, "root");
  const port: unknown = Reflect.get(v, "port");
  const host: unknown = Reflect.get(v, "host");
  const url: unknown = Reflect.get(v, "url");
  const created: unknown = Reflect.get(v, "created");
  if (typeof name !== "string" || typeof root !== "string" || typeof url !== "string") return null;
  if (typeof port !== "number" || typeof created !== "number") return null;
  if (host !== "launchd" && host !== "compose") return null;
  return { name, root, port, host, url, created };
}

/** the first sign-in code a tenant's log printed last, or null before it
 *  prints one: a restart prints a new one */
export function firstCodeIn(log: string): string | null {
  let code: string | null = null;
  for (const m of log.matchAll(/first sign-in code (\S+) /g)) code = m[1] ?? code;
  return code;
}
