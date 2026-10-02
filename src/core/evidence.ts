/** Reads a judge step's evidence out of a local repo. Each path is resolved
 *  through symlinks and refused when that lands outside the repo, and only
 *  the head of a big file is read, since the judge reads a clipped part
 *  anyway. Bun-only. */

import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { EvidenceFile } from "./types";
import { EVIDENCE_EACH } from "./verdict";

export async function readEvidence(repoPath: string, paths: string[]): Promise<EvidenceFile[]> {
  const root = await realpath(repoPath);
  return Promise.all(
    paths.map(async (path): Promise<EvidenceFile> => {
      try {
        const full = await realpath(join(root, path));
        if (!full.startsWith(root + sep)) return { path, text: null };
        // a FIFO or a device would block the read with no end
        if (!(await stat(full)).isFile()) return { path, text: null };
        // read a generous byte head, then clip in characters: a byte cut could
        // land inside a multibyte sequence, a character cut never does
        const head = await Bun.file(full)
          .slice(0, EVIDENCE_EACH * 8)
          .text();
        return { path, text: head.slice(0, EVIDENCE_EACH * 2) };
      } catch {
        return { path, text: null };
      }
    }),
  );
}
