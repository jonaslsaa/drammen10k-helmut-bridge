import { serve } from "bun";
import { parseArgs } from "util";
import {
  FLOWICS_PUSH_URL, FLOWICS_TOKEN,
  HELMUT_URL, RACE_START_OSLO,
  TOTAL_KM, EVENT_NAME, CATEGORY,
  RECORD_LABEL, RECORD_TIME,
  POLL_INTERVAL_MS, STATUS_PORT,
  UL_EVENT_ID, UL_SYNC_INTERVAL_MS, UL_LEADERBOARD_SIZE,
} from "./env";
import { timeToSeconds, osloToUtc, log } from "./time";
import { type Split, fetchHelmutData, parsePlainTextSplits, getHelmutStats } from "./helmut";
import { UL_ENABLED, syncStartTime, fetchAllLeaderboards, buildLeaderboardSet, type AllLeaderboards, type UlRecord } from "./ul";
import { computeRaceState, type RaceState } from "./race-state";
import { applyUlFinishFallback } from "./finish-fallback";

// --- CLI args (runtime-only flags) ---
const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    simulate: { type: "string" },
    "simulate-interval": { type: "string", default: "10" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(`
Usage: bun run index.ts [options]

Config is loaded from .env file. See .env.example for all variables.

Options:
  --dry-run                Run without pushing to Flowics
  --simulate <file>        Simulate a race from a test data file (releases splits one by one)
  --simulate-interval <s>  Seconds between each simulated split (default: 10)
  -h, --help               Show this help

Examples:
  bun run index.ts --dry-run
  bun run index.ts --simulate testdata.txt --dry-run
  bun run index.ts --simulate testdata.txt
`);
  process.exit(0);
}

const DRY_RUN = args["dry-run"] || false;
const SIMULATE_FILE = args["simulate"] || "";
const SIMULATE_INTERVAL_S = Number(args["simulate-interval"]);

// --- Race start time (mutable — can be updated by Ultimate Live) ---
let RACE_START: Date = osloToUtc(RACE_START_OSLO);
let raceStartSource: "cli" | "ultimate-live" = "cli";

// --- Compute full race state ---
function buildRaceState(splits: Split[]): RaceState {
  const now = new Date();
  let elapsedSecsOverride: number | undefined;

  if (SIMULATE_FILE && simStartTime && splits.length > 0) {
    const latestSplitSecs = timeToSeconds(splits[splits.length - 1]?.split ?? "0");
    const realSecsSinceStart = (now.getTime() - simStartTime.getTime()) / 1000;
    const realSecsSinceLastRelease = realSecsSinceStart % SIMULATE_INTERVAL_S;
    const fractionToNextSplit = realSecsSinceLastRelease / SIMULATE_INTERVAL_S;
    const lastLapSecs = timeToSeconds(splits[splits.length - 1]?.last_km ?? "0");
    elapsedSecsOverride = latestSplitSecs + fractionToNextSplit * lastLapSecs;
  }

  return computeRaceState({
    now,
    raceStart: RACE_START,
    splits,
    totalKm: TOTAL_KM,
    event: EVENT_NAME,
    category: CATEGORY,
    recordLabel: RECORD_LABEL,
    recordTime: RECORD_TIME,
    elapsedSecsOverride,
  });
}

// --- Simulate mode ---
let allSimSplits: Split[] = [];
let simStartTime: Date | null = null;
let simLeaderboard5km: UlRecord[] = [];
let simLeaderboard10km: UlRecord[] = [];

