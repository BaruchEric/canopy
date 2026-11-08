/**
 * What a right-click offers (FR-056), by what it landed on. Each builder
 * reads the store as it is when the menu draws (the host runs it again on
 * every change) and reuses what the page already has: the ⋯ menu's body
 * for a repo, a surface's gear groups, the copy keys' parts. The order is
 * the click's own: selected text, then the link or the fact under the
 * pointer, then the thing it is on, then the surface's settings. Nowhere
 * to go and nothing to set leaves the page's own row: views, the command
 * line, the clipboard.
 */
import { RUN_CARD, agentName } from "../allagents";
import { machineOf } from "../agentcards";
import { gearAround } from "../ctxgears";
import { ctxLink, ctxSubjects, factLabel, isFact, type CtxItem, type CtxNode, type CtxSubject } from "../ctxmenu";
import { pickable } from "../flows";
import { lastShell, typeInto } from "../liveTerms";
import { backendOf } from "../registry";
import { say } from "../said";
import { copyText } from "../share";
import { GO, type CopyKey } from "../shortcuts";
import { SECTION_KEYS, SECTION_WORD, type SectionKey } from "../surface";
import { eventActs, statusWord } from "../triggers";
import { GLYPH, linkLabel, stateOf } from "../util";
import { WAITING_PANEL } from "../waiting";
import { closedIn, idText, inboxItems, isFavorite, multi, useStore, type CanopyState } from "../store";
import { openView } from "../clirun";
import type { Repo } from "../../../src/core/types";
import { ContextMenuHost, GearBlock, type CtxBlock, type CtxHead, type CtxQuick, type CtxSpec } from "./ContextMenu";
import { Icon } from "./Icon";
import { KIND_GLYPH } from "./Inbox";
import { copyPart, copyableOfKey, triggerEventOf } from "./KbFocus";
import { RepoMenuItems } from "./RepoMenu";

/** Mounted once per window, by App. */
export function ContextMenus() {
  return <ContextMenuHost build={buildMenu} />;
}

/** Copies `text` and says what went: `name` is what the line calls it. */
async function copyNamed(name: string, text: string): Promise<string> {
  await copyText(text, { from: name });
  return `copied ${name}: ${factLabel(text, 60)}`;
}

/** A copy row: dimmed with "none" where the item has no such part. */
function copyRow(id: string, name: string, text: string | null | undefined, keys?: string): CtxItem {
  return text
    ? { kind: "run", id, label: name, fact: { code: factLabel(text, 26) }, title: text, ...(keys ? { keys } : {}), run: () => copyNamed(name, text) }
    : { kind: "run", id, label: name, off: "none", run: () => undefined };
}

/** The copy keys' parts of an item with a ring key, as rows that copy the
 *  way y does. */
function partRows(key: string): CtxItem[] {
  const parts = copyableOfKey(key);
  if (!parts) return [];
  const row = (k: CopyKey, id: string, name: string, text: string | null): CtxItem =>
    text ? { kind: "run", id, label: name, fact: { code: factLabel(text, 26) }, title: text, keys: `y ${k}`, run: () => copyPart(k, text) } : { kind: "run", id, label: name, off: "none", run: () => undefined };
  return [row("b", "copy:branch", "branch", parts.branch), row("p", "copy:pr", "PR link", parts.pr), row("r", "copy:run", "run id", parts.run)];
}

/** the view this window shows, as App reads it */
const viewNow = (): string => new URLSearchParams(location.search).get("view") || "git";

/** The element on the way up that the chain's `i`th node describes. */
function nth(target: Element, i: number): Element | null {
  let at: Element | null = target;
  for (let k = 0; k < i && at; k++) at = at.parentElement;
  return at;
}

