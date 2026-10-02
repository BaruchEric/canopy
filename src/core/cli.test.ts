import { expect, test } from "bun:test";
import { checkEnv } from "./cli";

test("a check's shell runs canopy's own CLI through $CANOPY_CLI", async () => {
  const p = Bun.spawn(["sh", "-c", '"$CANOPY_CLI" version'], { env: { ...process.env, ...checkEnv() }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  expect(out).toContain("canopy");
});
