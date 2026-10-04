/** The shared repo spec (`spec/` at canopy's root): one SPEC.md standard and
 *  one DESIGN.md for every repo, and what canopy writes into a repo to adopt
 *  it. The spec owns two kinds of content there: marker blocks
 *  (`<!-- spec:begin vX.Y.Z -->…<!-- spec:end -->`) in SPEC.md, AGENTS.md and
 *  CLAUDE.md, and DESIGN.md whole when the repo takes the visual half.
 *  `.canopy/spec.json` records the version and a sha256 of each, so a hand
 *  edit reads as drift and an older version as behind. The planning is pure;
 *  the fs half at the bottom reads and writes a local checkout. */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SpecHalf, SpecState } from "./types";

export const SPEC_DIR = join(import.meta.dir, "../../spec");
export const RECORD = ".canopy/spec.json";
const DESIGN = "DESIGN.md";
const POINTERS = ["AGENTS.md", "CLAUDE.md"];

export interface Spec {
  version: string;
  /** file in the repo → the block's body, `{{version}}` filled in */
  blocks: Record<string, string>;
  design: string;
  template: string;
}

export interface SpecRecord {
  version: string;
  halves: SpecHalf[];
  /** file in the repo → sha256 of what the spec owns in it */
  blocks: Record<string, string>;
}

interface Manifest {
  version: string;
  design: string;
  template: string;
  blocks: Record<string, string>;
}

export async function loadSpec(dir: string = SPEC_DIR): Promise<Spec> {
  const read = (rel: string) => readFile(join(dir, rel), "utf8");
  const m = JSON.parse(await read("manifest.json")) as Manifest;
  const fill = (s: string) => s.replaceAll("{{version}}", m.version);
  const blocks: Record<string, string> = {};
  for (const [file, rel] of Object.entries(m.blocks)) blocks[file] = fill(await read(rel)).trimEnd();
  return { version: m.version, blocks, design: await read(m.design), template: await read(m.template) };
}

let bundled: Promise<Spec> | null = null;
/** canopy's own spec, read once per process: the scan asks for every repo. */
const bundledSpec = (): Promise<Spec> => (bundled ??= loadSpec());

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const BLOCK = /<!-- spec:begin v[^\s>]+ -->\n[\s\S]*?\n<!-- spec:end -->/;

export function renderBlock(spec: Spec, file: string): string {
  return `<!-- spec:begin v${spec.version} -->\n${spec.blocks[file] ?? ""}\n<!-- spec:end -->`;
}

/** The marker block in a file's text, or null when it has none. */
export function findBlock(text: string): string | null {
  return BLOCK.exec(text)?.[0] ?? null;
}

/** The text with its block replaced, or the block appended when it has none. */
export function upsertBlock(text: string, block: string): string {
  if (BLOCK.test(text)) return text.replace(BLOCK, () => block);
  const body = text.trimEnd();
  return body ? `${body}\n\n${block}\n` : `${block}\n`;
}

/** What the spec owns in a file: DESIGN.md whole, otherwise its block. */
export function ownedText(file: string, text: string | null): string | null {
  if (text === null) return null;
  return file === DESIGN ? text : findBlock(text);
}

/** The files a sync touches. The pointer goes into AGENTS.md and CLAUDE.md
 *  where they exist, and into a new AGENTS.md when neither does. */
export function managedFiles(halves: readonly SpecHalf[], exists: (file: string) => boolean): string[] {
  const out: string[] = [];
  if (halves.includes("doc")) {
    out.push("SPEC.md");
    const pointers = POINTERS.filter(exists);
    out.push(...(pointers.length ? pointers : ["AGENTS.md"]));
  }
  if (halves.includes("visual")) out.push(DESIGN);
  return out;
}

export function parseRecord(text: string | null): SpecRecord | null {
  if (text === null) return null;
  try {
    const r = JSON.parse(text) as Partial<SpecRecord>;
    if (typeof r.version !== "string" || !Array.isArray(r.halves) || typeof r.blocks !== "object" || r.blocks === null) return null;
    return { version: r.version, halves: r.halves, blocks: r.blocks };
  } catch {
    return null;
  }
}

/** The bytes a sync writes, and the record it leaves. `current` holds each
 *  file's text, null when it is missing. A new SPEC.md starts from the
 *  template; its sections are the repo's to fill. */
export function planSync(
  spec: Spec,
  current: Record<string, string | null>,
  halves: readonly SpecHalf[],
  name: string,
): { writes: Record<string, string>; record: SpecRecord } {
  const writes: Record<string, string> = {};
  const blocks: Record<string, string> = {};
  for (const file of managedFiles(halves, (f) => current[f] != null)) {
    let next: string;
    if (file === DESIGN) {
      next = spec.design;
    } else {
      const block = renderBlock(spec, file);
      const had = current[file] ?? null;
      next = had === null && file === "SPEC.md"
        ? spec.template.replaceAll("{{name}}", name).replace("{{block}}", () => block)
        : upsertBlock(had ?? "", block);
    }
    if (next !== current[file]) writes[file] = next;
    blocks[file] = sha256(ownedText(file, next) ?? "");
  }
  return { writes, record: { version: spec.version, halves: [...halves], blocks } };
}

/** Where a repo stands against the spec. Drift wins over behind: a hand
 *  edit is what a sync would overwrite, so it is the thing to look at. */
export function specState(spec: Spec, record: SpecRecord | null, current: Record<string, string | null>): SpecState {
  if (record === null) return "not-adopted";
  for (const [file, hash] of Object.entries(record.blocks)) {
    const owned = ownedText(file, current[file] ?? null);
    if (owned === null || sha256(owned) !== hash) return "drifted";
  }
  return record.version === spec.version ? "in-sync" : "behind";
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readFiles(repo: string, files: Iterable<string>): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const f of files) out[f] = await readText(join(repo, f));
  return out;
}

/** A local checkout's state, or undefined when it cannot be read. */
export async function repoSpecState(repo: string, spec?: Spec): Promise<SpecState | undefined> {
  try {
    const record = parseRecord(await readText(join(repo, RECORD)));
    if (record === null) return "not-adopted";
    return specState(spec ?? (await bundledSpec()), record, await readFiles(repo, Object.keys(record.blocks)));
  } catch {
    return undefined;
  }
}

/** Write the spec into a local checkout. Halves default to the repo's
 *  recorded ones, then to the doc half alone: the visual half is opt-in. */
export async function syncRepo(
  repo: string,
  opts: { halves?: SpecHalf[]; spec?: Spec } = {},
): Promise<{ written: string[]; record: SpecRecord }> {
  const spec = opts.spec ?? (await loadSpec());
  const old = parseRecord(await readText(join(repo, RECORD)));
  const halves = opts.halves ?? old?.halves ?? ["doc"];
  const current = await readFiles(repo, ["SPEC.md", ...POINTERS, DESIGN]);
  const { writes, record } = planSync(spec, current, halves, basename(repo));
  for (const [file, text] of Object.entries(writes)) await writeFile(join(repo, file), text);
  await mkdir(dirname(join(repo, RECORD)), { recursive: true });
  await writeFile(join(repo, RECORD), `${JSON.stringify(record, null, 2)}\n`);
  return { written: Object.keys(writes), record };
}
