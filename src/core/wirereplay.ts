/** A finished run's replay, out of its kept wire (FR-043 plan 2).
 *
 *  `replayWire` folds the lines of `runs/<id>/wire.jsonl` back into the
 *  run's story with the drivers' own reducers (`foldClaude`, `foldCodex`),
 *  so a rebuilt step is the step the run made. What the wire adds to the
 *  record is the prompts: each control request (Claude) or server request
 *  (Codex) is an "asked:" step at the time it came, and the reply canopy
 *  sent down stdin is its answer.
 *
 *  The record's own steps carry exact times and canopy's notes, so they win
 *  while they are whole; the asks are placed among them by how many text
 *  and tool steps the wire had folded before each one. A record a restart
 *  left empty, or one whose oldest steps were trimmed, gives way to the
 *  steps the wire folds into, each timed by the nearest canopy line before
 *  it (`start`, `in`, `tick`). A wire from before ticks were written times
 *  its out lines by the `in` line before them alone.
 *
 *  No I/O: lines in, a replay out. The server reads the file (`readWire` in
 *  runlog.ts) and redacts the replay again on the way out (`redactReplay`).
 *  It runs on the server, since the prompts' words are the drivers'. */

import { describeTool, FIRST_MESSAGE } from "./actions";
import { PLAN_TURNED_DOWN } from "./claudedrive";
import { claudeFold, foldClaude } from "./claudefold";
import { codexFold, codexThread, codexTurn, foldCodex, ownThread } from "./codexfold";
import { approvalPrompt, DISMISSED, questionPrompt } from "./codexrun";
import { settleNote, type FoldOut, type PromptInput } from "./driver";
import { redactLine, type Secret } from "./redact";
import type { Harness, Run, RunAnswer, RunQuestion, RunReplay, RunStep } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? o[k] : "");

