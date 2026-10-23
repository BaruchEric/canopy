import { Fragment, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { escapeCloses } from "../surface";
import { useShallow } from "zustand/react/shallow";
import { capsFor, connOf, multi, useStore } from "../store";
import { HANGS_RIGHT, leavesPop, useFitPop } from "../pop";
import { PopGrip } from "./PopGrip";
import { deviceName } from "../../../src/core/presence";
import { sameBuild, shortCommit, versionLine } from "../../../src/core/version";
import type { About } from "../../../src/core/types";
import { api } from "../api";
import { maskKey } from "../answerKey";
import { PAGE_BUILD } from "../build";
import { ago } from "../util";
import { Seg } from "./Seg";
import { screenNow, screenWord, windowNow, windowWord } from "../screens";
import { GearIcon } from "./Gear";
import { ScreenLayoutsRow } from "./ScreenLayouts";
import { RangerRow } from "./Ranger";
import type { Palette } from "../settings";

const LEVEL = [
  { value: "intermediate", label: "intermediate", title: "Agent first: run your app, save your work, and the rest one click away" },
  { value: "advanced", label: "advanced", title: "Every section: changes, tasks, history, peers, launch and more" },
] as const;

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

const PALETTE: readonly { value: Palette; label: string; title: string }[] = [
  { value: "forest", label: "forest", title: "Canopy's own: bark, moss and lichen" },
  { value: "everforest", label: "everforest", title: "Soft greens and warm paper" },
  { value: "gruvbox", label: "gruvbox", title: "Retro, warm and earthy" },
  { value: "nord", label: "nord", title: "Arctic blue-greys, aurora accents" },
  { value: "solarized", label: "solarized", title: "Ethan Schoonover's sixteen colors" },
  { value: "catppuccin", label: "catppuccin", title: "Latte in the light, mocha in the dark" },
  { value: "tokyo-night", label: "tokyo night", title: "Day in the light, night in the dark" },
  { value: "rose-pine", label: "rosé pine", title: "Dawn in the light, main in the dark" },
  { value: "dracula", label: "dracula", title: "Dracula in the dark, Alucard in the light" },
  { value: "vivid", label: "vivid", title: "Saturated primaries on a neutral slate" },
  { value: "neon", label: "neon", title: "Glowing accents on purple-black" },
  { value: "contrast", label: "contrast", title: "Black and white, the most legible" },
];

/** One swatch per palette. Each carries its own `data-palette`, and the
 *  palette blocks in styles.css match any element, so a swatch shows its
 *  set on the scheme in force whatever the page itself wears. */
function PalettePick({ value, onChange }: { value: Palette; onChange: (p: Palette) => void }) {
  return (
    <div className="palettes" role="radiogroup" aria-label="Palette">
      {PALETTE.map((p) => (
        <button
          key={p.value}
          type="button"
          role="radio"
          aria-checked={p.value === value}
          data-palette={p.value}
          title={p.title}
          onClick={() => onChange(p.value)}
        >
          <span className="palette-dots" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          {p.label}
        </button>
      ))}
    </div>
  );
}

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
  ["w", "waiting on you, in a dock panel"],
  ["esc", "clear the filter"],
] as const;

/** A tab down Settings' rail. The first group holds this browser's own
 *  choices, the second the backend the picker names. */
type Tab = "look" | "layout" | "opening" | "device" | "keys" | "desktop" | "signed" | "shells" | "ranger" | "about";

const BROWSER_TABS: readonly { tab: Tab; label: string }[] = [
  { tab: "look", label: "look" },
  { tab: "layout", label: "layout" },
  { tab: "opening", label: "opening" },
  { tab: "device", label: "this device" },
  { tab: "keys", label: "keys" },
];

const BACKEND_TABS: readonly { tab: Tab; label: string }[] = [
  { tab: "desktop", label: "desktop" },
  { tab: "signed", label: "signed in" },
  { tab: "shells", label: "shell history" },
  { tab: "ranger", label: "ranger" },
  { tab: "about", label: "about" },
];

/** A backend's about, fetched each time Settings opens on it. */
function useAbout(name: string, open: boolean): { about: About | null; error: string | null } {
  const [about, setAbout] = useState<About | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setAbout(null);
    setError(null);
    api.about(name).then(
      (a) => {
        if (live) setAbout(a);
      },
      (e: unknown) => {
        if (live) setError(String(e instanceof Error ? e.message : e));
      },
    );
    return () => {
      live = false;
    };
  }, [name, open]);
  return { about, error };
}

