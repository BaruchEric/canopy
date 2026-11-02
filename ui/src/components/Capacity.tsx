import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { hitStands } from "../../../src/core/capacity";
import type { CapacityInfo } from "../../../src/core/types";
import { api } from "../api";
import { AGENT_NAME } from "../runs";
import { leavesPop, useFitPop } from "../pop";
import { qual } from "../registry";
import { useNow } from "./Registry";
import { useStore, idText } from "../store";
import { escapeCloses } from "../surface";
import { ageWord, CAPACITY_GLYPH, capacityRows, capacityWord, heldRows, holdPercent, rowsTone, settingsPatch, type CapacityRow } from "../capacity";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One row per backend and harness: the windows, the source, a standing
 *  hit. With no reading the source line says so on its own, and Claude's
 *  row points at the observed dollar figure from wherever the reader is:
 *  the chip sends them to the costs view, the costs view to its own form. */
export function ReadingRows({ rows, now, where }: { rows: CapacityRow[]; now: number; where: "chip" | "costs" }) {
  const hint = where === "chip" ? "set the observed dollar figure in the costs view to estimate from the ledger" : "set a 5-hour window in Claude $ below to estimate from the ledger";
  return (
    <div className="capacity-rows">
      {rows.map((row) => (
        <section className="capacity-row" key={`${row.backend}\u0000${row.cap.harness}`}>
          <h4>{row.backend} · {AGENT_NAME[row.cap.harness]}</h4>
          {row.lines.map((line) => (
            <span className={`capacity-reading ${row.tone}`} key={line}>{line}</span>
          ))}
          <span className="capacity-source">{row.source}</span>
          {row.lines.length === 0 && row.cap.harness === "claude" && <span className="capacity-hint">{hint}</span>}
          {row.cap.hit !== null && hitStands(row.cap.hit, now) && (
            <span className="capacity-hit">limit hit {ageWord(now - row.cap.hit.at)}: {row.cap.hit.text}</span>
          )}
        </section>
      ))}
    </div>
  );
}

/** The starts the governor holds on every backend, each with "start anyway",
 *  a one-off interactive start (FR-036). */
