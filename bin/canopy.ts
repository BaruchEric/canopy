#!/usr/bin/env bun
import { main } from "../src/cli/index";

await main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
