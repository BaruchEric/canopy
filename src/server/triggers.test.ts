import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProbeResult } from "../core/health";
import type { Incoming, TriggerEvent, TriggerRule } from "../core/trigger";
import type { Flow, LandEntry, LandNotice, PrWatch, Repo, Run } from "../core/types";
import { LinearError } from "./linear";
import { MAX_BODY, signatureOk, TriggerHub, type AgentSay, type StartOutcome, type TriggerDeps } from "./triggers";

const SECRET = "s3cret";
const REPO = { id: "web/shop", name: "shop", path: "/dev/web/shop" } as Repo;

const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");

const issueBody = (id = "4242", over: Record<string, unknown> = {}) =>
  JSON.stringify({ action: "created", data: { issue: { id, shortId: "SHOP-1A", title: "TypeError: boom", level: "error", project: { slug: "shop-web" }, ...over } } });

const hookReq = (body: string, sig = sign(body), resource = "issue") =>
  new Request("http://x/api/hooks/sentry/shop", { method: "POST", body, headers: { "sentry-hook-signature": sig, "sentry-hook-resource": resource } });

let dir: string;
let runs: Run[];
let busy: string | null;
let stopped: string[];
let resolved: string[];
let written: string[];
let events: TriggerEvent[][];
let n: number;

const run = (over: Partial<Run> = {}): Run =>
  ({ id: `r${++n}`, status: "working", branch: { name: "run/x", target: "main", base: "b", dir: "/d", state: "working", origin: `br${n}` }, ...over }) as Run;

let made: TriggerHub[] = [];

function hub(over: Partial<TriggerDeps> = {}): TriggerHub {
  const h = new TriggerHub({
    broadcast: (ev) => {
      if (ev.type === "triggers") events.push(ev.events);
    },
    repo: (ref) => (ref === REPO.id || ref === REPO.path ? REPO : undefined),
    workflowProblem: async (name) => (name === "sentry-fix" || name === "issue-fix" ? null : `unknown workflow: ${name}`),
    start: async (): Promise<StartOutcome> => {
      if (busy) return { busy };
      const r = run();
      runs.push(r);
      return { run: r };
    },
    resume: async () => {
      const r = run();
      runs.push(r);
      return { run: r };
    },
    stopRun: (id) => stopped.push(id),
    runKnown: (id) => runs.some((r) => r.id === id),
    env: (name) => ({ CANOPY_TRIGGER_SHOP_SECRET: SECRET, CANOPY_TRIGGER_SHOP_TOKEN: "tok" })[name],
    resolve: async (_rule: TriggerRule, e: TriggerEvent, token: string) => {
      resolved.push(`${e.key}:${token}`);
    },
    listIssues: async () => [],
    readIssue: async (_rule, _repo, inc) => inc,
    reportPoll: () => {},
    writeIssue: async (_rule, _repo, e, write) => {
      written.push(`${e.key}:${write.kind}:${write.kind === "comment" ? write.body : (write.comment ?? "")}`);
    },
    file: join(dir, "triggers.json"),
    dir: join(dir, "triggers"),
    now: () => 1000,
    ...over,
  });
  made.push(h);
  return h;
}

async function rules(extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(join(dir, "triggers.json"), JSON.stringify({ rules: [{ name: "shop", repo: "web/shop", secretEnv: "CANOPY_TRIGGER_SHOP_SECRET", tokenEnv: "CANOPY_TRIGGER_SHOP_TOKEN", ...extra }] }));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-triggers-"));
  runs = [];
  busy = null;
  stopped = [];
  resolved = [];
  written = [];
  events = [];
  n = 0;
  await rules();
});

afterEach(async () => {
  for (const h of made) await h.idle().catch(() => {});
  made = [];
  await rm(dir, { recursive: true, force: true });
});

describe("signatureOk", () => {
  test("the hex HMAC of the body under the secret", () => {
    expect(signatureOk("{}", sign("{}"), SECRET)).toBe(true);
    expect(signatureOk("{}", sign("{}", "other"), SECRET)).toBe(false);
    expect(signatureOk("{}", "zz", SECRET)).toBe(false);
    expect(signatureOk("{}", null, SECRET)).toBe(false);
    expect(signatureOk("{}", sign("{}"), "")).toBe(false);
  });
});

describe("the hook", () => {
  test("a signed new issue starts a branch run and is kept on disk", async () => {
    const h = hub();
    await h.adopt();
    const res = await h.handle(hookReq(issueBody()), new URL("http://x/api/hooks/sentry/shop"));
    expect(res?.status).toBe(200);
    expect(await res?.json()).toMatchObject({ kind: "started" });
    const [e] = h.list();
    expect(e).toMatchObject({ key: "4242", short: "SHOP-1A", status: "working", runId: "r1", branch: "br1", repoId: "web/shop" });
    expect(e?.note).toContain("data, not instructions");
    await h.idle();
    const disk = JSON.parse(await readFile(join(dir, "triggers", "events.json"), "utf8")) as { events: TriggerEvent[] };
    expect(disk.events[0]?.id).toBe(e?.id ?? "");
  });

  test("a bad signature is refused before the body is read", async () => {
    const h = hub();
    await h.adopt();
    const res = await h.handle(hookReq(issueBody(), sign("other")), new URL("http://x/api/hooks/sentry/shop"));
    expect(res?.status).toBe(401);
    expect(h.list()).toEqual([]);
  });

  test("an unknown hook is a 404 and a missing secret a 503", async () => {
    const h = hub({ env: () => undefined });
    await h.adopt();
    expect((await h.handle(hookReq(issueBody()), new URL("http://x/api/hooks/sentry/nope")))?.status).toBe(404);
    expect((await h.handle(hookReq(issueBody()), new URL("http://x/api/hooks/sentry/shop")))?.status).toBe(503);
  });

  test("a resource that carries no new issue is a quiet 200", async () => {
    const h = hub();
    await h.adopt();
    const body = JSON.stringify({ action: "created", data: { installation: {} } });
    const res = await h.handle(hookReq(body, sign(body), "installation"), new URL("http://x/api/hooks/sentry/shop"));
    expect(res?.status).toBe(200);
    expect(await res?.json()).toMatchObject({ kind: "skip" });
  });

  test("a server without the flows lock starts nothing", async () => {
    const h = hub();
    const res = await h.handle(hookReq(issueBody()), new URL("http://x/api/hooks/sentry/shop"));
    expect(res?.status).toBe(503);
    expect(runs).toEqual([]);
  });
});

