import { useEffect } from "react";
import type { PopupName } from "../sectiontabs";
import { useStore } from "../store";
import { ChanPopBody } from "./Chan";
import { HealthPopBody } from "./Health";
import { InboxPopBody } from "./Inbox";
import { KeptPopBody } from "./KeptShells";
import { RangerPopBody } from "./Ranger";
import { ShellsPopBody } from "./Shells";
import { TasksPopBody } from "./Tasks";
import { WaitingBody } from "./Waiting";

/**
 * A top-bar popup shown as a tab in a shell window (FR-030). Each popup's
 * body is the same component its popover draws, so there is one copy of
 * what it shows. A tab passes no `onDone`: a move that would close the
 * popover leaves the tab where it is. The wrapper fills the pane and
 * scrolls inside it, and `data-popup` lets the stylesheet give a body the
 * padding its popover gave it.
 */
export function PopupTabView({ name }: { name: PopupName }) {
  return (
    <div className="popup-tab" data-popup={name}>
      <PopupBody name={name} />
    </div>
  );
}

function PopupBody({ name }: { name: PopupName }) {
  switch (name) {
    case "inbox":
      return <InboxPopBody />;
    case "waiting":
      // waiting on you is a dock panel, not a popover; its body is shared
      // with that panel and keeps the panel's padding
      return (
        <div className="waiting-body">
          <WaitingBody />
        </div>
      );
    case "tasks":
      return <TasksPopBody />;
    case "health":
      return <HealthPopBody />;
    case "shells":
      return <ShellsPopBody />;
    case "kept":
      return <KeptPopBody />;
    case "ranger":
      return <RangerPopBody />;
    case "chan":
      return <ChanTab />;
  }
}

/** Opening the popover loads tailchan's conversations and the open one's
 *  messages and counts it as looked at (`openChan`). A tab never opens the
 *  popover, so it tells the store it is up (`chanTab`) while mounted. */
function ChanTab() {
  useEffect(() => {
    const { chanTab } = useStore.getState();
    chanTab(true);
    return () => chanTab(false);
  }, []);
  return <ChanPopBody />;
}
