import { qualify, split, type Reg } from "./backends";

/* Which backends this page talks to and at what base URL. Module state, set
   once by the store's init (and changed when a backend is hidden or shown);
   until then everything is home and every base is the page's own origin. */

let reg: Reg = { home: "", names: [""] };
const bases = new Map<string, string>();

export function setRegistry(home: string, names: string[]): void {
  reg = { home, names: names.includes(home) ? names : [home, ...names] };
}

/** A backend's base URL, "" for the page's own origin. */
export function setBase(name: string, base: string): void {
  bases.set(name, base.replace(/\/+$/, ""));
}

export const registry = (): Reg => reg;
export const homeName = (): string => reg.home;
export const backendNames = (): readonly string[] => reg.names;
export const backendOf = (id: string): string => split(reg, id)[0];
export const plainOf = (id: string): string => split(reg, id)[1];
export const qual = (backend: string, id: string): string => qualify(reg, backend, id);
export const baseOf = (backend: string): string => bases.get(backend) ?? "";
export const isHome = (id: string): boolean => backendOf(id) === reg.home;