describe("deliveries", () => {
  test("the same issue twice is one event and one run", async () => {
    const h = hub();
    await h.adopt();
    await h.handle(hookReq(issueBody()), new URL("http://x/api/hooks/sentry/shop"));
    const res = await h.handle(hookReq(issueBody()), new URL("http://x/api/hooks/sentry/shop"));
    expect(await res?.json()).toMatchObject({ kind: "duplicate" });
    expect(h.list()).toHaveLength(1);
    expect(h.list()[0]?.count).toBe(2);
    expect(runs).toHaveLength(1);
  });

  test("an ignored title is recorded with no run", async () => {
    await rules({ ignore: ["boom"] });
    const h = hub();
    await h.adopt();
    const res = await h.handle(hookReq(issueBody()), new URL("http://x/api/hooks/sentry/shop"));
    expect(await res?.json()).toMatchObject({ kind: "ignored" });
    expect(h.list()[0]?.status).toBe("ignored");
    expect(runs).toEqual([]);
  });

  test("full branch slots queue it, and a run ending starts it", async () => {
    busy = "shop has 2 branch runs going";
    const h = hub();
    await h.adopt();
    const res = await h.handle(hookReq(issueBody()), new URL("http://x/api/hooks/sentry/shop"));
    expect(await res?.json()).toMatchObject({ kind: "queued" });
    expect(h.list()[0]).toMatchObject({ status: "queued", reason: busy });
    busy = null;
    h.onRun(run({ id: "other", status: "done" }));
    await h.idle();
    await Bun.sleep(0);
    await h.idle();
    expect(h.list()[0]).toMatchObject({ status: "working", runId: "r2" });
  });

  test("a start that throws fails the event, and retry starts it on a new branch", async () => {
    let fail = true;
    const h = hub({
      start: async () => {
        if (fail) throw new Error("no main branch");
        const r = run();
        runs.push(r);
        return { run: r };
      },
    });
    await h.adopt();
    const d = await h.fire("shop", "");
    expect(d.kind).toBe("started");
    const [e] = h.list();
    expect(e).toMatchObject({ status: "failed", reason: "no main branch" });
    fail = false;
    const again = await h.retry(e?.id ?? "");
    expect(again).toMatchObject({ status: "working", runId: runs[0]?.id });
  });

  test("an unknown workflow is refused before an event is made", async () => {
    await rules({ workflow: "nope" });
    const h = hub();
    await h.adopt();
    expect(h.fire("shop", "x")).rejects.toThrow("unknown workflow");
  });
});

describe("runs, PRs and resolve", () => {
  test("stop, then resume picks the branch up", async () => {
    const h = hub();
    await h.adopt();
    await h.fire("shop", "boom");
    const [e] = h.list();
    await h.stopEvent(e?.id ?? "");
    expect(stopped).toEqual(["r1"]);
    h.onRun({ ...(runs[0] as Run), status: "stopped" });
    expect(h.get(e?.id ?? "")?.status).toBe("stopped");
    const back = await h.resume(e?.id ?? "");
    expect(back).toMatchObject({ status: "working", runId: "r2" });
  });

  test("a flow on a branch: the event follows it, a stop stops the flow, and resume picks the branch up with a run", async () => {
    const flow = {
      id: "f1",
      repoId: "web/shop",
      status: "working",
      steps: [{ name: "Fix", status: "running", runId: "r9" }],
      current: 0,
      branch: { name: "run/x", target: "main", base: "b", dir: "/d", state: "working", origin: "brf" },
    } as unknown as Flow;
    const stoppedFlows: string[] = [];
    const h = hub({ start: async () => ({ flow }), stopFlow: (id) => stoppedFlows.push(id), flowKnown: (id) => id === "f1" });
    await h.adopt();
    await h.fire("shop", "boom");
    const [e] = h.list();
    expect(e).toMatchObject({ status: "working", flowId: "f1", branch: "brf", runId: "r9" });
    // a step's run is the flow's to follow, not the event's
    h.onRun({ ...run({ id: "r9" }), status: "done" });
    expect(h.get(e?.id ?? "")?.status).toBe("working");
    await h.stopEvent(e?.id ?? "");
    expect(stoppedFlows).toEqual(["f1"]);
    expect(stopped).toEqual([]);
    h.onFlow({ ...flow, status: "stopped", branch: { ...flow.branch!, state: "uncommitted" } });
    expect(h.get(e?.id ?? "")).toMatchObject({ status: "stopped", reason: "stopped before it finished" });
    const back = await h.resume(e?.id ?? "");
    expect(back).toMatchObject({ status: "working", runId: runs[0]?.id, branch: "brf" });
    expect(back.flowId).toBeUndefined();
  });

  test("resume picks a kept flow up, and the event keeps following it", async () => {
    const flow = { id: "f3", repoId: "web/shop", status: "working", steps: [{ name: "Fix", status: "running", runId: "r7" }], current: 0, branch: { name: "run/x", target: "main", base: "b", dir: "/d", state: "working", origin: "brh" } } as unknown as Flow;
    const h = hub({ start: async () => ({ flow }), resume: async () => ({ flow: { ...flow, status: "working" } }), stopFlow: () => {} });
    await h.adopt();
    await h.fire("shop", "boom");
    const [e] = h.list();
    h.onFlow({ ...flow, status: "stopped" });
    const back = await h.resume(e?.id ?? "");
    expect(back).toMatchObject({ status: "working", flowId: "f3", branch: "brh" });
  });

  test("a done flow is ready once its worktree is read", async () => {
    const flow = { id: "f2", repoId: "web/shop", status: "working", steps: [], current: 0, branch: { name: "run/x", target: "main", base: "b", dir: "/d", state: "working", origin: "brg" } } as unknown as Flow;
    const h = hub({ start: async () => ({ flow }) });
    await h.adopt();
    await h.fire("shop", "boom");
    const [e] = h.list();
    h.onFlow({ ...flow, status: "done" });
    expect(h.get(e?.id ?? "")?.status).toBe("working");
    h.onFlow({ ...flow, status: "done", branch: { ...flow.branch!, state: "ready" } });
    expect(h.get(e?.id ?? "")?.status).toBe("ready");
  });

  test("the PR's merge resolves the Sentry issue with the rule's token", async () => {
    const h = hub();
    await h.adopt();
    await h.handle(hookReq(issueBody()), new URL("http://x/api/hooks/sentry/shop"));
    const r = runs[0] as Run;
    h.onRun({ ...r, status: "done", branch: { ...r.branch!, state: "ready" } });
    expect(h.list()[0]?.status).toBe("ready");
    const watch = { id: "br1", runId: "r1", number: 3, url: "https://github.com/a/b/pull/3", state: { status: "open" } } as PrWatch;
    h.onPrs([watch]);
    expect(h.list()[0]).toMatchObject({ status: "review", pr: { number: 3 } });
    h.onPrs([{ ...watch, state: { ...watch.state!, status: "merged" } }]);
    await h.idle();
    expect(resolved).toEqual(["4242:tok"]);
    expect(h.list()[0]).toMatchObject({ status: "merged", resolved: { at: 1000 } });
  });

  test("a manual fire never calls Sentry", async () => {
    const h = hub();
    await h.adopt();
    await h.fire("shop", "boom");
    const r = runs[0] as Run;
    h.onPrs([{ id: r.branch!.origin, runId: r.id, number: 1, url: "u", state: { status: "merged" } } as PrWatch]);
    await h.idle();
    expect(resolved).toEqual([]);
  });

  test("after a restart, an event whose run is gone reads stopped", async () => {
    const first = hub();
    await first.adopt();
    await first.fire("shop", "boom");
    await first.idle();
    runs = [];
    const second = hub();
    await second.adopt();
    expect(second.list()[0]).toMatchObject({ status: "stopped", reason: "a restart cut the run short" });
  });

  test("a live event cannot be dismissed; an ended one can", async () => {
    const h = hub();
    await h.adopt();
    await h.fire("shop", "boom");
    const [e] = h.list();
    expect(h.dismiss(e?.id ?? "")).rejects.toThrow("stop it first");
    h.onRun({ ...(runs[0] as Run), status: "failed", error: "x" });
    await h.dismiss(e?.id ?? "");
    expect(h.list()).toEqual([]);
  });
});

