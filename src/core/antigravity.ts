/** Antigravity's ACP v1 driver.
 *
 * `agy acp` is a JSON-RPC 2.0 server on stdio.  ACP keeps the conversation
 * lifecycle in `session/*`, streams the story as `session/update`, and asks
 * the client for tool permission with `session/request_permission`.  This
 * driver owns that process and bridge; `acpfold.ts` owns the replayable wire
 * fold.
 */

import { acpFold, acpInputText, acpPermissionPrompt, acpResult, acpSession, acpTurn, foldAcp, ownSession, type AcpFold } from "./acpfold";
import { promptFacts, spawnEnv, type DriveAgent, type DriveCtx, type DriveSpec, type PromptInput, type RunDriver } from "./driver";
import { bunSpawn, RpcClient, RpcClosed, RpcError, type RpcExit, type RpcId, type RpcRequest, type RpcSpawn } from "./codexrpc";
import type { McpLaunch } from "./runtools";
import type { RunAnswer } from "./types";

const GRACE_MS = 5_000;
const DETAIL_CAP = 4_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? o[k] : "");

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** String keys are only for matching a parked RunCtx prompt. Prefixing the
 * type keeps JSON-RPC ids `1` and `"1"` distinct; replies use the original
 * RpcId stored in `pending`. */
const rpcKey = (id: RpcId): string => `${typeof id}:${String(id)}`;

/** The CLI flags ACP itself accepts. Models and thinking levels are session
 *  options, not command-line flags. In ask mode agy sends every permission
 *  its rules do not cover as `session/request_permission`, the same as an
 *  interactive shell without flags. The extra box is for shells: `start`
 *  refuses a run that has one rather than drop the flags silently. */
export function antigravityArgs(spec: Pick<DriveSpec, "addDirs">, agent: Pick<DriveAgent, "yolo">): string[] {
  return [
    "acp",
    ...(agent.yolo ? ["--dangerously-skip-permissions"] : []),
    ...(spec.addDirs ?? []).flatMap((dir) => ["--add-dir", dir]),
  ];
}

export interface AntigravityOptions {
  /** argv prefix before `acp`; tests use a fake ACP process. */
  command?: readonly string[];
  spawn?: RpcSpawn;
  client?: { name: string; title: string; version: string };
  graceMs?: number;
}

type ConfigRole = "model" | "effort";

function optionRole(option: Record<string, unknown>): ConfigRole | null {
  const category = str(option, "category").toLowerCase();
  const text = `${str(option, "id")} ${str(option, "name")} ${category}`.toLowerCase();
  if (category === "model" || /\bmodel\b/.test(text)) return "model";
  if (category === "reasoning" || category === "thinking" || category === "thought_level" || category === "effort" || /thinking|thought|reasoning|effort/.test(text)) return "effort";
  return null;
}

function configOptions(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function selectValues(option: Record<string, unknown>): Record<string, unknown>[] {
  const values = option["options"];
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (!isRecord(value)) return [];
    if (Array.isArray(value["options"])) return configOptions(value["options"]);
    return [value];
  });
}

function normalizedEffort(effort: string): string[] {
  const wanted = effort.toLowerCase();
  return wanted === "xhigh" ? ["extra", "xhigh"] : [wanted];
}

function optionValue(option: Record<string, unknown>, role: ConfigRole, requested: string): string | null {
  const values = selectValues(option);
  const wanted = role === "effort" ? normalizedEffort(requested) : [requested.toLowerCase()];
  const found = values.find((value) => {
    const id = str(value, "value").toLowerCase();
    const name = str(value, "name").toLowerCase();
    // Model ids are opaque and case-sensitive on the wire. A display name is
    // allowed as a convenience, but never silently changes an id's spelling.
    return role === "model" && str(value, "value") === requested ? true : wanted.includes(id) || wanted.includes(name);
  });
  return found ? str(found, "value") || null : null;
}

function currentString(option: Record<string, unknown>): string {
  return typeof option["currentValue"] === "string" ? option["currentValue"] : "";
}

function mcpServers(mcp: McpLaunch | undefined): Record<string, unknown>[] {
  if (!mcp) return [];
  return [{ name: "canopy", command: mcp.command, args: [...mcp.args], env: [] }];
}

