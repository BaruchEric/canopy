# Incubator phase 3: scout, build-new and Vercel. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a clarified sprout goes on to research and an eval, a `new` pick is built, tested and accepted by agents, and canopy itself creates the private GitHub repo, pushes it and deploys it to Vercel. The result is a live URL on the sprout, in its vault note and in the daily note.

**Architecture:** two new bundled workflows, `scout` (Research, Eval) and `build-new` (Scaffold, Test, Accept). Each is a straight line run by the existing `Flows`, the same way clarify runs. The Incubator reads `pick.json` after scout and checks it in code (`parsePick`, `pickRefusal`, `phaseRefusal`). After `build-new` it runs `ship`, which is canopy's own code and not an agent step: `deployReady`, `gh repo create --private`, a push with hooks off, `vercel link`, `vercel deploy --prod`, then a production-URL smoke GET. No agent ever holds `git push`, `gh repo create` or a Vercel permission.

**Tech Stack:** Bun + TypeScript (strict), `bun:test`, the `gh` and `vercel` CLIs on the backend, the Vercel REST API (`GET /v9/projects/:name`, `POST /v11/projects`, `GET /v13/deployments/:id`) for the project and the deployment's aliases.

**Spec:** `docs/superpowers/specs/2026-10-01-incubator-design.md` (phases, the chain table, allowlists, hard limits, credentials, errors). Amendment 1 there covers phase 2. Task 13 of this plan adds amendment 2, which holds the rulings below.

## Rulings this plan makes (they become spec amendment 2)

1. **Deploy is canopy's code, not an agent step.** The spec's `build-new` ends in deploy and file steps whose allowlist holds `git-push` and `vercel deploy`. Here `build-new` stops at Accept, and the Incubator's `ship` does the rest in code. Under the spec's plan, an agent with `Bash(git push:*)` could push to any repo `GH_TOKEN` can write to, and one with `Bash(vercel deploy:*)` holds the Vercel token. With the work in code, both hard limits hold by construction.
2. **Phase 3 deploys `new` picks to `vercel` alone.** `pickRefusal` still knows all four hosts and the license rules. A new `phaseRefusal` parks a `renovate` or `extend` pick with "a renovate pick arrives in phase 4; the research is in .canopy/research.md", and parks any host but `vercel` the same way.
3. **Research reads nothing in the workspace beyond devhub's two indexes and READMEs.** That means `Read(//<root>/_devhub/manifest.json)`, `Read(//<root>/_devhub/references.json)` and `Read(//<root>/**/README.md)`, added by `withWorkspaceRead`. There is no bare `Read`, because `<root>/.env` holds shared secrets and `/proc/<pid>/environ` holds canopy's tokens, and WebFetch could carry either out. There is no `gh api`, because `gh api -X POST user/repos` makes a public repo. There is no `git clone`. The spec's research row had all three.
4. **Filing through devhub and moving a rejected seed wait.** Seeds are peer-synced, and a move on the mini leaves the Mac's copy at the old path. A live or rejected seed stays at `_incubator/<slug>`.
5. **A park with no gated flow behind it joins the inbox** as a `sprout` item of kind `park`, offering continue, retry and stop through the existing resume and stop routes. A park behind a gated flow is already in the inbox as that flow's gate.
6. **Seeds stay peer-synced.** Scaffold's check requires `.gitignore` to cover `node_modules`, `.vercel` and `.env.local`, so no WIP snapshot carries a dependency tree or a token.
7. **Checks reach canopy's CLI as `"$CANOPY_CLI"`.** `runCheck` sets it to canopy's own `bin/canopy.ts`, which is executable and has a bun shebang. That is how scout's check runs `canopy incubator pick-check` in the container, where `canopy` is not on PATH.
8. **`VERCEL_TOKEN` is read once, into the ship config, and deleted from canopy's env** (`SECRET_ENV`). It goes only into the env of the `vercel` processes `ship` spawns, and never onto an argv, where `ps` would show it to every agent in the shared pid namespace. An optional `VERCEL_SCOPE` names a team. Like the vault token, it stays readable through `/proc/<canopy>/environ` in the shared pid namespace, which deleting it cannot reach, so the docs ask for a token scoped to one team kept for incubator projects.
9. **The Vercel CLI is installed in the image**, pinned (`vercel@61.1.0`), the same way codex is. A backend without it parks with "the vercel CLI is not installed on <backend>".
10. **A judge rejection at scout's Eval ends the sprout as `rejected`** with the judge's reason in `parked`, and stops the gated flow. A rejection anywhere else parks, as a gate does now.
11. **New input after a pick drops the pick**, so the chain clarifies again, scouts again and builds again. `nextWorkflow` reads the flows, so a `build-new` from before the newest scout does not count.

## Global constraints

- TypeScript `"strict": true`; no `any`, no `as` casts on untrusted data, no non-null `!` (see the typescript-best-practices skill).
- `src/core/types.ts`, `src/core/sprout.ts` and `ui/src/*` stay browser-safe: no Bun or node imports.
- Gates before anything is called done: `bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build` (the zshrc memory: run the suite with `SHELL=/bin/bash`).
- Every stage runs with yolo off and without the route's extra flags (phase 2 ruling). Nothing in this plan changes `stageAgent`.
- Hosts: `HOSTS = ["vercel", "vercel+firebase", "vercel+convex", "mini"]`. Licenses: `ALLOWED_LICENSES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0", "Unlicense", "0BSD", "GPL-2.0", "GPL-3.0", "LGPL-2.1", "LGPL-3.0"]`.
- Budgets: scout `8 runs, 1h`; build-new `30 runs, 6h`.
- No allowlist entry holds `gh repo create`, `gh api`, `git push`, `vercel` of any kind, `vercel domains`, `vercel alias` or anything that buys.
- Copy follows the unslop rules: plain words, no em dashes, sentence case.
- Commit messages carry no backticks.
- Work on a branch in a worktree (`superpowers:using-git-worktrees`), never on `main`. `main` is peer-synced to the mini and redeploys from there. Cut the branch from `main` after the clarify fix and this plan are committed there, so the branch has both.

## Review focus

1. **A `pick.json` an agent wrote badly or hostilely**, such as a host off the list, a license missing on a renovate pick, `target` given as a local path, a `why` 10 KB long, or extra keys. `parsePick` refuses the first three with the reason, clips `why`, and ignores extra keys. Task 1.
2. **A deploy that half happened**, where the repo was created and then the push or the deploy failed, followed by resume or a canopy restart. `ship` skips `createRepo` once `privateRepo` is on record, and the push and deploy both run again cleanly. Task 8 and Task 9.
3. **A production URL that is not public**, because a Vercel deployment-protection setting answers 401. The sprout parks with that reason, never goes live with a URL nobody can open. Task 8.
4. **Input arriving while scout or build-new runs.** The stale pick never reaches a build, and the chain goes clarify, scout, build again. Task 6.
5. **A seed whose working tree an agent left dirty, or whose `.gitignore` misses `.vercel`.** Scaffold's check refuses it with a reason the retry carries. Task 5.

---

## File structure

| File | What changes |
|---|---|
| `src/core/types.ts` | `HOSTS`, `HostId`, `PickKind`, `SproutPick`; `Sprout` gains `pick?`, `privateRepo?`, `url?` |
| `src/core/sprout.ts` | `ALLOWED_LICENSES`, `parsePick`, `pickRefusal`, `phaseRefusal`, `SHIP`, `lastDone`, the new `nextWorkflow`, `STEP_STATUS`/`statusFor`, `withWorkspaceRead`, `SCOUT_FILES`; `parseSproutRecord` checks the new fields |
| `src/core/deploy.ts` (new, pure) | `deployReady`, `repoCandidates`, `vercelProject`, `deploymentUrl`, `productionUrl`, `isVercelAppUrl` |
| `src/core/shipper.ts` (new, Bun) | `ShipConfig`, `shipConfig(env)`, `shipper(cfg, deps)`: the real `Shipper` over `exec` and `fetch` |
| `src/core/incubator.ts` | `Shipper` in the deps; `scouted`, `built`, `reject`, `ship`, `reclarify`; the status follows the step |
| `src/core/sproutnote.ts` | `NoteEvent` gains `live` and `rejected` (both daily); the note shows the pick, the repo and the URL |
| `src/cli/index.ts` | `canopy incubator pick-check` |
| `src/server/index.ts` | `runCheck` sets `CANOPY_CLI`; the ship config read before `SECRET_ENV` is deleted; `ship` in the Incubator's deps; `opts.incubator.ship` for tests |
| `src/core/term.ts` | `SECRET_ENV` gains `VERCEL_TOKEN` |
| `lib/workflows/scout.md`, `lib/workflows/build-new.md` (new) | the two stages |
| `ui/src/inbox.ts`, `ui/src/components/Inbox.tsx` | the sprout `park` item |
| `ui/src/store.ts` | `answerInbox` maps a park's choice to resume or stop |
| `ui/src/sprouts.ts`, `ui/src/components/Incubator.tsx` | `ship` maps to the deploy stage; the sheet shows the pick, the repo and the URL |
| `Dockerfile`, `docker-compose.yml`, `docs/deploy.md`, `CLAUDE.md`, the spec | vercel in the image, `VERCEL_TOKEN`/`VERCEL_SCOPE`, the docs |


## Task 1: the pick, its hard limits and its phase limit

**Files:**
- Modify: `src/core/types.ts` (beside `SPROUT_STATUSES` and `interface Sprout`)
- Modify: `src/core/sprout.ts`
- Test: `src/core/sprout.test.ts`

**Interfaces:**
- Produces: `HOSTS`, `HostId`, `PickKind`, `SproutPick` (types.ts); `ALLOWED_LICENSES`, `ParsedPick`, `parsePick(text: string): ParsedPick`, `pickRefusal(p: SproutPick): string | null`, `phaseRefusal(p: SproutPick): string | null`, `isPick(v: unknown): v is SproutPick` (sprout.ts). `Sprout.pick?: SproutPick`, `Sprout.privateRepo?: string` ("owner/name"), `Sprout.url?: string`.

- [ ] **Step 1: Write the failing tests** (append to `src/core/sprout.test.ts`; add `parsePick, pickRefusal, phaseRefusal, parseSproutRecord` to its import from `./sprout` if they are not already there)

```ts
describe("the pick", () => {
  const pick = (o: Record<string, unknown>): string => JSON.stringify({ kind: "new", host: "vercel", why: "nothing close exists", ...o });

  test("a new pick on vercel reads back with its why clipped to one line", () => {
    const p = parsePick(pick({ why: `fits\n  the stack ${"x".repeat(600)}`, extra: 1 }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.pick.kind).toBe("new");
    expect(p.pick.host).toBe("vercel");
    expect(p.pick.why.startsWith("fits the stack x")).toBe(true);
    expect(p.pick.why.length).toBe(500);
    expect(Object.keys(p.pick).sort()).toEqual(["host", "kind", "why"]);
  });

  test("not JSON, not an object, a kind or host off the list, and no why are refused with the reason", () => {
    expect(parsePick("{nope")).toEqual({ ok: false, error: "pick.json is not JSON" });
    expect(parsePick("[]")).toEqual({ ok: false, error: "pick.json must be an object" });
    expect(parsePick(pick({ kind: "fork" }))).toEqual({ ok: false, error: "kind must be one of new, renovate, extend" });
    expect(parsePick(pick({ host: "netlify" }))).toEqual({ ok: false, error: "host must be one of vercel, vercel+firebase, vercel+convex, mini" });
    expect(parsePick(pick({ why: "  " }))).toEqual({ ok: false, error: "why must say in a sentence why this pick" });
  });

  test("a renovate pick needs an https target, kept without its secret; a new pick drops any target", () => {
    expect(parsePick(pick({ kind: "renovate", license: "MIT" }))).toEqual({ ok: false, error: "a renovate pick needs target: the upstream's https url" });
    expect(parsePick(pick({ kind: "renovate", license: "MIT", target: "/home/eric/dev/x" }))).toEqual({ ok: false, error: "a renovate pick needs target: the upstream's https url" });
    const r = parsePick(pick({ kind: "renovate", license: "MIT", target: "https://u:tok@github.com/a/b" }));
    expect(r.ok && r.pick.target).toBe("https://github.com/a/b");
    const n = parsePick(pick({ target: "https://github.com/a/b" }));
    expect(n.ok && n.pick.target).toBe(undefined);
    expect(parsePick(pick({ kind: "extend" }))).toEqual({ ok: false, error: "an extend pick needs target: the repo it extends" });
  });

  test("pickRefusal holds the license rules, phaseRefusal holds phase 3 to new picks on vercel", () => {
    const base = { kind: "renovate" as const, host: "vercel" as const, why: "w", target: "https://github.com/a/b" };
    expect(pickRefusal(base)).toBe("a renovate pick needs the upstream's SPDX license");
    expect(pickRefusal({ ...base, license: "AGPL-3.0" })).toBe("AGPL-3.0 is not on the allowed license list");
    expect(pickRefusal({ ...base, license: "MIT" })).toBe(null);
    expect(pickRefusal({ kind: "new", host: "vercel", why: "w" })).toBe(null);
    expect(phaseRefusal({ kind: "new", host: "vercel", why: "w" })).toBe(null);
    expect(phaseRefusal({ ...base, license: "MIT" })).toBe("a renovate pick arrives in phase 4; the research is in .canopy/research.md");
    expect(phaseRefusal({ kind: "new", host: "vercel+convex", why: "w" })).toBe("deploying to vercel+convex arrives in phase 4; the research is in .canopy/research.md");
  });

  test("a record with a pick, a repo and a url reads back; a bad pick refuses the record", () => {
    const rec = {
      id: "sp_0123456789ab", slug: "s", title: "t", status: "live", repoId: "_incubator/s", seedPath: "/r/_incubator/s",
      prepared: true, inputs: [], clarified: true, reclarify: false, flows: [], spent: { runs: 0, workMs: 0 }, createdAt: 1, updatedAt: 1,
      pick: { kind: "new", host: "vercel", why: "w" }, privateRepo: "eric/s", url: "https://s.vercel.app",
    };
    expect(parseSproutRecord(JSON.stringify(rec))?.url).toBe("https://s.vercel.app");
    expect(parseSproutRecord(JSON.stringify({ ...rec, pick: { kind: "new", host: "aws", why: "w" } }))).toBe(null);
    expect(parseSproutRecord(JSON.stringify({ ...rec, url: 7 }))).toBe(null);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `SHELL=/bin/bash bun test src/core/sprout.test.ts`
Expected: FAIL. `parsePick` is not exported.

- [ ] **Step 3: Add the types** to `src/core/types.ts`, beside `SPROUT_STATUSES`

```ts
/** where a sprout may deploy; anything else is refused in code */
export const HOSTS = ["vercel", "vercel+firebase", "vercel+convex", "mini"] as const;
export type HostId = (typeof HOSTS)[number];
export type PickKind = "new" | "renovate" | "extend";