export function SettingsMenu() {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const arrangeDock = useStore((s) => s.arrangeDock);
  const home = useStore((s) => s.home);
  const backendOrder = useStore((s) => s.backendOrder);
  const isMulti = useStore(multi);
  // which backend the second group scopes to; falls back to home when the
  // picked one is hidden or gone, or when nothing has been picked yet
  const [picked, setPicked] = useState<string | null>(null);
  const scope = picked && backendOrder.includes(picked) ? picked : home;
  const client = useStore((s) => connOf(s, scope).client);
  const helpers = useStore((s) => connOf(s, scope).helpers);
  const base = useStore((s) => connOf(s, scope).base);
  const caps = useStore(useShallow((s) => capsFor(s, scope)));
  const keeping = useStore((s) => connOf(s, scope).keeping);
  const setKeeping = useStore((s) => s.setKeeping);
  const auth = useStore((s) => s.authByBackend[scope]);
  const ranger = useStore((s) => s.rangers[scope]);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("look");
  const [query, setQuery] = useState("");
  const { about, error } = useAbout(scope, open);
  // read as the menu renders: it opens on the screen the window is on now
  const screen = open ? screenNow() : null;
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useFitPop(ref, open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (leavesPop(e.target, ref)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      escapeCloses(e, () => setOpen(false));
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // a caller that claimed its token since the last read shows when Settings opens
  useEffect(() => {
    if (open) void useStore.getState().loadAuth(scope);
  }, [open, scope]);

  // a find is for this opening; the menu comes back on its tab
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // a tab with nothing to show on this backend is left off the rail, and a
  // picked tab that went away falls back to the first
  const shown = [...BROWSER_TABS, ...BACKEND_TABS.filter((t) => (t.tab !== "signed" || auth) && (t.tab !== "ranger" || ranger))];
  const current = shown.some((t) => t.tab === tab) ? tab : "look";
  const stale = !!about && !!PAGE_BUILD && !sameBuild(PAGE_BUILD, about);

  const values: Partial<Record<Tab, string>> = open
    ? {
        look: PALETTE.find((p) => p.value === settings.palette)?.label,
        layout: settings.level,
        opening: settings.openIn,
        device: settings.device || deviceName(navigator.userAgent),
        desktop: caps.via === "backend" ? scope : (caps.helper?.name ?? "none"),
        signed: auth?.mode,
        shells: keeping ? "kept" : "off",
        ranger: ranger && (ranger.settings.on ? ranger.state : "off"),
        about: about?.version,
      }
    : {};

  const step = (e: ReactKeyboardEvent) => {
    if (!(e.target instanceof HTMLElement) || e.target.getAttribute("role") !== "tab") return;
    const order = shown.map((t) => t.tab);
    const i = order.indexOf(current);
    const n = order.length;
    const next =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? order[(i + 1) % n]
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? order[(i - 1 + n) % n]
          : e.key === "Home"
            ? order[0]
            : e.key === "End"
              ? order[n - 1]
              : undefined;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };

  const tabButton = (t: { tab: Tab; label: string }) => {
    const on = t.tab === current;
    // while finding, no tab is open; the ones holding a match stay lit
    const lit = found ? (hits.has(t.tab) ? " hit" : " miss") : "";
    return (
      <button
        key={t.tab}
        type="button"
        role="tab"
        id={`${id}-tab-${t.tab}`}
        className={`prefs-tab${lit}`}
        aria-selected={on && !found}
        aria-controls={`${id}-panel`}
        tabIndex={on ? 0 : -1}
        onClick={() => {
          setQuery("");
          setTab(t.tab);
        }}
      >
        <span className="prefs-tab-name">{t.label}</span>
        {values[t.tab] && <span className="prefs-tab-value">{values[t.tab]}</span>}
        {t.tab === "about" && stale && <span className="prefs-tab-mark" title="another build than this page" />}
      </button>
    );
  };

  // every section in the order the tabs show them, with the words the find
  // box matches: its heading, its choices, and what people call the thing
  const sections: { tab: Tab; key: string; words: string; node: ReactNode }[] = !open
    ? []
    : [
        {
          tab: "look",
          key: "theme",
          words: `theme system dark light colour color palette more contrast ${PALETTE.map((p) => p.label).join(" ")}`,
          node: (
            <section className="settings-row">
              <h3 className="panel-label">theme</h3>
              <Seg label="Theme" value={settings.theme} options={THEME} onChange={(v) => setSetting("theme", v)} />
              <PalettePick value={settings.palette} onChange={(v) => setSetting("palette", v)} />
              <label className="settings-line">
                <input type="checkbox" checked={settings.moreContrast} onChange={(e) => setSetting("moreContrast", e.target.checked)} />
                more contrast: starker text, lines and grounds, whichever palette
              </label>
            </section>
          ),
        },
        {
          tab: "look",
          key: "density",
          words: "density cozy compact cards columns",
          node: (
            <section className="settings-row">
              <h3 className="panel-label">density</h3>
              <Seg label="Card density" value={settings.density} options={DENSITY} onChange={(v) => setSetting("density", v)} />
            </section>
          ),
        },
        {
          tab: "layout",
          key: "panel",
          words: "repo panel intermediate advanced tour close buttons middle click screen width height zoom font size window",
          node: (
            <section className="settings-row">
              <h3 className="panel-label">repo panel</h3>
              <Seg label="How much a repo's panel shows" value={settings.level} options={LEVEL} onChange={(v) => setSetting("level", v)} />
              <button type="button" className="mini" onClick={() => setSetting("onboarded", false)}>
                show the tour again
              </button>
              <label className="settings-line">
                <input type="checkbox" checked={settings.panelClose} onChange={(e) => setSetting("panelClose", e.target.checked)} />
                close buttons: a docked panel's ✕, its tab's × and a middle click on the tab
              </label>
              {screen && (
                <p className="settings-hint">
                  Widths, heights, zoom, font sizes and what each gear sets are kept by device, by kind of screen (phone, tablet,
                  laptop, desktop, wide, ultra HD) and by kind of window. This browser keeps its own; this screen counts as{" "}
                  {/^[aeiou]/.test(screenWord(screen.cls)) ? "an" : "a"} {screenWord(screen.cls)} ({screen.w}×{screen.h}), and this is the{" "}
                  {windowWord(windowNow())}.
                </p>
              )}
            </section>
          ),
        },
        {
          tab: "layout",
          key: "screens",
          words: "screen layouts profile preset apply detect monitor display 4k ultra",
          node: <ScreenLayoutsRow />,
        },
        {
          tab: "opening",
          key: "open",
          words: "open a repo dock tabs new tab new window cmd-click shift-click",
          node: (
            <section className="settings-row">
              <h3 className="panel-label">open a repo</h3>
              <Seg
                label="Where a clicked repo opens"
                value={settings.openIn}
                options={OPEN_IN}
                // side by side and tabs put the open panels in that
                // arrangement, as the panel gear's entries do
                onChange={(v) => (v === "dock" || v === "tabs" ? arrangeDock(v === "tabs" ? "tabs" : "columns") : setSetting("openIn", v))}
              />
              <p className="settings-hint">Cmd-click always opens a tab, shift-click a window.</p>
            </section>
          ),
        },
        {
          tab: "opening",
          key: "shell",
          words: "shell in canopy terminal auto panel strip tab window",
          node: (
            <section className="settings-row">
              <h3 className="panel-label">shell in canopy</h3>
              <Seg label="Where a shell opened from a card lands" value={settings.shell} options={SHELL} onChange={(v) => setSetting("shell", v)} />
              <p className="settings-hint">
                Auto puts the shell in the repo's panel when one is open and in the strip along the bottom otherwise. A shell in a
                panel ends when you close the panel; a strip shell lives until you close it or the page.
              </p>
            </section>
          ),
        },
        {
          tab: "opening",
          key: "terminal",
          words: "kitty and terminal new window tab open in agent accessibility",
          node: (
            <section className="settings-row">
              <h3 className="panel-label">kitty and Terminal</h3>
              <Seg label="How the terminal openers place a repo" value={settings.terminal} options={TERMINAL} onChange={(v) => setSetting("terminal", v)} />
              <p className="settings-hint">
                For "open in" and the agent. kitty tabs go to the kitty canopy runs, its own instance; a Terminal tab presses cmd-t,
                which needs Accessibility access for the server.
              </p>
            </section>
          ),
        },
        {
          tab: "device",
          key: "name",
          words: "this device name devices browser presence",
          node: (
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
          ),
        },
        {
          tab: "device",
          key: "answer",
          words: "answer key secret token tailchan broker ask guards presence",
          node: <AnswerKeyRow />,
        },
        {
          tab: "keys",
          key: "keys",
          words: `keys keyboard shortcuts ${KEYS.map(([key, what]) => `${key} ${what}`).join(" ")}`,
          node: (
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
          ),
        },
        {
          tab: "desktop",
          key: "openers",
          words: "desktop openers helper machine kitty terminal vs code finder agent",
          node: (
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
                  ? scope === home
                    ? "Through this Mac, which runs the backend."
                    : `Through ${scope}'s own desktop, which runs its backend.`
                  : caps.helper
                    ? `Through the helper ${caps.helper.name} on ${caps.helper.platform}: ${caps.helper.openers.join(", ") || "no openers"}.`
                    : helpers.length > 0
                      ? "None picked. The helpers above are attached to the backend now, one per machine; pick the one that is this machine. Picking another sends this browser's clicks to that machine's desktop."
                      : `None. Run canopy helper --backend ${scope === home ? "<this url>" : base || scope} on that machine to open kitty, VS Code and the rest there.`}
                {client.address && ` This browser is seen as ${client.address}.`}
              </p>
            </section>
          ),
        },
        {
          tab: "signed",
          key: "signed",
          words: "signed in sign callers tokens revoke enforce log page cli helper",
          node: <SignedInRow name={scope} />,
        },
        {
          tab: "shells",
          key: "keeping",
          words: "keep shell history reboot scrollback disk continue resume",
          node: (
            <section className="settings-row">
              <h3 className="panel-label">keep shell history</h3>
              <label className="settings-line">
                <input type="checkbox" checked={keeping} onChange={(e) => void setKeeping(e.target.checked, scope)} />
                write each shell out, so a reboot does not take it
              </label>
              <p className="settings-hint">
                A backend setting, not this browser's. Off, the shells go with the machine. On, the backend writes every shell's screen and last 2000
                lines to disk each minute, which is whatever the shell printed, secrets included, and forgets a record a week later. What comes back is a
                new shell at the same repo with the old history ahead of it: the processes are gone, so a shell that had an agent in it is offered
                its continue (<code>claude --continue</code>, <code>codex resume --last</code>) instead.
              </p>
            </section>
          ),
        },
        {
          tab: "ranger",
          key: "ranger",
          words: "ranger always-on agent crons cron wake telegram profile",
          node: <RangerRow backend={scope} />,
        },
        {
          tab: "about",
          key: "about",
          words: "about version commit build server runtime bun root source reload",
          node: <AboutRow name={scope} isHome={scope === home} about={about} error={error} />,
        },
      ];

  const shownTabs = new Set(shown.map((t) => t.tab));
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const labelOf = (tab: Tab) => shown.find((t) => t.tab === tab)?.label ?? "";
  const found =
    terms.length > 0
      ? sections.filter((s) => shownTabs.has(s.tab) && terms.every((t) => `${labelOf(s.tab)} ${s.words}`.includes(t)))
      : null;
  const hits = new Set(found?.map((s) => s.tab));
  const showing = found ?? sections.filter((s) => s.tab === current);

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
        <GearIcon size={15} />
      </button>
      {open && (
        <div className="settings-pop prefs" role="dialog" aria-label="Settings">
          <nav className="prefs-rail" aria-label="Settings sections" onKeyDown={step}>
            <input
              className="settings-input prefs-find"
              type="search"
              id={`${id}-find`}
              placeholder="find a setting"
              value={query}
              spellCheck={false}
              aria-label="Find a setting"
              aria-controls={`${id}-panel`}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // the first Escape clears the box, the next closes Settings
                if (e.key === "Escape" && query) {
                  e.stopPropagation();
                  e.preventDefault();
                  setQuery("");
                }
              }}
            />
            <div className="prefs-group">
              <p className="prefs-root" id={`${id}-browser`}>
                this browser
              </p>
              <div className="prefs-tabs" role="tablist" aria-orientation="vertical" aria-labelledby={`${id}-browser`}>
                {BROWSER_TABS.map(tabButton)}
              </div>
            </div>
            <div className="prefs-group">
              {isMulti ? (
                <Seg
                  label="Which backend the tabs under it show"
                  value={scope}
                  options={backendOrder.map((n) => ({ value: n, label: n }))}
                  onChange={setPicked}
                />
              ) : (
                <p className="prefs-root">{home}</p>
              )}
              <div className="prefs-tabs" role="tablist" aria-orientation="vertical" aria-label={`Kept on ${scope}`}>
                {shown.filter((t) => BACKEND_TABS.includes(t)).map(tabButton)}
              </div>
            </div>
            {stale && scope === home && (
              <p className="prefs-stale">
                This page is from another build than the server.{" "}
                <button type="button" className="mini" onClick={() => location.reload()}>
                  reload
                </button>
              </p>
            )}
          </nav>
          <div
            key={found ? "find" : current}
            className="prefs-panel"
            role="tabpanel"
            id={`${id}-panel`}
            aria-labelledby={found ? `${id}-find` : `${id}-tab-${current}`}
            tabIndex={0}
          >
            {showing.map((s) => (
              <Fragment key={s.key}>{s.node}</Fragment>
            ))}
            {found?.length === 0 && (
              <p className="prefs-none">
                No setting matches "{query.trim()}". Try a word from a heading or a choice, like palette, kitty or token.
              </p>
            )}
          </div>
          <PopGrip name="settings" anchor={HANGS_RIGHT} gear />
        </div>
      )}
    </div>
  );
}

