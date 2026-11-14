/** `canopy new`'s and `canopy incubator add`'s arguments, read without
 *  touching the disk or the network. */
import { verbHelp } from "../core/help";
import { githubRepo, repoPage, urlWithoutSecret } from "../core/sprout";
import { apiBase } from "./api";

/** what a project's intake takes from the command line */
export interface IntakeArgs {
  text: string;
  files: string[];
  urls: string[];
  repo?: string;
  /** how a lone url was taken, and the flag that takes it the other way */
  note?: string;
}

export interface NewArgs extends IntakeArgs {
  backend: string;
}

export const NEW_USAGE = verbHelp("new") ?? 'usage: canopy new "<idea>" [--file f]... [--url u]... [--repo url] [--backend URL]';
export const ADD_USAGE = 'usage: canopy incubator add <id> ["<words>"] [--file f]... [--url u]...';

/** a url `git clone` takes as a repo: a GitHub repo or a page inside one
 *  (the server clones the repo it sits in), or any url ending in .git */
const readsAsRepo = (url: string): boolean =>
  githubRepo(url) !== null || repoPage(url) !== null || /^(https?|ssh|git):\/\/\S+\.git\/?$/i.test(url);

const isWebLink = (word: string): boolean => /^https?:\/\/\S+$/i.test(word);

/** The idea's words and the valued flags in `flags`. An unknown `--flag` is
 *  an error with the usage, never part of the idea, and `--` ends the
 *  flags. One url standing alone as the idea is not the idea: it is the
 *  repo when `--repo` is a flag here, none was given and it reads as a repo,
 *  else a link. */
function readIntakeArgs(argv: readonly string[], flags: readonly string[], usage: string): (IntakeArgs & { backend?: string }) | { error: string } {
  const words: string[] = [];
  const files: string[] = [];
  const urls: string[] = [];
  let repo: string | undefined;
  let backend: string | undefined;
  let ended = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (ended || !a.startsWith("--")) {
      words.push(a);
      continue;
    }
    if (a === "--") {
      ended = true;
      continue;
    }
    if (!flags.includes(a)) return { error: `unknown flag ${a}\n${usage}` };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
    i += 1;
    if (a === "--file") files.push(v);
    else if (a === "--url") urls.push(v);
    else if (a === "--repo") repo = v;
    else backend = v;
  }
  const lone = words.length === 1 ? (words[0] ?? "").trim() : "";
  const asRepo = lone !== "" && flags.includes("--repo") && repo === undefined && readsAsRepo(lone);
  if (asRepo || (lone !== "" && isWebLink(lone))) {
    const shown = urlWithoutSecret(lone);
    const repoFlag = flags.includes("--repo");
    const note = asRepo
      ? `took ${shown} as --repo; pass it with --url to give it as a link`
      : repoFlag
        ? `took ${shown} as --url; pass it with --repo to start from it`
        : undefined;
    return {
      text: "",
      files,
      urls: asRepo ? urls : [lone, ...urls],
      ...(asRepo ? { repo: lone } : repo !== undefined ? { repo } : {}),
      ...(backend !== undefined ? { backend } : {}),
      ...(note ? { note } : {}),
    };
  }
  return { text: words.join(" ").trim(), files, urls, ...(repo !== undefined ? { repo } : {}), ...(backend !== undefined ? { backend } : {}) };
}

export function parseNewArgs(argv: string[], env: Record<string, string | undefined>): NewArgs | { error: string } {
  const read = readIntakeArgs(argv, ["--file", "--url", "--repo", "--backend"], NEW_USAGE);
  if ("error" in read) return read;
  const { backend, ...intake } = read;
  const origin = apiBase(backend ?? env["CANOPY_API"]);
  if (!/^https?:\/\/[^/\s]+$/.test(origin)) return { error: `--backend must be an http(s) origin, got ${backend ?? origin}` };
  if (!intake.text && intake.files.length === 0 && intake.urls.length === 0 && !intake.repo) return { error: "give an idea, --file, --url or --repo" };
  return { ...intake, backend: origin };
}

/** `canopy incubator add`'s words and flags, after its id; the backend is the command's */
export function parseAddArgs(argv: readonly string[]): IntakeArgs | { error: string } {
  const read = readIntakeArgs(argv, ["--file", "--url"], ADD_USAGE);
  if ("error" in read) return read;
  if (!read.text && read.files.length === 0 && read.urls.length === 0) return { error: `give words, --file or --url\n${ADD_USAGE}` };
  return read;
}

export const sproutLink = (page: string, id: string): string => `${page.replace(/\/+$/, "")}/?view=incubator&sprout=${id}`;
