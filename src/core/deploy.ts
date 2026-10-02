/**
 * What the incubator's deploy needs and what it answers, pure and tested
 * (spec 2026-10-01-incubator-design.md, amendment 2). The deploy itself is
 * shipper.ts: canopy's own code, never an agent's step.
 */
import type { HostId } from "./types";

export interface DeployEnv {
  vercelToken: boolean;
  vercelCli: boolean;
  /** the backend's name, for the reason a park gives */
  backend: string;
}

/** null when `host` can be deployed to from here, else the one-line park reason */
export function deployReady(host: HostId, env: DeployEnv): string | null {
  if (host !== "vercel") return `deploying to ${host} arrives in phase 4`;
  if (!env.vercelToken) return `add VERCEL_TOKEN to ${env.backend}'s .env`;
  if (!env.vercelCli) return `the vercel CLI is not installed on ${env.backend}`;
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

/** the deployment url `vercel deploy` printed: its last vercel.app line */
export function deploymentUrl(stdout: string): string | null {
  const urls = stdout.split("\n").map((l) => l.trim()).filter(isVercelAppUrl);
  const last = urls.at(-1);
  return last ? last.replace(/\/$/, "") : null;
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
