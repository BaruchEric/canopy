import { useMemo } from "react";
import { idLabel, multi, useStore } from "../store";
import { benchProjects } from "../front";
import { useMedia } from "../media";
import { Seg } from "./Seg";

/** A window too small for the bench's parts side by side, a phone either
 *  way up; styles.css turns at the same widths and heights. */
export const BENCH_ONE = "(max-width: 760px), (max-height: 480px)";

/** The parts of the bench a phone shows one at a time: the panel's own
 *  column (changes, tasks and the rest), the app, the shells, the task log. */
export type BenchPane = "files" | "app" | "shell" | "log";

const PANES: readonly { value: BenchPane; label: string; title: string }[] = [
  { value: "files", label: "changes", title: "The panel: changes, tasks and the rest" },
  { value: "app", label: "app", title: "The dev server's preview" },
  { value: "shell", label: "shell", title: "The project's shells" },
  { value: "log", label: "log", title: "The picked task's terminal or log" },
];

/**
 * The bar along the top of a project's bench: every project it can switch
 * to (the open panels, then whatever else has a shell or a task running),
 * each with what it has running, and the button that puts the project back.
 * On a phone it also picks the one pane the bench shows.
 */
export function BenchBar({
  repoId,
  pane,
  setPane,
  has,
}: {
  repoId: string;
  pane: BenchPane;
  setPane: (p: BenchPane) => void;
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
  const options = PANES.filter((p) => has[p.value]);
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
      {phone && options.length > 1 && (
        <Seg label="Show" value={has[pane] ? pane : (options[0]?.value ?? "files")} options={options} onChange={setPane} className="bench-panes" />
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
