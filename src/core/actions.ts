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

const SUBMODULE_STEP = `If an entry in git status is a submodule (git status --porcelain=v2 marks it with an S field, or git diff --submodule shows it), handle it inside the submodule first: go into its directory and commit there by the same rules (and when this task pushes, push the submodule before pushing this repo, so the pointer stays reachable), then stage the updated pointer in this repo and commit that. Untracked or modified content inside a submodule is a change to deal with, not a reason to stop.`;

const STRAY_STEP = `For each file you would not commit on your own (build output, a stray backup, an editor file, something that looks accidental), ask with AskUserQuestion what to do with it: commit it, add it to .gitignore and commit that, delete it, or leave it. Do what the user picks. Skip the question only if the user's note already decided.`;

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
  commit: {
    label: "commit",
    verb: "commit",
    blurb:
      "Claude reads the diff, stages what belongs, writes the message in this repo's style and commits. Unrelated changes become separate commits. Nothing is pushed.",
    notePlaceholder: "anything Claude should know (optional)",
    noteRequired: false,
    allowedTools: [...GIT_READ, ...GIT_COMMIT],
    maxTurns: 30,
    progress: "committing",
    expectsChange: true,
    mode: "job",
    task: `Task: commit the current changes, so that git status is clean afterwards.
1. Look at git status and the full diff, including untracked files.
2. ${SUBMODULE_STEP}
3. ${STRAY_STEP}
4. Stage what belongs together. If the changes are clearly unrelated, make more than one commit, each with its own coherent set of files. Otherwise make one.
5. Match the style of recent messages (git log --oneline -15): imperative subject under 65 characters, optional body explaining why.
6. Do not push.`,
  },
  push: {
    label: "push",
    verb: "push",
    blurb:
      "Claude pushes the current branch. A branch with no upstream gets one. If the remote is ahead, Claude rebases only when that is clearly safe, and otherwise stops and explains. Never a force push.",
    notePlaceholder: "anything Claude should know (optional)",
    noteRequired: false,
    allowedTools: [...GIT_READ, ...GIT_PUSH],
    maxTurns: 20,
    progress: "pushing",
    expectsChange: true,
    mode: "job",
    task: `Task: push the current branch, so that it is no longer ahead of its upstream.
1. If the branch has an upstream, push to it. If not, push with -u to origin, or to the only remote if there is one; if several remotes and no origin, ask which one.
2. If the push is rejected because the remote is ahead: fetch, and rebase onto the upstream only if the rebase completes without conflicts. On any conflict abort the rebase, leave the repo as it was, and ask how to proceed.
3. If there are uncommitted changes as well, ask whether to commit them first (by the commit rules: submodules handled inside first, stray files decided one by one) or push only what is committed.
4. If the commits being pushed point at submodule commits that are not on the submodule's remote, push the submodule first.
5. Never force-push.`,
  },
  "commit-push": {
    label: "commit and push",
    verb: "commit and push",
    blurb:
      "Claude commits the changes the way the commit action does, then pushes the branch the way the push action does.",
    notePlaceholder: "anything Claude should know (optional)",
    noteRequired: false,
    allowedTools: [...GIT_READ, ...GIT_COMMIT, ...GIT_PUSH],
    maxTurns: 40,
    progress: "committing and pushing",
    expectsChange: true,
    mode: "job",
    task: `Task: commit the current changes and push the branch, so that git status is clean and the branch is level with its upstream afterwards.
Commit part:
1. Look at git status and the full diff, including untracked files.
2. ${SUBMODULE_STEP}
3. ${STRAY_STEP}
4. Stage what belongs together. If the changes are clearly unrelated, make more than one commit. Otherwise make one.
5. Match the style of recent messages (git log --oneline -15): imperative subject under 65 characters, optional body explaining why.
Push part:
6. Push to the upstream; with no upstream, push with -u to origin or the only remote; if several remotes and no origin, ask which one.
7. If the remote is ahead: fetch and rebase only if it completes without conflicts; otherwise abort the rebase and ask how to proceed. Never force-push.
8. Check git status and the ahead count once more; if anything is left, deal with it or ask.`,
  },
  deploy: {
    label: "deploy",
    verb: "deploy",
    blurb:
      "Claude works out how this project deploys (Vercel, Firebase, Cloudflare, a Dockerfile, a script...), runs the project's own gates first, and deploys. Uncommitted changes and anything outside the usual pipeline come back to you as a question.",
    notePlaceholder: "target, environment, or anything else Claude should know (optional)",
    noteRequired: false,
    allowedTools: [
      ...GIT_READ,
      ...BUN,
      "Bash(npm run:*)",
      "Bash(cat:*)",
      "Bash(ls:*)",
    ],
    maxTurns: 80,
    progress: "deploying",
    expectsChange: false,
    mode: "job",
    task: `Task: deploy this project to where it normally deploys.
1. Find out how it deploys: vercel.json or .vercel, firebase.json, wrangler.toml, fly.toml, a Dockerfile or compose file, deploy scripts in package.json, a Makefile, and anything CLAUDE.md or README says about deploying. If nothing indicates a deploy target, say so and stop.
2. If there are uncommitted changes, ask with AskUserQuestion whether to commit them first, deploy as-is, or stop.
3. Run the project's own gates before deploying (typecheck, lint, tests, build, in whatever form the project defines them). Stop and report if one fails; do not deploy a failing build.
4. Deploy. Prefer the project's own script over a raw CLI call when both exist.
5. Report the deployment URL and anything you noticed.`,
  },
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

export function canRun(repo: Repo, action: RunAction): RunCheck {
  if (repo.error) return { ok: false, why: "not a readable repo" };
  const st = repo.status;
  const dirty = (st?.files.length ?? 0) > 0;
  const unpushed = (st?.ahead ?? 0) > 0 || !st?.upstream;
  switch (action) {
    case "commit":
      return dirty ? { ok: true } : { ok: false, why: "nothing to commit" };
    case "push":
      return unpushed ? { ok: true } : { ok: false, why: "nothing to push" };
    case "commit-push":
      return dirty || unpushed
        ? { ok: true }
        : { ok: false, why: "nothing to commit or push" };
    default:
      return { ok: true };
  }
}

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
