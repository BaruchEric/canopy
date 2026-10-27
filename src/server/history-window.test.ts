import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryOverview } from "../core/types";
import { startServer } from "./index";

function isAvailableHistory(value: unknown): value is Extract<HistoryOverview, { available: true }> {
  return value !== null && typeof value === "object" && "available" in value && value.available === true &&
    "days" in value && Array.isArray(value.days) && value.days.every((day) => typeof day === "string");
}

async function overviewDays(response: Response): Promise<number> {
  if (response.status !== 200) throw new Error(`history response was ${response.status}: ${await response.text()}`);
  const body: unknown = await response.json();
  if (!isAvailableHistory(body)) throw new Error("history response was not available");
  return body.days.length;
}

test("history windows have independent caches and pending reads", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "canopy-history-window-"));
  const oldConfig = process.env["CANOPY_CONFIG_DIR"];
  const oldTmux = process.env["CANOPY_TMUX"];
  const oldLog = process.env["CANOPY_HISTORY_WINDOW_LOG"];
  const config = join(scratch, "config");
  const root = join(scratch, "root");
  const bin = join(scratch, "claude-history");
  const log = join(scratch, "calls");
  let server: Awaited<ReturnType<typeof startServer>> | undefined;

  try {
    process.env["CANOPY_CONFIG_DIR"] = config;
    process.env["CANOPY_TMUX"] = "0";
    process.env["CANOPY_HISTORY_WINDOW_LOG"] = log;
    await mkdir(config, { recursive: true });
    await mkdir(root, { recursive: true });
    await writeFile(join(config, "config.json"), JSON.stringify({ historyBin: bin }));
    await writeFile(
      bin,
      "#!/bin/sh\ncase \"$1\" in\n  projects) printf '%s\\n' '[]' ;;\n  activity) printf '%s\\n' \"$3\" >> \"$CANOPY_HISTORY_WINDOW_LOG\"; sleep 0.2; printf '%s\\n' '[]' ;;\nesac\n",
      { mode: 0o755 },
    );
    server = await startServer({ root, port: 0, chan: null });

    const base = `http://127.0.0.1:${server.port}`;
    const paths = ["/api/history", "/api/history?window=90d", "/api/history", "/api/history?window=30d"];
    const responses = await Promise.all(paths.map((path) => fetch(`${base}${path}`)));
    expect(await Promise.all(responses.map(overviewDays))).toEqual([30, 90, 30, 30]);

    const since = (await readFile(log, "utf8")).trim().split(/\r?\n/).filter(Boolean);
    expect(since).toHaveLength(2);
    expect(new Set(since).size).toBe(2);

    expect(await overviewDays(await fetch(`${base}/api/history`))).toBe(30);
    expect(await overviewDays(await fetch(`${base}/api/history?window=90d`))).toBe(90);
    expect((await readFile(log, "utf8")).trim().split(/\r?\n/).filter(Boolean)).toHaveLength(2);
  } finally {
    server?.stop();
    if (oldConfig === undefined) delete process.env["CANOPY_CONFIG_DIR"];
    else process.env["CANOPY_CONFIG_DIR"] = oldConfig;
    if (oldTmux === undefined) delete process.env["CANOPY_TMUX"];
    else process.env["CANOPY_TMUX"] = oldTmux;
    if (oldLog === undefined) delete process.env["CANOPY_HISTORY_WINDOW_LOG"];
    else process.env["CANOPY_HISTORY_WINDOW_LOG"] = oldLog;
    await rm(scratch, { recursive: true, force: true });
  }
});