/** Builds the menu for a right-click, or null to leave it to the browser. */
export function buildMenu(target: Element, chain: CtxNode[], selection: string): CtxSpec | null {
  const s = useStore.getState();
  const subjects = ctxSubjects(chain);
  const first = subjects[0];
  const blocks: CtxBlock[] = [];

  // what is under the pointer itself, most precise first
  const near: CtxItem[] = [];
  const repoHere = repoIdOf(subjects);
  if (selection) near.push(...selectionRows(s, selection, repoHere));
  const link = ctxLink(chain);
  if (link) {
    near.push(
      { kind: "link", id: "link:open", label: "open the link in a new tab", fact: linkLabel(link), href: link },
      { kind: "run", id: "link:copy", label: "copy the link", run: () => copyNamed("link", link) },
    );
  }
  const factAt = chain.findIndex(isFact);
  const factEl = factAt >= 0 ? nth(target, factAt) : null;
  const fact = factEl instanceof HTMLElement ? (factEl.dataset["copy"] ?? factEl.textContent ?? "").trim() : "";
  if (fact && fact !== selection && !(link && fact === link) && fact.length <= 4000) {
    near.push({ kind: "run", id: "fact:copy", label: "copy", fact: { code: factLabel(fact) }, title: fact, run: () => copyNamed("text", fact) });
  }
  if (near.length) blocks.push({ kind: "items", key: "near", items: near });

  let head: CtxHead | undefined;
  let quick: CtxQuick[] | undefined;
  let label = "Menu";
  let subjectBlocks: CtxBlock[] = [];

  const built = first ? subjectMenu(s, first, target) : null;
  if (built) {
    ({ head, quick, label } = built);
    subjectBlocks = built.blocks;
  }

  // a surface's gear, where the click is on the surface itself and not on
  // a card, a row or a tab that has a menu of its own; a panel's head and
  // tab carry the repo's actions, its body and its sections their gear
  const onThing = first !== undefined && first.kind !== "panel" && first.kind !== "section";
  const gear = onThing || (first?.kind === "panel" && first.head) ? null : gearAround(target);
  if (gear) {
    if (!head) head = { title: gear.reg.label().replace(/^the /, "") };
    subjectBlocks.push({ kind: "node", key: "gear", node: (done) => <GearBlock reg={gear.reg} done={done} /> });
  }
  blocks.push(...subjectBlocks);

  // nothing about the thing itself: the page's own row
  if (!built) blocks.push(pageBlock(s));
  if (!blocks.length) return null;
  return { label: head ? `Menu for ${head.title}` : label, ...(head ? { head } : {}), ...(quick ? { quick } : {}), blocks };
}

/** the repo a right-click is inside of, if any */
function repoIdOf(subjects: readonly CtxSubject[]): string | null {
  for (const sub of subjects) {
    if (sub.kind === "repo" || sub.kind === "panel") return sub.id;
    if (sub.kind === "section" && sub.repo) return sub.repo;
  }
  return null;
}

interface Built {
  label: string;
  head?: CtxHead;
  quick?: CtxQuick[];
  blocks: CtxBlock[];
}

function subjectMenu(s: CanopyState, sub: CtxSubject, target: Element): Built | null {
  switch (sub.kind) {
    case "repo": {
      const repo = s.repos.find((r) => r.id === sub.id);
      return repo ? repoMenu(s, repo, "card") : null;
    }
    case "tab":
    case "panel": {
      const repo = s.repos.find((r) => r.id === sub.id);
      return repo ? repoMenu(s, repo, sub.kind === "tab" ? "tab" : sub.head ? "head" : "body") : null;
    }
    case "section":
      return sub.repo ? sectionMenu(s, sub.key, sub.repo) : null;
    case "inbox":
      return inboxMenu(s, sub.key, target);
    case "trigger":
      return triggerMenu(s, sub.id);
    case "agent":
      return agentMenu(s, sub.id, target);
  }
}

/** The line naming a repo: its state's glyph and colour, its branch, its
 *  machine where there are several, what it holds. */
function repoHead(s: CanopyState, repo: Repo): CtxHead {
  const st = repo.status;
  const state = stateOf(repo);
  const facts: CtxHead["facts"] = [];
  const branch = st?.branch ?? repo.forge?.branch;
  if (branch) facts.push({ text: branch, mono: true, title: "branch" });
  if (repo.host) facts.push({ text: repo.host, title: "over ssh" });
  else if (multi(s)) facts.push({ text: backendOf(repo.id), title: "machine" });
  if (repo.forge) facts.push({ text: repo.forge.clonedAs ? "cloned here" : "on the forge" });
  else if (repo.error) facts.push({ text: "not a readable repo" });
  else if (st?.files.length) facts.push({ text: `${st.files.length} changed` });
  else facts.push({ text: "clean" });
  if ((st?.ahead ?? 0) > 0) facts.push({ text: `↑${st?.ahead}`, title: "commits to push" });
  if ((st?.behind ?? 0) > 0) facts.push({ text: `↓${st?.behind}`, title: "commits to pull" });
  return { glyph: GLYPH[state], state: `s-${state}`, title: repo.name, facts };
}

