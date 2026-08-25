import type { CSSProperties } from "react";
import { recentOf, ringLevel } from "../rings";
import { dayLabel, usd } from "../util";
import type { RepoHistory } from "../../../src/core/types";

/**
 * The rings: a core sample of the last month, one column per local day,
 * tinted by what Claude's work there cost. On a card it is a 3px strip and
 * the whole thing carries one tooltip; in the panel it is tall enough that
 * each day answers for itself.
 */
export function Rings({
  history,
  days,
  maxDay,
  tall = false,
}: {
  history: RepoHistory;
  /** the overview's local dates, oldest first */
  days: string[];
  /** the heaviest day in the grove, so every strip shares a scale */
  maxDay: number;
  tall?: boolean;
}) {
  const recent = recentOf(history);
  if (recent.sessions === 0 && recent.cost === 0) return null;
  const first = days[0] ?? "";
  const last = days[days.length - 1] ?? "";
  const summary = `${dayLabel(first)} to ${dayLabel(last)}: ${recent.sessions} ${
    recent.sessions === 1 ? "session" : "sessions"
  } with Claude, ${usd(recent.cost)} API-equivalent`;
  return (
    <span
      className={tall ? "rings tall" : "rings"}
      role="img"
      aria-label={summary}
      title={tall ? undefined : summary}
    >
      {days.map((day, i) => {
        const cost = history.days[i] ?? 0;
        const n = history.daySessions[i] ?? 0;
        const level = ringLevel(cost, maxDay);
        return (
          <i
            key={day}
            style={{ "--p": `${Math.round(level * 100)}%` } as CSSProperties}
            title={
              tall
                ? n > 0 || cost > 0
                  ? `${dayLabel(day)} · ${n} ${n === 1 ? "session" : "sessions"} · ${usd(cost)}`
                  : dayLabel(day)
                : undefined
            }
          />
        );
      })}
    </span>
  );
}
