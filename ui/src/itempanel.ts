/**
 * A chat or a top-bar popup as a dock panel of its own (FR-047), the way an
 * agent is (agentpanel.ts): a run (an agent's chat or a coordinator) under
 * `/run/` and its id, a popup under `/popup/` and its name. "Waiting on
 * you" and health keep the panels they had. A leading slash never names a
 * repo, so none of these reads as one. `panelOfItem` turns what a popup or
 * a sheet hands its gear (a TabRef, sectiontabs.ts) into the panel it opens
 * as, and `isReservedPanel` names every panel that is no repo's, wherever a
 * panel id would otherwise read as a repo's. Pure; tested in
 * itempanel.test.ts.
 */

import { agentPanel, isAgentPanel } from "./agentpanel";
import { isCliPanel } from "./cli";
import { HEALTH_PANEL, isHealthPanel } from "./health";
import { isPopupName, type PopupName, type TabRef } from "./sectiontabs";
import { WAITING_PANEL, isWaitingPanel } from "./waiting";

const RUN = "/run/";
const POPUP = "/popup/";

export const runPanel = (runId: string): string => RUN + runId;

export const isRunPanel = (id: string): boolean => id.startsWith(RUN) && id.length > RUN.length;

/** the run a panel shows, or null for any other panel */
export const runOfPanel = (id: string): string | null => (isRunPanel(id) ? id.slice(RUN.length) : null);

/** a popup's panel: the one it had, for waiting on you and health */
export const popupPanel = (name: PopupName): string => (name === "waiting" ? WAITING_PANEL : name === "health" ? HEALTH_PANEL : POPUP + name);

/** the popup a panel shows, or null for any other panel; waiting on you
 *  and health answer by their own ids too */
export function popupOfPanel(id: string): PopupName | null {
  if (isWaitingPanel(id)) return "waiting";
  if (isHealthPanel(id)) return "health";
  if (!id.startsWith(POPUP)) return null;
  const name = id.slice(POPUP.length);
  return isPopupName(name) ? name : null;
}

/** a `/popup/` panel by a name it has; waiting on you and health are not these */
export const isPopupPanel = (id: string): boolean => id.startsWith(POPUP) && popupOfPanel(id) !== null;

/** the panel an item opens as: a run's, an agent's, or a popup's; null for
 *  a popup by a name it has not */
export function panelOfItem(item: Pick<TabRef, "kind" | "ref">): string | null {
  switch (item.kind) {
    case "run":
      return runPanel(item.ref);
    case "agent":
      return agentPanel(item.ref);
    case "popup":
      return isPopupName(item.ref) ? popupPanel(item.ref) : null;
  }
}

/** a dock panel that is no repo's: "waiting on you", the command line's
 *  transcript, health, an agent's, a run's or a popup's. No scan prunes
 *  one, and neither pops out or takes a bench. */
export const isReservedPanel = (id: string): boolean =>
  isWaitingPanel(id) || isCliPanel(id) || isHealthPanel(id) || isAgentPanel(id) || isRunPanel(id) || isPopupPanel(id);

/** the mark on a run's or a popup's head and tab, the shell windows' item tab mark */
export const ITEM_GLYPH = "◇";
