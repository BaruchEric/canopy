import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { listRemotes, webUrl } from "./access";

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

const README = /^readme(\.(md|markdown|mdx|rst|txt))?$/i;

/** What a card says about a repo beyond its git state. Both halves are
 *  best-effort: anything unreadable is simply left out. */
export interface RepoMeta {
  link?: string;
  description?: string;
}

async function readDescription(repoPath: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = (await readdir(repoPath, { withFileTypes: true }))
      .filter((e) => e.isFile() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return undefined;
  }
  const byLower = new Map(entries.map((n) => [n.toLowerCase(), n]));
  const read = async (name: string): Promise<string | null> => {
    try {
      // enough for any manifest, and for a README's opening paragraph
      const text = await readFile(join(repoPath, name), "utf8");
      return text.slice(0, 64_000);
    } catch {
      return null;
    }
  };
  for (const m of MANIFESTS) {
    const name = byLower.get(m.file);
    if (!name) continue;
    const text = await read(name);
    const desc = text && m.parse(text);
    if (desc) return desc;
  }
  const readme = entries.find((n) => README.test(n));
  if (readme) {
    const text = await read(readme);
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
  return { ...(link ? { link } : {}), ...(description ? { description } : {}) };
}
