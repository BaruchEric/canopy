/**
 * Carries out a command line's command (cli.ts parses it) with the page's
 * own store and API, never by spawning the CLI on the backend: the answer
 * is the CLI's output as toned lines, with every repo it names a link.
 * Commands with a place of their own in the page (open, launch, library,
 * new) take the user there instead.
 */

import { api } from "./api";
import { backendOf } from "./registry";
import { helperFor, useStore } from "./store";
import { CLI_PANEL, ENTRIES, findRepo, parseCommand, quoteWord, tokenize, underDir, type Command } from "./cli";
import { SPEC_TONE, SPEC_WORDS, specLines, treeLines, type Line, type Seg, type Tone } from "../../src/core/treelines";
import { versionLine } from "../../src/core/version";
import type { Repo } from "../../src/core/types";

export interface Outcome {
  ok: boolean;
  lines: Line[];
  /** the command took the user somewhere; the prompt closes and the
   *  transcript panel stays as it was */
  went?: true;
}

/** what the runner needs from the page that the store does not hold */
interface RunEnv {
  navigate: (view: string) => void;
}

/** the App's view switch; until it binds, a command stays on this view */
const env: RunEnv = { navigate: () => {} };

/** the App hands over its view switch once it mounts */
export function bindNavigate(navigate: (view: string) => void): void {
  env.navigate = navigate;
}

const say = (text: string, tone?: Tone): Line => [tone ? { text, tone } : { text }];
const ok = (...lines: Line[]): Outcome => ({ ok: true, lines });
const fail = (text: string, usage?: string): Outcome => ({
  ok: false,
  lines: [say(text, "rust"), ...(usage ? [say(`usage: ${usage}`, "dim")] : [])],
});
const went = (text: string): Outcome => ({ ok: true, lines: [say(text, "dim")], went: true });

/** a mark, then words: `✓ pushed`, the CLI's way */
const mark = (glyph: string, tone: Tone, ...rest: Seg[]): Line => [{ text: glyph, tone }, { text: " " }, ...rest];
const link = (r: Repo): Seg => ({ text: r.id, repo: r.id });

/** git's or the server's own words, one dim line each */
const echo = (out: string): Line[] =>
  out
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "")
    .map((l) => say(l, "dim"));

const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);

class Refused extends Error {}

/** the repo a word names; `loose` lets a unique prefix name it, for a
 *  command that only reads or only goes somewhere */
function repoFor(word: string, loose = false): Repo {
  const st = useStore.getState();
  const got = findRepo(word, st.repos, { prefix: loose });
  if ("error" in got) throw new Refused(got.error);
  if (got.repo.forge) throw new Refused(`${got.repo.id} is only on the forge: clone it first`);
  return got.repo;
}

const helperOn = (r: Repo): string | undefined => helperFor(useStore.getState(), backendOf(r.id));

function helpLines(verb: string | null): Outcome {
  const entries = verb === null ? ENTRIES : ENTRIES.filter((e) => e.verb === verb);
  if (entries.length === 0) return fail(`no command called ${verb}`, "canopy help");
  const w = Math.min(44, Math.max(...entries.map((e) => e.usage.length)));
  return ok(
    ...entries.flatMap((e) => [
      [{ text: e.usage.padEnd(w), tone: "bold" }, { text: "  " }, { text: e.about, tone: "dim" }] satisfies Line,
      ...e.more.map((m) => say(`${" ".repeat(4)}${m}`, "dim")),
    ]),
  );
}