describe("info", () => {
  test("says whether each secret is set, never its value", async () => {
    const h = hub();
    await h.adopt();
    const info = await h.info();
    expect(info.keeping).toBe(true);
    expect(info.rules[0]).toMatchObject({ name: "shop", hook: "/api/hooks/sentry/shop", secretSet: true, tokenSet: true });
    expect(JSON.stringify(info)).not.toContain(SECRET);
  });

  test("names a rule whose repo is not in the tree", async () => {
    await rules({ repo: "gone" });
    const info = await hub().info();
    expect(info.rules[0]?.problem).toContain("no repo gone");
  });
});

describe("linear", () => {
  const LINEAR_SECRET = "lin-s3cret";
  let linked: string[];
  const env = (name: string) =>
    ({ CANOPY_TRIGGER_SHOP_SECRET: SECRET, CANOPY_TRIGGER_LIN_SECRET: LINEAR_SECRET, CANOPY_TRIGGER_LIN_TOKEN: "lin_api_k", CANOPY_TRIGGER_SHOP_TOKEN: "tok" })[name];
  const linearHub = (over: Partial<TriggerDeps> = {}) =>
    hub({
      env,
      workflowProblem: async (name) => (name === "linear-issue" ? null : `unknown workflow: ${name}`),
      link: async (_rule: TriggerRule, e: TriggerEvent, token: string) => {
        linked.push(`${e.key}:${e.pr?.number}:${token}`);
      },
      ...over,
    });
  const issue = (action = "create", over: Record<string, unknown> = {}, updatedFrom?: Record<string, unknown>) =>
    JSON.stringify({
      action,
      type: "Issue",
      url: "https://linear.app/acme/issue/ENG-7/add-a-sync-time",
      webhookTimestamp: 1000,
      data: { id: "iss-7", identifier: "ENG-7", title: "Add a sync time", team: { key: "ENG" }, state: { name: "Todo", type: "unstarted" }, labelIds: ["l1"], labels: [{ id: "l1", name: "canopy" }], ...over },
      ...(updatedFrom ? { updatedFrom } : {}),
    });
  const linearReq = (body: string, sig = sign(body, LINEAR_SECRET)) =>
    new Request("http://x/api/hooks/linear/lin", { method: "POST", body, headers: { "linear-signature": sig, "linear-event": "Issue" } });
  const URL_ = new URL("http://x/api/hooks/linear/lin");

  beforeEach(async () => {
    linked = [];
    await writeFile(
      join(dir, "triggers.json"),
      JSON.stringify({ rules: [{ name: "lin", source: "linear", repo: "web/shop", secretEnv: "CANOPY_TRIGGER_LIN_SECRET", tokenEnv: "CANOPY_TRIGGER_LIN_TOKEN" }] }),
    );
  });

  test("a signed issue created with the label starts a branch run named for it", async () => {
    const h = linearHub();
    await h.adopt();
    const res = await h.handle(linearReq(issue()), URL_);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toMatchObject({ kind: "started" });
    const [e] = h.list();
    expect(e).toMatchObject({ key: "iss-7", short: "ENG-7", source: "linear", service: "linear", workflow: "linear-issue", status: "working" });
    expect(e?.note.startsWith("Linear issue ENG-7 came in.")).toBe(true);
  });

  test("a bad signature, Sentry's header, or a stale timestamp is refused and records nothing", async () => {
    const h = linearHub();
    await h.adopt();
    expect((await h.handle(linearReq(issue(), sign(issue(), "other")), URL_))?.status).toBe(401);
    const sentryHeader = new Request("http://x/api/hooks/linear/lin", { method: "POST", body: issue(), headers: { "sentry-hook-signature": sign(issue(), LINEAR_SECRET) } });
    expect((await h.handle(sentryHeader, URL_))?.status).toBe(401);
    const stale = JSON.stringify({ ...(JSON.parse(issue()) as Record<string, unknown>), webhookTimestamp: 1000 + 61_000 });
    const res = await h.handle(linearReq(stale), URL_);
    expect(res?.status).toBe(401);
    expect(await res?.json()).toMatchObject({ error: expect.stringContaining("webhookTimestamp") });
    expect(h.list()).toEqual([]);
  });

  test("an edit that adds no label is a quiet 200", async () => {
    const h = linearHub();
    await h.adopt();
    const res = await h.handle(linearReq(issue("update", { title: "renamed" }, { title: "Add a sync time" })), URL_);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ kind: "skip", why: "no label this rule takes was added" });
    expect(h.list()).toEqual([]);
  });

  test("the PR's link goes to the issue once it opens, and the merge moves it to done", async () => {
    const h = linearHub();
    await h.adopt();
    await h.handle(linearReq(issue()), URL_);
    const r = runs[0] as Run;
    h.onRun({ ...r, status: "done", branch: { ...r.branch!, state: "ready" } });
    const watch = { id: "br1", runId: "r1", number: 9, url: "https://github.com/a/b/pull/9", state: { status: "open" } } as PrWatch;
    h.onPrs([watch]);
    await h.idle();
    expect(linked).toEqual(["iss-7:9:lin_api_k"]);
    expect(h.list()[0]).toMatchObject({ status: "review", linked: { at: 1000 } });
    h.onPrs([{ ...watch, state: { ...watch.state!, status: "merged" } }]);
    await h.idle();
    expect(linked).toHaveLength(1);
    expect(resolved).toEqual(["iss-7:lin_api_k"]);
    expect(h.list()[0]).toMatchObject({ status: "merged", linked: { at: 1000 }, resolved: { at: 1000 } });
  });

  test("a refused comment is kept on the event and the merge still moves the issue", async () => {
    const h = linearHub({
      link: async () => {
        throw new Error("Linear answered 401");
      },
    });
    await h.adopt();
    await h.handle(linearReq(issue()), URL_);
    const r = runs[0] as Run;
    h.onPrs([{ id: r.branch!.origin, runId: r.id, number: 2, url: "u", state: { status: "merged" } } as PrWatch]);
    await h.idle();
    expect(h.list()[0]).toMatchObject({ status: "merged", linked: { error: "Linear answered 401" }, resolved: { at: 1000 } });
  });

  test("a run that commits nothing or fails says why on the issue, once", async () => {
    const noted: string[] = [];
    const h = linearHub({ note: async (_rule, e, token, body) => void noted.push(`${e.key}:${token}:${body}`), origin: "https://canopy.example" });
    await h.adopt();
    await h.handle(linearReq(issue()), URL_);
    const r = runs[0] as Run;
    const result = { text: "The issue names no file.", durationMs: 1, turns: 1 };
    h.onRun({ ...r, status: "done", result });
    h.onRun({ ...r, status: "done", branch: { ...r.branch!, state: "nothing" }, result });
    h.onRun({ ...r, status: "done", branch: { ...r.branch!, state: "nothing" }, result });
    await h.idle();
    expect(noted).toEqual([
      "iss-7:lin_api_k:canopy ran on this issue and committed nothing.\n\nThe issue names no file.\n\nTo try again, use Retry on [canopy's triggers page](https://canopy.example/?view=triggers).",
    ]);
    expect(h.list()[0]).toMatchObject({ status: "no-fix" });

    noted.length = 0;
    const failing = linearHub({
      note: async (_rule, e, _token, body) => void noted.push(`${e.key}:${body}`),
      start: async () => {
        throw new Error("no worktree");
      },
    });
    await failing.adopt();
    await failing.handle(linearReq(issue("create", { id: "iss-8", identifier: "ENG-8" })), URL_);
    await failing.idle();
    expect(noted).toEqual(["iss-8:canopy's run on this issue failed: no worktree."]);
  });

  test("with no token, or on a test fire, Linear is never called", async () => {
    await writeFile(join(dir, "triggers.json"), JSON.stringify({ rules: [{ name: "lin", source: "linear", repo: "web/shop", secretEnv: "CANOPY_TRIGGER_LIN_SECRET" }] }));
    const h = linearHub({ note: async () => void linked.push("note") });
    await h.adopt();
    await h.handle(linearReq(issue()), URL_);
    await h.fire("lin", "");
    for (const r of runs) h.onRun({ ...r, status: "done", branch: { ...r.branch!, state: "nothing" } });
    for (const r of runs) h.onPrs([{ id: r.branch!.origin, runId: r.id, number: 1, url: "u", state: { status: "merged" } } as PrWatch]);
    await h.idle();
    expect(linked).toEqual([]);
    expect(resolved).toEqual([]);
    expect(h.list().find((e) => e.source === "manual")).toMatchObject({ service: "linear", title: "Show the last sync time on the settings page" });
  });
});

