import { describe, expect, mock, test } from "bun:test";

process.env.FLOWICS_PUSH_URL ||= "https://example.com/flowics";
process.env.HELMUT_URL ||= "https://example.com/helmut";
process.env.RACE_START ||= "2026-04-11T14:45";
process.env.UL_EVENT_ID ||= "7069";
process.env.UL_USER ||= "test-user";
process.env.UL_SECRET ||= "test-secret";

const { buildLeaderboard, buildLeaderboardSet, fetchAllLeaderboards } = await import("./ul");

describe("buildLeaderboard", () => {
  test("formats gaps, times, and flag URLs", () => {
    const leaderboard = buildLeaderboard(
      [
        {
          FirstName: "Jakob",
          LastName: "Ingebrigtsen",
          NationCode: "NOR",
          Time: "00:13:33",
        },
        {
          FirstName: "Grant",
          LastName: "Fisher",
          NationCode: "USA",
          Time: "00:13:36",
        },
      ],
      "Standings 5 km",
      "Time1"
    );

    expect(leaderboard).toEqual({
      title: "Standings 5 km",
      timing_point: "Time1",
      entries: [
        {
          position: 1,
          name: "Jakob Ingebrigtsen",
          country: "NOR",
          country_flag_url:
            "https://raw.githubusercontent.com/lipis/flag-icons/main/flags/4x3/no.svg",
          time: "13:33",
          gap: "-",
        },
        {
          position: 2,
          name: "Grant Fisher",
          country: "USA",
          country_flag_url:
            "https://raw.githubusercontent.com/lipis/flag-icons/main/flags/4x3/us.svg",
          time: "13:36",
          gap: "+0:03",
        },
      ],
    });
  });
});

describe("buildLeaderboardSet", () => {
  test("sorts by time before truncating to max entries", () => {
    const set = buildLeaderboardSet(
      [
        { FirstName: "Third", LastName: "Place", NationCode: "NOR", Time: "00:13:41" },
        { FirstName: "Leader", LastName: "Runner", NationCode: "USA", Time: "00:13:33" },
        { FirstName: "Second", LastName: "Runner", NationCode: "SWE", Time: "00:13:36" },
      ],
      [],
      "",
      2
    );

    expect(set["5km_leaderboard"].entries.map((entry) => entry.name)).toEqual([
      "Leader Runner",
      "Second Runner",
    ]);
    expect(set["5km_leaderboard"].entries.map((entry) => entry.position)).toEqual([
      1,
      2,
    ]);
    expect(set.auto_leaderboard.title).toBe("Standings 5 km");
  });
});

describe("fetchAllLeaderboards", () => {
  test("splits mixed and women leaderboards from timing point results", async () => {
    const originalFetch = globalThis.fetch;

    const allTime1 = [
      { FirstName: "Male", LastName: "Leader", NationCode: "NOR", Gender: "M", Time: "00:13:33" },
      { FirstName: "Female", LastName: "Chaser", NationCode: "NOR", Gender: "W", Time: "00:15:13" },
      { FirstName: "Female", LastName: "Leader", NationCode: "SWE", Gender: "W", Time: "00:15:10" },
    ];
    const allFinish = [
      { FirstName: "Male", LastName: "Winner", NationCode: "NOR", Gender: "M", Time: "00:26:53" },
    ];

    // @ts-ignore mock fetch for testing
    globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      const isTime1 = url.includes("time=Time1");
      const isMen = url.includes("sex=M");
      const isWomen = url.includes("sex=W");
      const pool = isTime1 ? allTime1 : allFinish;
      const filtered = isMen ? pool.filter(r => r.Gender === "M")
        : isWomen ? pool.filter(r => r.Gender === "W")
        : pool;

      return new Response(JSON.stringify({
        Records: { Record: filtered.length === 1 ? filtered[0] : filtered },
      }));
    }) as typeof fetch;

    try {
      const leaderboards = await fetchAllLeaderboards(2, () => {});

      expect(leaderboards).not.toBeNull();
      expect(leaderboards?.mixed["5km_leaderboard"].entries.map((entry) => entry.name)).toEqual([
        "Male Leader",
        "Female Leader",
      ]);
      expect(leaderboards?.women["5km_leaderboard"].entries.map((entry) => entry.name)).toEqual([
        "Female Leader",
        "Female Chaser",
      ]);
      expect(leaderboards?.mixed.auto_leaderboard.title).toBe("Results 10 km");
      expect(leaderboards?.women.auto_leaderboard.title).toBe("Standings 5 km Women");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
