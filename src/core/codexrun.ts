/** Runs on Codex: one `codex app-server` process per run, spoken to over
 *  stdio with JSON-RPC (`codexrpc.ts`).
 *
 *  `codex exec` would be simpler, but it forces approvals to "never", and a
 *  run in canopy asks the browser before it does anything the rules do not
 *  cover. The app-server asks the client instead: a command or a file change
 *  outside the sandbox comes to canopy as a server request, parks the run
 *  like a Claude permission prompt does, and goes back as accept or decline.
 *
 *  The wire, as measured against codex-cli 0.158.0 (the tests' stand-in
 *  server pins this subset, so a change shows up as a failing test):
 *
 *  - `initialize {clientInfo, capabilities}`, then the `initialized`
 *    notification. The answer's `userAgent` is `<client name>/<codex
 *    version> (...)`, which is where the version check reads the version.
 *  - `thread/start {cwd, model?, approvalPolicy, sandbox, config?,
 *    developerInstructions?}`. The thread's id is the run's session: what
 *    `codex resume <id>` takes later.
 *  - `turn/start {threadId, input: [{type: "text", text, text_elements}],
 *    effort?}`, one per message. A chat's next message is another turn on
 *    the same thread.
 *  - `item/started` and `item/completed` notifications carry `ThreadItem`s
 *    tagged in camelCase (`agentMessage`, `commandExecution`, `fileChange`,
 *    `mcpToolCall`, `webSearch`, ...). The completed one is authoritative.
 *  - `thread/tokenUsage/updated` comes before `turn/completed`, whose
 *    `turn.status` is completed, interrupted or failed.
 *  - Server requests (ids start at 0): `item/commandExecution/requestApproval`
 *    (the command is `/bin/sh -lc '<script>'` as one string),
 *    `item/fileChange/requestApproval` (no paths: those came with the
 *    `fileChange` item just before), `item/permissions/requestApproval`,
 *    `item/tool/requestUserInput`. Each is followed by
 *    `serverRequest/resolved`, which also comes for a request the server
 *    cleared on its own when the turn ended or was interrupted.
 *  - `turn/interrupt {threadId, turnId}` ends a running turn, which then
 *    completes as interrupted. The server exits on its own at stdin EOF. */

import { resolve } from "node:path";
import { describeTool, toolDetail } from "./actions";
import { splitArgs } from "./agent";
import { bunSpawn, RpcClient, RpcClosed, RpcError, type RpcExit, type RpcRequest, type RpcSpawn } from "./codexrpc";
import type { DriveAgent, DriveCtx, DriveResult, DriveTokens, PromptInput, RunDriver } from "./driver";
import type { RunAnswer, RunQuestion, RunStep, RunTool } from "./types";

/** characters of tool output kept per step, as for a Claude run */
const OUTPUT_CAP = 2_000;
/** characters of a prompt's detail */
const DETAIL_CAP = 4_000;
/** from an interrupt or a polite close to a kill */
const GRACE_MS = 5_000;

/** The versions this driver was measured against: from 0.158.0, below
 *  0.159.0. The app-server is marked experimental and codex moves quickly,
 *  so anything outside gets a note rather than a refusal. */
export const CODEX_TESTED = { from: "0.158.0", below: "0.159.0" } as const;

/** Claude's model aliases. A setting carried over from a Claude run cannot
 *  name a Codex model, so it is left to Codex's own default. */
const CLAUDE_MODELS = new Set(["fable", "opus", "sonnet", "haiku"]);

/** What canopy's prompts need Codex to know. The ground rules in actions.ts
 *  name Claude's AskUserQuestion; Codex's tool for the same thing is
 *  request_user_input, which canopy turns on for the run. */
const DEVELOPER = [
  "You are running inside canopy, a multi-repo git dashboard. A person reads this run in canopy's browser console and answers your questions and approval requests there.",
  "Where your instructions say to ask with AskUserQuestion, use your request_user_input tool instead: canopy shows its questions to the user and returns the answer.",
].join("\n");

/** An answer for every question in a set the user closed without answering,
 *  in the words a Claude run gets when a question is dismissed. */
const DISMISSED = "The user closed the question without answering. Stop and summarize.";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? o[k] : "");

const num = (o: Record<string, unknown>, k: string): number | null => (typeof o[k] === "number" ? o[k] : null);

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

