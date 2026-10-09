import { useMemo, useState, type ReactNode } from "react";
import { inboxTick } from "../inbox";
import { attentionItems, canAnswer as canAnswerHere, closedIn, failedItems, idText, inboxItems, turnItems, useStore } from "../store";
import { GLYPH } from "../util";
import { ATTENTION_WORD, WAITING_PANEL, WAITING_WORD, isUnpushed, type AttentionRow, type WaitingGroup } from "../waiting";
import { InboxRow, useNow } from "./Inbox";
import { IdLabel } from "./IdLabel";

/** "4m ago" from unix ms */
function agoMs(at: number, now: number): string {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** One foldable group of the panel, folded under the panel's own id in
 *  `closedSections` as a repo panel's sections are. Alt+click folds or
 *  opens every group the way this one goes. */
function Group({ k, count, children }: { k: WaitingGroup; count: number; children: ReactNode }) {
  const closed = useStore((s) => closedIn(s, WAITING_PANEL, k));
  const toggleSection = useStore((s) => s.toggleSection);
  const foldSections = useStore((s) => s.foldSections);
  return (
    <section className="waiting-group" data-group={k}>
      <div className="section-head">
        <button
          type="button"
          className={`panel-label fold${closed ? "" : " open"}`}
          aria-expanded={!closed}
          title={`Alt+click ${closed ? "opens" : "folds"} every group`}
          onClick={(e) => (e.altKey ? foldSections(WAITING_PANEL, !closed) : toggleSection(WAITING_PANEL, k))}
        >
          {WAITING_WORD[k]} <span>{count}</span>
        </button>
      </div>
      {!closed && children}
    </section>
  );
}

/** the repo rows of one group, each opening its panel */
function RepoRows({ rows }: { rows: readonly AttentionRow[] }) {
  const openPanel = useStore((s) => s.openPanel);
  return (
    <ul className="waiting-list">
      {rows.map(({ repo, state, detail }) => (
        <li key={repo.id}>
          <button type="button" className={`waiting-row s-${state}`} title={`Open ${repo.name}'s panel`} onClick={() => openPanel(repo.id)}>
            <span className="glyph" aria-hidden="true">
              {GLYPH[state]}
            </span>
            {/* IdLabel names another backend's repo; home's goes bare */}
            <span className="waiting-name">
              <IdLabel id={repo.id} />
            </span>
            <span className="waiting-state">{ATTENTION_WORD[state]}</span>
            <span className="waiting-detail" title={detail}>
              {detail}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The body of the "waiting on you" panel: everything that needs you, in
 * one place. First the chats and terminal agents whose turn it is, each
 * opening its run or its repo's agents; then the inbox's items, answered in place through the
 * inbox's own rows (an agent's ask, a run on a prompt, a workflow at a
 * gate, an incubator question, the lessons on offer); then the repos with
 * a conflict, an error or changes, each opening its panel; then the runs
 * and tasks that failed; last, folded at first, the repos that only hold
 * unpushed commits.
 */
export function WaitingBody({ hidden }: { hidden?: boolean }) {
  const turns = useStore(turnItems);
  const items = useStore(inboxItems);
  const canAnswer = useStore(canAnswerHere);
  const attention = useStore(attentionItems);
  const failed = useStore(failedItems);
  const all = useStore((s) => s.repos);
  const nameOf = useMemo(() => new Map(all.map((r) => [r.id, r.name])), [all]);
  const [repos, unpushed] = useMemo(() => [attention.filter((r) => !isUnpushed(r)), attention.filter(isUnpushed)], [attention]);
  const openPanel = useStore((s) => s.openPanel);
  const showRun = useStore((s) => s.showRun);
  const showAgents = useStore((s) => s.showAgents);
  const [picked, setPicked] = useState<string | null>(null);
  // the clocks move only while the panel shows
  const now = useNow(!hidden, inboxTick(items));
  const expanded = picked ?? items[0]?.key ?? null;
  const openTasks = (repoId: string) => {
    openPanel(repoId);
    const st = useStore.getState();
    if (closedIn(st, repoId, "tasks")) st.toggleSection(repoId, "tasks");
  };
  const repoName = (id: string) => nameOf.get(id) ?? idText(id);
  if (turns.length + items.length + attention.length + failed.length === 0) {
    return (
      <p className="waiting-empty">
        Nothing needs you: no chat or agent waits on its prompt, no agent asks, no run is on a prompt, no workflow is at a gate, no
        repo has changes or unpushed commits, and nothing failed.
      </p>
    );
  }
  return (
    <>
      {turns.length > 0 && (
        <Group k="turn" count={turns.length}>
          <ul className="waiting-list">
            {turns.map((t) => {
              const words = (
                <>
                  <span className="glyph" aria-hidden="true">
                    ▸
                  </span>
                  <span className="waiting-name">{t.kind === "chat" ? <IdLabel id={t.repoId} /> : t.name}</span>
                  <span className="waiting-state">{t.kind === "chat" ? "chat" : t.what}</span>
                  <span className="waiting-detail" title={t.kind === "chat" ? t.what : undefined}>
                    {t.kind === "chat" ? t.what : `${t.where}${t.repoId ? ` · ${repoName(t.repoId)}` : ""}`}
                  </span>
                  <span className="inbox-left dim">{agoMs(t.at, now)}</span>
                </>
              );
              const go = t.kind === "chat" ? () => showRun(t.id) : t.repoId ? () => showAgents(t.repoId as string) : null;
              return (
                <li key={`${t.kind}:${t.id}`}>
                  {go ? (
                    <button
                      type="button"
                      className="waiting-row s-turn"
                      title={t.kind === "chat" ? "Open the chat" : "Open its repo's agents"}
                      onClick={go}
                    >
                      {words}
                    </button>
                  ) : (
                    <div className="waiting-row s-turn">{words}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Group>
      )}
      {items.length > 0 && (
        <Group k="inbox" count={items.length}>
          <ul className="inbox-list">
            {items.map((i) => (
              <InboxRow
                key={i.key}
                item={i}
                now={now}
                open={expanded === i.key}
                canAnswer={canAnswer}
                onToggle={() => setPicked(expanded === i.key ? "" : i.key)}
              />
            ))}
          </ul>
        </Group>
      )}
      {repos.length > 0 && (
        <Group k="repos" count={repos.length}>
          <RepoRows rows={repos} />
        </Group>
      )}
      {failed.length > 0 && (
        <Group k="failed" count={failed.length}>
          <ul className="waiting-list">
            {failed.map((f) => (
              <li key={`${f.kind}:${f.id}`}>
                <button
                  type="button"
                  className="waiting-row s-error"
                  title={f.kind === "run" ? "Open the run" : "Open its panel's tasks"}
                  onClick={() => (f.kind === "run" ? showRun(f.id) : openTasks(f.repoId))}
                >
                  <span className="glyph" aria-hidden="true">
                    {GLYPH.error}
                  </span>
                  <span className="waiting-name">{repoName(f.repoId)}</span>
                  <span className="waiting-state">{f.kind}</span>
                  <span className="waiting-detail">{f.what}</span>
                  <span className="inbox-left dim">{agoMs(f.at, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Group>
      )}
      {unpushed.length > 0 && (
        <Group k="unpushed" count={unpushed.length}>
          <RepoRows rows={unpushed} />
        </Group>
      )}
    </>
  );
}
