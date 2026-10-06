/** What each agent-driven action means: the words the UI shows, the rules
 *  for when it makes sense, and the prompt it turns into; and how a tool
 *  call reads in the timeline, in one vocabulary for Claude Code's tools and
 *  Codex's items. Browser-safe: the UI imports this for labels and
 *  preconditions, the runner for prompts and titles. */

import type { FlowStepName, Repo, RunAction, RunScope, WorkflowWhen, Workspace } from "./types";

export interface ActionSpec {
  /** menu label */
  label: string;
  /** confirm-button verb, also the run's title */
  verb: string;
  /** one short paragraph for the pre-flight dialog: what the agent will do */
  blurb: string;
  /** placeholder for the note box */
  notePlaceholder: string;
  /** the note is the whole prompt, so it cannot be empty */
  noteRequired: boolean;
  /** permission rules added for the session; anything else asks first */
  allowedTools: string[];
  maxTurns: number;
  /** the card chip's word while the run is going */
  progress: string;
  /** a run that leaves git status untouched is reported as "no change" */
  expectsChange: boolean;
  /** the task paragraph of the prompt */
  task: string;
  /** how the note is framed and how the prompt closes: a job ends with the
   *  ground rules, an ask frames the note as the task, a chat puts the
   *  first message last */
  mode: "job" | "ask" | "chat";
  /** no one answers this run: every prompt is denied at once with this message */
  unattended?: string;
  /** a flow's step: which workflow and step, the run's `flowStep` */
  flowStep?: FlowStepName;
}

const safetyFor = (where: string) => `- ${where}
- Never rewrite published history, never force-push, never discard uncommitted work, never run destructive git commands (reset --hard, clean, checkout -- on tracked files).
- Do not add a Co-Authored-By trailer or any mention of Claude, Codex or an AI agent to commit messages.
- No backticks in commit messages.`;

const SAFETY = safetyFor("Work only inside this repository (submodules under it included).");
const WS_SAFETY = safetyFor("Work only inside these folders (submodules under them included).");

const DONE = `- canopy shows this repo as "changed" for as long as git status lists anything at all: untracked files, and submodules with new commits, modified content, or untracked content inside them. The job is done when the list is empty and the branch is not ahead, or when the user has decided to leave something.`;

const STUCK = `- When you cannot finish the task as stated (nothing you would commit on your own, a decision only the user can make, a conflict), do not end the run by explaining. Ask with AskUserQuestion, giving the concrete options, then do what the user picks. Explaining is for the summary after the work.`;

const SUMMARY = `- Finish with a short plain-prose summary of what you did (commit hashes, remote, URL) and anything you left alone and why. No headings, no bullet lists.`;

/** The three rule sets, built once per safety wording: a workspace run is
 *  told the same rules over its folders instead of one repository. */
const rulesFor = (safety: string) => ({
  job: ["Ground rules:", safety, DONE, STUCK, SUMMARY].join("\n"),
  /** An ask is the note's task and no more, so it goes without the line that
   *  makes a job done only once the repo is clean and pushed: with it, "explain
   *  this" or "pull main" ended by offering to commit whatever else was lying
   *  around and to push. */
  ask: ["Ground rules:", safety, STUCK, SUMMARY].join("\n"),
  /** The chat keeps the safety rules and drops the ones about how a job ends:
   *  a conversation has no closing summary, and it is not done until the user
   *  says so. */
  chat: ["Ground rules:", safety].join("\n"),
});

const RULES = rulesFor(SAFETY);
const WS_RULES = rulesFor(WS_SAFETY);

const GIT_READ = [
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git branch:*)",
  "Bash(git remote:*)",
  "Bash(git rev-parse:*)",
  "Bash(git fetch:*)",
];
const GIT_COMMIT = ["Bash(git add:*)", "Bash(git commit:*)", "Bash(git restore --staged:*)"];
const GIT_PUSH = ["Bash(git push:*)"];
const BUN = ["Bash(bun run:*)", "Bash(bun test:*)", "Bash(bun install)", "Bash(bun x:*)", "Bash(bunx:*)"];
const READ = ["Read", "Glob", "Grep"];