/** what scout chose, read from `.canopy/pick.json` by `parsePick` */
export interface SproutPick {
  kind: PickKind;
  /** renovate: the upstream's https url (no secret); extend: the repo it extends */
  target?: string;
  host: HostId;
  /** renovate: the upstream's SPDX license id */
  license?: string;
  /** one line */
  why: string;
}
```

and to `interface Sprout`, after `parked?`:

```ts
  /** scout's pick, once canopy has read and allowed it */
  pick?: SproutPick;
  /** the private GitHub repo canopy made for it, "owner/name" */
  privateRepo?: string;
  /** the production url once live */
  url?: string;
```

- [ ] **Step 4: Implement** in `src/core/sprout.ts`. Add `HOSTS, type HostId, type SproutPick, type PickKind` to the import from `./types`, then add this after `withInputsRead`:

```ts
/** the licenses a renovate pick may carry (SPDX ids) */
export const ALLOWED_LICENSES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0", "Unlicense", "0BSD", "GPL-2.0", "GPL-3.0", "LGPL-2.1", "LGPL-3.0"] as const;
const PICK_KINDS: readonly PickKind[] = ["new", "renovate", "extend"];
const isPickKind = (v: unknown): v is PickKind => typeof v === "string" && (PICK_KINDS as readonly string[]).includes(v);
const isHostId = (v: unknown): v is HostId => typeof v === "string" && (HOSTS as readonly string[]).includes(v);

export type ParsedPick = { ok: true; pick: SproutPick } | { ok: false; error: string };

/** scout's `.canopy/pick.json`, read as untrusted: extra keys are dropped,
 *  `why` is one line of at most 500, a renovate target is an https url
 *  kept without its secret, and a new pick carries no target */
export function parsePick(text: string): ParsedPick {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "pick.json is not JSON" };
  }
  if (!isObj(raw)) return { ok: false, error: "pick.json must be an object" };
  const { kind, host, why, target, license } = raw;
  if (!isPickKind(kind)) return { ok: false, error: `kind must be one of ${PICK_KINDS.join(", ")}` };
  if (!isHostId(host)) return { ok: false, error: `host must be one of ${HOSTS.join(", ")}` };
  if (typeof why !== "string" || !why.trim()) return { ok: false, error: "why must say in a sentence why this pick" };
  const pick: SproutPick = { kind, host, why: oneLine(why, 500) };
  if (kind === "renovate") {
    if (typeof target !== "string" || !/^https:\/\/\S+$/.test(target.trim())) return { ok: false, error: "a renovate pick needs target: the upstream's https url" };
    pick.target = urlWithoutSecret(target.trim());
  }
  if (kind === "extend") {
    if (typeof target !== "string" || !target.trim()) return { ok: false, error: "an extend pick needs target: the repo it extends" };
    pick.target = oneLine(target, 300);
  }
  if (typeof license === "string" && license.trim()) pick.license = oneLine(license, 40);
  return { ok: true, pick };
}

/** the hard limits on a pick, held in code whatever the judge said */
export function pickRefusal(p: SproutPick): string | null {
  if (!isHostId(p.host)) return `${p.host} is not one of the hosts canopy deploys to`;
  if (p.kind === "renovate") {
    if (!p.license) return "a renovate pick needs the upstream's SPDX license";
    if (!(ALLOWED_LICENSES as readonly string[]).includes(p.license)) return `${p.license} is not on the allowed license list`;
  }
  return null;
}

/** what this phase can carry out: a new pick deployed to vercel */
export function phaseRefusal(p: SproutPick): string | null {
  if (p.kind !== "new") return `a ${p.kind} pick arrives in phase 4; the research is in .canopy/research.md`;
  if (p.host !== "vercel") return `deploying to ${p.host} arrives in phase 4; the research is in .canopy/research.md`;
  return null;
}

export const isPick = (v: unknown): v is SproutPick =>
  isObj(v) && isPickKind(v["kind"]) && isHostId(v["host"]) && typeof v["why"] === "string" && optStr(v["target"]) && optStr(v["license"]);
```

`optStr` is declared further down the file as a `const`. Move the three helper lines (`isNum`, `optStr`, `optNum`) above `withInputsRead` so `isPick` can use them; a `const` arrow is not hoisted.

In `parseSproutRecord`, after the `questions` checks:

```ts
  const { pick, privateRepo, url } = raw;
  if (pick !== undefined && !isPick(pick)) return null;
  if (!optStr(privateRepo) || !optStr(url)) return null;
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `SHELL=/bin/bash bun test src/core/sprout.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/sprout.ts src/core/sprout.test.ts
git commit -m "feat(incubator): the pick, its hard limits and what phase 3 carries out"
```

---

## Task 2: the chain after clarify

**Files:**
- Modify: `src/core/sprout.ts` (`nextWorkflow`, `WORKFLOW_STATUS`)
- Modify: `ui/src/sprouts.ts` (`WORKFLOW_STAGE`)
- Test: `src/core/sprout.test.ts`, `ui/src/sprouts.test.ts`

