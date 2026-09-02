import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { ACTIONS, canRun } from "../../../src/core/actions";
import { activeRunFor, useStore } from "../store";
import {
  OPENER_IDS,
  RUN_ACTIONS,
  type OpenerId,
  type Repo,
  type RunAction,
} from "../../../src/core/types";

/** The "open in" row. The agent lives under "with claude" instead. */
const OPENERS = OPENER_IDS.filter((app) => app !== "agent");

/** What justifies the action, shown at the right edge of its row. */
function fact(repo: Repo, action: RunAction): string {
  const st = repo.status;
  if (!st) return "";
  const files = st.files.length ? `${st.files.length} file${st.files.length === 1 ? "" : "s"}` : "";
  const ahead = st.ahead ? `↑${st.ahead}` : !st.upstream ? "no upstream" : "";
  switch (action) {
    case "commit":
      return files;
    case "push":
      return ahead;
    case "commit-push":
      return [files, ahead].filter(Boolean).join(" · ");
    default:
      return "";
  }
}

const MENU_W = 296;

/**
 * The card's ⋯ menu. Two groups: jobs handed to Claude, which open a
 * pre-flight dialog, and openers, which launch at once. Rendered through a
 * portal so a card's hover transform cannot trap it, and closed by anything
 * that would leave it floating in the wrong place: outside clicks, Escape,
 * scrolling, a resize.
 */
export function RepoMenu({
  repo,
  onError,
}: {
  repo: Repo;
  /** where an opener failure is reported; the console when omitted */
  onError?: (message: string) => void;
}) {
  const plan = useStore((s) => s.plan);
  const showRun = useStore((s) => s.showRun);
  const active = useStore((s) => activeRunFor(s, repo.id));
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Measure once mounted, then flip above the trigger if the bottom edge
  // would leave the viewport.
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const r = trigger.current.getBoundingClientRect();
    const h = menu.current.offsetHeight;
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
    const below = r.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - 6 - h) : below;
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => {
    if (open && pos) {
      menu.current?.querySelector<HTMLElement>("[role=menuitem]:not([aria-disabled=true])")?.focus();
    }
  }, [open, pos]);

  const items = () =>
    Array.from(
      menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([aria-disabled=true])") ?? [],
    );
  const onMenuKey = (e: ReactKeyboardEvent) => {
    const list = items();
    const i = list.findIndex((el) => el === document.activeElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (i + 1) % list.length;
    else if (e.key === "ArrowUp") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    if (next !== null) {
      e.preventDefault();
      list[next]?.focus();
    }
  };

  const openIn = async (app: OpenerId) => {
    setOpen(false);
    try {
      await api.open(repo.id, app);
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (onError) onError(msg);
      else console.error(msg);
    }
  };

  const choose = (action: RunAction) => {
    setOpen(false);
    plan(repo.id, action);
  };

  // Events inside the portal bubble through React to the card, which would
  // open a panel for every menu click.
  const swallow = (e: SyntheticEvent) => e.stopPropagation();

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={open ? "more on" : "more"}
        aria-label={`Actions for ${repo.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Actions"
        onClick={(e) => {
          e.stopPropagation();
          setPos(null);
          setOpen(!open);
        }}
        onPointerDown={swallow}
        onKeyDown={swallow}
        onAuxClick={swallow}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <circle cx="2.5" cy="7" r="1.4" />
          <circle cx="7" cy="7" r="1.4" />
          <circle cx="11.5" cy="7" r="1.4" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="menu"
            role="menu"
            aria-label={`Actions for ${repo.name}`}
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              width: MENU_W,
              visibility: pos ? "visible" : "hidden",
            }}
            onClick={swallow}
            onPointerDown={swallow}
            onAuxClick={swallow}
            onKeyDown={(e) => {
              swallow(e);
              onMenuKey(e);
            }}
          >
            <div className="menu-label">with claude</div>
            {active && (
              <button
                type="button"
                role="menuitem"
                className="menu-item live"
                onClick={() => {
                  setOpen(false);
                  showRun(active.id);
                }}
              >
                <span className="dot sky" />
                <span className="menu-text">
                  {active.status === "waiting"
                    ? `${ACTIONS[active.action].verb} needs you`
                    : `${ACTIONS[active.action].verb} in progress`}
                </span>
                <span className="menu-fact">show</span>
              </button>
            )}
            {RUN_ACTIONS.map((action) => {
              const check = active
                ? { ok: false as const, why: "wait for the current run" }
                : canRun(repo, action);
              return (
                <button
                  key={action}
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  aria-disabled={!check.ok}
                  title={check.ok ? undefined : check.why}
                  tabIndex={check.ok ? 0 : -1}
                  onClick={() => {
                    if (check.ok) choose(action);
                  }}
                >
                  <span className="menu-text">{ACTIONS[action].label}</span>
                  <span className="menu-fact">
                    {check.ok ? fact(repo, action) : check.why}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              title="Start an interactive Claude Code session in a terminal at this repo"
              onClick={() => void openIn("agent")}
            >
              <span className="menu-text">agent</span>
              <span className="menu-fact">interactive, in a terminal</span>
            </button>
            <div className="menu-label">open in</div>
            <div className="menu-row">
              {OPENERS.map((app) => (
                <button
                  key={app}
                  type="button"
                  role="menuitem"
                  className="mini"
                  onClick={() => void openIn(app)}
                >
                  {app}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
