/** Preloaded by `bun test` (bunfig.toml). A shell inside the deployed
 *  container carries the backend's own env: `NODE_ENV=production`, which
 *  `peerSettingsFromEnv` refuses, and `CANOPY_BIND`/`CANOPY_PUBLIC_ORIGIN`/
 *  `CANOPY_SSH_HOST`, which change what the server under test does. Bun sets
 *  `NODE_ENV=test` only when it is unset, so the suite resets them itself;
 *  a test that wants one sets it. */
process.env["NODE_ENV"] = "test";
for (const k of ["CANOPY_BIND", "CANOPY_PUBLIC_ORIGIN", "CANOPY_SSH_HOST", "CANOPY_NO_DESKTOP"]) delete process.env[k];
