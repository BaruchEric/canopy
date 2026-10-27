/** Triggers' server half: the hooks Sentry and Linear post to, the event records, the
 *  queue of events waiting for a branch run slot, and the event's state as
 *  its run and its PR move. The model is `core/trigger.ts`; the branch run
 *  and its PR are the landing queue's and the PR watch's.
 *
 *  The rules are `<configDir>/triggers.json`, written by hand. The events are
 *  `<configDir>/triggers/events.json`, written only by the server holding the
 *  flows lock (`adopt`), as with the landing and PR records, so two servers
 *  sharing one config dir never both write them. The lock is per machine:
 *  what keeps the Mac and the mini from both starting a run for one issue is
 *  that Sentry posts to one address. A server without the lock answers a
 *  hook 503, and Sentry retries the same address later. */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "../core/store";
import {
  activityFor,
  afterRestart,
  existing,
  fromFlow,
  fromLanding,
  fromPr,
  fromRun,
  ignoreReason,
  issueNoteFor,
  linearFresh,
  linearInstallUrl,
  newEvent,
  otherWorkspace,
  parseAgentEvent,
  parseLinear,
  parseRules,
  parseSentry,
  pruneEvents,
  resumable,
  retryable,
  sampleIncoming,
  eventLive,
  type AgentActivity,
  type AgentDelivery,
  type Delivery,
  type Incoming,
  type TriggerEvent,
  type TriggerRule,
  type TriggerRuleInfo,
  type TriggersInfo,
} from "../core/trigger";
import type { Flow, LandNotice, PrWatch, Repo, Run, ServerEvent } from "../core/types";
import type { WorkSink } from "../core/work";
import { forgetAppToken, linearActivity, linearAppToken, linearComment, linearDone, LinearError, linearInstall, linearNote, linearSessionLinks, type LinearInstall } from "./linear";

export const triggersFile = (): string => join(configDir(), "triggers.json");
export const triggersDir = (): string => join(configDir(), "triggers");
/** how often the queue is tried again, for a slot freed while nothing told the hub */
export const TICK_EVERY = 30_000;
/** the largest hook body read; Sentry's and Linear's are a few kilobytes */
export const MAX_BODY = 1024 * 1024;
/** how long an install link's state is good for, from the click to Linear's redirect back */
export const INSTALL_FOR = 10 * 60 * 1000;

export class TriggerError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/** What starting an event's run came to: a run, or the repo's branch slots are full. */
export type StartOutcome = { run: Run } | { flow: Flow } | { busy: string };

/** What a Linear agent session is told: an activity, or links added to it. */
export type AgentSay = { activity: AgentActivity } | { links: { label: string; url: string }[] };

/** Linear's API for an agent session. */
const linearAgent = (rule: TriggerRule, token: string, session: string, say: AgentSay): Promise<void> =>
  "activity" in say ? linearActivity(rule, token, session, say.activity) : linearSessionLinks(rule, token, session, say.links);

/** An event a message in its agent session can carry on: stopped, or ended
 *  with nothing committed, on a branch still kept. */
export const followable = (e: TriggerEvent): boolean => e.branch !== undefined && (e.status === "stopped" || e.status === "no-fix");

