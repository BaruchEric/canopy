/** Live collision warnings (FR-040): the touched sets per live run, the
 *  pairs currently overlapping, and which chats have heard them. This is
 *  memory only; it writes nothing to disk and never holds a run. */

import { inQueue, sentBack, stoppedWhole } from "../core/landing";
import { ago } from "../core/treelines";
import { isRunActive, type LandEntry, type LandingInfo, type LandNotice, type LandingRun, type Repo, type Run } from "../core/types";
import { addStep, childrenSay, collide, collisionLine, collisionNotice, collisionSay, flipped, fromFiles, fromStatus, touchedOf, type Collision, type Side, type Touched } from "../core/touch";

export interface CollisionDeps {
  /** this backend's live runs */
  runs: () => Run[];
  /** the scan's repo by id, for its checkout's uncommitted files */
  repo: (id: string) => Repo | undefined;
  /** the queue: queued and ready branches' sorted files */
  landing: () => LandingInfo;
  /** `Runner.note` */
  note: (id: string, text: string) => void;
  /** `Runner.say`; throws when the chat is not idle */
  say: (id: string, text: string) => void;
  /** `LandingHub.notice` */
  notify: (n: Omit<LandNotice, "id" | "at">) => void;
  /** `LandingHub.republish` */
  publish: () => void;
  /** saves a live run/branch overlap on its branch record, without publishing */
  rememberOverlap?: (origin: string, overlap: NonNullable<LandingRun["overlap"]>) => void;
  /** whether the chat's say is off for a repo (`RepoAgent.collisionSay`) */
  sayOff?: (repoPath: string) => boolean | Promise<boolean>;
  /** FR-033 wires this as `(run) => run.group`: members of one group never collide */
  groupOf?: (run: Run) => string | undefined;
  now?: () => number;
}

interface PendingSay {
  run: string;
  pair: string;
  text: string;
}

const relevantEntry = (entry: LandEntry | undefined): boolean => {
  if (!entry) return true;
  // `judge` is the scenario queue's held state in the parallel scenario work.
  // Keep it eligible even when this checkout's LandState union predates it.
  return inQueue(entry) || sentBack(entry) || String(entry.state) === "judge";
};

const sayKey = (run: string, pair: string): string => `${run}\0${pair}`;

export class CollisionHub {
  private touched = new Map<string, Touched>();
  private stepIds = new Map<string, Set<string>>();
  private collisions: Collision[] = [];
  private saidAt = new Map<string, number>();
  private said = new Set<string>();
  private pending = new Map<string, PendingSay>();
  private sending = new Set<string>();

  constructor(private deps: CollisionDeps) {}

  /** the live collisions, newest first */
  list(): Collision[] {
    return [...this.collisions].sort((a, b) => b.at - a.at);
  }

  /** the sets of a repo's live runs (the queue's mark; FR-033's compare sheet) */
  working(repoId: string): Touched[] {
    return this.activeRuns()
      .filter((run) => run.repoId === repoId)
      .map((run) => this.touchRun(run));
  }

  /** a run changed: first sight builds its set from every step, later ones add the
   *  new steps (by step id); an ended run's set and pairs go */
  onRun(run: Run): void {
    const before = JSON.stringify(this.collisions);
    if (!isRunActive(run)) {
      this.touched.delete(run.id);
      this.stepIds.delete(run.id);
      this.prune();
      this.pruneMessages();
      if (before !== JSON.stringify(this.collisions)) this.deps.publish();
      return;
    }

    const touched = this.touchRun(run);
    const active = this.activeRuns();
    if (!active.some((current) => current.id === run.id)) active.push(run);
    const previous = this.collisions;
    const result = collide(previous, touched, this.sides(run, active, this.deps.landing()), run.repoId, this.now(), this.saidAt);
    this.collisions = result.live;
    this.rememberChanged(previous, result.live, active);
    this.process(result.fresh, result.grown, active);
    this.pruneMessages();
    if (run.chat && run.status === "idle") this.flush(run.id);
    if (before !== JSON.stringify(this.collisions)) this.deps.publish();
  }

  /** a repo's status changed: its uncommitted files against its live branch runs */
  onRepo(repo: Repo): void {
    const before = JSON.stringify(this.collisions);
    const checkout: Side = { touched: fromStatus(repo.status?.files ?? []), with: { kind: "checkout" } };
    const active = this.activeRuns();
    for (const run of active) {
      if (run.repoId !== repo.id || !run.branch) continue;
      const touched = this.touchRun(run);
      const id = `${run.id}+checkout`;
      const prior = this.collisions.filter((collision) => collision.id === id);
      const result = collide(prior, touched, [checkout], repo.id, this.now(), this.saidAt);
      this.collisions = [...this.collisions.filter((collision) => collision.id !== id), ...result.live];
      this.rememberChanged(prior, result.live, active);
      this.process(result.fresh, result.grown, active);
    }
    this.pruneMessages();
    if (before !== JSON.stringify(this.collisions)) this.deps.publish();
  }

