/** A permission prompt in plain words, for the human deciding on it: what a
 *  shell command does, step by step, and the few things worth a second look
 *  (it deletes, writes, reaches the network, runs code, commits or pushes,
 *  or works outside the project). Pure and browser-safe: no LLM, no node
 *  imports. The reading is a guide, never a guarantee; the raw command
 *  stays on screen beside it. */

/** What a human deciding on a prompt would want flagged, in the order shown. */
export const EXPLAIN_FLAGS = ["deletes", "push", "commit", "outside", "network", "writes", "code"] as const;
export type ExplainFlag = (typeof EXPLAIN_FLAGS)[number];

export const FLAG_WORDS: Record<ExplainFlag, string> = {
  deletes: "deletes",
  push: "pushes or publishes",
  commit: "git commit",
  outside: "outside the project",
  network: "network",
  writes: "writes files",
  code: "runs code",
};

export interface Explained {
  /** one line, lower case: "lists files in src and reads 3 files" */
  says: string;
  flags: ExplainFlag[];
  /** canopy has no reading of its own for some step ("runs frobnicate"),
   *  so the raw command shows unfolded */
  vague?: true;
}

/* ---------- splitting: a command line into its simple commands ---------- */

/** One simple command of a line: its words, the files its redirects write
 *  and read, and a heredoc's body when it has one. */
export interface SimpleCommand {
  words: string[];
  writes: string[];
  reads: string[];
  heredoc?: string;
}

type Token =
  | { t: "word"; v: string }
  | { t: "sep" }
  | { t: "redir"; op: string }
  | { t: "heredoc"; body: string };

/** The text up to the `)` that closes a `$(` opened just before `from`,
 *  quotes respected; the end index is past the `)`. */
function closeParen(s: string, from: number): { inner: string; end: number } {
  let depth = 1;
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      i = close === -1 ? s.length : close + 1;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") {
      depth--;
      if (depth === 0) return { inner: s.slice(from, i), end: i + 1 };
    }
    i++;
  }
  return { inner: s.slice(from), end: s.length };
}

/** Tokens of a command line, tolerant: an unclosed quote runs to the end,
 *  and nothing makes it give up. Substitutions' inner text goes to `subs`. */
function tokenize(s: string, subs: string[]): Token[] {
  const out: Token[] = [];
  let word = "";
  let inWord = false;
  /** heredoc delimiters waiting for the end of their line */
  const pending: { delim: string; strip: boolean }[] = [];
  let wantDelim: boolean | null = null;
  const end = () => {
    if (!inWord) return;
    if (wantDelim !== null) {
      pending.push({ delim: word, strip: wantDelim });
      wantDelim = null;
    } else out.push({ t: "word", v: word });
    word = "";
    inWord = false;
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i] ?? "";
    const next = s[i + 1] ?? "";
    if (ch === "\\" && next === "\n") {
      i += 2;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      end();
      i++;
      continue;
    }
    if (ch === "\n") {
      end();
      i++;
      // a heredoc's body runs from here to its delimiter's own line
      for (const h of pending.splice(0)) {
        const body: string[] = [];
        while (i < s.length) {
          const nl = s.indexOf("\n", i);
          const line = nl === -1 ? s.slice(i) : s.slice(i, nl);
          i = nl === -1 ? s.length : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          body.push(line);
        }
        out.push({ t: "heredoc", body: body.join("\n") });
      }
      out.push({ t: "sep" });
      continue;
    }
    if (ch === "#" && !inWord) {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl;
      continue;
    }
    if (ch === "'") {
      const close = s.indexOf("'", i + 1);
      word += close === -1 ? s.slice(i + 1) : s.slice(i + 1, close);
      inWord = true;
      i = close === -1 ? s.length : close + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      inWord = true;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length) {
          word += s[i + 1];
          i += 2;
          continue;
        }
        word += s[i];
        i++;
      }
      i++;
      continue;
    }
    if (ch === "\\") {
      word += next;
      inWord = true;
      i += 2;
      continue;
    }
    if (ch === "$" && next === "(") {
      const { inner, end: e } = closeParen(s, i + 2);
      subs.push(inner);
      word += "$(…)";
      inWord = true;
      i = e;
      continue;
    }
    if (ch === "`") {
      const close = s.indexOf("`", i + 1);
      subs.push(close === -1 ? s.slice(i + 1) : s.slice(i + 1, close));
      word += "`…`";
      inWord = true;
      i = close === -1 ? s.length : close + 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "(" || ch === ")") {
      end();
      out.push({ t: "sep" });
      i += ch === "|" && next === "|" ? 2 : 1;
      continue;
    }
    if (ch === "&") {
      if (next === ">") {
        end();
        const op = s[i + 2] === ">" ? "&>>" : "&>";
        out.push({ t: "redir", op });
        i += op.length;
        continue;
      }
      end();
      out.push({ t: "sep" });
      i += next === "&" ? 2 : 1;
      continue;
    }
    if (ch === ">" || ch === "<") {
      // a file descriptor written right before it is part of the redirect
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else end();
      const op = /^(<<<|<<-|<<|>>|>&|<&|>\||>|<)/.exec(s.slice(i))?.[0] ?? ch;
      i += op.length;
      if (op === "<<" || op === "<<-") wantDelim = op === "<<-";
      else out.push({ t: "redir", op });
      continue;
    }
    word += ch;
    inWord = true;
    i++;
  }
  end();
  // a heredoc whose line never ended has no body
  for (let k = 0; k < pending.length; k++) out.push({ t: "heredoc", body: "" });
  return out;
}

