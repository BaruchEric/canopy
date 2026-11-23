/** `canopy fr`: feature numbers for the repo the shell sits in (FR-076).
 *  `reserve` takes the next free number before a session writes it anywhere,
 *  `next` says what it would be, the bare command lists who holds what, and
 *  `check` fails on a list that gives one number to two entries. It runs git
 *  here and asks no backend: a reservation is a ref in the repo itself, so
 *  every worktree of the repo sees it at once, and origin carries it to the
 *  other machines. The names and the words are core/fr.ts. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "../core/exec";
import { FR_FILE, FR_REFS, frDuplicates, frEntries, frId, frLine, frMessage, frNext, frOfRef, frRef, parseFrMessage, type FrHolder, type FrReservation, type FrWhere } from "../core/fr";
import { has, take } from "./health";
import { ageWord } from "./worktrees";

export const FR_USAGE = [
  "usage: canopy fr [list] [--all] [--json] [-C dir]",
  "       canopy fr next [-C dir]",
  "       canopy fr reserve [-m title] [--json] [-C dir]",
  "       canopy fr check [-C dir]",
].join("\n");

export type FrArgs = { dir: string | null; json: boolean } & ({ act: "list"; all: boolean } | { act: "next" } | { act: "reserve"; title: string } | { act: "check" });

/** The command's words, without changing the caller's list. */
export function parseFrArgs(argv: string[]): FrArgs | string {
  const args = [...argv];
  const dir = take(args, "-C") ?? null;
  const title = take(args, "-m");
  const json = has(args, "--json");
  const all = has(args, "--all");
  const [word = "list", ...rest] = args;
  if (rest.length > 0 || word.startsWith("-")) return FR_USAGE;
  if (title !== undefined && word !== "reserve") return `-m goes with reserve\n\n${FR_USAGE}`;
  if (all && word !== "list") return `--all goes with list\n\n${FR_USAGE}`;
  switch (word) {
    case "list":
      return { dir, json, act: "list", all };
    case "next":
      return { dir, json, act: "next" };
    case "reserve":
      return { dir, json, act: "reserve", title: title ?? "" };
    case "check":
      return { dir, json, act: "check" };
    default:
      return FR_USAGE;
  }
}

/** What went wrong, in words for the person. */
export class FrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrError";
  }
}

/** how long a call to origin may take before canopy carries on without it */
const REMOTE_MS = 20_000;
/** how many numbers a reserve tries before it gives up: each miss means
 *  another session took that one first */
const TRIES = 25;
/** the most branches whose copy of the list is read */
const BRANCHES_MAX = 300;
const REMOTE = "origin";

/** git in a folder, never asking at a terminal */
const git = (cwd: string, args: string[], timeoutMs = 15_000) => exec(["git", ...args], { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });

/** The repo's root for a folder, or a refusal. */
export async function frRoot(dir: string): Promise<string> {
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) throw new FrError(`${dir} is not in a git repository`);
  return r.stdout.trim();
}

const hasRemote = async (root: string): Promise<boolean> => (await git(root, ["remote", "get-url", REMOTE])).code === 0;

/** Brings origin's branches and reservations here. False when origin did
 *  not answer, which leaves what was fetched before. A reservation made
 *  here that origin holds differently is left alone: git refuses to replace
 *  it, and the rest still arrive. */
async function fetchRemote(root: string): Promise<boolean> {
  // the repo's own refspecs, so a clone of one branch stays one, then the reservations
  const own = (await git(root, ["config", "--get-all", `remote.${REMOTE}.fetch`])).stdout.split("\n").filter(Boolean);
  const r = await git(root, ["fetch", "-q", REMOTE, ...(own.length ? own : [`+refs/heads/*:refs/remotes/${REMOTE}/*`]), `${FR_REFS}/*:${FR_REFS}/*`], REMOTE_MS);
  if (r.code === 0) return true;
  // a refused ref fails the fetch though origin answered: ask it one thing more
  return (await git(root, ["ls-remote", REMOTE, "HEAD"], REMOTE_MS)).code === 0;
}

/** The reservations in this repo's refs: number, commit, message and time. */
async function localReservations(root: string): Promise<{ n: number; sha: string; at: number; holder: FrHolder }[]> {
  // one record per ref, fields and records split by bytes no message holds
  const r = await git(root, ["for-each-ref", "--format=%(refname)%1f%(objectname)%1f%(committerdate:unix)%1f%(contents)%1e", FR_REFS]);
  if (r.code !== 0) return [];
  const out: { n: number; sha: string; at: number; holder: FrHolder }[] = [];
  for (const record of r.stdout.split("\x1e")) {
    const [ref = "", sha = "", when = "", message = ""] = record.replace(/^\n/, "").split("\x1f");
    const n = frOfRef(ref);
    if (n !== null && sha) out.push({ n, sha, at: Number(when) * 1000 || 0, holder: parseFrMessage(message) });
  }
  return out.sort((a, b) => a.n - b.n);
}