/** A repo's menu, from its card, its tree row, its panel's tab or head or
 *  the panel itself: the head, the quick row, the panel's own moves where
 *  it is one, the ⋯ menu's body, and the copies. */
function repoMenu(s: CanopyState, repo: Repo, where: "card" | "tab" | "head" | "body"): Built {
  const id = repo.id;
  const fav = isFavorite(s, id);
  const front = s.front?.kind === "project" && s.front.repoId === id;
  const docked = s.settings.openIn === "dock" || s.settings.openIn === "tabs";
  const quick: CtxQuick[] = [];
  if (where === "card") quick.push({ id: "q:open", label: "Open its panel", icon: <Icon name="window" />, run: () => s.openRepo(id) });
  if (!repo.forge && docked) {
    quick.push(
      front
        ? { id: "q:front", label: "Put the project back", icon: <Icon name="front" />, on: true, run: () => s.bringProject(null) }
        : { id: "q:front", label: "Bring the project to the front", icon: <Icon name="front" />, run: () => s.bringOnDouble(id) },
    );
  }
  if (!repo.forge) quick.push({ id: "q:shell", label: "A new shell here", icon: <Icon name="terminal" />, run: () => s.openTerm(id) });
  quick.push(
    { id: "q:star", label: fav ? "Take the star off" : "Star it", icon: <span className="ctx-star">{fav ? "★" : "☆"}</span>, on: fav, run: () => s.favoriteRepo(id, !fav).then(() => (fav ? "unstarred" : "starred")) },
    { id: "q:copy", label: "Copy its path", icon: <Icon name="copy" />, run: () => copyNamed("path", repo.path) },
  );

  const blocks: CtxBlock[] = [];
  if (where !== "card") {
    const panel: CtxItem[] = [];
    if (where !== "head" && where !== "body") panel.push({ kind: "run", id: "p:show", label: "show it", run: () => s.showPanel(id) });
    if (!repo.forge && docked) {
      panel.push(front ? { kind: "run", id: "p:back", label: "put the project back", keys: "Esc", run: () => s.bringProject(null) } : { kind: "run", id: "p:front", label: "bring the project to the front", keys: "double-click", run: () => s.bringOnDouble(id) });
    }
    panel.push(
      { kind: "run", id: "p:pop", label: "pop out into a window", run: () => s.popOut(id) },
      { kind: "run", id: "p:fold", label: "fold every section", run: () => s.foldSections(id, true) },
      { kind: "run", id: "p:unfold", label: "unfold every section", run: () => s.foldSections(id, false) },
      { kind: "run", id: "p:close", label: "close the panel", tone: "rust", run: () => s.closePanel(id) },
    );
    blocks.push({ kind: "items", key: "panel", label: "panel", items: panel });
  }
  // the panel's body has its gear for settings; its head and tab, the card
  // and the tree row have the repo's actions
  if (where !== "body") blocks.push({ kind: "node", key: "repo", node: (done) => <RepoMenuItems repo={repo} onDone={done} onError={(m) => say(m, true)} /> });

  const copies: CtxItem[] = [
    copyRow("copy:path", "path", repo.path),
    copyRow("copy:name", "name", repo.name),
    ...partRows(`repo:${id}`),
    ...(repo.link ? [copyRow("copy:remote", "remote", repo.link)] : []),
    ...(repo.forge && !repo.forge.empty ? [copyRow("copy:clone", "clone url", repo.forge.clone)] : []),
  ];
  const more: CtxItem[] = [{ kind: "sub", id: "copy", label: "copy", sub: copies }];
  if (pickable(repo)) {
    const picked = s.selecting && s.selected.includes(id);
    more.push({
      kind: "run",
      id: "pick",
      label: picked ? "unpick it" : "pick it for a fleet",
      keys: "x",
      title: "Select mode: pick repos, then run one workflow on every one of them",
      run: () => {
        if (!s.selecting) s.setSelecting(true);
        s.toggleSelected(id);
      },
    });
  }
  blocks.push({ kind: "items", key: "more", items: more });
  return { label: `Menu for ${repo.name}`, head: repoHead(s, repo), quick, blocks };
}

/** A section of a repo panel: its fold and its gear (zoom, layout, share),
 *  which the caller adds. */