describe("the linear agent", () => {
  const APP_HOOK = "app-hook-secret";
  let told: { token: string; session: string; say: AgentSay }[];
  let follows: string[];
  let mintCount: number;
  const env = (name: string) => ({ CANOPY_TRIGGER_APP_HOOK: APP_HOOK, CANOPY_TRIGGER_APP_SECRET: "csecret" })[name];
  const agentHub = (over: Partial<TriggerDeps> = {}) =>
    hub({
      env,
      workflowProblem: async () => null,
      appToken: async () => "app-tok",
      agent: async (_rule, token, session, say) => {
        told.push({ token, session, say });
      },
      followUp: async (e, text) => {
        follows.push(`${e.branch}:${text}`);
        const r = run();
        runs.push(r);
        return { run: r };
      },
      origin: "https://canopy.example/",
      ...over,
    });
  const body = (action: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "AgentSessionEvent",
      action,
      webhookTimestamp: 1000,
      agentSession: { id: "ses-1", issue: { id: "iss-9", identifier: "ENG-9", title: "Fix the sync badge", url: "https://linear.app/acme/issue/ENG-9", team: { key: "ENG" } } },
      promptContext: '<issue identifier="ENG-9"><title>Fix the sync badge</title></issue>',
      ...extra,
    });
  const req = (b: string) => new Request("http://x/api/hooks/linear/app", { method: "POST", body: b, headers: { "linear-signature": sign(b, APP_HOOK) } });
  const URL_ = new URL("http://x/api/hooks/linear/app");
  const said = () => told.map((t) => ("activity" in t.say ? `${t.say.activity.type}: ${"body" in t.say.activity ? t.say.activity.body : t.say.activity.parameter}` : `links: ${t.say.links.map((l) => l.url).join(" ")}`));

  beforeEach(async () => {
    told = [];
    follows = [];
    mintCount = 0;
    await writeFile(
      join(dir, "triggers.json"),
      JSON.stringify({ rules: [{ name: "app", source: "linear", repo: "web/shop", secretEnv: "CANOPY_TRIGGER_APP_HOOK", clientId: "cid", clientSecretEnv: "CANOPY_TRIGGER_APP_SECRET" }] }),
    );
  });

  test("a new session thinks aloud, links canopy, starts a run and reports it", async () => {
    const h = agentHub();
    await h.adopt();
    const res = await h.handle(req(body("created")), URL_);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ kind: "accepted" });
    await h.idle();
    const [e] = h.list();
    expect(e).toMatchObject({ key: "iss-9", short: "ENG-9", session: "ses-1", status: "working", runId: "r1" });
    expect(e?.note).toContain("context from Linear:");
    expect(said()).toEqual(["thought: On it: starting a run in web/shop.", "links: https://canopy.example/?view=triggers", "action: web/shop, on a branch of its own"]);
    expect(told.every((t) => t.session === "ses-1" && t.token === "app-tok")).toBe(true);
  });

  test("a rule with no app takes no session, and a session with no issue is told why", async () => {
    await writeFile(join(dir, "triggers.json"), JSON.stringify({ rules: [{ name: "app", source: "linear", repo: "web/shop", secretEnv: "CANOPY_TRIGGER_APP_HOOK" }] }));
    const h = agentHub();
    await h.adopt();
    expect(await (await h.handle(req(body("created")), URL_))?.json()).toMatchObject({ kind: "skip" });
    await rulesWithApp();
    const res = await h.handle(req(body("created", { agentSession: { id: "ses-doc" } })), URL_);
    expect(await res?.json()).toMatchObject({ kind: "skip", why: "the session is not on an issue" });
    await h.idle();
    expect(said()).toEqual(["response: canopy works on issues: delegate one to it, or mention it on one."]);
    expect(h.list()).toEqual([]);
  });

  async function rulesWithApp(): Promise<void> {
    await writeFile(
      join(dir, "triggers.json"),
      JSON.stringify({ rules: [{ name: "app", source: "linear", repo: "web/shop", secretEnv: "CANOPY_TRIGGER_APP_HOOK", clientId: "cid", clientSecretEnv: "CANOPY_TRIGGER_APP_SECRET" }] }),
    );
  }

  test("a message while the run works is told to wait; stop stops it, and a message then carries it on", async () => {
    const h = agentHub();
    await h.adopt();
    await h.handle(req(body("created")), URL_);
    await h.idle();
    told = [];
    await h.handle(req(body("prompted", { agentActivity: { body: "also the tooltip" } })), URL_);
    await h.idle();
    expect(said()).toEqual(["response: The run is still going, and canopy reads a message only once it ends. Stop it to end it now."]);
    await h.handle(req(body("prompted", { agentActivity: { signal: "stop" } })), URL_);
    await h.idle();
    expect(stopped).toEqual(["r1"]);
    const r = runs[0] as Run;
    h.onRun({ ...r, status: "stopped" });
    await h.idle();
    expect(said().at(-1)).toContain("response: Stopped: stopped before it finished. Write here to carry on");
    await h.handle(req(body("prompted", { agentActivity: { body: "also the tooltip" } })), URL_);
    await h.idle();
    expect(follows).toEqual(["br1:also the tooltip"]);
    expect(h.list()[0]).toMatchObject({ status: "working", runId: "r2" });
    expect(said().at(-1)).toBe("action: web/shop, on a branch of its own");
  });

  test("the PR goes on the session as a link, not a comment, and the merge moves the issue with the app's token", async () => {
    const h = agentHub({ link: async () => void linkedComments.push("comment") });
    await h.adopt();
    await h.handle(req(body("created")), URL_);
    await h.idle();
    const r = runs[0] as Run;
    h.onRun({ ...r, status: "done", branch: { ...r.branch!, state: "ready" }, result: { text: "Fixed the badge.", durationMs: 1, turns: 1 } });
    const watch = { id: "br1", runId: "r1", number: 9, url: "https://github.com/a/b/pull/9", state: { status: "open" } } as PrWatch;
    h.onPrs([watch]);
    await h.idle();
    h.onPrs([{ ...watch, state: { ...watch.state!, status: "merged" } }]);
    await h.idle();
    expect(linkedComments).toEqual([]);
    expect(said()).toContain("links: https://github.com/a/b/pull/9");
    expect(said()).toContain("response: Opened [pull request #9](https://github.com/a/b/pull/9).\n\nFixed the badge.");
    expect(said()).toContain("response: Merged [pull request #9](https://github.com/a/b/pull/9).");
    expect(resolved).toEqual(["iss-9:app-tok"]);
    expect(h.list()[0]).toMatchObject({ status: "merged", linked: { at: 1000 }, resolved: { at: 1000 } });
  });
  const linkedComments: string[] = [];

  test("a token Linear refuses is minted again once", async () => {
    let first = true;
    const h = agentHub({
      appToken: async () => `app-${++mintCount}`,
      agent: async (_rule, token, session, say) => {
        if (first) {
          first = false;
          throw new LinearError("Linear answered 401: Authentication required", 401);
        }
        told.push({ token, session, say });
      },
    });
    await h.adopt();
    await h.handle(req(body("created")), URL_);
    await h.idle();
    expect(told[0]?.token).toBe("app-2");
  });

  test("an issue canopy already has takes the session and is told where it stands", async () => {
    const h = agentHub();
    await h.adopt();
    await h.handle(req(body("created")), URL_);
    await h.idle();
    told = [];
    const again = body("created", { agentSession: { id: "ses-2", issue: { id: "iss-9", identifier: "ENG-9", title: "Fix the sync badge", team: { key: "ENG" } } } });
    await h.handle(req(again), URL_);
    await h.idle();
    expect(h.list()).toHaveLength(1);
    expect(h.list()[0]).toMatchObject({ session: "ses-2", count: 2 });
    expect(told.map((t) => t.session)).toEqual(["ses-2", "ses-2", "ses-2"]);
    expect(said().at(-1)).toBe("response: canopy already has this issue, and its run reads working. Updates come here from now on.");
  });
});

