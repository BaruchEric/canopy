import { myPlatform } from "../client";
import { GO, keyCaps, shortcutsOn } from "../shortcuts";
import { useStore } from "../store";
import { PopGear } from "./PopGrip";

/** One press as its keys, each in its own cap. */
function Caps({ press, apple }: { press: string; apple: boolean }) {
  return (
    <span className="keys-caps">
      {keyCaps(press, apple).map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}

/** The ? sheet: every shortcut on the view it was opened from, then the
 *  views g goes to, both read from the table the key handler reads. */
export function KeysSheet({ view }: { view: string }) {
  const close = useStore((s) => s.closeSheet);
  const apple = ["mac", "ios"].includes(myPlatform());
  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">keys · {view}</div>
          <h2 className="sheet-title">Keyboard shortcuts</h2>
        </div>
        <PopGear />
        <button type="button" className="mini close" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="sheet-body keys">
        <p className="keys-note">Single keys work outside a text box.</p>
        <dl className="keys-list">
          {shortcutsOn(view).map((s) => (
            <div key={s.press} className="keys-row">
              <dt>
                <Caps press={s.press} apple={apple} />
              </dt>
              <dd>{s.what}</dd>
            </div>
          ))}
        </dl>
        <h3 className="keys-head">g then</h3>
        <dl className="keys-list">
          {GO.map((g) => (
            <div key={g.key} className={g.view === view ? "keys-row here" : "keys-row"}>
              <dt>
                <span className="keys-caps">
                  <kbd>g</kbd>
                  <kbd>{g.key}</kbd>
                </span>
              </dt>
              <dd>{g.what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}