/** The names a workflow step's `tools:` line may use in place of rules. */
export const TOOL_SETS: Record<string, readonly string[]> = {
  "git-read": GIT_READ,
  "git-commit": GIT_COMMIT,
  "git-push": GIT_PUSH,
  bun: BUN,
  read: READ,
};

export const ACTIONS: Record<RunAction, ActionSpec> = {
  ask: {
    label: "ask the agent…",
    verb: "ask",
    blurb:
      "The repo's agent opens in this repo with your note as the task. It asks before running anything beyond reading files and git status.",
    notePlaceholder: "what should the agent do in this repo?",
    noteRequired: true,
    allowedTools: GIT_READ,
    maxTurns: 60,
    progress: "working",
    expectsChange: false,
    mode: "ask",
    task: `Task: see the note below.`,
  },
  chat: {
    label: "chat…",
    verb: "chat",
    blurb:
      "A conversation with the repo's agent in this repo, turn by turn, in canopy. It asks before running anything beyond reading files and git status.",
    notePlaceholder: "say something about this repo",
    noteRequired: false,
    allowedTools: GIT_READ,
    // Per user message, not per chat: the CLI counts the agentic turns of one
    // reply and starts over with the next message.
    maxTurns: 100,
    progress: "replying",
    expectsChange: false,
    mode: "chat",
    task: `Task: hold a conversation. The user is chatting with you about this repository from canopy's chat box, and every later message arrives the same way. Answer each message on its own; when a message asks for work, do it. Keep replies short and in plain prose unless the user asks for more. Ask with AskUserQuestion when a choice is theirs to make.`,
  },
};

/** Whether the action makes sense for the repo right now. `why` is shown as
 *  the disabled item's tooltip, so it names the missing thing, not a rule. */
export type RunCheck = { ok: true } | { ok: false; why: string };

/** A workflow's precondition against the repo as the card shows it. */
export function checkWhen(repo: Repo, when: WorkflowWhen): RunCheck {
  if (repo.error) return { ok: false, why: "not a readable repo" };
  const st = repo.status;
  const dirty = (st?.files.length ?? 0) > 0;
  const unpushed = (st?.ahead ?? 0) > 0 || !st?.upstream;
  switch (when) {
    case "dirty":
      return dirty ? { ok: true } : { ok: false, why: "nothing to commit" };
    case "unpushed":
      return unpushed ? { ok: true } : { ok: false, why: "nothing to push" };
    case "dirty-or-unpushed":
      return dirty || unpushed ? { ok: true } : { ok: false, why: "nothing to commit or push" };
    case "any":
      return { ok: true };
  }
}

/** One line of facts for the dialog and the prompt: branch, changes, ahead. */
export function repoFacts(repo: Repo): string[] {
  const st = repo.status;
  if (!st) return [];
  const facts = [st.branch];
  facts.push(st.files.length === 1 ? "1 changed file" : `${st.files.length} changed files`);
  if (st.ahead) facts.push(`${st.ahead} unpushed`);
  if (st.behind) facts.push(`${st.behind} behind`);
  if (!st.upstream) facts.push("no upstream");
  return facts;
}

/** A workspace's members around its primary, for a run there: the local
 *  repos the run adds as folders, and in words the members it cannot open
 *  here (on another host, on the forge, or missing from the last scan),
 *  which it leaves out rather than refuses. */
export function splitMembers(ws: Workspace, primary: string, repos: readonly Repo[]): { others: Repo[]; skipped: string[] } {
  const others: Repo[] = [];
  const skipped: string[] = [];
  for (const p of ws.repos) {
    if (p === primary) continue;
    const r = repos.find((x) => x.path === p);
    if (!r) skipped.push(`${p} (not found by the last scan)`);
    else if (r.host) skipped.push(`${p} (on ${r.host})`);
    else if (r.forge) skipped.push(`${p} (on the forge)`);
    else others.push(r);
  }
  return { others, skipped };
}

/** The full prompt for a run. The repo facts come from canopy's own status
 *  read, so the agent starts with the same picture the card shows. The
 *  ground rules name Claude's AskUserQuestion; a Codex run is told its own
 *  tool for the same thing (codexrun.ts). */
