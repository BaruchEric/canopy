/** xterm, its fit addon and its stylesheet, fetched with the first shell or
 *  once the page is idle, never with the page itself: they are a fifth of
 *  the bundle, and most screens open without a shell. */
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

export interface Xterm {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
}

let here: Xterm | null = null;
let loading: Promise<Xterm> | null = null;

/** xterm when it has loaded already, else null */
export const xtermHere = (): Xterm | null => here;

export function loadXterm(): Promise<Xterm> {
  loading ??= Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]).then(
    ([x, f]) => (here = { Terminal: x.Terminal, FitAddon: f.FitAddon }),
    (err: unknown) => {
      // the next shell to mount tries again
      loading = null;
      throw err;
    },
  );
  return loading;
}