**Interfaces:**
- Consumes: `Sprout.pick` (Task 1).
- Produces: `SHIP = "ship"` (not a workflow: canopy's own deploy), `lastDone(s: Sprout, workflow: string): number`, `nextWorkflow(s: Sprout): string` returning `"clarify" | "scout" | "build-new" | "ship"`, `STEP_STATUS`, `statusFor(workflow: string, step: string | undefined): SproutStatus`, `SCOUT_FILES`.

- [ ] **Step 1: Write the failing tests** (in `src/core/sprout.test.ts`)

```ts
describe("the chain", () => {
  const base = (o: Partial<Sprout> = {}): Sprout => ({
    id: "sp_0123456789ab", slug: "s", title: "t", status: "queued", repoId: "_incubator/s", seedPath: "/r/_incubator/s",
    prepared: true, inputs: [], clarified: true, reclarify: false, flows: [], spent: { runs: 0, workMs: 0 }, createdAt: 1, updatedAt: 1, ...o,
  });
  const done = (workflow: string, n: number) => ({ workflow, flowId: `f${n}`, outcome: "done" });
  const pick = { kind: "new" as const, host: "vercel" as const, why: "w" };

  test("clarify, then scout, then build-new, then canopy's ship", () => {
    expect(nextWorkflow(base({ clarified: false }))).toBe("clarify");
    expect(nextWorkflow(base({ reclarify: true, pick }))).toBe("clarify");
    expect(nextWorkflow(base({ flows: [done("clarify", 1)] }))).toBe("scout");
    expect(nextWorkflow(base({ pick, flows: [done("clarify", 1), done("scout", 2)] }))).toBe("build-new");
    expect(nextWorkflow(base({ pick, flows: [done("clarify", 1), done("scout", 2), done("build-new", 3)] }))).toBe(SHIP);
  });

  test("a build from before the newest scout does not count", () => {
    const flows = [done("clarify", 1), done("scout", 2), done("build-new", 3), done("clarify", 4), done("scout", 5)];
    expect(nextWorkflow(base({ pick, flows }))).toBe("build-new");
    expect(lastDone(base({ flows }), "scout")).toBe(4);
    expect(lastDone(base({ flows }), "retro")).toBe(-1);
  });

  test("a running sprout's status follows the step in progress", () => {
    expect(statusFor("build-new", "Scaffold")).toBe("building");
    expect(statusFor("build-new", "Test")).toBe("testing");
    expect(statusFor("build-new", "Accept")).toBe("accepting");
    expect(statusFor("build-new", undefined)).toBe("building");
    expect(statusFor("scout", "Eval")).toBe("researching");
    expect(statusFor(SHIP, undefined)).toBe("deploying");
    expect(statusFor("clarify", "Clarify")).toBe("clarifying");
  });
});
```

and in `ui/src/sprouts.test.ts`:

```ts
test("a sprout queued for canopy's ship is at the deploy stage", () => {
  const s = sprout({ status: "queued", clarified: true, pick: { kind: "new", host: "vercel", why: "w" }, flows: [
    { workflow: "clarify", flowId: "f1", outcome: "done" },
    { workflow: "scout", flowId: "f2", outcome: "done" },
    { workflow: "build-new", flowId: "f3", outcome: "done" },
  ] });
  expect(stageAt(s)).toBe("deploy");
});
```

(`ui/src/sprouts.test.ts` already has a `sprout(...)` maker for a `Sprout`. If it is named differently, use that one and keep the body.)

- [ ] **Step 2: Run them and see them fail**

Run: `SHELL=/bin/bash bun test src/core/sprout.test.ts ui/src/sprouts.test.ts`
Expected: FAIL. `SHIP` is not exported, and the nextWorkflow cases after scout do not match.

- [ ] **Step 3: Implement** in `src/core/sprout.ts`. Replace `WORKFLOW_STATUS` and `nextWorkflow`:

```ts
/** not a workflow: the deploy canopy carries out itself after build-new */
export const SHIP = "ship";

/** the status a sprout shows while a workflow runs for it */
export const WORKFLOW_STATUS: Readonly<Record<string, SproutStatus>> = {
  clarify: "clarifying",
  scout: "researching",
  "build-new": "building",
  renovate: "building",
  extend: "building",
  [SHIP]: "deploying",
};

/** within a workflow, the status each step shows; a step not named here shows the workflow's */
export const STEP_STATUS: Readonly<Record<string, Readonly<Record<string, SproutStatus>>>> = {
  "build-new": { Scaffold: "building", Test: "testing", Accept: "accepting" },
};

export function statusFor(workflow: string, step: string | undefined): SproutStatus {
  const byStep = STEP_STATUS[workflow];
  const own = step !== undefined && byStep && Object.hasOwn(byStep, step) ? byStep[step] : undefined;
  return own ?? WORKFLOW_STATUS[workflow] ?? "researching";
}

/** the index of the last flow of `workflow` that finished done, or -1 */
export function lastDone(s: Sprout, workflow: string): number {
  for (let i = s.flows.length - 1; i >= 0; i--) {
    const f = s.flows[i];
    if (f && f.workflow === workflow && f.outcome === "done") return i;
  }
  return -1;
}

/** what a queued sprout runs next: clarify until it has clarified what is
 *  known now, scout until there is a pick, a build after the newest scout,
 *  then canopy's own ship */
export function nextWorkflow(s: Sprout): string {
  if (!s.clarified || s.reclarify) return "clarify";
  if (!s.pick) return "scout";
  if (lastDone(s, "build-new") < lastDone(s, "scout")) return "build-new";
  return SHIP;
}

/** what canopy commits to the seed after scout, beside SEED_FILES */
export const SCOUT_FILES = [".canopy/research.md", ".canopy/pick.json", ".canopy/eval.md"];
```

In `ui/src/sprouts.ts`, add `[SHIP]: "deploy"` to `WORKFLOW_STAGE` (and `SHIP` to its import from `../../src/core/sprout`).

- [ ] **Step 4: Run the tests and see them pass**

Run: `SHELL=/bin/bash bun test src/core/sprout.test.ts ui/src/sprouts.test.ts src/core/incubator.test.ts`
Expected: PASS. The phase 2 incubator test "no questions goes on to research, which parks while scout is not installed" still passes, because a clarified sprout with no pick still goes to `scout`.

- [ ] **Step 5: Commit**

```bash
git add src/core/sprout.ts src/core/sprout.test.ts ui/src/sprouts.ts ui/src/sprouts.test.ts
git commit -m "feat(incubator): the chain runs scout, build-new, then canopy's ship"
```

---

## Task 3: canopy's CLI inside a check, and pick-check

**Files:**
- Create: `src/core/cli.ts`
- Modify: `src/server/index.ts` (`runCheck`)
- Modify: `src/cli/index.ts` (the `incubator` case)
- Test: `src/core/cli.test.ts` (new), `src/cli/pickcheck.test.ts` (new)

**Interfaces:**
- Consumes: `parsePick`, `pickRefusal` (Task 1).
- Produces: `CANOPY_CLI_PATH: string`, `checkEnv(): Record<string, string>` (`{ CANOPY_CLI }`); the CLI subcommand `canopy incubator pick-check`, which exits 0 with `pick ok: <kind> on <host>`, or exits 1 with the reason on stderr.

- [ ] **Step 1: Write the failing tests**

`src/core/cli.test.ts`:

```ts
import { expect, test } from "bun:test";
import { checkEnv } from "./cli";

test("a check's shell runs canopy's own CLI through $CANOPY_CLI", async () => {
  const p = Bun.spawn(["sh", "-c", '"$CANOPY_CLI" version'], { env: { ...process.env, ...checkEnv() }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  expect(out).toContain("canopy");
});
```

`src/cli/pickcheck.test.ts`:

```ts
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANOPY_CLI_PATH } from "../core/cli";

const dir = mkdtempSync(join(tmpdir(), "canopy-pickcheck-"));
mkdirSync(join(dir, ".canopy"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = async (files: Record<string, string | null>): Promise<{ code: number; err: string; out: string }> => {
  for (const [rel, text] of Object.entries(files)) {
    rmSync(join(dir, rel), { force: true });
    if (text !== null) writeFileSync(join(dir, rel), text);
  }
  const p = Bun.spawn([CANOPY_CLI_PATH, "incubator", "pick-check"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
};

test("a sound pick and its research pass", async () => {
  const r = await run({ ".canopy/research.md": "# Research\n", ".canopy/pick.json": JSON.stringify({ kind: "new", host: "vercel", why: "w" }) });
  expect(r.code).toBe(0);
  expect(r.out).toContain("pick ok: new on vercel");
});

test("no pick, a bad pick, a refused license and no research each say why", async () => {
  expect((await run({ ".canopy/pick.json": null })).err).toContain(".canopy/pick.json is missing");
  expect((await run({ ".canopy/pick.json": "{" })).err).toContain("pick.json is not JSON");
  const agpl = JSON.stringify({ kind: "renovate", host: "vercel", why: "w", target: "https://github.com/a/b", license: "AGPL-3.0" });
  const r = await run({ ".canopy/pick.json": agpl });
  expect(r.code).toBe(1);
  expect(r.err).toContain("AGPL-3.0 is not on the allowed license list");
  expect((await run({ ".canopy/pick.json": JSON.stringify({ kind: "new", host: "vercel", why: "w" }), ".canopy/research.md": null })).err).toContain(".canopy/research.md is missing");
});
```

The check does not apply `phaseRefusal`. A renovate pick passes the check and the judge, then the Incubator parks it with the phase 4 reason. That keeps scout's workflow the same in phase 4.

- [ ] **Step 2: Run them and see them fail**

Run: `SHELL=/bin/bash bun test src/core/cli.test.ts src/cli/pickcheck.test.ts`
Expected: FAIL. `./cli` does not exist.

- [ ] **Step 3: Implement**

`src/core/cli.ts`:

```ts
/** canopy's own CLI, for a workflow check's shell. bin/canopy.ts is
 *  executable with a bun shebang, so "$CANOPY_CLI" runs it wherever the
 *  checkout is, in the container too, where canopy is not on PATH. */
import { fileURLToPath } from "node:url";

export const CANOPY_CLI_PATH = fileURLToPath(new URL("../../bin/canopy.ts", import.meta.url));

/** the variables a step's check gets beside the server's own */
export const checkEnv = (): Record<string, string> => ({ CANOPY_CLI: CANOPY_CLI_PATH });
```

In `src/server/index.ts`, import `checkEnv` from `../core/cli` and give `runCheck`'s local branch the env:

```ts
      ? await exec(["sh", "-lc", command], { cwd: path, timeoutMs: CHECK_TIMEOUT, env: checkEnv() })
```

In `src/cli/index.ts`, inside `case "incubator"` before `return fail("usage: …")`, add (with `parsePick, pickRefusal` imported from `../core/sprout`):

```ts
      if (sub === "pick-check") {
        // run by scout's check in the seed: what canopy will read after scout, read now
        const pickFile = Bun.file(".canopy/pick.json");
        if (!(await pickFile.exists())) return fail(".canopy/pick.json is missing: research ends by writing it");
        const parsed = parsePick(await pickFile.text());
        if (!parsed.ok) return fail(`.canopy/pick.json: ${parsed.error}`);
        const refused = pickRefusal(parsed.pick);
        if (refused) return fail(`.canopy/pick.json: ${refused}`);
        if (!(await Bun.file(".canopy/research.md").exists())) return fail(".canopy/research.md is missing: research writes it before the pick");
        console.log(`pick ok: ${parsed.pick.kind} on ${parsed.pick.host}`);
        return;
      }
```

Change the usage line to `"usage: canopy incubator list | show <id> | pick-check"`. `fail` prints to stderr through `console.error` and exits 1, which is what the tests read.

- [ ] **Step 4: Run the tests and see them pass**

Run: `SHELL=/bin/bash bun test src/core/cli.test.ts src/cli/pickcheck.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/cli.ts src/core/cli.test.ts src/cli/index.ts src/cli/pickcheck.test.ts src/server/index.ts
git commit -m "feat(incubator): checks reach canopy's CLI, and canopy incubator pick-check"
```

---

## Task 4: the scout workflow, with the workspace reads it may make

**Files:**
- Create: `lib/workflows/scout.md`
- Modify: `src/core/sprout.ts` (`withWorkspaceRead`, `workspaceLine`)
- Modify: `src/core/workflows.ts` (`BUNDLED_ORDER`)
- Test: `src/core/workflows.test.ts`, `src/core/sprout.test.ts`

**Interfaces:**
- Produces: `withWorkspaceRead(wf: Workflow, root: string): Workflow`, which adds to every step `Read(/<root>/_devhub/manifest.json)`, `Read(/<root>/_devhub/references.json)` and `Read(/<root>/**/README.md)`. The `//` prefix makes each an absolute-path rule for Claude Code, as with `withInputsRead`. Also `workspaceLine(root: string): string`, the sentence that names those two files in the stage note.

- [ ] **Step 1: Write the failing tests**

In `src/core/workflows.test.ts`:

```ts
describe("the bundled scout", () => {
  test("unlisted, budgeted, research then a judged eval that rewinds to research", async () => {
    const scout = findWorkflow(await loadWorkflows({ path: "", host: "none" }), "scout");
    expect(scout?.listed).toBe(false);
    expect(scout?.budget).toEqual({ runs: 8, hours: 1 });
    expect(scout?.steps.map((s) => s.name)).toEqual(["Research", "Eval"]);
    const [research, evalStep] = scout?.steps ?? [];
    expect(research?.check).toBe('"$CANOPY_CLI" incubator pick-check');
    expect(research?.retries).toBe(2);
    expect(evalStep?.gate).toBe("judge");
    expect(evalStep?.back).toBe("Research");
    expect(evalStep?.retries).toBe(2);
    expect(evalStep?.evidence).toEqual([".canopy/intent.md", ".canopy/research.md", ".canopy/pick.json", ".canopy/eval.md"]);
  });

  test("no step may read the whole disk, call gh api, clone, push or touch vercel", async () => {
    const scout = findWorkflow(await loadWorkflows({ path: "", host: "none" }), "scout");
    const tools = (scout?.steps ?? []).flatMap((s) => s.tools);
    expect(tools).toEqual(expect.arrayContaining(["WebSearch", "WebFetch", "Bash(gh search repos:*)", "Bash(gh repo view:*)"]));
    for (const banned of ["Read", "Glob", "Grep", "Bash(gh api:*)", "Bash(git clone:*)", "Bash(git push:*)"]) expect(tools).not.toContain(banned);
    expect(tools.some((t) => /vercel|gh repo create|gh repo fork/.test(t))).toBe(false);
  });
});
```

In `src/core/sprout.test.ts` (import `withWorkspaceRead`, `workspaceLine`):

```ts
test("withWorkspaceRead adds devhub's two indexes and READMEs under the root, and nothing wider", () => {
  const wf = { steps: [{ name: "Research", tools: ["WebFetch"] }] } as unknown as Workflow;
  const next = withWorkspaceRead(wf, "/work/dev");
  expect(next.steps[0]?.tools).toEqual([
    "WebFetch",
    "Read(//work/dev/_devhub/manifest.json)",
    "Read(//work/dev/_devhub/references.json)",
    "Read(//work/dev/**/README.md)",
  ]);
  expect(wf.steps[0]?.tools).toEqual(["WebFetch"]);
  expect(workspaceLine("/work/dev")).toBe("The workspace's devhub manifest is /work/dev/_devhub/manifest.json and its saved references are /work/dev/_devhub/references.json.");
});
```

(The `as unknown as Workflow` is test-only. If `sprout.test.ts` already has a `Workflow` maker for the `withInputsRead` test, use that instead.)

- [ ] **Step 2: Run them and see them fail**

Run: `SHELL=/bin/bash bun test src/core/workflows.test.ts src/core/sprout.test.ts`
Expected: FAIL. There is no scout workflow and no `withWorkspaceRead`.

- [ ] **Step 3: Add `withWorkspaceRead` and `workspaceLine`** to `src/core/sprout.ts`, after `withInputsRead`:

```ts
/** A copy of the workflow whose every step may also read devhub's two
 *  indexes and the READMEs under the launch root, and nothing else there:
 *  the root holds a shared `.env`, and a whole-disk Read reaches
 *  /proc/<pid>/environ, either of which WebFetch could carry out. */
export function withWorkspaceRead(wf: Workflow, root: string): Workflow {
  const rules = [`Read(/${root}/_devhub/manifest.json)`, `Read(/${root}/_devhub/references.json)`, `Read(/${root}/**/README.md)`];
  return { ...wf, steps: wf.steps.map((st) => ({ ...st, tools: [...st.tools, ...rules] })) };
}

/** the stage note's sentence naming what withWorkspaceRead opens */
export const workspaceLine = (root: string): string =>
  `The workspace's devhub manifest is ${root}/_devhub/manifest.json and its saved references are ${root}/_devhub/references.json.`;
```

- [ ] **Step 4: Put scout in the bundled order.** In `src/core/workflows.ts`, `BUNDLED_ORDER` becomes `["commit", "push", "ship", "deploy", "review", "clarify", "scout"]`. A name missing from it gets `indexOf` -1 and sorts ahead of `commit`. In `src/core/workflows.test.ts`, the first `loadWorkflows` test's names become `["commit", "push", "ship", "deploy", "review", "clarify", "scout", "broken", "tidy"]`.

- [ ] **Step 4b: Write `lib/workflows/scout.md`**

````markdown
---
name: scout
label: scout
verb: scout
blurb: The agent researches what already exists for a new project, in the user's workspace, on GitHub and on the web, and picks one way to build it, then an evaluator judges the pick against the intent. It runs inside the incubator only.
listed: false
budget: 8 runs, 1h
---

## Research
tools: WebSearch, WebFetch, Bash(gh search repos:*), Bash(gh search code:*), Bash(gh repo view:*), Edit, Write
turns: 80
check: "$CANOPY_CLI" incubator pick-check
retries: 2

Task: you are the research stage of canopy's incubator. .canopy/intent.md says what the user wants, with the answers to clarify's questions at its end; .canopy/brief.md names the project.

1. Look for what exists, nearest first. The user's own projects: the devhub manifest the note names (each project's name, category and description), and the README.md of any project in it that looks close. GitHub: gh search repos, gh search code and gh repo view (its README, license, stars and last push). The web: WebSearch and WebFetch, for products, libraries and write-ups.
2. Write .canopy/research.md: a table of the candidates worth naming, with what each is, its license, its last activity, its stack, how far that stack is from the user's (TypeScript, React, Vite or Next, Convex or Firestore, Vercel) and what renovating it would take. Then the current release of every framework and library the build would use, read from npm or the project's own releases, with the date you read it.
3. Pick one way to build it, in this order of preference: extend one of the user's projects when the idea is a feature of something that exists; renovate an open-source project when one is close and its license allows it; else new, on the user's stack at current versions. Pick the host: vercel for a web app with no database of its own, vercel+convex or vercel+firebase when it needs one, mini for something that must run on the home server.
4. Write .canopy/pick.json as {"kind": "new", "host": "vercel", "why": "one sentence"}, where kind is new, renovate or extend and host is vercel, vercel+firebase, vercel+convex or mini. A renovate pick adds "target" (the upstream's https url) and "license" (its SPDX id); an extend pick adds "target" (the repo it extends).

Edit and write only files under .canopy/. In the workspace, read nothing but the manifest, references.json and README.md files. Do not clone anything, and do not create, fork or change any repo. Stay inside the tools you were given; if you cannot finish without another one, say which and stop. canopy checks pick.json when the step ends and sends you back with the reason if it cannot take it.

Finish with one sentence: the pick and why.

## Eval
tools: Edit, Write
turns: 20
gate: judge
evidence: .canopy/intent.md .canopy/research.md .canopy/pick.json .canopy/eval.md
back: Research
retries: 2

Task: judge the pick in .canopy/pick.json against .canopy/intent.md and .canopy/research.md before anything is built. Write .canopy/eval.md with each "What success looks like" line from intent.md and whether the pick can meet it, the pick's biggest risk, and whether anything breaks the rules: a host off the list, a license that forbids the use, spending money, a public repo, a domain or DNS change. Write only .canopy/eval.md. An evaluator reads these files next and decides whether the pick goes ahead; if the idea itself cannot meet the intent, say so plainly.

Finish with one sentence: whether the pick meets the intent.
````

- [ ] **Step 5: Run the tests and see them pass**

Run: `SHELL=/bin/bash bun test src/core/workflows.test.ts src/core/sprout.test.ts`
Expected: PASS. If the parser refuses the file, its error names the key. Fix the file, never the parser.

- [ ] **Step 6: Commit**

```bash
git add lib/workflows/scout.md src/core/sprout.ts src/core/sprout.test.ts src/core/workflows.ts src/core/workflows.test.ts
git commit -m "feat(incubator): the scout workflow, research and a judged eval, with confined workspace reads"
```

---

## Task 5: the build-new workflow and its checks

**Files:**
- Create: `lib/workflows/build-new.md`
- Modify: `src/core/sprout.ts` (`BUILD_FILES`)
- Modify: `src/core/workflows.ts` (`BUNDLED_ORDER`)
- Test: `src/core/workflows.test.ts`

**Interfaces:**
- Produces: workflow `build-new` with steps `Scaffold`, `Test`, `Accept` (the names `STEP_STATUS` in Task 2 keys on), and `BUILD_FILES = [".canopy/smoke.md", ".canopy/accept.md"]`, which canopy commits after the flow.

- [ ] **Step 1: Write the failing tests** in `src/core/workflows.test.ts`. Add `mkdtemp, mkdir, rm, writeFile` from `node:fs/promises` and `tmpdir`, `join` if they are not imported yet; the file imports most of them already.

```ts
describe("the bundled build-new", () => {
  const load = async () => findWorkflow(await loadWorkflows({ path: "", host: "none" }), "build-new");

  test("scaffold, test, then a judged accept that rewinds to scaffold", async () => {
    const wf = await load();
    expect(wf?.listed).toBe(false);
    expect(wf?.budget).toEqual({ runs: 30, hours: 6 });
    expect(wf?.steps.map((s) => s.name)).toEqual(["Scaffold", "Test", "Accept"]);
    const accept = wf?.steps[2];
    expect(accept?.gate).toBe("judge");
    expect(accept?.back).toBe("Scaffold");
    expect(accept?.evidence).toEqual([".canopy/intent.md", ".canopy/pick.json", ".canopy/smoke.md", ".canopy/accept.md", "README.md"]);
  });

  test("no step holds push, gh, vercel or a whole-disk read", async () => {
    const tools = ((await load())?.steps ?? []).flatMap((s) => s.tools);
    expect(tools).toEqual(expect.arrayContaining(["Bash(git commit:*)", "Bash(bun run:*)", "Bash(bun add:*)", "Bash(curl:*)"]));
    for (const banned of ["Read", "Bash(git push:*)", "Bash(gh api:*)"]) expect(tools).not.toContain(banned);
    expect(tools.some((t) => /vercel|^Bash\(gh /.test(t))).toBe(false);
  });

  test("scaffold's check refuses a gitignore gap, a missing script, an uncommitted lock and a dirty tree", async () => {
    const check = (await load())?.steps[0]?.check ?? "";
    const dir = await mkdtemp(join(tmpdir(), "canopy-build-check-"));
    const sh = async (cmd: string): Promise<{ code: number; out: string }> => {
      const p = Bun.spawn(["sh", "-c", cmd], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out: o + e };
    };
    try {
      await sh("git init -q && git config user.email t@t && git config user.name t && mkdir .canopy && echo x > .canopy/brief.md");
      await writeFile(join(dir, ".gitignore"), "node_modules\n");
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { dev: "true", build: "true" } }));
      expect((await sh(check)).out).toContain(".gitignore must cover .vercel");
      await writeFile(join(dir, ".gitignore"), "node_modules\ndist\n.vercel\n.env*\n");
      await sh("bun install >/dev/null 2>&1");
      expect((await sh(check)).out).toContain("bun.lock is not committed");
      await sh("git add -A && git commit -qm init");
      expect((await sh(check)).code).toBe(0);
      await writeFile(join(dir, "stray.ts"), "export {};\n");
      const dirty = await sh(check);
      expect(dirty.code).toBe(1);
      expect(dirty.out).toContain("the working tree is not clean");
      await rm(join(dir, "stray.ts"));
      // .canopy/ is canopy's: what it holds uncommitted never fails the check
      await writeFile(join(dir, ".canopy", "questions.json"), "[]");
      expect((await sh(check)).code).toBe(0);
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { build: "true" } }));
      await sh("git commit -qam nodev");
      expect((await sh(check)).out).toContain("package.json needs a dev script");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("test's check wants a 2xx status in smoke.md", async () => {
    const check = (await load())?.steps[1]?.check ?? "";
    expect(check).toContain("^status: 2");
  });
});
```

If `bun install` with no dependencies writes no `bun.lock` on the bun in use, add one dependency-free line to the fixture's setup: `await writeFile(join(dir, "bun.lock"), "{\n  \"lockfileVersion\": 1,\n  \"workspaces\": { \"\": { \"name\": \"x\" } },\n  \"packages\": {}\n}\n")`. Keep the "bun.lock is not committed" assertion either way.

- [ ] **Step 2: Run them and see them fail**

Run: `SHELL=/bin/bash bun test src/core/workflows.test.ts`
Expected: FAIL. There is no build-new workflow.

- [ ] **Step 2b: Put build-new in the bundled order.** Append `"build-new"` to `BUNDLED_ORDER` in `src/core/workflows.ts`, after `"scout"`. The first `loadWorkflows` test's names become `["commit", "push", "ship", "deploy", "review", "clarify", "scout", "build-new", "broken", "tidy"]`.

- [ ] **Step 3: Write `lib/workflows/build-new.md`.** Each `check:` value is one line, so the parser reads it whole.

````markdown
---
name: build-new
label: build new
verb: build
blurb: The agent builds a new project from its intent and research on the user's stack at current versions and tests it, then an evaluator checks what runs against the intent. canopy deploys it after. It runs inside the incubator only.
listed: false
budget: 30 runs, 6h
---

## Scaffold
tools: git-read, git-commit, bun, Bash(bun add:*), Bash(bun remove:*), Bash(bun create:*), Bash(ls:*), Bash(mkdir:*), Edit, Write, WebFetch
turns: 200
check: for p in node_modules .vercel .env.local; do git check-ignore -q "$p" || { echo ".gitignore must cover $p"; exit 1; }; done; [ -f package.json ] || { echo "package.json is missing"; exit 1; }; for s in dev build; do grep -q "\"$s\":" package.json || { echo "package.json needs a $s script"; exit 1; }; done; git ls-files --error-unmatch bun.lock >/dev/null 2>&1 || { echo "bun.lock is not committed"; exit 1; }; bun install --frozen-lockfile >/dev/null 2>&1 || { echo "bun install --frozen-lockfile failed: commit bun.lock after every bun add"; exit 1; }; for s in typecheck lint test build; do if grep -q "\"$s\":" package.json; then bun run "$s" || { echo "bun run $s failed"; exit 1; }; fi; done; [ -z "$(git status --porcelain -- . ':(exclude).canopy')" ] || { echo "the working tree is not clean: commit your work"; git status --short; exit 1; }
retries: 3

Task: you are the build stage of canopy's incubator. Build the project .canopy/intent.md describes, as .canopy/pick.json picked it, in this repo, which holds nothing yet but .canopy/.

1. Use the versions .canopy/research.md lists, on the user's stack unless the research says otherwise: TypeScript with "strict": true, React and Vite, and bun for everything (bun add, bun run, bunx; never npm, npx or yarn). It deploys to Vercel as it is, with no server of its own and no database, so keep any data in the browser.
2. package.json has "dev" and "build" scripts, and "typecheck", "lint" and "test" where they make sense. Commit bun.lock.
3. .gitignore covers node_modules, dist, .vercel and .env*. Never write a token, a key or a password into any file.
4. A README.md says what it is and how to run it.
5. Commit with git add and git commit as you go, and leave the working tree clean. Do not push; canopy pushes and deploys after the last step.

Make a folder with mkdir or by writing a file into it. Stay inside the tools you were given; if you cannot finish without another one, say which and stop. canopy's check installs, runs every gate script and checks the tree is clean when the step ends, and sends you back with what failed.

Finish with two sentences: what you built and what is left out.

## Test
tools: git-read, git-commit, bun, Bash(bun add:*), Bash(curl:*), Bash(ls:*), KillShell, Edit, Write
turns: 120
check: for s in typecheck lint test build; do if grep -q "\"$s\":" package.json; then bun run "$s" || { echo "bun run $s failed"; exit 1; }; fi; done; grep -q '^status: 2' .canopy/smoke.md 2>/dev/null || { echo ".canopy/smoke.md must start with the status the running app answered, a 2xx"; exit 1; }; [ -z "$(git status --porcelain -- . ':(exclude).canopy')" ] || { echo "the working tree is not clean: commit your fixes"; git status --short; exit 1; }
retries: 3

Task: make sure the project runs.

1. Run every gate script package.json has (typecheck, lint, test, build) and fix what fails.
2. Start the app with "bun run dev --port 4317 --strictPort" as a background command (if the port is taken, the next free one up to 4399), fetch it with curl, then stop that background command.
3. Write .canopy/smoke.md: a first line "status: <the HTTP status>", then the page's title and the first lines of visible text, then how each "What success looks like" line in .canopy/intent.md can be seen in the running app.
4. Commit every fix and leave the tree clean. Do not push.

Stay inside the tools you were given; if you cannot finish without another one, say which and stop.

Finish with one sentence: whether it runs.

## Accept
tools: Edit, Write
turns: 20
gate: judge
evidence: .canopy/intent.md .canopy/pick.json .canopy/smoke.md .canopy/accept.md README.md
back: Scaffold
retries: 2

Task: check the work against the intent before it is deployed. Read .canopy/intent.md, README.md, the code and .canopy/smoke.md, then write .canopy/accept.md: each "What success looks like" line, met or not and where in the code, and anything under "Out of scope" that was built anyway. Write only .canopy/accept.md. An evaluator reads these files next and decides whether it is deployed.

Finish with one sentence: whether it meets the intent.
````

Add to `src/core/sprout.ts`, beside `SCOUT_FILES`:

```ts
/** what canopy commits to the seed after build-new: the smoke and accept notes */
export const BUILD_FILES = [".canopy/smoke.md", ".canopy/accept.md"];
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `SHELL=/bin/bash bun test src/core/workflows.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/workflows/build-new.md src/core/sprout.ts src/core/workflows.ts src/core/workflows.test.ts
git commit -m "feat(incubator): the build-new workflow, scaffold, test and a judged accept"
```