async function runInner(cmd: Command): Promise<Outcome> {
  const st = useStore.getState();
  switch (cmd.kind) {
    case "tree": {
      const repos = underDir(cmd.dir, st.repos);
      if (cmd.dir !== null && repos.length === 0) return fail(`no repos under ${cmd.dir}`);
      return ok(...treeLines(cmd.dir ?? (st.root || "."), repos, { dirtyOnly: cmd.dirtyOnly }));
    }
    case "clear":
      st.cliClear();
      return { ok: true, lines: [] };
    case "help":
      return helpLines(cmd.verb);
    case "commit": {
      const r = repoFor(cmd.repo);
      const lines: Line[] = [];
      let message = cmd.message;
      if (message === null) {
        const s = await api.suggest(r.id);
        message = s.message;
        lines.push(mark("✎", "sky", { text: message }, { text: ` (${s.source})`, tone: "dim" }));
      }
      const c = await api.commit(r.id, message, cmd.all);
      lines.push(...echo(c.out), mark("✓", "moss", { text: "committed " }, link(r)));
      if (cmd.push) {
        const p = await api.push(r.id);
        lines.push(...echo(p.out), mark("✓", "moss", { text: "pushed " }, link(r)));
      }
      return ok(...lines);
    }
    case "suggest": {
      const r = repoFor(cmd.repo, true);
      const s = await api.suggest(r.id);
      return ok(...s.message.split("\n").map((l) => say(l)), say(`(${s.source})`, "dim"));
    }
    case "push":
    case "pull": {
      const r = repoFor(cmd.repo);
      const res = cmd.kind === "push" ? await api.push(r.id) : await api.pull(r.id);
      return ok(...echo(res.out), mark("✓", "moss", { text: `${cmd.kind === "push" ? "pushed" : "pulled"} ` }, link(r)));
    }
    case "open": {
      const r = repoFor(cmd.repo, true);
      if (cmd.app === null) {
        toGit();
        st.openPanel(r.id);
        return went(`opened ${r.id}`);
      }
      await api.open(r.id, cmd.app, false, helperOn(r));
      return ok(mark("✓", "moss", { text: `opened ` }, link(r), { text: ` in ${cmd.app}`, tone: "dim" }));
    }
    case "launch": {
      const r = repoFor(cmd.repo, true);
      // installing, building and removing are the launch section's: it
      // shows each one's progress as it goes
      if (cmd.more.length > 0) {
        toGit();
        st.showLaunch(r.id);
        return went(`the launch section of ${r.id} is open: finish there`);
      }
      const [builds, releases, pulls] = await Promise.all([
        api.builds(r.id),
        api.releases(r.id).catch((e: unknown) => errText(e)),
        api.pulls(r.id).catch((e: unknown) => errText(e)),
      ]);
      const lines: Line[] = [say("builds here", "bold")];
      if (builds.length === 0) lines.push(say("  none: launch <repo> <tag>, --pr N, or --here", "dim"));
      for (const b of builds) {
        lines.push([{ text: "  " }, { text: "▸", tone: "lichen" }, { text: " " }, { text: b.label, tone: "bold" }, { text: ` ${b.what ?? "nothing launchable"} · ${b.launches}× launched`, tone: "dim" }]);
      }
      lines.push(say("releases", "bold"));
      if (typeof releases === "string") lines.push(say(`  ${releases}`, "dim"));
      else if (releases.length === 0) lines.push(say("  none", "dim"));
      else for (const rel of releases.slice(0, 5)) lines.push([{ text: "  " }, { text: "▸", tone: "lichen" }, { text: " " }, { text: rel.tag, tone: "bold" }, { text: `${rel.prerelease ? " pre" : ""} ${rel.pick ?? "no asset for this machine"}`, tone: "dim" }]);
      lines.push(say("open pull requests", "bold"));
      if (typeof pulls === "string") lines.push(say(`  ${pulls}`, "dim"));
      else if (pulls.length === 0) lines.push(say("  none", "dim"));
      else for (const p of pulls.slice(0, 10)) lines.push([{ text: "  " }, { text: "▸", tone: "lichen" }, { text: " " }, { text: `#${p.number}`, tone: "bold" }, { text: ` ${p.title} ` }, { text: p.author, tone: "dim" }]);
      return ok(...lines);
    }
    case "ws-list": {
      if (st.workspaces.length === 0) return ok(say("no workspaces yet: ws create <name> <repos...>", "dim"));
      return ok(
        ...st.workspaces.flatMap((w) => [
          [{ text: w.name, tone: "bold" }, { text: ` (${w.repos.length})`, tone: "dim" }] satisfies Line,
          ...w.repos.map((path): Line => {
            const r = st.repos.find((x) => x.path === path);
            return [{ text: "  " }, { text: "▸", tone: "lichen" }, { text: " " }, r ? link(r) : { text: path, tone: "dim" }];
          }),
        ]),
      );
    }
    case "ws-add": {
      // the API takes repo ids and stores their paths
      const ids = cmd.repos.map((w) => repoFor(w).id);
      st.setWorkspaces(await api.wsAdd(cmd.name, ids));
      return ok(mark("✓", "moss", { text: "workspace " }, { text: cmd.name, tone: "bold" }, { text: " updated" }));
    }
    case "ws-rm": {
      const id = cmd.repo === null ? undefined : repoFor(cmd.repo).id;
      st.setWorkspaces(await api.wsRemove(cmd.name, id));
      return ok(mark("✓", "moss", { text: "removed" }));
    }
    case "ws-open": {
      if (!st.workspaces.some((w) => w.name === cmd.name)) return fail(`no workspace called ${cmd.name}`);
      await api.wsOpen(cmd.name, cmd.app, helperFor(st));
      return ok(mark("✓", "moss", { text: "opened " }, { text: cmd.name, tone: "bold" }, { text: ` in ${cmd.app}`, tone: "dim" }));
    }
    case "source-list": {
      const extra = st.sources.filter((s) => !s.launch);
      if (extra.length === 0) return ok(say("no extra folders: source add <dir> [--host h]", "dim"));
      return ok(
        ...extra.map((s): Line => {
          const at = s.kind === "forgejo" ? s.url : s.kind === "ssh" ? `${s.host}:${s.path}` : s.path;
          return [{ text: s.label, tone: "bold" }, { text: ` (${s.id})`, tone: "dim" }, { text: `  ${at}` }, ...(s.error ? [{ text: `  ${s.error}`, tone: "rust" } satisfies Seg] : [])];
        }),
      );
    }
    case "source-add": {
      const label = cmd.label === null ? {} : { label: cmd.label };
      await api.addSource(cmd.host === null ? { kind: "local", path: cmd.dir, ...label } : { kind: "ssh", host: cmd.host, path: cmd.dir, ...label });
      await st.rescan();
      return ok(mark("✓", "moss", { text: "scanning " }, { text: cmd.dir, tone: "bold" }));
    }
    case "source-forgejo": {
      await api.addSource({ kind: "forgejo", url: cmd.url, ...(cmd.label === null ? {} : { label: cmd.label }) });
      await st.rescan();
      return ok(mark("✓", "moss", { text: "listing " }, { text: cmd.url, tone: "bold" }));
    }
    case "source-rm": {
      await api.removeSource(cmd.id);
      await st.rescan();
      return ok(mark("✓", "moss", { text: `removed ${cmd.id}` }));
    }
    case "peers-status": {
      const p = await api.peers();
      const seen = new Map(p.seen.map((s) => [s.name, s]));
      return ok(
        [{ text: "self: " }, { text: p.self ?? "(unnamed)", tone: "bold" }, { text: "  sync: " }, { text: p.sync, tone: p.sync === "on" ? "moss" : p.sync === "off" ? "dim" : "lichen" }],
        ...p.peers.map((peer): Line => {
          const s = seen.get(peer.name);
          return [
            { text: "  " },
            s === undefined ? { text: "·", tone: "dim" } : s.ok ? { text: "●", tone: "moss" } : { text: "●", tone: "rust" },
            { text: ` ${peer.name}`, tone: "bold" },
            { text: `  ${peer.role}  ${peer.alias ?? "?"}:${peer.root}${peer.repos ? `  (${peer.repos.join(", ")})` : ""}`, tone: "dim" },
            ...(s && !s.ok && s.error ? [{ text: `  ${s.error}`, tone: "rust" } satisfies Seg] : []),
          ];
        }),
      );
    }
    case "peers-sync": {
      if (cmd.repo === null) {
        // the server takes the request either way; with sync off it does nothing
        const p = await api.peers();
        if (p.sync === "off" || p.self === null) return fail("peer sync is off on this backend: peers status says why");
        await api.peersSync();
        return ok(mark("▶", "sky", { text: "peer pass started: repos it moves update as it goes" }));
      }
      const r = repoFor(cmd.repo);
      await st.syncPeers(r.id);
      return ok(...peerLines(useStore.getState().repos.find((x) => x.id === r.id) ?? r));
    }
    case "peers-take": {
      const r = repoFor(cmd.repo);
      const got = await api.peerAction(r.id, { action: "take", peer: cmd.peer, ...(cmd.branch === null ? {} : { branch: cmd.branch }) });
      const { take, ...repo } = got;
      st.applyEvent({ type: "repo", repo });
      return ok(mark("✓", "moss", { text: take?.how === "files" ? "WIP checked out as uncommitted files" : `WIP is on branch ${take?.branch ?? "?"}` }));
    }
    case "peers-track": {
      const r = repoFor(cmd.repo);
      await st.trackBranch(r.id, cmd.peer, cmd.branch);
      return ok(mark("✓", "moss", { text: `${cmd.branch} now points at ${cmd.peer}/${cmd.branch}` }));
    }
    case "peers-seed": {
      const r = repoFor(cmd.repo);
      await st.seedRepo(r.id);
      return ok(mark("✓", "moss", { text: "seeded " }, link(r)));
    }
    case "spec-status": {
      const local = underDir(cmd.dir, st.repos).filter((r) => r.spec !== undefined);
      if (local.length === 0) return ok(say("no local checkout here reports a spec state", "dim"));
      return ok(...specLines(null, local));
    }
    case "spec-sync": {
      const r = repoFor(cmd.repo);
      const got = await api.specSync(r.id, cmd.halves);
      st.applyEvent({ type: "repo", repo: got.repo });
      const wrote = got.written.length ? `wrote ${got.written.join(", ")}` : "already in sync";
      return ok(mark("✓", "moss", { text: `spec v${got.version} (${got.halves.join(" + ")}): ${wrote} in ` }, link(r)));
    }
    case "spec-check": {
      if (cmd.repo === null) return fail("name the repo to check", "canopy spec check <repo>");
      const r = repoFor(cmd.repo, true);
      if (r.spec === undefined) return fail(`${r.id} has no spec state: it is not a local checkout`);
      return { ok: r.spec === "in-sync", lines: [[{ text: SPEC_WORDS[r.spec], tone: SPEC_TONE[r.spec] }, { text: "  " }, link(r)]] };
    }
    case "version": {
      const about = await api.about();
      return ok([{ text: "canopy ", tone: "bold" }, { text: versionLine(about) }, { text: `  on ${about.hostname}`, tone: "dim" }]);
    }
    case "view": {
      env.navigate(cmd.view);
      if (cmd.sprout) st.draftSprout(cmd.sprout);
      return went(cmd.sprout ? "the new project form is open" : `the ${cmd.view} is open`);
    }
    case "terminal":
      return { ok: false, lines: [say(cmd.why, "lichen")] };
  }
}

