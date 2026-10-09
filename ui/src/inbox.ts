/**
 * The inbox (agents spec, phase 4): everything waiting on the human, from
 * three places, in one list oldest first. The broker's open asks (an agent's
 * hook, anywhere on the tailnet, waiting before it falls back to its
 * terminal), canopy's own runs parked on a permission or a question (on any
 * backend the page shows), and flows parked at a gate. Pure, so it is
 * tested; the store feeds it what it holds and routes an answer back to
 * where the item came from.
 */
import type {
  AdviceOffer,
  AgentCard,
  Ask,
  AskAnswer,
  Flow,
  FlowChoice,
  FlowStepName,
  PermissionAsk,
  RememberAsk,
  RememberScope,
  Repo,
  Run,
  RunAnswer,
  RunQuestion,
  Sprout,
} from "../../src/core/types";
import { repoOfCard, repoWord, whereWord } from "./agentcards";
import { agentWord, harnessOf } from "./runs";
import { handOffText } from "../../src/core/sprout";
import { scopeWords } from "../../src/core/shellwords";

export type InboxSource = "ask" | "run" | "flow" | "sprout" | "advice";

export interface InboxItem {
  /** `${source}:${id}`, unique across the five */
  key: string;
  source: InboxSource;
  /** the broker's ask id (the home backend's), or a run's or flow's
   *  qualified id */
  id: string;
  kind: "permission" | "question" | "proposal" | "guard" | "gate" | "clarify" | "park" | "advice" | "hand-off";
  /** the repo it is about, by the page's id, when the page has it */
  repoId: string | null;
  /** the repo in words: the checkout's name, else what the agent's card says */
  repo: string;
  /** who waits: an agent's handle, or the run's or flow's word */
  who: string;
  /** where it runs: from the agent's registry card, or which backend's run */
  where: string;
  /** one line for the list */
  title: string;
  /** the tool's input, or why a gate parked, for the details view */
  detail: string;
  questions?: RunQuestion[];
  /** when it started waiting, unix ms */
  at: number;
  /** ms left before an ask falls back to its terminal, at the time the list
   *  was made; null for no deadline */
  left: number | null;
  /** when that is, unix ms, for a countdown that keeps time on its own */
  until: number | null;
  /** a run's prompt, which its answer names */
  promptId?: string;
  /** a run's permission as it was asked: the agent's own words, the
   *  command, the files, for the plain-language line and a remember */
  permission?: PermissionAsk;
  /** the run's project folder, which "outside the project" is judged by */
  repoPath?: string;
  /** a flow step's run: its workflow and step, the scopes a remember offers */
  flowStep?: FlowStepName;
  /** a gate the flow's budget parked: continuing grants one more step */
  budget?: true;
  /** a step the stage runner's absence parked: continuing runs it again */
  stage?: true;
  /** with `stage`: it was the step's check that found the runner away, so
   *  continuing runs the check alone */
  stageCheck?: true;
  /** the retro lessons on offer, the advice item's alone */
  advice?: AdviceOffer[];
  /** a hand-off's: the commit a yes is for */
  head?: string;
}

export interface InboxContext {
  /** the repos the page has, to name an item's repo */
  repos: readonly Repo[];
  /** the registry's cards by id, to say where an asking agent runs */
  cards: Readonly<Record<string, AgentCard>>;
  /** the backend an id belongs to; "" for home on a one-backend page */
  backendOf?: (id: string) => string;
  /** the repos an ask's agent card is matched against, the home backend's
   *  (whose broker the asks are); `repos` when absent */
  askRepos?: readonly Repo[];
  /** the incubator's sprouts, home's alone; one with open questions is an item */
  sprouts?: readonly Sprout[];
  /** the retro lessons on offer, home's alone; any make one item */
  advice?: readonly AdviceOffer[];
}

/** "asks to use Bash", "has a question", "hit a guard on Bash" */
export function askWord(a: Pick<Ask, "kind" | "tool">): string {
  if (a.kind === "question") return "has a question";
  if (a.kind === "guard") return `hit a guard on ${a.tool ?? "a tool"}`;
  return `asks to use ${a.tool ?? "a tool"}`;
}

