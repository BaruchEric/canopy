import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isSeedId } from "../../../src/core/sprout";
import { describeAgent } from "../../../src/core/agent";
import { HARNESS } from "../../../src/core/harness";
import { HARNESSES, type LaunchPick } from "../../../src/core/types";
import { profileNames, startHarnesses } from "../agents";
import { backendOf } from "../registry";
import { connOf, routesOf, useStore } from "../store";

/** how long a press is held before it is a long press, not a click */
const LONG_PRESS = 500;
const MENU_W = 240;

/** Where the menu floats: over the button, since a panel's shells are its
 *  footer, or under it when the button sits near the top of the window. It
 *  is fixed rather than placed in the tab row, which clips what overflows. */
function menuPlace(el: HTMLElement | null): CSSProperties {
  const r = el?.getBoundingClientRect();
  if (!r) return {};
  const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_W - 8));
  return r.top > 260 ? { left, bottom: window.innerHeight - r.top + 4, width: MENU_W } : { left, top: r.bottom + 4, width: MENU_W };
}

/**
 * The `+` on a repo's shells row. A click is a plain shell, as it always
 * was; a right click or a long press (a phone has no right click) offers
 * the same shell with an agent started in it: claude or codex, or a named
 * profile, each beating the repo's route for that one start. A harness the
 * backend lacks is greyed out.
 */
export function NewShellButton({ repoId }: { repoId: string }) {
  const openTerm = useStore((s) => s.openTerm);
  const backend = backendOf(repoId);
  // a repo on another host starts its agent there, whatever this backend has
  const host = useStore((s) => s.repos.find((r) => r.id === repoId)?.host ?? null);
  const has = useStore((s) => startHarnesses(connOf(s, backend).backend, host));
  const routes = useStore((s) => routesOf(s, backend));
  const [menu, setMenu] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  // a long press opens the menu, and the click that ends it must not also
  // open a plain shell
  const held = useRef(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // a seed's agents run through the incubator alone: its + is a plain shell
  const seed = isSeedId(repoId);
  const show = () => {
    if (seed) return;
    setPlace(menuPlace(box.current));
    setMenu(true);
  };
  const cancel = () => {
    if (press.current) clearTimeout(press.current);
    press.current = null;
  };
  const start = (pick?: LaunchPick) => {
    setMenu(false);
    if (pick) openTerm(repoId, "panel", "agent", undefined, pick);
    else openTerm(repoId, "panel");
  };
  const profiles = profileNames(routes).filter((n) => n !== "default");

  return (
    <span className="new-shell" ref={box}>
      <button
        type="button"
        className="term-new"
        title={seed ? "Another shell at this seed, here" : "Another shell at this repo, here; right click or hold for one with an agent in it"}
        aria-label="New shell"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => {
          if (held.current) {
            held.current = false;
            return;
          }
          start();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          cancel();
          show();
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || seed) return;
          held.current = false;
          cancel();
          press.current = setTimeout(() => {
            held.current = true;
            show();
          }, LONG_PRESS);
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
      >
        +
      </button>
      {menu && (
        <div className="menu new-shell-menu" role="menu" aria-label="New shell" style={place}>
          <button type="button" role="menuitem" className="menu-item" onClick={() => start()}>
            <span className="menu-text">plain shell</span>
          </button>
          {HARNESSES.map((h) => (
            <button
              key={h}
              type="button"
              role="menuitem"
              className="menu-item"
              disabled={!has.includes(h)}
              title={has.includes(h) ? undefined : `${HARNESS[h].label} is not installed on ${backend}`}
              onClick={() => start({ harness: h })}
            >
              <span className="menu-text">
                <span className={`harness-glyph h-${h}`} aria-hidden="true">
                  {HARNESS[h].glyph}
                </span>{" "}
                {HARNESS[h].label} shell
              </span>
              {!has.includes(h) && <span className="menu-fact">not installed</span>}
            </button>
          ))}
          {profiles.map((name) => {
            const p = routes.profiles[name]!;
            return (
              <button
                key={name}
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={!has.includes(p.harness)}
                onClick={() => start({ profile: name })}
              >
                <span className="menu-text">
                  <span className={`harness-glyph h-${p.harness}`} aria-hidden="true">
                    {HARNESS[p.harness].glyph}
                  </span>{" "}
                  {name}
                </span>
                <span className="menu-fact">{describeAgent(p, false)}</span>
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