export interface TriggerDeps {
  broadcast: (ev: ServerEvent) => void;
  /** a rule's repo, by id or absolute path */
  repo: (ref: string) => Repo | undefined;
  /** why a rule's workflow cannot run as a trigger, or null */
  workflowProblem: (name: string, repo: Repo) => Promise<string | null>;
  /** starts the event's branch run, or its flow on a branch, which opens a
   *  PR when it settles ready */
  start: (event: TriggerEvent, repo: Repo) => Promise<StartOutcome>;
  /** resumes the stopped work on the event's branch: its flow picked up
   *  where it stopped, or a run resuming the branch's last session */
  resume: (event: TriggerEvent) => Promise<{ run: Run } | { flow: Flow }>;
  /** stops a run by id */
  stopRun: (id: string) => void;
  /** whether this server holds a run by id */
  runKnown: (id: string) => boolean;
  /** stops a flow by id */
  stopFlow?: (id: string) => void;
  /** whether this server holds a flow by id: one is taken back after a restart */
  flowKnown?: (id: string) => boolean;
  /** a trigger secret's value: the `CANOPY_TRIGGER_` variables the server
   *  took out of its env at start (`takeTriggerSecrets`) */
  env: (name: string) => string | undefined;
  /** marks an outside issue resolved once its PR merges; the rule's service's
   *  API unless a test says otherwise */
  resolve?: (rule: TriggerRule, event: TriggerEvent, token: string) => Promise<void>;
  /** tells a Linear issue its PR opened; Linear's API unless a test says otherwise */
  link?: (rule: TriggerRule, event: TriggerEvent, token: string) => Promise<void>;
  /** comments on a Linear issue whose run ended without a PR; Linear's API unless a test says otherwise */
  note?: (rule: TriggerRule, event: TriggerEvent, token: string, body: string) => Promise<void>;
  /** tells a Linear agent session something; Linear's API unless a test says otherwise */
  agent?: (rule: TriggerRule, token: string, session: string, say: AgentSay) => Promise<void>;
  /** the Linear app's token for a rule, from its client secret; minted with
   *  the client credentials grant unless a test says otherwise */
  appToken?: (rule: TriggerRule, secret: string) => Promise<string>;
  /** carries an event on with a message written in its agent session: a run
   *  on the event's branch that reads the message */
  followUp?: (event: TriggerEvent, text: string) => Promise<{ run: Run }>;
  /** canopy's public address (`CANOPY_PUBLIC_ORIGIN`), for the session's
   *  link to the triggers page and the install's redirect back */
  origin?: string;
  /** finishes a Linear app's install with the code Linear sent back; Linear's API unless a test says otherwise */
  install?: (rule: TriggerRule, secret: string, code: string, redirect: string) => Promise<LinearInstall>;
  /** the work item's link and status lines; absent for pre-ledger events */
  work?: WorkSink;
  file?: string;
  dir?: string;
  now?: () => number;
  tickEvery?: number;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const escapeHtml = (t: string): string => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page a browser lands on after a Linear install: one heading, one
 *  line, and the way back to the triggers page. */
function installPage(status: number, title: string, line: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 16px}code{font-size:.9em;overflow-wrap:anywhere}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${line}</p><p><a href="/?view=triggers">Back to canopy's triggers</a></p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);

/** Whether `signature` is the hex HMAC-SHA256 of `body` under `secret`,
 *  compared in constant time: Sentry's `Sentry-Hook-Signature` and Linear's
 *  `Linear-Signature` are both that. */
export function signatureOk(body: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const want = createHmac("sha256", secret).update(body, "utf8").digest();
  let got: Buffer;
  try {
    got = Buffer.from(signature.trim(), "hex");
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Sentry's API: PUT the issue's status. With an org the organisation
 *  route, else the older route that takes the issue id alone. */
async function sentryResolve(rule: TriggerRule, event: TriggerEvent, token: string): Promise<void> {
  const path = rule.org ? `/api/0/organizations/${encodeURIComponent(rule.org)}/issues/${encodeURIComponent(event.key)}/` : `/api/0/issues/${encodeURIComponent(event.key)}/`;
  const res = await fetch(`${rule.api}${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "resolved" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Sentry answered ${res.status}`);
}

export class TriggerHub {
  private rules: TriggerRule[] = [];
  private problems: string[] = [];
  private events = new Map<string, TriggerEvent>();
  private keeping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** every change runs here, one after another, so two deliveries of one
   *  issue never both start a run */
  private serial: Promise<void> = Promise.resolve();
  private writing: Promise<void> = Promise.resolve();
  /** install links handed out, by their state, until Linear sends the admin back */
  private installs = new Map<string, { rule: string; redirect: string; at: number }>();
  /** what agent sessions are told, in order, apart from the serial queue so
   *  a slow call to Linear never holds a delivery up */
  private telling: Promise<void> = Promise.resolve();
  private pumping = false;

  constructor(private deps: TriggerDeps) {}

  private get file(): string {
    return this.deps.file ?? triggersFile();
  }
  private get dir(): string {
    return this.deps.dir ?? triggersDir();
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private env(name: string): string | undefined {
    const v = this.deps.env(name);
    return v?.trim() ? v.trim() : undefined;
  }

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.serial.then(fn);
    this.serial = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  /** Resolves once every change asked for so far is done and on disk. */
  async idle(): Promise<void> {
    await this.serial;
    await this.telling;
    await this.writing;
  }

  /* ---------- rules ---------- */

  /** Reads `triggers.json` again; called before each use, since it is edited by hand. */
  async loadRules(): Promise<void> {
    let text: string | null = null;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      // no rules yet
    }
    const { rules, problems } = parseRules(text);
    this.rules = rules;
    this.problems = problems;
  }

  private rule(name: string): TriggerRule | undefined {
    return this.rules.find((r) => r.name === name);
  }

  async info(): Promise<TriggersInfo> {
    await this.loadRules();
    const rules: TriggerRuleInfo[] = [];
    for (const r of this.rules) {
      const repo = this.deps.repo(r.repo);
      const problem = repo ? await this.deps.workflowProblem(r.workflow, repo) : `no repo ${r.repo} in the tree`;
      rules.push({
        ...r,
        ...(r.source !== "schedule" ? { hook: `/api/hooks/${r.source}/${r.name}` } : {}),
        secretSet: r.secretEnv ? this.env(r.secretEnv) !== undefined : true,
        tokenSet: r.tokenEnv ? this.env(r.tokenEnv) !== undefined : false,
        agentSet: r.clientSecretEnv ? this.env(r.clientSecretEnv) !== undefined : false,
        ...(r.clientId ? { install: `/api/linear/install?rule=${encodeURIComponent(r.name)}` } : {}),
        ...(problem ? { problem } : {}),
      });
    }
    return { rules, problems: this.problems, events: this.list(), keeping: this.keeping };
  }

  list(): TriggerEvent[] {
    return [...this.events.values()].sort((a, b) => b.lastAt - a.lastAt);
  }

  get(id: string): TriggerEvent | undefined {
    return this.events.get(id);
  }

  /* ---------- records ---------- */

  private publish(): void {
    this.deps.broadcast({ type: "triggers", events: this.list() });
  }

  private set(e: TriggerEvent): void {
    const prev = this.events.get(e.id);
    this.events.set(e.id, e);
    this.persist();
    this.publish();
    if (e.work && e.status !== prev?.status && (e.status === "no-fix" || e.status === "failed" || e.status === "stopped")) {
      this.deps.work?.note(e.work, `trigger event ${e.short ?? e.key} ${e.status}${e.reason ? `: ${e.reason}` : ""}`);
    }
    const activity = activityFor(prev, e);
    if (activity && e.session) this.tell(e.rule, e.session, { activity });
    const note = issueNoteFor(prev, e, this.deps.origin);
    if (note) void this.noteIssue(e.id, note);
  }

  private persist(): void {
    if (!this.keeping) return;
    const kept = pruneEvents(this.list());
    if (kept.length !== this.events.size) this.events = new Map(kept.map((e) => [e.id, e]));
    const path = join(this.dir, "events.json");
    const data = JSON.stringify({ events: kept }, null, 2);
    this.writing = this.writing
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        const tmp = `${path}.tmp-${process.pid}`;
        await writeFile(tmp, data);
        await rename(tmp, path);
      })
      .catch((err) => console.error(`triggers: ${errText(err)}`));
  }

  /** Takes the events the last server left, as the holder of the flows
   *  lock: a run a restart took reads as stopped, and the queue goes on. */
  async adopt(): Promise<void> {
    this.keeping = true;
    await this.loadRules();
    try {
      const v: unknown = JSON.parse(await readFile(join(this.dir, "events.json"), "utf8"));
      const list = isRecord(v) && Array.isArray(v["events"]) ? v["events"] : [];
      for (const e of list) {
        if (isRecord(e) && typeof e["id"] === "string" && typeof e["key"] === "string" && typeof e["status"] === "string") {
          const ev = afterRestart(e as unknown as TriggerEvent, this.deps.runKnown, this.deps.flowKnown);
          this.events.set(ev.id, ev);
        }
      }
    } catch {
      // nothing kept yet, or unreadable: start empty and say so once
    }
    this.persist();
    this.publish();
    void this.pump();
  }

  detach(): void {
    this.keeping = false;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pump(), this.deps.tickEvery ?? TICK_EVERY);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ---------- deliveries ---------- */

  /** One issue under one rule: dedupe, the rule's filters, then a run or the
   *  queue. A Linear agent session's issue carries the session, and the event
   *  reports to it from then on. */
  deliver(rule: TriggerRule, inc: Incoming, source: TriggerEvent["source"], session?: string): Promise<Exclude<Delivery, { kind: "fired" }>> {
    return this.queue(async () => {
      if (!this.keeping) throw new TriggerError("this backend does not hold the flows lock, so it starts no trigger", 503);
      const repo = this.deps.repo(rule.repo);
      if (!repo) throw new TriggerError(`no repo ${rule.repo} in the tree`, 404);
      const now = this.now();
      const had = existing(this.list(), rule.name, inc.key);
      if (had) {
        this.set({ ...had, count: had.count + 1, lastAt: now, ...(session ? { session } : {}) });
        if (session) {
          const pr = had.pr ? ` Its pull request is ${had.pr.url}.` : "";
          const more = followable(had) ? " Write here to carry it on from where it stopped." : " Updates come here from now on.";
          this.tell(rule.name, session, { activity: { type: "response", body: `canopy already has this issue, and its run reads ${had.status}.${pr}${more}` } });
        }
        return { kind: "duplicate", event: this.events.get(had.id) ?? had };
      }
      const problem = await this.deps.workflowProblem(rule.workflow, repo);
      if (problem) throw new TriggerError(problem, 400);
      const ignored = source === "manual" ? null : ignoreReason(rule, inc);
      const event: TriggerEvent = { ...newEvent(rule, inc, repo.id, source, now, ignored), ...(session ? { session } : {}) };
      this.set(event);
      if (ignored) return { kind: "ignored", event };
      const started = await this.begin(event, repo);
      return { kind: started.status === "queued" ? "queued" : "started", event: started };
    });
  }

  /** Starts an event's run, or leaves it queued when the repo's branch slots are full. */
  private async begin(event: TriggerEvent, repo: Repo): Promise<TriggerEvent> {
    try {
      const out = await this.deps.start(event, repo);
      if ("busy" in out) {
        const queued: TriggerEvent = { ...event, status: "queued", reason: out.busy };
        this.set(queued);
        return queued;
      }
      const work = "flow" in out ? out.flow.branch?.work : out.run.branch?.work;
      const next: TriggerEvent =
        "flow" in out
          ? { ...event, status: "working", flowId: out.flow.id, ...(out.flow.branch ? { branch: out.flow.branch.origin } : {}), ...(work ? { work } : {}) }
          : { ...event, status: "working", runId: out.run.id, ...(out.run.branch ? { branch: out.run.branch.origin } : {}), ...(work ? { work } : {}) };
      delete next.reason;
      delete next.endedAt;
      // a flow's first step can end inside its start, before the event knew
      // its id; the flow is the live object, so read where it is now
      const now = "flow" in out ? fromFlow(next, out.flow, this.now()) : next;
      this.set(now);
      if (now.work) this.deps.work?.link(now.work, { event: now.id });
      return now;
    } catch (err) {
      const failed: TriggerEvent = { ...event, status: "failed", reason: errText(err), endedAt: this.now() };
      this.set(failed);
      return failed;
    }
  }

  /** Tries every queued event again, oldest first. */
  async pump(): Promise<void> {
    if (!this.keeping || this.pumping) return;
    this.pumping = true;
    try {
      const waiting = this.list().filter((e) => e.status === "queued").reverse();
      for (const e of waiting) {
        await this.queue(async () => {
          const now = this.events.get(e.id);
          if (now?.status !== "queued") return;
          const repo = this.deps.repo(now.repoId);
          if (!repo) {
            this.set({ ...now, status: "failed", reason: `${now.repoId} is no longer in the tree`, endedAt: this.now() });
            return;
          }
          await this.begin(now, repo);
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  /* ---------- runs and PRs ---------- */

  /** The Runner's every change: the event waiting on that run follows it. */
  onRun(run: Run): void {
    for (const e of this.events.values()) {
      if (e.runId !== run.id) continue;
      const next = fromRun(e, run, this.now());
      if (next !== e && JSON.stringify(next) !== JSON.stringify(e)) this.set(next);
    }
    // a run ending may free a branch slot a queued event waits for
    if (run.status !== "working" && run.status !== "waiting" && run.status !== "idle") void this.pump();
  }

  /** The flows' every change: the event following that flow moves with it. */
  onFlow(flow: Flow): void {
    if (!flow.branch) return;
    for (const e of this.events.values()) {
      if (e.flowId !== flow.id) continue;
      const next = fromFlow(e, flow, this.now());
      if (next !== e && JSON.stringify(next) !== JSON.stringify(e)) this.set(next);
    }
    // a flow ending may free a branch slot a queued event waits for
    if (flow.status === "done" || flow.status === "failed" || flow.status === "stopped") void this.pump();
  }

  /** The PR watch's every change: an event follows its branch's PR, a
   *  Linear issue hears of its PR, and a merge marks the outside issue
   *  resolved, when the rule holds a token. */
  onPrs(prs: PrWatch[]): void {
    for (const w of prs) {
      for (const e of this.events.values()) {
        if (e.branch !== w.id) continue;
        const next = fromPr(e, w, this.now());
        if (next === e) continue;
        this.set(next);
        if (!this.keeping) continue;
        // queued in this order, so the link lands before the move to done
        if (next.service === "linear" && next.pr && !next.linked) void this.linkIssue(next.id);
        if (next.status === "merged" && !next.resolved) void this.resolveIssue(next.id);
      }
    }
  }

  /** The landing queue's notices: a committed event whose PR did not open says why. */
  onLanding(notices: readonly LandNotice[]): void {
    for (const e of this.events.values()) {
      const next = fromLanding(e, notices);
      if (next !== e) this.set(next);
    }
  }

  /** The rule and its token, for a call that writes back to the service:
   *  the rule's `tokenEnv`, else the Linear app's own token when the agent is on. */
  private async writer(e: TriggerEvent): Promise<{ rule: TriggerRule; token: string } | null> {
    if (e.source === "manual") return null;
    await this.loadRules();
    const rule = this.rule(e.rule);
    if (!rule) return null;
    const token = rule.tokenEnv ? this.env(rule.tokenEnv) : undefined;
    if (token) return { rule, token };
    const app = await this.appTokenOf(rule).catch(() => undefined);
    return app ? { rule, token: app } : null;
  }

  /** The Linear app's token, or undefined when the rule has no app or its secret is unset. */
  private async appTokenOf(rule: TriggerRule): Promise<string | undefined> {
    const secret = rule.clientSecretEnv ? this.env(rule.clientSecretEnv) : undefined;
    if (!rule.clientId || !secret) return undefined;
    return (this.deps.appToken ?? linearAppToken)(rule, secret);
  }

  /** Queues something for an agent session, after whatever it was told before. */
  private tell(ruleName: string, session: string, say: AgentSay): void {
    if (!this.keeping) return;
    this.telling = this.telling.then(() => this.sayNow(ruleName, session, say)).catch((err) => console.error(`triggers: Linear session ${session}: ${errText(err)}`));
  }

  /** Tells an agent session something now, as the app; a token Linear
   *  refuses is minted again once. */
  private async sayNow(ruleName: string, session: string, say: AgentSay): Promise<void> {
    await this.loadRules();
    const rule = this.rule(ruleName);
    if (!rule) throw new Error(`no rule ${ruleName} any more`);
    const call = async () => {
      const token = await this.appTokenOf(rule);
      if (!token) throw new Error(`${rule.name} has no Linear app secret set, so its sessions hear nothing`);
      await (this.deps.agent ?? linearAgent)(rule, token, session, say);
    };
    try {
      await call();
    } catch (err) {
      if (!(err instanceof LinearError && err.status === 401)) throw err;
      forgetAppToken(rule);
      await call();
    }
  }

  /** Sets one field on the event as it is now: the PR watch may have moved
   *  it while the call was out. */
  private mark(id: string, patch: Pick<TriggerEvent, "resolved"> | Pick<TriggerEvent, "linked">): void {
    const now = this.events.get(id);
    if (now) this.set({ ...now, ...patch });
  }

  private resolveIssue(id: string): Promise<void> {
    return this.queue(async () => {
      const e = this.events.get(id);
      if (!e || e.status !== "merged" || e.resolved) return;
      const w = await this.writer(e);
      if (!w) return;
      const resolve = this.deps.resolve ?? (w.rule.source === "linear" ? linearDone : sentryResolve);
      try {
        await resolve(w.rule, e, w.token);
        this.mark(id, { resolved: { at: this.now() } });
      } catch (err) {
        this.mark(id, { resolved: { error: errText(err) } });
      }
    });
  }

  /** The PR's link goes to the issue: on its agent session when it has one,
   *  else as a comment. */
  private linkIssue(id: string): Promise<void> {
    return this.queue(async () => {
      const e = this.events.get(id);
      if (!e?.pr || e.linked || e.service !== "linear" || e.source === "manual") return;
      try {
        if (e.session) {
          await this.sayNow(e.rule, e.session, { links: [{ label: `Pull request #${e.pr.number}`, url: e.pr.url }] });
        } else {
          const w = await this.writer(e);
          if (!w) return;
          await (this.deps.link ?? linearComment)(w.rule, e, w.token);
        }
        this.mark(id, { linked: { at: this.now() } });
      } catch (err) {
        this.mark(id, { linked: { error: errText(err) } });
      }
    });
  }

  /** Comments on a labeled Linear issue why its run ended without a PR. A
   *  refusal is only logged: the event already says how the run ended. */
  private noteIssue(id: string, body: string): Promise<void> {
    return this.queue(async () => {
      const e = this.events.get(id);
      if (!e || !this.keeping) return;
      const w = await this.writer(e);
      if (!w) return;
      try {
        await (this.deps.note ?? linearNote)(w.rule, e, w.token, body);
      } catch (err) {
        console.error(`triggers: Linear issue ${e.short}: ${errText(err)}`);
      }
    });
  }

  /* ---------- acts ---------- */

  fire(name: string, title: string): Promise<Delivery> {
    return this.loadRules().then(() => {
      const rule = this.rule(name);
      if (!rule) throw new TriggerError(`no trigger rule called ${name}`, 404);
      return this.deliver(rule, sampleIncoming(title, this.now(), rule.source), "manual");
    });
  }

  resume(id: string): Promise<TriggerEvent> {
    return this.queue(async () => {
      const e = this.events.get(id);
      if (!e) throw new TriggerError(`no trigger event ${id}`, 404);
      if (!resumable(e)) throw new TriggerError(`${e.short ?? e.title} is ${e.status}, not stopped on a branch`);
      const out = await this.deps.resume(e);
      const next: TriggerEvent = "flow" in out ? { ...e, status: "working", flowId: out.flow.id } : { ...e, status: "working", runId: out.run.id };
      // a run in place of a flow the server no longer keeps: the event follows that run
      if ("run" in out) {
        delete next.flowId;
        delete next.step;
      }
      delete next.reason;
      delete next.endedAt;
      const now = "flow" in out ? fromFlow(next, out.flow, this.now()) : next;
      this.set(now);
      return now;
    });
  }

  retry(id: string): Promise<TriggerEvent> {
    return this.queue(async () => {
      const e = this.events.get(id);
      if (!e) throw new TriggerError(`no trigger event ${id}`, 404);
      if (!retryable(e)) throw new TriggerError(`${e.short ?? e.title} is ${e.status}; only a failed, fixless or branchless stopped one starts again`);
      const repo = this.deps.repo(e.repoId);
      if (!repo) throw new TriggerError(`${e.repoId} is no longer in the tree`, 404);
      const fresh: TriggerEvent = { ...e, status: "queued", lastAt: this.now() };
      for (const k of ["runId", "flowId", "step", "branch", "reason", "endedAt", "pr", "resolved", "linked", "summary"] as const) delete fresh[k];
      this.set(fresh);
      return this.begin(fresh, repo);
    });
  }

  /** Carries a stopped or fixless event on with a message from its agent
   *  session: a run on its branch that reads the message. */
  followUp(id: string, text: string): Promise<TriggerEvent> {
    return this.queue(async () => {
      const e = this.events.get(id);
      if (!e) throw new TriggerError(`no trigger event ${id}`, 404);
      if (!followable(e)) throw new TriggerError(`${e.short ?? e.title} is ${e.status}; only a stopped or fixless one on a kept branch carries on`);
      if (!this.deps.followUp) throw new TriggerError("this backend cannot carry an event on", 501);
      const out = await this.deps.followUp(e, text);
      const next: TriggerEvent = { ...e, status: "working", runId: out.run.id, lastAt: this.now() };
      for (const k of ["flowId", "step", "reason", "endedAt", "summary"] as const) delete next[k];
      this.set(next);
      return next;
    });
  }

  stopEvent(id: string): Promise<TriggerEvent> {
    return this.queue(async () => {
      const e = this.events.get(id);
      if (!e) throw new TriggerError(`no trigger event ${id}`, 404);
      if (e.status === "queued") {
        const next: TriggerEvent = { ...e, status: "stopped", reason: "taken off the queue", endedAt: this.now() };
        this.set(next);
        return next;
      }
      if (eventLive(e) && e.flowId && this.deps.stopFlow) {
        this.deps.stopFlow(e.flowId);
        return this.events.get(id) ?? e;
      }
      if (!eventLive(e) || !e.runId) throw new TriggerError(`${e.short ?? e.title} has no run going`);
      this.deps.stopRun(e.runId);
      return this.events.get(id) ?? e;
    });
  }

  dismiss(id: string): Promise<void> {
    return this.queue(async () => {
      const e = this.events.get(id);
      if (!e) return;
      if (e.status === "queued" || eventLive(e)) throw new TriggerError("stop it first: its run is still going or queued");
      this.events.delete(id);
      this.persist();
      this.publish();
    });
  }

  /* ---------- routes ---------- */

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname.replace(/\/+$/, "");
    const method = req.method;
    try {
      const hook = /^\/api\/hooks\/([a-z]+)\/([a-z0-9-]+)$/.exec(path);
      if (hook && method === "POST") return await this.hook(req, hook[1] ?? "", hook[2] ?? "");
      if (path === "/api/triggers" && method === "GET") return json(await this.info());
      if (path === "/api/linear/install" && method === "GET") return await this.install(url);
      if (path === "/api/linear/callback" && method === "GET") return await this.installed(url);
      if (path === "/api/triggers/events" && method === "DELETE") {
        await this.dismiss(url.searchParams.get("id") ?? "");
        return json({ ok: true });
      }
      if (!path.startsWith("/api/triggers/") || method !== "POST") return null;
      const b: unknown = await req.json().catch(() => null);
      if (!isRecord(b)) return json({ error: "malformed body" }, 400);
      const act = path.slice("/api/triggers/".length);
      if (act === "fire") {
        if (typeof b["rule"] !== "string") return json({ error: "missing rule" }, 400);
        return json(await this.fire(b["rule"], typeof b["title"] === "string" ? b["title"] : ""), 201);
      }
      if (typeof b["id"] !== "string") return json({ error: "missing event id" }, 400);
      if (act === "resume") return json(await this.resume(b["id"]));
      if (act === "retry") return json(await this.retry(b["id"]));
      if (act === "stop") return json(await this.stopEvent(b["id"]));
      return null;
    } catch (err) {
      return json({ error: errText(err) }, err instanceof TriggerError ? err.status : 500);
    }
  }

  /** A delivery from Sentry or Linear. Nothing in the body is read before
   *  its signature checks out against the rule's secret. */
  private async hook(req: Request, source: string, name: string): Promise<Response> {
    await this.loadRules();
    const rule = this.rule(name);
    if (!rule || rule.source !== source || !rule.secretEnv) return json({ error: "no such hook" }, 404);
    const secret = this.env(rule.secretEnv);
    if (!secret) return json({ error: `${rule.secretEnv} is not set on this backend` }, 503);
    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > MAX_BODY) return json({ error: "body too large" }, 413);
    const body = await req.text();
    if (body.length > MAX_BODY) return json({ error: "body too large" }, 413);
    const linear = rule.source === "linear";
    if (!signatureOk(body, req.headers.get(linear ? "linear-signature" : "sentry-hook-signature"), secret)) return json({ error: "bad signature" }, 401);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return json({ error: "body is not JSON" }, 400);
    }
    if (linear && !linearFresh(payload, this.now())) return json({ error: "the delivery's webhookTimestamp is more than a minute off" }, 401);
    if (linear && otherWorkspace(rule, payload)) return json({ kind: "skip", why: "a delivery from a Linear workspace other than the rule's" });
    if (linear && isRecord(payload) && payload["type"] === "AgentSessionEvent") return this.agentHook(rule, payload);
    const inc = linear ? parseLinear(payload, rule.labels) : parseSentry(req.headers.get("sentry-hook-resource") ?? "", payload);
    // both services count anything but a 200 as a failure and retry it, so an
    // installation ping, a resolved issue or an edit that adds no label is a quiet 200
    if (!inc) return json({ kind: "skip", why: linear ? "no label this rule takes was added" : "not a new issue" });
    const d = await this.deliver(rule, inc, rule.source);
    return json(d.kind === "skip" ? d : { kind: d.kind, event: d.event.id });
  }

  /** A Linear agent session event. Linear gives the hook 5 s and marks a
   *  session unresponsive after 10 s with no activity, so the hook answers
   *  at once and the session hears a thought before the run is started. */
  private agentHook(rule: TriggerRule, payload: unknown): Response {
    if (!rule.clientId) return json({ kind: "skip", why: "this rule has no Linear app, so its agent is off" });
    const d = parseAgentEvent(payload);
    if (!d) return json({ kind: "skip", why: "not a session event canopy acts on" });
    if (!this.keeping) return json({ error: "this backend does not hold the flows lock, so it starts no trigger" }, 503);
    const fail = (err: unknown) => this.tell(rule.name, d.session, { activity: { type: "error", body: errText(err) } });
    if (d.kind === "prompted") {
      void this.prompted(rule, d).catch(fail);
      return json({ kind: "accepted" });
    }
    if (!d.inc) {
      this.tell(rule.name, d.session, { activity: { type: "response", body: "canopy works on issues: delegate one to it, or mention it on one." } });
      return json({ kind: "skip", why: "the session is not on an issue" });
    }
    this.tell(rule.name, d.session, { activity: { type: "thought", body: `On it: starting a run in ${rule.repo}.` } });
    if (this.deps.origin) this.tell(rule.name, d.session, { links: [{ label: "canopy", url: `${this.deps.origin.replace(/\/+$/, "")}/?view=triggers` }] });
    void this.deliver(rule, d.inc, "linear", d.session).catch(fail);
    return json({ kind: "accepted" });
  }

  /** Sends a workspace admin to Linear to install the rule's app as itself. */
  private async install(url: URL): Promise<Response> {
    await this.loadRules();
    const rule = this.rule(url.searchParams.get("rule") ?? "");
    if (!rule || rule.source !== "linear" || !rule.clientId) return installPage(404, "No such Linear app", "The rule is gone, or it names no clientId.");
    const redirect = `${(this.deps.origin ?? url.origin).replace(/\/+$/, "")}/api/linear/callback`;
    const state = randomBytes(24).toString("base64url");
    const now = this.now();
    for (const [k, v] of this.installs) if (now - v.at > INSTALL_FOR) this.installs.delete(k);
    this.installs.set(state, { rule: rule.name, redirect, at: now });
    return new Response(null, { status: 302, headers: { location: linearInstallUrl(rule, redirect, state) ?? "/?view=triggers", "cache-control": "no-store" } });
  }

  /** Where Linear sends the admin back: the state must be one this server
   *  handed out, once and recently, before the code is traded. */
  private async installed(url: URL): Promise<Response> {
    const state = url.searchParams.get("state") ?? "";
    const held = this.installs.get(state);
    this.installs.delete(state);
    if (!held || this.now() - held.at > INSTALL_FOR) return installPage(400, "This install link is spent", "Start the install again from the rule on canopy's triggers page.");
    const refused = url.searchParams.get("error");
    if (refused) return installPage(400, "Linear did not install canopy", escapeHtml(url.searchParams.get("error_description") ?? refused));
    const code = url.searchParams.get("code");
    if (!code) return installPage(400, "Linear sent no code", "Start the install again from the rule on canopy's triggers page.");
    await this.loadRules();
    const rule = this.rule(held.rule);
    const secret = rule?.clientSecretEnv ? this.env(rule.clientSecretEnv) : undefined;
    if (!rule || !secret) return installPage(503, "canopy cannot finish the install", `${escapeHtml(rule?.clientSecretEnv ?? "The app's client secret")} is not set on this backend.`);
    try {
      const got = await (this.deps.install ?? linearInstall)(rule, secret, code, held.redirect);
      const keep = rule.organization === got.organization.id ? "The rule already takes this workspace alone." : `To take deliveries from this workspace alone, set <code>"organization": "${escapeHtml(got.organization.id)}"</code> on the ${escapeHtml(rule.name)} rule in triggers.json.`;
      return installPage(200, "canopy is installed in Linear", `In ${escapeHtml(got.organization.name)} as ${escapeHtml(got.app.name)}. ${keep}`);
    } catch (err) {
      return installPage(502, "Linear did not finish the install", escapeHtml(errText(err)));
    }
  }

  /** A message in an agent session: stop, carry on, or say why neither. */
  private async prompted(rule: TriggerRule, d: Extract<AgentDelivery, { kind: "prompted" }>): Promise<void> {
    const e = this.list().find((x) => x.session === d.session);
    const say = (body: string) => this.tell(rule.name, d.session, { activity: { type: "response", body } });
    if (!e) return say("canopy has no run for this session any more. Delegate the issue to canopy again to start one.");
    const going = e.status === "queued" || eventLive(e);
    if (d.stop) {
      if (!going) return say(`Nothing is running: the run reads ${e.status}.`);
      await this.stopEvent(e.id);
      return;
    }
    if (going) return say("The run is still going, and canopy reads a message only once it ends. Stop it to end it now.");
    if (followable(e)) {
      await this.followUp(e.id, d.text);
      return;
    }
    if (e.pr && e.status === "review") return say(`The pull request is open at ${e.pr.url}. Review comments there reach canopy's PR watch.`);
    if (retryable(e)) {
      await this.retry(e.id);
      return;
    }
    return say(`The run reads ${e.status}, so there is nothing to carry on. Delegate the issue again for a new run.`);
  }
}
