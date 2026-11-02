/** The PR watch's pre-merge scenario pass (FR-032 plan 3). When auto-merge
 *  would merge a head that `screen` let go, the repo's holdout scenarios run
 *  in the PR's worktree on that head first, as the landing queue runs them
 *  after its gates.
 *
 *  The pass runs off the hub's serial queue, since a set may take up to
 *  MAX_TIMEOUT seconds and every read, toggle and close waits on that
 *  queue. Meanwhile the watch carries `checking`, which `readyToMerge`
 *  waits on, and the pass's end comes back to the hub through `ended`, on
 *  its queue. The pass is kept by head on the watch (`PrWatch.scenarios`),
 *  so the set runs once per pushed head however often the PR is read. A red
 *  command scenario, a judge that could not answer or a score under the
 *  repo's minimum sets `approve` and leaves the merge to Eric. Nothing
 *  starts a fix: the agent cannot see what it would fix against. Bun-only. */

import { failPass, holdPass, PASS_FAILED, scenarioHold, settlePass } from "../core/prscenarios";
import type { ScenarioSet, ScenarioSettings } from "../core/scenario";
import type { EvidenceFile, PrState, PrWatch } from "../core/types";
import { readScenarioSet, readScenarioSettings, runScenarioSet, scenariosRoot, setDirOf, type ScenarioJudge, type ScenarioRunner } from "./scenarios";

export interface PrScenarioDeps {
  /** where the sets live; `scenariosRoot()` unless a test says otherwise */
  root?: string;
  /** runs one scenario line (`runScenario`) */
  run: ScenarioRunner;
  /** the judge for judge scenarios, or null with no gateway key */
  judge: ScenarioJudge | null;
  evidence?: (dir: string, paths: string[]) => Promise<EvidenceFile[]>;
}

/** what a pass's end does to the watch as it is then */
export type PassChange = (w: PrWatch) => PrWatch;

const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);

export class PrScenarios {
  /** the pass going per watch id */
  private going = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: () => PrScenarioDeps,
    private readonly now: () => number,
    /** applies a pass's end to the watch on the hub's queue; resolves once applied */
    private readonly ended: (id: string, change: PassChange) => Promise<void>,
  ) {}

  /** What the set says about the head auto-merge would merge next. The
   *  watch as it is when the head may go: the repo has no set, or a pass
   *  on this head passed. With `approve` when a pass on this head held it
   *  or the set cannot run, and with `checking` while a pass goes, which
   *  this starts when the head has none yet. */
  async gate(w: PrWatch, s: PrState): Promise<PrWatch> {
    const head = s.head;
    // a pass still going, on this head or one the PR has moved past: the
    // merge waits for it to end, and the next read starts the next one
    if (this.going.has(w.id)) return { ...w, checking: { head, since: w.checking?.since ?? this.now() } };
    // a mark no pass stands behind (one a restart ended) holds nothing
    const { checking: _c, ...base } = w;
    const d = this.deps();
    const root = d.root ?? scenariosRoot();
    let set: ScenarioSet;
    try {
      set = await readScenarioSet(root, w.repoPath);
    } catch (err) {
      // the error names the set's folder, which no watch shows
      console.error(`prs: reading the scenarios for ${w.repoPath}: ${errText(err)}`);
      return failPass(base, head);
    }
    if (set.scenarios.length === 0 && set.errors.length === 0) return base;
    let settings: ScenarioSettings;
    try {
      settings = await readScenarioSettings(w.repoPath);
    } catch (err) {
      // a broken .canopy/scenarios.json is the repo's own file and may be named
      return failPass(base, head, `${PASS_FAILED}: ${errText(err)}`);
    }
    if (base.scenarios?.head === head) return holdPass(base, head, scenarioHold(base.scenarios, settings.minimum));
    const minimum = settings.minimum;
    const pass: Promise<void> = runScenarioSet({
      dir: w.dir,
      setDir: setDirOf(root, w.repoPath),
      set,
      settings,
      run: d.run,
      judge: d.judge,
      ...(d.evidence ? { evidence: d.evidence } : {}),
      head,
      now: this.now(),
    })
      .then(
        (run): PassChange => (cur) => settlePass(cur, head, run, minimum),
        (err: unknown): PassChange => {
          console.error(`prs: the scenarios for ${w.branch} could not run: ${errText(err)}`);
          return (cur) => failPass(cur, head);
        },
      )
      .then((change) =>
        this.ended(w.id, (cur) => {
          // let go inside the hub's queue, so no read between the end and
          // the result on the watch starts the same pass again
          this.release(w.id, pass);
          return change(cur);
        }),
      )
      .catch((err: unknown) => console.error(`prs: keeping the scenario pass for ${w.branch}: ${errText(err)}`))
      .finally(() => this.release(w.id, pass));
    this.going.set(w.id, pass);
    return { ...base, checking: { head, since: this.now() } };
  }

  private release(id: string, pass: Promise<void>): void {
    if (this.going.get(id) === pass) this.going.delete(id);
  }

  /** Resolves once every pass going has ended and its end is applied. */
  async idle(): Promise<void> {
    while (this.going.size > 0) await Promise.all(this.going.values());
  }
}
