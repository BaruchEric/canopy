/** Reads a judge step's evidence out of a local repo. Each path is resolved
 *  through symlinks and refused when that lands outside the repo, and a huge
 *  file is read as its head and its end, since the judge reads a clipped
 *  part anyway. Bun-only. */

import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { EvidenceFile } from "./types";
import { EVIDENCE_EACH } from "./verdict";

/** bytes a file may have and still be read whole */
const READ_WHOLE = EVIDENCE_EACH * 8;

export async function readEvidence(repoPath: string, paths: string[]): Promise<EvidenceFile[]> {
  const root = await realpath(repoPath);
  return Promise.all(
    paths.map(async (path): Promise<EvidenceFile> => {
      try {
        const full = await realpath(join(root, path));
        if (!full.startsWith(root + sep)) return { path, text: null };
        // a FIFO or a device would block the read with no end
        if (!(await stat(full)).isFile()) return { path, text: null };
        const file = Bun.file(full);
        if (file.size <= READ_WHOLE) return { path, text: await file.text() };
        // a huge file: its head and its end, since judgeState keeps both;
        // a byte cut can land inside a multibyte sequence, and the decoder's
        // replacement characters at the cut are dropped
        const half = READ_WHOLE / 2;
        const head = (await file.slice(0, half).text()).replace(/�+$/, "");
        const tail = (await file.slice(file.size - half).text()).replace(/^�+/, "");
        return { path, text: `${head}\n[…]\n${tail}` };
      } catch {
        return { path, text: null };
      }
    }),
  );
}