describe("installing the linear app", () => {
  let installs: string[];
  const installHub = (over: Partial<TriggerDeps> = {}) =>
    hub({
      env: (name) => ({ CANOPY_TRIGGER_APP_HOOK: "h", CANOPY_TRIGGER_APP_SECRET: "csecret" })[name],
      origin: "https://canopy.example",
      install: async (_rule, secret, code, redirect) => {
        installs.push(`${secret}:${code}:${redirect}`);
        return { organization: { id: "org-1", name: "Acme" }, app: { id: "u1", name: "canopy" } };
      },
      ...over,
    });
  const get = (h: TriggerHub, path: string) => h.handle(new Request(`http://x${path}`), new URL(`http://x${path}`));

  beforeEach(async () => {
    installs = [];
    await writeFile(
      join(dir, "triggers.json"),
      JSON.stringify({ rules: [{ name: "app", source: "linear", repo: "web/shop", secretEnv: "CANOPY_TRIGGER_APP_HOOK", clientId: "cid", clientSecretEnv: "CANOPY_TRIGGER_APP_SECRET" }] }),
    );
  });

  test("the rule says where its install starts, and that sends the admin to Linear with a fresh state", async () => {
    const h = installHub();
    expect((await h.info()).rules[0]?.install).toBe("/api/linear/install?rule=app");
    const res = await get(h, "/api/linear/install?rule=app");
    expect(res?.status).toBe(302);
    const to = new URL(res?.headers.get("location") ?? "");
    expect(to.searchParams.get("actor")).toBe("app");
    expect(to.searchParams.get("redirect_uri")).toBe("https://canopy.example/api/linear/callback");
    expect(to.searchParams.get("state")?.length).toBeGreaterThan(20);
    expect((await get(h, "/api/linear/install?rule=nope"))?.status).toBe(404);
  });

  test("the way back trades the code once, and names the workspace to pin", async () => {
    const h = installHub();
    const state = new URL((await get(h, "/api/linear/install?rule=app"))?.headers.get("location") ?? "").searchParams.get("state");
    const res = await get(h, `/api/linear/callback?code=c1&state=${state}`);
    expect(res?.status).toBe(200);
    const page = (await res?.text()) ?? "";
    expect(page).toContain("canopy is installed in Linear");
    expect(page).toContain('<code>"organization": "org-1"</code>');
    expect(installs).toEqual(["csecret:c1:https://canopy.example/api/linear/callback"]);
    expect((await get(h, `/api/linear/callback?code=c1&state=${state}`))?.status).toBe(400);
    expect(installs).toHaveLength(1);
  });

  test("an unknown, stale or refused state trades nothing", async () => {
    let t = 1000;
    const h = installHub({ now: () => t });
    expect((await get(h, "/api/linear/callback?code=c&state=made-up"))?.status).toBe(400);
    const st = (): Promise<string | null> => get(h, "/api/linear/install?rule=app").then((r) => new URL(r?.headers.get("location") ?? "").searchParams.get("state"));
    const old = await st();
    t += 11 * 60 * 1000;
    expect((await get(h, `/api/linear/callback?code=c&state=${old}`))?.status).toBe(400);
    const denied = await st();
    const res = await get(h, `/api/linear/callback?error=access_denied&error_description=${encodeURIComponent("<b>no</b>")}&state=${denied}`);
    expect(res?.status).toBe(400);
    expect(await res?.text()).toContain("&#60;b&#62;no&#60;/b&#62;");
    expect(installs).toEqual([]);
  });

  test("a delivery from another workspace is passed over once the rule names its own", async () => {
    await writeFile(
      join(dir, "triggers.json"),
      JSON.stringify({ rules: [{ name: "app", source: "linear", repo: "web/shop", secretEnv: "CANOPY_TRIGGER_APP_HOOK", organization: "org-1" }] }),
    );
    const h = installHub({ workflowProblem: async () => null });
    await h.adopt();
    const send = (org: string) => {
      const b = JSON.stringify({ action: "create", type: "Issue", organizationId: org, webhookTimestamp: 1000, data: { id: `iss-${org}`, identifier: "ENG-1", title: "t", labelIds: ["l"], labels: [{ id: "l", name: "canopy" }] } });
      return h.handle(new Request("http://x/api/hooks/linear/app", { method: "POST", body: b, headers: { "linear-signature": sign(b, "h") } }), new URL("http://x/api/hooks/linear/app"));
    };
    expect(await (await send("org-2"))?.json()).toEqual({ kind: "skip", why: "a delivery from a Linear workspace other than the rule's" });
    expect(await (await send("org-1"))?.json()).toMatchObject({ kind: "started" });
    expect(h.list()).toHaveLength(1);
  });
});

