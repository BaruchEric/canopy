/** Shell words and Claude's permission rules, pure and browser-safe: the
 *  page derives the rule a "remember" offers with the same words the server
 *  matches it with. Codex's approvals, a run's own allowlist and the
 *  remembered rules (`remember.ts`) all read commands through here. */

import type { RememberScope } from "./types";

/* ---------- shell words: what an approval's command actually runs ---------- */

/** A command line as words, the way a POSIX shell would split it, or null
 *  when the shell would do more than run one simple command: chain another
 *  (`;`, `|`, `&`, newline), redirect (`<`, `>`), open a subshell or group
 *  (`(`, `)`, `{`, `}`), substitute anything (`$`, a backtick) or start a
 *  comment. Quotes are honoured: what sits inside them is data, so `git
 *  commit -m "a; b"` is one command, while `$` and backticks are refused in
 *  double quotes too, since they expand there. */
export function shellWords(s: string): string[] | null {
  const out: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  const end = () => {
    if (inWord) out.push(word);
    word = "";
    inWord = false;
  };
  while (i < s.length) {
    const ch = s[i] ?? "";
    if (ch === " " || ch === "\t") {
      end();
      i++;
      continue;
    }
    if (ch === "'") {
      const close = s.indexOf("'", i + 1);
      if (close === -1) return null;
      word += s.slice(i + 1, close);
      inWord = true;
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      inWord = true;
      let closed = false;
      while (i < s.length) {
        const c = s[i] ?? "";
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === "$" || c === "`") return null;
        if (c === "\\") {
          const n = s[i + 1];
          if (n === undefined || n === "\n") return null;
          if (n === "$" || n === "`" || n === '"' || n === "\\") {
            word += n;
            i += 2;
            continue;
          }
          word += c;
          i++;
          continue;
        }
        word += c;
        i++;
      }
      if (!closed) return null;
      continue;
    }
    if (ch === "\\") {
      const n = s[i + 1];
      if (n === undefined || n === "\n") return null;
      word += n;
      inWord = true;
      i += 2;
      continue;
    }
    if (";|&<>(){}$`\n\r".includes(ch)) return null;
    if (ch === "#" && !inWord) return null;
    word += ch;
    inWord = true;
    i++;
  }
  end();
  return out;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const SHELL_FLAGS = new Set(["-c", "-lc", "-cl"]);

/** `/bin/sh -lc '<script>'` and its kin as [script], else null. */
function wrapped(words: string[]): string | null {
  if (words.length !== 3) return null;
  const [shell = "", flag = "", script = ""] = words;
  const base = shell.slice(shell.lastIndexOf("/") + 1);
  return SHELLS.has(base) && SHELL_FLAGS.has(flag) ? script : null;
}

/** The script a command runs, for a step's title: codex hands every command
 *  over as `/bin/sh -lc '<script>'`, and the wrapper says nothing. */
export function unwrapShell(command: string): string {
  const words = shellWords(command);
  return (words && wrapped(words)) ?? command;
}

/** The words of the one simple command an approval would run, unwrapped from
 *  its shell, or null when it is anything more. */
export function commandWords(command: string): string[] | null {
  const outer = shellWords(command);
  if (!outer) return null;
  const script = wrapped(outer);
  const words = script === null ? outer : shellWords(script);
  return words && words.length > 0 ? words : null;
}

/* ---------- allowed tools: Claude's rules, enforced by canopy ---------- */

export type ToolRule =
  | { kind: "bash"; words: string[]; prefix: boolean }
  | { kind: "tool"; name: string };

/** One of Claude's permission rules as canopy can apply it to Codex:
 *  `Bash(git status:*)` is a word prefix, `Bash(bun install)` an exact
 *  command, a bare `Edit` a whole tool. A rule scoped to paths (`Edit(src/**)`)
 *  or unreadable is null: honouring half of it would allow more than it says. */
export function parseRule(rule: string): ToolRule | null {
  const bash = /^Bash\((.+)\)$/.exec(rule.trim());
  if (bash) {
    const inner = bash[1] ?? "";
    const prefix = inner.endsWith(":*");
    const words = shellWords(prefix ? inner.slice(0, -2) : inner);
    return words && words.length > 0 ? { kind: "bash", words, prefix } : null;
  }
  return /^[A-Za-z]+$/.test(rule.trim()) ? { kind: "tool", name: rule.trim() } : null;
}

