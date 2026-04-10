import { describe, expect, test } from "bun:test";
import { applyUlFinishFallback } from "./finish-fallback";
import type { Split } from "./helmut";
import type { AllLeaderboards } from "./ul";

const baseSplits: Split[] = [
  { km: 1, split: "2:44", last_km: "2:44", projected_finish: "27:19" },
  { km: 9, split: "24:14", last_km: "2:37", projected_finish: "26:56" },
];

const leaderboards: AllLeaderboards = {
  mixed: {
    "5km_leaderboard": { title: "Standings 5 km", timing_point: "Time1", entries: [] },
    "10km_leaderboard": {
      title: "Results 10 km",
      timing_point: "Finish",
      entries: [{ position: 1, name: "Mixed Winner", country: "NOR", country_flag_url: null, time: "26:53", gap: "-" }],
    },
    auto_leaderboard: { title: "Results 10 km", timing_point: "Finish", entries: [] },
  },
  men: {
    "5km_leaderboard": { title: "Standings 5 km Men", timing_point: "Time1", entries: [] },
    "10km_leaderboard": {
      title: "Results 10 km Men",
      timing_point: "Finish",
      entries: [{ position: 1, name: "Men Winner", country: "NOR", country_flag_url: null, time: "26:51", gap: "-" }],
    },
    auto_leaderboard: { title: "Results 10 km Men", timing_point: "Finish", entries: [] },
  },
  women: {
    "5km_leaderboard": { title: "Standings 5 km Women", timing_point: "Time1", entries: [] },
    "10km_leaderboard": {
      title: "Results 10 km Women",
      timing_point: "Finish",
      entries: [{ position: 1, name: "Women Winner", country: "NOR", country_flag_url: null, time: "30:12", gap: "-" }],
    },
    auto_leaderboard: { title: "Results 10 km Women", timing_point: "Finish", entries: [] },
  },
};

describe("applyUlFinishFallback", () => {
  test("uses the men finish leaderboard for male categories", () => {
    const result = applyUlFinishFallback({
      splits: baseSplits,
      leaderboards,
      totalKm: 10,
      category: "Male Leaders",
    });

    expect(result.usedUlFinish).toBe(true);
    expect(result.finishTime).toBe("26:51");
    expect(result.splits.at(-1)).toEqual({
      km: 10,
      split: "26:51",
      last_km: "2:37",
      projected_finish: "26:51",
    });
  });

  test("uses the women finish leaderboard for female categories", () => {
    const result = applyUlFinishFallback({
      splits: baseSplits,
      leaderboards,
      totalKm: 10,
      category: "Female Leaders",
    });

    expect(result.usedUlFinish).toBe(true);
    expect(result.finishTime).toBe("30:12");
  });

  test("does not infer finish when more than one km is missing", () => {
    const result = applyUlFinishFallback({
      splits: [{ km: 8, split: "21:38", last_km: "2:41", projected_finish: "27:02" }],
      leaderboards,
      totalKm: 10,
      category: "Male Leaders",
    });

    expect(result.usedUlFinish).toBe(false);
    expect(result.splits).toHaveLength(1);
  });

  test("does not infer finish when UL finish time is not after the last split", () => {
    const result = applyUlFinishFallback({
      splits: baseSplits,
      leaderboards: {
        ...leaderboards,
        men: {
          ...leaderboards.men,
          "10km_leaderboard": {
            ...leaderboards.men["10km_leaderboard"],
            entries: [{ position: 1, name: "Broken", country: "NOR", country_flag_url: null, time: "24:00", gap: "-" }],
          },
        },
      },
      totalKm: 10,
      category: "Male Leaders",
    });

    expect(result.usedUlFinish).toBe(false);
    expect(result.splits).toEqual(baseSplits);
  });
});
