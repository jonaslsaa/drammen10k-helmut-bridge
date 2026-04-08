import { UL_EVENT_ID, UL_USER, UL_SECRET, RACE_START_OSLO } from "./env";
import { osloToUtc } from "./time";

let ulApiKey: string | null = null;

async function computeApiKey(secret: string): Promise<string> {
  const inner = new Bun.CryptoHasher("md5").update("API@UltimateLIVE").digest("hex");
  return new Bun.CryptoHasher("md5").update(secret + inner).digest("hex");
}

export const UL_ENABLED = Boolean(UL_EVENT_ID && UL_USER && UL_SECRET);

interface SyncResult {
  updated: boolean;
  newStart?: Date;
  source?: string;
}

export async function syncStartTime(
  currentStart: Date,
  log: (tag: string, msg: string) => void
): Promise<SyncResult> {
  if (!UL_EVENT_ID || !UL_USER || !UL_SECRET) return { updated: false };

  if (!ulApiKey) {
    ulApiKey = await computeApiKey(UL_SECRET);
  }

  try {
    const url = `https://live.ultimate.dk/api/data/?eventid=${UL_EVENT_ID}&type=json&method=startgroups&apiuser=${encodeURIComponent(UL_USER)}&apikey=${ulApiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      log("ul", `ERROR: HTTP ${res.status}`);
      return { updated: false };
    }

    const data = await res.json() as Record<string, unknown>;
    if ("0" in data) {
      log("ul", `API error: ${data["0"]}`);
      return { updated: false };
    }

    const records = (data as { Records?: { Record?: Array<Record<string, string>> | Record<string, string> } })
      .Records?.Record;
    if (!records) return { updated: false };

    const recordList = Array.isArray(records) ? records : [records];

    // Find a startgroup with an ActualStartTime
    for (const sg of recordList) {
      const actual = sg.ActualStartTime;
      if (actual && actual !== "00:00:00") {
        const datepart = RACE_START_OSLO.split("T")[0];
        if (!datepart) continue;
        const newStart = osloToUtc(`${datepart}T${actual}`);
        if (isNaN(newStart.getTime())) continue;

        if (newStart.getTime() !== currentStart.getTime()) {
          log("ul", `Start time updated: ${currentStart.toISOString()} -> ${newStart.toISOString()} (from startgroup "${sg.Title}")`);
          return { updated: true, newStart, source: sg.Title };
        }
        return { updated: false };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ul", `ERROR: ${msg}`);
  }

  return { updated: false };
}
