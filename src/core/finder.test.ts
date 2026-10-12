import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { fileKind, mimeOf } from "./filekind";
import { FinderError, listFiles, parseFiles, rawCommand, readRaw, safeRel } from "./finder";

let scratch: string;
let repo: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-finder-"));
  repo = join(scratch, "repo");
  await Bun.$`mkdir -p ${join(repo, "src")} ${join(repo, "node_modules", "x")} && git -C ${repo} init -q`.quiet();
  await writeFile(join(repo, ".gitignore"), "node_modules\n.env\n");
  await writeFile(join(repo, "README.md"), "# hi\n");
  await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(repo, "node_modules", "x", "i.js"), "x");
  await writeFile(join(repo, ".env"), "SECRET=1\n");
  await writeFile(join(scratch, "outside.txt"), "not yours\n");
  await symlink(join(scratch, "outside.txt"), join(repo, "escape.txt"));
  await Bun.$`git -C ${repo} add README.md && git -C ${repo} -c user.email=t@t -c user.name=t commit -qm init`.quiet();
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("safeRel", () => {
  test("takes a plain path from the root", () => {
    expect(safeRel("src/a.ts")).toBe("src/a.ts");
    expect(safeRel(".env")).toBe(".env");
  });
  test("refuses anything that could step out", () => {
    for (const p of ["", "/etc/passwd", "../x", "src/../../x", "a//b", "./a", "a\\b", "a\0b", "src/"]) {
      expect(safeRel(p)).toBeNull();
    }
  });
});

describe("listing", () => {
  test("folds repeats and sorts", () => {
    expect(parseFiles("b\0a\0b\0")).toEqual({ files: ["a", "b"], truncated: false });
    expect(parseFiles("c\0b\0a\0", 2)).toEqual({ files: ["a", "b"], truncated: true });
  });

  test("lists tracked and new files, never ignored ones", async () => {
    const { files } = await listFiles(repo);
    expect(files).toContain("README.md");
    expect(files).toContain("src/a.ts");
    expect(files).toContain(".gitignore");
    expect(files.some((f) => f.startsWith("node_modules"))).toBe(false);
    expect(files).not.toContain(".env");
  });
});

describe("reading a file", () => {
  test("reads a file in the repo", async () => {
    const f = await readRaw(repo, "src/a.ts", 1024);
    expect(f.size).toBe(20);
    expect(await new Response(f.body).text()).toBe("export const a = 1;\n");
  });

  test("refuses a symlink out of the repo, a folder, a missing file and one over the cap", async () => {
    const status = (p: Promise<unknown>) => p.then(() => 0, (e: unknown) => (e instanceof FinderError ? e.status : -1));
    expect(await status(readRaw(repo, "escape.txt", 1024))).toBe(403);
    expect(await status(readRaw(repo, "src", 1024))).toBe(400);
    expect(await status(readRaw(repo, "nope.txt", 1024))).toBe(404);
    expect(await status(readRaw(repo, "src/a.ts", 5))).toBe(413);
  });

  // the remote read is one sh script; run here, it answers as it would there
  test("the remote script checks, sizes and encodes the same way", async () => {
    const run = (rel: string, max: number) => exec(rawCommand(repo, rel, max));
    const ok = await run("src/a.ts", 1024);
    expect(ok.code).toBe(0);
    const [size, ...b64] = ok.stdout.split("\n");
    expect(size).toBe("20");
    expect(Buffer.from(b64.join(""), "base64").toString()).toBe("export const a = 1;\n");
    expect((await run("escape.txt", 1024)).code).toBe(5);
    expect((await run("nope.txt", 1024)).code).toBe(4);
    expect((await run("src/a.ts", 5)).code).toBe(6);
    expect((await exec(rawCommand(join(scratch, "gone"), "a", 5))).code).toBe(3);
  });
});

describe("file kinds", () => {
  test("media by extension, text for the rest, binary for known blobs", () => {
    expect(fileKind("a/b.PNG")).toBe("image");
    expect(fileKind("clip.webm")).toBe("video");
    expect(fileKind("doc.pdf")).toBe("pdf");
    expect(fileKind("Makefile")).toBe("text");
    expect(fileKind(".env.example")).toBe("text");
    expect(fileKind("index.html")).toBe("text");
    expect(fileKind("bun.lockb")).toBe("binary");
  });
  test("text and markup go out as plain text", () => {
    expect(mimeOf("index.html")).toBe("text/plain; charset=utf-8");
    expect(mimeOf("logo.svg")).toBe("image/svg+xml");
    expect(mimeOf("a.zip")).toBe("application/octet-stream");
  });
});
