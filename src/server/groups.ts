/** Durable best-of-N groups. The flows-lock owner alone scores and writes.
 * Member gates share one serial loop per repo; comparison uses the checkout's
 * ordinary run slot. HTTP authorization belongs to the server's CallerGate. */
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { git } from "../core/exec";
import {
  comparePrompt,
  GROUP_MAX,
  LOSER_KEEP,
  parseCompare,
  pickWinner,
  settleGroup,
  type GroupDry,
  type MemberScore,
  type RunGroup,
} from "../core/group";
import { inQueue, sentBack } from "../core/landing";
import { configDir } from "../core/store";
import {
  isRunAction,
  isRunActive,
  type LandingInfo,
  type LandingRun,
  type PrWatch,
  type Repo,
  type Run,
  type ServerEvent,
} from "../core/types";

export interface GroupDeps {
  broadcast: (ev: ServerEvent) => void;
  repo: (id: string) => Repo | undefined;
  run: (id: string) => Run | undefined;
  activeFor: (repoId: string) => Run | undefined;
  /** a workflow can own its checkout between runner steps */
  checkoutBusy?: (repoId: string) => boolean;
  dryGates: (origin: string) => Promise<GroupDry>;
  /** current must be rechecked after async preflight, immediately before start */
  startReviewer: (
    group: RunGroup,
    prompt: string,
    current: () => boolean,
  ) => Promise<Run | null>;
  /** cancel only the reviewer this hub started, including an obsolete success */
  stopReviewer: (id: string) => Promise<void>;
  dropMember: (origin: string, why: string) => Promise<void>;
  openPr: (origin: string) => Promise<unknown>;
  /** Existing LandingHub.land, only for an auto-sorted non-PR winner. */
  land: (origin: string) => Promise<unknown>;
  landingInfo: () => LandingInfo;
  publish: (ev: ServerEvent) => void;
  dir?: string;
  now?: () => number;
}

/** Private journal fields stay on disk, outside the browser-safe group model. */
type SentBackSnapshot = {
  state: "red" | "conflict" | "moved";
  queuedAt: number;
  updatedAt: number;
  tries: number;
};
type DispatchIntent = { winner: string; retry?: SentBackSnapshot } & (
  | { kind: "land" | "pr"; status: "pending" | "done" }
  | { kind: "wait"; status: "waiting" }
);

type StoredGroup = RunGroup & { _dispatch?: DispatchIntent };

/** One projection for every public group boundary, without sharing mutable state. */
const publicGroup = ({
  _dispatch: _private,
  ...group
}: StoredGroup): RunGroup => structuredClone(group);

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");
const optional = (value: unknown, check: (v: unknown) => boolean): boolean =>
  value === undefined || check(value);
const verdict = (value: unknown): boolean =>
  value === "auto" || value === "land" || value === "approve";
const branchState = (value: unknown): boolean =>
  value === "working" ||
  value === "ready" ||
  value === "uncommitted" ||
  value === "nothing" ||
  value === "stopped" ||
  value === "failed";
const gates = (value: unknown): boolean =>
  record(value) &&
  typeof value["ok"] === "boolean" &&
  optional(value["red"], (v) => typeof v === "string") &&
  optional(value["tail"], (v) => typeof v === "string");
const scenarios = (value: unknown): boolean =>
  record(value) &&
  finite(value["score"]) &&
  value["score"] >= 0 &&
  value["score"] <= 1 &&
  finite(value["passed"]) &&
  finite(value["total"]);
const score = (value: unknown): boolean =>
  record(value) &&
  typeof value["branch"] === "string" &&
  typeof value["base"] === "string" &&
  branchState(value["state"]) &&
  optional(value["gates"], gates) &&
  optional(value["scenarios"], scenarios) &&
  optional(value["verdict"], verdict) &&
  optional(
    value["diffstat"],
    (v) =>
      record(v) &&
      finite(v["files"]) &&
      finite(v["added"]) &&
      finite(v["removed"]),
  ) &&
  optional(
    value["cost"],
    (v) => record(v) && finite(v["usd"]) && finite(v["tokens"]),
  );
const member = (value: unknown): value is RunGroup["members"][number] =>
  record(value) &&
  typeof value["run"] === "string" &&
  typeof value["origin"] === "string" &&
  (value["profile"] === null || typeof value["profile"] === "string");
