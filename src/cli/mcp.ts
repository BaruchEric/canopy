/** `canopy mcp`: the process around core/canopymcp.ts. Bun-only. */
import { readBuild } from "../core/build";
import { KIND_RIGHTS, type CallerKind } from "../core/callers";
import { serve, toolsFor, type CanopyApi } from "../core/canopymcp";
import { versionLine } from "../core/version";
import { apiBase, callerToken } from "./api";
import { errText, take } from "./health";

export const MCP_USAGE = "usage: canopy mcp [--backend URL] [--run-config FILE]\n       canopy mcp tools [--backend URL]";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isKind = (value: unknown): value is CallerKind => typeof value === "string" && Object.hasOwn(KIND_RIGHTS, value);

/** The session's token wins over a CLI token saved on the same machine. A
 *  run's server takes no other: on the Mac the file holds an admin token, and
 *  a run whose own went missing must get nothing rather than that. */
export function mcpToken(base: string, env: Record<string, string | undefined> = process.env): string | null {
  const own = env["CANOPY_TOKEN"]?.trim();
  if (own) return own;
  return env["CANOPY_RUN"]?.trim() ? null : callerToken(base);
}

/** The environment a run's `mcp.json` holds, for a harness that cannot hand
 *  the server an env without putting the token on argv. Throws on a file that
 *  is not one: a run's server takes that file's token or none. */
export function runConfigEnv(text: string): Record<string, string> {
  const parsed: unknown = JSON.parse(text);
  const servers = isRecord(parsed) ? parsed["mcpServers"] : null;
  const entry = isRecord(servers) ? servers["canopy"] : null;
  const env = isRecord(entry) ? entry["env"] : null;
  if (!isRecord(env) || typeof env["CANOPY_API"] !== "string" || typeof env["CANOPY_TOKEN"] !== "string" || typeof env["CANOPY_RUN"] !== "string") throw new Error("it is not a run's canopy config");
  return { CANOPY_API: env["CANOPY_API"], CANOPY_TOKEN: env["CANOPY_TOKEN"], CANOPY_RUN: env["CANOPY_RUN"] };
}

/** One HTTP request per call. A refusal or redirect is never retried. */
export function apiOver(base: string, token: string | null): CanopyApi {
  return {
    async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
      const headers = new Headers();
      if (token) headers.set("x-canopy-token", token);
      if (body !== undefined) headers.set("content-type", "application/json");
      const response = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual", signal: AbortSignal.timeout(30_000) });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(isRecord(data) && typeof data["error"] === "string" ? data["error"] : `${base} answered ${response.status}`);
      // The API's typed records share the same contracts as the CLI.
      return data as T;
    },
  };
}

export function toolLines(kind: CallerKind, base: string): string[] {
  return [`tools for a ${kind} token on ${base}`, ...toolsFor(kind).map((tool) => `  ${tool.name.padEnd(15)}  ${tool.right.padEnd(8)}  ${tool.description}`)];
}

export async function mcpCommand(argv: string[], { fail }: { fail: (message: string) => never }): Promise<void> {
  const args = [...argv];
  if (args.includes("--backend") && !args[args.indexOf("--backend") + 1]) return fail(MCP_USAGE);
  if (args.includes("--run-config") && !args[args.indexOf("--run-config") + 1]) return fail(MCP_USAGE);
  const file = take(args, "--run-config");
  const held = file === undefined ? null : await Bun.file(file).text().then(runConfigEnv).catch((err: unknown) => fail(`canopy mcp: ${file}: ${errText(err)}`));
  const env = held ?? process.env;
  const base = apiBase(take(args, "--backend") ?? held?.["CANOPY_API"]);
  if (args.length > 1 || (args.length === 1 && args[0] !== "tools")) return fail(MCP_USAGE);
  const api = apiOver(base, mcpToken(base, env));
  const auth = await api.call<unknown>("GET", "/api/auth").catch((err: unknown) => fail(`canopy mcp: ${base} did not answer: ${errText(err)}`));
  if (!isRecord(auth) || !isKind(auth["you"])) return fail(`canopy mcp: ${base} did not answer with a caller kind`);
  const kind = auth["you"];
  if (args[0] === "tools") {
    for (const line of toolLines(kind, base)) console.log(line);
    return;
  }
  const writer = Bun.stdout.writer();
  await serve(Bun.stdin.stream(), { write: async (line: string) => { writer.write(line + "\n"); await writer.flush(); } }, { api, kind, run: env["CANOPY_RUN"] ?? null, version: versionLine(readBuild()) });
}
