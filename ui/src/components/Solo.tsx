import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { groveUrl, soloUrl } from "../routes";
import { SOLO, useStore } from "../store";
import { SECTION_WORD, type SectionKey } from "../surface";
import { PanelSection, RepoPanel } from "./Dock";
import { SectionWindow } from "./Surface";
import { PanelShells } from "./TermDock";
import { Resizer } from "./Resizer";
import { RunSheet } from "./RunSheet";
import { Wordmark } from "./TopBar";
import { IdLabel, WaitingFor, useWaitingFor } from "./IdLabel";
import { idText } from "../store";

/** the window's inner width, kept current across resizes */
function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/** One repo, edge to edge: what a "new tab" or "new window" click shows. */
export function Solo({ id }: { id: string }) {
  const root = useStore((s) => s.root);
  const repo = useStore((s) => s.repos.find((r) => r.id === id));
  const soloWidth = useStore((s) => s.soloWidth);
  const setSoloWidth = useStore((s) => s.setSoloWidth);
  const name = repo?.name;
  const waiting = useWaitingFor(id, repo !== undefined);
  // The drag stops at the window's edge, so a stored width wider than this
  // window does not leave the handle stuck for the first few px of a pull.
  const windowWidth = useWindowWidth();
  const max = Math.max(SOLO.min, Math.min(SOLO.max, windowWidth));

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
        <span className="solo-id">
          <IdLabel id={id} />
        </span>
        <span className="spacer" />
        <a className="mini" href={groveUrl()} target="_blank">
          whole grove ↗
        </a>
      </header>
      <div
        className="solo-main"
        style={{ "--solo-w": `${soloWidth}px` } as CSSProperties}
      >
        {repo ? (
          <>
            <SoloResizer dir={-1} value={soloWidth} max={max} onCommit={setSoloWidth} />
            <RepoPanel id={id} width={0} onClose={close} />
            <SoloResizer dir={1} value={soloWidth} max={max} onCommit={setSoloWidth} />
          </>
        ) : waiting ? (
          <WaitingFor name={waiting} />
        ) : (
          <p className="empty">
            No repo called {idText(id)} under {root}.{" "}
            <a href={groveUrl()}>Open the whole grove</a> instead.
          </p>
        )}
      </div>
      <RunSheet />
    </div>
  );
}

/** One section of a repo's panel, alone in its window: what a section's
 *  "open in a new tab" or "new window" shows. Always open, whatever the
 *  grove has folded, and it writes no layout back. */
export function SectionSolo({ id, section }: { id: string; section: SectionKey }) {
  const root = useStore((s) => s.root);
  const repo = useStore((s) => s.repos.find((r) => r.id === id));
  const soloWidth = useStore((s) => s.soloWidth);
  const setSoloWidth = useStore((s) => s.setSoloWidth);
  const windowWidth = useWindowWidth();
  const max = Math.max(SOLO.min, Math.min(SOLO.max, windowWidth));
  const word = SECTION_WORD[section];
  const name = repo?.name;
  const waiting = useWaitingFor(id, repo !== undefined);

  useEffect(() => {
    document.title = name ? `${name} · ${word} · canopy` : "canopy";
    return () => {
      document.title = "canopy";
    };
  }, [name, word]);

  return (
    <div className="solo">
      <header className="topbar">
        <Wordmark />
        <span className="root-path" title={root}>
          {root}
        </span>
        <span className="solo-id">
          <IdLabel id={id} /> · {word}
        </span>
        <span className="spacer" />
        {repo && (
          <a className="mini" href={soloUrl(id)}>
            whole panel
          </a>
        )}
        <a className="mini" href={groveUrl()} target="_blank">
          whole grove ↗
        </a>
      </header>
      <div className="solo-main" style={{ "--solo-w": `${soloWidth}px` } as CSSProperties}>
        {repo && !repo.error ? (
          <>
            <SoloResizer dir={-1} value={soloWidth} max={max} onCommit={setSoloWidth} />
            <section className="panel section-solo" aria-label={`${word} at ${repo.name}`}>
              <div className="panel-body">
                <SectionWindow.Provider value={true}>
                  <PanelSection k={section} repo={repo} />
                </SectionWindow.Provider>
              </div>
              {/* a shell a section opens (peers' "shell") lands here */}
              <PanelShells repo={repo} />
            </section>
            <SoloResizer dir={1} value={soloWidth} max={max} onCommit={setSoloWidth} />
          </>
        ) : waiting ? (
          <WaitingFor name={waiting} />
        ) : (
          <p className="empty">
            No readable repo called {idText(id)} under {root}. <a href={groveUrl()}>Open the whole grove</a> instead.
          </p>
        )}
      </div>
      <RunSheet />
    </div>
  );
}

/** One edge of the centered panel. Both handles size the same width, so a
 *  pull on either moves both edges; factor 2 keeps the dragged one under
 *  the cursor. */
function SoloResizer({
  dir,
  value,
  max,
  onCommit,
}: {
  dir: 1 | -1;
  value: number;
  max: number;
  onCommit: (px: number) => void;
}) {
  return (
    <Resizer
      className="solo-resizer"
      label="Panel width"
      value={value}
      min={SOLO.min}
      max={max}
      initial={SOLO.initial}
      dir={dir}
      factor={2}
      cssVar="--solo-w"
      target={(h) => h.parentElement}
      onCommit={onCommit}
    />
  );
}
