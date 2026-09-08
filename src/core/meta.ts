import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { listRemotes, webUrl } from "./access";
import { onHost } from "./exec";
import { parseLocator } from "./host";

/** A card holds one line. Longer than this and it is a paragraph, not a
 *  description. */
export const MAX_DESCRIPTION = 160;

/** Collapse whitespace and cut at a word boundary. */
export function tidy(text: string): string | null {
  const one = text.replace(/\s+/g, " ").trim();
  if (!one) return null;
  if (one.length <= MAX_DESCRIPTION) return one;
  const cut = one.slice(0, MAX_DESCRIPTION);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 60 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, "")}…`;
}

/** package.json, composer.json, deno.json — all spell it the same way. */
export function fromJsonManifest(text: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const desc = (data as { description?: unknown }).description;
  return typeof desc === "string" ? tidy(desc) : null;
}

/** Cargo.toml and pyproject.toml. Only a single-quoted or double-quoted value
 *  on its own line — a multi-line TOML string is a paragraph anyway. */
export function fromTomlManifest(text: string): string | null {
  const m = /^[ \t]*description[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)')[ \t]*$/m.exec(
    text,
  );
  const value = m?.[1] ?? m?.[2];
  return value ? tidy(value) : null;
}

/** True for a line that carries no prose: a heading, a rule, a table row, raw
 *  HTML, or a row of badges. Third-party READMEs open with several of these
 *  in a row, and a card showing markup soup is worse than a card showing
 *  nothing. */
function isChrome(line: string): boolean {
  if (/^(#|>|<|\||:::)/.test(line)) return true;
  if (/^([-*_=])\1{2,}$/.test(line.replace(/\s/g, ""))) return true;
  if (/^([-*+]|\d+[.)])\s/.test(line)) return true;
  // a link reference definition — [label]: https://…
  if (/^\[[^\]]+\]:\s*\S+$/.test(line)) return true;
  // strip images, links and inline HTML; what is left has to say something
  const bare = line
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .trim();
  if (!/[A-Za-z]{3}/.test(bare)) return true;
  // a row of links with a word or two of glue is a table of contents
  const links = line.match(/\[[^\]]*\]\([^)]*\)/g)?.length ?? 0;
  return links >= 2 && (bare.match(/[A-Za-z]/g)?.length ?? 0) < 12;
}

export function fromReadme(text: string): string | null {
  const lines = text.split("\n");
  let i = 0;
  // YAML frontmatter
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && lines[i]?.trim() !== "---") i++;
    i++;
  }
  let fenced = false;
  for (; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line || isChrome(line)) continue;
    // an underlined setext heading is a title, not a description
    if (/^([-=])\1{2,}$/.test((lines[i + 1] ?? "").trim())) continue;
    // Take the whole paragraph, not the line: a hard-wrapped README would
    // otherwise leave the description cut off at the author's margin.
    const para: string[] = [];
    for (let j = i; j < lines.length; j++) {
      const next = (lines[j] ?? "").trim();
      if (!next || isChrome(next) || /^(```|~~~)/.test(next)) break;
      para.push(next);
    }
    const prose = para
      .join(" ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, "")
      .replace(/[`*_]/g, "")
      .trim();
    const one = tidy(prose);
    if (one) return one;
  }
  return null;
}

const MANIFESTS: { file: string; parse: (text: string) => string | null }[] = [
  { file: "package.json", parse: fromJsonManifest },
  { file: "cargo.toml", parse: fromTomlManifest },
  { file: "pyproject.toml", parse: fromTomlManifest },
  { file: "composer.json", parse: fromJsonManifest },
];

const README_NAMES = [
  "readme",
  "readme.md",
  "readme.markdown",
  "readme.mdx",
  "readme.rst",
  "readme.txt",
];

/** Every file a description can come from, lowercased. */
const CANDIDATES = [...MANIFESTS.map((m) => m.file), ...README_NAMES];

/** enough for any manifest, and for a README's opening paragraph */
const READ_LIMIT = 64_000;

/** What a card says about a repo beyond its git state. Both halves are
 *  best-effort: anything unreadable is simply left out. */
export interface RepoMeta {
  link?: string;
  description?: string;
  /** every remote's url, in `git config` order; the same read the link comes
   *  from, kept so a repo can be matched against the same repo on a forge */
  remotes?: string[];
}

/** The candidate files a repo has, keyed by lowercased name. */
async function readCandidatesLocal(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const lower = e.name.toLowerCase();
    if (!CANDIDATES.includes(lower) || !(e.isFile() || e.isSymbolicLink())) continue;
    try {
      const text = await readFile(join(dir, e.name), "utf8");
      out.set(lower, text.slice(0, READ_LIMIT));
    } catch {
      // unreadable: leave it out
    }
  }
  return out;
}

/** One ssh round trip for every candidate: `find` names them, and a tiny
 *  shell prints each as `name\n<head>\n\0`. */
export function remoteCandidatesCommand(dir: string): string[] {
  const names = CANDIDATES.flatMap((n, i) =>
    i === 0 ? ["-iname", n] : ["-o", "-iname", n],
  );
  return [
    "find",
    dir,
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    "(",
    "-type",
    "f",
    "-o",
    "-type",
    "l",
    ")",
    "(",
    ...names,
    ")",
    "-exec",
    "sh",
    "-c",
    `printf '%s\\n' "$1"; head -c ${READ_LIMIT} -- "$1"; printf '\\n\\0'`,
    "_",
    "{}",
    ";",
  ];
}

/** Undo the packing above: name, newline, text, then a NUL per file. */
export function parseRemoteCandidates(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of text.split("\0")) {
    const nl = chunk.indexOf("\n");
    if (nl === -1) continue;
    const name = chunk.slice(0, nl).split("/").pop() ?? "";
    if (!name) continue;
    out.set(name.toLowerCase(), chunk.slice(nl + 1).replace(/\n$/, ""));
  }
  return out;
}

async function readCandidatesRemote(
  host: string,
  dir: string,
): Promise<Map<string, string>> {
  const r = await onHost(host, remoteCandidatesCommand(dir), { timeoutMs: 30_000 });
  return parseRemoteCandidates(r.stdout);
}

async function readDescription(repoPath: string): Promise<string | undefined> {
  const { host, path } = parseLocator(repoPath);
  const files =
    host === null
      ? await readCandidatesLocal(path)
      : await readCandidatesRemote(host, path);
  for (const m of MANIFESTS) {
    const text = files.get(m.file);
    const desc = text && m.parse(text);
    if (desc) return desc;
  }
  for (const name of README_NAMES) {
    const text = files.get(name);
    const desc = text && fromReadme(text);
    if (desc) return desc;
  }
  return undefined;
}

/** origin wins, then upstream, then whatever is configured — the same order a
 *  person would read the remotes in. */
export function pickLink(remotes: { name: string; url: string }[]): string | undefined {
  const order = [...remotes].sort(
    (a, b) => rank(a.name) - rank(b.name),
  );
  for (const r of order) {
    const url = webUrl(r.url);
    if (url) return url;
  }
  return undefined;
}

const rank = (name: string): number =>
  name === "origin" ? 0 : name === "upstream" ? 1 : 2;

export async function readMeta(repoPath: string): Promise<RepoMeta> {
  const [remotes, description] = await Promise.all([
    listRemotes(repoPath).catch(() => []),
    readDescription(repoPath),
  ]);
  const link = pickLink(remotes);
  const urls = remotes.map((r) => r.url);
  return {
    ...(link ? { link } : {}),
    ...(description ? { description } : {}),
    ...(urls.length ? { remotes: urls } : {}),
  };
}
