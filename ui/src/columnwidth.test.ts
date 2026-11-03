import { describe, expect, test } from "bun:test";
import { CARDS, SEAM, cardsTop, sharedRoom } from "./cardswidth";
import { CARDS_SHARE, COLUMN_CAP, WIDE_WINDOW, cardsKeep, newColumnWidth, type ColumnRoom } from "./columnwidth";
import { COLUMN_WIDTH } from "./grid";
import { SCREEN_CLASSES } from "./screens";

/** the tree at its initial width, with its seam */
const TREE = 264 + SEAM;
const at = (window: number, rest: Partial<ColumnRoom> = {}): number => newColumnWidth({ window, before: TREE, cards: null, columns: [], ...rest });

describe("the bounds", () => {
  test("a column starts wider from where the desktop class ends", () => {
    const desktop = SCREEN_CLASSES.find((c) => c.cls === "desktop");
    expect(desktop?.upTo).toBe(WIDE_WINDOW);
  });
  test("the cap is above the default and the cards' share leaves room for a column", () => {
    expect(COLUMN_CAP).toBeGreaterThan(COLUMN_WIDTH);
    expect(CARDS_SHARE).toBeLessThan(0.5);
  });
});

describe("cardsKeep", () => {
  test("is a third of the room while nothing is chosen, never under the cards' floor", () => {
    expect(cardsKeep(3164, null)).toBe(1054);
    expect(cardsKeep(600, null)).toBe(CARDS.min);
  });
  test("is the chosen width, held as the floor is", () => {
    expect(cardsKeep(3164, 1500)).toBe(1500);
    expect(cardsKeep(3164, 100)).toBe(CARDS.min);
    expect(cardsKeep(3164, 4000)).toBe(cardsTop(3164));
  });
});

describe("newColumnWidth under a wide window", () => {
  test("a laptop at 1440 and 1920 and a desktop at 2560 start every column at COLUMN_WIDTH, as before", () => {
    for (const w of [1440, 1920, 2560]) {
      expect(at(w)).toBe(COLUMN_WIDTH);
      expect(at(w, { before: 0 })).toBe(COLUMN_WIDTH);
      expect(at(w, { cards: 400 })).toBe(COLUMN_WIDTH);
      expect(at(w, { columns: [COLUMN_WIDTH, COLUMN_WIDTH] })).toBe(COLUMN_WIDTH);
    }
  });
  test("a phone, a window one short of wide, or no window at all", () => {
    expect(at(412)).toBe(COLUMN_WIDTH);
    expect(at(WIDE_WINDOW - 1)).toBe(COLUMN_WIDTH);
    expect(at(0)).toBe(COLUMN_WIDTH);
    expect(at(Number.NaN)).toBe(COLUMN_WIDTH);
  });
});

describe("newColumnWidth on an ultrawide at 3440", () => {
  const room = sharedRoom(3440, TREE);
  const keep = cardsKeep(room, null);

  test("the room is the window less the tree, its seam and the cards' seam, and the cards keep a third", () => {
    expect(room).toBe(3164);
    expect(keep).toBe(1054);
  });
  test("the first column takes what the cards leave, up to the cap", () => {
    expect(room - keep - SEAM).toBeGreaterThan(COLUMN_CAP);
    expect(at(3440)).toBe(COLUMN_CAP);
  });
  test("the second takes the rest beside the first, and the third starts at COLUMN_WIDTH again", () => {
    const second = at(3440, { columns: [COLUMN_CAP] });
    expect(second).toBe(room - keep - (COLUMN_CAP + SEAM) - SEAM);
    expect(second).toBe(898);
    expect(at(3440, { columns: [COLUMN_CAP, second] })).toBe(COLUMN_WIDTH);
  });
  test("two columns with their seams and the cards' share fill the room exactly", () => {
    const first = at(3440);
    const second = at(3440, { columns: [first] });
    expect(first + SEAM + second + SEAM + keep).toBe(room);
  });
  test("a width chosen at the cards' seam is what the cards keep", () => {
    expect(at(3440, { cards: 1500 })).toBe(COLUMN_CAP);
    expect(at(3440, { cards: 1500, columns: [COLUMN_CAP] })).toBe(room - 1500 - (COLUMN_CAP + SEAM) - SEAM);
    expect(at(3440, { cards: 2800 })).toBe(COLUMN_WIDTH);
  });
  test("a column widened by hand counts at its width, and a narrow spare falls back to COLUMN_WIDTH", () => {
    expect(at(3440, { columns: [1800] })).toBe(COLUMN_WIDTH);
    expect(at(3440, { columns: [1000] })).toBe(room - keep - (1000 + SEAM) - SEAM);
  });
  test("without the tree the whole window is the room", () => {
    const open = sharedRoom(3440, 0);
    expect(at(3440, { before: 0 })).toBe(COLUMN_CAP);
    expect(at(3440, { before: 0, columns: [COLUMN_CAP] })).toBe(open - cardsKeep(open, null) - (COLUMN_CAP + SEAM) - SEAM);
  });
  test("the width is whole px", () => {
    expect(Number.isInteger(at(3440, { before: 270.5, columns: [COLUMN_CAP] }))).toBe(true);
  });
});