/** Paths inside the repo lose the repo prefix, as in actions.ts. */
function shorten(path: string, root: string): string {
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

/** Where the codex binary is, or null. */
export function codexBinary(): string | null {
  return Bun.which("codex");
}

/* ---------- version ---------- */

/** The version in `codex --version` output ("codex-cli 0.158.0") or in the
 *  app-server's user agent ("canopy/0.158.0 (Debian 13; x86_64) ..."), or
 *  null when neither shape is there. */
export function codexVersion(text: string): string | null {
  const m =
    /codex-cli\s+(\d+\.\d+\.\d+)/.exec(text) ?? /^[^/\s]+\/(\d+\.\d+\.\d+)/.exec(text.trim());
  return m?.[1] ?? null;
}

/** Negative, zero or positive, comparing dotted numbers part by part. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The run's first note when the codex here is not one this driver was
 *  measured against, else null. */
export function versionNote(version: string | null): string | null {
  const range = `${CODEX_TESTED.from} up to ${CODEX_TESTED.below}`;
  if (!version) return `codex did not say its version; canopy is tested with ${range}, so this run may misbehave`;
  if (compareVersions(version, CODEX_TESTED.from) < 0) {
    return `codex ${version} is older than canopy is tested with (${range}); update codex if this run misbehaves`;
  }
  if (compareVersions(version, CODEX_TESTED.below) >= 0) {
    return `codex ${version} is newer than canopy is tested with (${range}); its app-server protocol may have changed`;
  }
  return null;
}

/* ---------- the process and the thread ---------- */

export interface ThreadPolicy {
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

/** Yolo is the pair `--dangerously-bypass-approvals-and-sandbox` sets: no
 *  approvals, no sandbox. Otherwise commands run in the workspace-write
 *  sandbox and Codex asks, through canopy, for anything beyond it. */
export function threadPolicy(agent: Pick<DriveAgent, "yolo">): ThreadPolicy {
  return agent.yolo
    ? { approvalPolicy: "never", sandbox: "danger-full-access" }
    : { approvalPolicy: "on-request", sandbox: "workspace-write" };
}

/** The extra-flags box, cut down to what `codex app-server` takes: `-c
 *  key=value` (or `--config`), `--enable` and `--disable`. The rest of the
 *  box is for an interactive codex (`--search`, `-m`, ...); passed here it
 *  would stop the server from starting. */
export function configFlags(extra: string): string[] {
  const words = splitArgs(extra);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    const eq = /^(-c|--config|--enable|--disable)=(.+)$/.exec(w);
    if (eq) {
      out.push(eq[1] ?? "", eq[2] ?? "");
      continue;
    }
    const next = words[i + 1];
    if ((w === "-c" || w === "--config" || w === "--enable" || w === "--disable") && next !== undefined) {
      out.push(w, next);
      i++;
    }
  }
  return out;
}

/** argv after the binary. The transport is named, not left to the default,
 *  so a change of default cannot move canopy off stdio. */
export function appServerArgs(agent: Pick<DriveAgent, "extra">): string[] {
  return ["app-server", "--listen", "stdio://", ...configFlags(agent.extra)];
}

const codexModel = (model: string): string | null =>
  model && model !== "default" && !CLAUDE_MODELS.has(model) ? model : null;

const codexEffort = (effort: string): string | null => (effort && effort !== "default" ? effort : null);

export interface ThreadOptions {
  /** let Codex ask questions (request_user_input) outside plan mode */
  askQuestions: boolean;
  /** replaces the policy the agent settings imply */
  policy?: Partial<ThreadPolicy>;
}

/** `thread/start` params. `request_user_input` is off outside plan mode
 *  unless its feature is on, and turning it on prints an "under-development
 *  features" warning unless that is suppressed; both ride in the thread's
 *  config, so the user's config.toml is never touched. */
export function threadParams(cwd: string, agent: DriveAgent, opts: ThreadOptions): Record<string, unknown> {
  const model = codexModel(agent.model);
  // An override left undefined must not blank the policy out: a thread/start
  // without one falls back to the user's config.toml, which may say
  // danger-full-access.
  const override = Object.fromEntries(Object.entries(opts.policy ?? {}).filter(([, v]) => v !== undefined));
  return {
    cwd,
    ...(model ? { model } : {}),
    ...threadPolicy(agent),
    ...override,
    ...(opts.askQuestions
      ? {
          config: {
            "features.default_mode_request_user_input": true,
            suppress_unstable_features_warning: true,
          },
          developerInstructions: DEVELOPER,
        }
      : {}),
  };
}

/** `turn/start` params for one message. */
export function turnParams(threadId: string, text: string, agent: DriveAgent): Record<string, unknown> {
  const effort = codexEffort(agent.effort);
  return {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
    ...(effort ? { effort } : {}),
  };
}

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

/** What canopy knows about an approval when it decides whether a rule
 *  covers it. */
export type ApprovalFacts =
  | { kind: "command"; command: string | null }
  | { kind: "fileChange"; paths: string[] | null; grantRoot: string | null }
  | { kind: "other" };

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** Whether a job's rules answer this approval without asking. A command is
 *  accepted when it is one simple command whose words start with a `Bash(x:*)`
 *  rule's words, or equal a `Bash(x)` rule's. A file change is accepted when
 *  the rules allow editing and every path it touches is inside the repo; one
 *  that also asks for write access under another root never is. Anything
 *  else goes to the human, as it would for Claude. */
export function autoAnswer(rules: readonly string[], facts: ApprovalFacts, cwd: string): boolean {
  const parsed = rules.map(parseRule).filter((r): r is ToolRule => r !== null);
  if (facts.kind === "command") {
    const words = facts.command === null ? null : commandWords(facts.command);
    if (!words) return false;
    return parsed.some(
      (r) =>
        r.kind === "bash" &&
        (r.prefix ? words.length >= r.words.length : words.length === r.words.length) &&
        r.words.every((w, i) => words[i] === w),
    );
  }
  if (facts.kind === "fileChange") {
    if (facts.grantRoot || !facts.paths || facts.paths.length === 0) return false;
    if (!parsed.some((r) => r.kind === "tool" && EDIT_TOOLS.has(r.name))) return false;
    return facts.paths.every((p) => resolve(cwd, p).startsWith(cwd.replace(/\/+$/, "") + "/"));
  }
  return false;
}

/* ---------- items: what the timeline shows ---------- */

type FileChange = { path: string; kind: string; movePath: string | null; diff: string };

function fileChanges(item: Record<string, unknown>): FileChange[] {
  const raw = item["changes"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c: unknown) => {
    if (!isRecord(c) || !str(c, "path")) return [];
    const kind = rec(c["kind"]);
    return [{ path: str(c, "path"), kind: str(kind, "type"), movePath: str(kind, "move_path") || null, diff: str(c, "diff") }];
  });
}