/** Model ids exposed by the legacy ACP set_model extension. The stable
 * configOptions model selector is preferred; this is only a fallback for
 * agents that advertise a model list without that selector. */
function modelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (!isRecord(entry)) return [];
    const id = str(entry, "modelId") || str(entry, "model_id") || str(entry, "id");
    return id ? [id] : [];
  });
}

function advertisedModels(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const out = new Set<string>();
  for (const key of ["availableModels", "models", "modelOptions"]) {
    for (const id of modelIds(value[key])) out.add(id);
    const nested = rec(value[key]);
    for (const list of [nested["availableModels"], nested["models"], nested["options"]]) {
      for (const id of modelIds(list)) out.add(id);
    }
  }
  return [...out];
}

function unsupported(ctx: DriveCtx): string | null {
  if (ctx.spec.fork) return "Antigravity ACP does not support session forks";
  if (ctx.spec.pluginDirs?.length) return "Antigravity ACP does not support plugin directories";
  if (ctx.spec.settings) return "Antigravity ACP does not support a settings file";
  // The runner materializes canopy's mcp.json and its ACP stdio launch
  // together. The file is bookkeeping in that case; reject only an mcp.json
  // that has no corresponding session server to send.
  if (ctx.spec.mcpConfig && !ctx.spec.mcpServer) return "Antigravity ACP takes MCP servers through session setup, not an mcp.json file";
  if (ctx.spec.servers?.length) return "Antigravity ACP cannot attach loadout MCP servers here";
  if (ctx.spec.permissionMode) return "Antigravity ACP does not support canopy's plan permission mode";
  if (ctx.agent.provider) return "Antigravity ACP does not support a configured provider";
  if (ctx.agent.extra.trim()) return "Antigravity ACP does not support extra flags";
  if (ctx.spec.canopy && !ctx.spec.mcpServer) return "Antigravity ACP could not find canopy's MCP server";
  return null;
}

function permissionOptions(params: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(params["options"]) ? params["options"].filter(isRecord) : [];
}

function choosePermission(params: Record<string, unknown>, answer: RunAnswer, cancelled: boolean): unknown {
  if (cancelled) return { outcome: { outcome: "cancelled" } };
  const options = permissionOptions(params);
  const allow = answer.kind === "allow" || answer.kind === "allow-all";
  // RunCtx owns the scope of "allow all" and remembered rules. ACP's
  // allow_always would bypass that scope, so every canopy approval is a
  // one-time ACP decision, including an allow-all answer.
  const desired = allow ? ["allow_once"] : ["reject_once", "reject_always"];
  const selected = options.find((option) => desired.includes(str(option, "kind")) && str(option, "optionId"));
  if (selected) return { outcome: { outcome: "selected", optionId: str(selected, "optionId") } };
  // ACP says clients must not treat an unknown option as approval. A
  // cancellation is the safe fallback when the server offered no reject.
  return { outcome: { outcome: "cancelled" } };
}

function permissionDetail(params: Record<string, unknown>, command?: string): string {
  const call = rec(params["toolCall"]);
  const input = acpInputText(call["rawInput"], command);
  const content = Array.isArray(call["content"])
    ? call["content"].flatMap((block) => (isRecord(block) && typeof block["text"] === "string" ? [block["text"]] : [])).join("\n")
    : "";
  return [input, content].filter(Boolean).join("\n\n").slice(0, DETAIL_CAP);
}

export class AntigravityDriver implements RunDriver {
  readonly harness = "antigravity" as const;
  readonly label = "Antigravity";
  private ctx: DriveCtx | null = null;
  private rpc: RpcClient | null = null;
  private fold: AcpFold = acpFold("");
  private session: string | null = null;
  private config: Record<string, unknown>[] = [];
  private models = new Set<string>();
  private turning = false;
  private starting = false;
  private stopping = false;
  private cut = false;
  private closed = false;
  private failure: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private graceKilled = false;
  /** pending permission prompts keyed by the string used by RunCtx, while
   * retaining the JSON-RPC id type for the eventual reply. */
  private pending = new Map<string, RpcId>();
  private replied = new Set<string>();
  private completedTools = new Set<string>();
  private toolCalls = 0;
  private capped: string | null = null;
  /** this turn's denials that came with a reason. ACP's permission reply
   *  carries allow or reject and no words, so agy hears the reasons as the
   *  next message once the turn ends, as Claude Code and Codex hear them
   *  inside the turn. */
  private reasons: { what: string; why: string }[] = [];
  /** reason messages sent since the last message from outside: an
   *  unattended run's fixed reason goes once, never after every deny */
  private followUps = 0;