---

## Task 6: the Incubator reads scout and build-new

**Files:**
- Modify: `src/core/incubator.ts` (`flowMoved`, `launch`, `pump`, three `reclarify = true` sites; new `scouted`, `built`, `reject`, `reclarify`, and a placeholder `ship` that Task 9 replaces)
- Test: `src/core/incubator.test.ts`

**Interfaces:**
- Consumes: `parsePick`, `pickRefusal`, `phaseRefusal`, `SHIP`, `statusFor`, `SCOUT_FILES`, `BUILD_FILES`, `withWorkspaceRead`, `workspaceLine` (Tasks 1, 2, 4, 5).
- Produces: `NoteEvent` `"rejected"` is passed to `changed` (Task 10 makes it a daily event); `private ship(s: Sprout): Promise<void>`, which Task 9 fills in.

- [ ] **Step 1: Write the failing tests** in `src/core/incubator.test.ts`, as a new `describe`. Use the file's `world`, `intake`, `now` and `CLARIFY`. The file already has a one-step `SCOUT` fixture that the phase 2 tests use, so these stages go by `SCOUT_STAGE` and `BUILD_STAGE`. Add `import type { Judgment } from "./types";` if it is not imported.

```ts
const ONE_STEP = CLARIFY.steps[0];
if (!ONE_STEP) throw new Error("the CLARIFY fixture has a step");
const stage = (name: string, steps: string[], gate: "continue" | "judge" = "continue"): Workflow => ({
  ...CLARIFY,
  name,
  label: name,
  verb: name,
  file: `/${name}.md`,
  steps: steps.map((n, i) => ({ ...ONE_STEP, name: n, gate: i === steps.length - 1 ? gate : "continue" })),
});
const SCOUT_STAGE = stage("scout", ["Research", "Eval"], "judge");
const BUILD_STAGE = stage("build-new", ["Scaffold", "Test", "Accept"], "judge");
const PICK = JSON.stringify({ kind: "new", host: "vercel", why: "nothing close exists" });

describe("scout and build-new", () => {
  const chain = () => {
    const w = world();
    w.workflows.set("scout", SCOUT_STAGE);
    w.workflows.set("build-new", BUILD_STAGE);
    return w;
  };
  const end = async (w: World, id: string, files: Record<string, string>, patch: Partial<Flow> = { status: "done" }) => {
    const s = now(w, id);
    for (const [rel, text] of Object.entries(files)) await w.seeds.write(s.seedPath, rel, text);
    w.flows.move(s.flows.at(-1)?.flowId ?? "", patch);
    await w.inc.idle();
    return now(w, id);
  };
  /** a sprout through clarify with no questions, so scout has started */
  const scouting = async (w: World): Promise<Sprout> => {
    const s = await w.inc.create(intake({ text: "coin counter" }));
    await w.inc.idle();
    return end(w, s.id, { ".canopy/questions.json": "[]" });
  };

  test("scout starts with the workspace reads and the manifest named in its note", async () => {
    const w = chain();
    const s = await scouting(w);
    expect(s.status).toBe("researching");
    const started = w.flows.started.at(-1);
    expect(started?.workflow.name).toBe("scout");
    expect(started?.workflow.steps[0]?.tools).toContain("Read(//root/_devhub/manifest.json)");
    expect(started?.note).toContain("/root/_devhub/manifest.json");
  });

  test("a new pick on vercel is kept, scout's files are committed, and build-new starts", async () => {
    const w = chain();
    const s = await scouting(w);
    const after = await end(w, s.id, { ".canopy/pick.json": PICK, ".canopy/research.md": "# Research" });
    expect(after.pick).toEqual({ kind: "new", host: "vercel", why: "nothing close exists" });
    expect(w.seeds.commits.at(-1)?.message).toBe("scout: coin counter");
    expect(after.status).toBe("building");
    expect(w.flows.started.at(-1)?.workflow.name).toBe("build-new");
  });

  test("a renovate pick parks with the phase 4 reason and is not kept; no pick parks too", async () => {
    const w = chain();
    const s = await scouting(w);
    const renovate = JSON.stringify({ kind: "renovate", host: "vercel", why: "w", target: "https://github.com/a/b", license: "MIT" });
    const after = await end(w, s.id, { ".canopy/pick.json": renovate });
    expect(after.status).toBe("parked");
    expect(after.parked).toBe("a renovate pick arrives in phase 4; the research is in .canopy/research.md");
    expect(after.pick).toBe(undefined);
    const w2 = chain();
    const s2 = await scouting(w2);
    expect((await end(w2, s2.id, {})).parked).toBe("scout ended without a .canopy/pick.json");
  });

  test("the judge turning the idea down at eval rejects the sprout, stops the flow and frees the slot", async () => {
    const w = chain();
    const s = await scouting(w);
    const judgment: Judgment = {
      answers: { fit: { choice: "misses" }, evidence: { probability: 0.9 }, rules: { probability: 0 } },
      go: false,
      rejected: true,
      reason: "a coin counter already ships with every phone",
    };
    const after = await end(w, s.id, {}, {
      status: "gated",
      current: 1,
      steps: [{ name: "Research", status: "passed" }, { name: "Eval", status: "gated", reason: judgment.reason ?? "", judgment }],
    });
    expect(after.status).toBe("rejected");
    expect(after.parked).toBe("a coin counter already ships with every phone");
    expect(after.flows.at(-1)?.outcome).toBe("rejected");
    expect(w.flows.get(after.flows.at(-1)?.flowId ?? "")?.status).toBe("stopped");
  });

  test("the status follows build-new's step, and its end commits the notes and goes to canopy's ship", async () => {
    const w = chain();
    const s = await scouting(w);
    const building = await end(w, s.id, { ".canopy/pick.json": PICK });
    const flowId = building.flows.at(-1)?.flowId ?? "";
    w.flows.move(flowId, { current: 1, steps: [{ name: "Scaffold", status: "passed" }, { name: "Test", status: "running" }, { name: "Accept", status: "pending" }] });
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("testing");
    w.flows.move(flowId, { current: 2, steps: [{ name: "Scaffold", status: "passed" }, { name: "Test", status: "passed" }, { name: "Accept", status: "running" }] });
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("accepting");
    const after = await end(w, s.id, { ".canopy/smoke.md": "status: 200", ".canopy/accept.md": "met" });
    expect(w.seeds.commits.at(-1)?.message).toBe("build: coin counter");
    // Task 6 leaves ship a placeholder; Task 9 replaces this line with the live path
    expect(after.parked).toBe("canopy cannot deploy yet");
  });

  test("input that arrives while scout runs drops the pick, and the chain clarifies again", async () => {
    const w = chain();
    const s = await scouting(w);
    await w.inc.addInputs(s.id, intake({ text: "and it should count euros" }));
    await w.inc.idle();
    const after = await end(w, s.id, { ".canopy/pick.json": PICK });
    expect(after.pick).toBe(undefined);
    expect(w.flows.started.at(-1)?.workflow.name).toBe("clarify");
  });
});
```

`Flow`, `Sprout`, `Workflow` and `World` are already in scope in this file. If `addInputs` on a running sprout answers differently in phase 2 (it may queue the inputs and wait), keep the expectation on what starts next. That is the behaviour this task owns.

- [ ] **Step 2: Run them and see them fail**

Run: `SHELL=/bin/bash bun test src/core/incubator.test.ts`
Expected: FAIL. Scout's end parks with "nothing follows scout yet".

- [ ] **Step 3: Implement** in `src/core/incubator.ts`. Add to the import from `./sprout`: `BUILD_FILES, parsePick, phaseRefusal, pickRefusal, SCOUT_FILES, SHIP, statusFor, withWorkspaceRead, workspaceLine`.

The three `s.reclarify = true` sites (in `addInputs`, `afterInputs` and `clarifyAgain`) each become `this.reclarify(s)`, and the helper is:

```ts
  /** new input means clarify reads again, and a pick made before it no longer stands */
  private reclarify(s: Sprout): void {
    s.reclarify = true;
    delete s.pick;
  }
```

In `pump`, replace the stage start in the loop body:

```ts
      const name = nextWorkflow(s);
      // the slot is claimed here, before anything awaits
      s.status = statusFor(name, undefined);
      delete s.parked;
      this.track(name === SHIP ? this.ship(s) : this.startStage(s, name));
```

In `launch`, after the clarify line:

```ts
    if (name === "scout") wf = withWorkspaceRead(wf, this.deps.root);
```

and build the note with the workspace line for scout:

```ts
    const base = stageNote(s, this.deps.store.inputsDir(s.id));
    const note = name === "scout" ? `${base} ${workspaceLine(this.deps.root)}` : base;
    const flow = await this.deps.flows.start(repo, wf, note);
```

Replace `flowMoved` with:

