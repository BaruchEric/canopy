import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { linkLabel } from "../util";
import { ACTIONS, checkWhen } from "../../../src/core/actions";
import { describeAgent } from "../../../src/core/agent";
import { describeLaunch } from "../../../src/core/launch";
import { flowWord } from "../flows";
import { useShallow } from "zustand/react/shallow";
import { activeFlowFor, activeRunFor, agentFor, capsFor, connOf, launchFor, useStore } from "../store";
import { backendOf } from "../registry";
import {
  CLAUDE_OPENERS,
  OPENER_IDS,
  type OpenerId,
  type Repo,
  type RunAction,
} from "../../../src/core/types";

/** The "open in" row. The openers that start Claude live under "with claude". */
const OPENERS = OPENER_IDS.filter((app) => !CLAUDE_OPENERS.includes(app));

/** The jobs; the built-in commit/push/commit-push/deploy have workflow twins
 *  now, so only the free-form ask remains here. Chat has its own entry since
 *  it opens no pre-flight. */
const JOBS = ["ask"] as const;

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
  const editLaunch = useStore((s) => s.editLaunch);
  const showLaunch = useStore((s) => s.showLaunch);
  const openTerm = useStore((s) => s.openTerm);
  const agent = useStore((s) => agentFor(s, repo));
  const launch = useStore((s) => launchFor(s, repo));
  // The launcher runs on the backend host; a headless backend (a container)
  // cannot, so it is hidden there. The desktop openers are what this browser
  // can open: the backend's own desktop when it is a Mac this browser runs
  // on, else a helper on this machine, else none. Without a `code` opener
  // VS Code is kept as a client-side Remote-SSH link the browser opens itself.
  // all of it the repo's own backend's: another machine's checkout opens
  // through that machine's openers and helpers, never this page's
  const backend = useStore((s) => connOf(s, backendOf(repo.id)).backend);
  const client = useStore(useShallow((s) => capsFor(s, backendOf(repo.id))));
  const can = (app: OpenerId) => client.openers.includes(app);
  const apps = OPENERS.filter(can);
  const active = useStore((s) => activeRunFor(s, repo.id));
  const workflows = useStore((s) => s.workflows[repo.id]);
  const loadWorkflows = useStore((s) => s.loadWorkflows);
  const planFlow = useStore((s) => s.planFlow);
  const activeFlow = useStore((s) => activeFlowFor(s, repo.id));
  const showFlow = useStore((s) => s.showFlow);
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

  // A fresh fetch on every open, so a workflow file edited since the last
  // one shows up without a rescan.
  useEffect(() => {
    if (open && !repo.host && !repo.forge) void loadWorkflows(repo.id);
  }, [open, repo.id, repo.host, repo.forge, loadWorkflows]);

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
                      ? `${active.verb} needs you`
                      : active.status === "idle"
                        ? "chat open, your turn"
                        : `${active.verb} in progress`}
                  </span>
                  <span className="menu-fact">show</span>
                </button>
              )}
              {activeFlow && (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item live"
                  onClick={() => {
                    setOpen(false);
                    showFlow(activeFlow.id);
                  }}
                >
                  <span className="dot sky" />
                  <span className="menu-text">{flowWord(activeFlow, true)}</span>
                  <span className="menu-fact">show</span>
                </button>
              )}
              {!repo.host && (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  aria-disabled={!!activeFlow}
                  tabIndex={activeFlow ? -1 : 0}
                  title={activeFlow ? "workflow running" : "Talk with Claude Code about this repo, here in canopy"}
                  onClick={() => {
                    if (!activeFlow) void chat();
                  }}
                >
                  <span className="menu-text">{ACTIONS.chat.label}</span>
                  <span className="menu-fact">
                    {activeFlow ? "workflow running" : active ? "show" : "in canopy"}
                  </span>
                </button>
              )}
              {JOBS.map((action) => {
                const check = activeFlow
                  ? { ok: false as const, why: "workflow running" }
                  : active
                    ? { ok: false as const, why: "wait for the current run" }
                    : checkWhen(repo, "any");
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
                    <span className="menu-fact">{check.ok ? "" : check.why}</span>
                  </button>
                );
              })}
              {!repo.host && (workflows ?? []).map((e) => {
                if (!e.ok) {
                  return (
                    <button key={`wf-${e.name}`} type="button" role="menuitem" className="menu-item" aria-disabled title={e.error} tabIndex={-1}>
                      <span className="menu-text">{e.name}</span>
                      <span className="menu-fact">will not parse</span>
                    </button>
                  );
                }
                const w = e.workflow;
                const check = active || activeFlow ? { ok: false as const, why: "wait for the current run" } : checkWhen(repo, w.when);
                return (
                  <button
                    key={`wf-${w.name}`}
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    aria-disabled={!check.ok}
                    title={check.ok ? w.blurb : check.why}
                    tabIndex={check.ok ? 0 : -1}
                    onClick={() => {
                      if (!check.ok) return;
                      setOpen(false);
                      planFlow(repo.id, w.name);
                    }}
                  >
                    <span className="menu-text">{w.label}</span>
                    <span className="menu-fact">
                      {check.ok ? (w.steps.length === 1 ? "" : `${w.steps.length} steps`) : check.why}
                    </span>
                  </button>
                );
              })}
              {can("agent") && (
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
              )}
              {can("herdr") && (
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
              )}
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
              {backend.openers && (
                <>
                  <div className="menu-label">launch</div>
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    title="Released builds installed here, pull requests built here, and this checkout, each launched with a click"
                    onClick={() => {
                      setOpen(false);
                      showLaunch(repo.id);
                    }}
                  >
                    <span className="menu-text">builds & releases</span>
                    <span className="menu-fact">in the panel</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    title="Build and run lines, and which release asset is for this machine"
                    onClick={() => {
                      setOpen(false);
                      editLaunch(repo.id);
                    }}
                  >
                    <span className="menu-text">launch settings…</span>
                    <span className="menu-fact">{describeLaunch(launch)}</span>
                  </button>
                </>
              )}
              <div className="menu-label">open in</div>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                title="A shell at this repo, where the shell setting puts it"
                onClick={() => {
                  setOpen(false);
                  openTerm(repo.id);
                }}
              >
                <span className="menu-text">shell</span>
                <span className="menu-fact">in canopy</span>
              </button>
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
              {apps.length > 0 && (
                <div className="menu-row">
                  {apps.map((app) => (
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
              )}
              {!can("code") && !repo.host && backend.sshHost && (
                <a
                  role="menuitem"
                  className="menu-item"
                  href={`vscode-remote://ssh-remote+${backend.sshHost}${repo.path}`}
                  title="Open this repo in VS Code over Remote-SSH on your own machine"
                  onClick={() => setOpen(false)}
                >
                  <span className="menu-text">VS Code</span>
                  <span className="menu-fact">remote ↗</span>
                </a>
              )}
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
