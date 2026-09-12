import { useEffect, useState } from "react";
import { useStore } from "../store";

export function Library({ ports, project, onRepo, onPorts }: {
  ports: boolean;
  project: string | null;
  onRepo: (id: string) => void;
  onPorts: () => void;
}) {
  const root = useStore((s) => s.root);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    setError("");
    void fetch("/api/library", { signal: controller.signal }).then(async (response) => {
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not load library");
      setReady(true);
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const frame = document.querySelector<HTMLIFrameElement>(".library-frame");
      if (event.origin !== location.origin || event.source !== frame?.contentWindow) return;
      const data = event.data as { type?: string; path?: string } | null;
      if (data?.type === "canopy:ports") { onPorts(); return; }
      if (data?.type !== "canopy:open-repo" || typeof data.path !== "string") return;
      const repo = useStore.getState().repos.find((r) => r.path === data.path);
      if (repo) onRepo(repo.id);
      else setError("This project is outside the current Git scan. Rescan the cockpit to add it.");
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onRepo, onPorts]);
  const refresh = async () => {
    setRefreshing(true);
    setError("");
    try {
      const response = await fetch("/library/refresh", { method: "POST" });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error || "Refresh failed");
      }
      setRevision((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };
  return <section className="library-view" aria-label={ports ? "Ports and dev servers" : "Project library"}>
    <div className="library-toolbar">
      <span title={root}>{root}</span>
      <span className="library-hint">{ports ? "Dev servers and port assignments" : "Projects, references, tags, notes and relations"}</span>
      <button type="button" className="mini" disabled={!ready || refreshing} onClick={() => void refresh()}>
        {refreshing ? "refreshing…" : "refresh library"}
      </button>
    </div>
    {error && <div className="library-message" role="alert">{error} <button type="button" className="mini" onClick={() => setAttempt(n => n + 1)}>retry</button></div>}
    {!ready && !error && <div className="loading" role="status">Loading library and scanning projects…</div>}
    {ready && <iframe key={`${revision}:${ports}:${project}`} className="library-frame"
      title={ports ? "Canopy ports and dev servers" : "Canopy project library"}
      src={`/library/${ports ? "ports" : ""}${project ? `?project=${encodeURIComponent(project)}` : ""}`} />}
  </section>;
}
