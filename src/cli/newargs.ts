/** `canopy new`'s arguments, read without touching the disk or the network. */

export interface NewArgs {
  text: string;
  files: string[];
  urls: string[];
  repo?: string;
  backend: string;
}

const VALUED = new Set(["--file", "--url", "--repo", "--backend"]);

export function parseNewArgs(argv: string[], env: Record<string, string | undefined>): NewArgs | { error: string } {
  const words: string[] = [];
  const files: string[] = [];
  const urls: string[] = [];
  let repo: string | undefined;
  let backend: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!VALUED.has(a)) {
      words.push(a);
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
    i += 1;
    if (a === "--file") files.push(v);
    else if (a === "--url") urls.push(v);
    else if (a === "--repo") repo = v;
    else backend = v;
  }
  const origin = (backend ?? env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(origin)) return { error: `--backend must be an http(s) origin, got ${backend ?? origin}` };
  const text = words.join(" ").trim();
  if (!text && files.length === 0 && urls.length === 0 && !repo) return { error: "give an idea, --file, --url or --repo" };
  return { text, files, urls, ...(repo ? { repo } : {}), backend: origin };
}

export const sproutLink = (backend: string, id: string): string => `${backend.replace(/\/+$/, "")}/?view=incubator&sprout=${id}`;