/** "edit a.ts", "write b.ts", "move c.ts to d.ts", "edit a.ts, b.ts and 2 more" */
function changeTitle(changes: FileChange[], root: string): string {
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

function changeDiff(changes: FileChange[], root: string): string {
  return changes.map((c) => `${shorten(c.path, root)}\n${c.diff.trim()}`.trim()).join("\n\n");
}

/** The first string among a tool's arguments, as describeTool shows one. */
function firstArg(args: unknown): string {
  const first = isRecord(args) ? Object.values(args).find((v) => typeof v === "string") : undefined;
  return typeof first === "string" ? first.slice(0, 80) : "";
}

/** Text out of an MCP result's content blocks. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: unknown) => (isRecord(c) && str(c, "type") === "text" ? str(c, "text") : ""))
    .filter(Boolean)
    .join("\n");
}

type Phase = "started" | "completed";

/** Codex's item status as a step's. An item with no status of its own (a web
 *  search) is running until it completes. */
function toolStatus(item: Record<string, unknown>, phase: Phase): RunTool["status"] {
  const s = str(item, "status");
  if (s === "inProgress") return "running";
  if (s === "failed" || s === "declined" || s === "interrupted") return "error";
  if (s === "completed") return "ok";
  return phase === "completed" ? "ok" : "running";
}

/** A tool-like item as the timeline's tool step, or null for an item that is
 *  not one (messages, reasoning, ...). Names follow Claude's where one fits,
 *  so the console's icons and words need no second vocabulary: a command is
 *  `Bash`, a file change `Edit`, an MCP call `mcp__<server>__<tool>`. */
export function itemTool(item: Record<string, unknown>, phase: Phase, root: string): RunTool | null {
  const type = str(item, "type");
  const status = toolStatus(item, phase);
  const withOutput = (tool: RunTool, output: string): RunTool => {
    const text = output.trim();
    return text ? { ...tool, output: clip(text, OUTPUT_CAP) } : tool;
  };
  switch (type) {
    case "commandExecution": {
      const script = unwrapShell(str(item, "command"));
      const exit = num(item, "exitCode");
      const failed = status === "ok" && exit !== null && exit !== 0;
      const declined = str(item, "status") === "declined";
      return withOutput(
        { name: "Bash", title: describeTool("Bash", { command: script }), status: failed ? "error" : status },
        declined ? "declined" : str(item, "aggregatedOutput"),
      );
    }
    case "fileChange": {
      const changes = fileChanges(item);
      return withOutput(
        { name: "Edit", title: changeTitle(changes, root), status },
        str(item, "status") === "declined" ? "declined" : phase === "completed" ? changeDiff(changes, root) : "",
      );
    }
    case "mcpToolCall": {
      const server = str(item, "server");
      const tool = str(item, "tool");
      const arg = firstArg(item["arguments"]);
      const error = str(rec(item["error"]), "message");
      return withOutput(
        { name: `mcp__${server}__${tool}`, title: `${server} ${tool}${arg ? ` ${arg}` : ""}`, status },
        error || contentText(rec(item["result"])["content"]),
      );
    }
    case "webSearch": {
      const query = str(item, "query");
      return { name: "WebSearch", title: query ? `web search ${query}` : "web search", status };
    }
    case "dynamicToolCall": {
      const tool = str(item, "tool");
      const arg = firstArg(item["arguments"]);
      const bad = item["success"] === false;
      return { name: tool || "tool", title: `${tool}${arg ? ` ${arg}` : ""}`, status: bad ? "error" : status };
    }
    case "collabAgentToolCall": {
      const prompt = str(item, "prompt").split("\n")[0]?.slice(0, 80) ?? "";
      return { name: "Agent", title: `agent: ${prompt || str(item, "tool") || "subtask"}`, status };
    }
    case "imageView":
      return { name: "Read", title: `view ${shorten(str(item, "path"), root)}`, status };
    case "plan":
      return withOutput({ name: "Plan", title: "update the plan", status }, str(item, "text"));
    default:
      return null;
  }
}

/* ---------- approvals and questions ---------- */

/** A server request's params as the permission prompt the browser shows.
 *  `item` is the item the request is about, when canopy has seen it: a file
 *  change's paths and diff arrive with the item, not the request. */
export function approvalPrompt(
  method: string,
  params: Record<string, unknown>,
  item: Record<string, unknown> | null,
  root: string,
): PromptInput {
  const reason = str(params, "reason");
  const tail = (lines: string[]): string => lines.filter(Boolean).join("\n\n").slice(0, DETAIL_CAP);
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval": {
      const net = rec(params["networkApprovalContext"]);
      if (str(net, "host")) {
        return {
          kind: "permission",
          tool: "Network",
          title: `network access to ${str(net, "host")}`,
          detail: tail([`${str(net, "protocol")} ${str(net, "host")}`, reason]),
        };
      }
      const raw = params["command"];
      const command = Array.isArray(raw) ? joinArgv(raw) : str(params, "command");
      const script = unwrapShell(command);
      const cwd = str(params, "cwd");
      const where = cwd && cwd !== root ? `in ${cwd}` : "";
      if (str(params, "kind") === "writeStdin") {
        return {
          kind: "permission",
          tool: "Bash",
          title: `send input to ${script}`,
          detail: tail([script, where, reason]),
        };
      }
      return {
        kind: "permission",
        tool: "Bash",
        title: describeTool("Bash", { command: script }),
        detail: tail([toolDetail("Bash", { command: script }), where, reason]),
      };
    }
    case "item/fileChange/requestApproval":
    case "applyPatchApproval": {
      const changes = method === "applyPatchApproval" ? legacyChanges(params["fileChanges"]) : fileChanges(item ?? {});
      const grant = str(params, "grantRoot");
      return {
        kind: "permission",
        tool: "Edit",
        title: changeTitle(changes, root) + (grant ? `, and write access under ${grant}` : ""),
        detail: tail([
          changeDiff(changes, root),
          grant ? `also asks to write anywhere under ${grant} for the rest of the run` : "",
          reason,
        ]),
      };
    }
    case "item/permissions/requestApproval": {
      const perms = rec(params["permissions"]);
      const net = rec(perms["network"]);
      const fs = rec(perms["fileSystem"]);
      const paths = (k: string) => (Array.isArray(fs[k]) ? fs[k].filter((p): p is string => typeof p === "string") : []);
      const parts = [
        ...(net["enabled"] === true ? ["network"] : []),
        ...paths("write").map((p) => `write ${shorten(p, root)}`),
        ...paths("read").map((p) => `read ${shorten(p, root)}`),
      ];
      return {
        kind: "permission",
        tool: "Permissions",
        title: `more access: ${parts.join(", ") || "sandbox permissions"}`,
        detail: tail([JSON.stringify(perms, null, 2), reason]),
      };
    }
    default:
      return { kind: "permission", tool: method, title: method, detail: tail([JSON.stringify(params, null, 2)]) };
  }
}