function parse(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

/** canopy's own line in the wire: a `canopy` word and a time. A harness's
 *  stream-json or JSON-RPC line has neither. */
const canopyLine = (v: Record<string, unknown>): boolean =>
  typeof v["canopy"] === "string" && typeof v["at"] === "number" && Number.isFinite(v["at"]);

const isWork = (s: RunStep): boolean => s.kind === "text" || s.kind === "tool";

/** A prompt the harness asked, as the wire shows it. */
interface Ask {
  step: RunStep;
  prompt: PromptInput;
  /** text and tool steps folded before it, which places it in the record */
  after: number;
  /** Codex's question ids, in the order of the prompt's questions */
  ids?: string[];
}

export interface ReplayOptions {
  /** where the run worked, for step titles, when the wire does not say
   *  (Claude's init and Codex's thread/start do) */
  cwd: string;
  /** this machine's home folder, which a `~` path names */
  home: string;
}

/** Folds a kept wire into the run's replay. `run` is its record: the
 *  steps it kept, its start, its note and whether it was a chat. */
export function replayWire(lines: readonly string[], run: Run, opts: ReplayOptions): RunReplay {
  const parsed = lines.map(parse).filter((v): v is Record<string, unknown> => v !== null);
  const start = parsed.find((v) => canopyLine(v) && v["canopy"] === "start");
  const harness: Harness = start?.["harness"] === "codex" || start?.["harness"] === "claude" ? start["harness"] : run.harness;
  const cut = parsed.some((v) => canopyLine(v) && v["canopy"] === "cut");
  const fold = new WireFold(run, opts);
  const folded = harness === "codex" ? fold.codex(parsed) : fold.claude(parsed);
  const asks = folded.asks.map((a) => a.step.id);
  if (folded.steps.filter(isWork).length > run.steps.filter(isWork).length) {
    return { source: "wire", steps: folded.steps, asks, cut };
  }
  return { source: "record", steps: placeAsks(run.steps, folded.asks), asks, cut };
}

/** The record's steps with the asks among them: each after the text or
 *  tool step the wire had folded just before it, and after any note that
 *  came earlier than it did. An ask's time is the canopy line before it, so
 *  it is never later than the truth: a step stamped the same millisecond
 *  comes after it. */
function placeAsks(record: readonly RunStep[], asks: readonly Ask[]): RunStep[] {
  const out: RunStep[] = [];
  let work = 0;
  let next = 0;
  const emit = (ask: Ask) => {
    const last = out[out.length - 1];
    out.push({ ...ask.step, at: Math.max(ask.step.at, last?.at ?? ask.step.at) });
  };
  for (const r of record) {
    for (let ask = asks[next]; ask && ask.after <= work && (isWork(r) || r.at >= ask.step.at); ask = asks[next]) {
      emit(ask);
      next += 1;
    }
    out.push(r);
    if (isWork(r)) work += 1;
  }
  for (const ask of asks.slice(next)) emit(ask);
  return out;
}

/** The words an ask's step reads: what the harness asked for. */
function askWords(prompt: PromptInput): string {
  if (prompt.kind === "permission") return prompt.title;
  if (prompt.kind === "proposal") return "the plan";
  return prompt.questions[0]?.question || "a question";
}

/** AskUserQuestion's questions, as far as an ask's words need them. */
function questionsOf(input: Record<string, unknown>): RunQuestion[] {
  const raw = Array.isArray(input["questions"]) ? input["questions"] : [];
  return raw.filter(isRecord).map((q) => ({ question: str(q, "question"), header: str(q, "header"), options: [], multiSelect: q["multiSelect"] === true }));
}

/** Codex's reply to a server request as the answer canopy gave
 *  (`approvalReply` and `questionReply`, read backwards). */
function codexAnswer(ask: Ask, result: Record<string, unknown>): RunAnswer {
  if (ask.prompt.kind === "question") {
    const given = rec(result["answers"]);
    const answers: Record<string, string> = {};
    ask.prompt.questions.forEach((q, i) => {
      const id = ask.ids?.[i];
      const raw = id === undefined ? undefined : rec(given[id])["answers"];
      const text = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").join(", ") : "";
      if (text && text !== DISMISSED) answers[q.question] = text;
    });
    return Object.keys(answers).length > 0 ? { kind: "answers", answers } : { kind: "deny" };
  }
  const decision = result["decision"];
  if (decision === "acceptForSession" || decision === "approved_for_session") return { kind: "allow-all" };
  if (decision === "accept" || decision === "approved") return { kind: "allow" };
  if (decision !== undefined) return { kind: "deny" };
  if (isRecord(result["permissions"]) && Object.keys(result["permissions"]).length > 0) {
    return str(result, "scope") === "session" ? { kind: "allow-all" } : { kind: "allow" };
  }
  return { kind: "deny" };
}

/** One walk over a wire: canopy's lines keep the clock, and every step the
 *  fold makes is stamped with it. */
class WireFold {
  readonly steps: RunStep[] = [];
  readonly asks: Ask[] = [];
  /** asks waiting for their answer, by the harness's request id */
  private pending = new Map<string, Ask>();
  private now: number;
  private seq = 0;
  private users = 0;
  readonly out: FoldOut;

  constructor(private run: Run, private opts: ReplayOptions) {
    this.now = run.startedAt;
    this.out = {
      step: (step) => this.add(step),
      changed: () => {},
      note: (text) => {
        this.add({ kind: "note", text });
      },
      todos: () => {},
      result: () => {},
    };
  }

  private add(step: Omit<RunStep, "id" | "at">): RunStep {
    const full: RunStep = { id: `w${++this.seq}`, at: this.now, ...step };
    this.steps.push(full);
    return full;
  }

  private walk(parsed: readonly Record<string, unknown>[], onIn: (m: Record<string, unknown>) => void, onOut: (m: Record<string, unknown>) => void): void {
    for (const v of parsed) {
      if (!canopyLine(v)) {
        onOut(v);
        continue;
      }
      this.now = Math.max(this.now, Number(v["at"]));
      const line = v["line"];
      if (v["canopy"] === "in" && typeof line === "string") {
        const m = parse(line);
        if (m) onIn(m);
      }
    }
  }

  private ask(key: string, prompt: PromptInput, ids?: string[]): void {
    const ask: Ask = {
      step: { id: `ask${this.asks.length + 1}`, at: this.now, kind: "note", text: `asked: ${askWords(prompt)}` },
      prompt,
      after: this.steps.filter(isWork).length,
      ...(ids ? { ids } : {}),
    };
    this.asks.push(ask);
    this.steps.push(ask.step);
    this.pending.set(key, ask);
  }

  /** the answer to an ask, in the words the run's note had */
  private settle(key: string, answer: (ask: Ask) => RunAnswer): void {
    const ask = this.pending.get(key);
    if (!ask) return;
    this.pending.delete(key);
    this.add({ kind: "note", text: settleNote(ask.prompt, answer(ask)) });
  }

  /** A message the user sent. The first is the repo's framing around the
   *  note, which the sheet shows on its own. A chat's first message comes
   *  last in its framing, after `FIRST_MESSAGE`, and is its first step; the
   *  marker tells a chat whose record a restart left without saying so. */
  private said(text: string): void {
    this.users += 1;
    if (this.users === 1) {
      const at = text.lastIndexOf(`${FIRST_MESSAGE}\n`);
      const first = at !== -1 ? text.slice(at + FIRST_MESSAGE.length + 1) : this.run.chat ? this.run.note : "";
      if (first.trim()) this.add({ kind: "user", text: first.trim() });
      return;
    }
    if (text.trim()) this.add({ kind: "user", text: text.trim() });
  }

  claude(parsed: readonly Record<string, unknown>[]): { steps: RunStep[]; asks: Ask[] } {
    const state = claudeFold(this.opts.cwd, this.opts.home);
    this.walk(
      parsed,
      (m) => {
        const type = str(m, "type");
        if (type === "user") {
          const content = rec(m["message"])["content"];
          this.said(typeof content === "string" ? content : "");
          return;
        }
        // canopy's answer to a prompt; its own requests go as control_requests
        if (type !== "control_response") return;
        const r = rec(m["response"]);
        this.settle(str(r, "request_id"), (ask) => {
          const reply = rec(r["response"]);
          const allow = str(r, "subtype") === "success" && str(reply, "behavior") === "allow";
          if (ask.prompt.kind === "question") {
            const answers = Object.entries(rec(rec(reply["updatedInput"])["answers"])).map(([q, v]) => [q, String(v)]);
            return allow ? { kind: "answers", answers: Object.fromEntries(answers) } : { kind: "deny" };
          }
          if (allow) return { kind: "allow" };
          const message = str(reply, "message");
          return ask.prompt.kind === "proposal" && message && message !== PLAN_TURNED_DOWN ? { kind: "deny", message } : { kind: "deny" };
        });
      },
      (m) => {
        const type = str(m, "type");
        if (type === "control_request") {
          const request = rec(m["request"]);
          if (str(request, "subtype") !== "can_use_tool") return;
          const tool = str(request, "tool_name");
          const input = rec(request["input"]);
          this.ask(
            str(m, "request_id"),
            tool === "ExitPlanMode"
              ? { kind: "proposal", plan: str(input, "plan"), auto: false }
              : tool === "AskUserQuestion"
                ? { kind: "question", questions: questionsOf(input) }
                : { kind: "permission", tool, title: describeTool(tool, input, state.cwd), detail: "" },
          );
          return;
        }
        // the CLI took a prompt back, which the run settles as a deny
        if (type === "control_cancel_request") return this.settle(str(m, "request_id"), () => ({ kind: "deny" }));
        // the CLI's reply to canopy's own request
        if (type === "control_response") return;
        if (type === "system" && str(m, "subtype") === "init" && str(m, "cwd")) state.cwd = str(m, "cwd");
        foldClaude(state, m, this.out, { now: this.now });
      },
    );
    return { steps: this.steps, asks: this.asks };
  }

  codex(parsed: readonly Record<string, unknown>[]): { steps: RunStep[]; asks: Ask[] } {
    const state = codexFold(this.opts.cwd);
    /** canopy's own requests by id, so their answers can be told apart */
    const sent = new Map<string, string>();
    this.walk(
      parsed,
      (m) => {
        const method = str(m, "method");
        const id = m["id"];
        if (!method) {
          // canopy's reply to a server request: the answer to an ask
          if (id !== undefined && isRecord(m["result"])) {
            const result = m["result"];
            this.settle(String(id), (ask) => codexAnswer(ask, result));
          }
          return;
        }
        if (id !== undefined) sent.set(String(id), method);
        const params = rec(m["params"]);
        if (method === "thread/start" && str(params, "cwd")) state.cwd = str(params, "cwd");
        if (method === "turn/start") {
          codexTurn(state, this.now);
          const input = Array.isArray(params["input"]) ? params["input"] : [];
          this.said(input.filter(isRecord).map((p) => str(p, "text")).join("\n"));
        }
      },
      (m) => {
        const method = str(m, "method");
        const id = m["id"];
        const params = rec(m["params"]);
        if (!method) {
          // the answer to canopy's own request
          if (id !== undefined && sent.get(String(id)) === "thread/start") codexThread(state, rec(m["result"]));
          return;
        }
        if (id !== undefined) {
          // a server request: an approval or a question parks the run
          const key = String(id);
          if (method === "item/tool/requestUserInput") {
            const { prompt, ids } = questionPrompt(params);
            if (prompt.questions.length > 0) this.ask(key, prompt, ids);
          } else if (method.endsWith("/requestApproval") || method === "execCommandApproval" || method === "applyPatchApproval") {
            this.ask(key, approvalPrompt(method, params, state.items.get(str(params, "itemId")) ?? null, state.cwd));
          }
          return;
        }
        // the server cleared a request canopy had not answered: a deny
        if (method === "serverRequest/resolved") return this.settle(String(params["requestId"]), () => ({ kind: "deny" }));
        if (!ownThread(state, params) || method === "turn/started") return;
        foldCodex(state, method, params, this.out, this.now);
      },
    );
    return { steps: this.steps, asks: this.asks };
  }
}

/** The replay redacted again with this machine's current secrets, as the
 *  export is: a value can reach the wire spelled another way. */
export function redactReplay(replay: RunReplay, secrets: readonly Secret[]): RunReplay {
  const r = (s: string): string => redactLine(s, secrets).line;
  return {
    ...replay,
    steps: replay.steps.map((step) => ({
      ...step,
      ...(step.text !== undefined ? { text: r(step.text) } : {}),
      ...(step.tool
        ? {
            tool: {
              ...step.tool,
              title: r(step.tool.title),
              ...(step.tool.output !== undefined ? { output: r(step.tool.output) } : {}),
              ...(step.tool.paths ? { paths: step.tool.paths.map(r) } : {}),
            },
          }
        : {}),
    })),
  };
}
