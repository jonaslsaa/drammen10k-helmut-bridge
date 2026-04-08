import { describe, expect, test } from "bun:test";
import { computeRaceState } from "./race-state";
import type { Split } from "./helmut";

const baseSplits: Split[] = [
  { km: 1, split: "2:44", last_km: "2:44", projected_finish: "27:19" },
  { km: 2, split: "5:25", last_km: "2:41", projected_finish: "27:07" },
];

describe("computeRaceState", () => {
  test("returns waiting state before the race starts", () => {
    const raceStart = new Date("2026-04-11T12:45:00.000Z");
    const now = new Date("2026-04-11T12:44:30.000Z");

    expect(
      computeRaceState({
        now,
        raceStart,
        splits: [],
        totalKm: 10,
        event: "Drammen 10K",
        category: "Male Leaders",
        recordLabel: "European Record",
        recordTime: "26:33",
      })
    ).toMatchObject({
      status: "waiting",
      race_clock: "-0:30",
      estimated_position_km: 0,
      pace_min_per_km: "0:00",
      speed_kmh: 0,
      projected_finish: "0:00",
    });
  });

  test("interpolates leader position between split points", () => {
    const raceStart = new Date("2026-04-11T12:45:00.000Z");
    const now = new Date("2026-04-11T12:50:25.000Z");

    expect(
      computeRaceState({
        now,
        raceStart,
        splits: baseSplits,
        totalKm: 10,
        event: "Drammen 10K",
        category: "Male Leaders",
        recordLabel: "European Record",
        recordTime: "26:33",
      })
    ).toMatchObject({
      status: "live",
      race_clock: "5:25",
      latest_km: 2,
      estimated_position_km: 2,
      pace_min_per_km: "2:41",
      speed_kmh: 22.4,
      projected_finish: "27:07",
    });
  });

  test("uses elapsed override for simulation interpolation", () => {
    const raceStart = new Date("2026-04-11T12:45:00.000Z");
    const now = new Date("2026-04-11T12:45:20.000Z");

    expect(
      computeRaceState({
        now,
        raceStart,
        splits: baseSplits,
        totalKm: 10,
        event: "Drammen 10K",
        category: "Male Leaders",
        recordLabel: "European Record",
        recordTime: "26:33",
        elapsedSecsOverride: 406,
      })
    ).toMatchObject({
      status: "live",
      race_clock: "6:46",
      estimated_position_km: 2.5,
      pace_min_per_km: "2:41",
      speed_kmh: 22.4,
      projected_finish: "27:07",
    });
  });

  test("freezes state at finish once total distance is reached", () => {
    const raceStart = new Date("2026-04-11T12:45:00.000Z");
    const now = new Date("2026-04-11T13:20:00.000Z");
    const finishingSplits: Split[] = [
      ...baseSplits,
      { km: 10, split: "26:53", last_km: "2:38", projected_finish: "26:53" },
    ];

    expect(
      computeRaceState({
        now,
        raceStart,
        splits: finishingSplits,
        totalKm: 10,
        event: "Drammen 10K",
        category: "Male Leaders",
        recordLabel: "European Record",
        recordTime: "26:33",
      })
    ).toMatchObject({
      status: "finished",
      race_clock: "26:53",
      latest_km: 10,
      estimated_position_km: 10,
      pace_min_per_km: "2:38",
      speed_kmh: 22.8,
      projected_finish: "26:53",
    });
  });
});
