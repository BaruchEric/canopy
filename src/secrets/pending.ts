/**
 * The proposals waiting on an approval, kept in the secrets-data volume so
 * a restart of the service does not lose them: every deploy that rebuilds
 * its image recreates the container. A value stays sealed to the mini's
 * key, exactly as it arrived, and nothing is opened to write this file.
 * What a proposal's name and match are is worked out again at the next
 * start, from the store as it is then.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { parseProposals } from "../core/secretwire";
import type { SecretProposalIn } from "../core/types";

export interface KeptProposal {
  id: string;
  p: SecretProposalIn;
  /** epoch ms */
  expires: number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function entry(v: unknown): KeptProposal | null {
  if (!isObj(v)) return null;
  const { id, p, expires } = v;
  // the same checks a proposal passes on its way in
  const parsed = parseProposals([p]);
  const one = Array.isArray(parsed) ? parsed[0] : undefined;
  if (!one || typeof id !== "string" || !ID.test(id) || typeof expires !== "number" || !Number.isFinite(expires)) return null;
  return { id, p: one, expires };
}

/** The kept proposals, and how many entries could not be read. No file is
 *  none of either; a file that is not a JSON list counts as one lost. */
export async function readPending(path: string): Promise<{ list: KeptProposal[]; dropped: number }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    return { list: [], dropped: isObj(err) && err["code"] === "ENOENT" ? 0 : 1 };
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { list: [], dropped: 1 };
  }
  if (!Array.isArray(v)) return { list: [], dropped: 1 };
  const list = v.flatMap((x) => {
    const e = entry(x);
    return e ? [e] : [];
  });
  return { list, dropped: v.length - list.length };
}

let writes = 0;

/** a temp file at 0600 beside it, renamed over, so a crash leaves the old list or the new */
export async function writePending(path: string, list: readonly KeptProposal[]): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${++writes}`;
  await writeFile(tmp, `${JSON.stringify(list)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}