  constructor(private opts: AntigravityOptions = {}) {}

  check(): string | null {
    if (this.opts.command?.length) return null;
    return Bun.which("agy") ? null : "the Antigravity CLI is not on PATH; install it and sign in first";
  }

  start(ctx: DriveCtx, message: string): void {
    this.ctx = ctx;
    this.fold = acpFold(ctx.cwd);
    const problem = unsupported(ctx);
    if (problem) {
      ctx.exited({ code: null, stderr: "", error: problem });
      return;
    }
    void this.open(message);
  }

  say(text: string): void {
    if (!this.ctx || this.closed || this.session === null || this.turning) return;
    this.followUps = 0;
    void this.send(text, false);
  }

  /** ACP's v1 steering is agent-specific; canopy does not send a second
   *  prompt while one is active because that could start an independent turn. */

  interrupt(): boolean {
    if (!this.ctx || !this.rpc || this.rpc.closed || !this.turning || this.session === null || this.stopping) return false;
    this.cut = true;
    this.cancel();
    return true;
  }

  stop(): void {
    if (this.closed) return;
    if (!this.rpc) {
      this.stopping = true;
      return;
    }
    if (this.turning || this.starting) {
      this.stopping = true;
      if (this.turning) this.cancel();
      else this.close();
      return;
    }
    this.close();
  }

  async model(model: string): Promise<string | null> {
    if (model === "default") return "Antigravity cannot switch back to an unnamed default model; choose an advertised model";
    if (!this.rpc || this.rpc.closed || this.session === null) return "its Antigravity session is not open";
    try {
      await this.setConfig("model", model, true);
      return null;
    } catch (err) {
      return errText(err);
    }
  }