/** A command line as its simple commands, in order, those inside `$(…)`
 *  and backticks after them. Never fails: what it cannot read it skips. */
export function splitShell(line: string): SimpleCommand[] {
  const subs: string[] = [];
  const tokens = tokenize(line, subs);
  const out: SimpleCommand[] = [];
  let cur: SimpleCommand = { words: [], writes: [], reads: [] };
  const flush = () => {
    if (cur.words.length || cur.writes.length || cur.heredoc !== undefined) out.push(cur);
    cur = { words: [], writes: [], reads: [] };
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    if (tok.t === "sep") flush();
    else if (tok.t === "heredoc") {
      // the body belongs to the command that opened it, already flushed
      // when the line ended
      const owner = cur.words.length ? cur : out[out.length - 1];
      if (owner) owner.heredoc = tok.body;
    } else if (tok.t === "redir") {
      const target = tokens[i + 1];
      if (target?.t !== "word") continue;
      i++;
      if (tok.op === ">&" || tok.op === "<&" || tok.op === "<<<") continue;
      if (tok.op.includes(">")) cur.writes.push(target.v);
      else cur.reads.push(target.v);
    } else cur.words.push(tok.v);
  }
  flush();
  for (const sub of subs) out.push(...splitShell(sub));
  return out;
}

/* ---------- paths: what is inside the project ---------- */

