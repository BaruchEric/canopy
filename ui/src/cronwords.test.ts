import { expect, test } from "bun:test";
import { isCron } from "../../src/core/cron";
import { CRON_PRESETS, bumpField, cronLegend, cronWords, fieldAt, fieldSpan } from "./cronwords";

test("a line reads as a sentence", () => {
  const says: [string, string][] = [
    ["* * * * *", "Every minute"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["0,30 * * * *", "Every 30 minutes"],
    ["0 * * * *", "Every hour at :00"],
    ["15,45 * * * *", "Every hour at :15 and :45"],
    ["0 */2 * * *", "Every 2 hours"],
    ["30 */6 * * *", "Every 6 hours at :30"],
    ["0 9 * * *", "Every day at 09:00"],
    ["5 4 * * *", "Every day at 04:05"],
    ["0 9,17 * * *", "Every day at 09:00 and 17:00"],
    ["0 0,6 * * *", "Every day at 00:00 and 06:00"],
    ["0 9 * * 1-5", "Weekdays at 09:00"],
    ["0 22 * * 6,0", "Weekends at 22:00"],
    ["30 4 * * 1", "Mondays at 04:30"],
    ["0 5 * * 1,3,5", "Mondays, Wednesdays and Fridays at 05:00"],
    ["0 5 * * 1-6", "Mondays to Saturdays at 05:00"],
    ["0 3 1 * *", "The 1st of the month at 03:00"],
    ["0 3 1,15 * *", "The 1st and 15th of the month at 03:00"],
    ["0 3 1-7 * *", "The 1st to the 7th of the month at 03:00"],
    ["0 0 1 1 *", "The 1st of January at 00:00"],
    ["0 9 * 6-8 *", "Every day in June to August at 09:00"],
    ["0 9 * 1,7 1", "Mondays in January and July at 09:00"],
    ["0 9-17 * * 1-5", "Every hour from 09:00 to 17:00 on weekdays"],
    ["*/5 9-17 * * *", "Every 5 minutes from 09:00 to 17:59"],
    ["* 3 * * *", "Every minute from 03:00 to 03:59"],
    ["*/15 * * * 1-5", "Every 15 minutes on weekdays"],
    ["*/10 * 1 * *", "Every 10 minutes on the 1st of the month"],
    ["@daily", "Every day at 00:00"],
    ["@hourly", "Every hour at :00"],
    ["@weekly", "Sundays at 00:00"],
  ];
  for (const [line, words] of says) expect([line, cronWords(line)]).toEqual([line, words]);
});

test("the days read as cron counts them: either field when both are set, both when one is starred", () => {
  expect(cronWords("0 9 1,15 * 1")).toBe("The 1st and 15th of the month and Mondays at 09:00");
  expect(cronWords("0 9 */2 * 1")).toBe("Mondays that fall on every 2nd day of the month at 09:00");
  // a day field that covers every day, with neither starred, leaves no day out
  expect(cronWords("0 9 1-31 * 1")).toBe("Every day at 09:00");
  expect(cronWords("0 9 1 * 0-6")).toBe("Every day at 09:00");
});

test("a line with too many times to list falls back on its fields", () => {
  expect(cronWords("0,10,20,35,50 * * * *")).toBe("At minute 0, 10, 20, 35, 50 of every hour");
  expect(cronWords("5,10 1,2,3,7 * * *")).toBe("At minute 5, 10 of hour 1-3, 7");
});

test("a line that does not read has no words", () => {
  expect(cronWords("")).toBeNull();
  expect(cronWords("0 9 * *")).toBeNull();
  expect(cronWords("61 9 * * *")).toBeNull();
});

test("every preset is a line that reads, labelled in the words it would be given", () => {
  for (const p of CRON_PRESETS) {
    expect(isCron(p.line)).toBe(true);
    expect(cronWords(p.line)).not.toBeNull();
  }
});

test("the legend names the five fields, an @ word written out, a field not typed yet left empty", () => {
  expect(cronLegend("0 9 * * 1-5").map((f) => `${f.name}=${f.token}`)).toEqual(["minute=0", "hour=9", "day=*", "month=*", "weekday=1-5"]);
  expect(cronLegend("@daily").map((f) => f.token)).toEqual(["0", "0", "*", "*", "*"]);
  expect(cronLegend("0 9").map((f) => f.token)).toEqual(["0", "9", "", "", ""]);
});

test("the caret is in the field it touches, or the one that follows the gap it sits in", () => {
  const line = "0 9 * * 1-5";
  expect(fieldAt(line, 0)).toBe(0);
  expect(fieldAt(line, 1)).toBe(0);
  expect(fieldAt(line, 2)).toBe(1);
  expect(fieldAt(line, 8)).toBe(4);
  expect(fieldAt(line, line.length)).toBe(4);
  expect(fieldAt("0  9", 2)).toBe(1);
  expect(fieldAt("@daily", 3)).toBeNull();
  expect(fieldAt("", 0)).toBeNull();
  expect(fieldAt("0 9 * * 1 extra", 12)).toBeNull();
  expect(fieldSpan(line, 4)).toEqual({ start: 8, end: 11 });
  expect(fieldSpan("@daily", 0)).toBeNull();
});

test("a press steps the number under the caret and wraps inside its field", () => {
  expect(bumpField("0 9 * * *", 3, 1)).toEqual({ line: "0 10 * * *", caret: 4 });
  expect(bumpField("0 10 * * *", 4, -1)).toEqual({ line: "0 9 * * *", caret: 3 });
  expect(bumpField("59 9 * * *", 1, 1)?.line).toBe("0 9 * * *");
  expect(bumpField("0 0 * * *", 3, -1)?.line).toBe("0 23 * * *");
  expect(bumpField("0 9 31 * *", 5, 1)?.line).toBe("0 9 1 * *");
  expect(bumpField("0 9 * 1 *", 7, -1)?.line).toBe("0 9 * 12 *");
  expect(bumpField("0 9 * * 6", 9, 1)?.line).toBe("0 9 * * 0");
});

test("a star takes the field's first value going up and its last going down", () => {
  expect(bumpField("* * * * *", 0, 1)).toEqual({ line: "0 * * * *", caret: 1 });
  expect(bumpField("0 * * * *", 3, -1)).toEqual({ line: "0 23 * * *", caret: 4 });
});

test("in a field of several numbers the press takes the one the caret is on; a step starts at 1", () => {
  expect(bumpField("0 9 * * 1-5", 10, 1)?.line).toBe("0 9 * * 1-6");
  expect(bumpField("0 9 * * 1-5", 8, 1)?.line).toBe("0 9 * * 2-5");
  expect(bumpField("*/15 * * * *", 4, 1)?.line).toBe("*/16 * * * *");
  expect(bumpField("*/1 * * * *", 3, -1)?.line).toBe("*/59 * * * *");
  expect(bumpField("0,30 * * * *", 1, 1)?.line).toBe("1,30 * * * *");
  expect(bumpField("0,30 * * * *", 2, 1)?.line).toBe("0,31 * * * *");
  expect(bumpField("@daily", 2, 1)).toBeNull();
});