/** The legacy approval's argv as one line, quoted where a word needs it. */
function joinArgv(argv: unknown[]): string {
  return argv
    .map((a) => String(a))
    .map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'"'"'`)}'`))
    .join(" ");
}

/** The legacy applyPatchApproval's `{path: FileChange}` map as changes. */
function legacyChanges(raw: unknown): FileChange[] {
  if (!isRecord(raw)) return [];
  return Object.entries(raw).map(([path, c]) => {
    const o = rec(c);
    const kind = str(o, "type");
    return { path, kind, movePath: str(o, "move_path") || null, diff: str(o, "unified_diff") || str(o, "content") };
  });
}

/** What canopy's rules can judge an approval by. */
export function approvalFacts(
  method: string,
  params: Record<string, unknown>,
  item: Record<string, unknown> | null,
): ApprovalFacts {
  if (method === "item/commandExecution/requestApproval") {
    // a network prompt carries no command, and input for a running program
    // is not the command it runs
    if (isRecord(params["networkApprovalContext"]) || str(params, "kind") === "writeStdin") return { kind: "other" };
    return { kind: "command", command: str(params, "command") || null };
  }
  if (method === "item/fileChange/requestApproval") {
    return {
      kind: "fileChange",
      paths: item ? fileChanges(item).flatMap((c) => (c.movePath ? [c.path, c.movePath] : [c.path])) : null,
      grantRoot: str(params, "grantRoot") || null,
    };
  }
  return { kind: "other" };
}