  /** the queue changed: prune departed branches and compare newly ready ones */
  onLanding(info: LandingInfo): void {
    const before = JSON.stringify(this.collisions);
    this.prune(info);
    const active = this.activeRuns();
    for (const run of active) {
      const touched = this.touchRun(run);
      const previous = this.collisions;
      const result = collide(previous, touched, this.sides(run, active, info), run.repoId, this.now(), this.saidAt);
      this.collisions = result.live;
      this.rememberChanged(previous, result.live, active);
      this.process(result.fresh, result.grown, active);
    }
    this.prune(info);
    this.pruneMessages();
    if (before !== JSON.stringify(this.collisions)) this.deps.publish();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private activeRuns(): Run[] {
    return this.deps.runs().filter(isRunActive);
  }

  private touchRun(run: Run): Touched {
    const group = this.deps.groupOf?.(run);
    let touched = this.touched.get(run.id);
    if (!touched) {
      touched = touchedOf(run, group);
      this.touched.set(run.id, touched);
      this.stepIds.set(run.id, new Set(run.steps.map((step) => step.id)));
      return touched;
    }

    if (group === undefined) delete touched.group;
    else touched.group = group;
    const ids = this.stepIds.get(run.id) ?? new Set<string>();
    for (const step of run.steps) {
      if (ids.has(step.id)) continue;
      addStep(touched, step);
      ids.add(step.id);
    }
    this.stepIds.set(run.id, ids);
    return touched;
  }

  private sides(run: Run, active: readonly Run[], landing: LandingInfo): Side[] {
    const sides: Side[] = [];
    for (const other of active) {
      if (other.id === run.id || other.repoId !== run.repoId) continue;
      const touched = this.touchRun(other);
      sides.push({ touched, with: { kind: "run", run: other.id, verb: other.verb, name: touched.name } });
    }

    const liveIds = new Set(active.map((live) => live.id));
    const entries = new Map(landing.entries.map((entry) => [entry.id, entry]));
    for (const record of landing.runs) {
      if (record.repoId !== run.repoId || record.id === run.branch?.origin || liveIds.has(record.runId)) continue;
      if (record.state !== "ready" && !stoppedWhole(record)) continue;
      if (!relevantEntry(entries.get(record.id))) continue;
      sides.push({
        touched: fromFiles(record.runId, record.id, record.branch, record.review?.files ?? []),
        with: { kind: "branch", origin: record.id, branch: record.branch },
      });
    }

    if (run.branch) {
      sides.push({ touched: fromStatus(this.deps.repo(run.repoId)?.status?.files ?? []), with: { kind: "checkout" } });
    }
    return sides;
  }

  private branchStillPresent(collision: Collision, info: LandingInfo, liveIds: ReadonlySet<string>): boolean {
    const other = collision.with;
    if (other.kind !== "branch") return true;
    const record = info.runs.find((candidate) => candidate.id === other.origin && candidate.repoId === collision.repoId);
    if (!record || (record.state !== "ready" && !stoppedWhole(record)) || liveIds.has(record.runId)) return false;
    return relevantEntry(info.entries.find((entry) => entry.id === record.id));
  }

  private prune(info = this.deps.landing()): void {
    const activeIds = new Set(this.activeRuns().map((run) => run.id));
    this.collisions = this.collisions.filter((collision) =>
      activeIds.has(collision.run) &&
      (collision.with.kind !== "run" || activeIds.has(collision.with.run)) &&
      this.branchStillPresent(collision, info, activeIds),
    );
    const ids = new Set(this.collisions.map((collision) => collision.id));
    for (const id of this.saidAt.keys()) if (!ids.has(id)) this.saidAt.delete(id);
  }

  private pruneMessages(): void {
    const ids = new Set(this.collisions.map((collision) => collision.id));
    for (const [key, pending] of this.pending) {
      if (!ids.has(pending.pair)) this.pending.delete(key);
    }
    for (const key of this.said) {
      const pair = key.slice(key.indexOf("\0") + 1);
      if (!ids.has(pair)) this.said.delete(key);
    }
  }

  private process(fresh: readonly Collision[], grown: readonly Collision[], active: readonly Run[]): void {
    const freshIds = new Set(fresh.map((collision) => collision.id));
    for (const collision of [...fresh, ...grown]) {
      this.saidAt.set(collision.id, collision.paths.length);
      this.noteSides(collision, active);
      if (freshIds.has(collision.id)) {
        const touching = active.find((run) => run.id === collision.run);
        if (touching) {
          this.deps.notify({
            entry: touching.branch?.origin ?? touching.id,
            repoId: touching.repoId,
            branch: touching.branch?.name ?? collision.name,
            note: touching.note,
            kind: "collision",
            why: collisionNotice(collision),
          });
        }
        this.saySides(collision, active);
      }
    }
  }

  /** Persist every changed path set, including growth too small to resay. */
  private rememberChanged(previous: readonly Collision[], current: readonly Collision[], active: readonly Run[]): void {
    const before = new Map(previous.map((collision) => [collision.id, JSON.stringify({ with: collision.with, paths: collision.paths })]));
    for (const collision of current) {
      if (before.get(collision.id) === JSON.stringify({ with: collision.with, paths: collision.paths })) continue;
      this.rememberOverlap(collision, active);
    }
  }

  /** Retains only overlaps with observed runs or branches; checkout status is
   *  transient and must never become a historical branch warning. */
  private rememberOverlap(collision: Collision, active: readonly Run[]): void {
    if (!this.deps.rememberOverlap || collision.with.kind === "checkout") return;
    const first = active.find((run) => run.id === collision.run);
    if (!first) return;
    const paths = [...collision.paths];
    if (first.branch) {
      const withName = collision.with.kind === "run" ? collision.with.name : collision.with.branch;
      this.deps.rememberOverlap(first.branch.origin, { with: withName, paths });
    }
    const other = collision.with;
    if (other.kind === "run") {
      const second = active.find((run) => run.id === other.run);
      if (second?.branch) {
        this.deps.rememberOverlap(second.branch.origin, { with: first.branch?.name ?? collision.name, paths });
      }
      return;
    }
    if (other.kind === "branch") {
      this.deps.rememberOverlap(other.origin, { with: first.branch?.name ?? collision.name, paths });
    }
  }

  private noteSides(collision: Collision, active: readonly Run[]): void {
    const first = active.find((run) => run.id === collision.run);
    if (first) this.deps.note(first.id, collisionLine(collision));
    const other = collision.with;
    if (other.kind === "run") {
      const second = active.find((run) => run.id === other.run);
      if (second && first) this.deps.note(second.id, collisionLine(flipped(collision, first.verb)));
    }
  }

  private saySides(collision: Collision, active: readonly Run[]): void {
    const first = active.find((run) => run.id === collision.run);
    const otherSide = collision.with;
    if (first?.chat) {
      const other = otherSide.kind === "run" ? active.find((run) => run.id === otherSide.run) : undefined;
      const when = other ? ago(other.startedAt / 1000, this.now()) || "0m" : "";
      this.queueSay(first, collision, collisionSay(collision, when));
    }

    if (otherSide.kind !== "run") return;
    const second = active.find((run) => run.id === otherSide.run);
    if (second?.chat && first) {
      const view = flipped(collision, first.verb);
      const when = ago(first.startedAt / 1000, this.now()) || "0m";
      this.queueSay(second, collision, collisionSay(view, when));
    }

    if (first?.parent && first.parent === second?.parent) {
      const parent = active.find((run) => run.id === first.parent && run.chat);
      if (parent) this.queueSay(parent, collision, childrenSay(collision.name, otherSide.name, collision.paths));
    }
  }

  private queueSay(run: Run, collision: Collision, text: string): void {
    const key = sayKey(run.id, collision.id);
    if (this.said.has(key) || this.pending.has(key)) return;
    this.pending.set(key, { run: run.id, pair: collision.id, text });
    this.flush(run.id);
  }

  private flush(runId: string): void {
    for (const [key, pending] of this.pending) {
      if (pending.run === runId) void this.trySay(key);
    }
  }

  private async trySay(key: string): Promise<void> {
    if (this.sending.has(key)) return;
    const pending = this.pending.get(key);
    if (!pending) return;
    const currentRun = (): Run | undefined => this.activeRuns().find((run) => run.id === pending.run);
    const currentCollision = (): Collision | undefined => this.collisions.find((collision) => collision.id === pending.pair);
    const run = currentRun();
    if (!run?.chat || !currentCollision()) {
      this.pending.delete(key);
      return;
    }
    if (run.status !== "idle") return;

    this.sending.add(key);
    try {
      const repo = this.deps.repo(run.repoId);
      const off = repo ? await (this.deps.sayOff?.(repo.path) ?? false) : false;
      if (this.pending.get(key) !== pending || !currentCollision()) return;
      if (off) {
        this.said.add(key);
        this.pending.delete(key);
        return;
      }
      const latest = currentRun();
      if (!latest?.chat || latest.status !== "idle") return;
      this.deps.say(latest.id, pending.text);
      this.said.add(key);
      this.pending.delete(key);
    } catch {
      // a chat which started replying, or rejected a say, retries at its next idle change
    } finally {
      this.sending.delete(key);
    }
  }
}