/**
 * This device's answer key: the secret half of one `name:secret` pair in
 * the tailchan broker's ANSWER_TOKENS, one pair per device. Kept in this
 * browser alone and sent to the home backend only on the writes that need
 * it (answering an ask, presence, guards), which passes it to the broker
 * and keeps nothing. Typed into a masked box; "test key" makes one presence
 * beat with it, the harmless write, and says whether the broker took it.
 */
function AnswerKeyRow() {
  const key = useStore((s) => s.answerKey);
  const ready = useStore((s) => s.asksReady);
  const home = useStore((s) => s.home);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const save = () => {
    try {
      useStore.getState().setAnswerKey(draft);
      setDraft("");
      setNote({ ok: true, text: "kept in this browser" });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };
  const test = async () => {
    setBusy(true);
    const r = await useStore.getState().testAnswerKey(draft.trim() || key || "");
    setBusy(false);
    setNote(r.ok ? { ok: true, text: "ok: the broker took it" } : { ok: false, text: `${r.refused ? "refused" : "could not tell"}: ${r.why}` });
  };
  return (
    <section className="settings-row">
      <h3 className="panel-label">answer key</h3>
      <div className="key-row">
        <input
          className="settings-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={key ? maskKey(key) : "this device's secret"}
          value={draft}
          aria-label="This device's answer key"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) save();
          }}
        />
        <button type="button" className="mini" disabled={!draft.trim()} onClick={save}>
          save
        </button>
        <button type="button" className="mini" disabled={busy || !ready || (!draft.trim() && !key)} onClick={() => void test()}>
          {busy ? "testing…" : "test key"}
        </button>
        {key && (
          <button
            type="button"
            className="mini"
            onClick={() => {
              useStore.getState().setAnswerKey(null);
              setNote(null);
            }}
          >
            forget
          </button>
        )}
      </div>
      <p className="settings-hint">
        What lets this device answer an agent's ask, set presence and edit guards: the secret of this device's own name:secret pair in the
        tailchan broker's ANSWER_TOKENS. Kept in this browser only; {home} passes it to the broker on each answer and keeps nothing.
        {!ready && " This page's backend has no broker, so there is nothing to answer here."}
      </p>
      {note && <p className={note.ok ? "settings-hint" : "settings-hint error"}>{note.text}</p>}
    </section>
  );
}