if (SIMULATE_FILE) {
  const file = Bun.file(SIMULATE_FILE);
  if (!(await file.exists())) {
    console.error(`Simulate file not found: ${SIMULATE_FILE}`);
    process.exit(1);
  }
  const text = await file.text();
  allSimSplits = parsePlainTextSplits(text);
  if (allSimSplits.length === 0) {
    console.error(`No splits found in ${SIMULATE_FILE}`);
    process.exit(1);
  }
  simStartTime = new Date();
  RACE_START = simStartTime;
  log("sim", `Loaded ${allSimSplits.length} splits from ${SIMULATE_FILE}`);
  log("sim", `Will release one split every ${SIMULATE_INTERVAL_S}s`);

  // Load simulated leaderboard data if available
  const lbFile = Bun.file("testdata_leaderboard.json");
  if (await lbFile.exists()) {
    const lbData = await lbFile.json() as { "5km"?: UlRecord[]; "10km"?: UlRecord[] };
    simLeaderboard5km = lbData["5km"] ?? [];
    simLeaderboard10km = lbData["10km"] ?? [];
    log("sim", `Loaded leaderboard data: 5km=${simLeaderboard5km.length} 10km=${simLeaderboard10km.length} entries`);
  }
}

function getSimulatedLeaderboards(currentKm: number): AllLeaderboards | null {
  if (simLeaderboard5km.length === 0 && simLeaderboard10km.length === 0) return null;

  const all5km = currentKm >= 5 ? simLeaderboard5km : [];
  const all10km = currentKm >= 10 ? simLeaderboard10km : [];

  const men5km = all5km.filter((r) => r.Gender === "M");
  const men10km = all10km.filter((r) => r.Gender === "M");
  const women5km = all5km.filter((r) => r.Gender === "W");
  const women10km = all10km.filter((r) => r.Gender === "W");

  const maxEntries = UL_LEADERBOARD_SIZE;

  return {
    mixed: buildLeaderboardSet(all5km, all10km, "", maxEntries),
    men: buildLeaderboardSet(men5km, men10km, "Men", maxEntries),
    women: buildLeaderboardSet(women5km, women10km, "Women", maxEntries),
  };
}

function getSimulatedSplits(): Split[] {
  if (!simStartTime) return [];
  const elapsed = (Date.now() - simStartTime.getTime()) / 1000;
  const released = Math.min(
    Math.floor(elapsed / SIMULATE_INTERVAL_S),
    allSimSplits.length
  );
  return allSimSplits.slice(0, released);
}

// --- State ---
let lastKnownSplits: Split[] = [];
let lastSplitCount = 0;
let lastState: RaceState | null = null;
let lastLeaderboards: AllLeaderboards | null = null;
let pushSuccessCount = 0;
let pushErrorCount = 0;
let lastLoggedUlFinish: string | null = null;

// --- Push to Flowics ---
async function pushToFlowics(state: RaceState): Promise<void> {
  if (DRY_RUN || !FLOWICS_PUSH_URL) return;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (FLOWICS_TOKEN) {
      headers["Authorization"] = `Bearer ${FLOWICS_TOKEN}`;
    }
    const res = await fetch(FLOWICS_PUSH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...state, ...lastLeaderboards }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      pushErrorCount++;
      log("push", `ERROR: Flowics responded ${res.status}`);
    } else {
      pushSuccessCount++;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pushErrorCount++;
    log("push", `ERROR: ${msg}`);
  }
}

