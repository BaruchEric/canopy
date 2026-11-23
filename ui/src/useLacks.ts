/* Whether this page lacks a right where a repo or a run lives (FR-074): a
   viewer's page hides what it cannot use instead of offering a button the
   backend refuses. */

import type { Right } from "../../src/core/callers";
import { lacks } from "./callerToken";
import { backendOf } from "./registry";
import { useStore } from "./store";

/** for an id the page holds (a repo's, a run's, a shell's) */
export const useLacks = (id: string, right: Right): boolean => useStore((s) => lacks(s.authByBackend[backendOf(id)], right));

/** for the home backend */
export const useLacksHome = (right: Right): boolean => useStore((s) => lacks(s.authByBackend[s.home], right));