/** The reply to an approval request. "allow all" is `acceptForSession` where
 *  the request offers it; canopy then lets every later one through itself.
 *  A deny while the run is being stopped is `cancel`, which also ends the
 *  turn, since it is about to be interrupted anyway. */
export function approvalReply(
  method: string,
  params: Record<string, unknown>,
  a: RunAnswer,
  stopping: boolean,
): unknown {
  const allow = a.kind === "allow" || a.kind === "allow-all";
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": {
      const offered = Array.isArray(params["availableDecisions"]) ? params["availableDecisions"] : null;
      const session = !offered || offered.includes("acceptForSession");
      const decision =
        a.kind === "allow-all" ? (session ? "acceptForSession" : "accept") : allow ? "accept" : stopping ? "cancel" : "decline";
      return { decision };
    }
    case "item/permissions/requestApproval": {
      if (!allow) return { permissions: {}, scope: "turn" };
      // grant exactly what was asked for, nulls left out
      const asked = rec(params["permissions"]);
      const granted = Object.fromEntries(Object.entries(asked).filter(([, v]) => v !== null && v !== undefined));
      return { permissions: granted, scope: a.kind === "allow-all" ? "session" : "turn" };
    }
    case "execCommandApproval":
    case "applyPatchApproval":
      return {
        decision:
          a.kind === "allow-all"
            ? "approved_for_session"
            : allow
              ? "approved"
              : stopping
                ? "abort"
                : { denied: { rejection: "The user declined this in canopy." } },
      };
    default:
      return {};
  }
}

/** `item/tool/requestUserInput` as a question prompt, with each question's
 *  Codex id in the same order. The browser keys answers by question text, so
 *  a repeated text gets a counter. A secret question says the answer will
 *  show, since the console keeps what was answered. */
export function questionPrompt(params: Record<string, unknown>): {
  prompt: { kind: "question"; questions: RunQuestion[] };
  ids: string[];
} {
  const raw = Array.isArray(params["questions"]) ? params["questions"] : [];
  const questions: RunQuestion[] = [];
  const ids: string[] = [];
  const seen = new Map<string, number>();
  for (const q of raw) {
    if (!isRecord(q) || !str(q, "id")) continue;
    let text = str(q, "question") || str(q, "header") || "?";
    if (q["isSecret"] === true) text += " (the answer will show in canopy's timeline)";
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    if (n > 1) text += ` (${n})`;
    const options = Array.isArray(q["options"])
      ? q["options"].flatMap((o: unknown) =>
          isRecord(o) && str(o, "label") ? [{ label: str(o, "label"), description: str(o, "description") }] : [],
        )
      : [];
    questions.push({ question: text, header: str(q, "header"), options, multiSelect: false });
    ids.push(str(q, "id"));
  }
  return { prompt: { kind: "question", questions }, ids };
}

/** The reply to `item/tool/requestUserInput`: each question's answer under
 *  its id. A dismissed set tells Codex so in every answer, as a dismissed
 *  question tells Claude. */
export function questionReply(questions: RunQuestion[], ids: string[], a: RunAnswer): unknown {
  const answers: Record<string, { answers: string[] }> = {};
  questions.forEach((q, i) => {
    const id = ids[i];
    if (id === undefined) return;
    const given = a.kind === "answers" ? a.answers[q.question]?.trim() : undefined;
    answers[id] = { answers: [given || DISMISSED] };
  });
  return { answers };
}

/* ---------- the result ---------- */

export function tokensOf(breakdown: unknown): DriveTokens | undefined {
  if (!isRecord(breakdown)) return undefined;
  const n = (k: string) => num(breakdown, k) ?? 0;
  return {
    input: n("inputTokens"),
    cachedInput: n("cachedInputTokens"),
    output: n("outputTokens"),
    reasoning: n("reasoningOutputTokens"),
    total: n("totalTokens"),
  };
}

/** The text a turn ended with: its final answer, else its last message,
 *  else whatever the completed turn's own item summary holds. */
function closingText(final: string, last: string, turn: Record<string, unknown>): string {
  if (final || last) return final || last;
  const items = Array.isArray(turn["items"]) ? turn["items"] : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = rec(items[i]);
    if (str(it, "type") === "agentMessage" && str(it, "text").trim()) return str(it, "text").trim();
  }
  return "";
}