/* ---------- remembering: the rule an allowed prompt can leave behind ---------- */

/** A word as a POSIX shell reads it back: bare when it is plain, else in
 *  single quotes, a quote inside closed, escaped and reopened. */
export function quoteWord(w: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w)) return w;
  return `'${w.replace(/'/g, `'\\''`)}'`;
}

/** `Bash(<words>:*)` for a prefix, `Bash(<words>)` for the exact command;
 *  `parseRule` reads the same words back. */
export const ruleOf = (words: readonly string[], prefix: boolean): string =>
  `Bash(${words.map(quoteWord).join(" ")}${prefix ? ":*" : ""})`;

/** What a remember offers for one prompt: rules from the broadest to the
 *  narrowest, the one picked by default, and whether the command chains
 *  several (then only a bare `Bash` would ever cover it again). */
export interface RuleOffer {
  rules: string[];
  pick: number;
  chain?: true;
}

/** tools whose second word is what they do: `git status`, `bun test`. A
 *  prefix rule for one is never shorter than two words: `git:*` would also
 *  cover `git -c alias.x='!…' x` and `git push --force`. */
const SUBCOMMANDS = new Set([
  "git", "gh", "bun", "npm", "pnpm", "yarn", "deno", "cargo", "go", "uv", "pip", "pip3",
  "docker", "podman", "kubectl", "brew", "make", "pacman", "systemctl", "launchctl", "tailscale", "vercel", "firebase", "aws",
]);

/** programs that run whatever their words say (an interpreter, a wrapper,
 *  a remote shell, a program with its own exec): any prefix of one runs
 *  anything, so only the exact command is offered */
const RUNS_ANYTHING = new Set([
  "python", "python3", "node", "ruby", "perl", "php", "lua", "rscript", "tclsh", "expect", "osascript", "deno",
  "sh", "bash", "zsh", "dash", "fish", "eval", "exec", "source", ".", "command", "builtin", "!",
  "sudo", "doas", "env", "xargs", "nohup", "time", "timeout", "nice", "stdbuf", "watch", "parallel", "flock", "chroot", "script", "strace",
  "ssh", "mosh", "awk", "gawk", "nawk", "sed", "find", "fd", "open", "xdg-open", "bunx", "npx", "pnpx", "uvx", "pipx",
]);

/** a subcommand that runs whatever follows it: exact only, like RUNS_ANYTHING */
const RUNS_ANYTHING_SUB = new Set([
  "docker run", "docker exec", "docker compose", "podman run", "podman exec", "podman compose", "kubectl exec", "kubectl run",
  "npm exec", "pnpm exec", "pnpm dlx", "yarn dlx", "yarn exec", "bun x", "uv run", "uv tool", "gh api", "aws ssm",
]);

/** A program's name as the lookups know it: the last part of its path, in
 *  lower case, since APFS finds `Python3` and `NODE` as the real binaries. */
export const progName = (word: string): string => word.slice(word.lastIndexOf("/") + 1).toLowerCase();

/** installs and the like, which run the scripts of whatever they fetch */
const INSTALLS: Record<string, readonly string[]> = {
  npm: ["install", "i", "in", "ins", "isntall", "add", "ci", "update", "up", "upgrade", "rebuild", "link", "ln", "exec", "x", "init", "create", "pkg", "set-script", "config", "publish", "pack", "version", "dlx"],
  pnpm: ["install", "i", "add", "update", "up", "upgrade", "rebuild", "link", "exec", "dlx", "create", "init", "pkg", "config", "publish", "pack", "version"],
  yarn: ["install", "add", "upgrade", "up", "dlx", "exec", "create", "init", "link", "config", "publish", "pack", "version"],
  bun: ["install", "i", "add", "a", "update", "upgrade", "link", "x", "create", "init", "pm", "publish"],
  pip: ["install", "download", "wheel"],
  pip3: ["install", "download", "wheel"],
  uv: ["pip", "add", "sync", "lock", "run", "tool", "build"],
  cargo: ["install"],
  go: ["run", "generate", "install", "get", "tool"],
  gem: ["install", "update"],
  bundle: ["install", "exec", "update"],
  brew: ["install", "reinstall", "upgrade", "bundle", "tap"],
  git: ["config", "hook", "filter-branch", "send-email"],
};

/** options that name a program to run, by the program they belong to */
const EXEC_OPTIONS: Record<string, readonly string[]> = {
  rg: ["--pre"],
  tar: ["--to-command", "--use-compress-program", "--checkpoint-action", "--info-script", "--new-volume-script", "--rsh-command", "--rmt-command"],
  git: ["--config-env", "--exec-path", "--upload-pack", "--receive-pack", "--exec", "--open-files-in-pager", "--extcmd", "--template", "--config"],
  make: ["--file", "--makefile", "--eval", "--directory", "--include-dir", "--environment-overrides"],
  find: ["-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"],
  fd: ["--exec", "--exec-batch"],
  npm: ["--script-shell", "--node-options", "--userconfig", "--globalconfig"],
  pnpm: ["--script-shell", "--node-options", "--userconfig", "--globalconfig"],
  yarn: ["--script-shell", "--node-options", "--use-yarnrc"],
  bun: ["--script-shell", "--preload", "--config"],
  go: ["-exec", "-toolexec", "-vettool", "-overlay"],
  cargo: ["--config"],
};

/** The option in `words` that runs another program, or null. Fail closed:
 *  a short option is caught bundled (`tar -xIf`) and an option with its
 *  value attached (`--pre=x`). */
export function execOption(words: readonly string[]): string | null {
  const prog = progName(words[0] ?? "");
  const args = words.slice(1);
  const long = EXEC_OPTIONS[prog] ?? [];
  for (const a of args) {
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (long.includes(name)) return name;
  }
  const subOf = (skip: readonly string[]): string | undefined => {
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? "";
      if (a.startsWith("-")) {
        if (skip.includes(a)) i++;
        continue;
      }
      return a.toLowerCase();
    }
    return undefined;
  };
  if (prog === "tar") {
    // old style: the first word is a bundle of letters without a dash
    for (const [i, a] of args.entries()) {
      const bundle = /^-[A-Za-z]+$/.test(a) || (i === 0 && /^[A-Za-z]+$/.test(a));
      if (bundle && /[IF]/.test(a)) return a;
      if (/^-[IF]./.test(a)) return a;
    }
  }
  if (prog === "git") {
    for (const [i, a] of args.entries()) {
      // an identity is the one setting that names no program
      if (a === "-c" && /^user\.(name|email)=/.test(args[i + 1] ?? "")) continue;
      if (a === "-c" || /^-c./.test(a) || a === "-O" || /^-O./.test(a)) return a;
    }
    const sub = subOf(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
    if (sub && ["fetch", "pull", "clone", "ls-remote", "submodule", "archive"].includes(sub) && args.includes("-u")) return "-u";
    if (sub && ["rebase", "difftool", "mergetool"].includes(sub) && args.some((a) => a === "-x" || a === "-t" || a.startsWith("--tool") || a.startsWith("--exec"))) return "-x";
    if (sub === "bisect" && args.includes("run")) return "bisect run";
    if (sub === "submodule" && args.includes("foreach")) return "submodule foreach";
  }
  if (prog === "make") {
    for (const a of args) {
      if (/^-[fECIe]/.test(a) || (!a.startsWith("-") && a.includes("="))) return a;
    }
  }
  if (prog === "fd") for (const a of args) if (a === "-x" || a === "-X") return a;
  const sub = subOf(prog === "git" ? ["-C", "-c", "--git-dir", "--work-tree", "--namespace"] : []);
  const installs = INSTALLS[prog];
  // a bare `yarn` installs
  if (prog === "yarn" && sub === undefined) return "yarn";
  if (installs && sub !== undefined && installs.includes(sub)) return `${prog} ${sub}`;
  return null;
}

/** Whether a simple command's words can run some other program: one that
 *  runs anything (`RUNS_ANYTHING`, `RUNS_ANYTHING_SUB`), or one with an
 *  option or a subcommand that does (`execOption`). A prefix rule never
 *  covers one, and is never offered for one. */
export function runsOther(words: readonly string[]): boolean {
  const first = progName(words[0] ?? "");
  if (RUNS_ANYTHING.has(first)) return true;
  if (RUNS_ANYTHING_SUB.has(`${first} ${(words[1] ?? "").toLowerCase()}`)) return true;
  return execOption(words) !== null;
}

/** tools that are never remembered: a sandbox escalation is granted each
 *  time, plan mode and questions are the human's call, a network rule would
 *  cover every host, and a notebook edit is not matched as a file change */
const NEVER = new Set(["Permissions", "AskUserQuestion", "ExitPlanMode", "Network", "NotebookEdit"]);

/** `FOO=1`: an assignment the command runs under, which changes what it does */
const ASSIGNS = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Whether a rule may name this tool: a plain name, not one never remembered. */
export const rememberable = (tool: string): boolean => !NEVER.has(tool) && /^[A-Za-z]+$/.test(tool);

/** The rules a "remember" can save for a prompt on `tool` (with `command`,
 *  for a shell command), or null when none would ever cover it. A plain
 *  command offers its leading words, up to three and never past a flag, as
 *  prefixes, broadest first and picked, then itself exactly; a tool with
 *  subcommands starts at two words. Only the exact command is offered when
 *  a prefix could run anything: a flag as the second word (`git -C x`,
 *  `bun -e`), a leading assignment (`FOO=1 bun test`), a program path, an
 *  interpreter, a wrapper or a program with its own exec (`RUNS_ANYTHING`,
 *  `RUNS_ANYTHING_SUB`). A chain offers a bare `Bash` alone, since a prefix
 *  rule never matches one. Another tool offers its name. */
export function ruleOffer(tool: string, command?: string): RuleOffer | null {
  if (tool === "Bash") {
    if (!command?.trim()) return null;
    const words = commandWords(command);
    if (!words) return { rules: ["Bash"], pick: 0, chain: true };
    const exact = ruleOf(words, false);
    const first = words[0] ?? "";
    const second = words[1];
    const exactOnly = { rules: [exact], pick: 0 };
    if (ASSIGNS.test(first) || first.includes("/") || runsOther(words)) return exactOnly;
    if (second?.startsWith("-")) return exactOnly;
    const sub = SUBCOMMANDS.has(progName(first));
    if (sub && second === undefined) return exactOnly;
    // the leading words before any flag, three at most
    const flag = words.findIndex((w) => w.startsWith("-"));
    const lead = Math.min(3, flag === -1 ? words.length : flag);
    const from = sub ? 2 : 1;
    const prefixes: string[] = [];
    for (let n = from; n <= lead; n++) prefixes.push(ruleOf(words.slice(0, n), true));
    return { rules: [...prefixes, exact], pick: 0 };
  }
  return rememberable(tool) ? { rules: [tool], pick: 0 } : null;
}

/** tools whose rule is about the files they change, covered inside the project only */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit"]);

/** tools a rule covers by their files, inside the project only: the one list
 *  the page's offer, the server and the rule's words all read */
export const FILE_TOOLS: ReadonlySet<string> = new Set([...EDIT_TOOLS, "Read", "NotebookRead", "Glob", "Grep", "LS"]);

/** Where a remembered rule applies, in words. */
export function scopeWords(s: RememberScope): string {
  if (s.kind === "step") return `${s.workflow} · ${s.step}, in every project`;
  if (s.kind === "workflow") return `every step of ${s.workflow}`;
  return `runs in ${s.path.replace(/\/+$/, "").split("/").pop() || s.path}`;
}

/** A rule in words, for the remember line and the gear's list. */
export function ruleWords(rule: string): string {
  const r = parseRule(rule);
  if (!r) return rule;
  if (r.kind === "tool") {
    if (r.name === "Bash") return "any shell command";
    return FILE_TOOLS.has(r.name) ? `any ${r.name} inside the project` : `any ${r.name}`;
  }
  const words = r.words.map(quoteWord).join(" ");
  return r.prefix ? `commands starting ${words}` : `exactly ${words}`;
}
