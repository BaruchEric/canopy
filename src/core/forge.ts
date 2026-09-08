import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parseRemote } from "./access";
import type { ForgeRepo, Repo, Source } from "./types";

/** Repos on a self-hosted Forgejo (Gitea speaks the same API). They are bare
 *  on the server, so canopy cannot walk them the way it walks a folder: the
 *  API lists them instead and the cards it makes carry no working state. */

/** A token that is missing, unreadable or refused. The server tells this
 *  from a forge it simply cannot reach: one is the person's mistake, the
 *  other is the network's. */
export class ForgeAuthError extends Error {}

/** The env var read when a source names no token file. */
export const TOKEN_ENV = "CANOPY_FORGEJO_TOKEN";

/** How many repos one page asks for. Forgejo caps this server-side, which is
 *  why the walk keeps paging until a page comes back short. */
export const PAGE = 50;

/** Enough for any single-user forge; the guard is against a server that
 *  answers a full page forever. */
const MAX_PAGES = 40;

/** The origin the API lives on: no trailing slash, and `/api/v1` dropped so
 *  a base pasted from the API docs works as well as one from the address
 *  bar. Throws on anything that is not an http(s) URL. */
export function apiBase(url: string): string {
  const trimmed = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") {
    throw new Error(`not an http address: ${url}`);
  }
  const withScheme = scheme ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`not an http address: ${url}`);
  }
  u.username = "";
  u.password = "";
  u.search = "";
  u.hash = "";
  const path = u.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
  u.pathname = path;
  return u.toString().replace(/\/$/, "");
}

export const reposUrl = (base: string, page: number): string =>
  `${base}/api/v1/user/repos?limit=${PAGE}&page=${page}`;

/** The fields canopy reads off a forge's repo. The API sends dozens more. */
export interface ForgeApiRepo {
  name: string;
  full_name: string;
  description: string;
  html_url: string;
  ssh_url: string;
  clone_url: string;
  default_branch: string;
  updated_at: string;
  private: boolean;
  empty: boolean;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** One page of `/user/repos`, keeping only entries with the fields a card
 *  needs. A repo the API describes oddly is dropped, not guessed at. */
export function parseRepoPage(body: unknown): ForgeApiRepo[] {
  if (!Array.isArray(body)) throw new Error("the forge did not answer with a list of repos");
  const out: ForgeApiRepo[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const name = str(r["name"]);
    const html = str(r["html_url"]);
    if (!name || !html) continue;
    out.push({
      name,
      full_name: str(r["full_name"]) || name,
      description: str(r["description"]),
      html_url: html,
      ssh_url: str(r["ssh_url"]),
      clone_url: str(r["clone_url"]),
      default_branch: str(r["default_branch"]),
      updated_at: str(r["updated_at"]),
      private: r["private"] === true,
      empty: r["empty"] === true,
    });
  }
  return out;
}

/** A git URL as `host/owner/name`, lowercased, for matching a remote against
 *  a forge repo. Ports, the `git@` user and a trailing `.git` all vary
 *  between what Forgejo advertises and what a remote was added as. */
export function repoKey(url: string): string | null {
  const ref = parseRemote(url);
  if (!ref) return null;
  return `${ref.host}/${ref.owner}/${ref.name}`.toLowerCase();
}

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** One API repo as a card. `path` is the forge's web address: there is no
 *  folder, and a string nothing can mistake for one keeps the openers from
 *  ever pointing a terminal at it. */
export function forgeRepo(source: Source, api: ForgeApiRepo): Repo {
  const forge: ForgeRepo = {
    kind: "forgejo",
    slug: api.full_name,
    clone: api.ssh_url || api.clone_url,
    branch: api.default_branch || "main",
    updated: time(api.updated_at),
    private: api.private,
    empty: api.empty,
  };
  return {
    id: `${source.id}:${api.full_name}`,
    name: api.name,
    path: api.html_url,
    group: source.label,
    source: source.id,
    link: api.html_url,
    ...(api.description ? { description: api.description } : {}),
    status: null,
    forge,
  };
}

/** Ties the forge's repos to the clones already on this machine: each forge
 *  card learns the local repo that has it as a remote, and a local repo with
 *  no web link yet gets the forge's page. Both sides come out of the same
 *  match, so this runs over the whole tree after any scan. */
export function linkForgeClones(repos: Repo[]): Repo[] {
  const byKey = new Map<string, string>();
  for (const r of repos) {
    if (r.forge) continue;
    for (const url of r.remotes ?? []) {
      const key = repoKey(url);
      if (key && !byKey.has(key)) byKey.set(key, r.id);
    }
  }
  if (byKey.size === 0 && !repos.some((r) => r.forge)) return repos;
  const linkFor = new Map<string, string>();
  const out = repos.map((r) => {
    if (!r.forge) return r;
    const keys = [r.forge.clone, r.path].map(repoKey).filter((k): k is string => k !== null);
    const clonedAs = keys.map((k) => byKey.get(k)).find((id) => id !== undefined);
    if (clonedAs !== undefined) linkFor.set(clonedAs, r.path);
    if (clonedAs === r.forge.clonedAs) return r;
    // Rebuilt rather than spread over: a clone that has gone away has to
    // leave the tie behind with it.
    const forge: ForgeRepo = { ...r.forge };
    if (clonedAs === undefined) delete forge.clonedAs;
    else forge.clonedAs = clonedAs;
    return { ...r, forge };
  });
  return out.map((r) => {
    const link = linkFor.get(r.id);
    return !r.forge && link && !r.link ? { ...r, link } : r;
  });
}

/** The token, from the source's file or the environment. Only the path is
 *  ever stored in canopy's config — the secret stays where it lives. */
export async function readToken(source: {
  tokenFile?: string;
}): Promise<string | null> {
  const file = source.tokenFile?.trim();
  if (file) {
    const path = file.startsWith("~/") ? `${homedir()}/${file.slice(2)}` : file;
    const text = await readFile(path, "utf8").catch(() => {
      throw new ForgeAuthError(`cannot read the token file ${file}`);
    });
    const token = text.trim();
    if (!token) throw new ForgeAuthError(`the token file ${file} is empty`);
    return token;
  }
  return process.env[TOKEN_ENV]?.trim() || null;
}

/** Every repo the token's user can see, paged. */
export async function listForgeRepos(
  place: { url: string; tokenFile?: string },
  opts: { timeoutMs?: number } = {},
): Promise<ForgeApiRepo[]> {
  const base = apiBase(place.url);
  const token = await readToken(place);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `token ${token}`;
  const all: ForgeApiRepo[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetch(reposUrl(base, page), {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      throw new Error(`cannot reach ${base}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ForgeAuthError(
        token ? `${base} rejected the token` : `${base} needs a token: ${TOKEN_ENV} or a token file`,
      );
    }
    if (!res.ok) throw new Error(`${base} answered ${res.status}`);
    const body: unknown = await res.json().catch(() => null);
    const batch = parseRepoPage(body);
    all.push(...batch);
    if (batch.length < PAGE) break;
  }
  return all;
}
