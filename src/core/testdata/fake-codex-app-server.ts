/** A stand-in for `codex app-server`, for the CodexDriver tests.
 *
 *  It speaks the subset of the protocol canopy uses, the way codex-cli
 *  0.158.0 was measured to: JSON-RPC lines without the `jsonrpc` field,
 *  server request ids from 0, `thread/start` answered and then
 *  `thread/started`, one scripted sequence of events per `turn/start`, exit
 *  at stdin EOF. What it plays comes from a scenario file named by
 *  `FAKE_CODEX_SCENARIO`; everything the client sends, and the argv it was
 *  started with, is appended to `FAKE_CODEX_LOG` one JSON object per line,
 *  so a test reads what canopy said once the process is gone.
 *
 *  A scenario:
 *
 *    { "userAgent": "canopy/0.158.0 (fake)",       // initialize's answer
 *      "threadStartError": { "code": -32600, "message": "..." },
 *      "ignoreEof": false,                          // stay up after stdin closes
 *      "turns": [ [ step, ... ], ... ] }            // one list per turn/start
 *
 *  Steps, run in order:
 *
 *    { "notify": "<method>", "params": { ... } }
 *    { "request": "<method>", "params": { ... }, "wait": true }
 *        sends a server request and, unless "wait" is false, waits for the
 *        client's answer before the next step
 *    { "waitInterrupt": true }       waits for turn/interrupt
 *    { "complete": "completed" | "interrupted" | "failed", "error": { ... } }
 *        sends turn/completed for the running turn
 *    { "sleep": ms }
 *    { "exit": code, "stderr": "..." }
 *
 *  In params, the strings "$THREAD", "$TURN" and "$REQ" become the thread's
 *  id, the running turn's id and the last server request's id. */

import { appendFileSync } from "node:fs";

type Step = Record<string, unknown>;
interface Scenario {
  userAgent?: string;
  threadStartError?: { code: number; message: string };
  ignoreEof?: boolean;
  turns?: Step[][];
}

const scenarioPath = process.env["FAKE_CODEX_SCENARIO"];
const logPath = process.env["FAKE_CODEX_LOG"];
const scenario: Scenario = scenarioPath ? ((await Bun.file(scenarioPath).json()) as Scenario) : {};

const THREAD = "thr-1";
let turnSeq = 0;
let turn = "";
let reqSeq = 0;
let lastReq = -1;
const answers = new Map<number, (m: unknown) => void>();
let interrupted: (() => void) | null = null;
let interruptSeen = false;

const record = (m: unknown): void => {
  if (logPath) appendFileSync(logPath, JSON.stringify(m) + "\n");
};
const out = (m: unknown): void => {
  process.stdout.write(JSON.stringify(m) + "\n");
};

record({ argv: process.argv.slice(2) });

/** "$THREAD" and friends, anywhere in a params tree */
function fill(v: unknown): unknown {
  if (v === "$THREAD") return THREAD;
  if (v === "$TURN") return turn;
  if (v === "$REQ") return lastReq;
  if (Array.isArray(v)) return v.map(fill);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, fill(x)]));
  }
  return v;
}

const turnShape = (status: string, extra: Record<string, unknown> = {}) => ({
  id: turn,
  items: [],
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
  ...extra,
});

async function play(steps: Step[]): Promise<void> {
  for (const s of steps) {
    if (typeof s["notify"] === "string") {
      out({ method: s["notify"], params: fill(s["params"] ?? {}), emittedAtMs: Date.now() });
    } else if (typeof s["request"] === "string") {
      const id = reqSeq++;
      lastReq = id;
      const answered = new Promise((res) => answers.set(id, res));
      out({ method: s["request"], id, params: fill(s["params"] ?? {}) });
      if (s["wait"] !== false) await answered;
    } else if (s["waitInterrupt"]) {
      if (!interruptSeen) await new Promise<void>((res) => (interrupted = res));
    } else if (typeof s["complete"] === "string") {
      const status = s["complete"];
      out({
        method: "turn/completed",
        params: {
          threadId: THREAD,
          turn: turnShape(status, {
            itemsView: "summary",
            error: s["error"] ?? null,
            durationMs: typeof s["durationMs"] === "number" ? s["durationMs"] : 7,
            ...(Array.isArray(s["items"]) ? { items: fill(s["items"]) } : {}),
          }),
        },
      });
    } else if (typeof s["sleep"] === "number") {
      await Bun.sleep(s["sleep"]);
    } else if (typeof s["exit"] === "number") {
      if (typeof s["stderr"] === "string") await Bun.write(Bun.stderr, s["stderr"]);
      process.exit(s["exit"]);
    }
  }
}

function handle(m: Record<string, unknown>): void {
  const method = typeof m["method"] === "string" ? m["method"] : null;
  const id = m["id"];
  if (method === null) {
    // the client's answer to one of our requests
    if (typeof id === "number") answers.get(id)?.(m);
    return;
  }
  switch (method) {
    case "initialize":
      out({
        id,
        result: {
          userAgent: scenario.userAgent ?? "canopy/0.158.0 (Fake OS; x86_64) fake (canopy; 0)",
          codexHome: "/nowhere/.codex",
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
      return;
    case "initialized":
      return;
    case "thread/start": {
      if (scenario.threadStartError) {
        out({ id, error: scenario.threadStartError });
        return;
      }
      const thread = { id: THREAD, sessionId: THREAD, preview: "", ephemeral: false, turns: [] };
      out({ id, result: { thread, model: "fake-model", modelProvider: "openai", cwd: "/", approvalPolicy: "on-request" } });
      out({ method: "thread/started", params: { thread }, emittedAtMs: Date.now() });
      return;
    }
    case "turn/start": {
      turnSeq += 1;
      turn = `turn-${turnSeq}`;
      interruptSeen = false;
      out({ id, result: { turn: turnShape("inProgress") } });
      out({ method: "turn/started", params: { threadId: THREAD, turn: turnShape("inProgress") } });
      const steps = scenario.turns?.[turnSeq - 1] ?? [{ complete: "completed" }];
      void play(steps);
      return;
    }
    case "turn/interrupt":
      out({ id, result: {} });
      interruptSeen = true;
      interrupted?.();
      interrupted = null;
      return;
    default:
      out({ id, error: { code: -32601, message: `the stand-in does not know ${method}` } });
  }
}

const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf("\n");
    if (!line) continue;
    const m = JSON.parse(line) as Record<string, unknown>;
    record(m);
    handle(m);
  }
}
record({ eof: true });
if (scenario.ignoreEof) await Bun.sleep(60_000);
process.exit(0);