describe("github and forgejo hooks", () => {
  const HOOK = "gh-s3cret";
  const env = (name: string) => ({ CANOPY_TRIGGER_GH_HOOK: HOOK })[name];
  const ghRules = (extra: Record<string, unknown> = {}) =>
    writeFile(join(dir, "triggers.json"), JSON.stringify({ rules: [{ name: "gh", source: "github", repo: "web/shop", secretEnv: "CANOPY_TRIGGER_GH_HOOK", ...extra }] }));
  const fjRules = () =>
    writeFile(join(dir, "triggers.json"), JSON.stringify({ rules: [{ name: "fj", source: "forgejo", repo: "web/shop", api: "https://git.example.com", secretEnv: "CANOPY_TRIGGER_GH_HOOK" }] }));
  /** one issue as both services put it in a delivery */
  const issue = (number: number, over: Record<string, unknown> = {}) => ({
    number,
    title: `Issue ${number}`,
    body: "Steps: open the settings page.",
    state: "open",
    html_url: `https://git.example.com/o/r/issues/${number}`,
    labels: [{ name: "canopy" }],
    ...over,
  });
  const ghBody = (over: Record<string, unknown> = {}) => JSON.stringify({ action: "labeled", label: { name: "canopy" }, issue: issue(12), ...over });
  const fjBody = () => JSON.stringify({ action: "label_updated", issue: issue(7) });
  const githubUrl = new URL("http://x/api/hooks/github/gh");
  const forgejoUrl = new URL("http://x/api/hooks/forgejo/fj");
  const githubReq = (body: string, sig = `sha256=${sign(body, HOOK)}`, event = "issues") =>
    new Request(githubUrl.href, { method: "POST", body, headers: { "x-hub-signature-256": sig, "x-github-event": event } });
  const forgejoReq = (body: string, headers: Record<string, string> = { "x-forgejo-signature": sign(body, HOOK), "x-forgejo-event": "issues" }) =>
    new Request(forgejoUrl.href, { method: "POST", body, headers });
  let reports: ProbeResult[];
  let reads: string[];
  const issueHub = (over: Partial<TriggerDeps> = {}) =>
    hub({
      env,
      readIssue: async (_rule, _repo, inc) => {
        reads.push(inc.key);
        return { ...inc, comments: [{ author: "eric", body: "Still happens on main." }] };
      },
      reportPoll: (r) => reports.push(r),
      ...over,
    });

  beforeEach(() => {
    reports = [];
    reads = [];
  });

  test("a signed labeled delivery reads the issue in full and starts a run", async () => {
    await ghRules();
    const h = issueHub();
    await h.adopt();
    const res = await h.handle(githubReq(ghBody()), githubUrl);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toMatchObject({ kind: "started" });
    const [e] = h.list();
    expect(e).toMatchObject({ key: "12", short: "#12", service: "github", source: "github", status: "working", runId: "r1", link: "https://git.example.com/o/r/issues/12" });
    expect(e?.note.startsWith("GitHub issue #12 came in.")).toBe(true);
    expect(e?.note).toContain("comment by eric:\nStill happens on main.");
    expect(reads).toEqual(["12"]);
    expect(reports).toEqual([]);
  });

  test("a bad signature is a 401 before the body is parsed, and a body over a MiB a 413", async () => {
    await ghRules();
    const h = issueHub();
    await h.adopt();
    expect((await h.handle(githubReq("{", "sha256=bad"), githubUrl))?.status).toBe(401);
    // GitHub's header carries the sha256= prefix; a bare digest is not it
    expect((await h.handle(githubReq(ghBody(), sign(ghBody(), HOOK)), githubUrl))?.status).toBe(401);
    expect((await h.handle(githubReq(ghBody(), `sha256=${sign(ghBody(), "other")}`), githubUrl))?.status).toBe(401);
    expect((await h.handle(githubReq("{".padEnd(MAX_BODY + 1, " "), "sha256=bad"), githubUrl))?.status).toBe(413);
    expect(h.list()).toEqual([]);
    expect(reads).toEqual([]);
  });

  test("ping, any event but issues, and an issues event that adds another label are a quiet 200", async () => {
    await ghRules();
    const h = issueHub();
    await h.adopt();
    const ping = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
    const res = await h.handle(githubReq(ping, undefined, "ping"), githubUrl);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ kind: "skip", why: "not an issues event" });
    expect(await (await h.handle(githubReq(ghBody(), undefined, "pull_request"), githubUrl))?.json()).toMatchObject({ kind: "skip" });
    expect(await (await h.handle(githubReq(ghBody({ label: { name: "bug" } })), githubUrl))?.json()).toEqual({ kind: "skip", why: "no label this rule takes was added to an open issue" });
    expect(h.list()).toEqual([]);
    expect(reads).toEqual([]);
  });

  test("a rule with no secret has no hook, and one whose secret is unset answers 503", async () => {
    await ghRules({ secretEnv: undefined });
    const h = issueHub();
    await h.adopt();
    expect((await h.handle(githubReq(ghBody()), githubUrl))?.status).toBe(404);
    await ghRules({ secretEnv: "CANOPY_TRIGGER_GH_UNSET" });
    expect((await h.handle(githubReq(ghBody()), githubUrl))?.status).toBe(503);
    expect(h.list()).toEqual([]);
  });

  test("a Forgejo delivery signs as Forgejo or as Gitea, and a second label update on the issue bumps its count", async () => {
    await fjRules();
    const h = issueHub();
    await h.adopt();
    expect(await (await h.handle(forgejoReq(fjBody()), forgejoUrl))?.json()).toMatchObject({ kind: "started" });
    const gitea = forgejoReq(fjBody(), { "x-gitea-signature": sign(fjBody(), HOOK), "x-gitea-event": "issues" });
    expect(await (await h.handle(gitea, forgejoUrl))?.json()).toMatchObject({ kind: "duplicate" });
    expect(h.list()).toHaveLength(1);
    expect(h.list()[0]).toMatchObject({ key: "7", short: "#7", service: "forgejo", count: 2, runId: "r1" });
    expect(h.list()[0]?.note.startsWith("Forgejo issue #7 came in.")).toBe(true);
    expect(runs).toHaveLength(1);
    // the issue was read in full once: a redelivery finds its event before any read
    expect(reads).toEqual(["7"]);
    expect((await h.handle(forgejoReq(fjBody(), { "x-forgejo-signature": sign(fjBody(), "other"), "x-forgejo-event": "issues" }), forgejoUrl))?.status).toBe(401);
    expect(await (await h.handle(forgejoReq(fjBody(), { "x-forgejo-signature": sign(fjBody(), HOOK), "x-forgejo-event": "push" }), forgejoUrl))?.json()).toEqual({ kind: "skip", why: "not an issues event" });
    expect(h.list()[0]?.count).toBe(2);
  });

  test("an issue canopy cannot read in full makes no event: the hook says so and health hears once", async () => {
    await ghRules();
    const h = issueHub({
      readIssue: async () => {
        throw new Error("gh answered 502");
      },
    });
    await h.adopt();
    const res = await h.handle(githubReq(ghBody()), githubUrl);
    expect(res?.status).toBe(502);
    expect(await res?.json()).toEqual({ error: "cannot read issue #12 in full: gh answered 502" });
    expect(h.list()).toEqual([]);
    expect(reports).toEqual([{ state: "down", why: "gh: cannot read issue #12 in full: gh answered 502" }]);
  });
});