/** what the repo's peers have that it does not, as `peers sync <repo>` answers */
function peerLines(r: Repo): Line[] {
  const p = r.peers;
  if (p === undefined) return [say("not synced yet", "dim")];
  const lines: Line[] = [
    ...p.wip.map((w): Line => mark("◐", "sky", { text: `WIP on ${w.branch} at ${w.peer}` }, { text: `  peers take ${quoteWord(r.id)} ${w.peer}`, tone: "dim" })),
    ...p.diverged.map((d): Line => mark("◆", "rust", { text: `${d.branch} diverged from ${d.peer}` })),
    ...p.peerOnly.map((o): Line => mark("⑂", "sky", { text: `${o.peer}/${o.branch}` }, { text: `  peers track ${quoteWord(r.id)} ${o.peer} ${o.branch}`, tone: "dim" })),
  ];
  return lines.length ? lines : [mark("○", "moss", { text: "in step with every peer" })];
}

let nextId = 1;

/** Runs one parsed command into the transcript: the entry goes in as
 *  running, then takes what the command printed. A command that printed
 *  something opens the transcript panel; one that took the user elsewhere
 *  does not. */
export async function runLine(line: string): Promise<Outcome> {
  const cmd = parseCommand(tokenize(line).words);
  const st = useStore.getState();
  const id = nextId++;
  const at = Date.now();
  if (cmd.kind === "clear") {
    st.cliClear();
    return { ok: true, lines: [] };
  }
  st.cliPut({ id, line, at, status: "running", out: [] });
  // the answer shows as it comes, unless the command goes somewhere else
  if (!goesElsewhere(cmd)) showTranscript();
  let out: Outcome;
  if (cmd.kind === "error") out = fail(cmd.text, cmd.usage);
  else {
    try {
      out = await runInner(cmd);
    } catch (err) {
      out = fail(err instanceof Refused ? err.message : errText(err));
    }
  }
  useStore.getState().cliPut({ id, line, at, status: out.ok ? "ok" : "error", out: out.lines });
  if (!out.went) showTranscript();
  return out;
}

/** to the repos' view, without a history entry when the page is on it */
function toGit(): void {
  if (new URLSearchParams(location.search).get("view")) env.navigate("git");
}

/** the transcript lives in the dock, on the repos' view */
function showTranscript(): void {
  toGit();
  useStore.getState().openPanel(CLI_PANEL);
}

/** whether a command, once parsed, takes the user to a place of its own
 *  rather than printing an answer */
const goesElsewhere = (cmd: ReturnType<typeof parseCommand>): boolean =>
  (cmd.kind === "open" && cmd.app === null) || cmd.kind === "view" || (cmd.kind === "launch" && cmd.more.length > 0);
