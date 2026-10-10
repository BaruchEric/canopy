/**
 * The command line: canopy's CLI words, typed in the page. This is the pure
 * half (tested in cli.test.ts): splitting a line into words, reading the
 * CLI's own help text for verbs and usage, parsing words into a command,
 * finding the repo a word names, and completing the word being typed.
 * `clirun.ts` carries a command out against the store and the API.
 */

import { HELP_TEXT } from "../../src/core/help";
import { OPENER_IDS, type OpenerId, type Repo, type SpecHalf } from "../../src/core/types";
import type { Line } from "../../src/core/treelines";

/** The transcript's id in the dock. Like "waiting on you" it is no repo's:
 *  a leading slash never starts a repo id, and with no `|` it reads as
 *  home's (see waiting.ts). */
export const CLI_PANEL = "/cli";

export const isCliPanel = (id: string): boolean => id === CLI_PANEL;

export const CLI_NAME = "canopy";

/** the prompt's mark, on the panel's head, its tab and the top bar */
export const CLI_GLYPH = "▸";

/* ---------- words ---------- */

/** A line split as a POSIX shell splits words: blanks separate, single
 *  quotes keep everything, double quotes keep all but `\"` and `\\`.
 *  `open` is the quote left unclosed, if any; the words still come back. */
export function tokenize(line: string): { words: string[]; open: "'" | '"' | null; trailing: boolean } {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === " " || c === "\t") {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      inWord = true;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  const last = line.at(-1);
  return { words, open: quote, trailing: !inWord && (last === " " || last === "\t") };
}

