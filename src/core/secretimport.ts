/**
 * Where secrets live today, read for the import. Each reader takes a file's
 * text and returns the values in it; the lists name the files on the mini
 * (read by the secrets service) and on the Mac (read by the Mac's canopy).
 * A found value goes straight into a seal; nothing here logs one.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SECRET_NAME } from "./secretfile";
import { parseDotenv } from "./sinks";
import type { SecretSinkFormat } from "./types";

/** `value` null: a source canopy can list but not read (sops) */
export interface Found {
  source: string;
  key: string;
  value: string | null;
}

export type ImportKind = "dotenv" | "credentials" | "claude" | "codex" | "sops";

export interface ImportSource {
  path: string;
  kind: ImportKind;
}

/** an env reference such as ${HOME}, which is not a secret */
const REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function fromDotenv(source: string, text: string): Found[] {
  const p = parseDotenv(text);
  if ("error" in p) return [];
  return p.lines.flatMap((l) => (l.kind === "pair" && l.value !== "" && !REF.test(l.value) ? [{ source, key: l.key, value: l.value }] : []));
}

function leaves(source: string, v: unknown, path: string[]): Found[] {
  if (typeof v === "string") return v !== "" && !REF.test(v) ? [{ source, key: path.join("."), value: v }] : [];
  if (!isObj(v)) return [];
  return Object.entries(v).flatMap(([k, x]) => leaves(source, x, [...path, k]));
}

const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const fromCredentials = (source: string, text: string): Found[] => leaves(source, json(text), []);

/** each server's env and headers in one `mcpServers` map */
function mcp(source: string, servers: unknown, prefix: string[]): Found[] {
  if (!isObj(servers)) return [];
  return Object.entries(servers).flatMap(([name, s]) =>
    isObj(s) ? [...leaves(source, s["env"], [...prefix, name, "env"]), ...leaves(source, s["headers"], [...prefix, name, "headers"])] : [],
  );
}

export function fromClaudeJson(source: string, text: string): Found[] {
  const v = json(text);
  if (!isObj(v)) return [];
  const projects = isObj(v["projects"]) ? Object.entries(v["projects"]) : [];
  return [
    ...mcp(source, v["mcpServers"], ["mcpServers"]),
    ...projects.flatMap(([p, cfg]) => (isObj(cfg) ? mcp(source, cfg["mcpServers"], ["projects", p, "mcpServers"]) : [])),
  ];
}

export function fromCodexToml(source: string, text: string): Found[] {
  let v: unknown;
  try {
    v = Bun.TOML.parse(text);
  } catch {
    return [];
  }
  if (!isObj(v) || !isObj(v["mcp_servers"])) return [];
  return Object.entries(v["mcp_servers"]).flatMap(([name, s]) => (isObj(s) ? leaves(source, s["env"], ["mcp_servers", name, "env"]) : []));
}

export function sopsNames(source: string, text: string): Found[] {
  let v: unknown;
  try {
    v = Bun.YAML.parse(text);
  } catch {
    return [];
  }
  if (!isObj(v)) return [];
  return Object.keys(v)
    .filter((k) => k !== "sops")
    .map((key) => ({ source, key, value: null }));
}

/** A name for a found value: the stack or MCP server it belongs to, then
 *  its key, lowercased, in the store's alphabet. */
export function suggestName(source: string, key: string): string {
  const stack = /^\/opt\/stacks\/([^/]+)\//.exec(source)?.[1];
  const parts = key.split(".");
  const server = parts[0] === "mcpServers" || parts[0] === "mcp_servers" ? parts[parts.length - 3] : parts[0] === "projects" ? parts[parts.length - 3] : undefined;
  const last = parts.length > 1 && !server ? parts.join("_") : (parts[parts.length - 1] ?? key);
  const raw = [stack, server, last].filter(Boolean).join("_").toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").slice(0, 100);
  return SECRET_NAME.test(raw) ? raw : `s_${raw}`.slice(0, 100);
}

/** the sink format a source file would have, null when it cannot be one */
export function formatOf(path: string): SecretSinkFormat | null {
  if (path.endsWith(".env")) return "dotenv";
  if (path.endsWith(".json")) return "json";
  return null;
}

const READERS: Record<ImportKind, (source: string, text: string) => Found[]> = {
  dotenv: fromDotenv,
  credentials: fromCredentials,
  claude: fromClaudeJson,
  codex: fromCodexToml,
  sops: sopsNames,
};

export async function scanFiles(list: readonly ImportSource[]): Promise<{ found: Found[]; missing: string[] }> {
  const found: Found[] = [];
  const missing: string[] = [];
  for (const s of list) {
    let text: string;
    try {
      text = await readFile(s.path, "utf8");
    } catch {
      missing.push(s.path);
      continue;
    }
    found.push(...READERS[s.kind](s.path, text));
  }
  return { found, missing };
}

export const macSources = (home: string, dev: string): ImportSource[] => [
  { path: join(home, ".claude", "credentials", ".credentials.json"), kind: "credentials" },
  { path: join(dev, ".env"), kind: "dotenv" },
  { path: join(home, ".claude.json"), kind: "claude" },
  { path: join(home, ".codex", "config.toml"), kind: "codex" },
];

/** each stack folder's .env, the two sops files, and `extra` dotenv files */
export async function miniSources(stacks: string, extra: readonly string[]): Promise<ImportSource[]> {
  let dirs: string[] = [];
  try {
    dirs = (await readdir(stacks, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    // no stacks mounted
  }
  return [
    ...dirs.map((d) => ({ path: join(stacks, d, ".env"), kind: "dotenv" as const })),
    { path: join(stacks, "memory", "env.sops.yaml"), kind: "sops" },
    { path: join(stacks, "executor", "env.sops.yaml"), kind: "sops" },
    ...extra.map((path) => ({ path, kind: "dotenv" as const })),
  ];
}