/** Every copy of the list this repo can see: the file in each worktree,
 *  written or not yet committed, and the one each branch holds, origin's
 *  branches included. */
async function listCopies(root: string): Promise<string[]> {
  const texts: string[] = [];
  const trees = await git(root, ["worktree", "list", "--porcelain"]);
  const paths = trees.code === 0 ? trees.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length)) : [root];
  for (const path of new Set([root, ...paths])) {
    const file = join(path, FR_FILE);
    try {
      if (existsSync(file)) texts.push(readFileSync(file, "utf8"));
    } catch {
      // a worktree whose folder is out of reach from here: its branch is read below
    }
  }
  const refs = await git(root, ["for-each-ref", "--format=%(refname)", "refs/heads", `refs/remotes/${REMOTE}`]);
  for (const ref of refs.stdout.split("\n").filter(Boolean).slice(0, BRANCHES_MAX)) {
    const r = await git(root, ["show", `${ref}:${FR_FILE}`]);
    if (r.code === 0) texts.push(r.stdout);
  }
  return texts;
}

/** The list as origin's default branch holds it, or as the local one does
 *  where there is no origin; empty when neither has one. */
async function landedList(root: string): Promise<string> {
  const head = await git(root, ["symbolic-ref", "-q", "--short", `refs/remotes/${REMOTE}/HEAD`]);
  for (const ref of [head.code === 0 ? head.stdout.trim() : "", `${REMOTE}/main`, `${REMOTE}/master`, "main", "master"]) {
    if (!ref) continue;
    const r = await git(root, ["show", `${ref}:${FR_FILE}`]);
    if (r.code === 0) return r.stdout;
  }
  return "";
}

/** The next free number as this repo sees it now, origin asked first. */
export async function frNextHere(root: string): Promise<number> {
  if (await hasRemote(root)) await fetchRemote(root);
  return frNext(await listCopies(root), (await localReservations(root)).map((r) => r.n));
}

