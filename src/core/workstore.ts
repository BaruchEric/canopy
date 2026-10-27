/** The work ledger on disk: one JSON file per item under `<configDir>/work/`.
 *  Bun-only; the hub that writes through here is `server/work.ts`. */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { configDir } from "./store";
import { isWorkId, WORK_STATES, type WorkFrom, type WorkItem, type WorkNote } from "./work";

export const workDir = (): string => join(configDir(), "work");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function isWorkFrom(value: unknown): value is WorkFrom {
  if (!isRecord(value)) return false;
  switch (value["kind"]) {
    case "note":
      return true;
    case "issue":
      return typeof value["service"] === "string" && typeof value["key"] === "string" && (value["link"] === undefined || typeof value["link"] === "string");
    case "coordinator":
      return typeof value["run"] === "string" && typeof value["card"] === "string";
    case "trigger":
      return typeof value["event"] === "string";
    default:
      return false;
  }
}

function isWorkNote(value: unknown): value is WorkNote {
  return isRecord(value) && typeof value["at"] === "number" && typeof value["by"] === "string" && typeof value["text"] === "string";
}

function isPr(value: unknown): value is { number: number; url: string } {
  return isRecord(value) && typeof value["number"] === "number" && typeof value["url"] === "string";
}

function isWorkItem(value: unknown): value is WorkItem {
  if (!isRecord(value)) return false;
  const closedAt = value["closedAt"];
  const reason = value["reason"];
  return (
    isWorkId(value["id"]) &&
    typeof value["title"] === "string" &&
    isStringArray(value["repos"]) &&
    WORK_STATES.some((state) => state === value["state"]) &&
    isWorkFrom(value["from"]) &&
    isStringArray(value["runs"]) &&
    isStringArray(value["branches"]) &&
    Array.isArray(value["prs"]) &&
    value["prs"].every(isPr) &&
    isStringArray(value["events"]) &&
    Array.isArray(value["notes"]) &&
    value["notes"].every(isWorkNote) &&
    typeof value["createdAt"] === "number" &&
    typeof value["updatedAt"] === "number" &&
    (closedAt === undefined || typeof closedAt === "number") &&
    (reason === undefined || typeof reason === "string")
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}

/** Every valid JSON record under `dir`, in id order; malformed files are left alone. */
export async function readWorkItems(dir: string): Promise<WorkItem[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }

  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name).sort();
  const items: WorkItem[] = [];
  for (const file of files) {
    try {
      const contents = await readFile(join(dir, file), "utf8");
      const value: unknown = JSON.parse(contents);
      if (!isWorkItem(value)) throw new Error("not a work item");
      if (file !== `${value.id}.json`) throw new Error(`file name does not match ${value.id}`);
      items.push(value);
    } catch (error: unknown) {
      console.error(`work: ${file} unreadable, left alone: ${errorText(error)}`);
    }
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

/** Writes a whole item through a same-directory temporary file and rename. */
export async function writeWorkItem(dir: string, item: WorkItem): Promise<void> {
  if (!isWorkId(item.id)) throw new Error(`invalid work id: ${item.id}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${item.id}.json`);
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(item, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
