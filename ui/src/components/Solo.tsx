import { useEffect } from "react";
import { groveUrl } from "../routes";
import { useStore } from "../store";
import { RepoPanel } from "./Dock";
import { RunSheet } from "./RunSheet";
import { Wordmark } from "./TopBar";

/** One repo, edge to edge: what a "new tab" or "new window" click shows. */
export function Solo({ id }: { id: string }) {
  const root = useStore((s) => s.root);
  const repo = useStore((s) => s.repos.find((r) => r.id === id));
  const name = repo?.name;

  useEffect(() => {
    document.title = name ? `${name} · canopy` : "canopy";
    return () => {
      document.title = "canopy";
    };
  }, [name]);

  // Opened by a click in another window, so window.close() is allowed; a
  // tab the user typed the URL into just stays open and shows the grove.
  const close = () => {
    window.close();
    window.location.assign(groveUrl());
  };

  return (
    <div className="solo">
      <header className="topbar">
        <Wordmark />
        <span className="root-path" title={root}>
          {root}
        </span>
        <span className="solo-id">{id}</span>
        <span className="spacer" />
        <a className="mini" href={groveUrl()} target="_blank">
          whole grove ↗
        </a>
      </header>
      <div className="solo-main">
        {repo ? (
          <RepoPanel id={id} width={0} onClose={close} />
        ) : (
          <p className="empty">
            No repo called {id} under {root}.{" "}
            <a href={groveUrl()}>Open the whole grove</a> instead.
          </p>
        )}
      </div>
      <RunSheet />
    </div>
  );
}
