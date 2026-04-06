import { serve } from "bun";
import { parseArgs } from "util";

// --- CLI args ---
const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "helmut-url": { type: "string" },
    "flowics-url": { type: "string" },
    "poll-interval": { type: "string", default: "5000" },
    "race-start": { type: "string" },
    "total-km": { type: "string", default: "10" },
    "event": { type: "string", default: "Drammen 10K" },
    "category": { type: "string", default: "Male Leaders" },
    "port": { type: "string", default: "3000" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(`
Usage: bun run index.ts [options]

Required:
  --helmut-url <url>       Helmut WordPress splits page URL
  --race-start <datetime>  Race start time in Oslo time (e.g. 2026-04-11T14:45)

Optional:
  --flowics-url <url>      Flowics HTTP Push endpoint URL
  --poll-interval <ms>     Poll interval in ms (default: 5000)
  --total-km <n>           Total race distance in km (default: 10)
  --event <name>           Event name (default: "Drammen 10K")
  --category <name>        Category name (default: "Male Leaders")
  --port <n>               Status server port (default: 3000)
  --dry-run                Run without pushing to Flowics
  -h, --help               Show this help

Examples:
  bun run index.ts --helmut-url "http://splits.hwrun.de/?p=17793" --race-start "2026-04-11T14:45" --dry-run
  bun run index.ts --helmut-url "http://splits.hwrun.de/?p=17793" --race-start "2026-04-11T14:45" --flowics-url "https://..."
`);
  process.exit(0);
}

// --- Validation ---
const errors: string[] = [];

if (!args["helmut-url"]) errors.push("--helmut-url is required");
if (!args["race-start"]) errors.push("--race-start is required");

const HELMUT_URL = args["helmut-url"] || "";
const FLOWICS_PUSH_URL = args["flowics-url"] || "";
const DRY_RUN = args["dry-run"] || false;
const POLL_INTERVAL_MS = Number(args["poll-interval"]);
const TOTAL_KM = Number(args["total-km"]);

// Convert Oslo time (Europe/Oslo) to UTC
// Input format: "2026-04-11T14:45" or "2026-04-11T14:45:00"
function osloToUtc(osloTime: string): Date {
  // Intl can format a known instant in Oslo; we invert that here.
  // Append "+02:00" for CEST or "+01:00" for CET based on the date.
  // Safest: use a formatter round-trip to let the engine figure out the offset.
  const guess = new Date(osloTime + "Z"); // treat as UTC first
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  // Find what Oslo time that UTC instant maps to, then compute the offset
  const parts = fmt.formatToParts(guess);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "0";
  const osloOfGuess = new Date(
    `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`
  );
  const offsetMs = osloOfGuess.getTime() - guess.getTime();
  // The real UTC time = input oslo time - offset
  return new Date(new Date(osloTime + "Z").getTime() - offsetMs);
}

const RACE_START_OSLO = args["race-start"] || "";
let RACE_START: Date | null = null;
if (RACE_START_OSLO) {
  RACE_START = osloToUtc(RACE_START_OSLO);
  if (isNaN(RACE_START.getTime())) {
    RACE_START = null;
  }
}
const EVENT_NAME = args["event"] || "Drammen 10K";
const CATEGORY = args["category"] || "Male Leaders";
const STATUS_PORT = Number(args["port"]);