```ts
  private async flowMoved(s: Sprout, entry: SproutFlow, flow: Flow): Promise<void> {
    // an outcome on record means this flow's end was already taken in
    if (this.detached || s.status === "stopped" || entry.outcome) return;
    const step = flow.steps[flow.current];
    if (flow.status === "gated") {
      if (entry.workflow === "scout" && step?.judgment?.rejected) {
        return this.reject(s, entry, flow, step.judgment.reason ?? step.reason ?? "the judge turned the idea down");
      }
      // the flow lives on, waiting on the human: the sprout keeps its slot, so nothing is pumped
      return this.park(s, `${entry.workflow} waits${step ? ` after ${step.name}` : ""}: ${step?.reason ?? "a gate"}`, false);
    }
    if (flow.status === "working" || flow.status === "waiting") {
      // back from a park, or on to the next step: the status follows the step in progress
      const want = statusFor(entry.workflow, step?.name);
      if (s.status !== "parked" && (s.status === want || !RUNNING_STATUSES.has(s.status))) return;
      s.status = want;
      delete s.parked;
      await this.changed(s);
      return;
    }
    entry.outcome = flow.status;
    s.spent = { runs: s.spent.runs + (flow.spent?.runs ?? 0), workMs: s.spent.workMs + (flow.spent?.workMs ?? 0) };
    if (flow.status !== "done") return this.park(s, `${entry.workflow} ${flow.status}${flow.error ? `: ${flow.error}` : ""}`);
    try {
      if (entry.workflow === "clarify") await this.clarified(s);
      else if (entry.workflow === "scout") await this.scouted(s);
      else if (entry.workflow === "build-new") await this.built(s);
      else await this.park(s, `nothing follows ${entry.workflow} yet`);
    } catch (err) {
      await this.park(s, `could not read what ${entry.workflow} wrote: ${msg(err)}`);
    }
  }
```

Import `RUNNING_STATUSES` from `./sprout` if `incubator.ts` does not already.

Add after `clarified`:

```ts
  /** scout finished: its pick, read as untrusted and held to the limits in code */
  private async scouted(s: Sprout): Promise<void> {
    const raw = await this.deps.seeds.read(s.seedPath, ".canopy/pick.json");
    if (raw === null) return this.park(s, "scout ended without a .canopy/pick.json");
    const parsed = parsePick(raw);
    if (!parsed.ok) return this.park(s, `scout wrote a pick canopy cannot read: ${parsed.error}`);
    try {
      await this.deps.seeds.commit(s.seedPath, [...SEED_FILES, ...SCOUT_FILES], `scout: ${s.title}`);
    } catch (err) {
      return this.park(s, `could not commit scout's files: ${msg(err)}`);
    }
    const refused = pickRefusal(parsed.pick) ?? phaseRefusal(parsed.pick);
    if (refused) return this.park(s, refused);
    if (sproutEnded(s)) return;
    // input that came while scout ran: clarify reads it, and scout picks again
    if (!s.reclarify) s.pick = parsed.pick;
    s.status = "queued";
    await this.changed(s);
    this.pump();
  }

  /** build-new finished: its notes committed, then canopy's own ship */
  private async built(s: Sprout): Promise<void> {
    try {
      await this.deps.seeds.commit(s.seedPath, BUILD_FILES, `build: ${s.title}`);
    } catch (err) {
      return this.park(s, `could not commit the build's notes: ${msg(err)}`);
    }
    if (sproutEnded(s)) return;
    s.status = "queued";
    await this.changed(s);
    this.pump();
  }

  /** the judge turned the idea down at eval: an end, not a park */
  private async reject(s: Sprout, entry: SproutFlow, flow: Flow, reason: string): Promise<void> {
    entry.outcome = "rejected";
    s.spent = { runs: s.spent.runs + (flow.spent?.runs ?? 0), workMs: s.spent.workMs + (flow.spent?.workMs ?? 0) };
    s.status = "rejected";
    s.parked = reason;
    this.stopFlow(flow);
    await this.changed(s, "rejected");
    this.pump();
  }

  /** canopy's own deploy; Task 9 replaces this placeholder */
  private async ship(s: Sprout): Promise<void> {
    await this.park(s, "canopy cannot deploy yet");
  }
```

`changed(s, "rejected")` does not compile until `NoteEvent` has `"rejected"`. Add `"live"` and `"rejected"` to the `NoteEvent` union in `src/core/sproutnote.ts` now. Task 10 makes them daily events and words them.

- [ ] **Step 4: Run the tests and see them pass**

Run: `SHELL=/bin/bash bun test src/core/incubator.test.ts src/core/sprout.test.ts`
Expected: PASS, the phase 2 tests included. The phase 2 test "no questions goes on to research, which parks while scout is not installed" still holds, because its world has no scout workflow.

- [ ] **Step 5: Commit**

```bash
git add src/core/incubator.ts src/core/incubator.test.ts src/core/sproutnote.ts
git commit -m "feat(incubator): read scout's pick, reject at eval, follow build-new's steps"
```

---

## Task 7: what a deploy needs and answers, pure

**Files:**
- Create: `src/core/deploy.ts`
- Test: `src/core/deploy.test.ts`

**Interfaces:**
- Consumes: `HostId` (Task 1).
- Produces: `DeployEnv`, `deployReady(host: HostId, env: DeployEnv): string | null`, `repoCandidates(slug: string): string[]`, `vercelProject(name: string): string`, `isVercelAppUrl(u: string): boolean`, `deploymentUrl(stdout: string): string | null`, `productionUrl(aliases: readonly string[], fallback: string): string`, `smokeRefusal(status: number, url: string): string | null`, `vercelArgs(cmd: "link" | "deploy", project: string, scope: string | null): string[]`.

- [ ] **Step 1: Write the failing tests** (`src/core/deploy.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { deployReady, deploymentUrl, isVercelAppUrl, productionUrl, repoCandidates, smokeRefusal, vercelArgs, vercelProject } from "./deploy";

describe("deployReady", () => {
  const env = { vercelToken: true, vercelCli: true, backend: "mini" };
  test("vercel with a token and the CLI is ready; each gap says what to add", () => {
    expect(deployReady("vercel", env)).toBe(null);
    expect(deployReady("vercel", { ...env, vercelToken: false })).toBe("add VERCEL_TOKEN to mini's .env");
    expect(deployReady("vercel", { ...env, vercelCli: false })).toBe("the vercel CLI is not installed on mini");
    expect(deployReady("vercel+convex", env)).toBe("deploying to vercel+convex arrives in phase 4");
    expect(deployReady("mini", env)).toBe("deploying to mini arrives in phase 4");
  });
});

describe("names", () => {
  test("repo names try the slug, then -2 to -9, always lowercase and safe", () => {
    expect(repoCandidates("coin-counter").slice(0, 3)).toEqual(["coin-counter", "coin-counter-2", "coin-counter-3"]);
    expect(repoCandidates("coin-counter")).toHaveLength(9);
    expect(repoCandidates("Ünsafe name!")[0]).toBe("unsafe-name");
    expect(repoCandidates("---")[0]).toBe("sprout");
  });
  test("a vercel project name keeps to its rules", () => {
    expect(vercelProject("coin-counter-2")).toBe("coin-counter-2");
    expect(vercelProject("A----B")).toBe("a--b");
    expect(vercelProject("x".repeat(120))).toHaveLength(100);
  });
});

