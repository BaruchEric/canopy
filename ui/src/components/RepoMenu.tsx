import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { linkLabel } from "../util";
import { ACTIONS, canRun } from "../../../src/core/actions";
import { describeAgent } from "../../../src/core/agent";
import { activeRunFor, agentFor, useStore } from "../store";
import {
  CLAUDE_OPENERS,
  OPENER_IDS,
  RUN_ACTIONS,
  type OpenerId,
  type Repo,
  type RunAction,
} from "../../../src/core/types";

/** The "open in" row. The openers that start Claude live under "with claude". */
const OPENERS = OPENER_IDS.filter((app) => !CLAUDE_OPENERS.includes(app));

/** The jobs; the chat has its own entry since it opens no pre-flight. */
const JOBS = RUN_ACTIONS.filter((a) => a !== "chat");

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
  const openRepo = useStore((s) => s.openRepo);
  const openApp = useStore((s) => s.openApp);
  const showRun = useStore((s) => s.showRun);
  const openChat = useStore((s) => s.openChat);
  const editAgent = useStore((s) => s.editAgent);
  const agent = useStore((s) => agentFor(s, repo));
  const active = useStore((s) => activeRunFor(s, repo.id));
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
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
      await openApp(repo.id, app);
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

  const chat = async () => {
    setOpen(false);
    try {
      await openChat(repo.id);
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (onError) onError(msg);
      else console.error(msg);
    }
  };

  const forge = repo.forge;

  const copyClone = async () => {
    if (!forge || forge.empty) return;
    try {
      await navigator.clipboard.writeText(forge.clone);
      setCopied(true);
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (onError) onError(msg);
      else console.error(msg);
    }
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
          setCopied(false);
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
            {forge ? (
              <>
                <div className="menu-label">on the forge</div>
                <a
                  role="menuitem"
                  className="menu-item"
                  href={repo.path}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={linkLabel(repo.path)}
                  onClick={() => setOpen(false)}
                >
                  <span className="menu-text">{forge.slug}</span>
                  <span className="menu-fact">browser ↗</span>
                </a>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  aria-disabled={forge.empty}
                  title={forge.empty ? "nothing pushed to it yet" : forge.clone}
                  onClick={() => void copyClone()}
                >
                  <span className="menu-text">copy the clone url</span>
                  <span className="menu-fact">{copied ? "copied" : "ssh"}</span>
                </button>
                {forge.clonedAs !== undefined && (
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    title="Open the clone already on this machine"
                    onClick={() => {
                      setOpen(false);
                      openRepo(forge.clonedAs ?? "");
                    }}
                  >
                    <span className="menu-text">the clone here</span>
                    <span className="menu-fact">{forge.clonedAs}</span>
                  </button>
                )}
              </>
            ) : (
              <>
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
                      : active.status === "idle"
                        ? "chat open, your turn"
                        : `${ACTIONS[active.action].verb} in progress`}
                  </span>
                  <span className="menu-fact">show</span>
                </button>
              )}
              {!repo.host && (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  title="Talk with Claude Code about this repo, here in canopy"
                  onClick={() => void chat()}
                >
                  <span className="menu-text">{ACTIONS.chat.label}</span>
                  <span className="menu-fact">{active ? "show" : "in canopy"}</span>
                </button>
              )}
              {JOBS.map((action) => {
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
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                title="Open this repo as a herdr workspace with Claude Code running in it"
                onClick={() => void openIn("herdr")}
              >
                <span className="menu-text">herdr</span>
                <span className="menu-fact">a workspace in herdr</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                title="Model, effort and permissions for every Claude this repo starts"
                onClick={() => {
                  setOpen(false);
                  editAgent(repo.id);
                }}
              >
                <span className="menu-text">agent settings…</span>
                <span className="menu-fact">{describeAgent(agent)}</span>
              </button>
              <div className="menu-label">open in</div>
              {repo.link && (
                <a
                  role="menuitem"
                  className="menu-item"
                  href={repo.link}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={linkLabel(repo.link)}
                  onClick={() => setOpen(false)}
                >
                  <span className="menu-text">git remote</span>
                  <span className="menu-fact">browser ↗</span>
                </a>
              )}
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
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
