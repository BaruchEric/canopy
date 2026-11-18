/**
 * The pure half of the manager's new box (NewComposer.tsx), which starts a
 * goal or a project from one place. The words and the files belong to the
 * box and stay when the kind switches; what the picked kind cannot take is
 * said and holds its start, so nothing is dropped without a word. Tested in
 * newbox.test.ts.
 */
import { INPUT_FILE_MAX, INPUT_TOTAL_MAX, inputType, sizeWord } from "../../src/core/sprout";
import type { NewKind } from "./routes";

/** the browser's key for the kind the box last started */
export const NEW_KIND_KEY = "canopy.new-kind";

/** a stored kind, or goal for anything else */
export const kindOf = (raw: string | null | undefined): NewKind => (raw === "project" ? "project" : "goal");

/** Why the incubator would refuse these files as a project's inputs, or
 *  null: a type it does not take, a file over its size, or all of them
 *  over the total. A goal takes any file, so the line says so. */
export function projectFilesWhy(files: readonly { name: string; type: string; size: number }[]): string | null {
  const bad = files.flatMap((f) =>
    !inputType(f.type, f.name) ? [`${f.name} is not audio, an image, a pdf, text or markdown`] : f.size > INPUT_FILE_MAX ? [`${f.name} is over ${sizeWord(INPUT_FILE_MAX)}`] : [],
  );
  if (bad.length > 0) return `A project cannot take ${bad.length === 1 ? "this file" : "these files"}: ${bad.join("; ")}. Remove ${bad.length === 1 ? "it" : "them"}, or start a goal.`;
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (bytes > INPUT_TOTAL_MAX) return `The files come to ${sizeWord(bytes)}; a project takes ${sizeWord(INPUT_TOTAL_MAX)} in all.`;
  return null;
}

/** the links typed on the project side, one per word */
export const linksOf = (links: string): string[] => links.split(/\s+/).filter(Boolean);

/** What the project side holds that a goal does not take (its links and
 *  its repo url), said while the goal side shows; null when there is none.
 *  Nothing is sent with the goal, and the fields keep their words. */
export function goalLeaves(links: string, repo: string): string | null {
  const n = linksOf(links).length;
  const parts = [n === 1 ? "the link" : n > 1 ? `the ${n} links` : "", repo.trim() ? "the repo url" : ""].filter(Boolean);
  if (parts.length === 0) return null;
  return `A goal does not take ${parts.join(" or ")} from the project side; put a link in the words, or name a repo with @.`;
}

/** what the project side sends the incubator, as its form */
export interface ProjectDraft {
  text: string;
  links: string;
  repo: string;
  files: readonly File[];
}

/** The incubator's intake form (`POST /api/incubator`): the words, each
 *  link, the repo url and each file, as the old new project sheet sent. */
export function projectForm(d: ProjectDraft): FormData {
  const form = new FormData();
  if (d.text.trim()) form.append("text", d.text);
  for (const u of linksOf(d.links)) form.append("url", u);
  if (d.repo.trim()) form.append("repo", d.repo.trim());
  for (const f of d.files) form.append("file", f, f.name);
  form.append("via", "sheet");
  return form;
}

/** A project has something to start from: words, a link, a file or a repo. */
export const projectHasInput = (d: Omit<ProjectDraft, "files"> & { files: number }): boolean =>
  d.text.trim() !== "" || linksOf(d.links).length > 0 || d.files > 0 || d.repo.trim() !== "";
