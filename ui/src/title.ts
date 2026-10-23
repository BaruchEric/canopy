import { titled } from "./notify";

/** The page title has two writers: a solo, shell or agent window names what
 *  it shows, and the store counts what waits on the human. Each sets its
 *  half here so neither overwrites the other. */
let base = "canopy";
let count = 0;

function write(): void {
  if (typeof document === "undefined") return;
  document.title = titled(base, count);
}

/** what the window shows; "canopy" when it goes back to nothing */
export function setTitleBase(next: string): void {
  base = next;
  write();
}

/** how many things wait on the human; 0 drops the "(n)" */
export function setTitleCount(n: number): void {
  if (n === count) return;
  count = n;
  write();
}