/** `turn/completed` as the run's result and, when it did not complete, the
 *  problem the run reports. `turns` counts Codex turns on the thread, one per
 *  message: Codex does not report the model calls inside one. */
export function turnResult(
  turn: Record<string, unknown>,
  texts: { final: string; last: string },
  turns: number,
  tokens: DriveTokens | undefined,
  elapsedMs: number,
): { result: DriveResult; problem: string | null } {
  const status = str(turn, "status");
  const error = rec(turn["error"]);
  const detail = [str(error, "message"), str(error, "additionalDetails")].filter(Boolean).join("\n");
  const problem =
    status === "completed"
      ? null
      : status === "interrupted"
        ? "the turn was interrupted"
        : status === "failed"
          ? detail || "Codex reported an error"
          : `the turn ended as ${status || "unknown"}`;
  return {
    result: {
      text: closingText(texts.final, texts.last, turn),
      durationMs: num(turn, "durationMs") ?? elapsedMs,
      turns,
      ...(tokens ? { tokens } : {}),
    },
    problem,
  };
}

/* ---------- the driver ---------- */

export interface CodexOptions {
  /** argv that starts codex, before `app-server`; the default is the codex
   *  binary on PATH (the stand-in server in tests) */
  command?: readonly string[];
  spawn?: RpcSpawn;
  /** who canopy says it is in `initialize`; the name also leads the user
   *  agent codex sends upstream */
  client?: { name: string; title: string; version: string };
  /** from an interrupt or a polite close to a kill */
  graceMs?: number;
  /** let Codex ask questions outside plan mode (default on: canopy's ground
   *  rules tell the agent to ask when it is stuck) */
  askQuestions?: boolean;
  /** Replaces the approval policy and sandbox the agent settings imply, for
   *  a host whose sandbox cannot start. Measured in canopy's shells
   *  container: bwrap cannot make a user namespace under docker's default
   *  seccomp profile, so every workspace-write command fails ("bwrap: No
   *  permissions to create a new namespace") and Codex asks to rerun it
   *  outside the sandbox. */
  policy?: Partial<ThreadPolicy>;
}

/** Notifications canopy never reads, left off the wire: the streaming
 *  deltas (the completed item carries the whole text) and reasoning. */
const QUIET = [
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/plan/delta",
];

export class CodexDriver implements RunDriver {
  readonly harness = "codex" as const;
  readonly label = "Codex";
  private ctx: DriveCtx | null = null;
  private rpc: RpcClient | null = null;
  private thread: string | null = null;
  /** the running turn, from turn/start's answer or turn/started */
  private turn: string | null = null;
  /** the thread or the first turn is still being set up */
  private starting = false;
  private turns = 0;
  private turnAt = 0;
  private finalText = "";
  private lastText = "";
  private tokens: DriveTokens | undefined;
  /** item id → its tool step */
  private steps = new Map<string, RunStep>();
  /** item id → the last item seen under it, for approvals about it */
  private items = new Map<string, Record<string, unknown>>();
  /** server requests the server cleared before canopy answered */
  private resolved = new Set<string>();
  /** requests canopy is still deciding */
  private asking = new Set<string>();
  /** the last turn that completed: its turn/start answer can be read after
   *  its completion when both arrive in one chunk */
  private ended: string | null = null;
  /** a stop came while a turn ran or the thread was being set up */
  private interrupting = false;
  /** the grace timer ended a process canopy had asked to go */
  private graceKilled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** why canopy killed the process itself, reported with its exit */
  private failure: string | null = null;

  constructor(private opts: CodexOptions = {}) {}

  check(): string | null {
    if (this.opts.command?.length) return null;
    return codexBinary() ? null : "the codex CLI is not on PATH; install Codex and sign in first";
  }

  start(ctx: DriveCtx, message: string): void {
    this.ctx = ctx;
    void this.open(message);
  }

  say(text: string): void {
    void this.send(text, false);
  }

  stop(): void {
    const rpc = this.rpc;
    if (!rpc) {
      // still spawning: open() sees this and goes no further
      this.interrupting = true;
      return;
    }
    if (this.turn !== null || this.starting) {
      this.interrupting = true;
      if (this.turn !== null && this.thread !== null) {
        rpc.request("turn/interrupt", { threadId: this.thread, turnId: this.turn }).catch(() => {});
        this.killLater();
      } else {
        // nothing to interrupt yet: the thread is still being set up
        rpc.kill();
      }
      return;
    }
    // A chat between turns: close stdin and let the server exit on its own.
    this.close();
  }

