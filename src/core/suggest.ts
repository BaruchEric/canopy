/** The commit message suggestion: the diff handed to the agent the repo's
 *  `suggest` route names, one shot and no tools, with a heuristic when that
 *  agent is not installed or says nothing. Claude Code answers through
 *  `claude -p`; Codex through `codex exec` in its read-only sandbox, kept
 *  off disk (`--ephemeral`), its last message written to a file. */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFlags } from "./codexrun";
import { stageEnv } from "./envnames";
import { exec, git, type ExecOptions, type ExecResult } from "./exec";
import { HARNESS } from "./harness";
import { parseLocator } from "./host";
import { DEFAULT_AGENT, type AgentSettings, type RepoFile } from "./types";

const PROMPT = `Write a git commit message for the changes below.
Output ONLY the commit message: an imperative subject line under 65 characters,
optionally followed by a blank line and up to 3 short "- " body lines.
No backticks, no quotes around the message, no commentary.`;

/** Codex is an agent in a sandbox: without this it may go and run git
 *  itself, which reads the same changes more slowly. */
const CODEX_PROMPT = `${PROMPT}
Do not run any commands: everything you need is below.`;

/** how long an agent gets to answer */
const SUGGEST_TIMEOUT = 90_000;

/** Heuristic fallback: summarize by top-level area. */
export function heuristicMessage(files: RepoFile[]): string {
  if (files.length === 0) return "update";
  const areas = new Map<string, number>();
  for (const f of files) {
    const seg = f.path.includes("/") ? (f.path.split("/")[0] ?? "") : "root";
    areas.set(seg, (areas.get(seg) ?? 0) + 1);
  }
  const top = [...areas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const parts = top.map(([area, n]) => `${area} (${n})`);
  const verb = files.every((f) => f.untracked) ? "add" : "update";
  return `${verb} ${parts.join(", ")}`;
}

async function diffContext(repoPath: string): Promise<string> {
  const [short, staged, unstaged, stagedDiff, unstagedDiff] = await Promise.all(
    [
      git(repoPath, ["status", "--short"]),
      git(repoPath, ["diff", "--cached", "--stat"]),
      git(repoPath, ["diff", "--stat"]),
      git(repoPath, ["diff", "--cached"]),
      git(repoPath, ["diff"]),
    ],
  );
  const hasStaged = staged.stdout.trim().length > 0;
  const body = (hasStaged ? stagedDiff : unstagedDiff).stdout.slice(0, 12_000);
  return [
    "## git status --short",
    short.stdout,
    "## diffstat",
    hasStaged ? staged.stdout : unstaged.stdout,
    "## diff (truncated)",
    body,
  ].join("\n");
}

/** `claude` argv after the binary: print mode, plain text, and the route's
 *  model and effort (none at the defaults). */
export function claudeSuggestArgs(agent: AgentSettings, prompt: string): string[] {
  const h = HARNESS.claude;
  return ["-p", prompt, "--output-format", "text", ...h.modelArgs(agent.model), ...h.effortArgs(agent.effort)];
}

/** Where `codex exec` runs for a suggestion: in the repo, whose AGENTS.md
 *  may say how its commits are written, when the repo is on this machine;
 *  in `scratch` for one on another host, whose `ssh://` locator is no
 *  folder here. The diff is in the prompt either way, and
 *  `--skip-git-repo-check` lets codex run outside a repo. */
export const codexSuggestDir = (repoPath: string, scratch: string): string =>
  parseLocator(repoPath).host === null ? repoPath : scratch;

/** `codex` argv after the binary: `codex exec` in the read-only sandbox (it
 *  forces approvals to never, and a message needs no tools), nothing kept
 *  on disk, run from `dir` (`codexSuggestDir`), the last message into
 *  `out`, the route's model, effort and config flags, and the prompt last. */
export function codexSuggestArgs(agent: AgentSettings, dir: string, out: string, prompt: string): string[] {
  const h = HARNESS.codex;
  return [
    "exec",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-C",
    dir,
    "-o",
    out,
    ...h.modelArgs(agent.model),
    ...h.effortArgs(agent.effort),
    ...configFlags(agent.extra),
    prompt,
  ];
}

/** Codex's last message, or "" when it gave none. A seed's runs from the
 *  scratch folder too, so none of the seed's own AGENTS.md or .codex/ is read. */
async function askCodex(bin: string, repoPath: string, agent: AgentSettings, context: string, o: SuggestOpts): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "canopy-suggest-"));
  try {
    const out = join(dir, "message.txt");
    const where = o.seed ? dir : codexSuggestDir(repoPath, dir);
    const r = await (o.run ?? exec)([bin, ...codexSuggestArgs(agent, where, out, `${CODEX_PROMPT}\n\n${context}`)], {
      cwd: where,
      timeoutMs: SUGGEST_TIMEOUT,
      ...(o.seed ? { base: stageEnv(o.env ?? process.env) } : {}),
    });
    if (r.code !== 0) return "";
    return (await readFile(out, "utf8").catch(() => "")).trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** `seed`: an incubator seed, written by agents, so the harness starts in a
 *  scratch folder with the stage env (no token, none of the seed's settings).
 *  `run`, `which` and `env` stand in for exec, Bun.which and the env in tests. */
export interface SuggestOpts {
  seed?: boolean;
  run?: (argv: string[], opts?: ExecOptions) => Promise<ExecResult>;
  which?: (bin: string) => string | null;
  env?: Readonly<Record<string, string | undefined>>;
}

/** Claude's answer; a seed's from a scratch folder with the stage env */
async function claudeSuggest(bin: string, agent: AgentSettings, context: string, o: SuggestOpts): Promise<ExecResult> {
  const argv = [bin, ...claudeSuggestArgs(agent, `${PROMPT}\n\n${context}`)];
  if (!o.seed) return (o.run ?? exec)(argv, { timeoutMs: SUGGEST_TIMEOUT });
  const dir = await mkdtemp(join(tmpdir(), "canopy-suggest-"));
  try {
    return await (o.run ?? exec)(argv, { cwd: dir, timeoutMs: SUGGEST_TIMEOUT, base: stageEnv(o.env ?? process.env) });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Suggest a commit message through the agent the settings name; falls
 *  back to a heuristic. */
export async function suggestMessage(
  repoPath: string,
  files: RepoFile[],
  agent: AgentSettings = DEFAULT_AGENT,
  o: SuggestOpts = {},
): Promise<{ message: string; source: "ai" | "heuristic" }> {
  const bin = (o.which ?? Bun.which)(HARNESS[agent.harness].binary);
  if (bin) {
    const context = await diffContext(repoPath);
    if (agent.harness === "codex") {
      const message = await askCodex(bin, repoPath, agent, context, o);
      if (message) return { message, source: "ai" };
    } else {
      const r = await claudeSuggest(bin, agent, context, o);
      const message = r.stdout.trim();
      if (r.code === 0 && message) return { message, source: "ai" };
    }
  }
  return { message: heuristicMessage(files), source: "heuristic" };
}
