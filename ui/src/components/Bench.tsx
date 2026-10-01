import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { idLabel, multi, useStore } from "../store";
import {
  BENCH_DOCK,
  BENCH_RAIL,
  BENCH_SPLIT,
  benchProjects,
  dockAt,
  railAt,
  shareOf,
  splitAt,
  type BenchPane,
} from "../front";
import { clamp } from "../util";
import { useMedia } from "../media";
import { Seg } from "./Seg";

/** A window too small for the bench's parts side by side, a phone either
 *  way up; styles.css turns at the same widths and heights. */
export const BENCH_ONE = "(max-width: 760px), (max-height: 480px)";

export type { BenchPane };

const PANES: readonly { value: BenchPane; label: string; title: string }[] = [
  { value: "files", label: "changes", title: "The panel: changes, tasks and the rest" },
  { value: "app", label: "app", title: "The dev server's preview" },
  { value: "shell", label: "shell", title: "The project's shells" },
  { value: "log", label: "log", title: "The picked task's terminal or log" },
];

/** the bar's choice for every part side by side, which a phone has no room for */
const ALL = { value: "all", label: "all", title: "Every part side by side" } as const;

/**
 * The bar along the top of a project's bench: every project it can switch
 * to (the open panels, then whatever else has a shell or a task running),
 * each with what it has running, and the button that puts the project back.
 * It also picks the one part that fills the bench, which a phone always has.
 */
