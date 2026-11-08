import { describe, expect, test } from "bun:test";
import { pictureName } from "./clipfiles";

describe("clipboard files in the page", () => {
  test("a picture from a clipboard is named for the local time it was taken", () => {
    const at = new Date(2026, 10, 7, 9, 4, 5);
    expect(pictureName("image/png", at)).toBe("picture 2026-11-07 09.04.05.png");
    expect(pictureName("image/jpeg", at)).toBe("picture 2026-11-07 09.04.05.jpg");
    expect(pictureName("image/svg+xml", at)).toBe("picture 2026-11-07 09.04.05.svgxml");
    expect(pictureName("", at)).toBe("picture 2026-11-07 09.04.05.png");
  });
});
