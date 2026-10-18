import { expect, test } from "bun:test";
import { INHERITED_ENV } from "./core/term";

// Run from a canopy shell, the suite starts with the backend's env and the
// shell's own names (test-env.ts). None of them may reach a test server.
test("the preload clears the backend's and the shell's settings", () => {
  for (const k of ["CANOPY_CALLERS", "CANOPY_ORIGINS", "CANOPY_PREVIEW_PUBLIC", "CANOPY_PUBLIC_ORIGIN", ...INHERITED_ENV]) {
    expect(process.env[k], k).toBeUndefined();
  }
});