function sectionMenu(s: CanopyState, key: string, repoId: string): Built | null {
  const repo = s.repos.find((r) => r.id === repoId);
  if (!repo) return null;
  const word = (SECTION_KEYS as readonly string[]).includes(key) ? SECTION_WORD[key as SectionKey] : key;
  const closed = closedIn(s, repoId, key);
  const items: CtxItem[] = [
    { kind: "run", id: "s:fold", label: closed ? `unfold ${word}` : `fold ${word}`, run: () => s.toggleSection(repoId, key) },
    { kind: "run", id: "s:all", label: "fold every section", run: () => s.foldSections(repoId, true) },
  ];
  return {
    label: `Menu for ${word} at ${repo.name}`,
    head: { glyph: "§", state: `s-${stateOf(repo)}`, title: word, facts: [{ text: repo.name }] },
    blocks: [{ kind: "items", key: "section", items }],
  };
}

/** A row of what waits on you: open it, its repo, and its copies. Nothing
 *  here answers it: an approval stays in its form, where it is read. */
function inboxMenu(s: CanopyState, key: string, target: Element): Built | null {
  const item = inboxItems(s).find((i) => i.key === key);
  if (!item) return null;
  const row = target.closest(".inbox-item");
  const items: CtxItem[] = [
    {
      kind: "run",
      id: "i:open",
      label: row?.classList.contains("open") ? "fold it" : "open it",
      keys: "Enter",
      run: () => row?.querySelector<HTMLElement>(".inbox-head")?.click(),
    },
  ];
  if (item.repoId) items.push({ kind: "run", id: "i:repo", label: `open ${item.repo}`, run: () => s.openRepo(item.repoId ?? "") });
  const copies: CtxItem[] = [copyRow("copy:title", "the line", item.title), ...(item.detail ? [copyRow("copy:detail", "what it runs", item.detail)] : []), ...partRows(`inbox:${key}`)];
  items.push({ kind: "sub", id: "copy", label: "copy", sub: copies });
  return {
    label: `Menu for ${item.title}`,
    head: { glyph: KIND_GLYPH[item.kind], title: item.who, facts: [{ text: item.title }, ...(item.repo ? [{ text: item.repo }] : [])] },
    blocks: [{ kind: "items", key: "inbox", items }],
  };
}

const ACT_WORD = { stop: "stop", resume: "resume", retry: "start again", dismiss: "dismiss" } as const;

/** A trigger's event: its run, what can be done to it now, where it came
 *  from, and its copies. */
function triggerMenu(s: CanopyState, id: string): Built | null {
  const found = triggerEventOf(id);
  const e = found?.event;
  if (!e) return null;
  const items: CtxItem[] = [];
  if (e.runId) items.push({ kind: "run", id: "t:run", label: "open the run", keys: "Space", run: () => s.showRun(e.runId ?? "") });
  for (const a of eventActs(e)) {
    items.push({
      kind: "run",
      id: `t:${a}`,
      label: ACT_WORD[a],
      ...(a === "stop" ? { tone: "rust" as const } : {}),
      run: () => (a === "dismiss" ? s.dismissTrigger(e.id) : s.triggerAct(e.id, a)).then(() => (a === "dismiss" ? "dismissed" : `${ACT_WORD[a]}: ${e.title}`)),
    });
  }
  if (e.pr) items.push({ kind: "link", id: "t:pr", label: `pull request #${e.pr.number}`, href: e.pr.url });
  if (e.link) items.push({ kind: "link", id: "t:link", label: `the issue in ${e.service}`, href: e.link });
  items.push({ kind: "sub", id: "copy", label: "copy", sub: [copyRow("copy:title", "title", e.title), copyRow("copy:id", "id", e.short ?? e.key), ...partRows(`trigger:${id}`)] });
  return {
    label: `Menu for ${e.title}`,
    head: { title: e.title, facts: [{ text: statusWord(e) }, { text: e.short ?? e.key, mono: true }] },
    blocks: [{ kind: "items", key: "trigger", items }],
  };
}

/** An agent's card on the board: focus it, take it into the dock, its run,
 *  and its copies. */
