import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { isRunActive } from "../../../src/core/types";
import { openNotes } from "../../../src/core/notes";
import { capacityRows, capacityWord, heldRows, rowsTone } from "../capacity";
import { ownRun } from "../flows";
import { healthSummary } from "../health";
import { backendsWords, barChips, type BarChip, type BarFacts } from "../quietbar";
import { rangerCard, rangerTone, shownRangers, worstTone } from "../ranger";
import { activeFilterCount, allRuns, attentionCount, connOf, inboxItems, pickedIds, useStore, waitingCount } from "../store";
import { taskChip } from "../tasks";
import { WAITING_PANEL } from "../waiting";
import { freshElsewhere } from "./Clipboard";
import { useHealthRows } from "./Health";
import { useNow } from "./Registry";

/** The quiet bar's chips, each with whether it speaks right now (FR-079):
 *  the facts are read with the selectors the chips themselves use, so a
 *  chip's place on the bar and what it shows there never disagree. Flat
 *  values only, so the bar draws again when one of them moves and not on
 *  every event. */
export function useBarChips(): BarChip[] {
  const now = useNow();
  const rows = useHealthRows();
  const health = useMemo(() => ({ n: rows.length, ...healthSummary(rows, now) }), [rows, now]);
  const facts: BarFacts = useStore(
    useShallow((s): BarFacts => {
      const runs = allRuns(s).filter((r) => isRunActive(r) && ownRun(s.flowRuns, r));
      const here = new Set(s.terms.map((t) => t.id));
      const rangers = shownRangers(s.rangers, s.backendOrder);
      const capacity = capacityRows(s.capacity, s.backendOrder, now);
      const trouble = taskChip(s.taskAll);
      return {
        sort: s.settings.sort,
        attention: attentionCount(s),
        dirtyOnly: s.dirtyOnly,
        filters: activeFilterCount(s),
        sources: s.sources.length,
        sourcesBroken: s.sources.filter((x) => x.error).length,
        workspaces: s.workspaces.length,
        workspace: s.workspaces.some((w) => w.name === s.activeWs) ? s.activeWs : null,
        feedOpen: s.feedOpen,
        selecting: s.selecting,
        picked: pickedIds(s).length,
        waiting: waitingCount(s),
        waitingOpen: s.panels.includes(WAITING_PANEL),
        inbox: inboxItems(s).length,
        inboxReady: s.asksReady,
        notes: openNotes(Object.values(s.quickNotes).flat()).length,
        clipsFresh: freshElsewhere(s),
        chan: s.chan?.ready === true,
        chanUnread: s.chanUnread,
        runs: runs.length,
        runsWaiting: runs.filter((r) => r.status === "waiting").length,
        shells: s.shells.length,
        shellsElsewhere: s.shells.filter((t) => !here.has(t.id)).length,
        kept: s.kept.length,
        tasks: s.taskAll.length,
        tasksRunning: s.taskAll.filter((t) => t.status === "running").length,
        taskTrouble: trouble?.bad ? trouble.title : null,
        rangers: rangers.length,
        rangerTone: worstTone(rangers.map(([, r]) => rangerTone(r, rangerCard(s.registry, r)))),
        capacity: capacity.length,
        capacityWord: capacityWord(capacity),
        capacityTone: rowsTone(capacity),
        held: heldRows(s.capacity, s.backendOrder).length,
        limited: Object.values(s.runs).filter((r) => r.status === "limited").length,
        health: health.n,
        healthLevel: health.level,
        healthWord: health.word,
        backends: backendsWords(s.backendOrder.map((name) => ({ name, state: connOf(s, name).status.state }))),
        backendsDown: s.backendOrder.filter((name) => connOf(s, name).status.state !== "online").length,
        peersLost: s.peerSeen.filter((p) => !p.ok).length,
      };
    }),
  );
  return useMemo(() => barChips(facts), [facts]);
}
