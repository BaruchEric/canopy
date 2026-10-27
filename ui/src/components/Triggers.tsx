import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { SAMPLE_TITLE, SERVICE_NAME, type TriggerRuleInfo, type TriggersInfo } from "../../../src/core/trigger";
import { baseOf } from "../registry";
import { copyText } from "../share";
import { useStore } from "../store";
import { STATUS_TONE, STATUS_WORD, eventActs, outcomeLine, ruleIntake, serviceOf, triggerSections, type TriggerRow } from "../triggers";
import { ago } from "../util";

type Call = { kind: "idle" } | { kind: "busy" } | { kind: "failed"; error: string };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const ACT_WORD = { stop: "stop", resume: "resume", retry: "start again", dismiss: "dismiss" } as const;
const ACT_TITLE = {
  stop: "Stop the run, or take it off the queue",
  resume: "Pick the stopped run up where it left off, on the same branch and session",
  retry: "Start a new run on a new branch",
  dismiss: "Take it off this list",
} as const;

/** The repo's name as the tree shows it, else its id. */
function useRepoName(id: string): string {
  return useStore((s) => s.repos.find((r) => r.id === id)?.name ?? id);
}

function EventRow({ row, many }: { row: TriggerRow; many: boolean }) {
  const { event: e, backend } = row;
  const { showRun, triggerAct, dismissTrigger } = useStore(useShallow((s) => ({ showRun: s.showRun, triggerAct: s.triggerAct, dismissTrigger: s.dismissTrigger })));
  const repo = useRepoName(e.repoId);
  const [call, setCall] = useState<Call>({ kind: "idle" });
  const outcome = outcomeLine(e);
  const service = serviceOf(e);
  const act = (a: "stop" | "resume" | "retry" | "dismiss") => {
    setCall({ kind: "busy" });
    (a === "dismiss" ? dismissTrigger(e.id) : triggerAct(e.id, a)).then(
      () => setCall({ kind: "idle" }),
      (err: unknown) => setCall({ kind: "failed", error: errText(err) }),
    );
  };
  return (
    <li className={`trigger-row ${STATUS_TONE[e.status]}`}>
      <div className="trigger-main">
        {e.runId ? (
          <button type="button" className="trigger-title" title="Open the run" onClick={() => showRun(e.runId ?? "")}>
            {e.title}
          </button>
        ) : (
          <span className="trigger-title">{e.title}</span>
        )}
        {e.pr && (
          <a className="trigger-pr" href={e.pr.url} target="_blank" rel="noreferrer">
            Pull request #{e.pr.number}
          </a>
        )}
      </div>
      <div className="trigger-facts">
        <span className={`trigger-state ${STATUS_TONE[e.status]}`}>{STATUS_WORD[e.status]}</span>
        {e.step && <span title="the workflow's step in progress">{e.step}</span>}
        <span className="trigger-id">{e.short ?? e.key}</span>
        <span>{repo}</span>
        {many && <span>on {backend}</span>}
        <span title={new Date(e.lastAt).toLocaleString()}>{ago(e.lastAt / 1000)}</span>
        {e.count > 1 && <span title={`times ${service} sent this issue`}>×{e.count}</span>}
        {e.source === "manual" && <span>test fire</span>}
        {e.session && <span title="Delegated to canopy in Linear: its agent session hears how the run goes">agent session</span>}
        {e.link && (
          <a href={e.link} target="_blank" rel="noreferrer">
            {service}
          </a>
        )}
        <span className="trigger-acts">
          {eventActs(e).map((a) => (
            <button key={a} type="button" className="mini" disabled={call.kind === "busy"} title={ACT_TITLE[a]} onClick={() => act(a)}>
              {ACT_WORD[a]}
            </button>
          ))}
        </span>
      </div>
      {outcome && <div className={`trigger-outcome${e.status === "merged" && e.resolved && "at" in e.resolved ? " moss" : ""}`}>{outcome}</div>}
      {call.kind === "failed" && (
        <div className="trigger-err" role="alert">
          {call.error}
        </div>
      )}
    </li>
  );
}