function agentMenu(s: CanopyState, id: string, target: Element): Built | null {
  const run = id.startsWith(RUN_CARD) ? s.runs[id.slice(RUN_CARD.length)] : undefined;
  const card = s.registry[id];
  if (!card && !run) return null;
  const name = card ? agentName(card) : (run?.verb ?? "run");
  const tile = target.closest("[data-card]");
  const items: CtxItem[] = [
    { kind: "run", id: "a:focus", label: "focus it", run: () => tile?.querySelector<HTMLElement>(".bt-name")?.click() },
    {
      kind: "run",
      id: "a:dock",
      label: "a card in the dock",
      title: "Out of the board into a panel of its own, on the git view",
      run: () => {
        s.dockItem({ kind: "agent", ref: id, label: name });
        openView("git");
      },
    },
  ];
  if (run) items.push({ kind: "run", id: "a:run", label: "open the run", run: () => s.showRun(run.id) });
  const repoId = run?.repoId;
  if (repoId) items.push({ kind: "run", id: "a:repo", label: `open ${s.repos.find((r) => r.id === repoId)?.name ?? idText(repoId)}`, run: () => s.openRepo(repoId) });
  const branch = card?.branch ?? run?.branch?.name;
  items.push({ kind: "sub", id: "copy", label: "copy", sub: [...(card?.cwd ? [copyRow("copy:cwd", "folder", card.cwd)] : []), copyRow("copy:branch", "branch", branch), copyRow("copy:id", "id", run?.id ?? id)] });
  const facts: CtxHead["facts"] = [];
  if (card?.state) facts.push({ text: card.state });
  if (branch) facts.push({ text: branch, mono: true });
  if (card) facts.push({ text: machineOf(card) });
  return { label: `Menu for ${name}`, head: { title: name, facts }, blocks: [{ kind: "items", key: "agent", items }] };
}

/** Rows for selected text: copy it, and put it somewhere useful. */
function selectionRows(s: CanopyState, text: string, repoId: string | null): CtxItem[] {
  const short = factLabel(text, 24);
  const rows: CtxItem[] = [
    { kind: "run", id: "sel:copy", label: "copy", fact: `${text.length} characters`, keys: "⌘C", run: () => copyNamed("selection", text) },
    { kind: "run", id: "sel:note", label: "keep it as a note", title: `A quick note: ${short}`, run: () => s.addQuickNote({ text, ...(repoId ? { repo: repoId } : {}) }).then(() => "noted") },
  ];
  const shell = lastShell();
  if (shell) rows.push({ kind: "run", id: "sel:shell", label: `paste into ${shell.name}`, title: "Into the shell the keyboard was last in; Enter is left to you", run: () => (typeInto(shell.id, text) ? `pasted into ${shell.name}` : "that shell is gone") });
  const repo = repoId ? s.repos.find((r) => r.id === repoId) : undefined;
  if (repo && !repo.forge) {
    rows.push(
      { kind: "run", id: "sel:find", label: `find it in ${repo.name}'s files`, run: () => s.searchIn(repo.id, text) },
      {
        kind: "run",
        id: "sel:agent",
        label: `send it to the agent at ${repo.name}`,
        title: "To its running chat, else pasted into its agent shell, else a new chat that starts with it",
        run: () => s.sendToAgent(repo.id, text).then((how) => (how === "said" ? "said to the run" : how === "pasted" ? "pasted into the agent's shell" : "a chat started with it")),
      },
    );
  }
  return rows;
}

/** The page's own row, where a right-click is on nothing with a menu. */
function pageBlock(s: CanopyState): CtxBlock {
  const view = viewNow();
  const items: CtxItem[] = [
    { kind: "sub", id: "go", label: "go to", sub: GO.map((g) => ({ kind: "run", id: `go:${g.view}`, label: g.what, keys: `g ${g.key}`, ...(g.view === view ? { off: "here" } : {}), run: () => openView(g.view) })) },
    { kind: "run", id: "page:cli", label: "the command line", keys: ":", run: () => s.setCliOpen(true) },
    { kind: "run", id: "page:find", label: "search every repo's files", keys: "⌘⇧F", run: () => s.openSearch() },
    { kind: "run", id: "page:waiting", label: "what is waiting on you", keys: "w", run: () => s.openPanel(WAITING_PANEL) },
    { kind: "run", id: "page:clips", label: "the clipboard", keys: "v", run: () => s.openClips() },
    { kind: "run", id: "page:notes", label: "notes and reminders", run: () => s.openQuickNotes() },
    { kind: "run", id: "page:keys", label: "keyboard shortcuts", keys: "?", run: () => s.openKeys(view) },
    { kind: "run", id: "page:reload", label: "reload the page", run: () => location.reload() },
  ];
  return { kind: "items", key: "page", label: "canopy", items };
}