describe("the deploy's answers", () => {
  test("only an https vercel.app address counts", () => {
    expect(isVercelAppUrl("https://coin-counter.vercel.app")).toBe(true);
    expect(isVercelAppUrl("https://coin-counter-abc123-eric.vercel.app/")).toBe(true);
    expect(isVercelAppUrl("http://coin-counter.vercel.app")).toBe(false);
    expect(isVercelAppUrl("https://coins.example.com")).toBe(false);
    expect(isVercelAppUrl("https://evil.com/.vercel.app")).toBe(false);
  });
  test("the deployment url is the last vercel.app line vercel deploy printed", () => {
    const out = "Vercel CLI 61.1.0\nhttps://coin-counter-abc123-eric.vercel.app\n";
    expect(deploymentUrl(out)).toBe("https://coin-counter-abc123-eric.vercel.app");
    expect(deploymentUrl("Error: no\n")).toBe(null);
  });
  test("the production url is the shortest vercel.app alias, else the deployment's own", () => {
    expect(productionUrl(["coin-counter-eric.vercel.app", "coin-counter.vercel.app", "coins.example.com"], "https://d.vercel.app")).toBe("https://coin-counter.vercel.app");
    expect(productionUrl([], "https://d.vercel.app")).toBe("https://d.vercel.app");
  });
  test("a smoke GET goes live on 2xx or 3xx; 401 and 403 name the protection", () => {
    expect(smokeRefusal(200, "https://x.vercel.app")).toBe(null);
    expect(smokeRefusal(401, "https://x.vercel.app")).toBe("https://x.vercel.app answers 401: Vercel's deployment protection may cover it; turn it off for production in the project's settings, then resume");
    expect(smokeRefusal(500, "https://x.vercel.app")).toBe("https://x.vercel.app answers 500");
  });
  test("the vercel argv never carries the token", () => {
    expect(vercelArgs("link", "coin-counter", null)).toEqual(["vercel", "link", "--yes", "--project", "coin-counter"]);
    expect(vercelArgs("deploy", "coin-counter", "team-x")).toEqual(["vercel", "deploy", "--prod", "--yes", "--scope", "team-x"]);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `SHELL=/bin/bash bun test src/core/deploy.test.ts`
Expected: FAIL. `./deploy` does not exist.

- [ ] **Step 3: Implement** `src/core/deploy.ts`

```ts
/**
 * What the incubator's deploy needs and what it answers, pure and tested
 * (spec 2026-10-01-incubator-design.md, amendment 2). The deploy itself is
 * shipper.ts: canopy's own code, never an agent's step.
 */
import type { HostId } from "./types";

export interface DeployEnv {
  vercelToken: boolean;
  vercelCli: boolean;
  /** the backend's name, for the reason a park gives */
  backend: string;
}

/** null when `host` can be deployed to from here, else the one-line park reason */
export function deployReady(host: HostId, env: DeployEnv): string | null {
  if (host !== "vercel") return `deploying to ${host} arrives in phase 4`;
  if (!env.vercelToken) return `add VERCEL_TOKEN to ${env.backend}'s .env`;
  if (!env.vercelCli) return `the vercel CLI is not installed on ${env.backend}`;
  return null;
}

const safeName = (s: string): string =>
  s
    .normalize("NFKD")
    // NFKD splits an accented letter into the letter and a mark; the mark goes
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");

/** GitHub repo names to try for a seed: its slug, then -2 to -9 */
export function repoCandidates(slug: string): string[] {
  const base = safeName(slug).slice(0, 90) || "sprout";
  return [base, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)];
}

/** a Vercel project name: lowercase letters, digits, ".", "_" and "-", at most 100, never "---" */
export function vercelProject(name: string): string {
  return safeName(name).replace(/-{3,}/g, "--").slice(0, 100) || "sprout";
}

const VERCEL_APP = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app\/?$/;
/** the only addresses a sprout goes live at: no custom domain is ever involved */
export const isVercelAppUrl = (u: string): boolean => VERCEL_APP.test(u);

/** the deployment url `vercel deploy` printed: its last vercel.app line */
export function deploymentUrl(stdout: string): string | null {
  const urls = stdout.split("\n").map((l) => l.trim()).filter(isVercelAppUrl);
  const last = urls.at(-1);
  return last ? last.replace(/\/$/, "") : null;
}

/** the production url among a deployment's aliases: the shortest vercel.app one, else the deployment's own */
export function productionUrl(aliases: readonly string[], fallback: string): string {
  const own = aliases
    .map((a) => (a.startsWith("https://") ? a : `https://${a}`))
    .filter(isVercelAppUrl)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return own[0]?.replace(/\/$/, "") ?? fallback;
}

/** what a smoke GET's status says about going live; null is live */
export function smokeRefusal(status: number, url: string): string | null {
  if (status >= 200 && status < 400) return null;
  if (status === 401 || status === 403) {
    return `${url} answers ${status}: Vercel's deployment protection may cover it; turn it off for production in the project's settings, then resume`;
  }
  return `${url} answers ${status}`;
}

/** the vercel argv; the token rides in the child's env, never here, where ps would show it */
export function vercelArgs(cmd: "link" | "deploy", project: string, scope: string | null): string[] {
  const s = scope ? ["--scope", scope] : [];
  return cmd === "link" ? ["vercel", "link", "--yes", "--project", project, ...s] : ["vercel", "deploy", "--prod", "--yes", ...s];
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `SHELL=/bin/bash bun test src/core/deploy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/deploy.ts src/core/deploy.test.ts
git commit -m "feat(incubator): what a deploy needs and answers, pure"
```

---

## Task 8: the shipper, over gh, git, vercel and the Vercel API

**Files:**
- Create: `src/core/shipper.ts`
- Test: `src/core/shipper.test.ts`

**Interfaces:**
- Consumes: Task 7's functions; `exec`, `ExecOptions` and `ExecResult` from `./exec`.
- Produces: `interface Shipper { ready(host: HostId): string | null; createRepo(slug: string, description: string): Promise<string>; project(slug: string): Promise<string>; push(seedPath: string, repo: string): Promise<void>; deploy(seedPath: string, project: string): Promise<string> }`, `ShipConfig { vercelToken: string | null; vercelScope: string | null; backend: string }`, `shipConfig(env: Record<string, string | undefined>, backend: string): ShipConfig`, `ShipDeps`, `shipper(cfg: ShipConfig, deps?: ShipDeps): Shipper`. The `Shipper` interface lives here and `incubator.ts` imports it as a type.

- [ ] **Step 1: Write the failing tests** (`src/core/shipper.test.ts`). The fakes record every argv, cwd and env, so the tests can prove that no token ever reaches an argv.

```ts
import { describe, expect, test } from "bun:test";
import type { ExecOptions, ExecResult } from "./exec";
import { shipConfig, shipper, type ShipDeps } from "./shipper";

interface Call { cmd: string[]; opts: ExecOptions }
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const no = (stderr = "nope"): ExecResult => ({ code: 1, stdout: "", stderr });

function fakes(answer: (c: Call) => ExecResult, http: (url: string, method: string) => Response = () => new Response("{}", { status: 200 })) {
  const calls: Call[] = [];
  const fetched: { url: string; method: string; auth: string | null }[] = [];
  const deps: ShipDeps = {
    exec: async (cmd, opts = {}) => {
      const c = { cmd, opts };
      calls.push(c);
      return answer(c);
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      fetched.push({ url, method, auth: new Headers(init?.headers).get("authorization") });
      return http(url, method);
    }) as typeof fetch,
    which: (bin) => (bin === "vercel" ? "/usr/bin/vercel" : null),
  };
  return { calls, fetched, deps };
}
const cfg = shipConfig({ VERCEL_TOKEN: "tok_secret" }, "mini");

describe("createRepo", () => {
  test("a private repo under the logged-in owner, skipping taken names", async () => {
    const f = fakes((c) => {
      if (c.cmd.join(" ") === "gh api user --jq .login") return ok("eric\n");
      if (c.cmd[1] === "repo" && c.cmd[2] === "view") return c.cmd[3] === "eric/coin-counter" ? ok("{}") : no("not found");
      return ok();
    });
    expect(await shipper(cfg, f.deps).createRepo("coin-counter", "Coin counter")).toBe("eric/coin-counter-2");
    const create = f.calls.find((c) => c.cmd[2] === "create");
    expect(create?.cmd).toEqual(["gh", "repo", "create", "eric/coin-counter-2", "--private", "--disable-wiki", "--description", "Coin counter"]);
  });
  test("a gh that cannot say who it is fails with the reason", async () => {
    const f = fakes(() => no("HTTP 401"));
    await expect(shipper(cfg, f.deps).createRepo("x", "x")).rejects.toThrow("gh cannot say who it is logged in as: HTTP 401");
  });
});

describe("project", () => {
  test("the first project name Vercel does not have yet, made there before the link", async () => {
    const f = fakes(
      () => ok(),
      (url, method) => new Response("{}", { status: method === "POST" ? 200 : url.endsWith("/v9/projects/coin-counter") ? 200 : 404 }),
    );
    expect(await shipper(cfg, f.deps).project("coin-counter")).toBe("coin-counter-2");
    expect(f.fetched.map((x) => `${x.method} ${x.url}`)).toEqual([
      "GET https://api.vercel.com/v9/projects/coin-counter",
      "GET https://api.vercel.com/v9/projects/coin-counter-2",
      "POST https://api.vercel.com/v11/projects",
    ]);
    expect(f.fetched.every((x) => x.auth === "Bearer tok_secret")).toBe(true);
  });
  test("a name another account took between the read and the make goes on to the next", async () => {
    const f = fakes(
      () => ok(),
      (url, method) => new Response("{}", { status: method === "POST" ? (f.fetched.filter((x) => x.method === "POST").length === 1 ? 409 : 200) : 404 }),
    );
    expect(await shipper(cfg, f.deps).project("coin-counter")).toBe("coin-counter-2");
  });
});

describe("push", () => {
  test("origin added or reset, then HEAD to main, with hooks off and no prompt", async () => {
    const f = fakes((c) => (c.cmd.includes("get-url") ? no() : ok()));
    await shipper(cfg, f.deps).push("/seed", "eric/coin-counter");
    const git = f.calls.map((c) => c.cmd.filter((w) => !w.startsWith("core.") && w !== "-c").slice(1).join(" "));
    expect(git).toEqual(["remote get-url origin", "remote add origin https://github.com/eric/coin-counter.git", "push -u origin HEAD:refs/heads/main"]);
    for (const c of f.calls) {
      expect(c.cmd).toContain("core.hooksPath=/dev/null");
      expect(c.opts.cwd).toBe("/seed");
      expect(c.opts.env?.["GIT_TERMINAL_PROMPT"]).toBe("0");
    }
  });
  test("a refused push fails with git's words", async () => {
    const f = fakes((c) => (c.cmd.includes("push") ? no("rejected: non-fast-forward") : ok()));
    await expect(shipper(cfg, f.deps).push("/seed", "eric/x")).rejects.toThrow("git push: rejected: non-fast-forward");
  });
});

describe("deploy", () => {
  const deployed = (c: Call): ExecResult => (c.cmd[1] === "deploy" ? ok("Vercel CLI 61.1.0\nhttps://coin-counter-abc-eric.vercel.app\n") : ok());
  test("link, deploy, read the aliases, smoke the production url; the token only in the env", async () => {
    const f = fakes(deployed, (url) =>
      url.includes("/v13/deployments/")
        ? new Response(JSON.stringify({ alias: ["coin-counter.vercel.app", "coin-counter-eric.vercel.app"] }), { status: 200 })
        : new Response("<html>", { status: 200 }),
    );
    expect(await shipper(cfg, f.deps).deploy("/seed", "coin-counter")).toBe("https://coin-counter.vercel.app");
    expect(f.calls.map((c) => c.cmd.slice(0, 2).join(" "))).toEqual(["vercel link", "vercel deploy"]);
    for (const c of f.calls) {
      expect(c.cmd.join(" ")).not.toContain("tok_secret");
      expect(c.opts.env?.["VERCEL_TOKEN"]).toBe("tok_secret");
    }
    expect(f.fetched.map((x) => x.url)).toEqual(["https://api.vercel.com/v13/deployments/coin-counter-abc-eric.vercel.app", "https://coin-counter.vercel.app"]);
    // the smoke GET goes to the public page without the token
    expect(f.fetched[1]?.auth).toBe(null);
  });
  test("a production url behind protection fails with the reason; no token fails before anything runs", async () => {
    const f = fakes(deployed, (url) => new Response("{}", { status: url.includes("api.vercel.com") ? 200 : 401 }));
    await expect(shipper(cfg, f.deps).deploy("/seed", "p")).rejects.toThrow("answers 401: Vercel's deployment protection may cover it");
    const none = fakes(deployed);
    await expect(shipper(shipConfig({}, "mini"), none.deps).deploy("/seed", "p")).rejects.toThrow("add VERCEL_TOKEN to mini's .env");
    expect(none.calls).toHaveLength(0);
  });
  test("a production url that sends visitors to a sign-in page is not live", async () => {
    const f = fakes(deployed, (url) => {
      if (url.includes("api.vercel.com")) return new Response("{}", { status: 200 });
      const res = new Response("<html>sign in", { status: 200 });
      Object.defineProperty(res, "url", { value: "https://vercel.com/login?next=x" });
      return res;
    });
    await expect(shipper(cfg, f.deps).deploy("/seed", "p")).rejects.toThrow("sends visitors on to vercel.com");
  });
  test("ready reads the token and the CLI", () => {
    expect(shipper(cfg, fakes(() => ok()).deps).ready("vercel")).toBe(null);
    expect(shipper(shipConfig({}, "mini"), fakes(() => ok()).deps).ready("vercel")).toBe("add VERCEL_TOKEN to mini's .env");
  });
});
```

Every `rejects` is awaited. Without the `await`, bun ends the test before the promise settles and the test passes whatever the code does.

- [ ] **Step 2: Run them and see them fail**

Run: `SHELL=/bin/bash bun test src/core/shipper.test.ts`
Expected: FAIL. `./shipper` does not exist.

- [ ] **Step 3: Implement** `src/core/shipper.ts`

```ts
/**
 * The incubator's deploy, carried out by canopy and not by an agent (spec
 * amendment 2): the private GitHub repo, the push, the Vercel link and
 * deploy, and a smoke GET of the production url. Bun-only; every outside
 * call goes through injected deps so the tests drive it with fakes.
 */
import { deployReady, deploymentUrl, isVercelAppUrl, productionUrl, repoCandidates, smokeRefusal, vercelArgs, vercelProject } from "./deploy";
import { exec as realExec, type ExecOptions, type ExecResult } from "./exec";
import type { HostId } from "./types";

export interface Shipper {
  /** null when the host can be deployed to from here, else the park reason */
  ready(host: HostId): string | null;
  /** a new private repo under the gh login, "owner/name" */
  createRepo(slug: string, description: string): Promise<string>;
  /** a Vercel project of its own, made under a name the account did not have */
  project(slug: string): Promise<string>;
  /** origin set to the repo, HEAD pushed to main, hooks off */
  push(seedPath: string, repo: string): Promise<void>;
  /** linked and deployed to production; the public production url */
  deploy(seedPath: string, project: string): Promise<string>;
}

export interface ShipConfig {
  vercelToken: string | null;
  /** a Vercel team slug; null is the token's own account */
  vercelScope: string | null;
  backend: string;
}

export const shipConfig = (env: Record<string, string | undefined>, backend: string): ShipConfig => ({
  vercelToken: env["VERCEL_TOKEN"]?.trim() || null,
  vercelScope: env["VERCEL_SCOPE"]?.trim() || null,
  backend,
});

export interface ShipDeps {
  exec: (cmd: string[], opts?: ExecOptions) => Promise<ExecResult>;
  fetch: typeof fetch;
  which: (bin: string) => string | null;
}

const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const tail = (r: ExecResult): string => (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function shipper(cfg: ShipConfig, deps: ShipDeps = { exec: realExec, fetch, which: (b) => Bun.which(b) }): Shipper {
  const scopeQuery = cfg.vercelScope ? `?slug=${encodeURIComponent(cfg.vercelScope)}` : "";
  const api = (path: string, init: { method?: string; body?: string } = {}): Promise<Response> =>
    deps.fetch(`https://api.vercel.com${path}${scopeQuery}`, {
      ...init,
      headers: { authorization: `Bearer ${cfg.vercelToken ?? ""}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
  const needToken = (): string => {
    if (!cfg.vercelToken) throw new Error(`add VERCEL_TOKEN to ${cfg.backend}'s .env`);
    return cfg.vercelToken;
  };
  return {
    ready: (host) => deployReady(host, { vercelToken: cfg.vercelToken !== null, vercelCli: deps.which("vercel") !== null, backend: cfg.backend }),

    async createRepo(slug, description) {
      const who = await deps.exec(["gh", "api", "user", "--jq", ".login"], { timeoutMs: 30_000 });
      const owner = who.stdout.trim();
      if (who.code !== 0 || !/^[A-Za-z0-9-]+$/.test(owner)) throw new Error(`gh cannot say who it is logged in as: ${tail(who)}`);
      for (const name of repoCandidates(slug)) {
        const full = `${owner}/${name}`;
        const seen = await deps.exec(["gh", "repo", "view", full, "--json", "name"], { timeoutMs: 30_000 });
        if (seen.code === 0) continue;
        const made = await deps.exec(["gh", "repo", "create", full, "--private", "--disable-wiki", "--description", description.slice(0, 300)], { timeoutMs: 60_000 });
        if (made.code !== 0) throw new Error(`gh repo create ${full}: ${tail(made)}`);
        return full;
      }
      throw new Error(`every name from ${slug} to ${slug}-9 is taken on GitHub`);
    },

    async project(slug) {
      needToken();
      for (const name of repoCandidates(slug).map(vercelProject)) {
        const res = await api(`/v9/projects/${encodeURIComponent(name)}`);
        if (res.ok) continue;
        if (res.status !== 404) throw new Error(`the Vercel API answered ${res.status} for project ${name}`);
        // made here, so the link never has to make it: vercel link only
        // promises a non-interactive link to a project that exists
        const made = await api("/v11/projects", { method: "POST", body: JSON.stringify({ name }) });
        if (made.ok) return name;
        if (made.status === 409) continue;
        throw new Error(`the Vercel API answered ${made.status} making project ${name}`);
      }
      throw new Error(`every Vercel project name from ${slug} to ${slug}-9 is taken`);
    },

    async push(seedPath, repo) {
      const url = `https://github.com/${repo}.git`;
      const git = (args: string[], timeoutMs = 30_000): Promise<ExecResult> =>
        deps.exec(["git", ...NO_HOOKS, ...args], { cwd: seedPath, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });
      const has = await git(["remote", "get-url", "origin"]);
      const set = await git(has.code === 0 ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url]);
      if (set.code !== 0) throw new Error(`git remote: ${tail(set)}`);
      const pushed = await git(["push", "-u", "origin", "HEAD:refs/heads/main"], 300_000);
      if (pushed.code !== 0) throw new Error(`git push: ${tail(pushed)}`);
    },

    async deploy(seedPath, project) {
      const token = needToken();
      const env = { VERCEL_TOKEN: token, VERCEL_TELEMETRY_DISABLED: "1" };
      const link = await deps.exec(vercelArgs("link", project, cfg.vercelScope), { cwd: seedPath, timeoutMs: 120_000, env });
      if (link.code !== 0) throw new Error(`vercel link: ${tail(link)}`);
      const out = await deps.exec(vercelArgs("deploy", project, cfg.vercelScope), { cwd: seedPath, timeoutMs: 15 * 60_000, env });
      if (out.code !== 0) throw new Error(`vercel deploy: ${tail(out)}`);
      const dep = deploymentUrl(out.stdout);
      if (!dep) throw new Error("vercel deploy printed no deployment url");
      const res = await api(`/v13/deployments/${new URL(dep).host}`);
      const body: unknown = res.ok ? await res.json() : null;
      const aliases = isObj(body) && Array.isArray(body["alias"]) ? body["alias"].filter((a): a is string => typeof a === "string") : [];
      const url = productionUrl(aliases, dep);
      if (!isVercelAppUrl(url)) throw new Error(`the deploy answered ${url}, which is not a vercel.app address`);
      const smoke = await deps.fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
      const refused = smokeRefusal(smoke.status, url);
      if (refused) throw new Error(refused);
      // protection can answer with a redirect to a sign-in page, which a
      // followed redirect turns into a 200
      const landed = smoke.url ? new URL(smoke.url).host : new URL(url).host;
      if (landed !== new URL(url).host) {
        throw new Error(`${url} sends visitors on to ${landed}, likely a sign-in page: turn off deployment protection for production, then resume`);
      }
      return url;
    },
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `SHELL=/bin/bash bun test src/core/shipper.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/shipper.ts src/core/shipper.test.ts
git commit -m "feat(incubator): the shipper, a private repo, a push and a Vercel deploy in canopy's code"
```

---

## Task 9: the Incubator ships

**Files:**
- Modify: `src/core/types.ts` (`Sprout.vercelProject?: string`)
- Modify: `src/core/sprout.ts` (`parseSproutRecord` checks it)
- Modify: `src/core/incubator.ts` (`IncubatorDeps.ship`, the real `ship`)
- Test: `src/core/incubator.test.ts`

**Interfaces:**
- Consumes: `Shipper` (Task 8, as a type), `isVercelAppUrl` (Task 7).
- Produces: `IncubatorDeps.ship?: Shipper | null`; a sprout goes `deploying` then `live` with `privateRepo`, `vercelProject` and `url` on record, and calls `changed(s, "live")`. `addInputs` answers 409 while a sprout is `deploying`.

- [ ] **Step 1: Write the failing tests** in the `describe("scout and build-new", …)` block of `src/core/incubator.test.ts`. Replace the placeholder's last assertion in the build-new test with a new test, and add a `FakeShip`:

```ts
class FakeShip implements Shipper {
  calls: string[] = [];
  readyAs: string | null = null;
  failDeploy: string | null = null;
  /** a deploy waits for release() while this is set */
  hold = false;
  private held: (() => void) | null = null;
  release(): void {
    this.hold = false;
    this.held?.();
  }
  ready(): string | null {
    return this.readyAs;
  }
  async createRepo(slug: string): Promise<string> {
    this.calls.push(`create ${slug}`);
    return `eric/${slug}`;
  }
  async project(slug: string): Promise<string> {
    this.calls.push(`project ${slug}`);
    return slug;
  }
  async push(_seed: string, repo: string): Promise<void> {
    this.calls.push(`push ${repo}`);
  }
  async deploy(_seed: string, project: string): Promise<string> {
    this.calls.push(`deploy ${project}`);
    if (this.hold) await new Promise<void>((resolve) => (this.held = resolve));
    if (this.failDeploy) throw new Error(this.failDeploy);
    return `https://${project}.vercel.app`;
  }
}

  /** a sprout through scout and build-new, at canopy's ship */
  const shipped = async (w: World): Promise<Sprout> => {
    const s = await scouting(w);
    await end(w, s.id, { ".canopy/pick.json": PICK });
    return end(w, s.id, { ".canopy/smoke.md": "status: 200" });
  };

  test("ship makes the private repo, pushes, deploys and goes live", async () => {
    const ship = new FakeShip();
    const w = chain(ship);
    const s = await shipped(w);
    expect(ship.calls).toEqual(["create coin-counter", "project coin-counter", "push eric/coin-counter", "deploy coin-counter"]);
    expect(s.status).toBe("live");
    expect(s.url).toBe("https://coin-counter.vercel.app");
    expect(s.privateRepo).toBe("eric/coin-counter");
    expect(s.vercelProject).toBe("coin-counter");
  });

  test("a deploy that fails parks with the reason; resume skips the repo and project already made", async () => {
    const ship = new FakeShip();
    ship.failDeploy = "vercel deploy: Build failed";
    const w = chain(ship);
    const s = await shipped(w);
    expect(s.status).toBe("parked");
    expect(s.parked).toBe("deploy: vercel deploy: Build failed");
    ship.failDeploy = null;
    ship.calls = [];
    await w.inc.resume(s.id, "retry");
    await w.inc.idle();
    expect(ship.calls).toEqual(["push eric/coin-counter", "deploy coin-counter"]);
    expect(now(w, s.id).status).toBe("live");
  });

  test("a host that is not ready parks before anything is made", async () => {
    const ship = new FakeShip();
    ship.readyAs = "add VERCEL_TOKEN to mini's .env";
    const s = await shipped(chain(ship));
    expect(s.parked).toBe("add VERCEL_TOKEN to mini's .env");
    expect(ship.calls).toEqual([]);
  });

  test("no shipper parks with the reason", async () => {
    const s = await shipped(chain(null));
    expect(s.parked).toBe("this backend has no deploy set up");
  });

  /** a sprout whose deploy is under way and held there until `release` */
  const midDeploy = async (ship: FakeShip, w: World): Promise<Sprout> => {
    const s = await scouting(w);
    await end(w, s.id, { ".canopy/pick.json": PICK });
    const cur = now(w, s.id);
    await w.seeds.write(cur.seedPath, ".canopy/smoke.md", "status: 200");
    w.flows.move(cur.flows.at(-1)?.flowId ?? "", { status: "done" });
    for (let i = 0; i < 200 && !ship.calls.includes("deploy coin-counter"); i++) await Bun.sleep(1);
    return now(w, s.id);
  };

  test("new input while the deploy runs is refused, so a stale build never goes live over it", async () => {
    const ship = new FakeShip();
    ship.hold = true;
    const w = chain(ship);
    const s = await midDeploy(ship, w);
    expect(s.status).toBe("deploying");
    await expect(w.inc.addInputs(s.id, intake({ text: "make it blue" }))).rejects.toMatchObject({ status: 409 });
    ship.release();
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("live");
  });

  test("a restart mid-deploy pushes and deploys again, and makes no second repo or project", async () => {
    const first = new FakeShip();
    first.hold = true;
    const w = chain(first);
    const s = await midDeploy(first, w);
    expect(s.privateRepo).toBe("eric/coin-counter");
    expect(s.vercelProject).toBe("coin-counter");
    const again = new FakeShip();
    const r = chain(again);
    r.store.records = w.store.records;
    r.store.inputs = w.store.inputs;
    r.seeds.files = w.seeds.files;
    r.flows.flows = w.flows.flows;
    for (const p of w.seeds.files.keys()) r.repos.add(p.replace("/root/", ""));
    await r.inc.restore();
    await r.inc.idle();
    expect(again.calls).toEqual(["push eric/coin-counter", "deploy coin-counter"]);
    expect(now(r, s.id).status).toBe("live");
    first.release();
    await w.inc.idle();
  });
```

Change `chain` to take the shipper, and import `type Shipper` from `./shipper`:

```ts
  const chain = (ship: Shipper | null = null) => {
    const w = world({ ship });
    w.workflows.set("scout", SCOUT_STAGE);
    w.workflows.set("build-new", BUILD_STAGE);
    return w;
  };
```

The Task 6 build-new test keeps its step-status assertions and ends at `expect(w.seeds.commits.at(-1)?.message).toBe("build: coin counter");`. Drop its `canopy cannot deploy yet` line.

- [ ] **Step 2: Run them and see them fail**

Run: `SHELL=/bin/bash bun test src/core/incubator.test.ts`
Expected: FAIL. `ship` is not a dep, and the sprout parks with "canopy cannot deploy yet".

- [ ] **Step 3: Implement.** Add `vercelProject?: string` to `interface Sprout` after `privateRepo`, with the doc `/** the Vercel project canopy deploys it as, chosen once */`. Add `vercelProject` to the `optStr` checks in `parseSproutRecord`. In `IncubatorDeps`:

```ts
  /** canopy's own deploy; null when this backend has none */
  ship?: Shipper | null;
```

with `import type { Shipper } from "./shipper";` (a type import keeps `incubator.ts` off `shipper.ts`'s runtime) and `isVercelAppUrl` from `./deploy`. Replace the placeholder `ship`:

```ts
  /** canopy's own deploy, after build-new: never an agent's step. Each
   *  thing made is put on record as soon as it exists, so a resume or a
   *  restart makes nothing twice. A stop that lands mid-deploy cannot halt
   *  vercel, but the sprout stays stopped. */
  private async ship(s: Sprout): Promise<void> {
    const ship = this.deps.ship ?? null;
    if (!s.pick) return this.park(s, "nothing was picked to deploy");
    if (!ship) return this.park(s, "this backend has no deploy set up");
    const ready = ship.ready(s.pick.host);
    if (ready) return this.park(s, ready);
    try {
      if (!s.privateRepo) {
        s.privateRepo = await ship.createRepo(s.slug, s.title);
        await this.changed(s);
      }
      if (!s.vercelProject) {
        s.vercelProject = await ship.project(s.slug);
        await this.changed(s);
      }
      if (sproutEnded(s)) return;
      await ship.push(s.seedPath, s.privateRepo);
      if (sproutEnded(s)) return;
      const url = await ship.deploy(s.seedPath, s.vercelProject);
      if (sproutEnded(s)) return;
      if (!isVercelAppUrl(url)) return this.park(s, `the deploy answered ${url}, which is not a vercel.app address`);
      s.url = url;
      s.status = "live";
      delete s.parked;
      await this.changed(s, "live");
      this.pump();
    } catch (err) {
      await this.park(s, `deploy: ${msg(err)}`);
    }
  }
```

In `addInputs`, beside the `sproutEnded` refusal:

```ts
    // a deploy cannot take the new input in, and would go live over it
    if (s.status === "deploying") throw new IncubatorError(409, "this project is deploying; add to it once the deploy ends");
```

A restored `deploying` sprout has no flow, so `restore` requeues it (`holdsSlot`), and `pump` runs `ship` again. The restart test pins that. Check that `resume` from a park whose last flow is done takes the `queued` path. It does: `cur.outcome` is set, so `f` is undefined.

- [ ] **Step 4: Run the tests and see them pass**

Run: `SHELL=/bin/bash bun test src/core/incubator.test.ts src/core/sprout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/sprout.ts src/core/incubator.ts src/core/incubator.test.ts
git commit -m "feat(incubator): ship makes the private repo, deploys and goes live, once each"
```

---

## Task 10: the vault hears of live and rejected

**Files:**
- Modify: `src/core/sproutnote.ts`
- Test: `src/core/sproutnote.test.ts`

**Interfaces:**
- Consumes: `NoteEvent` already holds `"live"` and `"rejected"` (Task 6), and `Sprout.pick`, `privateRepo` and `url` (Tasks 1 and 9).
- Produces: `DAILY_EVENTS` holds `started`, `parked`, `live` and `rejected`. `dailyLine` words both new events. `sproutNote` gets a `## Where it lives` section.

- [ ] **Step 1: Write the failing tests** in `src/core/sproutnote.test.ts`, in the `daily note` describe and the `sproutNote` describe:

```ts
  test("going live and being turned down each put a line in the day", () => {
    expect(DAILY_EVENTS.has("live")).toBe(true);
    expect(DAILY_EVENTS.has("rejected")).toBe(true);
    expect(dailyLine(sprout({ status: "live", url: "https://change-counter.vercel.app" }), "live")).toContain(
      "- **incubator: Change counter** - live at https://change-counter.vercel.app. Note:",
    );
    expect(dailyLine(sprout({ status: "rejected", parked: "a coin app\nalready exists" }), "rejected")).toContain(
      "turned down at eval: a coin app already exists.",
    );
  });
```

```ts
  test("a live sprout's note names the pick, the private repo and the url; a rejected one says why", () => {
    const live = sproutNote(
      sprout({
        status: "live",
        pick: { kind: "new", host: "vercel", why: "nothing close exists" },
        privateRepo: "eric/change-counter",
        url: "https://change-counter.vercel.app",
      }),
      "Count coins.",
    );
    expect(live).toContain("status: live\n");
    expect(live).toContain("Live at https://change-counter.vercel.app.");
    expect(live).toContain("## Where it lives\n\n- Pick: new, on vercel. nothing close exists\n- Repo: https://github.com/eric/change-counter (private)\n- Url: https://change-counter.vercel.app\n");
    const no = sproutNote(sprout({ status: "rejected", parked: "a coin app already exists" }), null);
    expect(no).toContain("Turned down at eval: a coin app already exists");
    expect(no).not.toContain("## Where it lives");
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `SHELL=/bin/bash bun test src/core/sproutnote.test.ts`
Expected: FAIL. `live` is not a daily event, and there is no "Where it lives" section.

- [ ] **Step 3: Implement.** In `src/core/sproutnote.ts`:

Change the header comment's "(later phases add live and rejected)" to "or goes live or is turned down".

```ts
export const DAILY_EVENTS: ReadonlySet<NoteEvent> = new Set<NoteEvent>(["started", "parked", "live", "rejected"]);
```

In `dailyLine`, replace the `what` chain with a switch:

```ts
const eventWord = (s: Sprout, event: NoteEvent): string => {
  switch (event) {
    case "started":
      return `started in canopy's incubator as ${s.repoId}`;
    case "parked":
      return `parked: ${flat(s.parked ?? "") || "no reason given"}`;
    case "live":
      return `live at ${s.url ?? "an address canopy did not keep"}`;
    case "rejected":
      return `turned down at eval: ${flat(s.parked ?? "") || "no reason given"}`;
    default:
      return event;
  }
};

export function dailyLine(s: Sprout, event: NoteEvent): string {
  return `\n- **incubator: ${s.title}** - ${eventWord(s, event)}. Note: ${link(s)}\n`;
}
```

In `statusLine`, ahead of the parked line:

```ts
  if (s.status === "live" && s.url) return `Live at ${s.url}.`;
  if (s.status === "rejected") return `Turned down at eval: ${flat(s.parked ?? "") || "no reason given"}`;
```

Add the section builder and put it in `sproutNote` after the `## Stages` block and before `## Spent`:

```ts
/** the pick, the repo and the address, once there are any */
function whereLines(s: Sprout): string[] {
  const lines = [
    ...(s.pick ? [`- Pick: ${s.pick.kind}, on ${s.pick.host}. ${flat(s.pick.why)}`] : []),
    ...(s.privateRepo ? [`- Repo: https://github.com/${s.privateRepo} (private)`] : []),
    ...(s.url ? [`- Url: ${s.url}`] : []),
  ];
  return lines.length ? ["## Where it lives", "", ...lines, ""] : [];
}
```

```ts
    ...(stages.length ? stages : ["None has run yet."]),
    "",
    ...whereLines(s),
    "## Spent",
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `SHELL=/bin/bash bun test src/core/sproutnote.test.ts src/core/incubator.test.ts`
Expected: PASS. The incubator tests that count daily lines may now see one more for a live or rejected sprout. If one fails on a count, read it. A live or rejected line is right, so update the count. Don't take the event out.

