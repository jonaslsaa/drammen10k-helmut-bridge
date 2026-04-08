import { serve } from "bun";
import { parseArgs } from "util";
import {
  FLOWICS_PUSH_URL, FLOWICS_TOKEN,
  HELMUT_URL, RACE_START_OSLO,
  TOTAL_KM, EVENT_NAME, CATEGORY,
  POLL_INTERVAL_MS, STATUS_PORT,
  UL_EVENT_ID, UL_SYNC_INTERVAL_MS,
} from "./env";
import { timeToSeconds, secondsToTime, osloToUtc, log } from "./time";
import { type Split, fetchHelmutData, parsePlainTextSplits, getHelmutStats } from "./helmut";
import { UL_ENABLED, syncStartTime } from "./ul";

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

// --- Race state types ---
interface RaceState {
  event: string;
  category: string;
  status: "waiting" | "live" | "finished";
  race_clock: string;
  latest_km: number;
  total_km: number;
  estimated_position_km: number;
  pace_min_per_km: string;
  speed_kmh: number;
  projected_finish: string;
  splits: Split[];
}

// --- Race start time (mutable — can be updated by Ultimate Live) ---
let RACE_START: Date = osloToUtc(RACE_START_OSLO);
let raceStartSource: "cli" | "ultimate-live" = "cli";

// --- Compute full race state ---
function computeRaceState(splits: Split[]): RaceState {
  const now = new Date();
  let elapsedSecs = (now.getTime() - RACE_START.getTime()) / 1000;

  if (SIMULATE_FILE && simStartTime && splits.length > 0) {
    const latestSplitSecs = timeToSeconds(splits[splits.length - 1]?.split ?? "0");
    const realSecsSinceStart = (now.getTime() - simStartTime.getTime()) / 1000;
    const realSecsSinceLastRelease = realSecsSinceStart % SIMULATE_INTERVAL_S;
    const fractionToNextSplit = realSecsSinceLastRelease / SIMULATE_INTERVAL_S;
    const lastLapSecs = timeToSeconds(splits[splits.length - 1]?.last_km ?? "0");
    elapsedSecs = latestSplitSecs + fractionToNextSplit * lastLapSecs;
  }

  const latestSplit = splits.at(-1) ?? null;
  const isFinished = latestSplit !== null && latestSplit.km >= TOTAL_KM;

  const status: RaceState["status"] =
    elapsedSecs < 0 ? "waiting" : isFinished ? "finished" : "live";

  const raceClock =
    status === "waiting"
      ? `-${secondsToTime(-elapsedSecs)}`
      : isFinished && latestSplit
        ? latestSplit.split
        : secondsToTime(elapsedSecs);

  let estimatedKm = 0;
  let paceMinPerKm = "0:00";
  let speedKmh = 0;
  let projectedFinish = "0:00";

  if (latestSplit && elapsedSecs > 0) {
    const lastKmSecs = timeToSeconds(latestSplit.last_km);
    const splitSecs = timeToSeconds(latestSplit.split);

    if (isFinished) {
      estimatedKm = TOTAL_KM;
    } else {
      const secsSinceLastSplit = elapsedSecs - splitSecs;
      if (secsSinceLastSplit > 0 && lastKmSecs > 0) {
        estimatedKm = latestSplit.km + secsSinceLastSplit / lastKmSecs;
      } else {
        estimatedKm = latestSplit.km;
      }
      estimatedKm = Math.min(estimatedKm, TOTAL_KM);
    }
    estimatedKm = Math.round(estimatedKm * 10) / 10;

    paceMinPerKm = latestSplit.last_km;
    speedKmh =
      lastKmSecs > 0 ? Math.round((3600 / lastKmSecs) * 10) / 10 : 0;
    projectedFinish = latestSplit.projected_finish;
  }

  return {
    event: EVENT_NAME,
    category: CATEGORY,
    status,
    race_clock: raceClock,
    latest_km: latestSplit?.km ?? 0,
    total_km: TOTAL_KM,
    estimated_position_km: estimatedKm,
    pace_min_per_km: paceMinPerKm,
    speed_kmh: speedKmh,
    projected_finish: projectedFinish,
    splits,
  };
}

// --- Simulate mode ---
let allSimSplits: Split[] = [];
let simStartTime: Date | null = null;

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
let pushSuccessCount = 0;
let pushErrorCount = 0;

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
      body: JSON.stringify(state),
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
    splits = await fetchHelmutData(log);
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

  const state = computeRaceState(lastKnownSplits);
  lastState = state;

  log("tick", `${state.status} | clock: ${state.race_clock} | lead: ${state.estimated_position_km} km | pace: ${state.pace_min_per_km}/km | proj: ${state.projected_finish}`);

  await pushToFlowics(state);
}

// --- UL sync tick ---
async function ulSyncTick() {
  const result = await syncStartTime(RACE_START, log);
  if (result.updated && result.newStart) {
    RACE_START = result.newStart;
    raceStartSource = "ultimate-live";
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
