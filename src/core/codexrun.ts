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
 *  - `thread/start {cwd, model?, modelProvider?, approvalPolicy, sandbox, config?,
 *    developerInstructions?}`. The thread's id is the run's session: what
 *    `codex resume <id>` takes later. A fork (FR-043 plan 3) sends
 *    `thread/fork {threadId, ...the same}` instead, which answers in the
 *    same shape with a new thread id and the old thread's context.
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

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describeTool, toolDetail } from "./actions";
import { splitArgs } from "./agent";
import { takesProvider } from "./harness";
import { sweepCodexTrust } from "./codextrust";
import { bunSpawn, RpcClient, RpcClosed, RpcError, type RpcExit, type RpcRequest, type RpcSpawn } from "./codexrpc";
import { changesInput, codexFold, codexThread, codexTurn, fileChanges, foldCodex, NO_COST, ownThread, type CodexFold, type CodexFolded, type FileChange } from "./codexfold";
import { spawnEnv, type DriveAgent, type DriveCtx, type PromptInput, type RunDriver } from "./driver";
import { commandWords, EDIT_TOOLS, parseRule, unwrapShell, type ToolRule } from "./shellwords";
import type { RunAnswer, RunQuestion } from "./types";

export { codexFold, codexThread, codexTurn, foldCodex, itemTool, NO_COST, tokensOf, turnResult, type CodexFold } from "./codexfold";

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
export const DISMISSED = "The user closed the question without answering. Stop and summarize.";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? o[k] : "");

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
 *  approvals, no sandbox.
 *
 *  Otherwise canopy's rules have to see every command and every edit, the
 *  way a Claude run's permission rules do. `on-request` would not do that:
 *  where the sandbox works, Codex runs any command inside it and applies
 *  patches under the workspace without asking, so the job's rules would
 *  only ever judge the escalations. Of the protocol's `AskForApproval`
 *  values, `untrusted` is the one that asks for every command Codex does
 *  not itself know to be read-only (`ls`, `cat`, `git status`, `rg` and
 *  their kin, which still run inside the sandbox) and for every patch;
 *  `granular` only chooses which kinds of prompt may reach the client, and
 *  `on-request` leaves asking to the model. The sandbox is `read-only`
 *  unless the rules allow editing (`Edit`, `Write` or `MultiEdit`), so a
 *  run that may not edit cannot, even through a command Codex thinks safe;
 *  with an edit rule it is `workspace-write`, and the patches still come
 *  to canopy, which accepts the ones inside the repo. */
export function threadPolicy(agent: Pick<DriveAgent, "yolo">, rules: readonly string[] = []): ThreadPolicy {
  if (agent.yolo) return { approvalPolicy: "never", sandbox: "danger-full-access" };
  return { approvalPolicy: "untrusted", sandbox: allowsEdits(rules) ? "workspace-write" : "read-only" };
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
  /** the job's allowed-tools rules, which pick the sandbox (`threadPolicy`) */
  rules?: readonly string[];
  /** replaces the policy the agent settings imply */
  policy?: Partial<ThreadPolicy>;
  /** variables the commands Codex runs are to see (canopy's CANOPY_*) */
  env?: Readonly<Record<string, string>>;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The part of a run's environment that is canopy's own (CANOPY_RUN and
 *  the like), which the commands Codex runs are handed too: Codex filters
 *  its commands' environment by the user's `shell_environment_policy`, and
 *  `inherit = "core"` would drop them, though its hooks still see them. */
export function canopyEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([k, v]) => k.startsWith("CANOPY_") && ENV_NAME.test(k) && ![...v].some((c) => c.charCodeAt(0) < 0x20)),
  );
}

/** `thread/start` params. `request_user_input` is off outside plan mode
 *  unless its feature is on, and turning it on prints an "under-development
 *  features" warning unless that is suppressed; both ride in the thread's
 *  config, so the user's config.toml is never touched, and so do the
 *  variables its commands are to see, added to the policy's own `set`
 *  table beside whatever the user sets there. */
