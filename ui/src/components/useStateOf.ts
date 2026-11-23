import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { stateIn, type BoardState } from "../boardstate";
import { boardStates, useStore } from "../store";

const NONE: Record<string, BoardState> = {};

/** how often the states are read with no change in the store: a trace's
 *  half hour runs out by the clock alone */
const TICK_MS = 30_000;

/** What goes on at each card in view, for the "state" grouping (FR-079):
 *  the grid and the tree both read it, so a heading means the same in
 *  both. Undefined while another grouping is on, which costs the store
 *  nothing; the same function until a card's state moves. */
export function useStateOf(on: boolean): ((r: { id: string }) => BoardState) | undefined {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, [on]);
  const states = useStore(useShallow((s) => (on ? boardStates(s, Date.now()) : NONE)));
  return useMemo(() => (on ? stateIn(states) : undefined), [on, states]);
}
