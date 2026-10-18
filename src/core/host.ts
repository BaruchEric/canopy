/** Repo paths are plain absolute paths on this machine, or a locator
 *  `ssh://<host><abs path>` for a folder on another host. Everything that
 *  runs git takes the locator and routes through `onHost`, so the rest of
 *  the code never has to know where a repo lives.
 *  The page reaches this file (through harness.ts), so it imports nothing
 *  from node: Vite's dev server throws on a node import a browser loads. */
export const SSH_SCHEME = "ssh://";

export interface Locator {
  /** ssh host alias, or null for this machine */
  host: string | null;
  /** absolute path on that host */
  path: string;
}

export function parseLocator(p: string): Locator {
  if (!p.startsWith(SSH_SCHEME)) return { host: null, path: p };
  const rest = p.slice(SSH_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return { host: rest, path: "/" };
  return { host: rest.slice(0, slash), path: rest.slice(slash) };
}

export function toLocator(host: string | null, path: string): string {
  return host ? `${SSH_SCHEME}${host}${path}` : path;
}

export const isRemote = (p: string): boolean => p.startsWith(SSH_SCHEME);

/** An ssh host as it appears in `~/.ssh/config`, optionally `user@host`.
 *  Anything else is refused before it can reach ssh's argv as an option. */
export function isSshHost(h: string): boolean {
  return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(h);
}

/** POSIX single-quoting: safe for any byte but NUL. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A word a POSIX shell reads as itself. */
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** What a line typed into a canopy shell uses for that shell's own
 *  CANOPY_TOKEN: the shell expands it, so no token value is ever typed. */
export const TOKEN_REF = "$CANOPY_TOKEN";

/** Marks the one word `shellLine` leaves as written. */
const RAW_WORD = "\u0001";

/** Codex's `-c` value that sets its commands' CANOPY_TOKEN from the shell's
 *  own, which the shell expands inside the toml quotes at run time: the one
 *  case that needs shell syntax in a line. `shellLine` matches it whole, so
 *  no other word, from settings, a prompt or anywhere else, is left raw. */
export const TOKEN_SET_WORD = `${RAW_WORD}'shell_environment_policy.set.CANOPY_TOKEN="'"${TOKEN_REF}"'"'`;

/** Words as one shell line, quoting only what needs it, so a command a
 *  person will see (in a terminal tab, a held window) stays readable. */
export function shellLine(words: string[]): string {
  return words.map((w) => (w === TOKEN_SET_WORD ? w.slice(RAW_WORD.length) : PLAIN_WORD.test(w) ? w : shellQuote(w))).join(" ");
}

/** Quote a path for a remote shell while letting a leading `~` expand, so a
 *  source can be added as `~/dev` without knowing the remote home. */
export function tildeQuote(p: string): string {
  if (p === "" || p === "~") return "~";
  if (p.startsWith("~/")) return `~/${shellQuote(p.slice(2))}`;
  return shellQuote(p);
}

/** ssh, never prompting, with a shared connection per host so a scan's many
 *  git calls ride one session. The control socket lives in `controlDir`. */
export function sshArgs(host: string, controlDir: string): string[] {
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${controlDir.replace(/\/+$/, "")}/ssh-%C`,
    "-o",
    "ControlPersist=120",
    "--",
    host,
  ];
}

/** ssh hands the remote shell one string; quote each word so the remote
 *  sees the argv we meant. Assumes a POSIX shell on the far side. */
export function remoteCommand(cmd: string[]): string {
  return cmd.map(shellQuote).join(" ");
}

/** The aliases in `~/.ssh/config`, minus patterns, for the add-a-folder
 *  form's host suggestions. */
export function parseSshHosts(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = /^Host\s+(.+)$/i.exec(line);
    if (!m) continue;
    for (const h of (m[1] ?? "").split(/\s+/)) {
      if (h && !/[*?!]/.test(h) && !out.includes(h)) out.push(h);
    }
  }
  return out;
}