export function threadParams(cwd: string, agent: DriveAgent, opts: ThreadOptions): Record<string, unknown> {
  const model = codexModel(agent.model);
  // An override left undefined must not blank the policy out: a thread/start
  // without one falls back to the user's config.toml, which may say
  // danger-full-access.
  const override = Object.fromEntries(Object.entries(opts.policy ?? {}).filter(([, v]) => v !== undefined));
  const config: Record<string, unknown> = {
    ...(opts.askQuestions
      ? { "features.default_mode_request_user_input": true, suppress_unstable_features_warning: true }
      : {}),
    ...Object.fromEntries(Object.entries(canopyEnv(opts.env ?? {})).map(([k, v]) => [`shell_environment_policy.set.${k}`, v])),
  };
  return {
    cwd,
    ...(model ? { model } : {}),
    ...(takesProvider("codex", agent.provider) ? { modelProvider: agent.provider } : {}),
    ...threadPolicy(agent, opts.rules),
    ...override,
    ...(Object.keys(config).length ? { config } : {}),
    ...(opts.askQuestions ? { developerInstructions: DEVELOPER } : {}),
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

/* ---------- shell words and rules: shellwords.ts, browser-safe ---------- */

export { commandWords, parseRule, shellWords, unwrapShell, type ToolRule } from "./shellwords";


/** What canopy knows about an approval when it decides whether a rule
 *  covers it. A command's `cwd` is where it would run, null when the
 *  request does not say (the thread's own folder, the repo). */
export type ApprovalFacts =
  | { kind: "command"; command: string | null; cwd: string | null }
  | { kind: "fileChange"; paths: string[] | null; grantRoot: string | null }
  | { kind: "other" };

/** Whether the rules let a run edit files at all: a bare `Edit`, `Write` or
 *  `MultiEdit`. */
export function allowsEdits(rules: readonly string[]): boolean {
  return rules.some((r) => {
    const p = parseRule(r);
    return p?.kind === "tool" && EDIT_TOOLS.has(p.name);
  });
}

/** `path` is `root` or under it, by the words of both: no `..` left, no
 *  trailing slash. */
export function within(path: string, root: string): boolean {
  const r = resolve(root);
  const p = resolve(r, path);
  return p === r || p.startsWith(r === "/" ? "/" : `${r}/`);
}

/** Whether a job's rules answer this approval without asking. A command is
 *  accepted when it runs in the repo (its folder, when it names one, is
 *  inside `cwd`) and is one simple command whose words start with a
 *  `Bash(x:*)` rule's words, or equal a `Bash(x)` rule's, or any command at
 *  all under a bare `Bash`. A file change is
 *  accepted when the rules allow editing and every path it touches is
 *  inside the repo; one that also asks for write access under another root
 *  never is. Anything else goes to the human, as it would for Claude. */
export function autoAnswer(rules: readonly string[], facts: ApprovalFacts, cwd: string): boolean {
  const parsed = rules.map(parseRule).filter((r): r is ToolRule => r !== null);
  if (facts.kind === "command") {
    if (facts.cwd !== null && !within(facts.cwd, cwd)) return false;
    // a bare `Bash` allows every command, as it does for Claude
    if (parsed.some((r) => r.kind === "tool" && r.name === "Bash")) return true;
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
    return facts.paths.every((p) => resolve(cwd, p) !== resolve(cwd) && within(p, cwd));
  }
  return false;
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
  // the agent's own words for it; the sandbox's retry line is not that
  const why = reason && !ESCALATION.test(reason) ? { description: reason.slice(0, 500) } : {};
  const prompt = approvalPromptOf(method, params, item, root, reason, why);
  if (prompt.kind !== "permission") return prompt;
  // a remembered rule must never let a command out of the sandbox, and an
  // older approval's facts are not what canopy matches a rule on. Codex marks
  // no escalation in its own fields (0.159's protocol), so this fails closed:
  // only a request canopy reads as plainly inside the sandbox may be answered
  const noRule =
    method === "item/commandExecution/requestApproval" && ESCALATION.test(reason)
      ? "it asks to run outside codex's sandbox, which is granted one time at a time"
      : method === "execCommandApproval" || method === "applyPatchApproval"
        ? "an older codex approval, which canopy cannot match a rule against"
        : plainInSandbox(method, params)
          ? null
          : NOT_PLAIN;
  return noRule ? { ...prompt, noRule } : prompt;
}

/** why a request canopy cannot read as plainly inside the sandbox keeps no rule */
export const NOT_PLAIN = "codex did not ask it as a plain request inside its sandbox, so no remembered rule answers it";

/** The fields a plain request carries, from Codex 0.159's app-server schema
 *  (`codex app-server generate-ts`): every other field set (a reason, a
 *  network context or amendment, an `approvalId`, a grant, a field a later
 *  Codex adds) means canopy cannot call the request plain. */
const PLAIN_FIELDS: Record<string, ReadonlySet<string>> = {
  "item/commandExecution/requestApproval": new Set([
    "threadId", "turnId", "itemId", "startedAtMs", "environmentId", "command", "cwd", "commandActions", "proposedExecpolicyAmendment", "kind",
  ]),
  "item/fileChange/requestApproval": new Set(["threadId", "turnId", "itemId", "startedAtMs"]),
};

/** Whether an approval is one canopy recognises as a plain request inside
 *  Codex's sandbox: only known fields set, and a command's `kind` a
 *  command. Anything else is not. */
function plainInSandbox(method: string, params: Record<string, unknown>): boolean {
  const known = PLAIN_FIELDS[method];
  if (!known) return false;
  const set = (v: unknown): boolean => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
  if (Object.entries(params).some(([k, v]) => set(v) && !known.has(k))) return false;
  const kind = str(params, "kind");
  return kind === "" || kind === "command";
}

function approvalPromptOf(
  method: string,
  params: Record<string, unknown>,
  item: Record<string, unknown> | null,
  root: string,
  reason: string,
  why: { description?: string },
): PromptInput {
  const tail = (lines: string[]): string => lines.filter(Boolean).join("\n\n").slice(0, DETAIL_CAP);
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval": {
      const net = rec(params["networkApprovalContext"]);
      if (str(net, "host")) {
        const input = { host: str(net, "host"), protocol: str(net, "protocol") };
        return {
          kind: "permission",
          tool: "Network",
          title: describeTool("Network", input),
          detail: tail([toolDetail("Network", input), reason]),
          ...why,
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
          ...why,
        };
      }
      return {
        kind: "permission",
        tool: "Bash",
        title: describeTool("Bash", { command: script }),
        detail: tail([toolDetail("Bash", { command: script }), where, reason]),
        command: script,
        ...(cwd ? { cwd } : {}),
        ...why,
      };
    }
    case "item/fileChange/requestApproval":
    case "applyPatchApproval": {
      const changes = method === "applyPatchApproval" ? legacyChanges(params["fileChanges"]) : fileChanges(item ?? {});
      const input = changesInput(changes);
      const paths = changes.flatMap((c) => (c.movePath ? [c.path, c.movePath] : [c.path]));
      const grant = str(params, "grantRoot");
      return {
        kind: "permission",
        tool: "Edit",
        title: describeTool("Edit", input, root) + (grant ? `, and write access under ${grant}` : ""),
        detail: tail([
          toolDetail("Edit", input, root),
          grant ? `also asks to write anywhere under ${grant} for the rest of the run` : "",
          reason,
        ]),
        ...(paths.length ? { paths } : {}),
        ...why,
      };
    }
    case "item/permissions/requestApproval": {
      const perms = rec(params["permissions"]);
      return {
        kind: "permission",
        tool: "Permissions",
        title: describeTool("Permissions", perms, root),
        detail: tail([toolDetail("Permissions", perms, root), reason]),
        ...why,
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
    return { kind: "command", command: str(params, "command") || null, cwd: str(params, "cwd") || null };
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

/** A command's folder is inside the repo on disk too, not only by its
 *  words: `repo/link` may be a symlink out of it. Both are resolved where
 *  they exist; a folder that does not exist yet is judged by its words,
 *  which `autoAnswer` has already done. */
export async function runsInside(facts: ApprovalFacts, root: string): Promise<boolean> {
  if (facts.kind !== "command" || facts.cwd === null) return true;
  const abs = resolve(root, facts.cwd);
  const [realCwd, realRoot] = await Promise.all([realpath(abs).catch(() => null), realpath(root).catch(() => null)]);
  if (realCwd === null || realRoot === null) return within(abs, root);
  return within(realCwd, realRoot);
}

/** What Codex says when a command its sandbox refused asks to run again
 *  outside it (measured against 0.158: "command failed; retry without
 *  sandbox?"). */
const ESCALATION = /retry without sandbox/i;

/** The note a run gets the first time a command asks to leave the sandbox,
 *  else null. Where the sandbox cannot start at all (bwrap cannot make a
 *  user namespace in canopy's shells container) that is every command, and
 *  each one is a prompt unless the job's rules cover it. */
export function escalationNote(method: string, params: Record<string, unknown>): string | null {
  if (method !== "item/commandExecution/requestApproval" || !ESCALATION.test(str(params, "reason"))) return null;
  return "a command failed in codex's sandbox and asks to run outside it (in a container without user namespaces, that is every command); the job's rules still answer the ones they cover, and the rest ask you";
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
                : { denied: { rejection: (a.kind === "deny" && a.message) || "The user declined this in canopy." } },
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
    const given = a.kind === "answers" ? a.answers[q.question]?.trim() : a.kind === "deny" ? a.message : undefined;
    answers[id] = { answers: [given || DISMISSED] };
  });
  return { answers };
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
  /** what folding the wire has kept so far: the thread, the turn count
   *  and texts, the tokens, the model, the items and their steps
   *  (`codexfold.ts`) */
  private fold: CodexFold = codexFold("");
  /** the running turn, from turn/start's answer or turn/started */
  private turn: string | null = null;
  /** the thread or the first turn is still being set up */
  private starting = false;
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
  /** the run has had its note about commands leaving the sandbox */
  private escalated = false;
  /** the running turn's finished commands and file changes, against the
   *  job's `maxTurns` */
  private toolCalls = 0;
  /** why canopy interrupted the running turn itself, which is its result's
   *  problem */
  private capped: string | null = null;

  constructor(private opts: CodexOptions = {}) {}

  check(): string | null {
    if (this.opts.command?.length) return null;
    return codexBinary() ? null : "the codex CLI is not on PATH; install Codex and sign in first";
  }

  start(ctx: DriveCtx, message: string): void {
    this.ctx = ctx;
    this.fold = codexFold(ctx.cwd);
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
      const thread = this.fold.thread;
      if (this.turn !== null && thread !== null) {
        rpc.request("turn/interrupt", { threadId: thread, turnId: this.turn }).catch(() => {});
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
    // the stage runner starts programs by bare name, out of its own PATH
    const command = ctx.spawn ? ["codex"] : this.opts.command?.length ? [...this.opts.command] : [codexBinary() ?? "codex"];
    // A seed codex trusts would have its own .codex/ config read
    // (codextrust.ts). Through the stage runner, codex reads the stages
    // container's CODEX_HOME, which the runner sweeps itself.
    if (ctx.stage && !ctx.spawn) {
      const env = spawnEnv(ctx);
      await sweepCodexTrust(env["CODEX_HOME"] ?? join(homedir(), ".codex"), dirname(ctx.cwd)).catch(() => false);
    }
    let rpc: RpcClient;
    try {
      const started = (ctx.spawn ?? this.opts.spawn ?? bunSpawn)([...command, ...appServerArgs(ctx.agent)], {
        cwd: ctx.cwd,
        env: spawnEnv(ctx),
      });
      rpc = new RpcClient(ctx.track ? ctx.track(started) : started, { tap: (dir, line) => ctx.wire(dir, line) });
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
      // a fork (FR-043 plan 3): thread/fork takes thread/start's params and
      // the thread to fork, and answers in the same shape with a new thread
      // whose context is the old one's (probe P4, 2026-11-02)
      const fork = ctx.spec.fork && ctx.spec.resume ? ctx.spec.resume : null;
      const started = rec(
        await rpc.request(
          fork ? "thread/fork" : "thread/start",
          {
            ...(fork ? { threadId: fork } : {}),
            ...threadParams(ctx.cwd, ctx.agent, {
              askQuestions: this.opts.askQuestions ?? true,
              rules: ctx.spec.allowedTools,
              ...(this.opts.policy ? { policy: this.opts.policy } : {}),
              env: ctx.env,
            }),
          },
        ),
      );
      const id = codexThread(this.fold, started);
      if (!id) throw new Error("codex started a thread without an id");
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
    const thread = this.fold.thread;
    if (!rpc || !ctx || thread === null) return;
    codexTurn(this.fold, Date.now());
    this.toolCalls = 0;
    this.capped = null;
    try {
      const r = rec(await rpc.request("turn/start", turnParams(thread, text, ctx.agent)));
      // turn/started may have said so already, and turn/completed may have
      // come in the same chunk as this answer and been handled first
      const id = str(rec(r["turn"]), "id") || null;
      if (id !== this.ended) this.turn ??= id;
      this.starting = false;
      if (this.interrupting && this.turn !== null) {
        rpc.request("turn/interrupt", { threadId: thread, turnId: this.turn }).catch(() => {});
        this.killLater();
      }
    } catch (err) {
      this.starting = false;
      if (first || err instanceof RpcClosed) {
        this.fail(err, "codex refused the message");
        return;
      }
      ctx.result({ text: "", ...NO_COST, durationMs: 0, turns: this.fold.turns }, `codex refused the message: ${errText(err)}`);
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

  private notified(method: string, params: Record<string, unknown>): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // A request is parked whichever thread sent it (a sub-agent's approval
    // is this run's to answer too), so its clearing is heard from any
    // thread: request ids are the connection's, not the thread's.
    if (method === "serverRequest/resolved") {
      const key = String(params["requestId"]);
      if (this.asking.has(key)) {
        this.resolved.add(key);
        ctx.withdraw(key);
      }
      return;
    }
    // notifications for another thread (a sub-agent's) are not this run's
    if (!ownThread(this.fold, params)) return;
    if (method === "turn/started") {
      this.turn = str(rec(params["turn"]), "id") || this.turn;
      return;
    }
    const folded = foldCodex(this.fold, method, params, ctx, Date.now());
    if (folded?.kind === "counted") this.counted();
    else if (folded?.kind === "completed") this.completed(folded);
  }

  /** Codex has no turn limit of its own. A Claude job's `maxTurns` caps the
   *  model calls in one reply (`--max-turns`), and the nearest thing Codex
   *  reports is the work those calls do: so each finished command or file
   *  change counts as one, and a turn that finishes more than `maxTurns` of
   *  them is interrupted, its result failing the way a Claude job's
   *  `error_max_turns` does. A chat counts per message, as Claude does. */
  private counted(): void {
    const ctx = this.ctx;
    const max = ctx?.spec.maxTurns ?? 0;
    this.toolCalls += 1;
    if (!ctx || max <= 0 || this.toolCalls <= max || this.capped !== null || this.interrupting) return;
    this.capped = `stopped after ${this.toolCalls} commands and file changes without finishing (the limit is ${max})`;
    ctx.note(`reached the limit of ${max} commands and file changes for one turn; interrupting codex`);
    const thread = this.fold.thread;
    if (this.rpc && thread !== null && this.turn !== null) {
      this.rpc.request("turn/interrupt", { threadId: thread, turnId: this.turn }).catch(() => {});
    }
  }

  /** A completed turn, folded: its result is the run's unless canopy's own
   *  stop interrupted it. */
  private completed(done: Extract<CodexFolded, { kind: "completed" }>): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.ended = done.turn;
    this.turn = null;
    if (this.interrupting) {
      // the stop's own interrupt: the process goes, and its exit is the stop
      this.close();
      return;
    }
    // canopy's own interrupt at the limit says why, rather than "interrupted"
    ctx.result(done.result, done.problem && this.capped ? this.capped : done.problem);
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
        const item = this.fold.items.get(str(params, "itemId")) ?? null;
        const escalation = this.escalated ? null : escalationNote(req.method, params);
        if (escalation) {
          this.escalated = true;
          ctx.note(escalation);
        }
        const facts = approvalFacts(req.method, params, item);
        if (autoAnswer(ctx.spec.allowedTools, facts, ctx.cwd) && (await runsInside(facts, ctx.cwd))) {
          rpc.reply(req.id, approvalReply(req.method, params, { kind: "allow" }, false));
          return;
        }
        const a = await this.ask(approvalPrompt(req.method, params, item, ctx.cwd), key, facts);
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
  private async ask(prompt: PromptInput, key: string, facts?: ApprovalFacts): Promise<RunAnswer | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    this.asking.add(key);
    try {
      const a = await ctx.ask(prompt, key, facts);
      return this.resolved.has(key) ? null : a;
    } finally {
      this.asking.delete(key);
      this.resolved.delete(key);
    }
  }
}
