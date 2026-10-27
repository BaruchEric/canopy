/** What stands between a backend's name and an id it minted. Backend names
 *  are slugs, so the first one in an id is always this. */
export const SEP = "|";

/** The backends a page talks to: the one that served it, and all of them
 *  in the registry's order (home among them). */
export interface Reg {
  home: string;
  names: readonly string[];
}

/** An id as the page holds it. The home backend's ids stay bare, so a page
 *  with one backend holds what it held before there were several. */
export function qualify(reg: Reg, backend: string, id: string): string {
  return backend === reg.home ? id : `${backend}${SEP}${id}`;
}

/** The backend an id belongs to and the id that backend knows. A prefix
 *  counts only when it names another backend in the registry, so a home id
 *  with a bar in it stays home. */
export function split(reg: Reg, id: string): [string, string] {
  const i = id.indexOf(SEP);
  if (i > 0) {
    const name = id.slice(0, i);
    if (name !== reg.home && reg.names.includes(name)) return [name, id.slice(i + 1)];
  }
  return [reg.home, id];
}
