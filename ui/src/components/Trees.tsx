import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { HARNESS } from "../../../src/core/harness";
import type { BranchTree, Repo } from "../../../src/core/types";
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

/** A repo's kept worktrees (FR-051): one row per tree with where its branch
 *  stands, a shell and an agent shell into it, and its removal; under them
 *  a form for a new tree on a branch, new or existing, with the repo's setup
 *  run and its build caches cloned in. Only a repo on its backend's own disk
 *  has the section. */
export function TreesSection({ repo }: { repo: Repo }) {
  const entry = useStore((s) => repoTrees(s.trees, repo.id));
  const openTerm = useStore((s) => s.openTerm);
  const addTree = useStore((s) => s.addTree);
  const removeTree = useStore((s) => s.removeTree);
  const loadTrees = useStore((s) => s.loadTrees);
  const showSection = useStore((s) => s.showSection);
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
      const slug = await addTree(repo.id, name, base.trim() || undefined, caches);
      setBranch("");
      setBase("");
      setAdding(false);
      if (withAgent && agentHere) openTerm(repo.id, "strip", "agent", undefined, undefined, name, slug);
    });
  };
  const shellIn = (t: BranchTree, start?: "agent") => openTerm(repo.id, "strip", start, undefined, undefined, t.branch, t.slug);
  return (
    <Section
      repo={repo}
      k="worktrees"
      className="trees-section"
      label="Worktrees"
      head={<span className={trees.some((t) => t.state === "failed") ? "rust" : trees.some((t) => t.state === "preparing") ? "lichen" : ""}>{treesHead(trees)}</span>}
      title="Worktrees kept by hand, one per branch, each with the repo's setup run and its build caches cloned in. A shell or an agent opens inside one; nothing lands them."
      copy={() => treeLines(trees)}
      tools={
        <button type="button" className="mini" disabled={adding} title="A new worktree on a branch, new or existing" onClick={() => setAdding(true)}>
          + worktree
        </button>
      }
    >
      <div className="landing-body">
        {trees.length > 0 && (
          <ul className="landing-list">
            {trees.map((t) => {
              const row = treeRow(t, now);
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
                    <button type="button" className="mini" disabled={busy !== null} title="Remove the worktree; its branch stays" onClick={() => remove(t, false, false)}>
                      remove
                    </button>
                  </span>
                  {t.state === "failed" && t.why && <pre className="trees-why">{t.why}</pre>}
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
