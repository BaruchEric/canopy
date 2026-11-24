import { useEffect } from "react";
import { popupPanel } from "../itempanel";
import { tellPanes } from "../panes";
import { groveUrl } from "../routes";
import { POPUP_WORD, type PopupName } from "../sectiontabs";
import { setTitleBase } from "../title";
import { PopupTabView } from "./PopupTab";
import { RunSheet } from "./RunSheet";
import { Wordmark } from "./TopBar";

/**
 * One of the top bar's popups in a window of its own
 * (`?view=popup&popup=<name>`, FR-084): the inbox, waiting on you, the
 * tasks, health and the rest, each the body its popover draws, filling the
 * window so it can stay up on another screen. With `popped` it is a dock
 * panel popped out: App.tsx speaks the panes channel for it under the
 * panel's id, as it does for a repo's and a chat's, so the dock takes the
 * panel out on the window's hello and puts it back on "back to the dock"
 * or when the window goes.
 *
 * The window has no dock. A panel one of its rows opens goes to a window of
 * its own (the store's `openPanel`), and so does a shell (`joinTerm`); a
 * chat opens on the sheet over the list.
 */
export function PopupSolo({ name, popped }: { name: PopupName; popped: boolean }) {
  const word = POPUP_WORD[name];

  useEffect(() => {
    setTitleBase(`${word} · canopy`);
    return () => {
      setTitleBase("canopy");
    };
  }, [word]);

  // Opened by a click in another window, so window.close() is allowed; a
  // tab the user typed the URL into just stays open and shows the grove.
  const backToDock = () => {
    tellPanes({ type: "return", id: popupPanel(name) });
    window.close();
    window.location.assign(groveUrl());
  };

  return (
    <div className="solo popup-solo">
      <header className="topbar">
        <Wordmark />
        <span className="solo-id">{word}</span>
        <span className="spacer" />
        {popped && (
          <button type="button" className="mini" onClick={backToDock}>
            back to the dock
          </button>
        )}
        <a className="mini" href={groveUrl()} target="_blank">
          whole grove ↗
        </a>
      </header>
      <div className="popup-solo-main">
        <PopupTabView name={name} />
      </div>
      <RunSheet />
    </div>
  );
}
