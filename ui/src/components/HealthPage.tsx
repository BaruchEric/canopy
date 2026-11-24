import { useCallback, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { isBad } from "../../../src/core/health";
import type { HealMode, HealthCheck, HealthState } from "../../../src/core/types";
import { STATE_TONE, STATE_WORD, span } from "../health";
import {
  backendWord,
  cellWord,
  changes,
  changeWord,
  pageBackends,
  pageSections,
  pageWindow,
  record,
  stretchAt,
  troubles,
  verdict,
  worstOf,
  type Change,
  type PageBackend,
  type PageRow,
  type Stretch,
  type Trouble,
} from "../healthpage";
import { plainOf } from "../registry";
import { useStore } from "../store";
import { ago } from "../util";
import { AgentFix } from "./AgentFix";
import { fixAsk, HealButton } from "./Health";
import { useNow } from "./Registry";

type Win = { from: number; to: number };

/** a moment on the page's clock: "2:34 PM", or "Mon 2:34 PM" off today */
function clock(ms: number, now: number, seconds = false): string {
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], seconds ? { hour: "numeric", minute: "2-digit", second: "2-digit" } : { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? t : `${d.toLocaleDateString([], { weekday: "short" })} ${t}`;
}

const HEAL_WORD: Record<HealMode, string> = {
  auto: "canopy heals it on its own",
  button: "heals by its button",
  self: "it restarts itself",
  none: "nothing here heals it",
};

/** the repo's name as the tree shows it, else the end of its path, so the
 *  same repo on two backends still shares a section */
function useRepoName(): (repoId: string) => string {
  const repos = useStore((s) => s.repos);
  return useCallback((id: string) => repos.find((r) => r.id === id)?.name ?? plainOf(id).split("/").filter(Boolean).pop() ?? id, [repos]);
}

/** what a tape's stretches are called under the pointer */
type TapeData = { parts: readonly Stretch[]; who: string };

/**
 * One line of the recorder: a hairline while well, a block for trouble,
 * dots where nothing was recorded. Every tape on the page spans the same
 * window, so one moment sits at one fraction of every tape.
 */
function Tape({ k, parts, win, label, pen }: { k: string; parts: readonly Stretch[]; win: Win; label: string; pen?: string }) {
  const width = Math.max(1, win.to - win.from);
  return (
    <span className={pen ? "hp-tape big" : "hp-tape"} data-k={k} role="img" aria-label={label}>
      {parts.map((p) => (
        <i key={p.from} className={`hp-mark ${p.state} ${STATE_TONE[p.state]}`} style={{ "--l": (p.from - win.from) / width, "--w": (p.to - p.from) / width } as CSSProperties} />
      ))}
      {pen && <b className={`hp-pen ${pen}`} />}
    </span>
  );
}

/** a check's facts beyond its state: what the probe saw, how it heals, its heals */
function facts(c: HealthCheck, now: number): string[] {
  const out: string[] = [];
  if (c.detail) out.push(c.detail);
  // a check that heals by a button it has no fix for, here, heals by nothing
  if (c.state !== "off") out.push(HEAL_WORD[c.heal === "button" && !c.button ? "none" : c.heal]);
  if (c.state !== "ok" && c.fails > 0) out.push(`${c.fails} failed ${c.fails === 1 ? "heal" : "heals"}`);
  if (c.state === "healing" && c.nextHeal !== null) out.push(`next heal in ${Math.max(0, Math.round((c.nextHeal - now) / 1000))}s`);
  return out;
}

/** heal and fix with the agent, where they apply */
function Acts({ backend, check }: { backend: string; check: HealthCheck }) {
  const heals = check.button && (isBad(check) || check.state === "healing");
  const fixIn = check.scope.kind === "repo" && isBad(check) ? check.scope.repoId : null;
  if (!heals && fixIn === null) return null;
  return (
    <span className="hp-acts">
      {heals && <HealButton backend={backend} check={check} />}
      {fixIn !== null && <AgentFix repoId={fixIn} ask={() => fixAsk(fixIn, check)} />}
    </span>
  );
}

/** where a check lives: its repo, and its backend when the page shows several */
const whereWords = (t: { where: string; backend: string }, many: boolean): string =>
  [t.where === "server" ? "" : t.where, many ? `on ${t.backend}` : ""].filter(Boolean).join(" ");

function TroubleRow({ t, now, many, onShow }: { t: Trouble; now: number; many: boolean; onShow: (row: string) => void }) {
  const c = t.check;
  const tone = STATE_TONE[c.state];
  // the buttons say what heals it here; only canopy's own healing needs words
  const more = facts(c, now).filter((f) => c.heal === "auto" || !Object.values(HEAL_WORD).includes(f));
  return (
    <li className={`hp-callout ${tone}`}>
      <span className="hp-callout-head">
        <button type="button" className="hp-callout-label" title="Show its record" onClick={() => onShow(t.row)}>
          {c.label}
        </button>
        <span className={`hp-state ${tone}`} title={new Date(c.since).toLocaleString()}>
          {STATE_WORD[c.state]} {span(now - c.since)}
        </span>
        <span className="hp-faint">{whereWords(t, many)}</span>
      </span>
      <Acts backend={t.backend} check={c} />
      {c.why && <span className="hp-why">{c.why}</span>}
      {more.length > 0 && <span className="hp-faint">{more.join(", ")}</span>}
    </li>
  );
}

/** a backend's check in full, under its column when its row is open */
function CellDetail({ backend, check, now }: { backend: string; check: HealthCheck; now: number }) {
  const tone = STATE_TONE[check.state];
  const more = facts(check, now);
  return (
    <div className="hp-cell-detail">
      <span className="hp-cell-on">{backend}</span>
      <span>
        <span className={`hp-state ${tone}`}>{STATE_WORD[check.state]}</span>{" "}
        <span className="hp-faint" title={`${ago(check.since / 1000)}, ${new Date(check.since).toLocaleString()}`}>
          since {clock(check.since, now)}
        </span>
      </span>
      {check.why && <span className="hp-why">{check.why}</span>}
      {more.map((f) => (
        <span key={f} className="hp-faint">
          {f}
        </span>
      ))}
      <Acts backend={backend} check={check} />
      <ol className="hp-log">
        {[...check.history].reverse().map((h) => (
          <li key={`${h.at}-${h.state}`}>
            <time dateTime={new Date(h.at).toISOString()}>{clock(h.at, now, true)}</time>
            <span className={STATE_TONE[h.state]}>{STATE_WORD[h.state]}</span>
            {h.why && <span className="hp-faint">{h.why}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function MatrixRow({ row, backends, win, now, open, onToggle, tapes }: { row: PageRow; backends: readonly PageBackend[]; win: Win; now: number; open: boolean; onToggle: () => void; tapes: Map<string, TapeData> }) {
  return (
    <>
      <div className={open ? "hp-row open" : "hp-row"} data-row={row.key}>
        <button type="button" className="hp-label" aria-expanded={open} title="What it has been through" onClick={onToggle}>
          {row.label}
        </button>
        {backends.map((b) => {
          const c = row.cells[b.name];
          if (!c) return <span key={b.name} className="hp-cell none" title={`${b.away === null ? "not checked" : "no word"} on ${b.name}`} />;
          const k = `${b.name}\u0000${c.id}`;
          const parts = record(c, win.from, win.to);
          tapes.set(k, { parts, who: `${row.label} on ${b.name}` });
          const word = cellWord(c, now);
          return (
            <span key={b.name} className="hp-cell">
              <Tape k={k} parts={parts} win={win} label={`${row.label} on ${b.name}: ${STATE_WORD[c.state]}${c.why ? `, ${c.why}` : ""}`} />
              <span className={`hp-word ${STATE_TONE[c.state]}`}>{word}</span>
            </span>
          );
        })}
      </div>
      {open && (
        <div className="hp-row hp-detail">
          <span />
          {backends.map((b) => {
            const c = row.cells[b.name];
            return c ? (
              <CellDetail key={b.name} backend={b.name} check={c} now={now} />
            ) : (
              <span key={b.name} className="hp-cell-detail hp-faint">
                <span className="hp-cell-on">{b.name}</span>
                {b.away === null ? "not checked here" : "no word from it"}
              </span>
            );
          })}
        </div>
      )}
    </>
  );
}

function ChangeRow({ c, now, many }: { c: Change; now: number; many: boolean }) {
  return (
    <li>
      <time dateTime={new Date(c.at).toISOString()} title={new Date(c.at).toLocaleString()}>
        {clock(c.at, now)}
      </time>
      <span className="hp-change-what">
        <b>{c.label}</b> <span className={STATE_TONE[c.to]}>{changeWord(c)}</span> <span className="hp-faint">{whereWords(c, many)}</span>
      </span>
      {c.why && c.to !== "ok" && <span className="hp-why">{c.why}</span>}
    </li>
  );
}

/** the off rows' why, said once when every backend agrees */
function offWhy(row: PageRow): string {
  const whys = Object.entries(row.cells).map(([b, c]) => [b, c.why ?? "off"] as const);
  const same = new Set(whys.map(([, w]) => w));
  if (same.size === 1) return `${whys[0]?.[1] ?? "off"}${whys.length > 1 ? ` (${whys.map(([b]) => b).join(", ")})` : ` on ${whys[0]?.[0] ?? ""}`}`;
  return whys.map(([b, w]) => `${b}: ${w}`).join("; ");
}

const LOG_SHOWN = 12;

/**
 * The health page (`?view=health`, FR-087): a verdict with each backend's
 * pulse, what is in trouble with its fixes, every check's record on every
 * backend over one window, the changes, and what is off. A pointer on any
 * tape draws the same moment across all of them and says what held then.
 */
export function HealthView() {
  const { health, order, conns } = useStore(useShallow((s) => ({ health: s.health, order: s.backendOrder, conns: s.conns })));
  const repoName = useRepoName();
  const backends = useMemo(() => pageBackends(health, order, conns), [health, order, conns]);
  const counting = backends.some((b) => b.checks.some((c) => c.state === "healing" && c.nextHeal !== null));
  const now = useNow(counting ? 1000 : 15_000);
  const win = pageWindow(backends, now);
  const { sections, off } = useMemo(() => pageSections(backends, repoName), [backends, repoName]);
  const log = useMemo(() => changes(backends, repoName), [backends, repoName]);
  const trouble = troubles(backends, repoName, now);
  const v = verdict(backends, trouble);
  const gone = backends.filter((b) => b.away !== null && b.away !== "connecting");
  const many = backends.length > 1;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [allLog, setAllLog] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  // what the pointer reads, refreshed every render: the tapes and the window
  const tapes = new Map<string, TapeData>();
  const scrub = useRef({ tapes, win, now });
  scrub.current = { tapes, win, now };

  const toggle = (key: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const show = (key: string) => {
    setOpen((was) => new Set(was).add(key));
    requestAnimationFrame(() => {
      const el = [...(rootRef.current?.querySelectorAll<HTMLElement>(".hp-row[data-row]") ?? [])].find((e) => e.dataset.row === key);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.querySelector<HTMLElement>(".hp-label")?.focus({ preventScroll: true });
    });
  };

  const onMove = (e: PointerEvent<HTMLElement>) => {
    const root = rootRef.current;
    const tip = tipRef.current;
    if (!root || !tip) return;
    const tape = e.target instanceof Element ? e.target.closest<HTMLElement>(".hp-tape") : null;
    const data = tape?.dataset.k ? scrub.current.tapes.get(tape.dataset.k) : undefined;
    if (!tape || !data) {
      root.classList.remove("scrub");
      tip.hidden = true;
      return;
    }
    const r = tape.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const { win: w, now: n } = scrub.current;
    const t = w.from + f * (w.to - w.from);
    const s = stretchAt(data.parts, t);
    root.style.setProperty("--hp-f", String(f));
    root.classList.add("scrub");
    const [when, what, why] = tip.children;
    if (when) when.textContent = `${clock(t, n, true)}, ${data.who}`;
    if (what) {
      what.textContent = s ? STATE_WORD[s.state] : "no record";
      what.className = s ? STATE_TONE[s.state] : "hp-faint";
    }
    if (why) why.textContent = s?.why ?? "";
    tip.hidden = false;
    const left = e.clientX + 260 > window.innerWidth ? e.clientX - 14 - tip.offsetWidth : e.clientX + 14;
    tip.style.transform = `translate(${Math.max(4, left)}px, ${e.clientY + 18}px)`;
  };
  const onLeave = () => {
    rootRef.current?.classList.remove("scrub");
    if (tipRef.current) tipRef.current.hidden = true;
  };

  const pulses = backends.map((b) => {
    const parts = worstOf(b.checks.map((c) => record(c, win.from, win.to)));
    const k = `pulse\u0000${b.name}`;
    tapes.set(k, { parts, who: b.name });
    return { b, parts, k, word: backendWord(b, now) };
  });
  const last = (s: readonly Stretch[]): HealthState | null => s[s.length - 1]?.state ?? null;

  return (
    <main
      ref={rootRef}
      className="health-view health-page"
      style={{ "--hp-n": backends.length } as CSSProperties}
      onPointerMove={onMove}
      onPointerDown={onMove}
      onPointerLeave={onLeave}
    >
      <header className={`hp-hero ${v.level}`}>
        <h1 className="hp-verdict">{v.head}</h1>
        <p className="hp-sub">{v.sub}</p>
        <div className="hp-pulses">
          {pulses.map(({ b, parts, k, word }) => {
            const end = last(parts);
            return (
              <div key={b.name} className="hp-pulse">
                <span className="hp-pulse-name">{b.name}</span>
                <Tape k={k} parts={parts} win={win} label={`${b.name}: ${word.text}`} pen={b.away === null && end ? STATE_TONE[end] : undefined} />
                <span className={`hp-pulse-word ${word.tone}`} title={word.text}>
                  {word.text}
                </span>
              </div>
            );
          })}
          <div className="hp-axis" aria-hidden="true">
            <span>{clock(win.from, now)}</span>
            <span>the last {span(win.to - win.from)}</span>
            <span>now</span>
          </div>
        </div>
      </header>

      {(trouble.length > 0 || gone.length > 0) && (
        <section className="hp-trouble" aria-label="Needs you">
          <ul>
            {gone.map((b) => (
              <li key={b.name} className="hp-callout rust">
                <span className="hp-callout-head">
                  <b>the {b.name} backend</b>
                  <span className="hp-state rust">{b.away}</span>
                </span>
                <span className="hp-faint">Its checks come back when the page reaches it again.</span>
              </li>
            ))}
            {trouble.map((t) => (
              <TroubleRow key={`${t.backend}\u0000${t.check.id}`} t={t} now={now} many={many} onShow={show} />
            ))}
          </ul>
        </section>
      )}

      <section className="hp-matrix" aria-label="Every check">
        <div className="hp-row hp-colhead">
          <span className="hp-colhead-note">{sections.reduce((n, s) => n + s.rows.length, 0)} checks</span>
          {backends.map((b) => (
            <span key={b.name} className="hp-col">
              <b>{b.name}</b>
              {b.away !== null && <span className={b.away === "connecting" ? "lichen" : "rust"}>{b.away === "connecting" ? "connecting" : "offline"}</span>}
            </span>
          ))}
        </div>
        {sections.map((s) => (
          <div key={s.key} className="hp-section">
            <h2 className="hp-section-head">{s.title}</h2>
            {s.rows.map((row) => (
              <MatrixRow key={row.key} row={row} backends={backends} win={win} now={now} open={open.has(row.key)} onToggle={() => toggle(row.key)} tapes={tapes} />
            ))}
          </div>
        ))}
        {sections.length === 0 && <p className="hp-faint">No backend has said anything yet.</p>}
      </section>

      <aside className="hp-side">
        <section className="hp-changes" aria-label="Changes">
          <h2 className="hp-h">Changes</h2>
          {log.length === 0 ? (
            <p className="hp-faint">Nothing has changed since the record began at {clock(win.from, now)}.</p>
          ) : (
            <>
              <ol className={log.some((c) => new Date(c.at).toDateString() !== new Date(now).toDateString()) ? "hp-change-list days" : "hp-change-list"}>
                {(allLog ? log : log.slice(0, LOG_SHOWN)).map((c) => (
                  <ChangeRow key={`${c.backend}\u0000${c.label}\u0000${c.where}\u0000${c.at}\u0000${c.to}`} c={c} now={now} many={many} />
                ))}
              </ol>
              {log.length > LOG_SHOWN && (
                <button type="button" className="mini" onClick={() => setAllLog(!allLog)}>
                  {allLog ? "fewer" : `all ${log.length}`}
                </button>
              )}
            </>
          )}
        </section>
        {off.length > 0 && (
          <details className="hp-off">
            <summary>
              {off.length} {off.length === 1 ? "check is" : "checks are"} off
            </summary>
            <ul>
              {off.map((row) => (
                <li key={row.key}>
                  <b>{row.label}</b> {row.where !== "server" && <span className="hp-faint">in {row.where}</span>}
                  <span className="hp-why">{offWhy(row)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </aside>

      <div ref={tipRef} className="hp-tip" aria-hidden="true" hidden>
        <span />
        <span />
        <span />
      </div>
    </main>
  );
}
