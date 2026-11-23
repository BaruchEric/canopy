import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { ago } from "../util";
import { Section, useSectionClosed } from "./Surface";
import { FullButton } from "./Floorplan";
import { FRAME_SANDBOX, RemoveButton, savePage } from "./Archify";
import {
  DIAGNOSIS_LANGUAGES,
  DIAGNOSIS_PAGE,
  DIAGNOSIS_PATH,
  DIAGNOSIS_SETTINGS,
  changesLine,
  diagnosisFailure,
  diagnosisHead,
  diagnosisLine,
  isDiagnosisPick,
  languageWord,
  othersLine,
  type DiagnosisInfo,
  type DiagnosisLead,
  type DiagnosisPick,
} from "../../../src/core/diagnosis";
import type { Repo } from "../../../src/core/types";

const errText = (err: unknown) => diagnosisFailure(String(err instanceof Error ? err.message : err));

/** a unix-ms time in the page's own words ("3h ago") */
const agoMs = (ms: number): string => ago(ms / 1000);

/** how often the route is read again while an analysis goes: it takes
 *  seconds on most repos */
const RUN_EVERY = 2500;

/** The seconds since `since`, counted while it is set. */
function useElapsed(since: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? null : Math.max(0, Math.round((now - since) / 1000));
}

/** One finding to look at first: where it is, then what it is, cut at two
 *  lines so the page below stays in view. The whole message is the row's
 *  title, and the page holds it too. */
function LeadRow({ lead }: { lead: DiagnosisLead }) {
  return (
    <li className="diag-lead" title={lead.message}>
      <span className={`diag-sev diag-${lead.severity}`}>{lead.severity}</span>
      <span className="diag-text">
        {lead.where && <code className="diag-where">{lead.where}</code>}
        {lead.message}
      </span>
    </li>
  );
}

/**
 * The map section's Architecture Diagnosis (FR-075): Archify's Code
 * Analysis of the checkout, run by the backend itself with no model, and
 * its page shown here in a sandboxed frame. Starts an analysis, says what
 * it found and what changed since the one before, shows the page, saves it
 * as a file and removes it. `kinds` is the map's kind switch, which sits at
 * the top of the body.
 */
