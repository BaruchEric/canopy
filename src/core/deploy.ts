/**
 * What the incubator's deploy needs and what it answers, pure and tested
 * (spec 2026-10-01-incubator-design.md, amendment 2). The deploy itself is
 * shipper.ts: canopy's own code, never an agent's step.
 */
import { CONVEX_PARKED, MINI_PARKED } from "./sprout";
import type { HostId } from "./types";

export interface DeployEnv {
  vercelToken: boolean;
  vercelCli: boolean;
  /** whether FIREBASE_TOKEN is set, and the firebase CLI found; only vercel+firebase asks */
  firebaseToken?: boolean;
  firebaseCli?: boolean;
  /** the backend's name, for the reason a park gives */
  backend: string;
}

/** null when `host` can be deployed to from here, else the one-line park reason */
export function deployReady(host: HostId, env: DeployEnv): string | null {
  if (host === "vercel+convex") return CONVEX_PARKED;
  if (host === "mini") return MINI_PARKED;
  if (!env.vercelToken) return `add VERCEL_TOKEN to ${env.backend}'s .env`;
  if (!env.vercelCli) return `the vercel CLI is not installed on ${env.backend}`;
  if (host === "vercel+firebase") {
    if (!env.firebaseToken) return `add FIREBASE_TOKEN to ${env.backend}'s .env`;
    if (!env.firebaseCli) return `the firebase CLI is not installed on ${env.backend}`;
  }
  return null;
}

const safeName = (s: string): string =>
  s
    .normalize("NFKD")
    // NFKD splits an accented letter into the letter and a mark; the mark goes
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");

/** GitHub repo names to try for a seed: its slug, then -2 to -9 */
export function repoCandidates(slug: string): string[] {
  const base = safeName(slug).slice(0, 90) || "sprout";
  return [base, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)];
}

/** a Vercel project name: lowercase letters, digits, ".", "_" and "-", at most 100, never "---" */
export function vercelProject(name: string): string {
  return safeName(name).replace(/-{3,}/g, "--").slice(0, 100) || "sprout";
}

const VERCEL_APP = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app\/?$/;
/** the only addresses a sprout goes live at: no custom domain is ever involved */
export const isVercelAppUrl = (u: string): boolean => VERCEL_APP.test(u);

/** the deployment url `vercel deploy` printed: off a terminal, vercel 61
 *  prints json and the url is its `deployment.url`; older ones print the
 *  url as their last vercel.app line */
export function deploymentUrl(stdout: string): string | null {
  const json = deploymentJsonUrl(stdout);
  if (json !== undefined) return json;
  const urls = stdout.split("\n").map((l) => l.trim()).filter(isVercelAppUrl);
  const last = urls.at(-1);
  return last ? last.replace(/\/$/, "") : null;
}

/** `deployment.url` from vercel's json output: undefined when the output is
 *  not json, null when it is but names no vercel.app url */
function deploymentJsonUrl(stdout: string): string | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("deployment" in parsed)) return null;
  const dep = parsed.deployment;
  if (typeof dep !== "object" || dep === null || !("url" in dep) || typeof dep.url !== "string") return null;
  return isVercelAppUrl(dep.url) ? dep.url.replace(/\/$/, "") : null;
}

/** the production url among a deployment's aliases: the shortest vercel.app one, else the deployment's own */
export function productionUrl(aliases: readonly string[], fallback: string): string {
  const own = aliases
    .map((a) => (a.startsWith("https://") ? a : `https://${a}`))
    .filter(isVercelAppUrl)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return own[0]?.replace(/\/$/, "") ?? fallback;
}

/** what a smoke GET's status says about going live; null is live */
export function smokeRefusal(status: number, url: string): string | null {
  if (status >= 200 && status < 400) return null;
  if (status === 401 || status === 403) {
    return `${url} answers ${status}: Vercel's deployment protection may cover it; turn it off for production in the project's settings, then resume`;
  }
  return `${url} answers ${status}`;
}

