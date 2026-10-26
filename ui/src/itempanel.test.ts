import { describe, expect, test } from "bun:test";
import { isPopupPanel, isReservedPanel, isRunPanel, panelOfItem, popupOfPanel, popupPanel, runOfPanel, runPanel } from "./itempanel";

describe("run panels", () => {
  test("round trip, and nothing else reads as one", () => {
    const id = runPanel("r1");
    expect(id).toBe("/run/r1");
    expect(isRunPanel(id)).toBe(true);
    expect(runOfPanel(id)).toBe("r1");
    expect(isRunPanel("/run/")).toBe(false);
    expect(isRunPanel("/agent/claude:abc")).toBe(false);
    expect(runOfPanel("web-apps/ripe")).toBeNull();
  });
});

describe("popup panels", () => {
  test("a popup by name, waiting on you and health keeping their own panels", () => {
    expect(popupPanel("inbox")).toBe("/popup/inbox");
    expect(popupPanel("waiting")).toBe("/waiting");
    expect(popupPanel("health")).toBe("/health");
    expect(isPopupPanel("/popup/inbox")).toBe(true);
    expect(popupOfPanel("/popup/inbox")).toBe("inbox");
    // their own ids answer by name, but are not `/popup/` panels
    expect(popupOfPanel("/waiting")).toBe("waiting");
    expect(popupOfPanel("/health")).toBe("health");
    expect(isPopupPanel("/waiting")).toBe(false);
  });

  test("a name no popup has is no panel", () => {
    expect(isPopupPanel("/popup/")).toBe(false);
    expect(isPopupPanel("/popup/weather")).toBe(false);
    expect(popupOfPanel("/popup/weather")).toBeNull();
    expect(popupOfPanel("web-apps/ripe")).toBeNull();
  });
});

describe("panelOfItem", () => {
  test("each kind opens as its own panel", () => {
    expect(panelOfItem({ kind: "run", ref: "r1" })).toBe("/run/r1");
    expect(panelOfItem({ kind: "agent", ref: "claude:abc" })).toBe("/agent/claude:abc");
    expect(panelOfItem({ kind: "popup", ref: "tasks" })).toBe("/popup/tasks");
    expect(panelOfItem({ kind: "popup", ref: "waiting" })).toBe("/waiting");
    expect(panelOfItem({ kind: "popup", ref: "weather" })).toBeNull();
  });
});

describe("isReservedPanel", () => {
  test("every panel that is no repo's, and no repo", () => {
    for (const id of ["/waiting", "/cli", "/health", "/agent/claude:abc", "/run/r1", "/popup/inbox"]) expect(isReservedPanel(id)).toBe(true);
    for (const id of ["web-apps/ripe", "mini|web-apps/ripe", "/popup/weather", "/run/", "/agent/"]) expect(isReservedPanel(id)).toBe(false);
  });
});
