import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { TriggerRuleInfo, TriggersInfo } from "../../../src/core/trigger";
import { baseOf } from "../registry";
import { copyText } from "../share";
import { useStore } from "../store";
import { STATUS_TONE, STATUS_WORD, eventActs, hookAddress, outcomeLine, triggerSections, type TriggerRow } from "../triggers";
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
        {e.count > 1 && <span title="times Sentry sent this issue">×{e.count}</span>}
        {e.source === "manual" && <span>test fire</span>}
        {e.link && (
          <a href={e.link} target="_blank" rel="noreferrer">
            Sentry
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
        placeholder="TypeError: Cannot read properties of undefined (reading 'percent')"
        aria-label={`Error title for a test fire of ${rule.name}`}
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
    </form>
  );
}

function RuleCard({ backend, rule, origin }: { backend: string; rule: TriggerRuleInfo; origin: string }) {
  const repo = useRepoName(rule.repo);
  const address = hookAddress(origin, rule.hook);
  const [copied, setCopied] = useState(false);
  return (
    <li className="trigger-rule">
      <div className="trigger-main">
        <span className="trigger-rule-name">{rule.name}</span>
        <span className="trigger-facts">
          <span>
            {rule.source} → {repo}
          </span>
          <span>runs {rule.workflow}</span>
          <span className={rule.secretSet ? "moss" : "rust"}>{rule.secretSet ? "secret set" : `${rule.secretEnv} not set`}</span>
          <span className={rule.tokenSet ? "moss" : "faint"} title="A Sentry token lets canopy mark the issue resolved once the fix merges">
            {rule.tokenSet ? "resolves in Sentry" : "leaves issues open"}
          </span>
        </span>
      </div>
      <div className="trigger-hook">
        <code>{address}</code>
        <button
          type="button"
          className="mini"
          onClick={() => {
            void copyText(address).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
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
            No trigger rules yet. Add one to <code>triggers.json</code> in canopy's config folder, naming the repo, the Sentry secret's environment variable and a one-step workflow
            (<code>sentry-fix</code> ships with canopy). Then point a Sentry internal integration's webhook at the address this page shows.
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
