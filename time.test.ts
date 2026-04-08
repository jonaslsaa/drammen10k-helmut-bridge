import { describe, expect, test } from "bun:test";
import { osloToUtc, secondsToTime, timeToSeconds } from "./time";

describe("time helpers", () => {
  test("converts mm:ss and hh:mm:ss to seconds", () => {
    expect(timeToSeconds("2:44")).toBe(164);
    expect(timeToSeconds("1:02:03")).toBe(3723);
  });

  test("formats seconds back to race-clock strings", () => {
    expect(secondsToTime(164)).toBe("2:44");
    expect(secondsToTime(3723)).toBe("1:02:03");
  });

  test("converts Oslo local race start to UTC", () => {
    expect(osloToUtc("2026-04-11T14:45").toISOString()).toBe(
      "2026-04-11T12:45:00.000Z"
    );
  });
});
