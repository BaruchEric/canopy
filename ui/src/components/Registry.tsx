import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { HARNESS } from "../../../src/core/harness";
import { isLiveAgent, type AgentCard, type Repo } from "../../../src/core/types";
import {
  ageWord,
  anyWaiting,
  cardName,
  groupCards,
  joinTarget,
  liveCount,
  repoWord,
  splitRecent,
  stateWord,
  transcriptTarget,
  whereWord,
  type CardGrouping,
} from "../agentcards";
import { api } from "../api";
import { backendOf, qual } from "../registry";
import { agentsOn, helperFor, useStore } from "../store";
import { Seg } from "./Seg";
import { Section } from "./Surface";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** now, again every `ms`, for the ages a row shows */
function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const glyphOf = (c: AgentCard): string => (c.harness === "other" ? "·" : HARNESS[c.harness].glyph);
const harnessWord = (c: AgentCard): string => (c.harness === "other" ? "another harness" : HARNESS[c.harness].label);

/**
 * One agent: its harness, handle, repo and branch; its state (rust while it
 * waits, dim once lost), model, how long, where; its caps and offers; and
 * what can be done from here: message it, join the canopy shell it runs in,
 * open its transcript when that file is on the home backend's machine.
 * `onGit` takes the page to the git view, where a panel shell shows.
 */
export function AgentRow({ card, now, showRepo = true, onGit }: { card: AgentCard; now: number; showRepo?: boolean; onGit?: () => void }) {
  const home = useStore((s) => s.home);
  const shown = useStore(useShallow((s) => s.backendOrder));
  const chanReady = useStore((s) => s.chan?.ready === true);
  const target = joinTarget(card, shown, qual);
  const held = useStore((s) => (target ? s.shells.find((t) => t.id === target)?.place : undefined));
  const repos = useStore((s) => s.repos);
  const transcript = useMemo(() => transcriptTarget(card, home, repos.filter((r) => backendOf(r.id) === home)), [card, home, repos]);
  const [err, setErr] = useState<string | null>(null);

  const message = () => useStore.getState().openChan(`@${card.handle}`);
  const join = () => {
    if (!target) return;
    useStore.getState().bringTerm(target);
    if (held === "panel") onGit?.();
  };
  const open = () => {
    if (!transcript) return;
    setErr(null);
    api.openFile(transcript.repoId, transcript.file, 1, helperFor(useStore.getState(), home)).catch((e: unknown) => setErr(errText(e)));
  };
  const started = new Date(card.startedAt).toLocaleString();
  return (
    <li className={isLiveAgent(card) ? "agents-row reg-row" : "agents-row reg-row reg-gone"}>
      <div className="agents-row-head">
        <span className={`harness-glyph h-${card.harness}`} title={harnessWord(card)}>
          {glyphOf(card)}
        </span>
        <span className="agents-name" title={card.id}>
          {cardName(card)}
        </span>
        {/* in a repo's own section the repo goes without saying; its branch does not */}
        <span className="agents-line" title={card.cwd}>
          {showRepo ? repoWord(card) : (card.branch ?? "")}
        </span>
        <span className={`reg-state rs-${card.state}`} title={card.waiting ?? undefined}>
          {stateWord(card)}
        </span>
        {card.model && <span className="agents-fact">{card.model}</span>}
        <span className="agents-fact" title={`started ${started}`}>
          {ageWord(card, now)}
        </span>
        <span className="agents-fact" title={card.cwd}>
          {whereWord(card)}
        </span>
        <span className="reg-actions">
          {card.handle && chanReady && isLiveAgent(card) && (
            <button type="button" className="mini" title={`A DM to @${card.handle}`} onClick={message}>
              message
            </button>
          )}
          {held && isLiveAgent(card) && (
            <button type="button" className="mini" title="The canopy shell it runs in" onClick={join}>
              join
            </button>
          )}
          {transcript && (
            <button type="button" className="mini" title={card.transcript ?? undefined} onClick={open}>
              transcript
            </button>
          )}
        </span>
      </div>
      {(card.caps.length > 0 || card.offers.length > 0) && (
        <div className="reg-more">
          {card.caps.map((c) => (
            <span key={c} className="reg-cap">
              {c}
            </span>
          ))}
          {card.offers.map((o) => (
            <span key={o} className="reg-offer">
              {o}
            </span>
          ))}
        </div>
      )}
      {err && <p className="settings-hint error">{err}</p>}
    </li>
  );
}

