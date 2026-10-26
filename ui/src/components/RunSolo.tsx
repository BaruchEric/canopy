import { useEffect } from "react";
import { runPanel } from "../itempanel";
import { tellPanes } from "../panes";
import { groveUrl } from "../routes";
import { idText, useStore } from "../store";
import { setTitleBase } from "../title";
import { Console } from "./RunSheet";
import { Wordmark } from "./TopBar";

/**
 * One chat in a window of its own (`?view=run&run=<id>`): the dock's run
 * panel popped out (FR-047). App.tsx speaks the panes channel for the
 * window under the panel's id, as it does for a popped repo panel, so the
 * dock takes the panel out on the window's hello and puts it back on "back
 * to the dock" or when the window goes. The console's ✕ in a pop-out
 * closes the window and has the dock forget the panel's slot, as a popped
 * repo panel's close does. A run the server no longer has says so.
 */
export function RunSolo({ id, popped }: { id: string; popped: boolean }) {
  const run = useStore((s) => s.runs[id]);
  const repo = useStore((s) => (run ? s.repos.find((r) => r.id === run.repoId) : undefined));
  const name = run ? `${run.verb} · ${repo?.name ?? idText(run.repoId)}` : null;

  useEffect(() => {
    setTitleBase(name ? `${name} · canopy` : "chat · canopy");
    return () => {
      setTitleBase("canopy");
    };
  }, [name]);

  // Opened by a click in another window, so window.close() is allowed; a
  // tab the user typed the URL into just stays open and shows the grove.
  const close = () => {
    window.close();
    window.location.assign(groveUrl());
  };
  const panel = runPanel(id);
  const backToDock = () => {
    tellPanes({ type: "return", id: panel });
    close();
  };
  const closePopped = () => {
    tellPanes({ type: "close", id: panel });
    close();
  };

  return (
    <div className="solo run-solo">
      <header className="topbar">
        <Wordmark />
        <span className="solo-id">{name ?? "chat"}</span>
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
      <div className="run-solo-main">
        {run ? (
          <div className="sheet run-tab">
            <Console run={run} repo={repo} onClose={popped ? closePopped : close} />
          </div>
        ) : (
          <p className="empty">
            That run is not on the server now. <a href={groveUrl()}>Open the whole grove</a> instead.
          </p>
        )}
      </div>
    </div>
  );
}