describe("polling", () => {
  let reports: ProbeResult[];
  let listed: number;
  let reads: string[];
  const candidates = (n: number): Incoming[] => Array.from({ length: n }, (_, i) => ({ key: String(i + 1), short: `#${i + 1}`, title: `Issue ${i + 1}`, detail: [], frames: [] }));
  /** a rule with no hook secret, so it polls every 15 minutes by default */
  const pollRules = (extra: Record<string, unknown> = {}) =>
    writeFile(join(dir, "triggers.json"), JSON.stringify({ rules: [{ name: "tracker", source: "github", repo: "web/shop", ...extra }] }));
  const pollHub = (over: Partial<TriggerDeps> = {}) =>
    hub({
      listIssues: async () => {
        listed++;
        return candidates(60);
      },
      readIssue: async (_rule, _repo, inc) => {
        reads.push(inc.key);
        return inc;
      },
      reportPoll: (r) => reports.push(r),
      ...over,
    });

  beforeEach(async () => {
    reports = [];
    listed = 0;
    reads = [];
    await pollRules();
  });

  test("a poll takes the oldest 50 of 60 candidates, reads each in full, and leaves the newer ten for the next tick", async () => {
    const h = pollHub();
    await h.adopt();
    await h.poll("tracker");
    const oldest = candidates(50);
    expect(h.list()).toHaveLength(50);
    expect(new Set(h.list().map((e) => e.key)).size).toBe(50);
    expect(h.list().map((e) => e.key)).toEqual(oldest.map((i) => i.key));
    expect(listed).toBe(1);
    expect(reads).toEqual(oldest.map((i) => i.key));
    expect(runs).toHaveLength(50);
    expect(reports).toEqual([{ state: "ok" }]);
    // the next poll lists the same sixty: the fifty with events are skipped before any read
    await h.poll("tracker");
    expect(h.list()).toHaveLength(60);
    expect(reads).toHaveLength(60);
    expect(h.list().every((e) => e.source === "github" && e.service === "github")).toBe(true);
  });

  test("only the flows-lock holder polls", async () => {
    const nonOwner = pollHub();
    await nonOwner.poll("tracker");
    expect(listed).toBe(0);
    expect(nonOwner.list()).toEqual([]);
    expect(reports).toEqual([]);
  });

  test("a poll still out is not started again", async () => {
    let releaseList = () => {};
    const h = pollHub({
      listIssues: () => {
        listed++;
        // only the first list waits to be answered
        if (listed > 1) return Promise.resolve(candidates(2));
        return new Promise<Incoming[]>((resolve) => {
          releaseList = () => resolve(candidates(2));
        });
      },
    });
    await h.adopt();
    const firstPoll = h.poll("tracker");
    await h.poll("tracker");
    // the list call comes after the rules are read, so wait for it before answering
    while (listed === 0) await Bun.sleep(1);
    releaseList();
    await firstPoll;
    expect(listed).toBe(1);
    expect(h.list()).toHaveLength(2);
    // once it is back, a poll runs again
    await h.poll("tracker");
    expect(listed).toBe(2);
  });

  test("a list that fails is one health line and no event", async () => {
    const h = pollHub({
      listIssues: async () => {
        throw new Error("gh: HTTP 502");
      },
    });
    await h.adopt();
    await h.poll("tracker");
    expect(h.list()).toEqual([]);
    expect(reports).toEqual([{ state: "down", why: "tracker: gh: HTTP 502" }]);
  });

  test("an issue that cannot be read in full is left out, and health hears once", async () => {
    const h = pollHub({
      listIssues: async () => candidates(3),
      readIssue: async (_rule, _repo, inc) => {
        if (inc.key === "2") throw new Error("gh answered 500");
        return inc;
      },
    });
    await h.adopt();
    await h.poll("tracker");
    expect(h.list().map((e) => e.key)).toEqual(["1", "3"]);
    expect(reports).toEqual([{ state: "down", why: "tracker: cannot read issue #2 in full: gh answered 500" }]);
  });

  test("the tick polls a rule when its cron comes due, and info says when next", async () => {
    let t = Date.UTC(2026, 9, 26, 10, 3);
    const h = pollHub({ now: () => t });
    await h.adopt();
    const quarter = Date.UTC(2026, 9, 26, 10, 15);
    expect((await h.info()).rules[0]?.nextFire).toBe(quarter);
    const got = (await (await h.handle(new Request("http://x/api/triggers"), new URL("http://x/api/triggers")))?.json()) as { rules: { nextFire?: number }[] };
    expect(got.rules[0]?.nextFire).toBe(quarter);
    await h.tick();
    expect(listed).toBe(0);
    t = quarter + 20_000;
    await h.tick();
    expect(listed).toBe(1);
    expect((await h.info()).rules[0]?.nextFire).toBe(Date.UTC(2026, 9, 26, 10, 30));
    // an hour asleep is one poll, not four
    t = Date.UTC(2026, 9, 26, 11, 31);
    await h.tick();
    expect(listed).toBe(2);
    // a rule with a hook secret and no poll line never polls, and names no next fire
    await rules();
    expect((await h.info()).rules[0]?.nextFire).toBeUndefined();
    t += 3_600_000;
    await h.tick();
    expect(listed).toBe(2);
  });

  test("a rule's own cron line is the one followed", async () => {
    await pollRules({ secretEnv: "CANOPY_TRIGGER_GH_HOOK", poll: "0 9 * * 1-5" });
    let t = Date.UTC(2026, 9, 26, 8, 0);
    const h = pollHub({ now: () => t, env: () => "s" });
    await h.adopt();
    expect((await h.info()).rules[0]?.nextFire).toBe(Date.UTC(2026, 9, 26, 9, 0));
    t = Date.UTC(2026, 9, 26, 8, 59);
    await h.tick();
    expect(listed).toBe(0);
    t = Date.UTC(2026, 9, 26, 9, 0, 5);
    await h.tick();
    expect(listed).toBe(1);
  });

  test("POST /api/triggers/poll runs one poll now, and refuses what it cannot poll", async () => {
    const h = pollHub({
      listIssues: async () => {
        listed++;
        return candidates(1);
      },
    });
    await h.adopt();
    const post = (hub: TriggerHub, body: unknown) =>
      hub.handle(new Request("http://x/api/triggers/poll", { method: "POST", body: JSON.stringify(body) }), new URL("http://x/api/triggers/poll"));
    const res = await post(h, { rule: "tracker" });
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ok: true });
    expect(h.list()).toHaveLength(1);
    expect((await post(h, { rule: "nope" }))?.status).toBe(404);
    expect((await post(h, {}))?.status).toBe(400);
    await rules();
    const refused = await post(h, { rule: "shop" });
    expect(refused?.status).toBe(400);
    expect(await refused?.json()).toEqual({ error: "a sentry rule has no issues to poll" });
    await pollRules();
    const cold = pollHub();
    expect((await post(cold, { rule: "tracker" }))?.status).toBe(503);
    expect(listed).toBe(1);
  });
});

describe("landing", () => {
  const landed: LandEntry = { id: "br1", repoId: "web/shop", repoPath: "/dev/web/shop", branch: "run/fix", target: "main", dir: "/tmp/run", note: "fix", state: "landed", tries: 0, queuedAt: 1, updatedAt: 9, landedAt: 9 };
  const notice = (over: Partial<LandNotice>): LandNotice => ({ id: "n", entry: "br1", repoId: "web/shop", branch: "run/fix", note: "", kind: "landed", at: 11, ...over });
  /** a hub with one Forgejo event committed on br1, waiting on the queue */
  async function readyHub(): Promise<TriggerHub> {
    await writeFile(join(dir, "triggers.json"), JSON.stringify({ rules: [{ name: "fj", source: "forgejo", repo: "web/shop", api: "https://git.example.com" }] }));
    const h = hub();
    await h.adopt();
    await h.fire("fj", "Show the last sync time");
    const r = runs[0] as Run;
    h.onRun({ ...r, status: "done", branch: { ...r.branch!, state: "ready" } });
    expect(h.list()[0]).toMatchObject({ service: "forgejo", status: "ready", branch: "br1" });
    return h;
  }

  test("a Forgejo event is merged once the queue lands its branch, by the entry", async () => {
    const entryHub = await readyHub();
    entryHub.onLanding([], [landed]);
    expect(entryHub.list()[0]).toMatchObject({ status: "merged", endedAt: 9 });
    expect(entryHub.list()[0]?.pr).toBeUndefined();
  });

  test("or by the landed notice, as a caller without entries sends it", async () => {
    const noticeHub = await readyHub();
    noticeHub.onLanding([notice({})]);
    expect(noticeHub.list()[0]).toMatchObject({ status: "merged", endedAt: 11 });
  });

  test("a held notice still says why the branch waits", async () => {
    const h = await readyHub();
    h.onLanding([notice({ kind: "held", why: "main moved under it" })], [{ ...landed, state: "waiting" }]);
    expect(h.list()[0]).toMatchObject({ status: "ready", reason: "main moved under it" });
  });
});