const STATES = new Set([
  "working",
  "scoring",
  "reviewing",
  "picked",
  "landed",
  "dropped",
  "needs-you",
]);
/** The disk boundary is untrusted too, including records from an older server. */
function isGroup(value: unknown): value is StoredGroup {
  if (
    !record(value) ||
    typeof value["id"] !== "string" ||
    !/^g-[a-f0-9]{8}$/.test(value["id"]) ||
    typeof value["repoId"] !== "string" ||
    typeof value["repoPath"] !== "string" ||
    !isRunAction(value["action"]) ||
    typeof value["note"] !== "string" ||
    typeof value["autoLand"] !== "boolean" ||
    !finite(value["startedAt"]) ||
    !finite(value["expectedMembers"]) ||
    !Number.isInteger(value["expectedMembers"]) ||
    value["expectedMembers"] < 1 ||
    value["expectedMembers"] > GROUP_MAX ||
    !Array.isArray(value["members"]) ||
    !value["members"].every(member) ||
    value["members"].length > value["expectedMembers"] ||
    typeof value["state"] !== "string" ||
    !STATES.has(value["state"])
  )
    return false;
  const origins = value["members"].map((m) => m.origin);
  if (new Set(origins).size !== origins.length) return false;
  return (
    optional(value["minimum"], (v) => finite(v) && v >= 0 && v <= 1) &&
    optional(
      value["scores"],
      (v) => record(v) && Object.values(v).every(score),
    ) &&
    optional(
      value["review"],
      (v) =>
        record(v) &&
        typeof v["run"] === "string" &&
        (typeof v["error"] === "string" ||
          (strings(v["ranking"]) &&
            record(v["why"]) &&
            Object.values(v["why"]).every((w) => typeof w === "string"))),
    ) &&
    optional(value["reason"], (v) => typeof v === "string") &&
    optional(
      value["winner"],
      (v) => typeof v === "string" && origins.includes(v),
    ) &&
    optional(value["pickedBy"], (v) => v === "eric" || v === "reviewer") &&
    optional(value["endedAt"], finite) &&
    optional(value["pr"], (v) => v === true) &&
    optional(
      value["_dispatch"],
      (v) =>
        record(v) &&
        typeof v["winner"] === "string" &&
        v["winner"] === value["winner"] &&
        (((v["kind"] === "land" || v["kind"] === "pr") &&
          (v["status"] === "pending" || v["status"] === "done")) ||
          (v["kind"] === "wait" && v["status"] === "waiting")) &&
        optional(
          v["retry"],
          (r) =>
            record(r) &&
            (r["state"] === "red" ||
              r["state"] === "conflict" ||
              r["state"] === "moved") &&
            finite(r["updatedAt"]) &&
            finite(r["queuedAt"]) &&
            finite(r["tries"]) &&
            Number.isInteger(r["tries"]) &&
            r["tries"] >= 0,
        ),
    ) &&
    optional(
      value["keptUntil"],
      (v) =>
        record(v) &&
        Object.entries(v).every(
          ([origin, until]) => origins.includes(origin) && finite(until),
        ),
    )
  );
}
const errText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