/**
 * Who may call a backend: its caller check's mode, how many calls it has
 * refused (or would have, in log mode), and each caller it knows with its
 * kind and last use. Revoking ends that caller's token; revoking this page's
 * own forgets it here too, and the top bar offers to sign in again.
 */
function SignedInRow({ name }: { name: string }) {
  const auth = useStore((s) => s.authByBackend[name]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!auth) return null;
  const revoke = (id: string) => {
    setBusy(id);
    setErr(null);
    useStore
      .getState()
      .revokeCaller(name, id)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };
  const admin = auth.you === "page" || auth.you === "cli";
  return (
    <section className="settings-row">
      <h3 className="panel-label">signed in</h3>
      <p className="settings-hint">
        {name} checks callers in <b>{auth.mode}</b> mode
        {auth.mode === "off" ? ": it lets every call through and keeps no count" : auth.mode === "log" ? ": it lets every call through and counts the ones enforce would refuse" : ": it refuses a call without the right token"}
        . {auth.refused.count} {auth.refused.count === 1 ? "call" : "calls"} {auth.mode === "enforce" ? "refused" : "would have been refused"} since it started. This page is{" "}
        {auth.you === "none" ? "not signed in" : `signed in as a ${auth.you}`}.
      </p>
      {auth.callers.length > 0 && (
        <ul className="callers">
          {auth.callers.map((c) => (
            <li key={c.id} className="caller-row">
              <span className="caller-label">{c.label}</span>
              <span className="caller-kind">{c.kind}</span>
              <span className="caller-used" title={new Date(c.used).toLocaleString()}>
                {c.id === auth.youId ? "this page" : `used ${ago(Math.floor(c.used / 1000))}`}
              </span>
              {admin && (
                <button type="button" className="mini" disabled={busy !== null} onClick={() => revoke(c.id)}>
                  {busy === c.id ? "revoking…" : "revoke"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {err && <p className="settings-hint error">{err}</p>}
    </section>
  );
}

/** Which canopy this is: the server's version and commit, where and since
 *  when it runs, and whether this page was bundled from the same build (a
 *  page left open across a redeploy, or a dist/web older than the server).
 *  `isHome` is whether `name` is the backend that actually served this page:
 *  only there does a stale build mean reloading fixes it. The menu fetches
 *  `about`, since its rail marks a stale build too. */
function AboutRow({ name, isHome, about, error }: { name: string; isHome: boolean; about: About | null; error: string | null }) {
  const committed = about?.committedAt ? Date.parse(about.committedAt) / 1000 : undefined;
  const commitUrl = about?.homepage && about.commit ? `${about.homepage}/commit/${about.commit}` : null;
  const stale = about && PAGE_BUILD && !sameBuild(PAGE_BUILD, about);

  return (
    <section className="settings-row">
      <h3 className="panel-label">about</h3>
      {!about && !error && <p className="settings-hint">asking {name}…</p>}
      {error && <p className="settings-hint error">{error}</p>}
      {about && (
        <dl className="about">
          <div>
            <dt>canopy</dt>
            <dd>
              {about.version}
              {about.commit && (
                <>
                  {" · "}
                  {commitUrl ? (
                    <a href={commitUrl} target="_blank" rel="noreferrer">
                      {shortCommit(about.commit)}
                    </a>
                  ) : (
                    shortCommit(about.commit)
                  )}
                  {about.dirty && "+dirty"}
                  {committed !== undefined && ` · ${ago(committed)}`}
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>server</dt>
            <dd>
              {about.hostname}, started {ago(about.startedAt / 1000)}
            </dd>
          </div>
          <div>
            <dt>runtime</dt>
            <dd>
              bun {about.bun} · {about.platform} {about.arch}
            </dd>
          </div>
          <div>
            <dt>root</dt>
            <dd className="about-path">{about.root}</dd>
          </div>
          {PAGE_BUILD && (
            <div>
              <dt>page</dt>
              <dd>{versionLine(PAGE_BUILD)}</dd>
            </div>
          )}
          {about.homepage && (
            <div>
              <dt>source</dt>
              <dd>
                <a href={about.homepage} target="_blank" rel="noreferrer">
                  {about.homepage.replace(/^https:\/\//, "")}
                </a>
              </dd>
            </div>
          )}
        </dl>
      )}
      {stale &&
        (isHome ? (
          <p className="settings-hint warn">
            This page is from another build than the server.{" "}
            <button type="button" className="mini" onClick={() => location.reload()}>
              reload
            </button>
          </p>
        ) : (
          <p className="settings-hint warn">{name} runs another build than this page.</p>
        ))}
    </section>
  );
}