export function buildPrompt(repo: Repo, spec: ActionSpec, note: string, scope?: RunScope): string {
  const facts = repoFacts(repo);
  const rules = scope ? WS_RULES : RULES;
  const head = (
    scope
      ? [
          `You are working across the workspace ${scope.workspace}, launched from canopy (a multi-repo git dashboard).`,
          `Primary folder, where new code goes: ${scope.primary} (the git repository ${repo.name}).`,
          scope.others.length ? `Other folders you may read and change: ${scope.others.join(", ")}.` : "",
          facts.length ? `Primary's current state: ${facts.join(", ")}.` : "",
        ]
      : [
          `You are in the git repository ${repo.name} at ${repo.path}, launched from canopy (a multi-repo git dashboard).`,
          facts.length ? `Current state: ${facts.join(", ")}.` : "",
        ]
  )
    .filter(Boolean)
    .join("\n");
  const trimmed = note.trim();
  const noteBlock = trimmed
    ? spec.mode === "ask"
      ? `Note from the user:\n${trimmed}`
      : spec.mode === "chat"
        ? `First message from the user:\n${trimmed}`
        : `Note from the user (follow it where it applies):\n${trimmed}`
    : "";
  // A chat's first message comes last, where a reply naturally follows it.
  const parts =
    spec.mode === "chat"
      ? [head, spec.task, rules.chat, noteBlock]
      : [head, spec.task, noteBlock, spec.mode === "ask" ? rules.ask : rules.job];
  return parts.filter(Boolean).join("\n\n");
}

/** Paths inside the repo lose the repo prefix; the console has no room for
 *  a full absolute path on every line. */
function shorten(path: string, root?: string): string {
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

/** One file a change touches, as Codex reports a file change: its kind
 *  (`add`, `delete`, `update`), where it moves to, and its unified diff. */
export interface FileChangeInput {
  path: string;
  kind: string;
  movePath?: string | null;
  diff?: string;
}

/** A tool input's `changes`, the ones well formed enough to name. */
function changesOf(input: Record<string, unknown>): FileChangeInput[] {
  const raw = input["changes"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c: unknown) => {
    if (typeof c !== "object" || c === null) return [];
    const o = c as Record<string, unknown>;
    if (typeof o["path"] !== "string" || !o["path"]) return [];
    return [
      {
        path: o["path"],
        kind: typeof o["kind"] === "string" ? o["kind"] : "update",
        movePath: typeof o["movePath"] === "string" && o["movePath"] ? o["movePath"] : null,
        diff: typeof o["diff"] === "string" ? o["diff"] : "",
      },
    ];
  });
}

