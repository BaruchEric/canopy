import { agentName } from "../allagents";
import { useEffect, useRef, useState } from "react";
import { machineOf } from "../agentcards";
import { FOCUS_PANE, PANES_CHANNEL, parsePaneMsg, type PaneMsg } from "../panes";
import { groveUrl } from "../routes";
import { useStore } from "../store";
import { setTitleBase } from "../title";
import { AgentScreen, AskHere, useAgentCard, useShellProbe } from "./AgentFocus";
import { AgentActions, glyphOf, harnessWord, useNow } from "./Registry";
import { Wordmark } from "./TopBar";

/**
 * One agent's screen in a window of its own: the agents board's focus,
 * popped out for a second screen while the board's rail stays in the main
 * window. With `follow` it is the board's focus pane (`FOCUS_PANE`, popped
 * out through panes.ts): it shows whichever agent the board names in a
 * "show", says hello when it shows (and again on "who"), bye when it goes,
 * hands the focus back with "return", and closes on the board's "return".
 */
export function AgentSolo({ card: first, follow }: { card: string | null; follow: boolean }) {
  const [id, setId] = useState<string | null>(first);
  useShellProbe();
  const card = useAgentCard(id);
  const ready = useStore((s) => s.registryReady || s.repos.length > 0);
  const now = useNow(15_000);
  const sweptAway = useStore((s) => id !== null && s.sweepEnded.includes(id));
  const following = follow && typeof BroadcastChannel !== "undefined";

  // a sweep ended this agent (its shell or chat closed): the window goes
  // with it, as its dock panel does; the board's focus pane follows the
  // board instead, which picks another
  useEffect(() => {
    if (sweptAway && !follow) window.close();
  }, [sweptAway, follow]);
  const chanRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (!following) return;
    const chan = new BroadcastChannel(PANES_CHANNEL);
    chanRef.current = chan;
    const hello = () => chan.postMessage({ type: "hello", id: FOCUS_PANE } satisfies PaneMsg);
    chan.onmessage = (e: MessageEvent) => {
      const m = parsePaneMsg(e.data);
      if (!m) return;
      if (m.type === "who") hello();
      else if (m.id !== FOCUS_PANE) return;
      else if (m.type === "show") setId(m.card);
      // the board took its focus back
      else if (m.type === "return") window.close();
    };
    hello();
    const bye = () => chan.postMessage({ type: "bye", id: FOCUS_PANE } satisfies PaneMsg);
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      bye();
      chan.close();
      chanRef.current = null;
    };
  }, [following]);

  // the window's url follows the agent, so a reload comes back to it
  useEffect(() => {
    const u = new URL(window.location.href);
    if (id) u.searchParams.set("card", id);
    else u.searchParams.delete("card");
    window.history.replaceState(null, "", u.toString());
  }, [id]);

  const name = card ? agentName(card) : null;
  useEffect(() => {
    setTitleBase(name ? `${name} · agent · canopy` : "agent · canopy");
    return () => {
      setTitleBase("canopy");
    };
  }, [name]);

  return (
    <div className="agent-solo">
      <header className="agent-solo-head">
        <Wordmark />
        {card ? (
          <>
            <span className={`harness-glyph h-${card.harness}`} title={harnessWord(card)}>
              {glyphOf(card)}
            </span>
            <b>{name}</b>
            {card.branch && <span className="bt-branch">{card.branch}</span>}
            <span className="bt-machine">{machineOf(card)}</span>
            <span className={`reg-state rs-${card.state}`}>{card.state}</span>
            <span className="reg-actions">
              <AgentActions card={card} />
            </span>
          </>
        ) : (
          <span className="agents-fact">{ready ? "No agent in focus. Pick one on the board." : "Reading the registry…"}</span>
        )}
        <span className="spacer" />
        {following && (
          <button
            type="button"
            className="mini"
            title="Show the focus on the board again and close this window"
            onClick={() => {
              chanRef.current?.postMessage({ type: "return", id: FOCUS_PANE } satisfies PaneMsg);
              window.close();
            }}
          >
            back to the board
          </button>
        )}
        <a className="mini" href={groveUrl()} target="_blank">
          whole grove ↗
        </a>
      </header>
      {card && (
        <div className="agent-solo-body">
          <AskHere card={card} />
          {/* keyed by the agent, so a new focus is a new shell view */}
          <AgentScreen key={card.id} card={card} live active now={now} />
        </div>
      )}
    </div>
  );
}