- [ ] **Step 5: Commit**

```bash
git add src/core/sproutnote.ts src/core/sproutnote.test.ts src/core/incubator.test.ts
git commit -m "feat(incubator): the vault note and the daily note hear of live and rejected"
```

---

## Task 11: the server wires the shipper, and the image carries vercel

**Files:**
- Modify: `src/core/term.ts` (`SECRET_ENV`)
- Modify: `src/server/index.ts` (the ship config, `ship` in the Incubator's deps, `opts.incubator.ship`)
- Modify: `Dockerfile`, `docker-compose.yml`, `docs/deploy.md`
- Test: `src/server/incubator.test.ts`

**Interfaces:**
- Consumes: `shipConfig`, `shipper`, `Shipper` (Task 8); `IncubatorDeps.ship` (Task 9).
- Produces: `startServer({ incubator: { ship } })` takes a `Shipper | null` for tests. `VERCEL_TOKEN` is gone from canopy's env once the server has started.

- [ ] **Step 1: Write the failing test** in `src/server/incubator.test.ts`. The suite starts one server in `beforeAll` through `scratchServer`, and that start is where canopy deletes its secrets. So set the token just before that call, pass `ship: null` beside the suite's other incubator options, and assert in a test:

```ts
  process.env["VERCEL_TOKEN"] = "tok_test";
  server = await scratchServer({
    root,
    port: 0,
    chan: null,
    harnesses: ["claude"],
    incubator: { autostart: false, transcribe: async () => "count the quarters", notes: null, ship: null },
  });
```

```ts
test("the Vercel token leaves canopy's env once the server has read it", () => {
  expect(process.env["VERCEL_TOKEN"]).toBeUndefined();
});
```

In `afterAll`, add `delete process.env["VERCEL_TOKEN"];` so a failing run leaves nothing for the next file.

- [ ] **Step 2: Run it and see it fail**

Run: `SHELL=/bin/bash bun test src/server/incubator.test.ts`
Expected: FAIL. `ship` is not in the `incubator` options type, and the token is still in the env.

- [ ] **Step 3: Implement.**

`src/core/term.ts`:

```ts
export const SECRET_ENV = ["CANOPY_VAULT_TOKEN", "CANOPY_TRANSCRIBE_KEY", "VERCEL_TOKEN"] as const;
```

Update the comment above it so it names the Vercel token too.

`src/server/index.ts`: import `shipConfig, shipper, type Shipper` from `../core/shipper`. Widen the option:

```ts
  incubator?: { autostart?: boolean; transcribe?: Transcriber | null; notes?: NoteSink | null; ship?: Shipper | null };
```

Read the config beside the other two, before the delete loop:

```ts
  const vault = vaultConfig();
  const speech = transcribeConfig();
  const ship = shipConfig(process.env, runnerOpts.backend);
```

Extend the not-in-test log with: `if (!ship.vercelToken) console.error("incubator: no VERCEL_TOKEN, so a built project parks before its deploy");`

In the `new Incubator({...})` deps, beside `notes`:

```ts
        ship: opts.incubator?.ship !== undefined ? opts.incubator.ship : shipper(ship),
```

`Dockerfile`: in the `shells` stage, after the codex line:

```dockerfile
# The Vercel CLI, for the incubator's deploy. canopy runs it itself, with
# VERCEL_TOKEN in that one process's env; no agent's allowlist names it.
# Pinned, so a CLI release cannot change what a deploy does unseen.
RUN bun add -g vercel@61.1.0 || echo "vercel not installed at build; the incubator parks before a deploy"
```

The canopy runtime stage is `FROM shells`, so the server gets the binary too. Check that `bun add -g` puts it on the PATH the server sees, the same way codex lands. If codex has a symlink line into `/usr/local/bin`, give vercel one too.

`docker-compose.yml`: on the canopy service, after `CANOPY_TRANSCRIBE_MODEL`:

```yaml
      # the incubator's deploy (docs/deploy.md): a Vercel token, scoped to
      # the one team the incubator's projects go to, and that team's slug
      # when it is not the token's own account. Readable through
      # /proc/<canopy>/environ like the two above.
      - VERCEL_TOKEN=${VERCEL_TOKEN:-}
      - VERCEL_SCOPE=${VERCEL_SCOPE:-}
```

Leave the shells service alone. Its env must not get the token.

`docs/deploy.md`: in "The incubator", after the transcribe bullet:

```markdown
- `VERCEL_TOKEN` and, for a team that is not the token's own account,
  `VERCEL_SCOPE` (the team's slug). With them, a project that passes its
  accept step gets a private GitHub repo under the `gh` login, a push, a
  Vercel project of its own name and a production deploy, all from
  canopy's own code. Without the token the project parks at deploy with
  "add VERCEL_TOKEN to <backend>'s .env". Make the token at
  vercel.com/account/tokens, scoped to one team kept for incubator
  projects. A production url behind Vercel's deployment protection answers
  401 and parks the project with that reason. Turn protection off for
  production in that team, or per project, then resume.
```

Add the token to the sentence after the list: "canopy reads the vault token, the transcribe key and the Vercel token once at start and then deletes all three from its own environment...".

- [ ] **Step 4: Run the test and see it pass, then the server suite**

Run: `SHELL=/bin/bash bun test src/server/incubator.test.ts && bun run typecheck`
Expected: PASS. Every other `startServer` in the tests passes no `ship`, so they get a real `shipper` built from an env with no token, which parks before running anything.

- [ ] **Step 5: Commit**

```bash
git add src/core/term.ts src/server/index.ts src/server/incubator.test.ts Dockerfile docker-compose.yml docs/deploy.md
git commit -m "feat(incubator): the server wires the shipper; vercel in the image, its token out of the env"
```

---

## Task 12: the page shows a park and a live project

**Files:**
- Modify: `ui/src/inbox.ts` (`InboxItem.kind` gains `"park"`; `sproutItem` takes the flows)
- Modify: `ui/src/store.ts` (`answerInbox` for a sprout `choice`)
- Modify: `ui/src/components/Inbox.tsx` (the park form)
- Modify: `ui/src/sprouts.ts` (`WORKFLOW_STAGE` gains `ship`)
- Modify: `ui/src/components/Incubator.tsx` (`SproutSheet` shows the pick, the repo and the url, and stop on a park)
- Test: `ui/src/inbox.test.ts`, `ui/src/sprouts.test.ts`

**Interfaces:**
- Consumes: `Sprout.pick`, `privateRepo`, `url`; `SHIP` from `src/core/sprout.ts` (browser-safe); the store's `resumeSprout(id, "continue" | "retry")` and `stopSprout(id)`.
- Produces: a sprout `park` item, keyed `sprout:<id>` (one key per sprout, since a sprout is never at a clarify and parked at once).

- [ ] **Step 1: Write the failing tests.** In `ui/src/inbox.test.ts`, inside the describe that holds the `sprout` fixture:

```ts
  test("a park with no gated flow behind it is one park item; a gated flow's park stays the flow's", () => {
    const parked: Sprout = { ...sprout, status: "parked", parked: "add VERCEL_TOKEN to mini's .env", questions: [], updatedAt: 25_000, flows: [{ workflow: "build-new", flowId: "fb", outcome: "done" }] };
    const items = mergeInbox([], {}, {}, 30_000, { ...ctx, sprouts: [parked] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "sprout:sp_000000000001", source: "sprout", kind: "park", who: "incubator", repo: "Coin counter", title: "is parked", detail: "add VERCEL_TOKEN to mini's .env", at: 25_000 });
    const behind: Sprout = { ...parked, flows: [{ workflow: "scout", flowId: "fs" }] };
    const gated = mergeInbox([], {}, { fs: flow({ id: "fs", status: "gated" }) }, 30_000, { ...ctx, sprouts: [behind] });
    expect(gated.map((i) => i.source)).toEqual(["flow"]);
  });
```

If the `flow` helper in this file does not take `status`, pass it the way the file's gate tests do.

In `ui/src/sprouts.test.ts`:

```ts
  test("canopy's deploy shows as the deploy stage", () => {
    const s = sprout({ status: "parked", parked: "deploy: vercel deploy: Build failed", flows: [{ workflow: "scout", flowId: "a", outcome: "done" }, { workflow: "build-new", flowId: "b", outcome: "done" }], pick: { kind: "new", host: "vercel", why: "w" } });
    expect(stageAt(s)).toBe("deploy");
  });
```

Use the file's own fixture builder. If it has none, build the sprout the way its other tests do.

- [ ] **Step 2: Run them and see them fail**

Run: `SHELL=/bin/bash bun test ui/src/inbox.test.ts ui/src/sprouts.test.ts`
Expected: FAIL. No park item, and the stage is null, since `ship` has no stage.

- [ ] **Step 3: Implement.**

`ui/src/sprouts.ts`: import `SHIP` from `../../src/core/sprout` beside `nextWorkflow`, and add `[SHIP]: "deploy",` to `WORKFLOW_STAGE`.

`ui/src/inbox.ts`: widen the kind to `"permission" | "question" | "guard" | "gate" | "clarify" | "park"`. Replace `sproutItem`:

```ts
function sproutItem(s: Sprout, flows: Readonly<Record<string, Flow>>, ctx: InboxContext): InboxItem | null {
  const base = {
    key: `sprout:${s.id}`,
    source: "sprout" as const,
    id: s.id,
    repoId: ctx.repos.some((r) => r.id === s.repoId) ? s.repoId : null,
    repo: s.title,
    where: "canopy incubator",
    left: null,
    until: null,
  };
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
```

Pass `flows` at the call: `const it = sproutItem(s, flows, ctx);`. The sprouts are home's, so their flow ids are home's bare ids, which is how `flows` keys them.

`ui/src/store.ts`, `answerInbox`, the sprout branch:

```ts
    if (item.source === "sprout") {
      if ("choice" in answer) {
        if (answer.choice === "stop") return get().stopSprout(item.id);
        return get().resumeSprout(item.id, answer.choice);
      }
      if ("skip" in answer) return get().answerSprout(item.id, null);
      if (!("answers" in answer)) throw new Error("clarify's questions take answers, or go on assumptions");
      return get().answerSprout(item.id, answer.answers);
    }
```

`ui/src/components/Inbox.tsx`: the gate form serves a park too. Change `item.kind === "gate"` to `item.kind === "gate" || item.kind === "park"`. A park has no `budget`, so the form shows continue, retry the step and stop as it is.

`ui/src/components/Incubator.tsx`, `SproutSheet`:
- In the parked block, add a stop button after a `<span className="spacer" />`, through `act(() => stopSprout(id))`. Take `stopSprout` from the store the way the sheet takes `resumeSprout`.
- After the parked block, add the place it lives, shown once any of it exists:

```tsx
        {(sprout.pick || sprout.privateRepo || sprout.url) && (
          <div className="plan-row">
            <div className="eyebrow">where it lives</div>
            {sprout.pick && (
              <p>
                {sprout.pick.kind}, on {sprout.pick.host}. {sprout.pick.why}
              </p>
            )}
            {sprout.privateRepo && (
              <p>
                <a href={`https://github.com/${sprout.privateRepo}`} target="_blank" rel="noreferrer">
                  {sprout.privateRepo}
                </a>{" "}
                (private)
              </p>
            )}
            {sprout.url && (
              <p>
                <a href={sprout.url} target="_blank" rel="noreferrer">
                  {sprout.url}
                </a>
              </p>
            )}
          </div>
        )}