if (HELMUT_URL && !/^https?:\/\//.test(HELMUT_URL))
  errors.push("--helmut-url must be a valid HTTP(S) URL");

if (FLOWICS_PUSH_URL && !/^https?:\/\//.test(FLOWICS_PUSH_URL))
  errors.push("--flowics-url must be a valid HTTP(S) URL");

if (!DRY_RUN && !FLOWICS_PUSH_URL)
  errors.push("--flowics-url is required (or use --dry-run)");

if (RACE_START_OSLO && !RACE_START)
  errors.push("--race-start must be a valid date (e.g. 2026-04-11T14:45)");

if (isNaN(POLL_INTERVAL_MS) || POLL_INTERVAL_MS < 1000)
  errors.push("--poll-interval must be a number >= 1000");

if (isNaN(TOTAL_KM) || TOTAL_KM < 1)
  errors.push("--total-km must be a number >= 1");

if (isNaN(STATUS_PORT) || STATUS_PORT < 1 || STATUS_PORT > 65535)
  errors.push("--port must be a number between 1 and 65535");

if (errors.length > 0) {
  console.error("Validation errors:");
  errors.forEach((e) => console.error(`  - ${e}`));
  console.error("\nRun with --help for usage info.");
  process.exit(1);
}

// --- Types ---
interface Split {
  km: number;
  split: string;
  last_km: string;
  projected_finish: string;
}

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

// --- Time helpers ---
function timeToSeconds(time: string): number {
  const parts = time.trim().split(":");
  if (parts.length === 3) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  if (parts.length === 2) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  return 0;
}

function secondsToTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const ss = s.toString().padStart(2, "0");
  const mm = m.toString().padStart(2, "0");
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${m}:${ss}`;
}

// --- Logging ---
function log(tag: string, msg: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

// --- Parse Helmut's WordPress HTML ---
function parseHelmutHtml(html: string): Split[] {
  const contentMatch = html.match(
    /<div class="entry-content">[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/
  );
  if (!contentMatch || !contentMatch[1]) return [];

  const lines = contentMatch[1]
    .split(/<br\s*\/?>/i)
    .map((l) => l.trim())
    .filter(Boolean);

  let splits: Split[] = [];
  for (const line of lines) {
    if (line === "start") {
      splits = [];
      continue;
    }

    const fields = line.split(" ; ");
    if (fields.length < 3) continue;

    const distField = fields[0];
    const lapField = fields[1];
    const projField = fields[2];
    if (!distField || !lapField || !projField) continue;

    const colonIdx = distField.indexOf(":");
    if (colonIdx === -1) continue;

    const dist = distField.slice(0, colonIdx).trim();
    const splitTime = distField.slice(colonIdx + 1).trim();
    if (!dist || !splitTime) continue;

    const kmMatch = dist.match(/(\d+)\s*km/);
    if (!kmMatch || !kmMatch[1]) continue;
    const km = Number(kmMatch[1]);
    if (km === 0) continue;

    // If km goes backwards, treat as a new run (reset)
    const prev = splits[splits.length - 1];
    if (prev && km <= prev.km) {
      splits = [];
    }

    const lastKmMatch = lapField.match(/last km:\s*(.+)/);
    const projMatch = projField.match(/proj:\s*(.+)/);

    splits.push({
      km,
      split: splitTime,
      last_km: lastKmMatch?.[1]?.trim() || "",
      projected_finish: projMatch?.[1]?.trim() || "",
    });
  }

  return splits;
}

// --- Compute full race state ---
function computeRaceState(splits: Split[]): RaceState {
  const now = new Date();
  const start = RACE_START ?? now;
  const elapsedSecs = (now.getTime() - start.getTime()) / 1000;

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
  let projectedFinish = "0:00:00";

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

// --- State ---
let lastKnownSplits: Split[] = [];
let lastSplitCount = 0;
let lastState: RaceState | null = null;
let lastFetchError: string | null = null;
let fetchSuccessCount = 0;
let fetchErrorCount = 0;
let pushSuccessCount = 0;
let pushErrorCount = 0;

// --- Fetch from Helmut ---
async function fetchHelmutData(): Promise<Split[] | null> {
  try {
    const res = await fetch(HELMUT_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      lastFetchError = `HTTP ${res.status}`;
      fetchErrorCount++;
      log("fetch", `ERROR: HTTP ${res.status}`);
      return null;
    }
    const html = await res.text();
    const splits = parseHelmutHtml(html);
    fetchSuccessCount++;
    lastFetchError = null;
    return splits;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastFetchError = msg;
    fetchErrorCount++;
    log("fetch", `ERROR: ${msg}`);
    return null;
  }
}

// --- Push to Flowics ---
async function pushToFlowics(state: RaceState): Promise<void> {
  if (DRY_RUN || !FLOWICS_PUSH_URL) return;
  try {
    const res = await fetch(FLOWICS_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  const splits = await fetchHelmutData();

  if (splits !== null) {
    lastKnownSplits = splits;
    if (splits.length !== lastSplitCount) {
      log("split", `New split! ${splits.length}/${TOTAL_KM} km recorded`);
      const latest = splits.at(-1);
      if (latest) {
        log(
          "split",
          `  ${latest.km} km: ${latest.split} | lap: ${latest.last_km} | proj: ${latest.projected_finish}`
        );
      }
      lastSplitCount = splits.length;
    }
  } else {
    log("fetch", `Using last known data (${lastKnownSplits.length} splits)`);
  }

  const state = computeRaceState(lastKnownSplits);
  lastState = state;

  log(
    "tick",
    `${state.status} | clock: ${state.race_clock} | lead: ${state.estimated_position_km} km | pace: ${state.pace_min_per_km}/km | proj: ${state.projected_finish}`
  );

  await pushToFlowics(state);
}

// --- Status server ---
serve({
  port: STATUS_PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/status") {
      return Response.json({
        ok: true,
        config: {
          helmut_url: HELMUT_URL,
          flowics_push_url: DRY_RUN ? "(dry run)" : FLOWICS_PUSH_URL,
          race_start_oslo: RACE_START_OSLO,
          race_start_utc: RACE_START?.toISOString() ?? "unknown",
          poll_interval_ms: POLL_INTERVAL_MS,
          total_km: TOTAL_KM,
          event: EVENT_NAME,
          category: CATEGORY,
        },
        stats: {
          fetch_success: fetchSuccessCount,
          fetch_errors: fetchErrorCount,
          push_success: pushSuccessCount,
          push_errors: pushErrorCount,
          last_fetch_error: lastFetchError,
        },
        state: lastState,
      });
    }

    return Response.redirect(`http://localhost:${STATUS_PORT}/status`, 302);
  },
});

// --- Start ---
log("start", "=== Helmut Bridge ===");
log("start", `Source:   ${HELMUT_URL}`);
log(
  "start",
  `Push to:  ${DRY_RUN ? "(dry run)" : FLOWICS_PUSH_URL}`
);
log("start", `Interval: ${POLL_INTERVAL_MS}ms`);
log("start", `Race:     ${EVENT_NAME} — ${CATEGORY}`);
log("start", `Start:    ${RACE_START_OSLO} Oslo (${RACE_START?.toISOString() ?? "?"} UTC)`);
log("start", `Status:   http://localhost:${STATUS_PORT}/status`);
log("start", "");

tick();
setInterval(tick, POLL_INTERVAL_MS);
