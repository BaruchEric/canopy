/** `canopy mcp`: the process around core/canopymcp.ts. Bun-only. */
import { readBuild } from "../core/build";
import { KIND_RIGHTS, type CallerKind } from "../core/callers";
import { serve, toolsFor, type CanopyApi } from "../core/canopymcp";
import { versionLine } from "../core/version";
import { apiBase, callerToken } from "./api";
import { errText, take } from "./health";

export const MCP_USAGE = "usage: canopy mcp [--backend URL]\n       canopy mcp tools [--backend URL]";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isKind = (value: unknown): value is CallerKind => typeof value === "string" && Object.hasOwn(KIND_RIGHTS, value);

/** The session's token wins over a CLI token saved on the same machine. */
export function mcpToken(base: string, env: Record<string, string | undefined> = process.env): string | null {
  return env["CANOPY_TOKEN"]?.trim() || callerToken(base);
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
  const base = apiBase(take(args, "--backend"));
  if (args.length > 1 || (args.length === 1 && args[0] !== "tools")) return fail(MCP_USAGE);
  const api = apiOver(base, mcpToken(base));
  const auth = await api.call<unknown>("GET", "/api/auth").catch((err: unknown) => fail(`canopy mcp: ${base} did not answer: ${errText(err)}`));
  if (!isRecord(auth) || !isKind(auth["you"])) return fail(`canopy mcp: ${base} did not answer with a caller kind`);
  const kind = auth["you"];
  if (args[0] === "tools") {
    for (const line of toolLines(kind, base)) console.log(line);
    return;
  }
  const writer = Bun.stdout.writer();
  await serve(Bun.stdin.stream(), { write: async (line: string) => { writer.write(line + "\n"); await writer.flush(); } }, { api, kind, run: process.env["CANOPY_RUN"] ?? null, version: versionLine(readBuild()) });
}
