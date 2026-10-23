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

import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "../core/store";
import {
  afterRestart,
  existing,
  fromFlow,
  fromLanding,
  fromPr,
  fromRun,
  ignoreReason,
  linearFresh,
  newEvent,
  parseLinear,
  parseRules,
  parseSentry,
  pruneEvents,
  resumable,
  retryable,
  sampleIncoming,
  eventLive,
  type Delivery,
  type Incoming,
  type TriggerEvent,
  type TriggerRule,
  type TriggerRuleInfo,
  type TriggersInfo,
} from "../core/trigger";
import type { Flow, LandNotice, PrWatch, Repo, Run, ServerEvent } from "../core/types";
import { linearComment, linearDone } from "./linear";

export const triggersFile = (): string => join(configDir(), "triggers.json");
export const triggersDir = (): string => join(configDir(), "triggers");
/** how often the queue is tried again, for a slot freed while nothing told the hub */
export const TICK_EVERY = 30_000;
/** the largest hook body read; Sentry's and Linear's are a few kilobytes */
export const MAX_BODY = 1024 * 1024;

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
  file?: string;
  dir?: string;
  now?: () => number;
  tickEvery?: number;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
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
        hook: `/api/hooks/${r.source}/${r.name}`,
        secretSet: this.env(r.secretEnv) !== undefined,
        tokenSet: r.tokenEnv ? this.env(r.tokenEnv) !== undefined : false,
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
    this.events.set(e.id, e);
    this.persist();
    this.publish();
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

  /** One issue under one rule: dedupe, the rule's filters, then a run or the queue. */
  deliver(rule: TriggerRule, inc: Incoming, source: TriggerEvent["source"]): Promise<Delivery> {
    return this.queue(async () => {
      if (!this.keeping) throw new TriggerError("this backend does not hold the flows lock, so it starts no trigger", 503);
      const repo = this.deps.repo(rule.repo);
      if (!repo) throw new TriggerError(`no repo ${rule.repo} in the tree`, 404);
      const now = this.now();
      const had = existing(this.list(), rule.name, inc.key);
      if (had) {
        this.set({ ...had, count: had.count + 1, lastAt: now });
        return { kind: "duplicate", event: this.events.get(had.id) ?? had };
      }
      const problem = await this.deps.workflowProblem(rule.workflow, repo);
      if (problem) throw new TriggerError(problem, 400);
      const ignored = source === "manual" ? null : ignoreReason(rule, inc);
      const event = newEvent(rule, inc, repo.id, source, now, ignored);
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
      const next: TriggerEvent =
        "flow" in out
          ? { ...event, status: "working", flowId: out.flow.id, ...(out.flow.branch ? { branch: out.flow.branch.origin } : {}) }
          : { ...event, status: "working", runId: out.run.id, ...(out.run.branch ? { branch: out.run.branch.origin } : {}) };
      delete next.reason;
      delete next.endedAt;
      // a flow's first step can end inside its start, before the event knew
      // its id; the flow is the live object, so read where it is now
      const now = "flow" in out ? fromFlow(next, out.flow, this.now()) : next;
      this.set(now);
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

  /** The rule and its token, for a call that writes back to the service. */
  private async writer(e: TriggerEvent): Promise<{ rule: TriggerRule; token: string } | null> {
    if (e.source === "manual") return null;
    await this.loadRules();
    const rule = this.rule(e.rule);
    const token = rule?.tokenEnv ? this.env(rule.tokenEnv) : undefined;
    return rule && token ? { rule, token } : null;
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

  private linkIssue(id: string): Promise<void> {
    return this.queue(async () => {
      const e = this.events.get(id);
      if (!e?.pr || e.linked || e.service !== "linear") return;
      const w = await this.writer(e);
      if (!w) return;
      try {
        await (this.deps.link ?? linearComment)(w.rule, e, w.token);
        this.mark(id, { linked: { at: this.now() } });
      } catch (err) {
        this.mark(id, { linked: { error: errText(err) } });
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
      for (const k of ["runId", "flowId", "step", "branch", "reason", "endedAt", "pr", "resolved", "linked"] as const) delete fresh[k];
      this.set(fresh);
      return this.begin(fresh, repo);
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
    if (!rule || rule.source !== source) return json({ error: "no such hook" }, 404);
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
    const inc = linear ? parseLinear(payload, rule.labels) : parseSentry(req.headers.get("sentry-hook-resource") ?? "", payload);
    // both services count anything but a 200 as a failure and retry it, so an
    // installation ping, a resolved issue or an edit that adds no label is a quiet 200
    if (!inc) return json({ kind: "skip", why: linear ? "no label this rule takes was added" : "not a new issue" });
    const d = await this.deliver(rule, inc, rule.source);
    return json(d.kind === "skip" ? d : { kind: d.kind, event: d.event.id });
  }
}
