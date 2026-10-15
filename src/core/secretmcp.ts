/**
 * One MCP server's allowance as a change to secrets.json (phase 2 spec,
 * "Allowing a server its secrets"): the `mcp:` allow entries and the env
 * and headers sinks, built in one pass so the service lands them in one
 * commit. Pure and browser-safe; no value passes through here.
 */

import { isServerSink, mcpEnvPath, mcpSinkId, parseMcpAllow, SINK_ID, type SecretFile, type SinkDef } from "./secretfile";

export interface McpAllowance {
  server: string;
  hash: string;
  /** env name to secret name */
  env: Record<string, string>;
  /** header name to secret name */
  headers: Record<string, string>;
  /** machine to its home, where the sink files go */
  homes: Record<string, string>;
}

type Result = { file: SecretFile } | { error: string };

/** Each secret's allow list with this server's `mcp:` entry set (or taken
 *  out when `hash` is null) and the `sink:` tags of the touched sinks
 *  following what they map. Every other entry stays. */
function retag(secrets: SecretFile["secrets"], sinks: Record<string, SinkDef>, touched: readonly string[], server: string, hash: string | null, uses: ReadonlySet<string>): SecretFile["secrets"] {
  return Object.fromEntries(
    Object.entries(secrets).map(([n, e]) => {
      const kept = e.allow.filter((a) => !(a.startsWith("sink:") && touched.includes(a.slice(5))) && parseMcpAllow(a)?.server !== server);
      const tags = touched.filter((id) => Object.values(sinks[id]?.keys ?? {}).includes(n)).map((id) => `sink:${id}`);
      const mcp = hash !== null && uses.has(n) ? [`mcp:${server}#${hash}`] : [];
      return [n, { ...e, allow: [...new Set([...kept, ...tags, ...mcp])].sort() }];
    }),
  );
}

export function mcpAllowFile(f: SecretFile, x: McpAllowance): Result {
  const names = [...Object.values(x.env), ...Object.values(x.headers)];
  if (names.length === 0) return { error: `${x.server} names no secret; it needs no allowance` };
  const gone = names.find((n) => !f.secrets[n]);
  if (gone) return { error: `${x.server} names ${gone}, which the store does not hold` };
  const machines = Object.keys(x.homes).sort();
  if (machines.length === 0) return { error: `${x.server} is placed on no machine` };
  if (machines.includes("gpd")) return { error: "gpd's sinks are secrets phase 3; allow the server without gpd" };
  if (machines.includes("breakglass")) return { error: "breakglass is a key, not a machine with sinks" };
  const sinks: Record<string, SinkDef> = Object.fromEntries(Object.entries(f.sinks).filter(([id, s]) => !isServerSink(id, x.server, s.machine)));
  const touched = new Set(Object.keys(f.sinks).filter((id) => !(id in sinks)));
  for (const m of machines) {
    for (const [headers, keys] of [[false, x.env], [true, x.headers]] as const) {
      if (Object.keys(keys).length === 0) continue;
      const id = mcpSinkId(x.server, m, headers);
      if (!SINK_ID.test(id)) return { error: `the sink id ${id} is too long; shorten the server's name` };
      const path = mcpEnvPath(x.homes[m] ?? "", x.server, headers);
      const clash = Object.entries(sinks).find(([, s]) => s.machine === m && s.path === path);
      if (clash) return { error: `sink ${clash[0]} already writes ${path} on ${m}` };
      sinks[id] = { machine: m, path, format: headers ? "json" : "dotenv", keys: { ...keys } };
      touched.add(id);
    }
  }
  return { file: { ...f, sinks, secrets: retag(f.secrets, sinks, [...touched], x.server, x.hash, new Set(names)) } };
}

export function mcpRevokeFile(f: SecretFile, server: string): Result {
  const sinks: Record<string, SinkDef> = Object.fromEntries(Object.entries(f.sinks).filter(([id, s]) => !isServerSink(id, server, s.machine)));
  const touched = Object.keys(f.sinks).filter((id) => !(id in sinks));
  const allowed = Object.values(f.secrets).some((e) => e.allow.some((a) => parseMcpAllow(a)?.server === server));
  if (!allowed && touched.length === 0) return { error: `${server} has no allowance` };
  return { file: { ...f, sinks, secrets: retag(f.secrets, sinks, touched, server, null, new Set()) } };
}
