/** Workflow files from the three places they live, bundled first, the
 *  user's second, the repo's own last, later ones replacing earlier ones
 *  with the same name. Bun-only: the parser is in workflow.ts. */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { configDir } from "./store";
import { parseWorkflow } from "./workflow";
import type { Repo, Workflow, WorkflowEntry, WorkflowSource } from "./types";

export const BUNDLED_DIR = join(import.meta.dir, "../../lib/workflows");

/** Bundled files in the order the menu shows them. */
const BUNDLED_ORDER = ["commit", "push", "ship", "deploy", "review", "clarify"];

async function readDir(dir: string, source: WorkflowSource): Promise<WorkflowEntry[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }
  if (source === "bundled") {
    names.sort((a, b) => BUNDLED_ORDER.indexOf(basename(a, ".md")) - BUNDLED_ORDER.indexOf(basename(b, ".md")));
  }
  const out: WorkflowEntry[] = [];
  for (const n of names) {
    const file = join(dir, n);
    const meta = { name: basename(n, ".md"), source, file };
    try {
      out.push(parseWorkflow(await readFile(file, "utf8"), meta));
    } catch (err) {
      out.push({ ok: false, ...meta, error: String(err instanceof Error ? err.message : err) });
    }
  }
  return out;
}

const entryName = (e: WorkflowEntry): string => (e.ok ? e.workflow.name : e.name);

export async function loadWorkflows(repo: Pick<Repo, "path" | "host">): Promise<WorkflowEntry[]> {
  const lists = [
    await readDir(BUNDLED_DIR, "bundled"),
    await readDir(join(configDir(), "workflows"), "user"),
    repo.host ? [] : await readDir(join(repo.path, ".canopy", "workflows"), "repo"),
  ];
  // Insertion order is the menu order; an override replaces in place.
  const merged = new Map<string, WorkflowEntry>();
  for (const list of lists) for (const e of list) merged.set(entryName(e), e);
  return [...merged.values()];
}

export function findWorkflow(entries: WorkflowEntry[], name: string): Workflow | undefined {
  const e = entries.find((x) => entryName(x) === name);
  return e?.ok ? e.workflow : undefined;
}
