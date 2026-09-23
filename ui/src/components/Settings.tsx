import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { capsFor, useStore } from "../store";
import { useFitPop } from "../pop";
import { deviceName } from "../../../src/core/presence";
import { Seg } from "./Seg";

const OPEN_IN = [
  { value: "dock", label: "in the dock", title: "Pins a panel on the right, beside the others" },
  { value: "tabs", label: "dock tabs", title: "One panel on the right, the open repos as tabs across it" },
  { value: "tab", label: "new tab", title: "One repo per browser tab" },
  { value: "window", label: "new window", title: "One repo per small window" },
] as const;

const TERMINAL = [
  { value: "window", label: "new window", title: "A new kitty or Terminal window per repo" },
  { value: "tab", label: "tab", title: "A tab in the front kitty or Terminal window" },
] as const;

const SHELL = [
  { value: "auto", label: "auto", title: "The repo's panel when it is open, else the strip" },
  { value: "panel", label: "panel", title: "A section of the repo's panel; it ends when the panel closes" },
  { value: "strip", label: "strip", title: "The strip along the bottom of the window" },
  { value: "tab", label: "tab", title: "A browser tab of its own" },
  { value: "window", label: "window", title: "A small browser window of its own" },
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
  const client = useStore((s) => s.client);
  const helpers = useStore((s) => s.helpers);
  const caps = useStore(useShallow(capsFor));
  const keeping = useStore((s) => s.keeping);
  const setKeeping = useStore((s) => s.setKeeping);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);

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
            <h3 className="panel-label">shell in canopy</h3>
            <Seg
              label="Where a shell opened from a card lands"
              value={settings.shell}
              options={SHELL}
              onChange={(v) => setSetting("shell", v)}
            />
            <p className="settings-hint">
              Auto puts the shell in the repo's panel when one is open and in
              the strip along the bottom otherwise. A shell in a panel ends when
              you close the panel; a strip shell lives until you close it or the
              page.
            </p>
          </section>
          <section className="settings-row">
            <h3 className="panel-label">desktop openers</h3>
            {helpers.length > 0 && (
              <Seg
                label="Which machine the desktop openers run on"
                value={settings.helper ?? "auto"}
                options={[
                  { value: "auto", label: "auto", title: "The helper at this browser's address, else this Mac when it runs the backend" },
                  ...helpers.map((h) => ({ value: h.name, label: h.name, title: `${h.platform}, from ${h.address}: ${h.openers.join(", ") || "no openers"}` })),
                ]}
                onChange={(v) => setSetting("helper", v === "auto" ? null : v)}
              />
            )}
            <p className="settings-hint">
              {caps.via === "backend"
                ? "Through this Mac, which runs the backend."
                : caps.helper
                  ? `Through the helper ${caps.helper.name} on ${caps.helper.platform}: ${caps.helper.openers.join(", ") || "no openers"}.`
                  : helpers.length > 0
                    ? "None picked. The helpers above are attached to the backend now, one per machine; pick the one that is this machine. Picking another sends this browser's clicks to that machine's desktop."
                    : "None. Run canopy helper --backend <this url> on this machine to open kitty, VS Code and the rest here."}
              {client.address && ` This browser is seen as ${client.address}.`}
            </p>
          </section>
          <section className="settings-row">
            <h3 className="panel-label">this device</h3>
            <input
              className="settings-input"
              type="text"
              maxLength={40}
              placeholder={deviceName(navigator.userAgent)}
              value={settings.device}
              aria-label="What this browser is called in the devices list"
              onChange={(e) => setSetting("device", e.target.value)}
            />
            <p className="settings-hint">
              How this browser appears to your other devices, and who a shell says is looking at it. Takes effect on the next reload.
            </p>
          </section>
          <section className="settings-row">
            <h3 className="panel-label">keep shell history</h3>
            <label className="settings-line">
              <input type="checkbox" checked={keeping} onChange={(e) => void setKeeping(e.target.checked)} />
              write each shell out, so a reboot does not take it
            </label>
            <p className="settings-hint">
              A backend setting, not this browser's. Off, the shells go with the machine. On, the backend writes every shell's screen and last 2000
              lines to disk each minute, which is whatever the shell printed, secrets included, and forgets a record a week later. What comes back is a
              new shell at the same repo with the old history ahead of it: the processes are gone, so a shell that had Claude in it is offered a{" "}
              <code>claude --continue</code> instead.
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
