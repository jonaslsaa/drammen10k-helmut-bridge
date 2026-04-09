import { UL_EVENT_ID, UL_USER, UL_SECRET, RACE_START_OSLO } from "./env";
import { osloToUtc, timeToSeconds, secondsToTime } from "./time";

// --- API helpers ---

let ulApiKey: string | null = null;

async function getApiKey(): Promise<string> {
  if (!ulApiKey) {
    const inner = new Bun.CryptoHasher("md5").update("API@UltimateLIVE").digest("hex");
    ulApiKey = new Bun.CryptoHasher("md5").update(UL_SECRET + inner).digest("hex");
  }
  return ulApiKey;
}

export const UL_ENABLED = Boolean(UL_EVENT_ID && UL_USER && UL_SECRET);

export type UlRecord = Record<string, string>;

interface UlResponse {
  Info?: { Records: string };
  Records?: { Record?: UlRecord[] | UlRecord };
  "0"?: string;
}

export async function ulFetch(method: string, params: Record<string, string> = {}): Promise<UlRecord[]> {
  const apikey = await getApiKey();
  const qs = new URLSearchParams({
    eventid: UL_EVENT_ID,
    type: "json",
    method,
    apiuser: UL_USER,
    apikey,
    ...params,
  });
  const res = await fetch(`https://live.ultimate.dk/api/data/?${qs}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = (await res.json()) as UlResponse;
  if (data["0"]) throw new Error(`API: ${data["0"]}`);

  const records = data.Records?.Record;
  if (!records) return [];
  return Array.isArray(records) ? records : [records];
}

// --- Start time sync ---

interface SyncResult {
  updated: boolean;
  newStart?: Date;
}

export async function syncStartTime(
  currentStart: Date,
  log: (tag: string, msg: string) => void
): Promise<SyncResult> {
  if (!UL_ENABLED) return { updated: false };

  try {
    const records = await ulFetch("startgroups");

    for (const sg of records) {
      const actual = sg.ActualStartTime;
      if (actual && actual !== "00:00:00") {
        const datepart = RACE_START_OSLO.split("T")[0];
        if (!datepart) continue;
        const newStart = osloToUtc(`${datepart}T${actual}`);
        if (isNaN(newStart.getTime())) continue;

        if (newStart.getTime() !== currentStart.getTime()) {
          log("ul", `Start time updated: ${currentStart.toISOString()} -> ${newStart.toISOString()} (from "${sg.Title}")`);
          return { updated: true, newStart };
        }
        return { updated: false };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ul", `ERROR (startgroups): ${msg}`);
  }

  return { updated: false };
}

// --- Leaderboard ---

// --- IOC to flag URL ---
// @ts-ignore no types available
import { convertIocCode } from "convert-country-codes";

export function iocToFlagUrl(iocCode: string): string | null {
  const result = convertIocCode(iocCode.toUpperCase());
  if (!result?.iso2) return null;
  return `https://raw.githubusercontent.com/lipis/flag-icons/main/flags/4x3/${result.iso2.toLowerCase()}.svg`;
}

export interface LeaderboardEntry {
  position: number;
  name: string;
  country: string;
  country_flag_url: string | null;
  time: string;
  gap: string;
}

export interface Leaderboard {
  title: string;
  timing_point: string;
  entries: LeaderboardEntry[];
}

export interface LeaderboardSet {
  "5km_leaderboard": Leaderboard;
  "10km_leaderboard": Leaderboard;
  auto_leaderboard: Leaderboard;
}

export interface AllLeaderboards {
  mixed: LeaderboardSet;
  men: LeaderboardSet;
  women: LeaderboardSet;
}

function formatTime(time: string): string {
  return time.replace(/^00?:/, "");
}

function computeGap(leaderSecs: number, runnerSecs: number): string {
  const diff = runnerSecs - leaderSecs;
  if (diff <= 0) return "+0:00";
  return `+${secondsToTime(diff)}`;
}

export function buildLeaderboard(records: UlRecord[], title: string, timingPoint: string): Leaderboard {
  if (records.length === 0) {
    return { title, timing_point: timingPoint, entries: [] };
  }

  const leaderTime = records[0]?.Time ?? "0:00:00";
  const leaderSecs = timeToSeconds(leaderTime);

  const entries: LeaderboardEntry[] = records.map((r, i) => {
    const name = [r.FirstName, r.LastName].filter(Boolean).join(" ");
    const country = r.NationCode || r.Nation || "";
    const runnerTime = r.Time || "0:00:00";
    const runnerSecs = timeToSeconds(runnerTime);

    return {
      position: i + 1,
      name,
      country,
      country_flag_url: iocToFlagUrl(country),
      time: formatTime(runnerTime),
      gap: i === 0 ? "-" : computeGap(leaderSecs, runnerSecs),
    };
  });

  return { title, timing_point: timingPoint, entries };
}

function emptyLeaderboard(title: string, timingPoint: string): Leaderboard {
  return { title, timing_point: timingPoint, entries: [] };
}

function sortRecordsByTime(records: UlRecord[]): UlRecord[] {
  return [...records].sort((a, b) => {
    const aSecs = timeToSeconds(a.Time || "99:59:59");
    const bSecs = timeToSeconds(b.Time || "99:59:59");
    return aSecs - bSecs;
  });
}

export function buildLeaderboardSet(
  records5km: UlRecord[],
  records10km: UlRecord[],
  sexLabel: string,
  maxEntries: number,
): LeaderboardSet {
  const filtered5km = sortRecordsByTime(records5km).slice(0, maxEntries);
  const filtered10km = sortRecordsByTime(records10km).slice(0, maxEntries);

  const suffix = sexLabel ? ` ${sexLabel}` : "";

  const lb5km = filtered5km.length > 0
    ? buildLeaderboard(filtered5km, `Standings 5 km${suffix}`, "Time1")
    : emptyLeaderboard(`Standings 5 km${suffix}`, "Time1");

  const lb10km = filtered10km.length > 0
    ? buildLeaderboard(filtered10km, `Results 10 km${suffix}`, "Finish")
    : emptyLeaderboard(`Results 10 km${suffix}`, "Finish");

  const auto = lb10km.entries.length > 0 ? lb10km : lb5km;

  return {
    "5km_leaderboard": lb5km,
    "10km_leaderboard": lb10km,
    auto_leaderboard: auto,
  };
}

export async function fetchAllLeaderboards(
  maxEntries: number,
  log: (tag: string, msg: string) => void,
): Promise<AllLeaderboards | null> {
  if (!UL_ENABLED) return null;

  try {
    // Fetch all results at both timing points in parallel (no sex filter)
    const [all5km, all10km] = await Promise.all([
      ulFetch("timingpointstandings", { time: "Time1", records: "100" }).catch(() => [] as UlRecord[]),
      ulFetch("timingpointstandings", { time: "Finish", records: "100" }).catch(() => [] as UlRecord[]),
    ]);

    // Split by gender
    const men5km = all5km.filter((r) => r.Gender === "M");
    const men10km = all10km.filter((r) => r.Gender === "M");
    const women5km = all5km.filter((r) => r.Gender === "W");
    const women10km = all10km.filter((r) => r.Gender === "W");

    const mixed = buildLeaderboardSet(all5km, all10km, "", maxEntries);
    const men = buildLeaderboardSet(men5km, men10km, "Men", maxEntries);
    const women = buildLeaderboardSet(women5km, women10km, "Women", maxEntries);

    const mx5 = mixed["5km_leaderboard"].entries.length;
    const mx10 = mixed["10km_leaderboard"].entries.length;
    const m5 = men["5km_leaderboard"].entries.length;
    const m10 = men["10km_leaderboard"].entries.length;
    const w5 = women["5km_leaderboard"].entries.length;
    const w10 = women["10km_leaderboard"].entries.length;

    if (mx5 + mx10 + m5 + m10 + w5 + w10 > 0) {
      log("ul", `Leaderboards: Mixed 5km=${mx5} 10km=${mx10} | Men 5km=${m5} 10km=${m10} | Women 5km=${w5} 10km=${w10}`);
    }

    return { mixed, men, women };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ul", `ERROR (leaderboards): ${msg}`);
    return null;
  }
}
