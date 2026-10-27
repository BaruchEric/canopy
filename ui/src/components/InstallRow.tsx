import { useState, useSyncExternalStore } from "react";
import { myPlatform } from "../client";
import { installState, requestInstall, STANDING_WORDS, standing, subscribeInstall, workerLine } from "../install";

export function InstallRow() {
  const { worker, prompt } = useSyncExternalStore(subscribeInstall, installState);
  const [error, setError] = useState("");
  const place = standing({ standalone: matchMedia("(display-mode: standalone)").matches, dev: import.meta.env.DEV, secure: window.isSecureContext, hasWorker: "serviceWorker" in navigator, platform: myPlatform() });
  const line = workerLine(worker);
  return (
    <section className="settings-row">
      <h3 className="panel-label">installed page</h3>
      <p className="settings-hint">{STANDING_WORDS[place]}</p>
      {place === "browser" && prompt !== null && <button type="button" className="mini" onClick={() => { setError(""); void requestInstall().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))); }}>install</button>}
      {line !== null && <p className="settings-hint">{line}</p>}
      {error && <p className="settings-hint rust">{error}</p>}
    </section>
  );
}
