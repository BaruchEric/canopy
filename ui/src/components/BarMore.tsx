import { moreGroups, putAway, type BarChip, type BarChipId } from "../quietbar";
import { PickMenu } from "./PickMenu";

/** Press a chip that sits in the quiet bar, shown or put away: its own
 *  button, so the menu does exactly what the chip does. A chip put away is
 *  still mounted (TopBar's `Tuck`), and one that opens a popover shows on
 *  the bar for as long as the popover is open. */
export function pressChip(id: BarChipId): void {
  document.querySelector<HTMLElement>(`[data-tuck="${id}"] :is(button, a)`)?.click();
}

/** The menu at the end of the quiet bar (FR-079): every chip by name with
 *  its state, the ones on the bar marked, and a pick presses that chip. A
 *  chip stays in the list while it is on the bar, so each is always found in
 *  the same place. */
export function BarMore({ chips, crowded }: { chips: readonly BarChip[]; crowded?: ReadonlySet<BarChipId> }) {
  const away = putAway(chips);
  // chips with something to say that the row had no room for: the button counts them
  const short = chips.filter((c) => c.there && c.says && crowded?.has(c.id)).length;
  return (
    <PickMenu
      className="bar-more"
      btnClass="bar-more-btn"
      hang="right"
      label="The rest of the bar"
      value={null}
      groups={moreGroups(chips).map((g) => ({
        label: g.label,
        options: g.chips.map((c) => ({
          value: c.id,
          label: (
            <>
              <span>{c.name}</span>
              {c.says && <span className={crowded?.has(c.id) ? "bar-more-on short" : "bar-more-on"}>{crowded?.has(c.id) ? "no room on the bar" : "on the bar"}</span>}
            </>
          ),
          what: c.state,
        })),
      }))}
      onPick={(id) => {
        const chip = chips.find((c) => c.id === id);
        // after the menu has closed, so the chip's popover is the one left open
        if (chip) setTimeout(() => pressChip(chip.id), 0);
      }}
      title={[
        `The rest of the bar: ${away} ${away === 1 ? "control has" : "controls have"} nothing to say right now and ${away === 1 ? "waits" : "wait"} here. A control comes back to the bar when it does.`,
        short > 0 ? `${short} with something to say ${short === 1 ? "has" : "have"} no room on the bar at this width.` : "",
      ]
        .filter(Boolean)
        .join("\n")}
      hint="A pick does what the control does on the bar. The advanced level, in Settings, keeps every control on the bar."
      trigger={
        <>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
          <span className="bar-more-word">more</span>
          {short > 0 && (
            <span className="bar-more-n" aria-label={`${short} with something to say`}>
              {short}
            </span>
          )}
        </>
      }
    />
  );
}