/** `p` against `base`, `.` and `..` folded, no trailing slash. */
function norm(p: string, base: string): string {
  const parts: string[] = [];
  for (const seg of (p.startsWith("/") ? p : `${base}/${p}`).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

const inside = (p: string, root: string): boolean => p === root || p.startsWith(root === "/" ? "/" : `${root}/`);

/** where paths are judged from: the project's folder and where the command is */
interface Where {
  root: string | null;
  cwd: string;
}

/** A path as the line shows it: under the project, from its folder; else
 *  as the command wrote it. */
function shown(p: string, w: Where): string {
  if (p.startsWith("~")) return clipPath(p);
  const abs = norm(p, w.cwd);
  // after a `cd ~`, home is HOME, whatever its path
  if (abs === HOME || abs.startsWith(`${HOME}/`)) return clipPath(`~${abs.slice(HOME.length)}`);
  if (!w.root) return clipPath(p);
  if (inside(abs, w.root)) return clipPath(abs === w.root ? "." : abs.slice(w.root.length + 1));
  return clipPath(p.startsWith("/") ? p : abs);
}

/** where a `cd ~` lands: a stand-in for the home folder, never inside a project */
const HOME = "/~home";

const clipPath = (p: string): string => (p.length > 48 ? `…${p.slice(-47)}` : p);

/** Whether a word names a place outside the project. */
function outsidePath(p: string, w: Where): boolean {
  if (!w.root || p.includes("://")) return false;
  if (p.startsWith("~")) return true;
  if (/^\/dev\/(null|stdout|stderr|stdin|fd\/\d+|tty)$/.test(p)) return false;
  return !inside(norm(p, w.cwd), w.root);
}

/** A word that looks like a path a command reaches, worth an outside check. */
const pathy = (word: string): boolean => /^(\/|~|\.\.(\/|$))/.test(word);

/* ---------- reading one simple command ---------- */

interface Part {
  /** parts with the same key fold into one: "reads 3 files" */
  key: string;
  one: string;
  many?: (n: number) => string;
  flags?: ExplainFlag[];
  /** no reading of canopy's own: the program's name and nothing more */
  vague?: true;
}

const part = (key: string, one: string, many?: (n: number) => string, flags?: ExplainFlag[]): Part => ({
  key,
  one,
  ...(many ? { many } : {}),
  ...(flags?.length ? { flags } : {}),
});

/** a step canopy only names: the raw command says more */
const vaguePart = (key: string, one: string, flags?: ExplainFlag[]): Part => ({ ...part(key, one, undefined, flags), vague: true });

/** only flags, no words: what a step also does */
const flagPart = (...flags: ExplainFlag[]): Part => part("", "", undefined, flags);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Non-flag words, skipping the value of each option in `takes`. */
function operands(args: readonly string[], takes: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("-") && a !== "-") {
      if (takes.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const host = (url: string): string => /^[a-z]+:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url;

/** "Python", "Node": the interpreter's name in a line */
const LANG: Record<string, string> = {
  python: "Python",
  python3: "Python",
  node: "Node",
  ruby: "Ruby",
  perl: "Perl",
  php: "PHP",
  deno: "Deno",
  osascript: "AppleScript",
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);
const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "nice", "timeout", "command", "exec", "doas", "stdbuf"]);

/** What a short program with nothing much to say does, and no flags. */
const QUIET: Record<string, string> = {
  pwd: "prints the folder",
  whoami: "prints the user",
  id: "prints the user",
  date: "prints the date",
  hostname: "prints the host name",
  uname: "reads system info",
  df: "reads disk usage",
  du: "reads folder sizes",
  printenv: "reads the environment",
  which: "looks up a program",
  type: "looks up a program",
  ps: "reads the process list",
  lsof: "reads open files",
  uptime: "reads system info",
  sleep: "waits",
  tsc: "type-checks",
  stat: "reads file info",
  file: "reads file info",
  realpath: "reads file info",
  readlink: "reads file info",
  basename: "reads file info",
  dirname: "reads file info",
  diff: "compares files",
  cmp: "compares files",
  md5sum: "checksums files",
  shasum: "checksums files",
  sha256sum: "checksums files",
  sort: "filters output",
  uniq: "filters output",
  cut: "filters output",
  tr: "filters output",
  jq: "filters output",
  awk: "filters output",
  column: "filters output",
  base64: "reads file bytes",
  xxd: "reads file bytes",
  od: "reads file bytes",
  hexdump: "reads file bytes",
  strings: "reads file bytes",
  kill: "stops a process",
  pkill: "stops a process",
  killall: "stops a process",
  pbcopy: "copies to the clipboard",
};

/** Words that do nothing worth saying. */
const SILENT = new Set(["true", "false", "test", "[", "[[", ":", "set", "export", "local", "shift", "exit", "return", "wait"]);

const READERS = new Set(["cat", "less", "more", "bat", "nl"]);

/** what a `find -exec` deletes with */
const REMOVERS = new Set(["rm", "rmdir", "unlink", "shred", "trash"]);

function gitPart(args: readonly string[], w: Where, who: string | null): Part[] {
  let i = 0;
  let as = who;
  const parts: Part[] = [];
  // options before the subcommand
  while (i < args.length && (args[i] ?? "").startsWith("-")) {
    const a = args[i] ?? "";
    if (a === "--config-env" || a.startsWith("--config-env=") || a === "--exec-path" || a.startsWith("--exec-path=")) parts.push(flagPart("code"));
    if (a === "-c" || a === "-C") {
      const v = args[i + 1] ?? "";
      if (a === "-c" && v.startsWith("user.name=")) as = v.slice("user.name=".length);
      // any other setting can name a program git runs: an alias, a pager, a hook path
      else if (a === "-c" && !v.startsWith("user.email=")) parts.push(flagPart("code"));
      if (a === "-C" && pathy(v) && outsidePath(v, w)) parts.push(part("outside", "", undefined, ["outside"]));
      i += 2;
      continue;
    }
    i++;
  }
  const sub = args[i] ?? "";
  const rest = args.slice(i + 1);
  const ops = operands(rest, ["-m", "-c", "-C", "-F", "--author", "-b", "-B", "-u"]);
  const authorAt = rest.indexOf("--author");
  const author = rest.find((a) => a.startsWith("--author="))?.slice("--author=".length) ?? (authorAt === -1 ? undefined : rest[authorAt + 1]);
  const g = (key: string, one: string, flags?: ExplainFlag[]) => [...parts, part(`git ${key}`, one, undefined, flags)];
  switch (sub) {
    case "status":
      return g("status", "reads git status");
    case "diff":
    case "show":
      return g("diff", "reads git changes");
    case "log":
    case "shortlog":
    case "reflog":
    case "blame":
      return g("log", "reads git history");
    case "rev-parse":
    case "ls-files":
    case "ls-tree":
    case "cat-file":
    case "describe":
    case "remote":
    case "grep":
      return g("info", "reads git info");
    case "config":
      return rest.some((a) => a === "--get" || a === "--list" || a === "-l") || ops.length < 2 ? g("info", "reads git info") : g("config", "changes git config", ["writes"]);
    case "branch":
    case "tag":
      if (rest.some((a) => a === "-d" || a === "-D" || a === "--delete")) return g(`${sub} delete`, `deletes ${sub}${ops.length ? ` ${ops.join(", ")}` : ""}`, ["deletes"]);
      return ops.length === 0 || rest.some((a) => a === "--list" || a === "-l") ? g(sub, `lists ${sub === "tag" ? "tags" : "branches"}`) : g(sub, `makes a ${sub}`, ["writes"]);
    case "add":
      return g("add", "stages changes", ["writes"]);
    case "commit": {
      const name = author ? author.replace(/\s*<.*$/, "") : as;
      return g("commit", `commits to git${name ? ` as ${name}` : ""}`, ["commit"]);
    }
    case "push":
      return g("push", `pushes to ${ops[0] ?? "the remote"}`, ["push", "network"]);
    case "pull":
      return g("pull", `pulls from ${ops[0] ?? "the remote"}`, ["network", "writes"]);
    case "fetch":
      return g("fetch", `fetches from ${ops[0] ?? "the remote"}`, ["network"]);
    case "clone":
      return g("clone", `clones ${ops[0] ? host(ops[0]) : "a repo"}`, ["network", "writes"]);
    case "checkout":
    case "switch":
    case "restore":
      return g("checkout", "switches branch or restores files", ["writes"]);
    case "reset":
      return g("reset", rest.includes("--hard") ? "resets the branch, dropping changes" : "resets the branch", rest.includes("--hard") ? ["deletes", "writes"] : ["writes"]);
    case "clean":
      return g("clean", "deletes untracked files", ["deletes"]);
    case "rm":
      return g("rm", "removes files from git", ["deletes"]);
    case "mv":
      return g("mv", "moves files in git", ["writes"]);
    case "stash":
      if (ops[0] === "drop") return g("stash drop", "drops a stash", ["deletes"]);
      if (ops[0] === "clear") return g("stash clear", "drops every stash", ["deletes"]);
      return g("stash", "stashes changes", ["writes"]);
    case "merge":
    case "rebase":
    case "cherry-pick":
    case "revert":
    case "am":
    case "apply":
      return g(sub, `${sub === "cherry-pick" ? "cherry-picks" : `${sub}s`}`.replace(/^ams$/, "applies patches").replace(/^applys$/, "applies a patch"), ["writes"]);
    case "init":
    case "worktree":
    case "submodule":
      return g(sub, `runs git ${sub}`, ["writes"]);
    case "":
      return [...parts, vaguePart("git", "runs git")];
    default:
      return [...parts, vaguePart(`git ${sub}`, `runs git ${sub}`)];
  }
}

/** A package manager's line: install, test, a script, a one-off tool. */
function packagePart(prog: string, args: readonly string[]): Part[] {
  const sub = args[0] ?? "";
  const ops = operands(args.slice(1));
  if (["install", "i", "add", "ci", "sync"].includes(sub)) return [part("install", ops.length && sub === "add" ? `adds ${ops.join(", ")}` : "installs packages", undefined, ["network", "writes"])];
  if (["remove", "rm", "uninstall"].includes(sub)) return [part("uninstall", "removes packages", undefined, ["writes"])];
  if (sub === "test" || sub === "t") return [part("test", "runs the tests", undefined, ["code"])];
  if (sub === "run" && ops[0]) return [part(`run ${ops[0]}`, prog === "uv" ? `runs ${ops[0]}` : `runs the ${ops[0]} script`, undefined, ["code"])];
  if (sub === "x" || sub === "dlx" || sub === "exec") return [part(`x ${ops[0] ?? ""}`, `runs ${ops[0] ?? "a tool"} via ${prog}`, undefined, ["code"])];
  if (sub === "pip") return packagePart("pip", args.slice(1));
  if (sub === "build") return [part("build", "builds the project", undefined, ["code"])];
  if (sub === "publish") return [part("publish", "publishes the package", undefined, ["push", "network"])];
  if (sub && !sub.startsWith("-")) return [vaguePart(`${prog} ${sub}`, `runs ${prog} ${sub}`, ["code"])];
  return [vaguePart(prog, `runs ${prog}`, ["code"])];
}

/** What one simple command does, as parts. `w.cwd` moves with a `cd`. */
function commandParts(cmd: SimpleCommand, w: Where, root: string | null): Part[] {
  let words = cmd.words.filter((x) => x !== "");
  let who: string | null = null;
  // env assignments and wrappers run what follows them
  for (;;) {
    const first = words[0] ?? "";
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(first);
    if (assign) {
      if (assign[1] === "GIT_AUTHOR_NAME" || assign[1] === "GIT_COMMITTER_NAME") who = assign[2] ?? null;
      words = words.slice(1);
      continue;
    }
    if (WRAPPERS.has(first)) {
      let k = 1;
      while (k < words.length && ((words[k] ?? "").startsWith("-") || /^[A-Za-z_]\w*=/.test(words[k] ?? "") || (first === "timeout" && /^\d/.test(words[k] ?? "")))) {
        if (first === "sudo" && (words[k] === "-u" || words[k] === "-g")) k++;
        if (first === "nice" && words[k] === "-n") k++;
        k++;
      }
      words = words.slice(k);
      continue;
    }
    break;
  }
  const parts: Part[] = [];
  const flagOutside = (p: string) => {
    if (pathy(p) && outsidePath(p, w)) parts.push(part("outside", "", undefined, ["outside"]));
  };
  for (const t of cmd.writes) {
    if (t.startsWith("/dev/")) continue;
    flagOutside(t);
    parts.push(part("write", `writes ${shown(t, w)}`, (n) => `writes ${plural(n, "file")}`, ["writes"]));
  }
  for (const t of cmd.reads) flagOutside(t);
  const prog = words[0];
  if (prog === undefined) return parts;
  const args = words.slice(1);
  const base = prog.slice(prog.lastIndexOf("/") + 1);
  const ops = (takes?: readonly string[]) => operands(args, takes);

  // interpreters and shells: their snippet is code, never read for paths
  const lang = LANG[base] ?? (SHELLS.has(base) ? "shell" : null);
  if (lang) {
    const inline = args.findIndex((a) => /^-[a-z]*[ce]$/.test(a) || a === "-p");
    if (lang === "shell" && inline !== -1) {
      const script = args[inline + 1] ?? "";
      return [...parts, ...explainParts(script, w, root)];
    }
    const mod = args.indexOf("-m");
    if (mod !== -1 && args[mod + 1]) return [...parts, part(`mod ${args[mod + 1]}`, `runs the ${args[mod + 1]} module with ${lang}`, undefined, ["code"])];
    const file = base === "deno" ? operands(args).find((a) => a !== "run") : operands(args)[0];
    if (inline !== -1 || cmd.heredoc !== undefined || file === undefined || file === "-") {
      return [...parts, part(`snippet ${lang}`, `runs a${/^[AEIOU]/.test(lang) ? "n" : ""} ${lang} snippet`, (n) => `runs ${n} ${lang} snippets`, ["code"])];
    }
    flagOutside(file);
    return [...parts, part(`script ${file}`, `runs ${shown(file, w)} with ${lang === "shell" ? "the shell" : lang}`, undefined, ["code"])];
  }

  if (base === "cd") {
    const to = args[0];
    if (to === "-") return parts;
    w.cwd = to === undefined ? "~" : norm(to, w.cwd);
    if (to === undefined || to.startsWith("~")) {
      w.cwd = norm(`${HOME}/${to?.slice(1) ?? ""}`, "/");
      if (root) parts.push(part("outside", "", undefined, ["outside"]));
      return parts;
    }
    flagOutside(to.startsWith("/") ? to : w.cwd);
    return parts;
  }

  // every other program: its path-like words are checked against the project
  const checkWords = !["echo", "printf"].includes(base);
  if (checkWords) {
    for (const a of args) {
      const v = a.startsWith("--") && a.includes("=") ? a.slice(a.indexOf("=") + 1) : a;
      flagOutside(v);
    }
  }

  if (SILENT.has(base)) return parts;
  if (base === "echo" || base === "printf") return cmd.writes.length ? parts : [...parts, part("print", "prints text")];
  if (base === "ls" || base === "tree" || base === "exa" || base === "eza") {
    const dirs = ops(["-I", "-L", "--ignore"]);
    if (dirs.length === 0) return [...parts, part("list", "lists files", (n) => `lists files ${n} times`)];
    return [...parts, ...dirs.map((d) => part("list", `lists files in ${shown(d, w)}`, (n) => `lists files in ${plural(n, "folder")}`))];
  }
  if (READERS.has(base)) {
    const files = ops();
    if (files.length === 0) return [...parts, part("filter", "filters output")];
    return [...parts, ...files.map((f) => part("read", `reads ${shown(f, w)}`, (n) => `reads ${plural(n, "file")}`))];
  }
  if (base === "head" || base === "tail") {
    const files = ops(["-n", "-c"]).filter((f) => !/^\d+$/.test(f));
    if (files.length === 0) return [...parts, part("filter", "filters output")];
    return [...parts, ...files.map((f) => part("read", `reads ${shown(f, w)}`, (n) => `reads ${plural(n, "file")}`))];
  }
  if (base === "wc") return [...parts, part("count", args.includes("-l") ? "counts lines" : "counts words")];
  if (base === "sed" || (base === "perl" && args.includes("-i"))) {
    const inPlace = args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place");
    if (!inPlace) return [...parts, part("filter", "filters output")];
    const files = ops(["-e", "-f"]).slice(args.some((a) => a === "-e") ? 0 : 1);
    return [...parts, part("edit", `edits ${files.length === 1 ? shown(files[0] ?? "", w) : plural(files.length, "file")} in place`, undefined, ["writes"])];
  }
  if (base === "grep" || base === "rg" || base === "ag" || base === "egrep" || base === "fgrep") {
    const eIdx = args.indexOf("-e");
    const rest = ops(["-e", "-f", "-A", "-B", "-C", "-m", "-g", "-t", "--type", "--glob", "--max-count"]);
    const pattern = eIdx !== -1 ? (args[eIdx + 1] ?? "") : (rest[0] ?? "");
    const where = eIdx !== -1 ? rest : rest.slice(1);
    const pat = pattern.length > 32 ? `${pattern.slice(0, 31)}…` : pattern;
    const tail = where.length === 1 ? ` in ${shown(where[0] ?? "", w)}` : where.length > 1 ? ` in ${plural(where.length, "place")}` : "";
    return [...parts, part("search", `searches for ${pat}${tail}`, (n) => `runs ${n} searches`)];
  }
  if (base === "find" || base === "fd") {
    const start = base === "find" ? args.filter((a, i) => !a.startsWith("-") && args.slice(0, i).every((b) => !b.startsWith("-"))) : [];
    const flags: ExplainFlag[] = [];
    const execAt = args.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-x" || a === "--exec");
    const runs = execAt === -1 ? "" : (args[execAt + 1] ?? "");
    if (args.includes("-delete") || REMOVERS.has(runs.slice(runs.lastIndexOf("/") + 1))) flags.push("deletes");
    if (execAt !== -1) flags.push("code");
    const where = start[0] && start[0] !== "." ? ` in ${shown(start[0], w)}` : "";
    return [...parts, part(`find${where}`, `${flags.includes("deletes") ? "finds and deletes files" : "finds files"}${where}`, undefined, flags)];
  }
  if (base === "rm" || base === "rmdir" || base === "unlink" || base === "trash") {
    const files = ops();
    return [...parts, ...files.map((f) => part("delete", `deletes ${shown(f, w)}`, (n) => `deletes ${plural(n, "file")}`, ["deletes"]))];
  }
  if (base === "shred") return [...parts, ...ops(["-n", "-s"]).map((f) => part("shred", `shreds ${shown(f, w)}`, (n) => `shreds ${plural(n, "file")}`, ["deletes"]))];
  if (base === "truncate") {
    const files = ops(["-s", "-r", "--size", "--reference"]);
    return [...parts, part("truncate", `truncates ${files.length === 1 ? shown(files[0] ?? "", w) : plural(files.length, "file")}`, undefined, ["deletes", "writes"])];
  }
  if (base === "crontab") {
    if (args.includes("-r")) return [...parts, part("crontab -r", "removes the crontab", undefined, ["deletes"])];
    return [...parts, args.includes("-l") ? part("crontab", "reads the crontab") : part("crontab", "replaces the crontab", undefined, ["writes"])];
  }
  if (base === "mkdir") return [...parts, ...ops(["-m"]).map((d) => part("mkdir", `makes folder ${shown(d, w)}`, (n) => `makes ${plural(n, "folder")}`, ["writes"]))];
  if (base === "touch") return [...parts, ...ops().map((f) => part("touch", `creates ${shown(f, w)}`, (n) => `creates ${plural(n, "file")}`, ["writes"]))];
  if (base === "tee") return [...parts, ...ops().map((f) => part("write", `writes ${shown(f, w)}`, (n) => `writes ${plural(n, "file")}`, ["writes"]))];
  if (base === "cp" || base === "mv" || base === "ln" || base === "install") {
    const verb = base === "mv" ? "moves" : base === "ln" ? "links" : "copies";
    const o = ops(["-t", "-S"]);
    const to = o[o.length - 1];
    return [...parts, part(base, `${verb} ${o.length > 2 ? plural(o.length - 1, "file") : shown(o[0] ?? "", w)}${to && o.length > 1 ? ` to ${shown(to, w)}` : ""}`, undefined, ["writes"])];
  }
  if (base === "chmod" || base === "chown" || base === "chgrp") return [...parts, part("perm", "changes file permissions", undefined, ["writes"])];
  if (base === "tar" || base === "zip" || base === "unzip" || base === "gzip" || base === "gunzip") return [...parts, part("pack", base === "unzip" || base === "gunzip" || args.some((a) => /^-?[a-z]*x/.test(a)) ? "unpacks files" : "packs files", undefined, ["writes"])];
  if (base === "curl" || base === "wget" || base === "http" || base === "xh") {
    const o = ops(["-o", "-X", "-d", "-H", "-u", "-F", "-A", "-e", "-w", "-T", "--data", "--header", "--output", "--request", "--user", "--form", "-O", "--max-time", "-m"]);
    const urls = o.filter((a) => a.includes("://") || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(a));
    const writes = args.some((a) => a === "-o" || a === "--output" || a === "-O" || a === "-T") || base === "wget";
    const sends = args.some((a) => /^(-d|--data.*|-F|--form|-T)$/.test(a)) || /^(POST|PUT|PATCH|DELETE)$/.test(args[args.indexOf("-X") + 1] ?? "");
    const flags: ExplainFlag[] = writes ? ["network", "writes"] : ["network"];
    if (urls.length === 0) return [...parts, part("fetch", "fetches a URL", (n) => `fetches ${plural(n, "URL")}`, flags)];
    return [...parts, ...urls.map((u) => (sends ? part(`send ${host(u)}`, `sends a request to ${host(u)}`, undefined, flags) : part("fetch", `fetches ${host(u)}`, (n) => `fetches ${plural(n, "URL")}`, flags)))];
  }
  if (base === "ssh" || base === "mosh") return [...parts, part(`ssh`, `connects to ${ops(["-p", "-i", "-o", "-l", "-J", "-F"])[0] ?? "a host"}`, undefined, ["network", "code"])];
  if (base === "scp" || base === "rsync" || base === "sftp") return [...parts, part("copy-net", "copies files over the network", undefined, ["network", "writes"])];
  if (["ping", "dig", "nslookup", "nc", "telnet", "host", "traceroute"].includes(base)) return [...parts, part("net", `checks ${ops()[0] ?? "the network"}`, undefined, ["network"])];
  if (base === "git") return [...parts, ...gitPart(args, w, who)];
  if (base === "gh") {
    const o = operands(args);
    const deletes = o.slice(0, 3).some((a) => a === "delete" || a === "remove" || a === "rm");
    return [...parts, part(`gh ${args.slice(0, 2).join(" ")}`, `uses GitHub: ${o.slice(0, 2).join(" ") || "gh"}`, undefined, deletes ? ["deletes", "network"] : ["network"])];
  }
  if (base === "aws") {
    const o = operands(args, ["--profile", "--region", "--output", "--query"]);
    const deletes = o.some((a) => a === "rm" || a === "rb" || a.startsWith("delete-") || a.startsWith("terminate-"));
    const writes = o[0] === "s3" && ["cp", "mv", "sync"].includes(o[1] ?? "");
    const flags: ExplainFlag[] = deletes ? ["deletes", "network"] : writes ? ["network", "writes"] : ["network"];
    return [...parts, part(`aws ${o.slice(0, 2).join(" ")}`, `uses AWS: ${o.slice(0, 2).join(" ") || "aws"}`, undefined, flags)];
  }
  if (base === "firebase" || base === "vercel" || base === "netlify" || base === "wrangler" || base === "fly" || base === "flyctl") {
    const sub = operands(args)[0];
    // a bare `vercel` deploys, as does `--prod`
    const deploys = sub === "deploy" || sub === "publish" || args.includes("--prod") || (base === "vercel" && sub === undefined);
    if (deploys) return [...parts, part(`deploy ${base}`, `deploys with ${base}`, undefined, ["push", "network"])];
    return [...parts, vaguePart(`${base} ${sub ?? ""}`, `runs ${base}${sub ? ` ${sub}` : ""}`, ["network"])];
  }
  if (["bun", "npm", "pnpm", "yarn", "uv", "pip", "pip3", "cargo", "go"].includes(base)) {
    if (base === "bun" && args[0] && /\.(ts|tsx|js|mjs|cjs)$/.test(args[0])) return [...parts, part(`script ${args[0]}`, `runs ${shown(args[0], w)} with Bun`, undefined, ["code"])];
    if (base === "bun" && (args[0] === "-e" || args[0] === "--eval")) return [...parts, part("snippet Bun", "runs a Bun snippet", undefined, ["code"])];
    return [...parts, ...packagePart(base, args)];
  }
  if (["bunx", "npx", "uvx", "pnpx"].includes(base)) {
    const tool = operands(args)[0] ?? "a tool";
    return [...parts, part(`x ${tool}`, `runs ${tool} via ${base}`, undefined, ["code"])];
  }
  if (base === "xargs") {
    const rest = operands(args, ["-n", "-I", "-P", "-L", "-d", "-s"]);
    if (rest.length === 0) return [...parts, part("print", "prints text")];
    return [...parts, ...commandParts({ words: rest, writes: [], reads: [] }, w, root)];
  }
  if (base === "eval" || base === "source" || base === ".") return [...parts, part(base, base === "eval" ? "runs a shell snippet" : `runs ${shown(args[0] ?? "a file", w)} in this shell`, undefined, ["code"])];
  if (base === "open" || base === "xdg-open") return [...parts, part("open", `opens ${ops()[0] ? shown(ops()[0] ?? "", w) : "something"}`)];
  if (base === "docker" || base === "podman" || base === "kubectl") {
    const o = operands(args);
    const sub = o[0];
    // `docker rm`, `docker rmi`, `docker system prune`, `docker volume rm`, `kubectl delete`
    if (o.slice(0, 2).some((a) => a === "rm" || a === "rmi" || a === "prune" || a === "delete")) {
      return [...parts, part(`${base} delete`, `deletes with ${base} ${o.slice(0, 2).join(" ")}`, undefined, ["deletes"])];
    }
    return [...parts, vaguePart(`${base} ${sub ?? ""}`, `runs ${base}${sub ? ` ${sub}` : ""}`, ["code"])];
  }
  if (base === "make") {
    const sub = operands(args)[0];
    return [...parts, part(`make ${sub ?? ""}`, `runs make${sub ? ` ${sub}` : ""}`, undefined, ["code"])];
  }
  const quiet = QUIET[base];
  if (quiet) return [...parts, part(quiet, quiet)];
  if (prog.includes("/")) {
    flagOutside(prog);
    return [...parts, vaguePart(`run ${prog}`, `runs ${shown(prog, w)}`, ["code"])];
  }
  return [...parts, vaguePart(`run ${base}`, `runs ${base}`, ["code"])];
}

/** every part of a line, `w.cwd` moving with its `cd`s */
function explainParts(line: string, w: Where, root: string | null): Part[] {
  return splitShell(line).flatMap((c) => commandParts(c, w, root));
}

/** steps named before the rest is only counted */
const MAX_STEPS = 5;

function fold(parts: readonly Part[]): Explained {
  const groups = new Map<string, Part[]>();
  const flags = new Set<ExplainFlag>();
  let vague = false;
  for (const p of parts) {
    for (const f of p.flags ?? []) flags.add(f);
    if (p.vague) vague = true;
    if (!p.one) continue;
    const g = groups.get(p.key);
    if (g) g.push(p);
    else groups.set(p.key, [p]);
  }
  const phrases: string[] = [];
  for (const g of groups.values()) {
    const first = g[0];
    if (!first) continue;
    const distinct = new Set(g.map((p) => p.one));
    const phrase = distinct.size > 1 && first.many ? first.many(distinct.size) : first.one;
    if (!phrases.includes(phrase)) phrases.push(phrase);
  }
  const says =
    phrases.length === 0
      ? "runs a shell command"
      : phrases.length > MAX_STEPS
        ? `${phrases.slice(0, MAX_STEPS).join(", ")}, and ${phrases.length - MAX_STEPS} more steps`
        : phrases.length === 1
          ? (phrases[0] ?? "")
          : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
  return { says, flags: EXPLAIN_FLAGS.filter((f) => flags.has(f)), ...(vague || phrases.length === 0 ? { vague: true as const } : {}) };
}

/** A shell command in plain words. `root` is the project's folder (outside
 *  is judged against it; no root, no outside), `cwd` where the command runs
 *  when the request says, else the project's folder. */
export function explainCommand(command: string, root?: string, cwd?: string): Explained {
  const r = root ? norm(root, "/") : null;
  const start = cwd ? norm(cwd, r ?? "/") : (r ?? "/");
  const w: Where = { root: r, cwd: start };
  const parts = explainParts(command, w, r);
  if (r && cwd && !inside(start, r)) parts.push(part("outside", "", undefined, ["outside"]));
  return fold(parts);
}

/** What a permission prompt carries that the explanation reads. */
export interface ExplainInput {
  tool: string;
  title: string;
  /** a shell prompt's command */
  command?: string;
  /** the files a file tool touches */
  paths?: readonly string[];
  /** where a command runs, when the request says */
  cwd?: string;
}

const FILE_VERBS: Record<string, [string, ExplainFlag[]]> = {
  Read: ["reads", []],
  NotebookRead: ["reads", []],
  Write: ["writes", ["writes"]],
  Edit: ["edits", ["writes"]],
  MultiEdit: ["edits", ["writes"]],
  NotebookEdit: ["edits", ["writes"]],
};

/** Whether a request starts outside the project: a command run from a
 *  folder outside it, or a file tool on a file outside it. A remembered rule
 *  never answers one (the server's matching checks the same), so the page
 *  does not offer to remember it. With no project folder, false. */
export function startsOutside(p: ExplainInput, root?: string): boolean {
  if (!root) return false;
  const r = norm(root, "/");
  if (p.cwd && !inside(norm(p.cwd, r), r)) return true;
  return (p.paths ?? []).some((x) => outsidePath(x, { root: r, cwd: p.cwd ? norm(p.cwd, r) : r }));
}

/** A permission prompt in plain words: a shell command read step by step,
 *  a file tool by its files, the web tools as network, and anything else
 *  by the title the run gave it. */
export function explainPrompt(p: ExplainInput, root?: string): Explained {
  if (p.tool === "Bash" && p.command?.trim()) return explainCommand(p.command, root, p.cwd);
  const r = root ? norm(root, "/") : null;
  const w: Where = { root: r, cwd: r ?? "/" };
  const file = FILE_VERBS[p.tool];
  if (file && p.paths?.length) {
    const [verb, flags] = file;
    const out = p.paths.some((x) => outsidePath(x, w));
    const says = p.paths.length === 1 ? `${verb} ${shown(p.paths[0] ?? "", w)}` : `${verb} ${plural(p.paths.length, "file")}`;
    return { says, flags: EXPLAIN_FLAGS.filter((f) => (f === "outside" ? out : flags.includes(f))) };
  }
  const net = p.tool === "WebFetch" || p.tool === "WebSearch" || p.tool === "Network";
  return net ? { says: p.title, flags: ["network"] } : { says: p.title, flags: [], vague: true };
}