  private async open(message: string): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const command = ctx.spawn ? ["agy"] : this.opts.command?.length ? [...this.opts.command] : ["agy"];
    let rpc: RpcClient;
    try {
      const started = (ctx.spawn ?? this.opts.spawn ?? bunSpawn)([...command, ...antigravityArgs(ctx.spec, ctx.agent)], {
        cwd: ctx.cwd,
        env: spawnEnv(ctx),
      });
      rpc = new RpcClient(ctx.track ? ctx.track(started) : started, { jsonrpc: true, tap: (dir, line) => ctx.wire(dir, line) });
    } catch (err) {
      ctx.exited({ code: null, stderr: "", error: `could not start Antigravity: ${errText(err)}` });
      return;
    }
    this.rpc = rpc;
    rpc.onNotification((method, params) => this.notified(method, rec(params)));
    rpc.onRequest((request) => void this.requested(request));
    void rpc.done.then((exit) => this.gone(exit));
    if (this.stopping) {
      this.close();
      return;
    }
    this.starting = true;
    try {
      const client = this.opts.client ?? { name: "canopy", title: "canopy", version: "0" };
      const initValue: unknown = await rpc.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { auth: { terminal: false }, fs: { readTextFile: false, writeTextFile: false }, terminal: false, plan: {} },
        clientInfo: client,
      });
      if (!isRecord(initValue)) throw new Error("Antigravity returned an invalid initialize response");
      const protocol = initValue["protocolVersion"];
      if (protocol !== 1) throw new Error(`Antigravity negotiated unsupported ACP protocol version ${String(protocol ?? "missing")}`);
      const rawCapabilities = initValue["agentCapabilities"];
      if (rawCapabilities !== undefined && !isRecord(rawCapabilities)) throw new Error("Antigravity returned invalid agent capabilities");
      const capabilities = rec(rawCapabilities);
      const load = capabilities["loadSession"] === true;
      if (ctx.spec.resume && !load) throw new Error("Antigravity ACP does not advertise session/load");
      const sessionMethod = ctx.spec.resume ? "session/load" : "session/new";
      const sessionParams: Record<string, unknown> = {
        cwd: ctx.cwd,
        mcpServers: mcpServers(ctx.spec.mcpServer),
        ...(ctx.spec.resume ? { sessionId: ctx.spec.resume } : {}),
        ...(this.hasAdditionalDirectories(capabilities) && ctx.spec.addDirs?.length ? { additionalDirectories: [...ctx.spec.addDirs] } : {}),
      };
      const startedValue: unknown = await rpc.request(sessionMethod, sessionParams);
      if (!isRecord(startedValue)) throw new Error(`Antigravity returned an invalid ${sessionMethod} response`);
      const started = startedValue;
      this.captureModels(started);
      const id = acpSession(this.fold, started, ctx.spec.resume ?? "");
      if (!id) throw new Error("Antigravity started a session without an id");
      this.session = id;
      ctx.session(id);
      this.config = configOptions(started["configOptions"]);
      this.captureCurrentModel();
      await this.configureAgent(ctx.agent);
      this.starting = false;
      if (this.stopping) {
        rpc.kill();
        return;
      }
      await this.send(message, true);
    } catch (err) {
      this.starting = false;
      if (err instanceof RpcError && err.code === -32000) this.failure = "Antigravity authentication required; run `agy acp --login` first";
      else if (err instanceof RpcClosed) return;
      else this.failure = `could not start the Antigravity session: ${errText(err)}`;
      rpc.kill();
    }
  }

  private hasAdditionalDirectories(capabilities: Record<string, unknown>): boolean {
    const sessions = rec(capabilities["sessionCapabilities"]);
    return isRecord(sessions["additionalDirectories"]);
  }

  private captureCurrentModel(): void {
    const model = this.config.find((option) => optionRole(option) === "model");
    const current = model ? currentString(model) : "";
    if (current) this.fold.model = current;
    if (model) for (const value of selectValues(model)) {
      const id = str(value, "value");
      if (id) this.models.add(id);
    }
  }

  private captureModels(value: Record<string, unknown>): void {
    for (const id of advertisedModels(value)) this.models.add(id);
    for (const option of configOptions(value["configOptions"])) {
      if (optionRole(option) !== "model") continue;
      for (const model of selectValues(option)) {
        const id = str(model, "value");
        if (id) this.models.add(id);
      }
    }
  }

  private async configureAgent(agent: DriveAgent): Promise<void> {
    if (agent.model !== "default") await this.setConfig("model", agent.model, true);
    if (agent.effort !== "default") await this.setConfig("effort", agent.effort, true);
  }

  private async setConfig(role: ConfigRole, requested: string, required: boolean): Promise<void> {
    const rpc = this.rpc;
    const session = this.session;
    if (!rpc || rpc.closed || session === null) throw new Error("its Antigravity session is not open");
    const option = this.config.find((candidate) => optionRole(candidate) === role);
    // `agy models` prints ids with the thinking level in them
    // (gemini-4-neon-high) while the model option lists bare names; agy takes
    // such an id as the option's value and sets both.
    const value = option ? optionValue(option, role, requested) ?? (role === "model" && this.models.has(requested) ? requested : null) : null;
    if (option && !value) {
      const advertised = selectValues(option).map((candidate) => str(candidate, "value") || str(candidate, "name")).filter(Boolean).join(", ");
      throw new Error(`Antigravity does not offer ${role} ${JSON.stringify(requested)} (advertised: ${advertised || "none"})`);
    }
    if (option && value) {
      if (currentString(option) === value) {
        if (role === "model") this.fold.model = value;
        return;
      }
      const response = rec(await rpc.request("session/set_config_option", { sessionId: session, configId: str(option, "id"), value }));
      const next = configOptions(response["configOptions"]);
      if (next.length) {
        this.config = next;
        this.captureModels(response);
        this.captureCurrentModel();
      }
      if (role === "model") this.fold.model = value;
      return;
    }
    if (role === "model") {
      // `session/set_model` is an unstable ACP extension. It is safe only
      // when the server advertised this exact opaque model id; otherwise a
      // successful-looking request can make the next turn end silently.
      if (!this.models.has(requested)) {
        throw new Error(`Antigravity did not advertise model ${JSON.stringify(requested)}; refusing session/set_model`);
      }
      await rpc.request("session/set_model", { sessionId: session, modelId: requested });
      this.fold.model = requested;
      return;
    }
    if (required) throw new Error(`Antigravity did not advertise a thinking-level option for ${JSON.stringify(requested)}`);
  }

  private async send(text: string, first: boolean, followUp = false): Promise<void> {
    const rpc = this.rpc;
    const ctx = this.ctx;
    const session = this.session;
    if (!rpc || !ctx || rpc.closed || session === null || this.closed) return;
    // a reason's turn carries on the message's: its time counts from there
    const at = this.fold.turnAt;
    acpTurn(this.fold, Date.now());
    if (followUp) this.fold.turnAt = at;
    this.reasons = [];
    this.completedTools.clear();
    this.toolCalls = 0;
    this.capped = null;
    this.turning = true;
    try {
      const responseValue: unknown = await rpc.request("session/prompt", { sessionId: session, prompt: [{ type: "text", text }] });
      if (!isRecord(responseValue)) throw new Error("Antigravity returned an invalid session/prompt response");
      const response = responseValue;
      this.turning = false;
      this.clearKillTimer();
      if (this.stopping) {
        this.close();
        return;
      }
      const problem = this.capped ?? (this.cut ? (ctx.chat ? null : "interrupted") : null);
      const done = acpResult(this.fold, response, problem, Date.now());
      this.cut = false;
      const reasons = done.problem ? null : this.followUp();
      if (reasons) {
        // the turn's tokens are counted above; its result is not the run's
        ctx.note(`told Antigravity why: ${reasons.why}`);
        return await this.send(reasons.text, false, true);
      }
      ctx.result(done.result, done.problem);
      if (!ctx.chat) this.close();
    } catch (err) {
      // a process gone mid-turn is `gone`'s to settle: it still knows the
      // turn was running, and so whether a cancel or the cap ended it
      if (err instanceof RpcClosed) return;
      this.turning = false;
      this.clearKillTimer();
      if (this.stopping) {
        this.close();
        return;
      }
      if (this.capped) {
        ctx.result({ text: this.fold.finalText, durationMs: 0, turns: this.fold.turns }, this.capped);
        this.close();
        return;
      }
      if (this.cut) {
        this.cut = false;
        ctx.result({ text: this.fold.finalText, durationMs: 0, turns: this.fold.turns }, ctx.chat ? null : "interrupted");
        if (!ctx.chat) this.close();
        return;
      }
      const problem = `Antigravity refused the message: ${errText(err)}`;
      if (first || !ctx.chat) {
        this.failure = problem;
        rpc.kill();
      } else {
        ctx.result({ text: "", durationMs: 0, turns: this.fold.turns }, problem);
      }
    }
  }

  /** The message that tells agy why this turn's denials were made, or null
   *  when none came with a reason or an unattended run already said it. */
  private followUp(): { text: string; why: string } | null {
    const reasons = this.reasons;
    this.reasons = [];
    if (!reasons.length || (this.ctx?.spec.unattended && this.followUps > 0)) return null;
    this.followUps += 1;
    return { text: reasons.map((r) => `${r.what} was declined: ${r.why}`).join("\n"), why: reasons.map((r) => r.why).join("; ") };
  }

  private cancel(): void {
    const rpc = this.rpc;
    const session = this.session;
    if (!rpc || rpc.closed || session === null) return;
    this.cancelPermissions();
    rpc.notify("session/cancel", { sessionId: session });
    // ACP cancellation is a notification. If an agent ignores it, the
    // pending session/prompt promise would otherwise park the run forever.
    this.killLater();
  }

  private cancelPermissions(): void {
    const rpc = this.rpc;
    const ctx = this.ctx;
    if (!rpc) return;
    for (const [key, id] of this.pending) {
      if (this.replied.has(key)) continue;
      rpc.reply(id, { outcome: { outcome: "cancelled" } });
      this.replied.add(key);
      ctx?.withdraw(key);
    }
  }

  private async requested(request: RpcRequest): Promise<void> {
    const rpc = this.rpc;
    const ctx = this.ctx;
    if (!rpc || !ctx || this.closed) return;
    const params = rec(request.params);
    const key = rpcKey(request.id);
    if (request.method !== "session/request_permission") {
      rpc.replyError(request.id, -32601, `canopy does not handle ${request.method}`);
      return;
    }
    this.pending.set(key, request.id);
    try {
      const prompt = acpPermissionPrompt(params, ctx.cwd);
      const detail = permissionDetail(params, prompt.kind === "permission" && prompt.tool === "Bash" ? prompt.command : undefined);
      const shown: PromptInput = prompt.kind === "permission" && detail ? { ...prompt, detail } : prompt;
      // An unattended run is an explicit deny policy. It must still pass
      // through RunCtx even when the harness is otherwise in yolo mode.
      const answer = ctx.agent.yolo && !ctx.spec.unattended ? { kind: "allow" as const } : await ctx.ask(shown, key, promptFacts(shown));
      if (this.replied.has(key) || rpc.closed) return;
      const cancelled = this.stopping || this.cut;
      rpc.reply(request.id, choosePermission(params, answer, cancelled));
      this.replied.add(key);
      const why = answer.kind === "deny" ? answer.message?.trim() : undefined;
      if (why && !cancelled) this.reasons.push({ what: shown.kind === "permission" ? shown.title : "the request", why });
    } finally {
      this.pending.delete(key);
      this.replied.delete(key);
    }
  }

  private notified(method: string, params: Record<string, unknown>): void {
    const ctx = this.ctx;
    if (!ctx || this.closed || !ownSession(this.fold, params)) return;
    if (method !== "session/update") return;
    const update = rec(params["update"]);
    if (str(update, "sessionUpdate") === "config_option_update") {
      const next = configOptions(update["configOptions"]);
      if (next.length) {
        this.config = next;
        this.captureModels({ configOptions: next });
        this.captureCurrentModel();
      }
    }
    if (str(update, "sessionUpdate") === "tool_call_update") this.countTool(update);
    foldAcp(this.fold, method, params, ctx, Date.now());
  }

  private countTool(update: Record<string, unknown>): void {
    if (str(update, "status") !== "completed" && str(update, "status") !== "failed") return;
    const id = str(update, "toolCallId");
    if (!id || this.completedTools.has(id)) return;
    this.completedTools.add(id);
    this.toolCalls += 1;
    const max = this.ctx?.spec.maxTurns ?? 0;
    if (max <= 0 || this.toolCalls <= max || this.capped !== null || this.stopping) return;
    this.capped = `stopped after ${this.toolCalls} tool calls without finishing (the limit is ${max})`;
    this.ctx?.note(`reached the limit of ${max} tool calls for one turn; interrupting Antigravity`);
    this.cancel();
  }

  private close(): void {
    if (this.closed) return;
    this.rpc?.end();
    this.killLater();
  }

  private killLater(): void {
    if (this.timer || !this.rpc || this.rpc.closed) return;
    const timer = setTimeout(() => {
      this.timer = null;
      this.graceKilled = true;
      this.rpc?.kill();
    }, this.opts.graceMs ?? GRACE_MS);
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  private clearKillTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private gone(exit: RpcExit): void {
    if (this.closed) return;
    this.closed = true;
    this.clearKillTimer();
    const ctx = this.ctx;
    if (!ctx) return;
    // A process that ignores cancellation can be killed by the grace timer
    // before session/prompt answers. Preserve the cancellation/limit outcome
    // rather than leaving a working run with no result.
    if (this.turning && !this.stopping) {
      this.turning = false;
      if (this.capped) ctx.result({ text: this.fold.finalText, durationMs: 0, turns: this.fold.turns }, this.capped);
      else if (this.cut) ctx.result({ text: this.fold.finalText, durationMs: 0, turns: this.fold.turns }, ctx.chat ? null : "interrupted");
    }
    ctx.exited({ code: this.graceKilled ? 0 : exit.code, stderr: exit.stderr, ...(this.failure ? { error: this.failure } : {}) });
  }
}

export { acpFold, acpPermissionPrompt, acpResult, acpSession, acpTurn, foldAcp, ownSession } from "./acpfold";