/** a word as the line would need it typed: quoted when it holds a blank or a quote */
export const quoteWord = (w: string): string => (/^[^\s'"\\]+$/.test(w) ? w : `"${w.replace(/["\\]/g, "\\$&")}"`);

/* ---------- the help text ---------- */

export interface HelpEntry {
  /** the first word after `canopy`, "" for the bare tree (`canopy [dir]`) */
  verb: string;
  /** what follows `canopy`: `commit <repo> -m "msg"` */
  usage: string;
  about: string;
  /** the indented lines under it: flags and the rest of the words */
  more: string[];
}

/** The CLI's usage lines, read off HELP_TEXT: an entry per `  canopy …`
 *  line, its words after two or more blanks, and any deeper-indented line
 *  under it kept as `more`. */
export function helpEntries(text: string = HELP_TEXT): HelpEntry[] {
  const out: HelpEntry[] = [];
  for (const raw of text.split("\n")) {
    const m = /^ {2}canopy (\S.*)$/.exec(raw);
    if (m) {
      const [usage = "", ...rest] = m[1]!.split(/\s{2,}/);
      const about = rest.join(" ").trim();
      // `push <repo> | pull <repo>`: two verbs taking the same words share
      // a line; an alternative with other words (`list | show <id>`) is a sub
      const [one = "", ...alts] = usage.trim().split(" | ");
      const [first = "", ...args] = one.split(" ");
      const same = alts.length > 0 && alts.every((a) => a.split(" ").slice(1).join(" ") === args.join(" "));
      for (const u of same ? [one, ...alts] : [usage.trim()]) {
        const verb = u.split(" ")[0] ?? "";
        out.push({ verb: first.startsWith("[") ? "" : verb, usage: u, about, more: [] });
      }
      continue;
    }
    const prev = out.at(-1);
    if (prev && /^ {3,}\S/.test(raw)) prev.more.push(raw.trim().replace(/\s{2,}/, "  "));
  }
  return out;
}

/** the command line's own verbs, which the CLI's help does not list */
const OWN: HelpEntry[] = [
  { verb: "help", usage: "help [verb]", about: "every command, or one verb's", more: [] },
  { verb: "clear", usage: "clear", about: "empty this transcript", more: [] },
];

/** every entry the command line offers: the CLI's, then its own */
export const ENTRIES: readonly HelpEntry[] = [...helpEntries(), ...OWN];

/** the verbs, in the help's order */
export const VERBS: readonly string[] = [...new Set(ENTRIES.map((e) => e.verb).filter((v) => v !== ""))];

/* ---------- commands ---------- */

export type Command =
  | { kind: "tree"; dir: string | null; dirtyOnly: boolean }
  | { kind: "commit"; repo: string; message: string | null; ai: boolean; all: boolean; push: boolean }
  | { kind: "suggest" | "push" | "pull"; repo: string }
  | { kind: "open"; repo: string; app: OpenerId | null }
  | { kind: "launch"; repo: string; more: string[] }
  | { kind: "ws-list" }
  | { kind: "ws-add"; name: string; repos: string[] }
  | { kind: "ws-rm"; name: string; repo: string | null }
  | { kind: "ws-open"; name: string; app: OpenerId }
  | { kind: "source-list" }
  | { kind: "source-add"; dir: string; host: string | null; label: string | null }
  | { kind: "source-forgejo"; url: string; label: string | null }
  | { kind: "source-rm"; id: string }
  | { kind: "peers-status" }
  | { kind: "peers-sync"; repo: string | null }
  | { kind: "peers-take"; repo: string; peer: string; branch: string | null }
  | { kind: "peers-track"; repo: string; peer: string; branch: string }
  | { kind: "peers-seed"; repo: string }
  | { kind: "spec-status"; dir: string | null }
  | { kind: "spec-sync"; repo: string; halves: SpecHalf[] | null }
  | { kind: "spec-check"; repo: string | null }
  | { kind: "version" }
  | { kind: "help"; verb: string | null }
  | { kind: "clear" }
  /** `sprout` is `new`'s words, for the new project form to start from */
  | { kind: "view"; view: "library" | "incubator"; sprout: SproutDraft | null }
  /** a command that belongs in a terminal on the machine, not in a page */
  | { kind: "terminal"; why: string };

/** what `canopy new` was given that a page can carry: the idea, its links
 *  and a repo to start from (files are dropped on the form itself) */
export interface SproutDraft {
  text: string;
  urls: string[];
  repo: string;
}

export type Parsed = Command | { kind: "error"; text: string; usage?: string };

/** the usage line of a verb, or of `verb sub`, for an error to quote */
export function usageOf(verb: string, sub?: string): string | undefined {
  const all = ENTRIES.filter((e) => e.verb === verb);
  const hit = sub === undefined ? all[0] : (all.find((e) => e.usage.split(" ")[1] === sub) ?? all[0]);
  return hit ? `canopy ${hit.usage}` : undefined;
}

/** takes `name` out of `args` when present */
function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

/** takes `name` and the word after it out of `args`; undefined when absent,
 *  null when the flag is there without its value */
function opt(args: string[], name: string): string | null | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [, value] = args.splice(i, 2);
  return value ?? null;
}

const isOpener = (v: string): v is OpenerId => (OPENER_IDS as readonly string[]).includes(v);

const APPS = OPENER_IDS.join(", ");

/** Words to a command. A leading `canopy` is allowed, as typed in a
 *  terminal. Anything the CLI would print usage for comes back as an error
 *  carrying that usage. */
export function parseCommand(input: string[]): Parsed {
  const args = input[0] === "canopy" ? input.slice(1) : [...input];
  const head = args[0];
  const verb = head !== undefined && (VERBS.includes(head) || head === "sources") ? args.shift()! : "";
  const need = (what: string, sub?: string): Parsed => ({ kind: "error", text: `${what} is missing`, usage: usageOf(verb, sub) });
  const app = (): OpenerId | null | Parsed => {
    const v = opt(args, "--app");
    if (v === undefined) return null;
    if (v === null || !isOpener(v)) return { kind: "error", text: `unknown app: ${v ?? "(none)"} (use ${APPS})` };
    return v;
  };
  switch (verb) {
    case "":
    case "tree":
      if (head !== undefined && verb === "" && head.startsWith("-")) return { kind: "error", text: `unknown command: ${head}`, usage: "canopy help" };
      return { kind: "tree", dir: args[0] ?? null, dirtyOnly: false };
    case "status":
      return { kind: "tree", dir: args[0] ?? null, dirtyOnly: true };
    case "clear":
      return { kind: "clear" };
    case "commit": {
      const ai = flag(args, "--ai");
      const all = flag(args, "--all");
      const push = flag(args, "--push");
      const m = opt(args, "-m");
      const repo = args[0];
      if (repo === undefined) return need("the repo");
      if (m === null || (m === undefined && !ai)) return { kind: "error", text: 'a message is missing: -m "msg", or --ai for a suggested one', usage: usageOf("commit") };
      return { kind: "commit", repo, message: m ?? null, ai, all, push };
    }
    case "suggest":
    case "push":
    case "pull": {
      const repo = args[0];
      return repo === undefined ? need("the repo") : { kind: verb, repo };
    }
    case "open": {
      const a = app();
      if (a !== null && typeof a !== "string") return a;
      const repo = args[0];
      return repo === undefined ? need("the repo") : { kind: "open", repo, app: a };
    }
    case "launch": {
      const repo = args.shift();
      return repo === undefined ? need("the repo") : { kind: "launch", repo, more: args };
    }
    case "ws": {
      const sub = args.shift();
      if (sub === undefined) return { kind: "ws-list" };
      if (sub === "create" || sub === "add") {
        const [name, ...repos] = args;
        if (name === undefined) return need("the workspace's name", sub);
        if (repos.length === 0) return need("a repo", sub);
        return { kind: "ws-add", name, repos };
      }
      if (sub === "rm") {
        const [name, repo] = args;
        return name === undefined ? need("the workspace's name", sub) : { kind: "ws-rm", name, repo: repo ?? null };
      }
      if (sub === "open") {
        const a = app();
        if (a !== null && typeof a !== "string") return a;
        const name = args[0];
        return name === undefined ? need("the workspace's name", sub) : { kind: "ws-open", name, app: a ?? "code" };
      }
      return { kind: "error", text: `unknown ws command: ${sub}`, usage: "canopy ws create | add | rm | open" };
    }
    case "source":
    case "sources": {
      const sub = args.shift();
      if (sub === undefined) return { kind: "source-list" };
      if (sub === "add") {
        const forgejo = opt(args, "--forgejo");
        const host = opt(args, "--host");
        const label = opt(args, "--label");
        if (opt(args, "--token") !== undefined) {
          return { kind: "terminal", why: "a Forgejo token file is read on the backend's machine: add it with canopy source add --forgejo <url> --token <file> there" };
        }
        if (forgejo !== undefined) {
          return forgejo === null ? need("the Forgejo's url", "add") : { kind: "source-forgejo", url: forgejo, label: label ?? null };
        }
        const dir = args[0];
        if (dir === undefined) return need("the folder", "add");
        // the page cannot resolve a relative folder on the backend's disk
        if (host === undefined && !dir.startsWith("/") && !dir.startsWith("~")) {
          return { kind: "error", text: `${dir} is relative: give the folder from / or ~ on the backend's machine`, usage: usageOf("source", "add") };
        }
        return { kind: "source-add", dir, host: host ?? null, label: label ?? null };
      }
      if (sub === "rm") {
        const id = args[0];
        return id === undefined ? need("the source's id", "rm") : { kind: "source-rm", id };
      }
      return { kind: "error", text: `unknown source command: ${sub}`, usage: "canopy source | source add | source rm" };
    }
    case "peers": {
      const sub = args.shift() ?? "status";
      const [repo, peer, branch] = args;
      switch (sub) {
        case "status":
          return { kind: "peers-status" };
        case "sync":
          return { kind: "peers-sync", repo: repo ?? null };
        case "take":
          if (repo === undefined) return need("the repo", sub);
          if (peer === undefined) return need("the peer", sub);
          return { kind: "peers-take", repo, peer, branch: branch ?? null };
        case "track":
          if (repo === undefined) return need("the repo", sub);
          if (peer === undefined) return need("the peer", sub);
          if (branch === undefined) return need("the branch", sub);
          return { kind: "peers-track", repo, peer, branch };
        case "seed":
          return repo === undefined ? need("the repo", sub) : { kind: "peers-seed", repo };
        case "init":
          return { kind: "terminal", why: "peers init sets a git remote in every repo on the machine: run canopy peers init in a terminal there" };
        case "gate":
          return { kind: "terminal", why: "peers gate is what a peer's ssh key runs on this machine, never something to type" };
      }
      return { kind: "error", text: `unknown peers command: ${sub}`, usage: "canopy peers status | sync | take | track | seed" };
    }
    case "spec": {
      const sub = args.shift() ?? "status";
      if (sub === "status") return { kind: "spec-status", dir: args[0] ?? null };
      if (sub === "check") return { kind: "spec-check", repo: args[0] ?? null };
      if (sub === "sync") {
        const visual = flag(args, "--visual");
        const doc = flag(args, "--doc");
        if (visual && doc) return { kind: "error", text: "pass --visual or --doc, not both", usage: usageOf("spec", "sync") };
        const repo = args[0];
        if (repo === undefined) return need("the repo", "sync");
        return { kind: "spec-sync", repo, halves: visual ? ["doc", "visual"] : doc ? ["doc"] : null };
      }
      return { kind: "error", text: `unknown spec command: ${sub}`, usage: "canopy spec status | sync | check" };
    }
    case "version":
      return { kind: "version" };
    case "help":
      return { kind: "help", verb: args[0] ?? null };
    case "library":
      return { kind: "view", view: "library", sprout: null };
    case "incubator":
      return { kind: "view", view: "incubator", sprout: null };
    case "new": {
      const words: string[] = [];
      const urls: string[] = [];
      let repo = "";
      for (let i = 0; i < args.length; i++) {
        const a = args[i] ?? "";
        if (a !== "--file" && a !== "--url" && a !== "--repo" && a !== "--backend") {
          words.push(a);
          continue;
        }
        const v = args[++i];
        if (v === undefined) return { kind: "error", text: `${a} needs a value`, usage: usageOf("new") };
        if (a === "--file") return { kind: "error", text: "a page cannot read a file by its path: drop the file on the new project form", usage: usageOf("new") };
        if (a === "--backend") return { kind: "error", text: "pick the backend on the new project form", usage: usageOf("new") };
        if (a === "--url") urls.push(v);
        else repo = v;
      }
      return { kind: "view", view: "incubator", sprout: { text: words.join(" ").trim(), urls, repo } };
    }
    case "ui":
      return { kind: "terminal", why: "this page is canopy ui already" };
    case "helper":
      return { kind: "terminal", why: "canopy helper runs on the machine whose desktop it lends: start it in a terminal there" };
  }
  return { kind: "error", text: `unknown command: ${verb}`, usage: "canopy help" };
}

/* ---------- repos by word ---------- */

/** The repo a typed word names: its id exactly, else the one repo with
 *  that name, else the one whose id ends in `/<word>`, else (when `prefix`
 *  allows it, for commands that only read) the one whose id or name starts
 *  with it. Several matches name none, and the error lists them. */
export function findRepo(word: string, repos: readonly Repo[], opts: { prefix: boolean } = { prefix: true }): { repo: Repo } | { error: string } {
  const exact = repos.find((r) => r.id === word);
  if (exact) return { repo: exact };
  const lower = word.toLowerCase();
  const picks = [
    (r: Repo) => r.name.toLowerCase() === lower,
    (r: Repo) => r.id.toLowerCase().endsWith(`/${lower}`),
    (r: Repo) => r.id.toLowerCase().startsWith(lower) || r.name.toLowerCase().startsWith(lower),
  ];
  for (const [i, pick] of picks.entries()) {
    const hits = repos.filter(pick);
    // a command that changes a repo takes no guess at which one was meant
    if (i === 2 && !opts.prefix) {
      return { error: `no repo here is called ${word}${hits.length === 1 ? `: did you mean ${hits[0]?.id}?` : ""}` };
    }
    if (hits.length === 1) return { repo: hits[0]! };
    if (hits.length > 1) return { error: `${word} names ${hits.length} repos: ${hits.slice(0, 6).map((r) => r.id).join(", ")}${hits.length > 6 ? ", …" : ""}` };
  }
  return { error: `no repo here is called ${word}` };
}

/** the repos under a `[dir]` word: the id itself and everything below it */
export function underDir(dir: string | null, repos: readonly Repo[]): Repo[] {
  if (dir === null || dir === "." || dir === "") return [...repos];
  const d = dir.replace(/\/+$/, "");
  return repos.filter((r) => r.id === d || r.id.startsWith(`${d}/`) || r.id.startsWith(`${d}:`));
}

/* ---------- completion ---------- */

/** what a position in a command expects */
type Slot = "repo" | "dir" | "ws" | "source" | "peer" | "verb" | "app" | "none";

/** the subcommands of the verbs that have them */
const SUBS: Record<string, readonly string[]> = {
  ws: ["create", "add", "rm", "open"],
  source: ["add", "rm"],
  peers: ["status", "sync", "take", "track", "seed"],
  spec: ["status", "sync", "check"],
};

/** the flags a verb (or `verb sub`) takes */
const FLAGS: Record<string, readonly string[]> = {
  commit: ["-m", "--ai", "--all", "--push"],
  open: ["--app"],
  "ws open": ["--app"],
  "spec sync": ["--visual", "--doc"],
  "source add": ["--host", "--label", "--forgejo"],
};

/** the slots after the verb (and its sub), in order; the last repeats when
 *  it ends in "…" */
const SLOTS: Record<string, readonly Slot[]> = {
  "": ["dir"],
  tree: ["dir"],
  status: ["dir"],
  commit: ["repo"],
  suggest: ["repo"],
  push: ["repo"],
  pull: ["repo"],
  open: ["repo"],
  launch: ["repo"],
  "ws create": ["ws", "repo", "repo", "repo", "repo", "repo", "repo", "repo", "repo"],
  "ws add": ["ws", "repo", "repo", "repo", "repo", "repo", "repo", "repo", "repo"],
  "ws rm": ["ws", "repo"],
  "ws open": ["ws"],
  "source rm": ["source"],
  "source add": ["none"],
  "peers sync": ["repo"],
  "peers take": ["repo", "peer"],
  "peers track": ["repo", "peer"],
  "peers seed": ["repo"],
  "spec status": ["dir"],
  "spec sync": ["repo"],
  "spec check": ["repo"],
  help: ["verb"],
};

/** what the completer can offer, from the store */
export interface CompleteCtx {
  repos: readonly Repo[];
  workspaces: readonly string[];
  sources: readonly string[];
  peers: readonly string[];
}

export interface Suggestion {
  /** the word that replaces the one being typed */
  value: string;
  /** a few words beside it: a verb's usage, a repo's branch */
  hint: string;
  /** a repo suggestion's id, for its status mark */
  repo?: string;
}

const LIMIT = 8;

/** The words that could finish the word at the end of `line`, best first,
 *  and the ghost: the rest of the first one, shown after the caret. */
export function complete(line: string, ctx: CompleteCtx): { word: string; options: Suggestion[]; ghost: string } {
  const { words, open, trailing } = tokenize(line);
  const done = trailing || words.length === 0 ? words : words.slice(0, -1);
  const word = trailing || words.length === 0 ? "" : (words.at(-1) ?? "");
  const none = { word, options: [], ghost: "" };
  if (open) return none;
  const head = done[0] === "canopy" ? done.slice(1) : done;
  const lower = word.toLowerCase();
  const starts = (v: string) => v.toLowerCase().startsWith(lower);

  let options: Suggestion[] = [];
  if (head.length === 0) {
    const entries = ENTRIES;
    options = VERBS.filter(starts).map((v) => ({ value: v, hint: entries.find((e) => e.verb === v)?.about ?? "" }));
  } else {
    const verb = head[0]!;
    const subs = SUBS[verb];
    const hasSub = subs !== undefined;
    if (hasSub && head.length === 1) {
      const entries = ENTRIES.filter((e) => e.verb === verb);
      options = subs.filter(starts).map((s) => ({ value: s, hint: entries.find((e) => e.usage.split(" ")[1] === s)?.about ?? "" }));
    } else {
      const key = hasSub ? `${verb} ${head[1]}` : verb;
      const rest = head.slice(hasSub ? 2 : 1);
      const prev = rest.at(-1);
      if (prev === "--app") {
        options = OPENER_IDS.filter(starts).map((a) => ({ value: a, hint: "" }));
      } else if (prev === "-m" || prev === "--host" || prev === "--label" || prev === "--forgejo") {
        options = [];
      } else if (word.startsWith("-")) {
        options = (FLAGS[key] ?? []).filter((f) => starts(f) && !rest.includes(f)).map((f) => ({ value: f, hint: "" }));
      } else {
        const positional = rest.filter((w, i) => !w.startsWith("-") && !["-m", "--app", "--host", "--label", "--forgejo"].includes(rest[i - 1] ?? ""));
        const slot = SLOTS[key]?.[positional.length] ?? "none";
        options = fill(slot, word, ctx);
      }
    }
  }
  options = options.slice(0, LIMIT);
  const first = options[0];
  // nothing typed yet: the list is a menu, and a ghost would sit on the placeholder
  const ghost = first && line.trim() !== "" && starts(first.value) ? first.value.slice(word.length) : "";
  return { word, options, ghost };
}

function fill(slot: Slot, word: string, ctx: CompleteCtx): Suggestion[] {
  const lower = word.toLowerCase();
  const starts = (v: string) => v.toLowerCase().startsWith(lower);
  switch (slot) {
    case "repo": {
      // the id's start first, then the name's, then the name anywhere
      const by = [
        (r: Repo) => starts(r.id),
        (r: Repo) => starts(r.name),
        (r: Repo) => lower !== "" && r.name.toLowerCase().includes(lower),
      ];
      const seen = new Set<string>();
      const out: Suggestion[] = [];
      for (const pick of by) {
        for (const r of ctx.repos) {
          if (out.length >= LIMIT || seen.has(r.id) || !pick(r)) continue;
          seen.add(r.id);
          out.push({ value: r.id, hint: r.status?.branch ?? "", repo: r.id });
        }
      }
      return out;
    }
    case "dir": {
      const groups = [...new Set(ctx.repos.map((r) => r.group).filter((g): g is string => !!g))].sort();
      return groups.filter(starts).map((g) => ({ value: g, hint: `${ctx.repos.filter((r) => r.group === g).length} repos` }));
    }
    case "ws":
      return ctx.workspaces.filter(starts).map((w) => ({ value: w, hint: "workspace" }));
    case "source":
      return ctx.sources.filter(starts).map((s) => ({ value: s, hint: "source" }));
    case "peer":
      return ctx.peers.filter(starts).map((p) => ({ value: p, hint: "peer" }));
    case "verb":
      return VERBS.filter(starts).map((v) => ({ value: v, hint: "" }));
    case "app":
    case "none":
      return [];
  }
}

/** the line with the word at its end swapped for `value`, and a blank after */
export function accept(line: string, value: string): string {
  const { words, trailing } = tokenize(line);
  if (trailing || words.length === 0) return `${line}${quoteWord(value)} `;
  // the last word as typed may be quoted; cut back to the blank before it
  const cut = Math.max(line.lastIndexOf(" "), line.lastIndexOf("\t")) + 1;
  return `${line.slice(0, cut)}${quoteWord(value)} `;
}

/* ---------- the transcript ---------- */

export type CliStatus = "running" | "ok" | "error";

/** one command in the transcript and what it printed */
export interface CliEntry {
  id: number;
  line: string;
  at: number;
  status: CliStatus;
  out: Line[];
}

/** how many commands the transcript keeps, newest last */
export const CLI_KEEP = 60;

/** a command's lines for the up-arrow, newest first, repeats dropped */
export function recall(entries: readonly CliEntry[]): string[] {
  const out: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const l = entries[i]!.line;
    if (!out.includes(l)) out.push(l);
  }
  return out;
}
