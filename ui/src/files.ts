import type { RepoFile } from "../../src/core/types";

/** The columns of a panel's changes list, in their default order. The
 *  stage checkbox is not one: it stays first whatever the order. */
export const FILE_COLS = ["mark", "file", "time"] as const;
export type FileCol = (typeof FILE_COLS)[number];

export const FILE_COL_INFO: Record<FileCol, { label: string; title: string }> = {
  mark: { label: "", title: "Status letter" },
  file: { label: "file", title: "Path in the repo" },
  time: { label: "time", title: "When the file on disk last changed" },
};

/** One flat list, or the files under a heading per folder. */
export const FILE_VIEWS = ["list", "folders"] as const;
export type FileView = (typeof FILE_VIEWS)[number];

export const SORT_DIRS = ["asc", "desc"] as const;
export type SortDir = (typeof SORT_DIRS)[number];

export interface FileSort {
  col: FileCol;
  dir: SortDir;
}

/** Recent first for time, A to Z for everything else. */
export function defaultDir(col: FileCol): SortDir {
  return col === "time" ? "desc" : "asc";
}

/** The one letter a row shows: U for a conflict, ? for untracked, else the
 *  staged state when there is one, else the worktree state. */
export function markOf(f: RepoFile): string {
  if (f.conflicted) return "U";
  if (f.untracked) return "?";
  return f.index !== "." ? f.index : f.worktree;
}

/** What a row's checkbox and diff go by. A conflict is not staged whatever
 *  its index letter says, and its conflict markers are in the worktree
 *  diff (the cached one only says "Unmerged path"). A partly staged file
 *  (`split`) has two diffs, the change in the index and the one on top of
 *  it, and both are shown. */
export function stagingOf(f: RepoFile): { staged: boolean; split: boolean } {
  const staged = f.index !== "." && !f.untracked && !f.conflicted;
  return { staged, split: staged && f.worktree !== "." };
}

function keyOf(f: RepoFile, col: FileCol): string | number {
  switch (col) {
    case "file":
      return f.path;
    case "mark":
      return markOf(f);
    case "time":
      return f.mtime ?? -1;
  }
}

/** A stable sort on one column. A file without a time sorts after every
 *  file that has one, whichever way the list runs. */
export function sortFiles(files: RepoFile[], sort: FileSort): RepoFile[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return files
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const ka = keyOf(a.f, sort.col);
      const kb = keyOf(b.f, sort.col);
      if (typeof ka === "number" && typeof kb === "number") {
        if (ka < 0 !== kb < 0) return ka < 0 ? 1 : -1;
        if (ka !== kb) return (ka - kb) * sign;
      } else {
        const c = String(ka).localeCompare(String(kb));
        if (c !== 0) return c * sign;
      }
      return a.i - b.i;
    })
    .map((x) => x.f);
}

/** Every word of the query must appear in the path or the rename origin,
 *  case-insensitively. */
export function filterFiles(files: RepoFile[], query: string): RepoFile[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return files;
  return files.filter((f) => {
    const hay = `${f.path} ${f.orig ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The folder part of a repo-relative path, "" at the root. */
export function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export interface FolderGroup {
  folder: string;
  files: RepoFile[];
}

/** The files under a heading per folder. Folders come in the order their
 *  first file does, so a list sorted newest first puts the folder with the
 *  newest change on top, and the files inside keep the list's order. */
export function groupByFolder(files: RepoFile[]): FolderGroup[] {
  const groups = new Map<string, RepoFile[]>();
  for (const f of files) {
    const folder = folderOf(f.path);
    const g = groups.get(folder);
    if (g) g.push(f);
    else groups.set(folder, [f]);
  }
  return [...groups].map(([folder, files]) => ({ folder, files }));
}

/** Move one column to another's slot, the rest shifting to make room. */
export function moveCol(order: FileCol[], from: FileCol, to: FileCol): FileCol[] {
  if (from === to) return order;
  const rest = order.filter((c) => c !== from);
  const at = rest.indexOf(to);
  if (at < 0) return order;
  // dropping on a column to the right lands after it, to the left before it
  const after = order.indexOf(to) > order.indexOf(from);
  rest.splice(after ? at + 1 : at, 0, from);
  return rest;
}

/** A saved order, made whole: unknown names dropped, duplicates collapsed,
 *  and any column it forgot appended in default order. */
export function colOrder(saved: unknown): FileCol[] {
  const out: FileCol[] = [];
  if (Array.isArray(saved)) {
    for (const v of saved) {
      if (
        typeof v === "string" &&
        (FILE_COLS as readonly string[]).includes(v) &&
        !out.includes(v as FileCol)
      ) {
        out.push(v as FileCol);
      }
    }
  }
  for (const c of FILE_COLS) if (!out.includes(c)) out.push(c);
  return out;
}