```

Use a class the sheet already uses for a labelled block if `plan-row` is not one. Check with `grep -n "className=\"plan" ui/src/components/RunSheet.tsx ui/src/components/Incubator.tsx`. Don't add css for this.

- [ ] **Step 4: Run the tests and see them pass, then typecheck the page**

Run: `SHELL=/bin/bash bun test ui/src/inbox.test.ts ui/src/sprouts.test.ts && bun run typecheck`
Expected: PASS. A `switch` over `InboxItem.kind` anywhere else in `ui/` that lists every kind fails the typecheck until it handles `park`. Give it the gate's case.

- [ ] **Step 5: Commit**

```bash
git add ui/src/inbox.ts ui/src/inbox.test.ts ui/src/store.ts ui/src/components/Inbox.tsx ui/src/sprouts.ts ui/src/sprouts.test.ts ui/src/components/Incubator.tsx
git commit -m "feat(incubator): a park joins the inbox, and the sheet shows the pick, the repo and the url"
```

---

## Task 13: the spec, the docs and the gates

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-incubator-design.md` (amendment 2)
- Modify: `CLAUDE.md` (the incubator bullet)

- [ ] **Step 1: Amendment 2.** Append it to the spec after amendment 1, headed `### Amendment 2: phase 3, 2026-10-02`. It holds the eleven rulings from the top of this plan, in that order and in the same words. Then add one line on the Vercel project name: canopy makes the project through `POST /v11/projects` under the first candidate `GET /v9/projects/<name>` answers 404 for, going on to the next on a 409, so it never deploys over a project the account already has. A smoke GET that lands on another host after its redirects, a sign-in page, is not live. Mark the spec's research row, the `build-new` deploy and file steps, and the `git-push` and `vercel deploy` allowlist entries as replaced by amendment 2, rulings 1 and 3. Strike nothing. Add "(see amendment 2)" after each.

- [ ] **Step 2: CLAUDE.md.** In the incubator bullet, after the sentence on the `clarify` workflow, add one sentence of the same density:

"`scout` (Research reads only devhub's `manifest.json` and `references.json` and the workspace's READMEs, through `withWorkspaceRead`; Eval writes `.canopy/pick.json`, which its check runs `"$CANOPY_CLI" incubator pick-check` on, `runCheck` setting `CANOPY_CLI` to canopy's own `bin/canopy.ts`; the Incubator reads it through `parsePick`, `pickRefusal` and `phaseRefusal`, which parks anything but a `new` pick on `vercel` in phase 3; a judge rejection at Eval is `rejected`) and `build-new` (Scaffold, Test, Accept, the status following the step through `statusFor`) are unlisted too, and after Accept the Incubator's `ship` (canopy's code, never an agent's step: `core/deploy.ts` pure, `core/shipper.ts` over `gh`, git with hooks off, the pinned `vercel` CLI with `VERCEL_TOKEN` in its env alone and the Vercel API) makes the private repo, the Vercel project, the push and the production deploy, each put on record as it exists so a resume makes nothing twice, and goes `live` only on a `vercel.app` url a smoke GET answers; a park with no gated flow behind it is a sprout `park` item in the inbox."

Add `VERCEL_TOKEN` to the sentence that lists what is deleted from canopy's env and listed in `PRIVATE_ENV`.

- [ ] **Step 3: The gates**

Run: `bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build`
Expected: all four pass. If a test unrelated to the incubator is flaky, run it alone twice before you call it flaky. The zshrc memory names the usual cause.

- [ ] **Step 4: An optional live run, behind a switch.** In `src/core/shipper.test.ts`, add a test gated on `CANOPY_INCUBATOR_IT=1` and a set `VERCEL_TOKEN`. It makes a temp static site (`index.html` alone), a real private repo named `canopy-it-<6 hex>`, a push, a deploy, and a GET of the url. Then it deletes the Vercel project (`DELETE /v9/projects/<name>`) and the repo (`gh repo delete --yes`). Skip it otherwise with `test.skipIf`. Don't run it as part of this plan. It creates outside resources, so Eric runs it once he has a token.

Add to the file's imports: `mkdtemp`, `rm` and `writeFile` from `node:fs/promises`, `tmpdir` from `node:os`, `join` from `node:path`, `randomBytes` from `node:crypto`, and `exec` from `./exec`.

```ts
const LIVE = process.env["CANOPY_INCUBATOR_IT"] === "1" && Boolean(process.env["VERCEL_TOKEN"]);
test.skipIf(!LIVE)("a real static site goes live and is cleaned up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canopy-it-"));
  const name = `canopy-it-${randomBytes(3).toString("hex")}`;
  const ship = shipper(shipConfig(process.env, "it"));
  let repo: string | null = null;
  let project: string | null = null;
  try {
    await writeFile(join(dir, "index.html"), "<!doctype html><title>canopy it</title><p>ok</p>");
    for (const args of [["init", "-b", "main"], ["add", "-A"], ["-c", "user.name=canopy", "-c", "user.email=canopy@localhost", "commit", "-m", "it"]]) {
      expect((await exec(["git", ...args], { cwd: dir })).code).toBe(0);
    }
    repo = await ship.createRepo(name, "canopy integration test, deleted at the end");
    project = await ship.project(name);
    await ship.push(dir, repo);
    const url = await ship.deploy(dir, project);
    expect(url).toMatch(/^https:\/\/.+\.vercel\.app$/);
  } finally {
    if (project) {
      const scope = process.env["VERCEL_SCOPE"] ? `?slug=${encodeURIComponent(process.env["VERCEL_SCOPE"])}` : "";
      await fetch(`https://api.vercel.com/v9/projects/${project}${scope}`, { method: "DELETE", headers: { authorization: `Bearer ${process.env["VERCEL_TOKEN"] ?? ""}` } });
    }
    if (repo) await exec(["gh", "repo", "delete", repo, "--yes"]);
    await rm(dir, { recursive: true, force: true });
  }
}, 20 * 60_000);
```

`gh repo delete` needs the `delete_repo` scope, which the mini's `GH_TOKEN` lacks. Run this on the Mac, or delete the repo by hand if the scope is missing.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-10-01-incubator-design.md CLAUDE.md src/core/shipper.test.ts
git commit -m "docs(incubator): amendment 2 for phase 3, and the shipper's live test behind a switch"
```

---

## After the plan

Merge the branch to `main` only when Eric says so. Then `bun run redeploy --pull` on the mini, with `VERCEL_TOKEN` (and `VERCEL_SCOPE` if a team) in the mini's `.env` first. The laundromat sprout parked at "the scout workflow is not installed". Resuming it after the redeploy is the first real run of phase 3.
