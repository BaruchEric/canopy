import type { Repo, ScanResult } from "../core/types";
import { dirtyCount } from "../core/types";

const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
const paint = (rgb: [number, number, number], s: string): string =>
  useColor ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\x1b[0m` : s;

// the canopy palette
export const moss = (s: string): string => paint([147, 201, 139], s);
export const lichen = (s: string): string => paint([217, 179, 107], s);
export const rust = (s: string): string => paint([201, 123, 95], s);
export const sky = (s: string): string => paint([127, 180, 201], s);
export const dim = (s: string): string =>
  useColor ? `\x1b[2m${s}\x1b[0m` : s;
export const bold = (s: string): string =>
  useColor ? `\x1b[1m${s}\x1b[0m` : s;

export function ago(unixSeconds: number | undefined): string {
  if (!unixSeconds) return "";
  const s = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / 86400 / 30)}mo`;
}

export function statusGlyph(r: Repo): string {
  if (r.error) return rust("✗");
  if (r.status?.files.some((f) => f.conflicted)) return rust("◆");
  if (dirtyCount(r) > 0) return lichen("●");
  if ((r.status?.ahead ?? 0) > 0) return sky("◐");
  return moss("○");
}

export function statusSummary(r: Repo): string {
  if (r.error) return rust("error");
  const st = r.status;
  if (!st) return "";
  const parts: string[] = [];
  if (st.files.length > 0) parts.push(lichen(`${st.files.length} changed`));
  if (st.ahead > 0) parts.push(sky(`↑${st.ahead}`));
  if (st.behind > 0) parts.push(rust(`↓${st.behind}`));
  if (st.tip && st.tip.ref !== st.upstream) parts.push(sky(`⇣${st.tip.ref}`));
  if (parts.length === 0) parts.push(dim("clean"));
  return parts.join(" ");
}

export function renderTree(
  result: ScanResult,
  opts: { dirtyOnly?: boolean } = {},
): string {
  let repos = result.repos;
  if (opts.dirtyOnly) {
    repos = repos.filter((r) => dirtyCount(r) > 0 || (r.status?.ahead ?? 0) > 0 || r.error);
  }
  const lines: string[] = [bold(result.root)];
  const groups = new Map<string, Repo[]>();
  for (const r of repos) {
    const g = r.group || ".";
    const arr = groups.get(g) ?? [];
    arr.push(r);
    groups.set(g, arr);
  }
  const nameW = Math.max(4, ...repos.map((r) => r.name.length));
  const branchW = Math.max(4, ...repos.map((r) => r.status?.branch.length ?? 0));

  const groupNames = [...groups.keys()].sort();
  groupNames.forEach((g, gi) => {
    const isLastGroup = gi === groupNames.length - 1;
    const members = groups.get(g) ?? [];
    const single = members.length === 1 && members[0]?.id === g;
    if (!single) lines.push(`${isLastGroup ? "└─" : "├─"} ${bold(g)}`);
    members.forEach((r, ri) => {
      const isLast = ri === members.length - 1;
      const stem = single
        ? isLastGroup
          ? "└─"
          : "├─"
        : `${isLastGroup ? "   " : "│  "}${isLast ? "└─" : "├─"}`;
      const branch = r.status?.branch ?? "";
      lines.push(
        [
          stem,
          statusGlyph(r),
          r.name.padEnd(nameW),
          dim(branch.padEnd(branchW)),
          statusSummary(r),
          dim(ago(r.status?.lastCommit?.at)),
        ].join(" "),
      );
    });
  });
  if (repos.length === 0) {
    lines.push(
      dim(
        opts.dirtyOnly
          ? "everything is clean and pushed"
          : "no git repos under this directory",
      ),
    );
  }
  return lines.join("\n");
}
