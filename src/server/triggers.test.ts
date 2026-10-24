import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TriggerEvent, TriggerRule } from "../core/trigger";
import type { Flow, PrWatch, Repo, Run } from "../core/types";
import { LinearError } from "./linear";
import { signatureOk, TriggerHub, type AgentSay, type StartOutcome, type TriggerDeps } from "./triggers";

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
    workflowProblem: async (name) => (name === "sentry-fix" ? null : `unknown workflow: ${name}`),
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
