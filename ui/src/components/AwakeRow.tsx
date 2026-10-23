import { useEffect, useState } from "react";
import { useStore } from "../store";
import { Seg } from "./Seg";
import { awakeWords, type AwakeMode } from "../../../src/core/types";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const MODES: readonly { value: AwakeMode; label: string; title: string }[] = [
  { value: "off", label: "off", title: "The machine sleeps as it always would" },
  { value: "working", label: "while agents work", title: "Held awake while a run or an agent on this machine is working" },
  { value: "always", label: "always", title: "Held awake for as long as canopy runs" },
];

/** The keep awake tab: when the backend holds its machine out of idle
 *  sleep, and whether it holds it now. Read when the row shows, then kept
 *  current by the `awake` event. */
export function AwakeRow({ backend }: { backend: string }) {
  const info = useStore((s) => s.awake[backend]);
  const setAwake = useStore((s) => s.setAwake);
  const [err, setErr] = useState<string | null>(null);
  // the backend asked once this row showed, so "has none" never flashes
  // while the first read is on its way
  const [asked, setAsked] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void useStore
      .getState()
      .loadAwake(backend)
      .finally(() => live && setAsked(backend));
    return () => {
      live = false;
    };
  }, [backend]);

  const pick = (mode: AwakeMode) => {
    setErr(null);
    void setAwake(backend, mode).catch((e) => setErr(errText(e)));
  };

  return (
    <section className="settings-row">
      <h3 className="panel-label">keep awake</h3>
      {info ? (
        <>
          <Seg label="When the backend keeps its machine awake" value={info.mode} options={MODES} onChange={pick} />
          <p className="settings-hint">{awakeWords(info)}</p>
        </>
      ) : asked === backend ? (
        <p className="settings-hint">{backend} did not say: it runs an older canopy, or did not answer.</p>
      ) : null}
      {err && <p className="note err">{err}</p>}
      <p className="settings-hint">
        A backend setting, not this browser's. Canopy holds the machine out of idle sleep through caffeinate on a Mac or systemd-inhibit on Linux,
        tied to its own process so a crash never leaves the hold behind. While agents work counts this backend's runs and the agents the registry
        sees on this machine, never another machine's. A backend in a container cannot hold its host.
      </p>
    </section>
  );
}
