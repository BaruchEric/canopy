/**
 * Guards (agents spec, phase 5): shell commands a yolo agent must not run
 * without a person saying yes, kept by tailchan's broker as rules in Claude
 * Code's rule syntax and edited in the agents view. The tailchan CLI's
 * `PreToolUse` hook matches a shell command against them and raises a
 * `guard` ask on a hit. Browser-safe and pure: the parser the editor
 * validates with, and a matcher that mirrors the hook's (`guard_jq` in the
 * CLI) so the editor can say which rule a command would hit.
 */

/** the broker's own check on a rule: a tool name, then an optional pattern
 *  in parentheses */
export const RULE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,99}(\(.{1,400}\))?$/;
/** the broker's limits: this many rules, each this long */
export const GUARDS_MAX = 200;
export const RULE_MAX = 500;

/** How a rule matches: `every` shell command (a bare `Bash`), a `prefix` on
 *  a word boundary (`Bash(git push --force:*)`), a `glob` with `*`
 *  (`Bash(rm -rf *)`), or one `exact` command. */
export type GuardKind = "every" | "prefix" | "glob" | "exact";

export interface GuardRule {
  /** the rule as the broker keeps it */
  text: string;
  tool: string;
  /** the pattern inside the parentheses; null for a bare tool */
  spec: string | null;
  kind: GuardKind;
  /** set for a rule the hook never matches: only shell commands are guarded */
  inert?: string;
}

export type GuardParse = { ok: true; rule: GuardRule } | { ok: false; error: string };

/** One rule off what was typed: trimmed, checked the way the broker checks
 *  it, and read for the words the editor shows. */
export function parseGuardRule(raw: string): GuardParse {
  const text = raw.trim();
  if (!text) return { ok: false, error: "a rule cannot be empty" };
  if (text.length > RULE_MAX) return { ok: false, error: `a rule is at most ${RULE_MAX} characters` };
  if (/[\r\n]/.test(text)) return { ok: false, error: "a rule is one line" };
  if (!RULE_RE.test(text)) {
    return { ok: false, error: "a rule is a tool, or a tool and a pattern in parentheses: Bash(git push --force:*)" };
  }
  const open = text.indexOf("(");
  const tool = open < 0 ? text : text.slice(0, open);
  const spec = open < 0 ? null : text.slice(open + 1, -1);
  const kind: GuardKind = spec === null ? "every" : spec.endsWith(":*") ? "prefix" : spec.includes("*") ? "glob" : "exact";
  const rule: GuardRule = { text, tool, spec, kind };
  if (tool !== "Bash") rule.inert = "only Bash rules stop anything: the hook guards shell commands";
  else if (kind === "prefix" && spec !== null && spec.slice(0, -2).trim() === "") return { ok: false, error: "a prefix rule needs a command before :*" };
  return { ok: true, rule };
}

/** "every shell command", "commands starting with git push --force" */
export function describeGuard(rule: GuardRule): string {
  if (rule.inert) return rule.inert;
  const spec = rule.spec ?? "";
  if (rule.kind === "every") return "every shell command";
  if (rule.kind === "prefix") return `commands starting with ${spec.slice(0, -2)}`;
  if (rule.kind === "glob") return `commands matching ${spec}`;
  return `exactly ${spec}`;
}

/** A list as the editor sends it: each rule trimmed and checked, blanks
 *  and repeats dropped; the first bad rule's error, or the list. */
export function normalizeGuards(raw: readonly string[]): { rules: string[] } | { error: string } {
  const out: string[] = [];
  for (const r of raw) {
    if (!r.trim()) continue;
    const p = parseGuardRule(r);
    if (!p.ok) return { error: `${r.trim()}: ${p.error}` };
    if (!out.includes(p.rule.text)) out.push(p.rule.text);
  }
  if (out.length > GUARDS_MAX) return { error: `at most ${GUARDS_MAX} rules` };
  return { rules: out };
}

const escapeRe = (s: string): string => s.replace(/[.\\+*?()[\]{}|^$]/g, "\\$&");

/** the hook's regex for a pattern: a prefix on a word boundary, or a glob */
function specRe(spec: string): RegExp {
  if (spec.endsWith(":*")) return new RegExp(`^${escapeRe(spec.slice(0, -2))}( .*)?$`);
  return new RegExp(`^${spec.split("*").map(escapeRe).join(".*")}$`);
}

const norm = (s: string): string => s.replace(/\s+/g, " ").replace(/^ /, "").replace(/ $/, "");

/** Each simple command of a compound one, the way the hook reads them:
 *  split on newlines, `&&`, `||`, `;`, `|` and `&`, a leading `(`/`{` and
 *  a trailing `)`/`}` dropped, a `sh -c '…'` unwrapped, leading variable
 *  assignments and one `sudo`/`exec`/`command`/`nohup`/`time`/`env` dropped. */
export function commandParts(cmd: string): string[] {
  const out: string[] = [];
  for (const raw of cmd.split(/\n|&&|\|\||;|\||&/)) {
    let s = norm(raw).replace(/^[({] */, "").replace(/ *[)}]$/, "");
    s = s.replace(/^(ba|z)?sh -l?c /, "").replace(/^["']/, "").replace(/["']$/, "");
    s = norm(s)
      .replace(/^([A-Za-z_][A-Za-z0-9_]*=[^ ]* )+/, "")
      .replace(/^(sudo|exec|command|nohup|time|env) /, "");
    if (s !== "") out.push(s);
  }
  return out;
}

/** The first rule a shell command hits, as the hook would find it, or
 *  null. Guards stop accidents, not a determined agent: `eval`, a script
 *  file or `bash -c "$(…)"` walk past them, here as in the hook. */
export function guardHit(rules: readonly string[], cmd: string): string | null {
  const all = [...commandParts(cmd), norm(cmd)];
  for (const r of rules) {
    const m = /^Bash(?:\((.*)\))?$/.exec(r);
    if (!m) continue;
    const spec = m[1];
    if (spec === undefined) return r;
    const re = specRe(spec);
    if (all.some((s) => re.test(s))) return r;
  }
  return null;
}