/** how a closed ask went, in words: "allowed by phone@canopy", "answered at
 *  the terminal", "expired to the terminal", "session ended" */
export function endingWord(a: Ask): string {
  if (a.state === "answered") {
    const by = a.answeredBy ? ` by ${a.answeredBy}` : "";
    if (a.kind === "question" && a.answer?.behavior !== "deny") return `answered${by}`;
    return `${a.answer?.behavior === "deny" ? "denied" : a.answer?.always ? "allowed always" : "allowed"}${by}`;
  }
  if (a.state === "expired") return a.kind === "guard" ? "expired, so the guard held it" : "expired to the terminal";
  if (a.state === "withdrawn") {
    if (a.why === "terminal") return "answered at the terminal";
    if (a.why === "ended") return "session ended";
    return "withdrawn";
  }
  if (a.state === "local") return "asked at the terminal";
  return "open";
}

/** "0:45 left", "29:12 left"; a guard has no terminal to fall back to */
export function leftWord(left: number | null, kind: InboxItem["kind"]): string {
  if (left === null) return "";
  if (left <= 0) return kind === "guard" ? "about to be held" : "going back to the terminal…";
  const s = Math.ceil(left / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec} left` : `${m}:${sec} left`;
}

/** when a run's prompt came up: the run records no time for it, so its
 *  last step's, which is what asked */
const promptAt = (run: Run): number => run.steps.at(-1)?.at ?? run.startedAt;

/** An agent's permission ask as a run's would be, for the plain words: the
 *  tool, and from its input (the hook's JSON) the command, the agent's own
 *  description and the file it touches. Nothing for a guard or a question,
 *  or an ask with no tool. */
export function askPermission(a: Ask): PermissionAsk | undefined {
  if (a.kind !== "permission" || !a.tool) return undefined;
  const p: PermissionAsk = { kind: "permission", tool: a.tool, title: a.title, detail: a.detail };
  let input: unknown;
  try {
    input = JSON.parse(a.detail);
  } catch {
    return p;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return p;
  const o = input as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const command = text(o.command);
  const description = text(o.description) ?? text(o.reason);
  const path = text(o.file_path) ?? text(o.notebook_path) ?? text(o.path);
  return {
    ...p,
    ...(command ? { command } : {}),
    ...(description ? { description: description.slice(0, 500) } : {}),
    ...(path ? { paths: [path] } : {}),
  };
}

function askItem(a: Ask, now: number, ctx: InboxContext): InboxItem {
  const card = ctx.cards[a.agent];
  const repo = card ? repoOfCard(card, ctx.askRepos ?? ctx.repos) : undefined;
  const permission = askPermission(a);
  return {
    ...(permission ? { permission } : {}),
    key: `ask:${a.id}`,
    source: "ask",
    id: a.id,
    kind: a.kind,
    repoId: repo?.id ?? null,
    repo: repo?.name ?? (card ? repoWord(card) : ""),
    who: a.handle || card?.handle || a.agent,
    where: card ? whereWord(card) : `on ${a.node}`,
    title: a.title,
    detail: a.detail,
    ...(a.questions?.length ? { questions: a.questions } : {}),
    at: a.createdAt,
    left: Math.max(0, a.waitUntil - now),
    until: a.waitUntil,
  };
}

function runItem(run: Run, flow: Flow | undefined, ctx: InboxContext): InboxItem | null {
  const p = run.prompt;
  if (run.status !== "waiting" || !p) return null;
  const repo = ctx.repos.find((r) => r.id === run.repoId);
  const backend = ctx.backendOf?.(run.id) ?? "";
  const step = flow?.steps.find((s) => s.runId === run.id);
  const who = flow ? `${flow.workflow}${step ? ` · ${step.name}` : ""}` : `${agentWord(harnessOf(run))} ${run.chat ? "chat" : run.verb}`;
  return {
    key: `run:${run.id}`,
    source: "run",
    id: run.id,
    kind: p.kind,
    repoId: run.repoId,
    repo: repo?.name ?? run.repoId,
    who,
    where: `canopy ${run.chat ? "chat" : "run"}${backend ? ` on ${backend}` : ""}`,
    title: p.kind === "permission" ? p.title : p.kind === "proposal" ? "plan to approve" : `question: ${p.questions[0]?.question ?? "a question"}`,
    // a plan's opening, to see what it is about; the run sheet holds the rest
    detail: p.kind === "permission" ? p.detail : p.kind === "proposal" ? p.plan.slice(0, 400) : "",
    ...(p.kind === "question" ? { questions: p.questions } : {}),
    ...(p.kind === "permission" ? { permission: p } : {}),
    ...(repo && !repo.host ? { repoPath: repo.path } : {}),
    // only the run's own word: it says where the workflow's file came from
    ...(run.flowStep ? { flowStep: run.flowStep } : {}),
    at: promptAt(run),
    left: null,
    until: null,
    promptId: p.id,
  };
}

function flowItem(flow: Flow, runs: Readonly<Record<string, Run>>, ctx: InboxContext): InboxItem | null {
  if (flow.status !== "gated") return null;
  const step = flow.steps[flow.current];
  const repo = ctx.repos.find((r) => r.id === flow.repoId);
  const backend = ctx.backendOf?.(flow.id) ?? "";
  const run = step?.runId ? runs[step.runId] : undefined;
  return {
    key: `flow:${flow.id}`,
    source: "flow",
    id: flow.id,
    kind: "gate",
    repoId: flow.repoId,
    repo: repo?.name ?? flow.repoId,
    who: flow.workflow,
    where: `canopy workflow${backend ? ` on ${backend}` : ""}`,
    title: `waits at a gate${step ? ` after "${step.name}"` : ""}`,
    detail: step?.reason ?? step?.summary ?? "",
    at: run?.endedAt ?? flow.startedAt,
    left: null,
    until: null,
    ...(flow.parkedFor === "budget" ? { budget: true as const } : {}),
    ...(flow.parkedFor === "stage" ? { stage: true as const } : {}),
    ...(flow.parkedFor === "stage" && flow.stageCheck ? { stageCheck: true as const } : {}),
  };
}

function sproutItem(s: Sprout, flows: Readonly<Record<string, Flow>>, ctx: InboxContext): InboxItem | null {
  const backend = ctx.backendOf?.(s.id) ?? "";
  const base = {
    key: `sprout:${s.id}`,
    source: "sprout" as const,
    id: s.id,
    repoId: ctx.repos.some((r) => r.id === s.repoId) ? s.repoId : null,
    repo: s.title,
    where: `canopy incubator${backend ? ` on ${backend}` : ""}`,
    left: null,
    until: null,
  };
  if (s.status === "approving" && s.handOff) {
    const r = s.handOff;
    return { ...base, kind: "hand-off", who: "hand-off", title: `waits for your yes to push ${r.branch}${r.flagged.length ? `, ${r.flagged.length} ${r.flagged.length === 1 ? "change" : "changes"} to look at first` : ""}`, detail: handOffText(r), head: r.head, at: r.at };
  }
  if (s.status === "parked") {
    // a gate behind the park is in the inbox already, as that flow's
    const cur = s.flows.at(-1);
    if (cur && !cur.outcome && flows[cur.flowId]?.status === "gated") return null;
    return { ...base, kind: "park", who: "incubator", title: "is parked", detail: s.parked ?? "", at: s.updatedAt };
  }
  const n = s.questions?.length ?? 0;
  if (s.status !== "clarifying" || n === 0) return null;
  return {
    ...base,
    kind: "clarify",
    who: "clarify",
    title: `${n} ${n === 1 ? "question" : "questions"} before research`,
    detail: "",
    ...(s.questions ? { questions: s.questions } : {}),
    at: s.questionsAt ?? s.updatedAt,
  };
}

/** The lessons retros left that are on offer, as one item: accepting or
 *  dismissing goes key by key. Empty is none. */
function adviceItem(advice: readonly AdviceOffer[]): InboxItem | null {
  if (advice.length === 0) return null;
  const n = advice.length;
  return {
    key: "advice:incubator",
    source: "advice",
    id: "incubator",
    kind: "advice",
    repoId: null,
    repo: "",
    who: "retro",
    where: "canopy incubator",
    title: `${n} ${n === 1 ? "lesson" : "lessons"} from retros`,
    detail: "",
    at: Math.min(...advice.map((o) => o.lastAt)),
    left: null,
    until: null,
    advice: [...advice],
  };
}

/** Everything waiting on the human, oldest first: open asks, waiting runs
 *  (a flow's step run named by its flow), gated flows. */
export function mergeInbox(
  asks: readonly Ask[],
  runs: Readonly<Record<string, Run>>,
  flows: Readonly<Record<string, Flow>>,
  now: number,
  ctx: InboxContext,
): InboxItem[] {
  const byRun = new Map<string, Flow>();
  for (const f of Object.values(flows)) for (const s of f.steps) if (s.runId) byRun.set(s.runId, f);
  const items: InboxItem[] = [];
  for (const a of asks) if (a.state === "open") items.push(askItem(a, now, ctx));
  for (const r of Object.values(runs)) {
    const it = runItem(r, byRun.get(r.id), ctx);
    if (it) items.push(it);
  }
  for (const f of Object.values(flows)) {
    const it = flowItem(f, runs, ctx);
    if (it) items.push(it);
  }
  for (const s of ctx.sprouts ?? []) {
    const it = sproutItem(s, flows, ctx);
    if (it) items.push(it);
  }
  const advice = adviceItem(ctx.advice ?? []);
  if (advice) items.push(advice);
  return items.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/** the asks that closed lately, newest first, for how each went; one routed
 *  to the terminal at once never waited here, so it is left out */
export function recentAsks(asks: readonly Ask[]): Ask[] {
  return asks
    .filter((a) => a.state !== "open" && a.state !== "local")
    .sort((a, b) => (b.answeredAt ?? b.createdAt) - (a.answeredAt ?? a.createdAt));
}

/** the open asks of one agent, by its card id */
export const asksOf = (asks: readonly Ask[], agent: string): Ask[] => asks.filter((a) => a.state === "open" && a.agent === agent);

/** What the human said, before it is routed to where the item came from. */
export type InboxAnswer =
  /** `remember` is a run's: allow, and keep this rule for later runs */
  | { behavior: "allow"; always?: boolean; remember?: RememberAsk }
  | { behavior: "deny"; message?: string }
  | { answers: Record<string, string> }
  | { choice: FlowChoice }
  /** clarify's questions passed over: go on assumptions */
  | { skip: true }
  /** a retro lesson accepted or dismissed, by its key */
  | { advice: string; accept: boolean }
  /** an extend's push: yes or no, for the head the item shows */
  | { handOff: boolean };

/** a run's answer: "allow always" is "allow all" for the rest of the run;
 *  a run's deny carries no message */
export function toRunAnswer(a: InboxAnswer): RunAnswer | null {
  if ("choice" in a || "skip" in a || "advice" in a || "handOff" in a) return null;
  if ("answers" in a) return { kind: "answers", answers: a.answers };
  if (a.behavior === "deny") return { kind: "deny" };
  if (a.always) return { kind: "allow-all" };
  return a.remember ? { kind: "allow", remember: a.remember } : { kind: "allow" };
}

/** the broker's answer: a question's answers go as an allow; a remember's
 *  rule rides along for the home backend to keep (the broker never sees it) */
export function toAskAnswer(a: InboxAnswer): (AskAnswer & { remember?: string }) | null {
  if ("choice" in a || "skip" in a || "advice" in a || "handOff" in a) return null;
  if ("answers" in a) return { behavior: "allow", answers: a.answers };
  if (a.behavior === "deny") return { behavior: "deny", ...(a.message?.trim() ? { message: a.message.trim() } : {}) };
  return { behavior: "allow", ...(a.always ? { always: true } : {}), ...(a.remember ? { remember: a.remember.rule } : {}) };
}

/** How often the open inbox redraws its clocks: every second while an
 *  ask counts down to its terminal, else often enough for a run's or a
 *  gate's "how long ago" to move on (it reads in minutes). */
export const inboxTick = (items: readonly Pick<InboxItem, "until">[]): number => (items.some((i) => i.until !== null) ? 1_000 : 15_000);

/** One scope a remember can keep a rule for, in words. */
export interface ScopeOffer {
  kind: RememberScope["kind"];
  label: string;
}

/** The scopes a run's permission can be remembered for, the default first:
 *  a flow's step in every project, its whole workflow, or the repo; a plain
 *  run, or a step of a workflow the repo ships itself, has the repo alone. */
export function scopeOffers(item: Pick<InboxItem, "flowStep" | "repo" | "repoPath">): ScopeOffer[] {
  const repo: ScopeOffer = { kind: "repo", label: scopeWords({ kind: "repo", path: item.repoPath ?? item.repo }) };
  const f = item.flowStep;
  if (!f || f.source === "repo") return [repo];
  const { workflow, step, source } = f;
  return [
    { kind: "step", label: scopeWords({ kind: "step", workflow, step, source }) },
    { kind: "workflow", label: scopeWords({ kind: "workflow", workflow, source }) },
    repo,
  ];
}

/** what the chip says on the tooltip: "2 in the inbox: …" */
export function inboxTitle(items: readonly InboxItem[]): string {
  if (items.length === 0) return "The inbox is empty";
  return [`${items.length} in the inbox`, ...items.slice(0, 5).map((i) => `${i.who}${i.repo ? ` in ${i.repo}` : ""}: ${i.title}`)].join("\n");
}

/** Asks held by id with `incoming` laid over them and `gone` dropped; an
 *  ask only ever leaves `open`, so an open reading of one held closed (a
 *  list that raced an event) is passed over. The same object when nothing
 *  moved. */
export function mergeAsks(held: Readonly<Record<string, Ask>>, incoming: readonly Ask[], gone: readonly string[] = []): Record<string, Ask> {
  let next: Record<string, Ask> | null = null;
  for (const a of incoming) {
    const had = held[a.id];
    if (had === a || (had && had.state !== "open" && a.state === "open")) continue;
    next ??= { ...held };
    next[a.id] = a;
  }
  for (const id of gone) {
    if (!(id in (next ?? held))) continue;
    next ??= { ...held };
    delete next[id];
  }
  return (next ?? held) as Record<string, Ask>;
}

/** A whole list read as the asks held: what it names, except that an ask
 *  held closed never reopens on an open reading, and that `since` names the
 *  asks an event told of while the list was on its way, whose event stands
 *  (an ask it brought is kept though the list lacks it, one it said was
 *  gone stays gone). An ask the list lacks that no event touched has gone. */
export function replaceAsks(
  held: Readonly<Record<string, Ask>>,
  list: readonly Ask[],
  since: (id: string) => boolean = () => false,
): Record<string, Ask> {
  const out: Record<string, Ask> = {};
  for (const a of list) {
    const had = Object.hasOwn(held, a.id) ? held[a.id] : undefined;
    if (since(a.id)) {
      if (had) out[a.id] = had;
      continue;
    }
    out[a.id] = had && had.state !== "open" && a.state === "open" ? had : a;
  }
  for (const [id, had] of Object.entries(held)) if (!Object.hasOwn(out, id) && since(id)) out[id] = had;
  return out;
}

/** A tool's input as the details view shows it: a shell command as it is,
 *  a file's path and what goes in it, anything else as indented JSON; text
 *  that is not JSON as it came. */
export function detailText(detail: string): string {
  let v: unknown;
  try {
    v = JSON.parse(detail);
  } catch {
    return detail;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  const o = v as Record<string, unknown>;
  if (typeof o.command === "string") return o.description && typeof o.description === "string" ? `# ${o.description}\n${o.command}` : o.command;
  if (Array.isArray(o.command)) return o.command.map(String).join(" ");
  return JSON.stringify(o, null, 2);
}