  /** Spawns the server, opens the thread and sends the first message. */
  private async open(message: string): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const command = this.opts.command?.length ? [...this.opts.command] : [codexBinary() ?? "codex"];
    let rpc: RpcClient;
    try {
      const proc = (this.opts.spawn ?? bunSpawn)([...command, ...appServerArgs(ctx.agent)], {
        cwd: ctx.cwd,
        env: { ...process.env, ...ctx.env },
      });
      rpc = new RpcClient(proc);
    } catch (err) {
      ctx.exited({ code: null, stderr: "", error: `could not start codex: ${errText(err)}` });
      return;
    }
    this.rpc = rpc;
    rpc.onNotification((method, params) => this.notified(method, rec(params)));
    rpc.onRequest((req) => void this.requested(req));
    void rpc.done.then((exit) => this.gone(exit));
    if (this.interrupting) {
      rpc.kill();
      return;
    }
    this.starting = true;
    try {
      const client = this.opts.client ?? { name: "canopy", title: "canopy", version: "0" };
      const init = rec(
        await rpc.request("initialize", {
          clientInfo: client,
          capabilities: { experimentalApi: false, optOutNotificationMethods: QUIET },
        }),
      );
      rpc.notify("initialized");
      const warn = versionNote(codexVersion(str(init, "userAgent")));
      if (warn) ctx.note(warn);
      const started = rec(
        await rpc.request(
          "thread/start",
          threadParams(ctx.cwd, ctx.agent, {
            askQuestions: this.opts.askQuestions ?? true,
            ...(this.opts.policy ? { policy: this.opts.policy } : {}),
          }),
        ),
      );
      const id = str(rec(started["thread"]), "id");
      if (!id) throw new Error("codex started a thread without an id");
      this.thread = id;
      ctx.session(id);
      if (this.interrupting) {
        rpc.kill();
        return;
      }
      await this.send(message, true);
    } catch (err) {
      this.starting = false;
      this.fail(err, "could not start the codex thread");
    }
  }

  /** One message as a turn. The first one's failure fails the run; a later
   *  one in a chat is a failed reply, and the chat goes on. */
  private async send(text: string, first: boolean): Promise<void> {
    const rpc = this.rpc;
    const ctx = this.ctx;
    if (!rpc || !ctx || this.thread === null) return;
    this.turns += 1;
    this.turnAt = Date.now();
    this.finalText = "";
    this.lastText = "";
    try {
      const r = rec(await rpc.request("turn/start", turnParams(this.thread, text, ctx.agent)));
      // turn/started may have said so already, and turn/completed may have
      // come in the same chunk as this answer and been handled first
      const id = str(rec(r["turn"]), "id") || null;
      if (id !== this.ended) this.turn ??= id;
      this.starting = false;
      if (this.interrupting && this.turn !== null) {
        rpc.request("turn/interrupt", { threadId: this.thread, turnId: this.turn }).catch(() => {});
        this.killLater();
      }
    } catch (err) {
      this.starting = false;
      if (first || err instanceof RpcClosed) {
        this.fail(err, "codex refused the message");
        return;
      }
      ctx.result({ text: "", durationMs: 0, turns: this.turns }, `codex refused the message: ${errText(err)}`);
    }
  }

  /** A failure canopy found itself. The process goes, and its exit reports
   *  the failure with what stderr said. When the process already went, its
   *  own exit is the better report. */
  private fail(err: unknown, what: string): void {
    if (err instanceof RpcClosed) return;
    if (this.interrupting) {
      this.rpc?.kill();
      return;
    }
    this.failure = err instanceof RpcError ? `${what}: ${err.message}` : `${what}: ${errText(err)}`;
    this.rpc?.kill();
  }

  private gone(exit: RpcExit): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.turn = null;
    // A process told to go that lingered past the grace went as asked.
    const code = this.graceKilled ? 0 : exit.code;
    this.ctx?.exited({ code, stderr: exit.stderr, ...(this.failure ? { error: this.failure } : {}) });
  }

  /** Stdin closed: the server exits on its own. The kill is for one that
   *  does not. */
  private close(): void {
    this.rpc?.end();
    this.killLater();
  }

  private killLater(): void {
    if (this.timer || !this.rpc || this.rpc.closed) return;
    const t = setTimeout(() => {
      this.graceKilled = !this.interrupting;
      this.rpc?.kill();
    }, this.opts.graceMs ?? GRACE_MS);
    // a lingering server must not hold canopy (or a test) open
    (t as { unref?: () => void }).unref?.();
    this.timer = t;
  }

  /** Notifications for another thread (a sub-agent's) are not this run's. */
  private ours(params: Record<string, unknown>): boolean {
    const t = params["threadId"];
    return this.thread === null || typeof t !== "string" || t === this.thread;
  }

  private notified(method: string, params: Record<string, unknown>): void {
    const ctx = this.ctx;
    if (!ctx || !this.ours(params)) return;
    switch (method) {
      case "item/started":
      case "item/completed":
        this.item(rec(params["item"]), method === "item/started" ? "started" : "completed");
        return;
      case "turn/started":
        this.turn = str(rec(params["turn"]), "id") || this.turn;
        return;
      case "thread/tokenUsage/updated":
        this.tokens = tokensOf(rec(params["tokenUsage"])["total"]) ?? this.tokens;
        return;
      case "turn/completed":
        this.completed(rec(params["turn"]));
        return;
      case "serverRequest/resolved": {
        const key = String(params["requestId"]);
        if (this.asking.has(key)) {
          this.resolved.add(key);
          ctx.withdraw(key);
        }
        return;
      }
      case "error":
        if (params["willRetry"] === true) {
          ctx.note(`codex hit an error and is retrying: ${str(rec(params["error"]), "message") || "unknown error"}`);
        }
        return;
      case "warning":
        if (str(params, "message")) ctx.note(`codex: ${str(params, "message")}`);
        return;
      case "configWarning":
        if (str(params, "summary")) ctx.note(`codex config: ${str(params, "summary")}`);
        return;
      case "model/rerouted":
        ctx.note(`codex moved this turn from ${str(params, "fromModel")} to ${str(params, "toModel")}`);
        return;
      default:
        return;
    }
  }

  private item(item: Record<string, unknown>, phase: Phase): void {
    const ctx = this.ctx;
    const id = str(item, "id");
    if (!ctx || !id) return;
    this.items.set(id, item);
    const type = str(item, "type");
    if (type === "agentMessage") {
      const text = str(item, "text").trim();
      if (phase !== "completed" || !text) return;
      this.lastText = text;
      if (str(item, "phase") === "final_answer") this.finalText = text;
      ctx.step({ kind: "text", text });
      ctx.changed();
      return;
    }
    if (type === "contextCompaction") {
      if (phase === "completed") ctx.note("codex compacted the conversation to fit");
      return;
    }
    const tool = itemTool(item, phase, ctx.cwd);
    if (!tool) return;
    const step = this.steps.get(id);
    if (step?.tool) {
      step.tool = tool;
    } else {
      this.steps.set(id, ctx.step({ kind: "tool", tool }));
    }
    if (phase === "completed") this.items.delete(id);
    ctx.changed();
  }

  private completed(turn: Record<string, unknown>): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.ended = str(turn, "id") || null;
    this.turn = null;
    this.steps.clear();
    this.items.clear();
    if (this.interrupting) {
      // the stop's own interrupt: the process goes, and its exit is the stop
      this.close();
      return;
    }
    const { result, problem } = turnResult(
      turn,
      { final: this.finalText, last: this.lastText },
      this.turns,
      this.tokens,
      Date.now() - this.turnAt,
    );
    ctx.result(result, problem);
    // a job is one turn; a chat keeps the thread for the next message
    if (!ctx.chat) this.close();
  }

  private async requested(req: RpcRequest): Promise<void> {
    const rpc = this.rpc;
    const ctx = this.ctx;
    if (!rpc || !ctx) return;
    const params = rec(req.params);
    const key = String(req.id);
    switch (req.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
      case "execCommandApproval":
      case "applyPatchApproval": {
        const item = this.items.get(str(params, "itemId")) ?? null;
        if (autoAnswer(ctx.spec.allowedTools, approvalFacts(req.method, params, item), ctx.cwd)) {
          rpc.reply(req.id, approvalReply(req.method, params, { kind: "allow" }, false));
          return;
        }
        const a = await this.ask(approvalPrompt(req.method, params, item, ctx.cwd), key);
        if (a) rpc.reply(req.id, approvalReply(req.method, params, a, this.interrupting));
        return;
      }
      case "item/tool/requestUserInput": {
        const { prompt, ids } = questionPrompt(params);
        if (prompt.questions.length === 0) {
          rpc.reply(req.id, { answers: {} });
          return;
        }
        const a = await this.ask(prompt, key);
        if (a) rpc.reply(req.id, questionReply(prompt.questions, ids, a));
        return;
      }
      case "mcpServer/elicitation/request":
        // a form or a link from an MCP server: canopy has no way to show one
        ctx.note(`declined ${str(params, "serverName") || "an MCP server"}'s request for input: canopy cannot show it`);
        rpc.reply(req.id, { action: "decline", content: null, _meta: null });
        return;
      default:
        rpc.replyError(req.id, -32601, `canopy does not handle ${req.method}`);
    }
  }

  /** Parks the run on a prompt. Null when the server cleared the request
   *  first: it is answered already, and a reply would go nowhere. */
  private async ask(prompt: PromptInput, key: string): Promise<RunAnswer | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    this.asking.add(key);
    try {
      const a = await ctx.ask(prompt, key);
      return this.resolved.has(key) ? null : a;
    } finally {
      this.asking.delete(key);
      this.resolved.delete(key);
    }
  }
}
