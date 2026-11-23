/** A stand-in for `agy acp`, for the AntigravityDriver tests.
 *
 *  It speaks the ACP v1 subset canopy uses, in the shapes agy 1.5.15 was
 *  measured to send on 2026-11-23: JSON-RPC 2.0 lines with the `jsonrpc`
 *  field, string ids on its own requests ("1", "2", ...), a session/new
 *  answer with `configOptions` (model, thought_level, mode) and the legacy
 *  `models` list, and -32000 "Authentication required" when signed out.
 *  What it plays comes from a scenario file named by `FAKE_AGY_SCENARIO`;
 *  the argv and everything the client sends are appended to `FAKE_AGY_LOG`,
 *  one JSON object per line, and stdin's end is logged as {"eof": true}.
 *
 *  A scenario:
 *
 *    { "auth": false,              // session/new answers -32000
 *      "loadSession": true,        // initialize's agentCapabilities.loadSession
 *      "ignoreCancel": false,      // a session/cancel ends no turn
 *      "turns": [ [ step, ... ], ... ] }   // one list per session/prompt
 *
 *  Steps, run in order:
 *
 *    { "update": { "sessionUpdate": ..., ... } }   a session/update
 *    { "permission": { toolCall, options } }       session/request_permission,
 *                                                  waits for the answer
 *    { "waitCancel": true }                        waits for session/cancel
 *    { "stop": "end_turn", "usage": { ... } }      answers session/prompt
 */

import { appendFileSync } from "node:fs";

type Step = Record<string, unknown>;
interface Scenario {
  auth?: boolean;
  loadSession?: boolean;
  ignoreCancel?: boolean;
  turns?: Step[][];
}

const scenarioPath = process.env["FAKE_AGY_SCENARIO"];
const logPath = process.env["FAKE_AGY_LOG"];
const scenario: Scenario = scenarioPath ? ((await Bun.file(scenarioPath).json()) as Scenario) : {};

const SESSION = "agy-1";
const MODELS = ["gemini-4-neon", "gemini-3.1-pro"];
const LEVELS: Record<string, string[]> = { "gemini-4-neon": ["low", "medium", "high", "xhigh"], "gemini-3.1-pro": ["low", "high"] };
let model = "gemini-3.1-pro";
let level = "low";
let turnSeq = 0;
let reqSeq = 0;
let prompt: number | string | null = null;
const answers = new Map<string, (m: unknown) => void>();
let cancelled: (() => void) | null = null;

const record = (m: unknown): void => {
  if (logPath) appendFileSync(logPath, JSON.stringify(m) + "\n");
};
const out = (m: Record<string, unknown>): void => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
};

record({ argv: process.argv.slice(2) });

const configOptions = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: MODELS.map((value) => ({ value, name: value })) },
  { id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: level, options: (LEVELS[model] ?? []).map((value) => ({ value, name: value })) },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
];
const advertised = MODELS.flatMap((m) => (LEVELS[m] ?? []).map((l) => `${m}-${l}`));

function setOption(configId: string, value: string): string | null {
  if (configId === "model") {
    const composite = advertised.includes(value) ? value : null;
    const bare = composite ? MODELS.find((m) => composite.startsWith(`${m}-`)) ?? null : MODELS.includes(value) ? value : null;
    if (!bare) return `unknown model ${value}`;
    model = bare;
    level = composite ? composite.slice(bare.length + 1) : (LEVELS[model] ?? ["low"])[0] ?? "low";
    return null;
  }
  if (configId === "thought_level") {
    if (!(LEVELS[model] ?? []).includes(value)) return `unknown level ${value}`;
    level = value;
    return null;
  }
  return `unknown option ${configId}`;
}

async function play(id: number | string, steps: Step[]): Promise<void> {
  for (const s of steps) {
    if (s["update"]) {
      out({ method: "session/update", params: { sessionId: SESSION, update: s["update"] } });
    } else if (s["permission"]) {
      const rid = String(++reqSeq);
      const answered = new Promise((res) => answers.set(rid, res));
      out({ id: rid, method: "session/request_permission", params: { sessionId: SESSION, ...(s["permission"] as object) } });
      await answered;
    } else if (s["waitCancel"]) {
      await new Promise<void>((res) => (cancelled = res));
      if (scenario.ignoreCancel) await new Promise(() => {});
      out({ id, result: { stopReason: "cancelled" } });
      return;
    } else if (typeof s["stop"] === "string") {
      out({ id, result: { stopReason: s["stop"], ...(s["usage"] ? { usage: s["usage"] } : {}) } });
      return;
    }
  }
  out({ id, result: { stopReason: "end_turn" } });
}

function handle(m: Record<string, unknown>): void {
  const method = typeof m["method"] === "string" ? m["method"] : null;
  const id = m["id"] as number | string | undefined;
  const params = (m["params"] ?? {}) as Record<string, unknown>;
  if (method === null) {
    if (id !== undefined) answers.get(String(id))?.(m);
    return;
  }
  switch (method) {
    case "initialize":
      out({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: scenario.loadSession ?? true, sessionCapabilities: { load: {}, additionalDirectories: {} } },
          agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" },
          authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
        },
      });
      return;
    case "session/new":
    case "session/load":
      if (scenario.auth === false) {
        out({ id, error: { code: -32000, message: "Authentication required" } });
        return;
      }
      out({
        id,
        result: method === "session/load" ? {} : {
          sessionId: SESSION,
          models: { availableModels: advertised.map((modelId) => ({ modelId, name: modelId })), currentModelId: `${model}-${level}` },
          configOptions: configOptions(),
        },
      });
      return;
    case "session/set_config_option": {
      const why = setOption(String(params["configId"]), String(params["value"]));
      if (why) out({ id, error: { code: -32602, message: why } });
      else out({ id, result: { configOptions: configOptions() } });
      return;
    }
    case "session/prompt": {
      turnSeq += 1;
      prompt = id ?? null;
      void play(id ?? 0, scenario.turns?.[turnSeq - 1] ?? [{ stop: "end_turn" }]);
      return;
    }
    case "session/cancel":
      cancelled?.();
      cancelled = null;
      return;
    default:
      if (id !== undefined) out({ id, error: { code: -32601, message: `no ${method}` } });
  }
}

let buf = "";
const dec = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk);
  let n: number;
  while ((n = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line) as Record<string, unknown>;
    record(m);
    handle(m);
  }
}
record({ eof: true, prompt });
process.exit(0);