function FireForm({ backend, rule }: { backend: string; rule: TriggerRuleInfo }) {
  const fireTrigger = useStore((s) => s.fireTrigger);
  const [title, setTitle] = useState("");
  const [call, setCall] = useState<Call | { kind: "done"; text: string }>({ kind: "idle" });
  return (
    <form
      className="trigger-fire"
      onSubmit={(ev) => {
        ev.preventDefault();
        setCall({ kind: "busy" });
        fireTrigger(backend, rule.name, title).then(
          (d) => {
            setTitle("");
            setCall({ kind: "done", text: d.kind === "skip" ? d.why : `${d.kind}: ${d.event.short ?? d.event.key}` });
          },
          (err: unknown) => setCall({ kind: "failed", error: errText(err) }),
        );
      }}
    >
      <input
        type="text"
        value={title}
        placeholder={SAMPLE_TITLE[rule.source]}
        aria-label={`Issue title for a test fire of ${rule.name}`}
        onChange={(ev) => setTitle(ev.target.value)}
      />
      <button type="submit" className="mini" disabled={call.kind === "busy" || Boolean(rule.problem)} title="Fire a made-up issue through this rule: a real branch run starts on the repo">
        {call.kind === "busy" ? "firing…" : "try it"}
      </button>
      {call.kind === "done" && <span className="trigger-note">{call.text}</span>}
      {call.kind === "failed" && (
        <span className="trigger-err" role="alert">
          {call.error}
        </span>
      )}
      {rule.poll && <PollButton backend={backend} rule={rule} />}
    </form>
  );
}

/** "poll now" on a rule that polls: its labelled issues listed at once, a run for each new one. */
function PollButton({ backend, rule }: { backend: string; rule: TriggerRuleInfo }) {
  const pollTrigger = useStore((s) => s.pollTrigger);
  const [call, setCall] = useState<Call | { kind: "done" }>({ kind: "idle" });
  return (
    <>
      <button
        type="button"
        className="mini"
        disabled={call.kind === "busy" || Boolean(rule.problem)}
        title="List the repo's labelled issues now, without waiting for the poll, and start a run for each new one"
        onClick={() => {
          setCall({ kind: "busy" });
          pollTrigger(backend, rule.name).then(
            () => setCall({ kind: "done" }),
            (err: unknown) => setCall({ kind: "failed", error: errText(err) }),
          );
        }}
      >
        {call.kind === "busy" ? "polling…" : "poll now"}
      </button>
      {call.kind === "done" && <span className="trigger-note">polled</span>}
      {call.kind === "failed" && (
        <span className="trigger-err" role="alert">
          {call.error}
        </span>
      )}
    </>
  );
}

