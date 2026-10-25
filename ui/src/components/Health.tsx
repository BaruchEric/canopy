import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { checkTarget, normalizeCheck } from "../../../src/core/repohealth";
import type { HealthCheck, Repo, RepoCheckKind, RepoHealMode, RepoHealthInfo } from "../../../src/core/types";
import { api } from "../api";
import { openView } from "../clirun";
import { HEALTH_PANEL, STATE_TONE, STATE_WORD, groupRows, healthRows, healthSummary, repoChecks, repoWord, type HealthGroup, type HealthRow } from "../health";
import { HANGS_RIGHT, leavesPop, useFitPop } from "../pop";
import { PopGrip } from "./PopGrip";
import { POPUP_WORD } from "../sectiontabs";
import { useStore } from "../store";
import { escapeCloses, keepKeys } from "../surface";
import { ago } from "../util";
import { Section, useSectionClosed } from "./Surface";

/** every shown backend's rows, recomputed only when one of their inputs moves */
function useHealthRows(): HealthRow[] {
  const { health, order, conns } = useStore(useShallow((s) => ({ health: s.health, order: s.backendOrder, conns: s.conns })));
  return useMemo(() => healthRows(health, order, conns, Date.now()), [health, order, conns]);
}

/** the groups, with each repo named as the tree names it */
function useHealthGroups(rows: readonly HealthRow[]): HealthGroup[] {
  const repos = useStore((s) => s.repos);
  const many = useStore((s) => s.backendOrder.length > 1);
  return useMemo(() => groupRows(rows, many, (_b, id) => repos.find((r) => r.id === id)?.name ?? id), [rows, many, repos]);
}

const when = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

type HealCall = { kind: "idle" } | { kind: "busy" } | { kind: "failed"; error: string };

function HealButton({ backend, check }: { backend: string; check: HealthCheck }) {
  const healCheck = useStore((s) => s.healCheck);
  const [call, setCall] = useState<HealCall>({ kind: "idle" });
  const busy = call.kind === "busy";
  return (
    <>
      <button
        type="button"
        className="mini"
        disabled={busy}
        title={check.state === "gave-up" ? "Try again, and start counting heals afresh" : "Heal it now"}
        onClick={() => {
          setCall({ kind: "busy" });
          healCheck(backend, check.id).then(
            () => setCall({ kind: "idle" }),
            (e: unknown) => setCall({ kind: "failed", error: e instanceof Error ? e.message : String(e) }),
          );
        }}
      >
        {busy ? "healing…" : check.state === "gave-up" ? "try again" : "heal"}
      </button>
      {call.kind === "failed" && (
        <span className="health-err" role="alert">
          {call.error}
        </span>
      )}
    </>
  );
}

