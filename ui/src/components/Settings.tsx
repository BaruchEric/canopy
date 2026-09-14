import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { Seg } from "./Seg";

const OPEN_IN = [
  { value: "dock", label: "in the dock", title: "Pins a panel on the right" },
  { value: "tab", label: "new tab", title: "One repo per browser tab" },
  { value: "window", label: "new window", title: "One repo per small window" },
] as const;

const TERMINAL = [
  { value: "window", label: "new window", title: "A new kitty or Terminal window per repo" },
  { value: "tab", label: "tab", title: "A tab in the front kitty or Terminal window" },
] as const;

const THEME = [
  { value: "system", label: "system", title: "Follows the OS setting" },
  { value: "dark", label: "dark" },
  { value: "light", label: "light" },
] as const;

const DENSITY = [
  { value: "cozy", label: "cozy" },
  {
    value: "compact",
    label: "compact",
    title: "Smaller cards, more columns",
  },
] as const;

const KEYS = [
  ["/", "filter repos"],
  ["d", "only what needs attention"],
  ["f", "filters"],
  ["s", "next grouping"],
  ["[", "hide or show the repo tree"],
  ["esc", "clear the filter"],
] as const;

export function SettingsMenu() {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="settings" ref={ref}>
      <button
        type="button"
        className={open ? "icon-btn on" : "icon-btn"}
        aria-label="Settings"
        aria-expanded={open}
        title="Settings"
        onClick={() => setOpen(!open)}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      </button>
      {open && (
        <div className="settings-pop" role="dialog" aria-label="Settings">
          <section className="settings-row">
            <h3 className="panel-label">open a repo</h3>
            <Seg
              label="Where a clicked repo opens"
              value={settings.openIn}
              options={OPEN_IN}
              onChange={(v) => setSetting("openIn", v)}
            />
            <p className="settings-hint">
              Cmd-click always opens a tab, shift-click a window.
            </p>
          </section>
          <section className="settings-row">
            <h3 className="panel-label">kitty and Terminal</h3>
            <Seg
              label="How the terminal openers place a repo"
              value={settings.terminal}
              options={TERMINAL}
              onChange={(v) => setSetting("terminal", v)}
            />
            <p className="settings-hint">
              For "open in" and the agent. kitty tabs go to the kitty canopy
              runs, its own instance; a Terminal tab presses cmd-t, which needs
              Accessibility access for the server.
            </p>
          </section>
          <section className="settings-row">
            <h3 className="panel-label">theme</h3>
            <Seg
              label="Theme"
              value={settings.theme}
              options={THEME}
              onChange={(v) => setSetting("theme", v)}
            />
          </section>
          <section className="settings-row">
            <h3 className="panel-label">density</h3>
            <Seg
              label="Card density"
              value={settings.density}
              options={DENSITY}
              onChange={(v) => setSetting("density", v)}
            />
          </section>
          <section className="settings-row">
            <h3 className="panel-label">keys</h3>
            <dl className="keys">
              {KEYS.map(([key, what]) => (
                <div key={key}>
                  <dt>
                    <kbd>{key}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}
