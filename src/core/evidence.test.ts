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
  await writeFile(join(repoDir, "big.md"), `${"y".repeat(EVIDENCE_EACH * 5)}## Verdict\ngo`);
  await writeFile(join(repoDir, "huge.md"), `${"z".repeat(EVIDENCE_EACH * 20)}## Verdict\ngo`);
  // two bytes a character, an odd count so a byte cut lands mid-sequence
  await writeFile(join(repoDir, "wide.md"), "é".repeat(EVIDENCE_EACH * 5 + 1));
  await writeFile(join(scratch, "secret.txt"), "outside");
  await symlink(join(scratch, "secret.txt"), join(repoDir, "link.md"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("reads files in the repo whole, and nothing outside it", async () => {
  const files = await readEvidence(repoDir, [".canopy/intent.md", "big.md", "link.md", "missing.md", "../secret.txt"]);
  expect(files[0]).toEqual({ path: ".canopy/intent.md", text: "be useful" });
  expect(files[1]?.text).toBe(`${"y".repeat(EVIDENCE_EACH * 5)}## Verdict\ngo`);
  expect(files[2]).toEqual({ path: "link.md", text: null });
  expect(files[3]).toEqual({ path: "missing.md", text: null });
  expect(files[4]).toEqual({ path: "../secret.txt", text: null });
});

test("a huge file is read as its head and its end, so the judge still sees how it ends", async () => {
  const [file] = await readEvidence(repoDir, ["huge.md"]);
  const text = file?.text ?? "";
  expect(text.startsWith("z")).toBe(true);
  expect(text.endsWith("## Verdict\ngo")).toBe(true);
  expect(text).toContain("\n[…]\n");
  expect(text.length).toBeLessThan(EVIDENCE_EACH * 8 + 10);
});

test("cuts a huge multibyte file between characters, never mid-sequence", async () => {
  const [file] = await readEvidence(repoDir, ["wide.md"]);
  expect(file?.text).toContain("\n[…]\n");
  expect(file?.text).not.toContain("�");
});

test("reads only regular files, so a FIFO named as evidence reads as missing instead of hanging", async () => {
  Bun.spawnSync(["mkfifo", join(repoDir, "pipe.md")]);
  await mkdir(join(repoDir, "folder.md"), { recursive: true });
  const files = await readEvidence(repoDir, ["pipe.md", "folder.md"]);
  expect(files).toEqual([
    { path: "pipe.md", text: null },
    { path: "folder.md", text: null },
  ]);
});