function HealthItem({ row, open }: { row: HealthRow; open: boolean }) {
  const { check } = row;
  const [shown, setShown] = useState(open);
  useEffect(() => setShown(open), [open]);
  const word = STATE_WORD[check.state];
  // the count stays until the check has held for a while; on a well row it reads as trouble
  const fails = check.state === "ok" ? 0 : check.fails;
  const healIn = check.state === "healing" && check.nextHeal !== null ? Math.max(0, Math.round((check.nextHeal - Date.now()) / 1000)) : null;
  return (
    <li className={`health-row ${check.state}`}>
      <span className="health-main">
        <button type="button" className="health-label" aria-expanded={shown} title="What it has been through" onClick={() => setShown(!shown)}>
          {check.label}
        </button>
        <span className={`health-state ${STATE_TONE[check.state]}`}>{word}</span>
        {check.state !== "off" && (
          <span className="health-fact" title={new Date(check.since).toLocaleString()}>
            {check.state === "ok" ? "since " : ""}
            {ago(check.since / 1000)}
          </span>
        )}
        {check.button && (check.state === "down" || check.state === "gave-up" || check.state === "healing") && <HealButton backend={row.backend} check={check} />}
      </span>
      {check.why && <span className="health-why">{check.why}</span>}
      {(check.detail || healIn !== null || fails > 0) && (
        <span className="health-fact">
          {[check.detail, healIn !== null ? `next heal in ${healIn}s` : null, fails > 0 ? `${fails} failed ${fails === 1 ? "heal" : "heals"}` : null]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
      {shown && (
        <ol className="health-history">
          {check.history.length === 0 && <li className="health-fact">nothing has changed yet</li>}
          {[...check.history].reverse().map((h) => (
            <li key={`${h.at}-${h.state}`}>
              <span className="health-fact">{when(h.at)}</span> <span className={STATE_TONE[h.state]}>{STATE_WORD[h.state]}</span>
              {h.why && <span className="health-fact"> {h.why}</span>}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

/** Every check, grouped by backend and by canopy or repo, the broken first.
 *  `open` shows every row's history. `only` keeps one repo's group (its
 *  qualified id), for a repo's panel. */
export function HealthList({ open = false, only }: { open?: boolean; only?: string }) {
  const rows = useHealthRows();
  const groups = useHealthGroups(rows).filter((g) => only === undefined || g.repoId === only);
  if (groups.length === 0) return <p className="health-empty">{only === undefined ? "No backend has said anything yet." : "No checks for this repo."}</p>;
  return (
    <div className="health-list">
      {groups.map((g) => (
        <section key={g.key} className="health-group">
          {only === undefined && <h3 className="panel-label">{g.title}</h3>}
          <ul>
            {g.rows.map((row) => (
              <HealthItem key={`${row.backend}\u0000${row.check.id}`} row={row} open={open} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The pulse drawn for the chip */
function Pulse() {
  return (
    <svg className="health-pulse" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3,12 8,12 10,7 14,17 16,12 21,12" />
    </svg>
  );
}

/**
 * What the health popover shows: its head, with the panel and the page one
 * click away, and every check. It is its own component so the popover and a
 * tab in a shell window (FR-030) draw the same thing. `onDone` closes the
 * popover after a move takes the list somewhere else; a tab has nothing to
 * close.
 */
export function HealthPopBody({ onDone }: { onDone?: () => void }) {
  const openPanel = useStore((s) => s.openPanel);
  return (
    <>
      <div className="health-pop-head">
        <h3 className="panel-label">health</h3>
        <span className="spacer" />
        <button
          type="button"
          className="mini"
          onClick={() => {
            openPanel(HEALTH_PANEL);
            onDone?.();
          }}
        >
          open as panel
        </button>
        <button
          type="button"
          className="mini"
          onClick={() => {
            openView("health");
            onDone?.();
          }}
        >
          open page
        </button>
      </div>
      <HealthList />
    </>
  );
}

/**
 * The top bar's health chip: a quiet pulse while every check is well, amber
 * with a count while something heals, rust with a count when something is
 * down or gave up. Open, it lists every check, with the panel and the page
 * one click away.
 */
export function HealthChip() {
  const rows = useHealthRows();
  const sum = healthSummary(rows, Date.now());
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (leavesPop(e.target, ref)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => escapeCloses(e, () => setOpen(false));
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (rows.length === 0) return null;
  const label = sum.level === "ok" ? "Health: every check is well" : `Health: ${sum.word}`;
  return (
    <div className="settings health" ref={ref}>
      <button
        type="button"
        className={`mini health-chip ${sum.level}${open ? " on" : ""}`}
        aria-label={label}
        aria-expanded={open}
        title={sum.level === "ok" ? "Every check is well" : sum.title}
        onClick={() => setOpen(!open)}
      >
        <Pulse />
        {sum.count > 0 && <span className="health-count">{sum.count}</span>}
      </button>
      {open && (
        <div className="settings-pop health-pop" role="dialog" aria-label="Health">
          <HealthPopBody onDone={() => setOpen(false)} />
          <PopGrip name="health" anchor={HANGS_RIGHT} gear tab={{ kind: "popup", ref: "health", label: POPUP_WORD.health }} />
        </div>
      )}
    </div>
  );
}

/** The health page (`?view=health`): the same list, every history open. */
export function HealthView() {
  return (
    <main className="health-view">
      <HealthList open />
    </main>
  );
}

/** one repo's checks from every backend, kept only while they change */
function useRepoChecks(repoId: string): HealthCheck[] {
  return useStore(useShallow((s) => repoChecks(s.health, repoId)));
}

/** The card's word for its repo's checks: "up · 42ms", "2 of 3 up",
 *  "down 3m". A click opens the repo's panel on its health section. */
export function RepoHealthChip({ repoId }: { repoId: string }) {
  const checks = useRepoChecks(repoId);
  const showHealth = useStore((s) => s.showHealth);
  const word = repoWord(checks, Date.now());
  if (!word) return null;
  return (
    <button
      type="button"
      className={`run-chip health-card ${word.tone}`}
      title={word.title}
      onClick={(e) => {
        e.stopPropagation();
        showHealth(repoId);
      }}
      onAuxClick={(e) => e.stopPropagation()}
      onKeyDown={keepKeys}
    >
      {word.text}
    </button>
  );
}

const KIND_WORD: Record<RepoCheckKind, string> = {
  http: "an address answers",
  port: "a port is open",
  task: "a task runs",
  compose: "a compose service runs",
  command: "a command passes",
};

/** what the kind's one field is called, and its placeholder */
const KIND_FIELD: Record<RepoCheckKind, { label: string; hint: string }> = {
  http: { label: "url", hint: "http://127.0.0.1:5173/" },
  port: { label: "port", hint: "5432" },
  task: { label: "task", hint: "dev" },
  compose: { label: "service", hint: "postgres" },
  command: { label: "run", hint: "bun run smoke" },
};

/** The check a form's fields make, through the same rules the server keeps */
function formCheck(name: string, kind: RepoCheckKind, field: string, heal: RepoHealMode, fix: string, every: string, during: string) {
  const value = kind === "port" ? Number(field) : field;
  const key = kind === "http" ? "url" : kind === "command" ? "run" : kind === "compose" ? "service" : kind;
  return normalizeCheck({
    name,
    kind,
    [key]: value,
    heal,
    ...(fix.trim() ? { fix } : {}),
    ...(every.trim() ? { every: Number(every) } : {}),
    ...(during.trim() && kind !== "task" ? { while: during.trim() } : {}),
  });
}

function AddCheck({ repo, onSaved }: { repo: Repo; onSaved: (info: RepoHealthInfo) => void }) {
  const kinds: RepoCheckKind[] = repo.host ? ["http", "port"] : ["http", "port", "task", "compose", "command"];
  const [name, setName] = useState("");
  const [kind, setKind] = useState<RepoCheckKind>("http");
  const [field, setField] = useState("");
  const [heal, setHeal] = useState<RepoHealMode>("button");
  const [fix, setFix] = useState("");
  const [every, setEvery] = useState("");
  const [during, setDuring] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const check = formCheck(name.trim(), kind, field.trim(), heal, fix, every, during);
    if (typeof check === "string") return setError(check);
    setBusy(true);
    setError("");
    api.saveRepoCheck(repo.id, check).then(
      (info) => {
        setBusy(false);
        setName("");
        setField("");
        setFix("");
        onSaved(info);
      },
      (err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  };
  const f = KIND_FIELD[kind];
  return (
    <form className="health-form" onSubmit={submit} onKeyDown={keepKeys}>
      <label>
        <span className="health-fact">name</span>
        <input className="settings-input" value={name} placeholder="site" onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        <span className="health-fact">checks that</span>
        <select className="settings-input" value={kind} onChange={(e) => setKind(e.target.value as RepoCheckKind)}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_WORD[k]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="health-fact">{f.label}</span>
        <input className="settings-input" value={field} placeholder={f.hint} inputMode={kind === "port" ? "numeric" : undefined} onChange={(e) => setField(e.target.value)} />
      </label>
      {!repo.host && (
        <label>
          <span className="health-fact">fix (optional)</span>
          <input className="settings-input" value={fix} placeholder="docker compose up -d" onChange={(e) => setFix(e.target.value)} />
        </label>
      )}
      <label>
        <span className="health-fact">heal</span>
        <select className="settings-input" value={heal} onChange={(e) => setHeal(e.target.value as RepoHealMode)}>
          <option value="button">by a button</option>
          <option value="auto">on its own</option>
          <option value="none">never</option>
        </select>
      </label>
      {kind !== "task" && (
        <label>
          <span className="health-fact">only while task runs</span>
          <input className="settings-input" value={during} placeholder="dev" onChange={(e) => setDuring(e.target.value)} />
        </label>
      )}
      <label>
        <span className="health-fact">every (s)</span>
        <input className="settings-input" value={every} placeholder="30" inputMode="numeric" onChange={(e) => setEvery(e.target.value)} />
      </label>
      <span className="health-form-foot">
        <button type="submit" className="mini" disabled={busy}>
          {busy ? "adding…" : "add check"}
        </button>
        {error && (
          <span className="health-err" role="alert">
            {error}
          </span>
        )}
      </span>
    </form>
  );
}

/**
 * A repo's health in its panel: its checks live, what its file got wrong,
 * and the checks canopy keeps for it here, with a form to add one. The
 * repo's own checks live in its `.canopy/health.json`.
 */
export function HealthSection({ repo }: { repo: Repo }) {
  const closed = useSectionClosed(repo.id, "health");
  const checks = useRepoChecks(repo.id);
  const [info, setInfo] = useState<RepoHealthInfo | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  // the defs follow the live list: a new or removed check reloads them
  const names = checks.map((c) => c.label).join("\u0000");
  useEffect(() => {
    if (closed) return;
    api.repoHealth(repo.id).then(setInfo, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [closed, repo.id, names]);
  const word = repoWord(checks, Date.now());
  const own = info?.checks.filter((c) => c.source === "canopy") ?? [];
  const remove = (name: string) =>
    api.removeRepoCheck(repo.id, name).then(setInfo, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  return (
    <Section
      repo={repo}
      k="health"
      className="health-section"
      label="Health"
      head={word ? <span className={word.tone}>{word.text}</span> : ""}
      title="What canopy checks for this repo: its .canopy/health.json, and the checks added here"
      copy={() => checks.map((c) => `${c.label}  ${STATE_WORD[c.state]}${c.why ? `  ${c.why}` : ""}`).join("\n")}
      tools={
        <button type="button" className="mini health-add" aria-expanded={adding} title="Add a check canopy keeps for this repo here" onClick={() => setAdding(!adding)}>
          {adding ? "done" : "add"}
        </button>
      }
    >
      <div className="health-body">
        {checks.length > 0 ? <HealthList only={repo.id} /> : <p className="health-empty">No checks yet. Add one here, or list them in .canopy/health.json.</p>}
        {info?.errors.map((e) => (
          <p key={e} className="health-err">
            {e}
          </p>
        ))}
        {error && <p className="health-err">{error}</p>}
        {adding && (
          <>
            {own.length > 0 && (
              <ul className="health-defs">
                {own.map((c) => (
                  <li key={c.name}>
                    <span>{c.name}</span> <span className="health-fact">{checkTarget(c)}</span>
                    <button type="button" className="mini" onClick={() => void remove(c.name)}>
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <AddCheck repo={repo} onSaved={setInfo} />
          </>
        )}
      </div>
    </Section>
  );
}
