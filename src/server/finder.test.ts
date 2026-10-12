/**
 * The files section's routes: the listing, and one file's bytes sent so a
 * repo's own HTML can never run as a page of canopy's origin.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoFiles } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let server: { port: number; stop: () => void };
let saved: string | undefined;
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const raw = (path: string, extra = "") => fetch(url(`/api/repos/raw?id=app&path=${encodeURIComponent(path)}${extra}`));

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-finder-srv-"));
  saved = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  const app = join(root, "app");
  await Bun.$`mkdir -p ${app} && git -C ${app} init -q`.quiet();
  await writeFile(join(app, "page.html"), "<script>alert(1)</script>");
  await writeFile(join(app, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  server = await startServer({ root, port: 0 });
});

afterAll(async () => {
  server.stop();
  if (saved === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = saved;
  await rm(scratch, { recursive: true, force: true });
});

describe("the files routes", () => {
  test("lists the working tree", async () => {
    const res = await fetch(url("/api/repos/ls?id=app"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as RepoFiles).files).toEqual(["logo.svg", "page.html"]);
  });

  test("sends HTML as sandboxed plain text", async () => {
    const res = await raw("page.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toStartWith("sandbox");
    expect(await res.text()).toBe("<script>alert(1)</script>");
  });

  test("sends an image as itself, still sandboxed", async () => {
    const res = await raw("logo.svg");
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toStartWith("sandbox");
  });

  test("refuses a path out of the repo and a file over the asked cap", async () => {
    expect((await raw("../config/x")).status).toBe(400);
    expect((await raw("/etc/hosts")).status).toBe(400);
    const big = await raw("page.html", "&max=4");
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toContain("25 bytes");
  });
});