function RuleCard({ backend, rule, origin }: { backend: string; rule: TriggerRuleInfo; origin: string }) {
  const repo = useRepoName(rule.repo);
  const intake = ruleIntake(rule, origin);
  const [copied, setCopied] = useState(false);
  const name = SERVICE_NAME[rule.source];
  const writesBack =
    rule.source === "linear"
      ? "A Linear API key, or the Linear app's own token, lets canopy put the PR's link on the issue and move it to done once the fix merges"
      : "A Sentry token lets canopy mark the issue resolved once the fix merges";
  // the server writes back with the rule's key, else with the app's token
  const writes = rule.tokenSet || rule.agentSet;
  return (
    <li className="trigger-rule">
      <div className="trigger-main">
        <span className="trigger-rule-name">{rule.name}</span>
        <span className="trigger-facts">
          <span>
            {rule.source} → {repo}
          </span>
          {rule.source !== "sentry" && <span title="Adding one of these labels to an issue starts the run">on label {rule.labels.join(", ")}</span>}
          {rule.clientSecretEnv && (
            <span className={rule.agentSet ? "moss" : "rust"} title="Delegating an issue to the Linear app, or mentioning it, starts the run, and the session hears how it goes">
              {rule.agentSet ? "agent on" : `${rule.clientSecretEnv} not set`}
            </span>
          )}
          <span>runs {rule.workflow}</span>
          <span className={rule.secretSet ? "moss" : rule.secretEnv ? "rust" : "faint"}>{rule.secretSet ? "secret set" : rule.secretEnv ? `${rule.secretEnv} not set` : "no hook secret"}</span>
          {intake.poll && (
            <span title={rule.nextFire ? `Next poll ${new Date(rule.nextFire).toLocaleString()}; a hook delivery that never arrived is caught up here` : "Its issues come in by polling"}>
              {intake.poll}
            </span>
          )}
          <span className={writes ? "moss" : "faint"} title={writesBack}>
            {writes ? (rule.source === "linear" ? "writes back to Linear" : "resolves in Sentry") : `leaves issues open in ${name}`}
          </span>
        </span>
      </div>
      {intake.hook && (
        <div className="trigger-hook">
          <code>{intake.hook}</code>
          <button
            type="button"
            className="mini"
            onClick={() => {
              void copyText(intake.hook ?? "").then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>
      )}
      {rule.install && (
        <div className="trigger-note">
          <a href={`${origin}${rule.install}`} target="_blank" rel="noreferrer" title="A workspace admin installs the Linear app as itself, so issues can be delegated to it and it can be mentioned">
            Install in Linear
          </a>
          {!rule.organization && " · takes deliveries from any workspace the app is in until the rule names one"}
        </div>
      )}
      {rule.problem && <div className="trigger-err">{rule.problem}</div>}
      <FireForm backend={backend} rule={rule} />
    </li>
  );
}

function Rules({ backend, info, many }: { backend: string; info: TriggersInfo; many: boolean }) {
  const origin = baseOf(backend) || window.location.origin;
  return (
    <section className="trigger-group">
      <h3 className="panel-label">{many ? `Rules on ${backend}` : "Rules"}</h3>
      {!info.keeping && <p className="trigger-note">This backend does not hold the flows lock, so its hooks start nothing.</p>}
      {info.problems.map((p) => (
        <p key={p} className="trigger-err">
          {p}
        </p>
      ))}
      <ul>
        {info.rules.map((r) => (
          <RuleCard key={r.name} backend={backend} rule={r} origin={origin} />
        ))}
      </ul>
    </section>
  );
}

/** The triggers view: each backend's rules with their hook and a test fire,
 *  then every event in sections, the ones that need Eric first. */
export function TriggersView() {
  const { triggers, order } = useStore(useShallow((s) => ({ triggers: s.triggers, order: s.backendOrder })));
  const sections = useMemo(() => triggerSections(triggers, order), [triggers, order]);
  const backends = order.filter((b) => triggers[b] !== undefined);
  const many = backends.length > 1;
  const anyRule = backends.some((b) => (triggers[b]?.rules.length ?? 0) > 0);
  return (
    <main className="health-view trigger-view">
      {backends.map((b) => {
        const info = triggers[b];
        return info && (info.rules.length > 0 || info.problems.length > 0) ? <Rules key={b} backend={b} info={info} many={many} /> : null;
      })}
      {!anyRule && (
        <section className="trigger-group">
          <h3 className="panel-label">Rules</h3>
          <p className="trigger-note">
            No trigger rules yet. Add one to <code>triggers.json</code> in canopy's config folder, naming the source (<code>sentry</code>, <code>linear</code>, <code>github</code> or{" "}
            <code>forgejo</code>), the repo and the environment variable holding the hook's secret. canopy ships <code>sentry-fix</code>, <code>linear-issue</code> and <code>issue-fix</code> as
            their workflows. Then point a Sentry internal integration's webhook, a Linear webhook for issues, or a GitHub or Forgejo webhook for issues, at the address this page shows. A
            GitHub or Forgejo rule with no secret polls the repo's labelled issues instead.
          </p>
        </section>
      )}
      {sections.map((s) => (
        <section key={s.key} className="trigger-group">
          <h3 className="panel-label">
            {s.title} <span className="trigger-count">{s.rows.length}</span>
          </h3>
          <ul>
            {s.rows.map((row) => (
              <EventRow key={row.event.id} row={row} many={many} />
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