/** "edit a.ts", "write b.ts", "move c.ts to d.ts", "edit a.ts, b.ts and 2 more" */
function changesTitle(changes: FileChangeInput[], root?: string): string {
  const one = changes[0];
  if (!one) return "edit files";
  if (changes.length === 1) {
    const path = shorten(one.path, root);
    if (one.kind === "add") return `write ${path}`;
    if (one.kind === "delete") return `delete ${path}`;
    if (one.movePath) return `move ${path} to ${shorten(one.movePath, root)}`;
    return `edit ${path}`;
  }
  const names = changes.slice(0, 2).map((c) => shorten(c.path, root));
  const more = changes.length - names.length;
  return `edit ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** Each file under its path, its diff after it. */
const changesDiff = (changes: FileChangeInput[], root?: string): string =>
  changes.map((c) => `${shorten(c.path, root)}\n${(c.diff ?? "").trim()}`.trim()).join("\n\n");

/** The access a sandbox permission request asks for, as words: "network,
 *  write out, read /etc". */
function accessWords(input: Record<string, unknown>, root?: string): string {
  const rec = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const net = rec(input["network"]);
  const fs = rec(input["fileSystem"]);
  const paths = (k: string) => (Array.isArray(fs[k]) ? fs[k].filter((p): p is string => typeof p === "string") : []);
  return [
    ...(net["enabled"] === true ? ["network"] : []),
    ...paths("write").map((p) => `write ${shorten(p, root)}`),
    ...paths("read").map((p) => `read ${shorten(p, root)}`),
  ].join(", ");
}

/** An MCP tool's name, `mcp__<server>__<tool>`, as its two parts. */
const mcpName = (name: string): [string, string] | null => {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? [m[1] ?? "", m[2] ?? ""] : null;
};

/** The first string among a tool's input, clipped, as a title shows one. */
const firstString = (input: Record<string, unknown>): string => {
  const first = Object.values(input).find((v) => typeof v === "string");
  return typeof first === "string" ? first.slice(0, 80) : "";
};

/** The one line the timeline shows for a tool call. Bash shows the command,
 *  file tools show the path, and anything else shows its name. Codex's
 *  items arrive under the same names where one fits (a command is Bash, a
 *  file change Edit with its `changes`, a sub-agent Agent), plus its own:
 *  WebSearch, Plan, an MCP call as `mcp__<server>__<tool>`, and the two
 *  that only ever show as prompts, Network and Permissions. */
export function describeTool(
  name: string,
  input: Record<string, unknown>,
  root?: string,
): string {
  const str = (k: string): string => {
    const v = input[k];
    return typeof v === "string" ? shorten(v, root) : "";
  };
  switch (name) {
    case "Bash":
      return str("command") || "shell command";
    case "Read":
      return `read ${str("file_path")}`;
    case "Edit":
    case "MultiEdit":
      return Array.isArray(input["changes"]) ? changesTitle(changesOf(input), root) : `edit ${str("file_path")}`;
    case "Write":
      return `write ${str("file_path")}`;
    case "Glob":
      return `find ${str("pattern")}`;
    case "Grep":
      return `search ${str("pattern")}`;
    case "AskUserQuestion":
      return "ask you a question";
    case "Task":
    case "Agent":
      return `agent: ${str("description") || "subtask"}`;
    case "Skill":
      return `skill ${str("skill")}`;
    case "TodoWrite":
    case "Plan":
      return "update the plan";
    case "WebSearch": {
      const q = str("query");
      return q ? `web search ${q}` : "web search";
    }
    case "Network":
      return `network access to ${str("host") || "the network"}`;
    case "Permissions":
      return `more access: ${accessWords(input, root) || "sandbox permissions"}`;
    default: {
      const mcp = mcpName(name);
      const first = firstString(input);
      if (mcp) return `${mcp[0]} ${mcp[1]}${first ? ` ${first}` : ""}`;
      return first ? `${name} ${first}` : name;
    }
  }
}

/** The multi-line detail behind a permission prompt: the whole command, or
 *  the input as JSON for tools that have no single obvious field. */
export function toolDetail(
  name: string,
  input: Record<string, unknown>,
  root?: string,
): string {
  const command = input["command"];
  if (name === "Bash" && typeof command === "string") return command;
  const file = input["file_path"];
  const text = (k: string): string => {
    const v = input[k];
    return typeof v === "string" ? v : "";
  };
  if (name === "Edit") {
    // Codex's file change: each file's unified diff under its path
    if (Array.isArray(input["changes"])) return changesDiff(changesOf(input), root).slice(0, 4000);
    // one file's unified diff
    if (typeof file === "string" && typeof input["diff"] === "string") {
      return `${shorten(file, root)}\n${text("diff").trim()}`.trim().slice(0, 4000);
    }
  }
  // An edit is judged by what it changes, so the prompt shows the change
  // the way a diff would, not just the file name.
  if (name === "Edit" && typeof file === "string") {
    const diff = (k: string, sign: string): string[] => {
      const v = text(k);
      return v ? v.split("\n").map((l) => `${sign} ${l}`) : [];
    };
    return [shorten(file, root), ...diff("old_string", "-"), ...diff("new_string", "+")]
      .join("\n")
      .slice(0, 4000);
  }
  if (name === "Write" && typeof file === "string") {
    const body = text("content");
    const lines = body.split("\n");
    const shown = lines.slice(0, 40).join("\n");
    const more = lines.length > 40 ? `\n… (${lines.length - 40} more lines)` : "";
    return `${shorten(file, root)}\n${shown}${more}`.slice(0, 4000);
  }
  if (name === "MultiEdit" && typeof file === "string") {
    return shorten(file, root);
  }
  if (name === "Network" && text("host")) {
    return `${text("protocol")} ${text("host")}`.trim();
  }
  try {
    return JSON.stringify(input, null, 2).slice(0, 4000);
  } catch {
    return name;
  }
}
