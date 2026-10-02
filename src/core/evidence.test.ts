import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvidence } from "./evidence";
import { EVIDENCE_EACH } from "./verdict";

let scratch: string;
let repoDir: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-evidence-"));
  repoDir = join(scratch, "repo");
  await mkdir(join(repoDir, ".canopy"), { recursive: true });
  await writeFile(join(repoDir, ".canopy/intent.md"), "be useful");
  await writeFile(join(repoDir, "big.md"), "y".repeat(EVIDENCE_EACH * 5));
  await writeFile(join(repoDir, "wide.md"), "é".repeat(EVIDENCE_EACH * 5));
  await writeFile(join(scratch, "secret.txt"), "outside");
  await symlink(join(scratch, "secret.txt"), join(repoDir, "link.md"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("reads files in the repo, only the head of a big one, and nothing outside it", async () => {
  const files = await readEvidence(repoDir, [".canopy/intent.md", "big.md", "link.md", "missing.md", "../secret.txt"]);
  expect(files[0]).toEqual({ path: ".canopy/intent.md", text: "be useful" });
  expect(files[1]?.text?.length).toBe(EVIDENCE_EACH * 2);
  expect(files[2]).toEqual({ path: "link.md", text: null });
  expect(files[3]).toEqual({ path: "missing.md", text: null });
  expect(files[4]).toEqual({ path: "../secret.txt", text: null });
});

test("clips in characters, so a multibyte file is never cut mid-sequence", async () => {
  const [file] = await readEvidence(repoDir, ["wide.md"]);
  expect(file?.text?.length).toBe(EVIDENCE_EACH * 2);
  expect(file?.text).not.toContain("�");
});