describe("writing back", () => {
  const HOOK = "gh-s3cret";
  const env = (name: string) => ({ CANOPY_TRIGGER_GH_HOOK: HOOK })[name];
  const issue = (number: number) => ({ number, title: `Issue ${number}`, body: "Steps.", state: "open", html_url: `https://git.example.com/o/r/issues/${number}`, labels: [{ name: "canopy" }] });
  const ghRule = (extra: Record<string, unknown> = {}) =>
    writeFile(join(dir, "triggers.json"), JSON.stringify({ rules: [{ name: "gh", source: "github", repo: "web/shop", secretEnv: "CANOPY_TRIGGER_GH_HOOK", ...extra }] }));
  const fjRule = () =>
    writeFile(join(dir, "triggers.json"), JSON.stringify({ rules: [{ name: "fj", source: "forgejo", repo: "web/shop", api: "https://git.example.com", secretEnv: "CANOPY_TRIGGER_GH_HOOK" }] }));
  /** delivers issue `number` to the rule, GitHub's way or Forgejo's */
  async function deliver(h: TriggerHub, source: "github" | "forgejo", number: number): Promise<void> {
    const body = JSON.stringify(source === "github" ? { action: "labeled", label: { name: "canopy" }, issue: issue(number) } : { action: "label_updated", issue: issue(number) });
    const headers: Record<string, string> = source === "github" ? { "x-hub-signature-256": `sha256=${sign(body, HOOK)}`, "x-github-event": "issues" } : { "x-forgejo-signature": sign(body, HOOK), "x-forgejo-event": "issues" };
    const url = new URL(`http://x/api/hooks/${source}/${source === "github" ? "gh" : "fj"}`);
    const res = await h.handle(new Request(url.href, { method: "POST", body, headers }), url);
    expect(res?.status).toBe(200);
  }
  const writeHub = (over: Partial<TriggerDeps> = {}) => hub({ env, ...over });
  /** the event's run, done and committed on its branch */
  const ready = (h: TriggerHub, r: Run) => h.onRun({ ...r, status: "done", branch: { ...r.branch!, state: "ready" } });
  const prOf = (r: Run, status: "open" | "merged") => ({ id: r.branch!.origin, runId: r.id, branch: r.branch!.name, number: 3, url: "https://github.com/o/r/pull/3", state: { status } }) as PrWatch;
  const landedEntry = (r: Run): LandEntry =>
    ({ id: r.branch!.origin, repoId: "web/shop", repoPath: "/dev/web/shop", branch: r.branch!.name, target: "main", dir: "/d", note: "fix", state: "landed", tries: 0, queuedAt: 1, updatedAt: 9, landedAt: 9 }) as LandEntry;

  test("a GitHub PR's open is commented on the issue once, and its merge closes the issue", async () => {
    await ghRule();
    const h = writeHub();
    await h.adopt();
    await deliver(h, "github", 12);
    const r = runs[0] as Run;
    ready(h, r);
    h.onPrs([prOf(r, "open")]);
    h.onPrs([prOf(r, "open")]);
    await h.idle();
    expect(written).toEqual(["12:comment:Opened #3 from run/x."]);
    expect(h.list()[0]).toMatchObject({ status: "review", linked: { at: 1000 } });
    h.onPrs([prOf(r, "merged")]);
    h.onPrs([prOf(r, "merged")]);
    await h.idle();
    expect(written).toEqual(["12:comment:Opened #3 from run/x.", "12:close:Fixed by #3."]);
    expect(h.list()[0]).toMatchObject({ status: "merged", resolved: { at: 1000 } });
  });

  test("a run that commits nothing, or fails, is explained on the issue", async () => {
    await ghRule();
    const h = writeHub({ origin: "https://canopy.example" });
    await h.adopt();
    await deliver(h, "github", 12);
    h.onRun({ ...(runs[0] as Run), status: "done", branch: { ...(runs[0] as Run).branch!, state: "nothing" } });
    await h.idle();
    const retry = "\n\nTo try again, use Retry on [canopy's triggers page](https://canopy.example/?view=triggers).";
    expect(written).toEqual([`12:comment:canopy ran on this issue and committed nothing.${retry}`]);
    await deliver(h, "github", 13);
    h.onRun({ ...(runs[1] as Run), status: "failed", error: "no worktree" });
    await h.idle();
    expect(written[1]).toBe(`13:comment:canopy's run on this issue failed: no worktree.${retry}`);
  });

  test("a Forgejo event's landing closes the issue, with no PR to name", async () => {
    await fjRule();
    const h = writeHub();
    await h.adopt();
    await deliver(h, "forgejo", 7);
    const r = runs[0] as Run;
    ready(h, r);
    h.onLanding([], [landedEntry(r)]);
    h.onLanding([], [landedEntry(r)]);
    await h.idle();
    expect(written).toEqual(["7:close:"]);
    expect(h.list()[0]).toMatchObject({ status: "merged", resolved: { at: 1000 } });
  });

  test("write: false writes nothing", async () => {
    await ghRule({ write: false });
    const h = writeHub();
    await h.adopt();
    await deliver(h, "github", 12);
    const r = runs[0] as Run;
    ready(h, r);
    h.onPrs([prOf(r, "open")]);
    h.onPrs([prOf(r, "merged")]);
    await h.idle();
    expect(written).toEqual([]);
    expect(h.list()[0]).toMatchObject({ status: "merged" });
    expect(h.list()[0]?.resolved).toBeUndefined();
    expect(h.list()[0]?.linked).toBeUndefined();
  });

  test("a test fire writes nothing either", async () => {
    await ghRule();
    const h = writeHub();
    await h.adopt();
    await h.fire("gh", "Show the last sync time");
    const r = runs[0] as Run;
    ready(h, r);
    h.onPrs([prOf(r, "merged")]);
    await h.idle();
    expect(written).toEqual([]);
    expect(h.list()[0]).toMatchObject({ status: "merged", source: "manual" });
  });

  test("a refused close stays on the event, and the next event still delivers", async () => {
    await fjRule();
    const h = writeHub({
      writeIssue: async () => {
        throw new Error("Forgejo answered 401");
      },
    });
    await h.adopt();
    await deliver(h, "forgejo", 7);
    const r = runs[0] as Run;
    ready(h, r);
    h.onLanding([], [landedEntry(r)]);
    await h.idle();
    expect(h.list()[0]).toMatchObject({ status: "merged", resolved: { error: "Forgejo answered 401" } });
    await deliver(h, "forgejo", 8);
    expect(h.list().find((e) => e.key === "8")).toMatchObject({ status: "working", runId: "r2" });
  });

  test("a refused comment stays on the event as the link's error", async () => {
    await ghRule();
    const h = writeHub({
      writeIssue: async () => {
        throw new Error("HTTP 403: Forbidden");
      },
    });
    await h.adopt();
    await deliver(h, "github", 12);
    const r = runs[0] as Run;
    ready(h, r);
    h.onPrs([prOf(r, "open")]);
    await h.idle();
    expect(h.list()[0]).toMatchObject({ status: "review", linked: { error: "HTTP 403: Forbidden" } });
  });
});