export function BenchBar({
  repoId,
  pane,
  setPane,
  has,
}: {
  repoId: string;
  /** the part filling the bench, null while every part shows */
  pane: BenchPane | null;
  setPane: (p: BenchPane | null) => void;
  /** which panes this project has */
  has: Record<BenchPane, boolean>;
}) {
  const panels = useStore((s) => s.panels);
  const terms = useStore((s) => s.terms);
  const shells = useStore((s) => s.shells);
  const taskAll = useStore((s) => s.taskAll);
  const repos = useStore((s) => s.repos);
  const bringProject = useStore((s) => s.bringProject);
  const phone = useMedia(BENCH_ONE);
  // with several machines shown, the same project on two reads apart
  const many = useStore(multi);
  const projects = useMemo(() => benchProjects(panels, terms, shells, taskAll, repos), [panels, terms, shells, taskAll, repos]);
  const parts = PANES.filter((p) => has[p.value]);
  const options = phone ? parts : [ALL, ...parts];
  return (
    <div className="bench-bar">
      <nav className="bench-projects" aria-label="Projects">
        {projects.map((p) => {
          const here = p.repoId === repoId;
          return (
            <button
              key={p.repoId}
              type="button"
              className={`bench-project${here ? " on" : ""}`}
              aria-current={here ? "page" : undefined}
              title={here ? `${p.name} is in front` : `Bring ${p.name} to the front instead`}
              onClick={() => {
                if (!here) bringProject(p.repoId);
              }}
            >
              {p.name}
              {many && idLabel(p.repoId).backend && <span className="bench-machine">{idLabel(p.repoId).backend}</span>}
              {p.running > 0 && (
                <span className="bench-vital run" aria-label={`${p.running} task${p.running === 1 ? "" : "s"} running`}>
                  ▶{p.running > 1 ? p.running : ""}
                </span>
              )}
              {p.shells > 0 && (
                <span className="bench-vital" aria-label={`${p.shells} shell${p.shells === 1 ? "" : "s"}`}>
                  ▸_{p.shells > 1 ? p.shells : ""}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      {parts.length > 1 && (
        <Seg
          label="Show"
          value={pane ?? (phone ? (parts[0]?.value ?? "files") : "all")}
          options={options}
          onChange={(v) => setPane(v === "all" ? null : v)}
          className="bench-panes"
        />
      )}
      <button
        type="button"
        className="term-new term-focus on bench-leave"
        title="Put the project back (Esc)"
        aria-label="Put the project back"
        aria-pressed
        onClick={() => bringProject(null)}
      >
        ⧉
      </button>
    </div>
  );
}

type SeamKind = "rail" | "dock" | "split";

const SEAMS: readonly { kind: SeamKind; label: string; cssVar: string }[] = [
  { kind: "rail", label: "Width of the panel's column", cssVar: "--bench-rail-user" },
  { kind: "dock", label: "Height of the shells and the log", cssVar: "--bench-dock-f" },
  { kind: "split", label: "Width of the log beside the shells", cssVar: "--bench-split-user" },
];

/** what a seam's value reads as in its custom property */
const cssOf = (kind: SeamKind, v: number) => (kind === "rail" ? `${v}px` : String(v));

/**
 * The bench's three draggable edges, laid over the seams between its parts:
 * the panel's column and the rest, the app and the row under it, the shells
 * and the log. They sit straight on the panel, beside its parts rather than
 * around them, since wrapping the preview or the shells would reload the app
 * and hang up the terminal. styles.css places them off the same variables
 * the parts read, and hides each one while its seam is not there. A drag
 * writes the variable live on the panel and saves on release, and the
 * panel's own style carries the saved value from then on; a double click
 * puts the seam back where it started.
 */
export function BenchSeams() {
  const rail = useStore((s) => s.settings.benchRail);
  const dock = useStore((s) => s.settings.benchDock);
  const split = useStore((s) => s.settings.benchSplit);
  const setSetting = useStore((s) => s.setSetting);
  const [dragging, setDragging] = useState<SeamKind | null>(null);
  // a seam that goes mid-drag (the bench left, a part picked) must not leave
  // the page unselectable with a resize cursor
  useEffect(() => () => document.body.classList.remove("resizing", "resizing-rows"), []);

  const commit = (kind: SeamKind, v: number | null) => {
    if (kind === "rail") setSetting("benchRail", v);
    else if (kind === "dock") setSetting("benchDock", v ?? BENCH_DOCK.initial);
    else setSetting("benchSplit", v ?? BENCH_SPLIT.initial);
  };

  const valueAt = (kind: SeamKind, panel: HTMLElement, e: { clientX: number; clientY: number }): number => {
    const box = panel.getBoundingClientRect();
    if (kind === "rail") return railAt(e.clientX, box.left, box.width);
    if (kind === "dock") return dockAt(e.clientY, box.bottom, box.height);
    // the row starts where the panel's column ends
    const column = panel.querySelector(":scope > .panel-body")?.getBoundingClientRect();
    return splitAt(e.clientX, column?.right ?? box.left, box.right);
  };

  const onDown = (kind: SeamKind, cssVar: string) => (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const panel = e.currentTarget.parentElement;
    if (!panel) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDragging(kind);
    document.body.classList.add("resizing");
    if (kind === "dock") document.body.classList.add("resizing-rows");
    let live: number | null = null;
    const move = (ev: globalThis.PointerEvent) => {
      live = valueAt(kind, panel, ev);
      panel.style.setProperty(cssVar, cssOf(kind, live));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setDragging(null);
      document.body.classList.remove("resizing", "resizing-rows");
      if (live !== null) commit(kind, live);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const onKey = (kind: SeamKind) => (e: KeyboardEvent<HTMLDivElement>) => {
    const panel = e.currentTarget.parentElement;
    const keys = kind === "dock" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
    if (!panel || !keys.includes(e.key)) return;
    e.preventDefault();
    // up and right grow the part on that side: the rail, the shells' row
    const grow = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : -1;
    if (kind === "rail") {
      const now = panel.querySelector(":scope > .panel-body")?.getBoundingClientRect().width ?? BENCH_RAIL.min;
      const box = panel.getBoundingClientRect();
      commit(kind, railAt(box.left + clamp(now + grow * (e.shiftKey ? 48 : 12), 0, box.width), box.left, box.width));
    } else if (kind === "dock") commit(kind, shareOf(dock + grow * (e.shiftKey ? 0.08 : 0.02), BENCH_DOCK));
    // right shrinks the log, which is the part on the right
    else commit(kind, shareOf(split - grow * (e.shiftKey ? 0.08 : 0.02), BENCH_SPLIT));
  };

  const now: Record<SeamKind, number | null> = { rail, dock, split };
  return (
    <>
      {SEAMS.map(({ kind, label, cssVar }) => (
        <div
          key={kind}
          className={`bench-seam seam-${kind}${dragging === kind ? " dragging" : ""}`}
          role="separator"
          aria-orientation={kind === "dock" ? "horizontal" : "vertical"}
          aria-label={label}
          aria-valuenow={now[kind] ?? undefined}
          tabIndex={0}
          title={`${label}: drag, or double-click to reset`}
          onPointerDown={onDown(kind, cssVar)}
          onDoubleClick={() => commit(kind, null)}
          onKeyDown={onKey(kind)}
        />
      ))}
    </>
  );
}
