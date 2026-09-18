/** What each Claude-driven action means: the words the UI shows, the rules
 *  for when it makes sense, and the prompt it turns into. Browser-safe: the
 *  UI imports this for labels and preconditions, the runner for prompts. */

import type { Repo, RunAction, WorkflowWhen } from "./types";

export interface ActionSpec {
  /** menu label */
  label: string;
  /** confirm-button verb, also the run's title */
  verb: string;
  /** one short paragraph for the pre-flight dialog: what Claude will do */
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
}

const RULES = `Ground rules:
- Work only inside this repository (submodules under it included).
- Never rewrite published history, never force-push, never discard uncommitted work, never run destructive git commands (reset --hard, clean, checkout -- on tracked files).
- Do not add a Co-Authored-By trailer or any mention of Claude to commit messages.
- No backticks in commit messages.
- canopy shows this repo as "changed" for as long as git status lists anything at all: untracked files, and submodules with new commits, modified content, or untracked content inside them. The job is done when the list is empty and the branch is not ahead, or when the user has decided to leave something.
- When you cannot finish the task as stated (nothing you would commit on your own, a decision only the user can make, a conflict), do not end the run by explaining. Ask with AskUserQuestion, giving the concrete options, then do what the user picks. Explaining is for the summary after the work.
- Finish with a short plain-prose summary of what you did (commit hashes, remote, URL) and anything you left alone and why. No headings, no bullet lists.`;

/** The chat keeps the safety rules and drops the ones about how a job ends:
 *  a conversation has no closing summary, and it is not done until the user
 *  says so. */
const CHAT_RULES = `Ground rules:
- Work only inside this repository (submodules under it included).
- Never rewrite published history, never force-push, never discard uncommitted work, never run destructive git commands (reset --hard, clean, checkout -- on tracked files).
- Do not add a Co-Authored-By trailer or any mention of Claude to commit messages.
- No backticks in commit messages.`;

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
    label: "ask claude…",
    verb: "ask",
    blurb:
      "Claude Code opens in this repo with your note as the task. It asks before running anything beyond reading files and git status.",
    notePlaceholder: "what should Claude do in this repo?",
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
      "A conversation with Claude Code in this repo, turn by turn, in canopy. It asks before running anything beyond reading files and git status.",
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

/** The full prompt for a run. The repo facts come from canopy's own status
 *  read, so Claude starts with the same picture the card shows. */
export function buildPrompt(repo: Repo, spec: ActionSpec, note: string): string {
  const facts = repoFacts(repo);
  const head = [
    `You are in the git repository ${repo.name} at ${repo.path}, launched from canopy (a multi-repo git dashboard).`,
    facts.length ? `Current state: ${facts.join(", ")}.` : "",
  ]
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
      ? [head, spec.task, CHAT_RULES, noteBlock]
      : [head, spec.task, noteBlock, RULES];
  return parts.filter(Boolean).join("\n\n");
}

/** Paths inside the repo lose the repo prefix; the console has no room for
 *  a full absolute path on every line. */
function shorten(path: string, root?: string): string {
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

/** The one line the timeline shows for a tool call. Bash shows the command,
 *  file tools show the path, and anything else shows its name. */
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
      return `edit ${str("file_path")}`;
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
      return "update the plan";
    default: {
      const first = Object.values(input).find((v) => typeof v === "string");
      return first ? `${name} ${String(first).slice(0, 80)}` : name;
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
  try {
    return JSON.stringify(input, null, 2).slice(0, 4000);
  } catch {
    return name;
  }
}