export function DiagnosisMap({ repo, kinds }: { repo: Repo; kinds: ReactNode }) {
  const closed = useSectionClosed(repo.id, "map");
  const [info, setInfo] = useState<DiagnosisInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"run" | "remove" | null>(null);
  const [language, setLanguage] = useState<DiagnosisPick>("auto");
  // the shown page, keyed by its build time so a new analysis reloads it
  const [page, setPage] = useState<{ key: number; html: string } | null>(null);
  const running = info?.running ?? null;
  const elapsed = useElapsed(running);

  const load = useCallback(
    () =>
      api.diagnosis(repo.id).then(
        (got) => {
          setInfo(got);
          setError(null);
        },
        (e: unknown) => setError(errText(e)),
      ),
    [repo.id],
  );
  useEffect(() => {
    if (!closed) void load();
  }, [closed, load]);

  // while an analysis goes, read again now and then; when it ends, once more
  useEffect(() => {
    if (closed || running === null) return;
    const timer = setInterval(() => void load(), RUN_EVERY);
    return () => {
      clearInterval(timer);
      void load();
    };
  }, [closed, running, load]);

  const report = info?.report ?? null;
  const key = report?.builtAt ?? null;
  const pageKey = page?.key ?? null;

  // the page, fetched when there is one and when a new analysis wrote it
  useEffect(() => {
    if (closed || key === null || pageKey === key) return;
    let live = true;
    api.diagnosisPage(repo.id).then(
      (html) => {
        if (live) setPage({ key, html });
      },
      (e: unknown) => {
        if (live) setError(errText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [closed, key, pageKey, repo.id]);

  const run = () => {
    setBusy("run");
    setError(null);
    api
      .diagnosisRun(repo.id, language)
      .then((r) => setInfo((i) => (i ? { ...i, running: r.running, failed: null } : i)))
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setBusy(null));
  };

  const remove = () => {
    setBusy("remove");
    setError(null);
    api
      .diagnosisRemove(repo.id)
      .then(() => {
        setPage(null);
        setInfo((i) => (i ? { ...i, report: null } : i));
        return load();
      })
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setBusy(null));
  };

  const html = page && page.key === key ? page.html : null;
  const facts = report?.facts ?? null;
  const changes = facts ? changesLine(facts.changes) : null;
  const others = facts ? othersLine(facts.others) : null;
  const chosen = info?.settings.language ?? null;
  return (
    <Section
      repo={repo}
      k="map"
      className="map"
      label="Map"
      head={diagnosisHead(info)}
      title="Architecture Diagnosis: what reading the code finds, with Archify's Code Analysis"
      noCapture={html ? "The diagnosis is a sandboxed frame, which a capture cannot see into" : undefined}
      tools={(m, setM) => (html ? <FullButton mode={m} setMode={setM} what="diagnosis" /> : null)}
    >
      <div className="map-body">
        {kinds}
        <p className="map-line">
          <span>
            {info ? diagnosisLine(info, agoMs) : "reading the diagnosis…"}
            {info?.tracked ? " · in git" : ""}
          </span>
          {running !== null && <span className="diag-going">analyzing now{elapsed !== null ? `, ${elapsed}s` : ""}</span>}
        </p>
        {running === null && !info?.tracked && (
          <div className="map-start">
            <select
              className="arch-type"
              value={language}
              aria-label="Which language to read"
              title={`Which language to read: one per analysis. auto lets the analysis choose${chosen ? `, or takes ${languageWord(chosen)} from ${DIAGNOSIS_SETTINGS}` : ""}`}
              onChange={(e) => setLanguage(isDiagnosisPick(e.target.value) ? e.target.value : "auto")}
            >
              <option value="auto">{chosen ? `auto (${languageWord(chosen)})` : "auto"}</option>
              {DIAGNOSIS_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {languageWord(l)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={report ? "mini" : "mini strong"}
              disabled={busy !== null || info === null}
              onClick={run}
              title={`The backend reads the code with Archify's Code Analysis and writes the page into ${DIAGNOSIS_PATH}/, which stays out of git. No model runs and the repo's code is never run`}
            >
              {busy === "run" ? "starting…" : report ? "analyze again" : "analyze"}
            </button>
          </div>
        )}
        {changes && <p className="map-line">{changes}</p>}
        {facts && facts.leads.length > 0 && (
          <ul className="diag-leads" aria-label="Look at first">
            {facts.leads.map((l, i) => (
              <LeadRow key={`${l.code}-${i}`} lead={l} />
            ))}
          </ul>
        )}
        {others && <p className="map-line">{others}</p>}
        {report && (
          <div className="map-acts">
            <button type="button" className="mini" disabled={html === null} onClick={() => html !== null && savePage(html, `${repo.name}-${DIAGNOSIS_PAGE}`)} title="Save the diagnosis as one HTML file, which opens in any browser">
              save the file
            </button>
            {running === null && !info?.tracked && <RemoveButton busy={busy !== null} onRemove={remove} what="the diagnosis's folder" />}
          </div>
        )}
        {info?.failed && running === null && (
          <p className="map-error" role="alert">
            the last analysis failed: {info.failed}
          </p>
        )}
        {error && (
          <p className="map-error" role="alert">
            {error}
          </p>
        )}
        {report && (
          <div className="map-frame-wrap">
            {html !== null ? (
              // clipboard-write lets the page's own "copy the task" buttons work
              <iframe key={key} className="map-frame" sandbox={FRAME_SANDBOX} allow="clipboard-write" referrerPolicy="no-referrer" srcDoc={html} title={`Architecture Diagnosis of ${repo.name}`} />
            ) : (
              <p className="arch-loading">{error ? "the diagnosis could not be loaded" : "loading the diagnosis…"}</p>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}