class GroupError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export class GroupHub {
  private groups = new Map<string, StoredGroup>();
  private revisions = new Map<string, number>();
  private dispatching = new Map<string, Promise<void>>();
  private knownPrs = new Set<string>();
  private keeping = false;
  private ownership = 0;
  private serial: Promise<void> = Promise.resolve();
  private adopting: Promise<void> | null = null;
  private loops = new Map<string, Promise<void>>();
  private again = new Set<string>();
  private seenRuns = new Map<string, Run>();
  private memberRuns = new Map<string, Run>();
  private startingReview = new Map<string, Run>();
  private landing: LandingInfo | null = null;
  private merged = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: GroupDeps) {}
  private get dir(): string {
    return this.deps.dir ?? join(configDir(), "landing", "groups");
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private owns(epoch: number): boolean {
    return this.keeping && epoch === this.ownership;
  }
  private facts(): LandingInfo {
    return this.landing ?? this.deps.landingInfo();
  }
  private run(id: string): Run | undefined {
    return this.seenRuns.get(id) ?? this.deps.run(id);
  }

  /** Return copies so caller edits cannot bypass persistence or fencing. */
  info(): RunGroup[] {
    return [...this.groups.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(publicGroup);
  }
  /** A bulk request cannot stand in for choosing a member. Fail closed while
   *  group ownership is unavailable, including adoption and detach windows. */
  canBulkLand(rec: Pick<LandingRun, "id" | "repoId" | "group">): boolean {
    const group = rec.group !== undefined ? this.groups.get(rec.group) : undefined;
    return this.keeping && group !== undefined && group.state === "picked" &&
      !group.pr && group.repoId === rec.repoId && group.winner === rec.id &&
      group.members.some(member => member.origin === rec.id);
  }
  private publish(): void {
    this.deps.publish({
      type: "landing",
      landing: { ...this.facts(), groups: this.info() },
    });
  }
  private async persist(
    id: string,
    next: StoredGroup | null,
    epoch: number,
  ): Promise<void> {
    const write = this.serial.then(async () => {
      if (!this.owns(epoch)) return;
      const path = join(this.dir, `${id}.json`);
      if (next === null) {
        await rm(path, { force: true });
        return;
      }
      await mkdir(this.dir, { recursive: true });
      const tmp = `${path}.tmp-${crypto.randomUUID()}`;
      try {
        await writeFile(tmp, JSON.stringify(next, null, 2));
        if (this.owns(epoch)) await rename(tmp, path);
      } finally {
        await rm(tmp, { force: true });
      }
    });
    this.serial = write.catch(() => {});
    await write;
  }
  private async set(next: StoredGroup, epoch: number): Promise<void> {
    if (!this.owns(epoch)) return;
    if (JSON.stringify(this.groups.get(next.id)) === JSON.stringify(next))
      return;
    const previous = this.groups.get(next.id);
    this.groups.set(next.id, next);
    try {
      await this.persist(next.id, next, epoch);
    } catch (error: unknown) {
      if (this.groups.get(next.id) === next) {
        if (previous) this.groups.set(next.id, previous);
        else this.groups.delete(next.id);
      }
      throw error;
    }
    if (this.owns(epoch) && this.groups.get(next.id) === next) this.publish();
  }
  private revise(id: string): void {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
  }
  private owned(): number {
    if (!this.keeping) throw new GroupError("group owner is not active", 503);
    return this.ownership;
  }

  async create(
    input: Pick<
      RunGroup,
      | "repoId"
      | "repoPath"
      | "action"
      | "note"
      | "autoLand"
      | "startedAt"
      | "expectedMembers"
    > & { pr?: true },
  ): Promise<RunGroup> {
    const epoch = this.owned();
    if (
      !Number.isInteger(input.expectedMembers) ||
      input.expectedMembers < 1 ||
      input.expectedMembers > GROUP_MAX
    )
      throw new GroupError("invalid member count", 400);
    const group: RunGroup = {
      ...input,
      id: `g-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
      members: [],
      state: "working",
    };
    await this.set(group, epoch);
    if (!this.owns(epoch)) throw new GroupError("group owner changed", 503);
    return publicGroup(group);
  }
  async addMember(
    id: string,
    next: RunGroup["members"][number],
  ): Promise<void> {
    const epoch = this.owned();
    const group = this.groups.get(id);
    if (!group) throw new GroupError("no group by that id", 404);
    if (
      group.state !== "working" ||
      group.members.length >= group.expectedMembers ||
      group.members.some((m) => m.origin === next.origin || m.run === next.run)
    )
      throw new GroupError("group cannot take that member");
    await this.set({ ...group, members: [...group.members, next] }, epoch);
    this.kick(group.repoId);
  }
  async remove(id: string): Promise<void> {
    const epoch = this.owned();
    this.revise(id);
    this.groups.delete(id);
    await this.persist(id, null, epoch);
    if (this.owns(epoch)) this.publish();
  }

  adopt(): Promise<void> {
    if (this.keeping) return Promise.resolve();
    if (this.adopting) return this.adopting;
    const epoch = ++this.ownership;
    const adopt = async (): Promise<void> => {
      await this.serial;
      // Old effects may finish, but can no longer commit. A new owner waits so
      // gates sharing ports never overlap across detach/adopt on this hub.
      await Promise.all(this.loops.values());
      await Promise.all(this.dispatching.values());
      const names = await readdir(this.dir).catch((error: unknown) => {
        if (record(error) && error["code"] === "ENOENT") return [];
        throw error;
      });
      const restored = new Map<string, StoredGroup>();
      for (const name of names.filter((name) =>
        /^g-[a-f0-9]{8}\.json$/.test(name),
      )) {
        try {
          const value: unknown = JSON.parse(
            await readFile(join(this.dir, name), "utf8"),
          );
          if (isGroup(value) && `${value.id}.json` === name)
            restored.set(value.id, value);
        } catch {
          /* a damaged record must never schedule side effects */
        }
      }
      if (epoch !== this.ownership) return;
      this.groups = restored;
      this.revisions.clear();
      this.landing = null;
      this.memberRuns.clear();
      this.seenRuns.clear();
      this.keeping = true;
      for (const group of this.groups.values()) {
        if (
          ["working", "scoring", "reviewing"].includes(group.state) &&
          group.members.length !== group.expectedMembers
        )
          await this.set(
            { ...group, state: "needs-you", reason: "group start was cut off" },
            epoch,
          );
      }
      if (!this.owns(epoch)) return;
      this.publish();
      for (const group of this.groups.values()) this.kick(group.repoId);
      this.timer = setInterval(() => {
        void this.sweep();
      }, 30_000);
      this.timer.unref();
    };
    const pending = adopt().finally(() => {
      if (this.adopting === pending) this.adopting = null;
    });
    this.adopting = pending;
    return pending;
  }
  detach(): void {
    this.keeping = false;
    ++this.ownership;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.adopting = null;
    this.again.clear();
  }
  async idle(): Promise<void> {
    while (this.loops.size) await Promise.all(this.loops.values());
    await this.serial;
  }
  async sweep(): Promise<void> {
    for (const group of this.groups.values()) this.kick(group.repoId);
    await this.idle();
  }

  /** Ownership changes outside the runner, such as workflow gates. */
  recheck(repoId: string): void {
    this.kick(repoId);
  }

  onRun(run: Run): void {
    this.seenRuns.set(run.id, run);
    if (run.branch) this.memberRuns.set(run.branch.origin, run);
    if (this.keeping && run.branch?.state === "working") {
      for (const group of this.groups.values()) {
        if (
          !["needs-you", "scoring", "reviewing"].includes(group.state) ||
          group.members.length !== group.expectedMembers ||
          !group.members.some((m) => m.origin === run.branch?.origin)
        )
          continue;
        this.revise(group.id);
        const next = { ...group, state: "working" as const };
        delete next.scores;
        delete next._dispatch;
        delete next.review;
        delete next.reason;
        delete next.winner;
        delete next.pickedBy;
        delete next.minimum;
        this.startingReview.delete(group.id);
        void this.set(next, this.ownership).catch(() => {});
      }
    }
    this.kick(run.repoId);
  }
  onLanding(info: LandingInfo): void {
    this.landing = info;
    for (const group of this.groups.values()) this.kick(group.repoId);
  }
  onPrs(prs: PrWatch[]): void {
    this.knownPrs = new Set(prs.map((pr) => pr.id));
    this.merged = new Set(
      prs.filter((pr) => pr.state?.status === "merged").map((pr) => pr.id),
    );
    for (const group of this.groups.values()) this.kick(group.repoId);
  }

  private kick(repo: string): void {
    if (!this.keeping) return;
    if (this.loops.has(repo)) {
      this.again.add(repo);
      return;
    }
    const epoch = this.ownership;
    const loop = async (): Promise<void> => {
      do {
        this.again.delete(repo);
        for (const group of [...this.groups.values()].filter(
          (g) => g.repoId === repo,
        )) {
          if (!this.owns(epoch)) return;
          const revision = this.revisions.get(group.id) ?? 0;
          try {
            await this.advance(group.id, epoch);
          } catch (error: unknown) {
            const current = this.groups.get(group.id);
            if (
              current &&
              this.owns(epoch) &&
              (this.revisions.get(group.id) ?? 0) === revision &&
              current.state !== "landed" &&
              current.state !== "dropped"
            )
              await this.set(
                { ...current, state: "needs-you", reason: errText(error) },
                epoch,
              );
          }
        }
      } while (this.again.has(repo) && this.owns(epoch));
    };
    const pending = loop()
      .catch(() => {})
      .finally(() => {
        if (this.loops.get(repo) === pending) this.loops.delete(repo);
        if (this.again.has(repo)) this.kick(repo);
      });
    this.loops.set(repo, pending);
  }
  private memberScore(m: RunGroup["members"][number]): MemberScore {
    const rec = this.facts().runs.find((rec) => rec.id === m.origin);
    const run = this.memberRuns.get(m.origin) ?? this.run(rec?.runId ?? m.run);
    const branch = run?.branch;
    const state =
      run?.status === "failed" || run?.status === "limited"
        ? "failed"
        : (branch?.state ??
          rec?.state ??
          (run && isRunActive(run) ? "working" : "stopped"));
    return {
      branch: branch?.name ?? rec?.branch ?? m.origin,
      base: branch?.base ?? rec?.base ?? "",
      state,
      ...(rec?.review ? { verdict: rec.review.verdict } : {}),
      ...(run?.result
        ? {
            cost: {
              usd: run.result.costUsd ?? 0,
              tokens: run.result.tokens?.total ?? 0,
            },
          }
        : {}),
    };
  }
  private green(group: RunGroup): string[] {
    return group.members
      .filter(
        (m) =>
          pickWinner(
            group,
            [group.scores?.[m.origin]?.branch ?? ""],
            group.minimum ?? 1,
          ) === m.origin,
      )
      .map((m) => m.origin);
  }
  private current(
    id: string,
    epoch: number,
    state: RunGroup["state"],
  ): StoredGroup | undefined {
    const group = this.groups.get(id);
    return this.owns(epoch) && group?.state === state ? group : undefined;
  }

  private async advance(id: string, epoch: number): Promise<void> {
    let group = this.groups.get(id);
    if (!group) return;
    if (group.state === "landed" || group.state === "dropped") {
      await this.cleanup(group, epoch);
      return;
    }
    if (group.state === "picked") {
      const entry = this.facts().entries.find((e) => e.id === group?.winner);
      const retry =
        (group._dispatch?.status === "pending" ||
          group._dispatch?.kind === "wait") &&
        group._dispatch.retry?.state === entry?.state &&
        group._dispatch.retry?.updatedAt === entry?.updatedAt &&
        group._dispatch.retry?.queuedAt === entry?.queuedAt &&
        group._dispatch.retry?.tries === entry?.tries;
      if (
        (!group.pr && entry?.state === "landed") ||
        (group.pr && group.winner && this.merged.has(group.winner))
      )
        await this.finish(group, epoch);
      else if (entry && sentBack(entry) && !retry)
        await this.set(
          {
            ...group,
            state: "needs-you",
            reason: entry.reason ?? `winner came back: ${entry.state}`,
          },
          epoch,
        );
      if (this.current(id, epoch, "picked")) {
        if (!group._dispatch) {
          const intent = this.intentFor(group);
          if (intent) {
            await this.set({ ...group, _dispatch: intent }, epoch);
            group = this.groups.get(id);
          }
        }
        if (group) await this.dispatch(group, epoch);
      }
      return;
    }
    if (group.state === "working") {
      if (group.members.length !== group.expectedMembers) return;
      const scores = Object.fromEntries(
        group.members.map((m) => [m.origin, this.memberScore(m)]),
      );
      await this.set(settleGroup(group, scores), epoch);
      group = this.groups.get(id);
    }
    if (!group || !this.owns(epoch)) return;
    if (group.state === "scoring") {
      for (const m of group.members) {
        group = this.current(id, epoch, "scoring");
        if (!group) return;
        const prior = group.scores?.[m.origin];
        if (prior?.state !== "ready" || prior.gates) continue;
        const dry = await this.deps.dryGates(m.origin);
        group = this.current(id, epoch, "scoring");
        if (!group) return;
        const result: MemberScore = {
          ...prior,
          branch: dry.branch,
          base: dry.base,
          gates: dry.gates,
          ...(dry.scenarios ? { scenarios: dry.scenarios } : {}),
        };
        const rec = this.facts().runs.find((rec) => rec.id === m.origin);
        if (rec) {
          const stat = await git(
            rec.repoPath,
            ["diff", "--shortstat", `${dry.base}...${dry.head}`, "--"],
            10_000,
          );
          if (stat.code === 0)
            result.diffstat = {
              files: Number(
                stat.stdout.match(/(\d+) files? changed/)?.[1] ?? 0,
              ),
              added: Number(stat.stdout.match(/(\d+) insertions?/)?.[1] ?? 0),
              removed: Number(stat.stdout.match(/(\d+) deletions?/)?.[1] ?? 0),
            };
        }
        group = this.current(id, epoch, "scoring");
        if (!group) return;
        await this.set(
          {
            ...group,
            minimum: group.minimum ?? dry.minimum,
            scores: { ...group.scores, [m.origin]: result },
          },
          epoch,
        );
      }
      group = this.current(id, epoch, "scoring");
      if (!group) return;
      const green = this.green(group);
      if (green.length === 0) {
        await this.set(
          {
            ...group,
            state: "needs-you",
            reason: "no member passed the gates",
          },
          epoch,
        );
        return;
      }
      if (green.length === 1 && green[0]) {
        await this.pick(group, green[0], "reviewer", epoch);
        return;
      }
      await this.set({ ...group, state: "reviewing" }, epoch);
    }
    group = this.current(id, epoch, "reviewing");
    if (!group) return;
    let review = group.review
      ? this.run(group.review.run)
      : this.startingReview.get(id);
    if (!review) {
      if (
        this.deps.activeFor(group.repoId) ||
        this.deps.checkoutBusy?.(group.repoId)
      )
        return;
      const dry: Record<string, GroupDry> = {};
      for (const m of group.members) {
        const s = group.scores?.[m.origin];
        if (!s?.gates) continue;
        dry[m.origin] = {
          branch: s.branch,
          base: s.base,
          head:
            this.facts().runs.find((r) => r.id === m.origin)?.dry?.head ??
            this.facts().runs.find((r) => r.id === m.origin)?.review?.head ??
            "",
          gates: s.gates,
          ...(s.scenarios ? { scenarios: s.scenarios } : {}),
          minimum: group.minimum ?? 1,
        };
      }
      const reviewGroup = group;
      const revision = this.revisions.get(id) ?? 0;
      const current = (): boolean =>
        this.current(id, epoch, "reviewing") === reviewGroup &&
        (this.revisions.get(id) ?? 0) === revision;
      try {
        const started = await this.deps.startReviewer(
          structuredClone(group),
          comparePrompt(group, dry),
          current,
        );
        if (!started) return;
        review = started;
      } catch (error: unknown) {
        // A checkout owner may arrive during the server's async preflight.
        // Its next run/flow event wakes this review; real failures still surface.
        if (
          this.current(id, epoch, "reviewing") === reviewGroup &&
          (this.deps.activeFor(group.repoId) ||
            this.deps.checkoutBusy?.(group.repoId))
        )
          return;
        throw error;
      }
      if (!current()) {
        await this.cancelReview(id, review.id);
        return;
      }
      this.startingReview.set(id, review);
      const attached: StoredGroup = {
        ...reviewGroup,
        review: { run: review.id, ranking: [], why: {} },
      };
      try {
        await this.set(attached, epoch);
      } catch (error: unknown) {
        await this.cancelReview(id, review.id);
        throw error;
      }
      if (
        !this.owns(epoch) ||
        this.groups.get(id) !== attached ||
        (this.revisions.get(id) ?? 0) !== revision
      ) {
        await this.cancelReview(id, review.id);
        return;
      }
    } else if (!group.review) {
      await this.set(
        { ...group, review: { run: review.id, ranking: [], why: {} } },
        epoch,
      );
    }
    group = this.current(id, epoch, "reviewing");
    if (!group || isRunActive(review)) return;
    const branches = group.members.map(
      (m) => group?.scores?.[m.origin]?.branch ?? m.origin,
    );
    const green = this.green(group).map(
      (origin) => group?.scores?.[origin]?.branch ?? origin,
    );
    const parsed = parseCompare(
      review.result?.text ?? review.error ?? "",
      branches,
      green,
    );
    if (!parsed.ok) {
      await this.set(
        {
          ...group,
          state: "needs-you",
          review: { run: review.id, error: parsed.error },
          reason: parsed.closing || parsed.error,
        },
        epoch,
      );
      return;
    }
    const winner = pickWinner(group, parsed.ranking, group.minimum ?? 1);
    await this.set(
      {
        ...group,
        review: { run: review.id, ranking: parsed.ranking, why: parsed.why },
      },
      epoch,
    );
    group = this.current(id, epoch, "reviewing");
    if (!group) return;
    if (winner) await this.pick(group, winner, "reviewer", epoch);
    else
      await this.set(
        { ...group, state: "needs-you", reason: "no member passed the gates" },
        epoch,
      );
  }
  private async cancelReview(groupId: string, runId: string): Promise<void> {
    if (this.startingReview.get(groupId)?.id === runId)
      this.startingReview.delete(groupId);
    await this.deps.stopReviewer(runId);
  }

  private intentFor(group: RunGroup): DispatchIntent | undefined {
    if (!group.winner) return;
    if (group.pr)
      return { winner: group.winner, kind: "pr", status: "pending" };
    const entry = this.facts().entries.find((e) => e.id === group.winner);
    const retry =
      entry &&
      (entry.state === "red" ||
        entry.state === "conflict" ||
        entry.state === "moved")
        ? {
            state: entry.state,
            queuedAt: entry.queuedAt,
            updatedAt: entry.updatedAt,
            tries: entry.tries,
          }
        : undefined;
    if (
      group.autoLand &&
      this.facts().runs.find((r) => r.id === group.winner)?.review?.verdict ===
        "auto"
    )
      return {
        winner: group.winner,
        kind: "land",
        status: "pending",
        ...(retry ? { retry } : {}),
      };
    // A new manual selection can acknowledge a repaired branch's old failure,
    // while a later queue attempt/failure must still bring it back to needs-you.
    if (retry)
      return { winner: group.winner, kind: "wait", status: "waiting", retry };
  }
  private externalWork(origin: string): boolean {
    return (
      this.knownPrs.has(origin) ||
      this.facts().runs.some((r) => r.id === origin && r.pr !== undefined) ||
      this.facts().entries.some(
        (e) => e.id === origin && (inQueue(e) || e.state === "landed"),
      )
    );
  }
  private unsafeOverride(group: StoredGroup): boolean {
    return (
      this.dispatching.has(group.id) ||
      group._dispatch?.status === "done" ||
      (!!group.winner &&
        (this.externalWork(group.winner) ||
          this.facts().entries.some(
            (e) => e.id === group.winner && sentBack(e),
          )))
    );
  }
  private async pick(
    group: StoredGroup,
    winner: string,
    pickedBy: "reviewer" | "eric",
    epoch: number,
  ): Promise<void> {
    if (
      group.winner !== undefined &&
      group.winner !== winner &&
      (pickedBy !== "eric" || this.unsafeOverride(group))
    )
      throw new GroupError("the winner has already been dispatched");
    this.revise(group.id);
    const next: StoredGroup = { ...group, state: "picked", winner, pickedBy };
    delete next.reason;
    if (group.winner !== winner) delete next._dispatch;
    next._dispatch ??= this.intentFor(next);
    await this.set(next, epoch);
    const selected = this.current(group.id, epoch, "picked");
    if (
      !selected ||
      selected.winner !== winner ||
      selected.pickedBy !== pickedBy
    )
      return;
    await this.dispatch(selected, epoch);
  }
  /** The pending journal entry precedes the effect. Reconcile existing queue/PR
   * facts before retrying after an ownership change or process restart. */
  private async dispatch(group: StoredGroup, epoch: number): Promise<void> {
    const intent = group._dispatch;
    if (
      group.state !== "picked" ||
      !intent ||
      intent.kind === "wait" ||
      intent.status === "done"
    )
      return;
    const active = this.dispatching.get(group.id);
    if (active) {
      await active;
      return;
    }
    const current = (): StoredGroup | undefined => {
      const latest = this.current(group.id, epoch, "picked");
      return latest?._dispatch === intent ? latest : undefined;
    };
    const apply = async (): Promise<void> => {
      const selected = current();
      if (!selected) return;
      if (this.externalWork(intent.winner)) {
        await this.set(
          { ...selected, _dispatch: { ...intent, status: "done" } },
          epoch,
        );
        return;
      }
      const winner = selected.members.find((m) => m.origin === intent.winner);
      if (!winner || this.memberScore(winner).state !== "ready") return;
      if (
        intent.kind === "land" &&
        (selected.pr ||
          !selected.autoLand ||
          this.facts().runs.find((r) => r.id === intent.winner)?.review
            ?.verdict !== "auto")
      )
        return;
      if (intent.kind === "pr" && !selected.pr) return;
      try {
        if (intent.kind === "pr") await this.deps.openPr(intent.winner);
        else await this.deps.land(intent.winner);
      } catch (error: unknown) {
        const latest = current();
        if (latest)
          await this.set(
            { ...latest, state: "needs-you", reason: errText(error) },
            epoch,
          );
        return;
      }
      const latest = current();
      if (latest)
        await this.set(
          { ...latest, _dispatch: { ...intent, status: "done" } },
          epoch,
        );
    };
    // Install the in-flight fence before calling a port which may publish or
    // synchronously re-enter a group route.
    const pending = Promise.resolve()
      .then(apply)
      .finally(() => {
        if (this.dispatching.get(group.id) === pending)
          this.dispatching.delete(group.id);
      });
    this.dispatching.set(group.id, pending);
    await pending;
  }
  private async finish(group: StoredGroup, epoch: number): Promise<void> {
    const next: StoredGroup = {
      ...group,
      state: "landed",
      endedAt: this.now(),
      keptUntil: Object.fromEntries(
        group.members
          .filter((m) => m.origin !== group.winner)
          .map((m) => [m.origin, group.keptUntil?.[m.origin] ?? this.now()]),
      ),
    };
    await this.set(next, epoch);
    // cleanup is executed by the repo loop, so a synchronous landing publish
    // and repeated PR snapshots cannot start duplicate removals.
    this.kick(group.repoId);
  }
  private async cleanup(group: StoredGroup, epoch: number): Promise<void> {
    for (const [origin, until] of Object.entries(group.keptUntil ?? {})) {
      if (!this.owns(epoch) || until > this.now()) continue;
      const current = this.groups.get(group.id);
      if (!current || current.keptUntil?.[origin] !== until) continue;
      if (this.facts().runs.some((r) => r.id === origin)) {
        try {
          await this.deps.dropMember(
            origin,
            current.state === "landed" ? "another member won" : "group dropped",
          );
        } catch {
          continue; /* retain the durable cleanup request for the next sweep */
        }
      }
      if (!this.owns(epoch)) return;
      const latest = this.groups.get(group.id);
      if (!latest) return;
      const keptUntil = { ...latest.keptUntil };
      delete keptUntil[origin];
      await this.set({ ...latest, keptUntil }, epoch);
    }
  }

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/groups" && !path.startsWith("/api/groups/")) return null;
    if (req.method === "GET" && path === "/api/groups")
      return json(this.info());
    if (
      req.method !== "POST" ||
      !["/api/groups/pick", "/api/groups/review", "/api/groups/drop"].includes(
        path,
      )
    )
      return json({ error: "not found" }, 404);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!record(body) || typeof body["group"] !== "string" || !body["group"])
      return json({ error: "group is required" }, 400);
    const group = this.groups.get(body["group"]);
    if (!group) return json({ error: "no group by that id" }, 404);
    const resolve = (id: string) =>
      group.members.find((m) => m.origin === id || m.run === id);
    try {
      const epoch = this.owned();
      if (path === "/api/groups/pick") {
        if (typeof body["run"] !== "string")
          return json({ error: "run is required" }, 400);
        const m = resolve(body["run"]);
        if (!m) return json({ error: "run is outside the group" }, 400);
        if (
          ["working", "scoring", "landed", "dropped"].includes(group.state) ||
          !this.green(group).includes(m.origin) ||
          this.memberScore(m).state !== "ready"
        )
          throw new GroupError("only a green ready member may be picked");
        await this.pick(group, m.origin, "eric", epoch);
      } else if (path === "/api/groups/review") {
        if (
          ["working", "scoring", "landed", "dropped", "picked"].includes(
            group.state,
          ) ||
          !this.green(group).length
        )
          throw new GroupError("group is not ready to review");
        if (group.state !== "reviewing") {
          this.revise(group.id);
          const next: StoredGroup = { ...group, state: "reviewing" };
          delete next._dispatch;
          delete next.review;
          delete next.reason;
          this.startingReview.delete(group.id);
          await this.set(next, epoch);
        }
        this.kick(group.repoId);
      } else {
        if (!optional(body["keep"], strings))
          return json({ error: "keep must be a list of member ids" }, 400);
        const keep = strings(body["keep"]) ? body["keep"] : [];
        if (keep.some((id) => !resolve(id)))
          return json({ error: "keep names a member outside the group" }, 400);
        if (group.state !== "dropped" && group.state !== "landed") {
          this.revise(group.id);
          const kept = new Set(keep.map((id) => resolve(id)?.origin));
          await this.set(
            {
              ...group,
              state: "dropped",
              endedAt: this.now(),
              keptUntil: Object.fromEntries(
                group.members.map((m) => [
                  m.origin,
                  this.now() + (kept.has(m.origin) ? LOSER_KEEP : 0),
                ]),
              ),
            },
            epoch,
          );
        }
        this.kick(group.repoId);
        await this.idle();
      }
      const current = this.groups.get(group.id);
      return json(current ? publicGroup(current) : undefined);
    } catch (error: unknown) {
      return json(
        { error: errText(error) },
        error instanceof GroupError ? error.status : 500,
      );
    }
  }
}