function HeldList({ capacity, order }: { capacity: Record<string, CapacityInfo>; order: string[] }) {
  const repos = useStore((s) => s.repos);
  const loadCapacity = useStore((s) => s.loadCapacity);
  const rows = useMemo(() => heldRows(capacity, order), [capacity, order]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (rows.length === 0) return null;
  const release = async (backend: string, id: string): Promise<void> => {
    setBusy(`${backend} ${id}`);
    setError(null);
    try {
      await api.capacityRelease(backend, id);
      await loadCapacity(backend);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="capacity-held">
      <h4 className="panel-label">held for capacity</h4>
      <ul>
        {rows.map(({ backend, held }) => (
          <li key={`${backend} ${held.id}`}>
            <span className="capacity-limited-name">
              {held.what} · {repos.find((r) => r.id === qual(backend, held.repoId))?.name ?? idText(held.repoId)}
            </span>
            <span className="capacity-limited-error">{held.priority} · {held.why}</span>
            <button type="button" className="mini" disabled={busy !== null} title="Start it now, this once, as interactive" onClick={() => void release(backend, held.id)}>
              {busy === `${backend} ${held.id}` ? "starting…" : "start anyway"}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="capacity-hit rust" role="alert">{error}</p>}
    </section>
  );
}

/** The usage windows for every backend that has answered, with the held
 *  starts and the limited runs below. */
export function CapacityChip() {
  const { capacity, order } = useStore(useShallow((s) => ({ capacity: s.capacity, order: s.backendOrder })));
  const limited = useStore(useShallow((s) => Object.values(s.runs)
    .filter((run) => run.status === "limited")
    .sort((a, b) => (b.limited?.at ?? b.startedAt) - (a.limited?.at ?? a.startedAt))));
  const repos = useStore((s) => s.repos);
  const now = useNow();
  const rows = useMemo(() => capacityRows(capacity, order, now), [capacity, order, now]);
  const word = capacityWord(rows);
  const tone = rowsTone(rows);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (leavesPop(event.target, ref)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => escapeCloses(event, () => setOpen(false));
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (rows.length === 0) return null;
  const held = heldRows(capacity, order).length;
  return (
    <div className="settings capacity" ref={ref}>
      <button
        type="button"
        className={`mini capacity-chip ${tone}${open ? " on" : ""}`}
        aria-label={`Capacity: ${word}${held > 0 ? `, ${held} held` : ""}`}
        aria-expanded={open}
        title="Usage windows by backend"
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">{CAPACITY_GLYPH}</span>
        {word}
        {held > 0 && <span className="capacity-held-count">· {held} held</span>}
      </button>
      {open && (
        <div className="settings-pop capacity-pop" role="dialog" aria-label="Capacity">
          <h3 className="panel-label">capacity</h3>
          <ReadingRows rows={rows} now={now} where="chip" />
          <HeldList capacity={capacity} order={order} />
          {limited.length > 0 && (
            <section className="capacity-limited">
              <h4 className="panel-label">waiting for capacity</h4>
              <ul>
                {limited.map((run) => (
                  <li key={run.id}>
                    <span className="capacity-limited-name">{run.verb} · {repos.find((repo) => repo.id === run.repoId)?.name ?? idText(run.repoId)}</span>
                    {run.error && <span className="capacity-limited-error">{run.error}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** One backend's thresholds and observed dollar figure, saved as a patch. */
function SettingsForm({ backend, info }: { backend: string; info: CapacityInfo }) {
  const loadCapacity = useStore((s) => s.loadCapacity);
  const s = info.settings;
  const shown = { low: holdPercent(s.lowHold), normal: holdPercent(s.normalHold), weekly: holdPercent(s.weeklyLowHold), usd: s.observedFiveHourUsd === null ? "" : String(s.observedFiveHourUsd) };
  const [form, setForm] = useState(shown);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const key = JSON.stringify(shown);
  // a change from elsewhere (the CLI, another page) shows when it lands
  useEffect(() => setForm(JSON.parse(key) as typeof shown), [key]);
  const field = (name: keyof typeof form, label: string, hint: string) => (
    <label className="capacity-field">
      <span>{label}</span>
      <input className="settings-input" inputMode="decimal" value={form[name]} placeholder={hint} onChange={(e) => setForm({ ...form, [name]: e.target.value })} />
    </label>
  );
  const save = async (): Promise<void> => {
    const patch = settingsPatch(form);
    if (typeof patch === "string") {
      setSaid({ ok: false, text: patch });
      return;
    }
    try {
      await api.capacitySettings(backend, patch);
      await loadCapacity(backend);
      setSaid({ ok: true, text: "saved" });
    } catch (e) {
      setSaid({ ok: false, text: errText(e) });
    }
  };
  return (
    <form className="capacity-settings" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h4>{backend}</h4>
      {field("low", "hold low work past %", "70")}
      {field("normal", "hold normal work past %", "90")}
      {field("weekly", "hold low work past % of the week", "85")}
      {field("usd", "a 5-hour window in Claude $", "none")}
      <span className="capacity-actions">
        <button type="submit" className="mini">save</button>
        {said && <span className={said.ok ? "capacity-source" : "capacity-hit rust"} role={said.ok ? undefined : "alert"}>{said.text}</span>}
      </span>
    </form>
  );
}

/** The costs view's capacity block (FR-036): the same rows as the chip, the
 *  held starts, and each backend's thresholds. */
export function CapacityBlock() {
  const { capacity, order } = useStore(useShallow((s) => ({ capacity: s.capacity, order: s.backendOrder })));
  const now = useNow();
  const rows = useMemo(() => capacityRows(capacity, order, now), [capacity, order, now]);
  if (rows.length === 0) return null;
  return (
    <section className="cost-group capacity-block">
      <h3 className="panel-label">capacity</h3>
      <ReadingRows rows={rows} now={now} where="costs" />
      <HeldList capacity={capacity} order={order} />
      <details className="capacity-holds">
        <summary>the governor's holds</summary>
        <p className="cost-note">
          Interactive work (a run, chat or ask you start) is never held. Normal work (a PR's auto-fix, a coordinator's cards, a flow's later steps) waits past the normal hold or on a limit hit; low work (triggers, best-of-N groups) waits past the low holds too. With no usage endpoint, the 5-hour share is the ledger's Claude dollars over the last five hours against the figure below; with no figure, nothing is held until a limit is hit.
        </p>
        {order.filter((b) => capacity[b]).map((b) => (
          <SettingsForm key={b} backend={b} info={capacity[b]!} />
        ))}
      </details>
    </section>
  );
}
