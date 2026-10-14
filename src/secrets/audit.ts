/**
 * The secrets service's audit log: one JSON line per gated act or gate
 * event, with the secret's name and the outcome, never a value. Lives in
 * the secrets-data volume; a recovery starts a new one.
 */

import { appendFile, chmod, readFile } from "node:fs/promises";
import type { SecretAuditEntry } from "../core/types";

export class Audit {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  async add(e: Omit<SecretAuditEntry, "at">): Promise<void> {
    const line: SecretAuditEntry = { at: new Date(this.now()).toISOString(), ...e };
    await appendFile(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    await chmod(this.file, 0o600);
  }

  /** the newest `n`, newest first */
  async last(n: number): Promise<SecretAuditEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const out: SecretAuditEntry[] = [];
    for (const line of text.split("\n").reverse()) {
      if (out.length >= n) break;
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as SecretAuditEntry);
      } catch {
        // a torn last line after a crash; the rest still reads
      }
    }
    return out;
  }
}