/** the vercel argv; the token rides in the child's env, never here, where ps would show it */
export function vercelArgs(cmd: "link" | "deploy", project: string, scope: string | null): string[] {
  const s = scope ? ["--scope", scope] : [];
  return cmd === "link" ? ["vercel", "link", "--yes", "--project", project, ...s] : ["vercel", "deploy", "--prod", "--yes", ...s];
}

/** the vercel.json keys a sprout's deploy may carry: how to build and serve
 *  it, nothing that names a domain, an alias, a team or a git link */
export const VERCEL_JSON_KEYS = [
  "$schema",
  "buildCommand",
  "outputDirectory",
  "installCommand",
  "framework",
  "cleanUrls",
  "trailingSlash",
  "rewrites",
  "redirects",
  "headers",
] as const;

/** the other config files the vercel CLI reads: the script forms run code
 *  in a process that holds the token, and none of them is checked here */
export const VERCEL_OTHER_CONFIGS = ["now.json", "vercel.toml", "vercel.ts", "vercel.mts", "vercel.js", "vercel.mjs", "vercel.cjs"] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** null when the deploy's own config may go to the CLI, else why not.
 *  `names` are the files at the deploy's root, `vercelJson` its vercel.json.
 *  Names compare lowercased: on a Mac's filesystem a `VERCEL.TS` is the
 *  `vercel.ts` the CLI loads, and a `Vercel.json` is the file read as
 *  vercel.json, so a name that only differs by case is refused too. */
export function vercelConfigRefusal(names: readonly string[], vercelJson: string | null): string | null {
  const other = names.find((n) => (VERCEL_OTHER_CONFIGS as readonly string[]).includes(n.toLowerCase()));
  if (other) return `${other} is a Vercel config canopy does not read; use vercel.json`;
  const odd = names.find((n) => n.toLowerCase() === "vercel.json" && n !== "vercel.json");
  if (odd) return `${odd} differs from vercel.json only by case; name it vercel.json`;
  if (vercelJson === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(vercelJson);
  } catch {
    return "vercel.json is not JSON";
  }
  if (!isRecord(parsed)) return "vercel.json is not a JSON object";
  if ("alias" in parsed) return "vercel.json sets alias, and a sprout never goes live on a domain of its own";
  const allowed: readonly string[] = VERCEL_JSON_KEYS;
  const off = Object.keys(parsed).filter((k) => !allowed.includes(k));
  if (off.length) return `vercel.json sets ${off.join(", ")}, which canopy does not deploy with; it takes ${VERCEL_JSON_KEYS.join(", ")}`;
  return null;
}

/** the Vercel framework preset package.json makes clear: Next, else Vite, else none */
export function frameworkOf(packageJson: string | null): "nextjs" | "vite" | null {
  if (packageJson === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const pkg = parsed;
  const has = (name: string): boolean =>
    ["dependencies", "devDependencies"].some((k) => {
      const deps = pkg[k];
      return isRecord(deps) && name in deps;
    });
  if (has("next")) return "nextjs";
  if (has("vite")) return "vite";
  return null;
}

/** a .vercelignore that keeps `.canopy/` out of the upload: canopy's line
 *  last, so no negation before it brings a note back */
export function withCanopyIgnored(text: string | null): string {
  const lines = (text ?? "").split("\n").filter((l) => l.trim() !== ".canopy/");
  while (lines.length && lines[lines.length - 1]?.trim() === "") lines.pop();
  return [...lines, ".canopy/", ""].join("\n");
}

/** the aliases a deployment answered that are not vercel.app addresses */
export const strangeAliases = (aliases: readonly string[]): string[] =>
  aliases.filter((a) => !isVercelAppUrl(a.startsWith("https://") ? a : `https://${a}`));

/** whether a page's body is the file itself, served as it is: what a 200
 *  for a `.canopy/` note means, as against an app's own fallback page */
export function servesFile(body: string, file: string): boolean {
  const head = file.trim().slice(0, 200);
  return head.length > 0 && body.trimStart().startsWith(head);
}
