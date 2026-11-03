import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, UIEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { clock, FEED_PLACES, filterFeed, type FeedEntry, type FeedKind, type FeedPlace } from "../feed";
import { FEED, FEED_W, idLabel, idText, useStore } from "../store";
import { TermGrip } from "./TermDock";
import { Gear, type GearEntry } from "./Gear";
import { Resizer } from "./Resizer";
import {
  FocusBackdrop,
  FocusGrips,
  focusVars,
  useLeaveOnEscape,
  modeEntries,
  shareEntries,
  useZoom,
  zoomStyle,
} from "./Surface";
import type { SurfaceMode } from "../surface";

/** how far from the bottom still counts as following the stream, in px */
const FOLLOW_SLACK = 24;

const KIND_WORD: Record<FeedKind, string> = {
  git: "git",
  scan: "scan",
  run: "run",
  flow: "flow",
  fleet: "fleet",
  workspace: "ws",
  agent: "agent",
  launch: "launch",
  client: "device",
  shell: "shell",
  chan: "chan",
  task: "task",
  registry: "agents",
  ask: "asks",
  incubator: "incubator",
  sweep: "sweep",
};

const PLACE_WORD: Record<FeedPlace, string> = {
  right: "on the right",
  left: "on the left",
  bottom: "along the bottom",
  top: "along the top",
};

/** the least the view keeps beside a feed on a side, as its seam is dragged */
const VIEW_KEEPS = 360;

/**
 * The event feed, on whichever edge the gear puts it (beside the view on the
 * right unless moved): one line per thing the server said since the page
 * loaded, every source in one stream, newest at the bottom. The chips narrow
 * it to one source; "quiet" shows the lines that only say a repo was re-read
 * with no change. The list follows the newest line until the reader scrolls
 * up, then holds still and counts what arrived. `place` is where it shows
 * now, which a narrow window makes the bottom for a side.
 */
