import { useEffect, useRef, useState } from "react";
import { escapeCloses } from "../surface";
import { useFitPop } from "../pop";
import { multi, useStore } from "../store";
import { ericsCrons, rangerCard, rangerLine, rangerTone, shownRangers, sizeWord, wakeWhen, worstTone } from "../ranger";
import type { RangerInfo } from "../../../src/core/types";

/** "5m ago", "3h ago" */
function ago(at: number, now: number): string {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

/** what a call that failed says, under the buttons */
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * One backend's ranger in the chip's popover: what it is doing, its
 * conversation, open its session, message it, restart it, a fresh
 * conversation, turn it off, and every wake it holds.
 */
function RangerBlock({ backend, info, close, showBackend }: { backend: string; info: RangerInfo; close: () => void; showBackend: boolean }) {
  const registry = useStore((s) => s.registry);
  const chanReady = useStore((s) => s.chan?.ready === true);
  const openRanger = useStore((s) => s.openRanger);
  const openChan = useStore((s) => s.openChan);
  const rangerAct = useStore((s) => s.rangerAct);
  const setRanger = useStore((s) => s.setRanger);
  const removeWake = useStore((s) => s.removeRangerWake);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const now = Date.now();
  const card = rangerCard(registry, info);
  const tone = rangerTone(info, card);
  const act = (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    void fn()
      .catch((e) => setErr(errText(e)))
      .finally(() => setBusy(false));
  };
  const live = info.state === "running" || info.state === "trust";
  return (
    <section className="settings-row ranger-block">
      <div className="ranger-head">
        <span className={`ranger-dot ranger-${tone}`} aria-hidden="true" />
        <strong>@{info.handle}</strong>
        {showBackend && <span className="backend-word">{backend}</span>}
        <span className="ranger-state">{rangerLine(info, card)}</span>
      </div>
      {info.why && <p className={tone === "warn" ? "settings-hint error" : "settings-hint"}>{info.why}</p>}
      <p className="settings-hint">
        {info.sessionAt !== undefined && `conversation from ${ago(info.sessionAt, now)}`}
        {info.transcriptBytes !== undefined && ` · ${sizeWord(info.transcriptBytes)}`}
        {info.restarts > 0 && ` · restarted ${info.restarts}×`}
        {info.viewers.length > 0 && ` · open on ${info.viewers.join(", ")}`}
      </p>
      {info.telegram === "contested" && (
        <p className="settings-hint error">
          Every other Claude session on {backend} still takes the Telegram bot: turn the telegram plugin off in that machine's ~/.claude/settings.json.
        </p>
      )}
      <div className="ranger-actions">
        <button
          type="button"
          className="mini"
          disabled={!live}
          title="Its session in the strip along the bottom"
          onClick={() => {
            openRanger(backend);
            close();
          }}
        >
          open
        </button>
        <button
          type="button"
          className="mini"
          disabled={!chanReady}
          title={chanReady ? `A tailchan DM to @${info.handle}, which wakes it` : "No tailchan broker on this page's backend"}
          onClick={() => {
            openChan(`@${info.handle}`);
            close();
          }}
        >
          message
        </button>
        <button type="button" className="mini" disabled={busy} title="Start it again on the same conversation" onClick={() => act(() => rangerAct(backend, "restart"))}>
          restart
        </button>
        <button type="button" className="mini" disabled={busy} title="Start it on a new conversation" onClick={() => act(() => rangerAct(backend, "fresh"))}>
          fresh conversation
        </button>
        <button type="button" className="mini" disabled={busy} title="End its session; it stays off until turned on in Settings" onClick={() => act(() => setRanger(backend, { on: false }))}>
          turn off
        </button>
      </div>
      {err && <p className="settings-hint error">{err}</p>}
      {info.wakes.length > 0 && (
        <ul className="ranger-wakes">
          {info.wakes.map((w) => (
            <li key={w.id}>
              <span className="ranger-when">{wakeWhen(w, now)}</span>
              <span className="ranger-by">{w.by === "eric" ? "yours" : "its own"}</span>
              <span className="ranger-prompt" title={w.prompt}>
                {w.prompt}
              </span>
              <button type="button" className="mini" aria-label="remove this wake" title="remove" onClick={() => act(() => removeWake(backend, w.id))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {info.wakes.length > 0 && !info.broker && <p className="settings-hint">No broker on {backend}: wakes wait until there is one.</p>}
    </section>
  );
}

/**
 * The ranger in the top bar: there only while a shown backend has one on,
 * the glyph alone where room is short (a phone's first row).
 * Moss while it runs, rust while it needs someone (gave up, the trust
 * prompt, its handle taken, or waiting on an answer). Open, each backend's
 * ranger with what it is doing and its wakes.
 */
export function RangerChip({ compact = false }: { compact?: boolean }) {
  const rangers = useStore((s) => s.rangers);
  const order = useStore((s) => s.backendOrder);
  const registry = useStore((s) => s.registry);
  const several = useStore(multi);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      escapeCloses(e, () => setOpen(false));
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = shownRangers(rangers, order);
  if (shown.length === 0) return null;
  const tone = worstTone(shown.map(([, r]) => rangerTone(r, rangerCard(registry, r))));
  const first = shown[0]?.[1];
  const title = shown.length === 1 && first ? `@${first.handle}: ${rangerLine(first, rangerCard(registry, first))}` : `${shown.length} rangers`;
  return (
    <div className="settings ranger" ref={ref}>
      <button
        type="button"
        className={open ? "mini on" : tone === "warn" ? "mini ranger-chip ranger-warn" : `mini ranger-chip ranger-${tone}`}
        aria-label="The ranger, canopy's always-on agent"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">✦</span>
        {compact ? (shown.length > 1 ? ` ${shown.length}` : null) : ` ${shown.length === 1 ? "ranger" : shown.length}`}
      </button>
      {open && (
        <div className="settings-pop ranger-pop" role="dialog" aria-label="The ranger">
          <h3 className="panel-label">ranger</h3>
          {shown.map(([b, r]) => (
            <RangerBlock key={b} backend={b} info={r} close={() => setOpen(false)} showBackend={several} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The ranger's row in Settings, for the backend the rows are scoped to: on
 * or off, the profile it runs, its handle, whether it owns the Telegram bot,
 * when canopy moves it to a fresh conversation by itself, and the crons
 * Eric sets for it.
 */
export function RangerRow({ backend }: { backend: string }) {
  const info = useStore((s) => s.rangers[backend]);
  // the object itself: keys taken in the selector would be a new array every time
  const profileMap = useStore((s) => s.agents[backend]?.profiles);
  const profiles = Object.keys(profileMap ?? {});
  const setRanger = useStore((s) => s.setRanger);
  const addWake = useStore((s) => s.addRangerWake);
  const removeWake = useStore((s) => s.removeRangerWake);
  const [handle, setHandle] = useState("");
  const [cron, setCron] = useState("");
  const [prompt, setPrompt] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // the hour and the size as typed, saved on blur or Enter rather than each
  // keystroke: "25" to "50" would otherwise pass through 5 MB on the way
  const [daily, setDaily] = useState<string | null>(null);
  const [maxMb, setMaxMb] = useState<string | null>(null);
  if (!info) return null;
  const s = info.settings;
  const save = (patch: Record<string, unknown>) => {
    setErr(null);
    void setRanger(backend, patch).catch((e) => setErr(errText(e)));
  };
  const commitDaily = () => {
    if (daily === null) return;
    const value = daily || null;
    setDaily(null);
    if (value !== s.fresh.daily) save({ fresh: { daily: value } });
  };
  const commitMaxMb = () => {
    if (maxMb === null) return;
    const value = maxMb.trim() ? Number(maxMb) : null;
    setMaxMb(null);
    if (value !== s.fresh.maxMb) save({ fresh: { maxMb: value } });
  };
  const add = () => {
    setErr(null);
    void addWake(backend, { cron: cron.trim(), prompt: prompt.trim() })
      .then(() => {
        setCron("");
        setPrompt("");
      })
      .catch((e) => setErr(errText(e)));
  };
  return (
    <section className="settings-row">
      <h3 className="panel-label">ranger</h3>
      <label className="settings-line">
        <input type="checkbox" checked={s.on} onChange={(e) => save({ on: e.target.checked })} />
        keep an always-on agent (@{info.handle}) running on {backend}
      </label>
      {s.on && <p className={info.state === "running" ? "settings-hint" : "settings-hint error"}>{rangerLine(info)}{info.why ? `: ${info.why}` : ""}</p>}
      <div className="ranger-fields">
        <label className="layout-field">
          profile
          <select className="settings-input" value={s.profile ?? ""} onChange={(e) => save({ profile: e.target.value || null })}>
            <option value="">the shell route</option>
            {profiles.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="layout-field">
          runs in
          <select className="settings-input" value={s.home} onChange={(e) => save({ home: e.target.value })}>
            <option value="own">a folder of its own</option>
            <option value="root">the scan root</option>
          </select>
        </label>
        <label className="layout-field">
          handle
          <input
            className="settings-input"
            placeholder={info.handle}
            value={handle}
            spellCheck={false}
            onChange={(e) => setHandle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && handle.trim()) {
                save({ handle: handle.trim() });
                setHandle("");
              }
            }}
          />
        </label>
        <label className="layout-field">
          fresh daily at
          <input
            className="settings-input"
            type="time"
            value={daily ?? s.fresh.daily ?? ""}
            onChange={(e) => setDaily(e.target.value)}
            onBlur={commitDaily}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitDaily();
            }}
          />
        </label>
        <label className="layout-field">
          or past (MB)
          <input
            className="settings-input"
            type="number"
            min={1}
            max={1000}
            value={maxMb ?? s.fresh.maxMb ?? ""}
            onChange={(e) => setMaxMb(e.target.value)}
            onBlur={commitMaxMb}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitMaxMb();
            }}
          />
        </label>
      </div>
      <label className="settings-line">
        <input type="checkbox" checked={s.telegram} onChange={(e) => save({ telegram: e.target.checked })} />
        it owns the Telegram bot
      </label>
      {info.telegram === "contested" && (
        <p className="settings-hint error">Other sessions on {backend} still take the bot: turn the telegram plugin off in ~/.claude/settings.json there.</p>
      )}
      <h3 className="panel-label">crons</h3>
      {ericsCrons(info).length > 0 && (
        <ul className="ranger-wakes">
          {ericsCrons(info).map((w) => (
            <li key={w.id}>
              <span className="ranger-when">{w.cron}</span>
              <span className="ranger-prompt" title={w.prompt}>
                {w.prompt}
              </span>
              <button type="button" className="mini" aria-label="remove this cron" title="remove" onClick={() => void removeWake(backend, w.id).catch((e) => setErr(errText(e)))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="key-row">
        <input className="settings-input ranger-cron" placeholder="0 8 * * *" value={cron} spellCheck={false} aria-label="Cron line" onChange={(e) => setCron(e.target.value)} />
        <input
          className="settings-input ranger-cron-prompt"
          placeholder="what to do then"
          value={prompt}
          aria-label="What the ranger is told"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && cron.trim() && prompt.trim()) add();
          }}
        />
        <button type="button" className="mini" disabled={!cron.trim() || !prompt.trim()} onClick={add}>
          add
        </button>
      </div>
      {err && <p className="settings-hint error">{err}</p>}
      <p className="settings-hint">
        A backend setting. The ranger is one Claude Code session canopy keeps running, restarting it when it exits and resuming its
        conversation; a message to its handle wakes it, and so do these crons (five fields, {backend}'s local time) and the wakes it sets
        itself. It never runs yolo, so what it is not allowed to do comes to the inbox. In a folder of its own ({info.home} now) it sees the
        scan root through --add-dir and Claude's trust prompt covers that folder alone; in the scan root, accepting the prompt trusts every
        project under it.
      </p>
    </section>
  );
}