// --- Main tick ---
async function tick() {
  let splits: Split[] | null;

  if (SIMULATE_FILE) {
    splits = getSimulatedSplits();
  } else {
    splits = await fetchHelmutData(HELMUT_URL, log);
  }

  if (splits !== null) {
    lastKnownSplits = splits;
    if (splits.length !== lastSplitCount) {
      log("split", `New split! ${splits.length}/${TOTAL_KM} km recorded`);
      const latest = splits.at(-1);
      if (latest) {
        log("split", `  ${latest.km} km: ${latest.split} | lap: ${latest.last_km} | proj: ${latest.projected_finish}`);
      }
      lastSplitCount = splits.length;
    }
  } else {
    log("fetch", `Using last known data (${lastKnownSplits.length} splits)`);
  }

  const finishFallback = applyUlFinishFallback({
    splits: lastKnownSplits,
    leaderboards: lastLeaderboards,
    totalKm: TOTAL_KM,
    category: CATEGORY,
  });
  const splitsForState = finishFallback.splits;
  if (finishFallback.usedUlFinish && finishFallback.finishTime) {
    if (finishFallback.finishTime !== lastLoggedUlFinish) {
      log("ul-finish", `Using UL finish time: ${finishFallback.finishTime} (from leaderboard)`);
      lastLoggedUlFinish = finishFallback.finishTime;
    }
  } else {
    lastLoggedUlFinish = null;
  }

  const state = buildRaceState(splitsForState);
  lastState = state;

  // Update leaderboards in simulate mode based on current km
  if (SIMULATE_FILE) {
    const simLb = getSimulatedLeaderboards(state.latest_km);
    if (simLb) lastLeaderboards = simLb;
  }

  log("tick", `${state.status} | clock: ${state.race_clock} | lead: ${state.estimated_position_km} km | pace: ${state.pace_min_per_km}/km | proj: ${state.projected_finish}`);

  await pushToFlowics(state);
}

// --- UL sync tick ---
async function ulSyncTick() {
  const [startResult, leaderboards] = await Promise.all([
    syncStartTime(RACE_START, log),
    fetchAllLeaderboards(UL_LEADERBOARD_SIZE, log),
  ]);

  if (startResult.updated && startResult.newStart) {
    RACE_START = startResult.newStart;
    raceStartSource = "ultimate-live";
  }

  if (leaderboards) {
    lastLeaderboards = leaderboards;
  }
}

// --- Status server ---
serve({
  port: STATUS_PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/status") {
      const helmutStats = getHelmutStats();
      return Response.json({
        ok: true,
        config: {
          helmut_url: HELMUT_URL,
          flowics_push_url: DRY_RUN ? "(dry run)" : FLOWICS_PUSH_URL,
          race_start_oslo: RACE_START_OSLO,
          race_start_utc: RACE_START.toISOString(),
          race_start_source: raceStartSource,
          poll_interval_ms: POLL_INTERVAL_MS,
          total_km: TOTAL_KM,
          event: EVENT_NAME,
          category: CATEGORY,
          ul_enabled: UL_ENABLED,
        },
        stats: {
          fetch_success: helmutStats.fetchSuccessCount,
          fetch_errors: helmutStats.fetchErrorCount,
          push_success: pushSuccessCount,
          push_errors: pushErrorCount,
          last_fetch_error: helmutStats.lastFetchError,
        },
        state: lastState,
        leaderboards: lastLeaderboards,
      });
    }

    return Response.redirect(`http://localhost:${STATUS_PORT}/status`, 302);
  },
});

// --- Start ---
log("start", "=== Helmut Bridge ===");
if (SIMULATE_FILE) {
  log("start", `Mode:     SIMULATE from ${SIMULATE_FILE} (1 split every ${SIMULATE_INTERVAL_S}s)`);
} else {
  log("start", `Source:   ${HELMUT_URL}`);
  log("start", `Start:    ${RACE_START_OSLO} Oslo (${RACE_START.toISOString()} UTC)`);
}
log("start", `Push to:  ${DRY_RUN ? "(dry run)" : FLOWICS_PUSH_URL}`);
log("start", `Interval: ${POLL_INTERVAL_MS}ms`);
log("start", `Race:     ${EVENT_NAME} — ${CATEGORY}`);
if (UL_ENABLED) {
  log("start", `UL sync:  event ${UL_EVENT_ID}, every ${UL_SYNC_INTERVAL_MS}ms`);
}
log("start", `Status:   http://localhost:${STATUS_PORT}/status`);
log("start", "");

tick();
setInterval(tick, POLL_INTERVAL_MS);

if (UL_ENABLED && !SIMULATE_FILE) {
  ulSyncTick();
  setInterval(ulSyncTick, UL_SYNC_INTERVAL_MS);
}
