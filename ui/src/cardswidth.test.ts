import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CARDS, DOCK_KEEP, SEAM, cardsFloor, cardsTop, chosenWidth, sharedRoom } from "./cardswidth";
import { PANEL } from "./store";

const CSS = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("the cards' bounds", () => {
  test("the floor is the stylesheet's --cards-min, and the dock keeps its narrowest column and seam", () => {
    expect(CSS).toContain(`--cards-min: ${CARDS.min}px;`);
    expect(DOCK_KEEP).toBe(PANEL.min + SEAM);
  });
});

describe("sharedRoom", () => {
  test("is the body less the tree, its seam and the cards' seam", () => {
    expect(sharedRoom(1440, 264 + 6)).toBe(1440 - 270 - 6);
    expect(sharedRoom(1000, 0)).toBe(994);
    expect(sharedRoom(4, 0)).toBe(0);
  });
});

describe("cardsTop", () => {
  test("leaves the dock DOCK_KEEP", () => {
    expect(cardsTop(1164)).toBe(1164 - DOCK_KEEP);
  });
  test("never goes under the cards' own floor", () => {
    expect(cardsTop(400)).toBe(CARDS.min);
    expect(cardsTop(0)).toBe(CARDS.min);
  });
});

describe("cardsFloor", () => {
  test("is the stylesheet's floor while nothing is chosen, however wide the window", () => {
    expect(cardsFloor(null, 600)).toBe(CARDS.min);
    expect(cardsFloor(null, 7000)).toBe(CARDS.min);
  });
  test("is the choice where it fits", () => {
    expect(cardsFloor(700, 1164)).toBe(700);
    expect(cardsFloor(700.4, 1164)).toBe(700);
  });
  test("gives way to a narrow window, down to the cards' floor, and holds again when it widens", () => {
    expect(cardsFloor(900, 1000)).toBe(1000 - DOCK_KEEP);
    expect(cardsFloor(900, 500)).toBe(CARDS.min);
    expect(cardsFloor(900, 2000)).toBe(900);
  });
  test("a choice under the floor is held to it", () => {
    expect(cardsFloor(100, 1164)).toBe(CARDS.min);
  });
});

describe("chosenWidth", () => {
  const room = 1164;
  test("a drag sets the width it let go at, rounded", () => {
    expect(chosenWidth(640.6, { start: 500, room, chosen: null })).toBe(641);
    expect(chosenWidth(420, { start: 500, room, chosen: 500 })).toBe(420);
  });
  test("is held between the floor and what fits now", () => {
    expect(chosenWidth(200, { start: 500, room, chosen: null })).toBe(CARDS.min);
    expect(chosenWidth(5000, { start: 500, room, chosen: null })).toBe(room - DOCK_KEEP);
    expect(chosenWidth(9000, { start: 500, room: 9000, chosen: null })).toBe(CARDS.max);
  });
  test("a drag let go where it started changes nothing", () => {
    expect(chosenWidth(820, { start: 820, room, chosen: null })).toBeNull();
    expect(chosenWidth(820.2, { start: 820, room, chosen: 500 })).toBe(500);
  });
  test("a key always sets", () => {
    expect(chosenWidth(832, { start: null, room, chosen: null })).toBe(832);
  });
});