const GROUPINGS = [
  { value: "machine", label: "by machine", title: "One group per machine the agents run on" },
  { value: "repo", label: "by repo", title: "One group per repo the agents work in" },
] as const;

/** the day's ended and lost cards, folded under the running ones */
function PastCards({ cards, now, showRepo, onGit }: { cards: AgentCard[]; now: number; showRepo?: boolean; onGit?: () => void }) {
  if (cards.length === 0) return null;
  return (
    <details className="reg-past">
      <summary>
        ended or lost today <span className="agents-fact">{cards.length}</span>
      </summary>
      <ul className="agents-list">
        {cards.map((c) => (
          <AgentRow key={c.id} card={c} now={now} showRepo={showRepo} onGit={onGit} />
        ))}
      </ul>
    </details>
  );
}

/**
 * The registry tab of the agents view: every agent the broker knows, on any
 * machine, grouped by machine or repo with the busier groups first, running
 * ones first in each; then the day's ended and lost ones, folded.
 */
export function RegistryTab({ onGit }: { onGit?: () => void }) {
  const all = useStore(useShallow((s) => Object.values(s.registry)));
  const [by, setBy] = useState<CardGrouping>("machine");
  const now = useNow();
  const { live, past } = useMemo(() => splitRecent(all, now), [all, now]);
  const groups = useMemo(() => groupCards(live, by), [live, by]);
  const waiting = live.filter((c) => c.state === "waiting").length;
  return (
    <>
      <div className="agents-add reg-bar">
        <Seg label="Group agents" value={by} options={GROUPINGS} onChange={setBy} />
        <span className="agents-fact">
          {live.length} running{waiting ? `, ${waiting} waiting` : ""}
        </span>
      </div>
      {live.length === 0 && <p className="settings-hint">No agent is running on any machine the broker hears from.</p>}
      {groups.map((g) => (
        <section key={g.key || "none"} className="agents-section" aria-label={g.label}>
          <h3 className="panel-label">
            {g.label} <span className="agents-fact">{g.cards.length}</span>
          </h3>
          <ul className="agents-list">
            {g.cards.map((c) => (
              <AgentRow key={c.id} card={c} now={now} showRepo={by === "machine"} onGit={onGit} />
            ))}
          </ul>
        </section>
      ))}
      <PastCards cards={past} now={now} onGit={onGit} />
    </>
  );
}

/** The `✦ n` on a repo card: its live agents on any machine, rust while
 *  one waits, the list in its tooltip; a click opens the panel's agents
 *  section. Nothing when none runs. */
export function AgentChip({ repoId }: { repoId: string }) {
  const cards = useStore((s) => agentsOn(s, repoId));
  const showAgents = useStore((s) => s.showAgents);
  const live = cards.filter(isLiveAgent);
  if (live.length === 0) return null;
  const title = live.map((c) => `${cardName(c)}: ${stateWord(c)}, ${whereWord(c)}`).join("\n");
  return (
    <button
      type="button"
      className={`run-chip agent-chip${anyWaiting(live) ? " waiting" : ""}`}
      title={title}
      aria-label={`${live.length} agent${live.length === 1 ? "" : "s"} on ${repoId}`}
      onClick={(e) => {
        e.stopPropagation();
        showAgents(repoId);
      }}
      onAuxClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      ✦ {live.length}
    </button>
  );
}

/** A panel's agents section: the same rows as the registry tab, only the
 *  ones on this repo's card, anywhere; nothing without a registry. */
export function AgentsSection({ repo }: { repo: Repo }) {
  const ready = useStore((s) => s.registryReady);
  const cards = useStore((s) => agentsOn(s, repo.id));
  const now = useNow();
  const { live, past } = useMemo(() => splitRecent(cards, now), [cards, now]);
  if (!ready) return null;
  const count = liveCount(live);
  return (
    <Section
      repo={repo}
      k="agents"
      className="reg-section"
      label="Agents"
      head={count ? <span className={anyWaiting(live) ? "reg-head-waiting" : undefined}>{count}</span> : null}
      title="The agents working in this repo, on any machine"
    >
      <div className="reg-body">
        {live.length === 0 && <p className="panel-clean">No agent is working in this repo.</p>}
        {live.length > 0 && (
          <ul className="agents-list">
            {live.map((c) => (
              <AgentRow key={c.id} card={c} now={now} showRepo={false} />
            ))}
          </ul>
        )}
        <PastCards cards={past} now={now} showRepo={false} />
      </div>
    </Section>
  );
}