/** Who a reservation made in this shell belongs to. */
export async function frHolderHere(root: string, title: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<FrHolder> {
  const session = env["CLAUDE_CODE_SESSION_ID"] ?? "";
  const thread = env["CODEX_THREAD_ID"] ?? env["CODEX_SESSION_ID"] ?? "";
  const by = env["TAILCHAN_AS"] || (session ? `claude-${session.slice(0, 6)}` : "") || (thread ? `codex-${thread.slice(0, 6)}` : "") || env["USER"] || "someone";
  const branch = (await git(root, ["branch", "--show-current"])).stdout.trim();
  return { title, by, branch, backend: env["CANOPY_BACKEND"] ?? "" };
}

/** A commit with no files that carries a reservation's words. git wants a
 *  name on a commit, so a machine with none set gets canopy's. */
async function emptyCommit(root: string, message: string): Promise<string> {
  const tree = await exec(["git", "mktree"], { cwd: root, input: "", timeoutMs: 15_000 });
  if (tree.code !== 0) throw new FrError(`git could not make an empty tree: ${tree.stderr.trim()}`);
  const named = (await git(root, ["config", "user.name"])).code === 0 && (await git(root, ["config", "user.email"])).code === 0;
  const who = named ? [] : ["-c", "user.name=canopy", "-c", "user.email=canopy@localhost"];
  const r = await exec(["git", ...who, "commit-tree", tree.stdout.trim()], { cwd: root, input: message, timeoutMs: 15_000 });
  if (r.code !== 0) throw new FrError(`git could not write the reservation: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export interface FrReserved {
  n: number;
  id: string;
  ref: string;
  /** origin holds it too; false means only this machine knows */
  shared: boolean;
  /** why it is not shared, when it is not */
  note: string | null;
}

/**
 * Takes the next free number for this repo and returns it. The ref is made
 * only when none is there, so a second session in this repo, in any of its
 * worktrees, gets the number after. Then the ref is pushed without force:
 * when another machine pushed the same number first, origin refuses, this
 * one is dropped and the next is tried. With no origin, or one that does
 * not answer, the reservation stands on this machine and says so.
 */
export async function frReserve(root: string, holder: FrHolder): Promise<FrReserved> {
  const remote = await hasRemote(root);
  for (let i = 0; i < TRIES; i++) {
    const online = remote && (await fetchRemote(root));
    if (online && i === 0) await shareWaiting(root);
    const n = frNext(await listCopies(root), (await localReservations(root)).map((r) => r.n));
    const ref = frRef(n);
    const sha = await emptyCommit(root, frMessage(n, holder, crypto.randomUUID()));
    // an empty old value: make the ref only when there is none
    const made = await git(root, ["update-ref", ref, sha, ""]);
    if (made.code !== 0) continue;
    const reserved = { n, id: frId(n), ref };
    if (!remote) return { ...reserved, shared: false, note: `this repo has no ${REMOTE}, so only this machine knows` };
    if (!online) return { ...reserved, shared: false, note: `${REMOTE} did not answer, so only this machine knows until canopy fr runs here again with it back` };
    const pushed = await git(root, ["push", "-q", REMOTE, `${ref}:${ref}`], REMOTE_MS);
    if (pushed.code === 0) return { ...reserved, shared: true, note: null };
    const theirs = await git(root, ["ls-remote", REMOTE, ref], REMOTE_MS);
    const held = theirs.code === 0 ? (theirs.stdout.trim().split(/\s+/)[0] ?? "") : "";
    if (theirs.code === 0 && held && held !== sha) {
      // another machine took it first: drop ours, the next fetch brings theirs
      await git(root, ["update-ref", "-d", ref, sha]);
      continue;
    }
    if (held === sha) return { ...reserved, shared: true, note: null };
    return { ...reserved, shared: false, note: `${REMOTE} would not take it (${pushed.stderr.trim().split("\n").pop() ?? "no reason given"}), so only this machine knows` };
  }
  throw new FrError(`no free number after ${TRIES} tries; canopy fr list shows who holds what`);
}

/** Shares the reservations made while origin was away. Best effort: one
 *  origin refuses stays as it is, and `list` says so. */
async function shareWaiting(root: string): Promise<void> {
  const remote = await git(root, ["ls-remote", REMOTE, `${FR_REFS}/*`], REMOTE_MS);
  if (remote.code !== 0) return;
  const there = new Set(remote.stdout.split("\n").map((l) => l.split(/\s+/)[1] ?? ""));
  const waiting = (await localReservations(root)).map((r) => frRef(r.n)).filter((ref) => !there.has(ref));
  if (waiting.length) await git(root, ["push", "-q", REMOTE, ...waiting.map((ref) => `${ref}:${ref}`)], REMOTE_MS);
}

/** The reservations this repo knows, lowest number first, each with
 *  whether origin holds it and whether the list already has its entry. */
export async function frList(root: string): Promise<FrReservation[]> {
  const remote = await hasRemote(root);
  if (remote && (await fetchRemote(root))) await shareWaiting(root);
  const there = new Map<string, string>();
  if (remote) {
    const r = await git(root, ["ls-remote", REMOTE, `${FR_REFS}/*`], REMOTE_MS);
    for (const line of r.code === 0 ? r.stdout.split("\n") : []) {
      const [sha = "", ref = ""] = line.split(/\s+/);
      if (ref) there.set(ref, sha);
    }
  }
  const listed = new Set(frEntries(await landedList(root)));
  const where = (n: number, sha: string): FrWhere => {
    const theirs = there.get(frRef(n));
    return theirs === sha ? "shared" : theirs ? "clash" : "here";
  };
  return (await localReservations(root)).map((r) => ({ n: r.n, id: frId(r.n), holder: r.holder, at: r.at, where: where(r.n, r.sha), listed: listed.has(r.n) }));
}

/** The numbers the list in this folder gives to two entries. */
export function frCheck(root: string): number[] {
  const file = join(root, FR_FILE);
  return existsSync(file) ? frDuplicates(readFileSync(file, "utf8")) : [];
}

export async function frCommand(argv: string[], { fail }: { fail: (message: string) => never }): Promise<void> {
  const parsed = parseFrArgs(argv);
  if (typeof parsed === "string") return fail(parsed);
  try {
    const root = await frRoot(parsed.dir ?? process.cwd());
    switch (parsed.act) {
      case "next":
        console.log(frId(await frNextHere(root)));
        return;
      case "reserve": {
        const got = await frReserve(root, await frHolderHere(root, parsed.title));
        if (parsed.json) console.log(JSON.stringify(got, null, 2));
        else {
          console.log(got.id);
          if (got.note) console.error(`canopy fr: ${got.note}`);
        }
        return;
      }
      case "check": {
        const twice = frCheck(root);
        if (twice.length) return fail(`${FR_FILE} gives one number to two entries: ${twice.map(frId).join(", ")}. Keep the entry that landed first and take a new number for the other with canopy fr reserve`);
        console.log(`${FR_FILE} gives every number once`);
        return;
      }
      case "list": {
        const all = await frList(root);
        const shown = parsed.all ? all : all.filter((r) => !r.listed);
        if (parsed.json) return console.log(JSON.stringify(shown, null, 2));
        const now = Date.now();
        const ago = (ms: number): string => `${ageWord(now - ms)} ago`.replace("now ago", "just now");
        for (const r of shown) console.log(frLine(r, ago));
        const hidden = all.length - shown.length;
        if (!shown.length) console.log(hidden ? "no number is reserved and waiting for its entry" : "no number is reserved here");
        if (hidden) console.log(`${hidden} more ${hidden === 1 ? "has its" : "have their"} entry in the list already (--all shows them)`);
        console.log(`next free: ${frId(frNext(await listCopies(root), all.map((r) => r.n)))}`);
        return;
      }
    }
  } catch (err) {
    if (err instanceof FrError) return fail(err.message);
    throw err;
  }
}
