import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { HARNESS } from "../../../src/core/harness";
import type { BranchTree, Repo } from "../../../src/core/types";
import { cleanable } from "../../../src/core/treewords";
import { startHarnesses } from "../agents";
import { backendOf } from "../registry";
import { agentFor, connOf, useStore } from "../store";
import { keepKeys } from "../surface";
import { repoTrees, treeLines, treeRow, treesChip, treesHead } from "../trees";
import { Section } from "./Surface";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** The card's word for the worktrees it keeps (FR-051): how many, each
 *  named in the tooltip. Clicking it opens the worktrees section. */
export function TreesChip({ repoId }: { repoId: string }) {
  const trees = useStore((s) => repoTrees(s.trees, repoId)?.trees);
  const showSection = useStore((s) => s.showSection);
  const chip = treesChip(trees);
  if (!chip) return null;
  return (
    <button
      type="button"
      className={`run-chip trees-card${chip.tone ? ` ${chip.tone}` : ""}`}
      title={chip.title}
      onClick={(e) => {
        e.stopPropagation();
        showSection(repoId, "worktrees");
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={keepKeys}
    >
      {chip.text}
    </button>
  );
}

/** rows a card shows before the rest folds into a count */
export const CARD_TREES = 6;

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

/** the tree's own card on the repo's backend (the trees source scans the
 *  folder), when the scan has found it */
const cardOf = (repos: readonly Repo[], repoId: string, t: BranchTree): Repo | undefined => {
  const b = backendOf(repoId);
  return repos.find((r) => r.path === t.dir && backendOf(r.id) === b);
};

/** The kept trees on the card itself, at cozy density (compact keeps the
 *  chip): a row per tree with its branch, words and age, a shell and the
 *  agent into it, and the count past CARD_TREES. The branch opens the
 *  worktrees section. In select mode the rows are inert, like the
 *  machine strip. */
export function TreeRows({ repo, selecting }: { repo: Repo; selecting: boolean }) {
  const trees = useStore((s) => repoTrees(s.trees, repo.id)?.trees);
  const openTerm = useStore((s) => s.openTerm);
  const showSection = useStore((s) => s.showSection);
  const openPanel = useStore((s) => s.openPanel);
  const repos = useStore((s) => s.repos);
  const agent = useStore((s) => agentFor(s, repo, "shell"));
  const shellHas = useStore((s) => startHarnesses(connOf(s, backendOf(repo.id)).backend, repo.host));
  if (!trees || trees.length === 0) return null;
  const now = Date.now();
  const agentHere = shellHas.includes(agent.harness);
  const agentLabel = HARNESS[agent.harness].label;
  const shown = trees.slice(0, CARD_TREES);
  const more = trees.length - shown.length;
  const section = (e: { stopPropagation(): void }) => {
    stop(e);
    showSection(repo.id, "worktrees");
  };
  return (
    <div className="card-trees" role="group" aria-label={`Worktrees kept for ${repo.name}`}>
      {shown.map((t) => {
        const row = treeRow(t, now);
        const words = `${row.words}${row.age ? ` · ${row.age}` : ""}`;
        const title = `${t.dir}${t.state === "failed" && t.why ? `\n${t.why}` : ""}`;
        // the tree's own card has the whole panel; until the scan finds it,
        // the section
        const card = cardOf(repos, repo.id, t);
        return (
          <div key={t.slug} className={`card-tree${row.tone ? ` ${row.tone}` : ""}`} title={title}>
            {selecting ? (
              <span className="card-tree-name">⑂ {t.branch}</span>
            ) : (
              <button
                type="button"
                className="card-tree-name"
                title={card ? `${t.dir}: open its own panel` : `${t.dir}: the worktrees section`}
                onClick={(e) => {
                  stop(e);
                  if (card) openPanel(card.id);
                  else showSection(repo.id, "worktrees");
                }}
                onPointerDown={stop}
                onKeyDown={keepKeys}
              >
                ⑂ {t.branch}
              </button>
            )}
            <span className="card-tree-words">{words}</span>
            {!selecting && (
              <span className="card-tree-tools">
                <button
                  type="button"
                  className="mini"
                  title={`A shell in ${t.dir}`}
                  onClick={(e) => {
                    stop(e);
                    openTerm(repo.id, undefined, undefined, undefined, undefined, t.branch, t.slug);
                  }}
                  onPointerDown={stop}
                  onKeyDown={keepKeys}
                >
                  shell
                </button>
                {agentHere && (
                  <button
                    type="button"
                    className="mini"
                    title={`A shell in the tree with ${agentLabel} started in it`}
                    onClick={(e) => {
                      stop(e);
                      openTerm(repo.id, undefined, "agent", undefined, undefined, t.branch, t.slug);
                    }}
                    onPointerDown={stop}
                    onKeyDown={keepKeys}
                  >
                    {HARNESS[agent.harness].glyph}
                  </button>
                )}
              </span>
            )}
          </div>
        );
      })}
      {more > 0 &&
        (selecting ? (
          <span className="card-tree-more">{more} more</span>
        ) : (
          <button type="button" className="card-tree-more" title="The worktrees section lists every tree" onClick={section} onPointerDown={stop} onKeyDown={keepKeys}>
            {more} more
          </button>
        ))}
    </div>
  );
}

/** A repo's kept worktrees (FR-051): one row per tree with where its branch
 *  stands, a shell and an agent shell into it, its sync from its base (a
 *  rebase with the uncommitted work stashed over it, by hand when the tree
 *  is behind and by itself whenever the base moves while auto is on), its
 *  merge into its base
 *  (worktrunk's `wt merge`: commit, squash, rebase, the gates, fast-forward,
 *  remove) and its removal; under them a form for a new tree on a branch,
 *  new or existing, with the repo's setup run and its build caches cloned
 *  in. The head's clean-up removes the trees whose base holds everything
 *  they have. Only a repo on its backend's own disk has the section. */
export function TreesSection({ repo }: { repo: Repo }) {
  const entry = useStore((s) => repoTrees(s.trees, repo.id));
  const openTerm = useStore((s) => s.openTerm);
  const addTree = useStore((s) => s.addTree);
  const removeTree = useStore((s) => s.removeTree);
  const mergeTree = useStore((s) => s.mergeTree);
  const cleanTrees = useStore((s) => s.cleanTrees);
  const syncTree = useStore((s) => s.syncTree);
  const setTreeAuto = useStore((s) => s.setTreeAuto);
  const loadTrees = useStore((s) => s.loadTrees);
  const showSection = useStore((s) => s.showSection);
  const openPanel = useStore((s) => s.openPanel);
  const repos = useStore((s) => s.repos);
  // the shell route's agent, the one "new shell" starts at the checkout
  const agent = useStore((s) => agentFor(s, repo, "shell"));
  const shellHas = useStore((s) => startHarnesses(connOf(s, backendOf(repo.id)).backend, repo.host));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ slug: string; why: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [caches, setCaches] = useState(true);
  const [follow, setFollow] = useState(true);
  const [withAgent, setWithAgent] = useState(true);
  // a fresh list whenever the panel shows the repo, since a commit made in
  // a tree from a shell moves counts the event may not carry yet
  useEffect(() => {
    void loadTrees(backendOf(repo.id));
  }, [repo.id, loadTrees]);
  if (repo.forge || repo.host) return null;
  const trees: readonly BranchTree[] = entry?.trees ?? [];
  const agentHere = shellHas.includes(agent.harness);
  const agentLabel = HARNESS[agent.harness].label;
  const now = Date.now();
  const act = (key: string, fn: () => Promise<void>) => {
    setError("");
    setBusy(key);
    void fn().then(
      () => setBusy(null),
      (err: unknown) => {
        setBusy(null);
        setError(errText(err));
      },
    );
  };
  const remove = (t: BranchTree, force: boolean, deleteBranch: boolean) => {
    setRefused(null);
    setError("");
    setBusy(`rm:${t.slug}`);
    void removeTree(repo.id, t.slug, force, deleteBranch).then(
      () => setBusy(null),
      (err: unknown) => {
        setBusy(null);
        const why = errText(err);
        // what the tree holds, said under its row with the way past it
        if (why.includes("remove it with force")) setRefused({ slug: t.slug, why: why.replace(/; remove it with force.*$/, "") });
        else setError(why);
      },
    );
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = branch.trim();
    if (!name || busy !== null) return;
    act("add", async () => {
      const slug = await addTree(repo.id, name, base.trim() || undefined, caches, follow);
      setBranch("");
      setBase("");
      setAdding(false);
      if (withAgent && agentHere) openTerm(repo.id, undefined, "agent", undefined, undefined, name, slug);
    });
  };
  // where the shell lands is the shells setting, as for the card's own shell
  const shellIn = (t: BranchTree, start?: "agent") => openTerm(repo.id, undefined, start, undefined, undefined, t.branch, t.slug);
  const merge = (t: BranchTree) => {
    setRefused(null);
    act(`merge:${t.slug}`, () => mergeTree(repo.id, t.slug));
  };
  // a sync that stopped is said under the row by the record, so it is not
  // the section's error as well
  const sync = (t: BranchTree) => {
    setRefused(null);
    act(`sync:${t.slug}`, () =>
      syncTree(repo.id, t.slug).catch((err: unknown) => {
        if (!errText(err).startsWith("sync stopped")) throw err;
      }),
    );
  };
  const cleanCount = trees.filter(cleanable).length;
  const headTone = trees.some((t) => t.state === "failed" || t.stopped) ? "rust" : trees.some((t) => t.state === "preparing" || t.state === "merging") ? "lichen" : "";
  return (
    <Section
      repo={repo}
      k="worktrees"
      className="trees-section"
      label="Worktrees"
      tab={trees.length > 0 ? trees.length : null}
      head={<span className={headTone}>{treesHead(trees)}</span>}
      title="Worktrees kept by hand, one per branch, each with the repo's setup run and its build caches cloned in. A shell or an agent opens inside one; sync rebases a tree onto its base, by hand or by itself whenever the base moves; merge folds a tree's branch into its base and removes it; clean up removes the trees already merged."
      copy={() => treeLines(trees)}
      tools={
        <>
          {cleanCount > 0 && (
            <button
              type="button"
              className="mini"
              disabled={busy !== null}
              title={`Remove the ${cleanCount === 1 ? "tree" : `${cleanCount} trees`} whose base holds every commit and that hold no change or shell, branch and all`}
              onClick={() => act("clean", async () => void (await cleanTrees(repo.id)))}
            >
              {busy === "clean" ? "cleaning…" : `clean up ${cleanCount}`}
            </button>
          )}
          <button type="button" className="mini" disabled={adding} title="A new worktree on a branch, new or existing" onClick={() => setAdding(true)}>
            + worktree
          </button>
        </>
      }
    >
      <div className="landing-body">
        {trees.length > 0 && (
          <ul className="landing-list">
            {trees.map((t) => {
              const row = treeRow(t, now);
              const card = cardOf(repos, repo.id, t);
              return (
                <li key={t.slug} className={`landing-row trees-row${row.tone ? ` ${row.tone}` : ""}`}>
                  <span className="landing-branch" title={t.dir}>
                    {t.branch}
                  </span>
                  <span className="dim">
                    {row.words}
                    {row.age ? ` · ${row.age}` : ""}
                  </span>
                  <span className="trees-tools">
                    {card && (
                      <button type="button" className="mini" title="The tree's own panel: its changes, files, tasks, preview and shells" onClick={() => openPanel(card.id)}>
                        open
                      </button>
                    )}
                    <button type="button" className="mini" title={`A shell in ${t.dir}`} onClick={() => shellIn(t)}>
                      shell
                    </button>
                    <button
                      type="button"
                      className="mini"
                      disabled={!agentHere}
                      title={agentHere ? `A shell in the tree with ${agentLabel} started in it` : `${agentLabel} is not installed on ${backendOf(repo.id)}`}
                      onClick={() => shellIn(t, "agent")}
                    >
                      {HARNESS[agent.harness].glyph} {agentLabel}
                    </button>
                    {(t.files > 0 || t.ahead > 0) && (
                      <button type="button" className="mini" title="The changes section lists this tree's files and commits under work elsewhere" onClick={() => showSection(repo.id, "changes")}>
                        changes
                      </button>
                    )}
                    {t.behind > 0 && (
                      <button
                        type="button"
                        className="mini"
                        disabled={busy !== null || t.state === "preparing" || t.state === "merging"}
                        title={`Rebase the branch onto ${t.base || "its base"} now, with uncommitted work stashed and put back (git rebase --autostash)`}
                        onClick={() => sync(t)}
                      >
                        {busy === `sync:${t.slug}` ? "syncing…" : "sync"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="mini trees-auto"
                      aria-pressed={t.sync}
                      disabled={busy !== null}
                      title={
                        t.sync
                          ? `The tree follows ${t.base || "its base"} by itself, rebased whenever it moves; click to leave it where it is`
                          : `The tree stays where it is while ${t.base || "its base"} moves; click to have it follow`
                      }
                      onClick={() => act(`auto:${t.slug}`, () => setTreeAuto(repo.id, t.slug, !t.sync))}
                    >
                      auto
                    </button>
                    <button
                      type="button"
                      className="mini"
                      disabled={busy !== null || t.state === "preparing" || t.state === "merging"}
                      title={`Commit what is uncommitted, squash the commits into one, rebase onto ${t.base || "the base"}, run the gates in the tree, fast-forward ${t.base || "the base"} to it, then remove the tree and its branch`}
                      onClick={() => merge(t)}
                    >
                      {t.state === "merging" ? "merging…" : "merge"}
                    </button>
                    <button type="button" className="mini" disabled={busy !== null} title="Remove the worktree; its branch stays" onClick={() => remove(t, false, false)}>
                      remove
                    </button>
                  </span>
                  {t.state === "failed" && t.why && <pre className="trees-why">{t.why}</pre>}
                  {t.stopped && <pre className="trees-why trees-stopped">{t.stopped}</pre>}
                  {refused?.slug === t.slug && (
                    <span className="trees-refused rust">
                      {refused.why}.
                      <button type="button" className="mini" disabled={busy !== null} title="Remove the worktree and lose what it holds; the branch and its commits stay" onClick={() => remove(t, true, false)}>
                        remove anyway
                      </button>
                      <button type="button" className="mini" disabled={busy !== null} title="Remove the worktree and delete its branch, commits and all" onClick={() => remove(t, true, true)}>
                        and its branch
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {adding && (
          <form className="trees-form" onSubmit={submit}>
            <input type="text" value={branch} placeholder="branch, new or existing" aria-label="Branch" autoFocus onChange={(e) => setBranch(e.target.value)} />
            <input type="text" value={base} placeholder={`from ${repo.status?.branch ?? "the default branch"}`} aria-label="Base" onChange={(e) => setBase(e.target.value)} />
            <label className="trees-check">
              <input type="checkbox" checked={caches} onChange={(e) => setCaches(e.target.checked)} /> clone build caches
            </label>
            <label className="trees-check">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow {base.trim() || repo.status?.branch || "the base"}
            </label>
            {agentHere && (
              <label className="trees-check">
                <input type="checkbox" checked={withAgent} onChange={(e) => setWithAgent(e.target.checked)} /> open {agentLabel} in it
              </label>
            )}
            <button type="submit" className="mini strong" disabled={busy !== null || !branch.trim()}>
              {busy === "add" ? "making…" : "make"}
            </button>
            <button type="button" className="mini" disabled={busy === "add"} onClick={() => setAdding(false)}>
              cancel
            </button>
          </form>
        )}
        {error && <p className="landing-err">{error}</p>}
      </div>
    </Section>
  );
}