export function FeedDock({ place }: { place: FeedPlace }) {
  const open = useStore((s) => s.feedOpen);
  const chosen = useStore((s) => s.feedPlace);
  const width = useStore((s) => s.feedWidth);
  const feed = useStore((s) => s.feed);
  const sources = useStore((s) => s.sources);
  const feedSource = useStore((s) => s.feedSource);
  const quiet = useStore((s) => s.feedQuiet);
  const height = useStore((s) => s.feedHeight);
  const {
    toggleFeed,
    clearFeed,
    setFeedHeight,
    setFeedPlace,
    setFeedWidth,
    setFeedSource,
    setFeedQuiet,
    openPanel,
  } = useStore(
    useShallow((s) => ({
      toggleFeed: s.toggleFeed,
      clearFeed: s.clearFeed,
      setFeedHeight: s.setFeedHeight,
      setFeedPlace: s.setFeedPlace,
      setFeedWidth: s.setFeedWidth,
      setFeedSource: s.setFeedSource,
      setFeedQuiet: s.setFeedQuiet,
      openPanel: s.openPanel,
    })),
  );
  const box = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [following, setFollowing] = useState(true);
  const [seen, setSeen] = useState(0);
  const [mode, setMode] = useState<SurfaceMode>("normal");
  const focusSize = useStore((s) => s.focusSize);
  const { zoom, entry: zoomEntry } = useZoom("feed", mode === "focus");
  useLeaveOnEscape(mode, setMode);

  // A source that has gone (removed while the feed was narrowed to it)
  // widens the view back out rather than showing nothing forever.
  useEffect(() => {
    if (feedSource !== null && !sources.some((s) => s.id === feedSource)) setFeedSource(null);
  }, [feedSource, sources, setFeedSource]);

  const shown = filterFeed(feed, feedSource, quiet);
  const last = shown[shown.length - 1]?.id ?? 0;

  // Stay on the newest line while following; while not, remember what the
  // reader had so the jump button can count what came after.
  useLayoutEffect(() => {
    if (!open) return;
    const el = list.current;
    if (!el) return;
    if (following) {
      el.scrollTop = el.scrollHeight;
      setSeen(last);
    }
  }, [open, following, last, shown.length]);

  if (!open) return null;

  const onScroll = (e: UIEvent<HTMLOListElement>) => {
    const el = e.currentTarget;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
    if (atEnd !== following) setFollowing(atEnd);
  };
  const unseen = following ? 0 : shown.filter((e) => e.id > seen).length;
  const jump = () => {
    setFollowing(true);
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  // A foreign source reads "<label> · <name>"; a source no longer known
  // never prints its (possibly qualified) id.
  const labelOf = (id: string): string => {
    const src = sources.find((s) => s.id === id);
    if (!src) return idText(id);
    const { backend } = idLabel(id);
    return backend ? `${src.label} · ${backend}` : src.label;
  };

  const modeClass = mode === "full" ? " surface-full" : mode === "focus" ? " surface-focus" : ` at-${place}`;
  // the chosen edge is marked, which a narrow window may be showing elsewhere
  const placeEntries: GearEntry[] = FEED_PLACES.map((p) => ({
    type: "item",
    label: PLACE_WORD[p],
    on: chosen === p,
    run: () => {
      setFeedPlace(p);
      setMode("normal");
    },
  }));
  const side = place === "left" || place === "right";
  return (
    <>
    {mode === "focus" && <FocusBackdrop onLeave={() => setMode("normal")} />}
    <section
      ref={box}
      className={`feed${modeClass}`}
      aria-label="Event feed"
      style={{ "--feed-h": `${height}px`, ...(mode === "focus" ? focusVars(focusSize) : {}) } as CSSProperties}
    >
      {mode === "normal" && side && (
        <Resizer
          className="feed-seam"
          label="Event feed width"
          value={width}
          min={FEED_W.min}
          max={FEED_W.max}
          initial={FEED_W.initial}
          dir={place === "left" ? 1 : -1}
          cssVar="--feed-w"
          target={(h) => h.closest<HTMLElement>(".app-mid")}
          fit={(h) => (h.closest(".app-mid")?.clientWidth ?? Infinity) - VIEW_KEEPS}
          onCommit={setFeedWidth}
        />
      )}
      {mode === "normal" && !side && (
        <TermGrip
          box={box}
          cssVar="--feed-h"
          label="Event feed height"
          height={height}
          setHeight={setFeedHeight}
          bounds={FEED}
          edge={place === "top" ? "bottom" : "top"}
        />
      )}
      <div className="feed-head">
        <span className="term-caption">events</span>
        <div className="feed-chips" role="group" aria-label="Narrow the feed to one source">
          <button
            type="button"
            className={feedSource === null ? "feed-chip on" : "feed-chip"}
            aria-pressed={feedSource === null}
            onClick={() => setFeedSource(null)}
          >
            all
          </button>
          {sources.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`feed-chip${feedSource === s.id ? " on" : ""}${s.error ? " err" : ""}`}
              aria-pressed={feedSource === s.id}
              title={s.error ? `${labelOf(s.id)}: ${s.error}` : labelOf(s.id)}
              onClick={() => setFeedSource(feedSource === s.id ? null : s.id)}
            >
              {labelOf(s.id)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <label className="feed-quiet">
          <input type="checkbox" checked={quiet} onChange={(e) => setFeedQuiet(e.target.checked)} />
          quiet lines
        </label>
        <span className="feed-count" aria-live="off">
          {shown.length}
        </span>
        <button type="button" className="mini" onClick={clearFeed} disabled={feed.length === 0}>
          clear
        </button>
        <Gear
          label="the event feed"
          groups={[
            { label: "feed", entries: [zoomEntry] },
            { label: "place", entries: placeEntries },
            { label: "layout", entries: modeEntries(mode, setMode, "window") },
            {
              label: "share",
              entries: shareEntries({
                el: () => box.current,
                label: "events",
                copy: () =>
                  shown
                    .map((e) => [clock(e.at), KIND_WORD[e.kind], e.source ? labelOf(e.source) : "", e.repo ?? "", e.text].filter(Boolean).join("  "))
                    .join("\n"),
              }),
            },
          ]}
        />
        <button type="button" className="term-x feed-x" aria-label="Hide the event feed" title="hide (e)" onClick={toggleFeed}>
          ×
        </button>
      </div>
      <ol ref={list} className="feed-list" onScroll={onScroll} style={zoomStyle(zoom)}>
        {shown.length === 0 && (
          <li className="feed-empty">
            {feed.length === 0 ? "nothing yet. events land here as the server sends them." : "nothing from this source yet."}
          </li>
        )}
        {shown.map((e) => (
          <FeedRow key={e.id} entry={e} source={e.source ? labelOf(e.source) : ""} onRepo={openPanel} />
        ))}
      </ol>
      {unseen > 0 && (
        <button type="button" className="feed-jump" onClick={jump}>
          ↓ {unseen} new
        </button>
      )}
      {mode === "focus" && <FocusGrips box={box} />}
    </section>
    </>
  );
}

function FeedRow({
  entry,
  source,
  onRepo,
}: {
  entry: FeedEntry;
  source: string;
  onRepo: (id: string) => void;
}) {
  const repoId = entry.repoId;
  return (
    <li className={`feed-row ${entry.kind}${entry.quiet ? " quiet" : ""}`}>
      <time className="feed-time" dateTime={new Date(entry.at).toISOString()}>
        {clock(entry.at)}
      </time>
      <span className="feed-kind">{KIND_WORD[entry.kind]}</span>
      <span className="feed-source" title={source}>
        {source}
      </span>
      {repoId !== undefined ? (
        <button type="button" className="feed-repo" onClick={() => onRepo(repoId)} title="open the repo's panel">
          {entry.repo}
        </button>
      ) : (
        <span className="feed-repo none" />
      )}
      <span className="feed-text">{entry.text}</span>
    </li>
  );
}
