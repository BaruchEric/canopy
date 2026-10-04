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
  "python", "python3", "node", "ruby", "perl", "php", "lua", "Rscript", "tclsh", "expect", "osascript",
  "sh", "bash", "zsh", "dash", "fish", "eval", "exec", "source", ".", "command", "builtin", "!",
  "sudo", "doas", "env", "xargs", "nohup", "time", "timeout", "nice", "stdbuf", "watch", "parallel", "flock", "chroot", "script", "strace",
  "ssh", "mosh", "awk", "gawk", "nawk", "sed", "find", "fd", "open", "xdg-open", "bunx", "npx", "pnpx", "uvx", "pipx",
]);

/** a subcommand that runs whatever follows it: exact only, like RUNS_ANYTHING */
const RUNS_ANYTHING_SUB = new Set([
  "docker run", "docker exec", "docker compose", "podman run", "podman exec", "podman compose", "kubectl exec", "kubectl run",
  "npm exec", "pnpm exec", "pnpm dlx", "yarn dlx", "yarn exec", "bun x", "uv run", "uv tool", "gh api", "aws ssm",
]);

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
    if (ASSIGNS.test(first) || first.includes("/") || RUNS_ANYTHING.has(first)) return exactOnly;
    if (second?.startsWith("-")) return exactOnly;
    const sub = SUBCOMMANDS.has(first);
    if (sub && (second === undefined || RUNS_ANYTHING_SUB.has(`${first} ${second}`))) return exactOnly;
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

/** tools whose remembered rule covers files inside the project only */
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "NotebookRead", "Glob", "Grep"]);

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
