import { parseArgs } from "util";
import {
  FLOWICS_GRAPHICS_TOKEN, FLOWICS_TIMER_PROVIDER_ID,
  UL_DISTANCE_ID, RACE_START_OSLO,
} from "./env";
import { ulFetch, UL_ENABLED } from "./ul";
import { osloToUtc, log } from "./time";

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "fake-start-time": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(`
Usage: bun run sync-timer.ts [options]

Syncs the Flowics broadcast timer to the actual race start time from Ultimate Live.
Press play on the timer AT or BEFORE the gun, then run this script to correct the drift.

Options:
  --fake-start-time <HH:MM:SS>  Fake the UL start time in Oslo time (for testing)
  -h, --help                    Show this help

Examples:
  bun run sync-timer.ts                          # Sync using real UL data
  bun run sync-timer.ts --fake-start-time 14:45:00  # Pretend gun fired at 14:45:00 Oslo
`);
  process.exit(0);
}

// --- Validate ---

if (!FLOWICS_GRAPHICS_TOKEN) {
  console.error("FLOWICS_GRAPHICS_TOKEN is required in .env");
  process.exit(1);
}
if (!UL_ENABLED && !args["fake-start-time"]) {
  console.error("Ultimate Live is not configured. Set UL_EVENT_ID, UL_USER, UL_SECRET in .env (or use --fake-start-time)");
  process.exit(1);
}

const PROVIDER_ID = FLOWICS_TIMER_PROVIDER_ID || "master-clock";
const BASE = `https://api.flowics.com/graphics/${FLOWICS_GRAPHICS_TOKEN}/control/global-data-providers/iid%3A${PROVIDER_ID}/actions`;

// --- Flowics Timer API ---

interface ResolveResult {
  timeReference: number;
  current: string;
  currentCalculated: string;
  timeReferenceCalculated: number;
}

async function resolveTimer(): Promise<ResolveResult> {
  const res = await fetch(`${BASE}/resolveTime`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`resolveTime: HTTP ${res.status}`);
  return res.json() as Promise<ResolveResult>;
}

async function pauseTimer(): Promise<void> {
  const res = await fetch(`${BASE}/pause`, { method: "PUT", signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`pause: HTTP ${res.status}`);
}

async function playTimer(): Promise<void> {
  const res = await fetch(`${BASE}/play`, { method: "PUT", signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`play: HTTP ${res.status}`);
}

// --- Get actual start time from UL ---

async function getActualStartTime(): Promise<Date | null> {
  const records = await ulFetch("startgroups", { id: UL_DISTANCE_ID });

  for (const sg of records) {
    const actual = sg.ActualStartTime;
    if (actual && actual !== "00:00:00") {
      const datepart = RACE_START_OSLO.split("T")[0];
      if (!datepart) continue;
      const start = osloToUtc(`${datepart}T${actual}`);
      if (!isNaN(start.getTime())) {
        log("sync", `UL startgroup: "${sg.Title}" — ActualStartTime: ${actual}`);
        return start;
      }
    }
  }

  return null;
}

// --- Parse HH:MM:SS to milliseconds ---

function parseTimeToMs(time: string): number {
  const parts = time.split(":").map(Number);
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return parts[0] * 1000;
}

// --- Prompt user ---

function ask(question: string): string {
  process.stdout.write(question);
  // Bun supports prompt() but let's use a sync approach
  const buf = new Uint8Array(64);
  const n = require("fs").readSync(0, buf);
  return new TextDecoder().decode(buf.subarray(0, n)).trim();
}

// --- Main ---

log("sync", "=== Flowics Timer Sync ===");
log("sync", "");

// 1. Get actual start time (from UL or --fake-start-time)
let ulStart: Date | null = null;
if (args["fake-start-time"]) {
  // Use today's date in Oslo timezone
  const now = new Date();
  const osloDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(now);
  ulStart = osloToUtc(`${osloDate}T${args["fake-start-time"]}`);
  if (isNaN(ulStart.getTime())) {
    log("sync", `Invalid time format: ${args["fake-start-time"]} (use HH:MM:SS)`);
    process.exit(1);
  }
  log("sync", `Using fake start time: ${args["fake-start-time"]} Oslo today`);
} else {
  ulStart = await getActualStartTime();
}
if (!ulStart) {
  log("sync", "Could not get actual start time from UL. Is the race started? (Use --fake-start-time to test)");
  process.exit(1);
}
const ulStartMs = ulStart.getTime();
log("sync", `UL actual start: ${ulStart.toISOString()}`);

// 2. Resolve Flowics timer
const resolved = await resolveTimer();
const resolveTimestamp = resolved.timeReferenceCalculated; // server time at resolve
const displayedMs = parseTimeToMs(resolved.currentCalculated);
const actualElapsedMs = resolveTimestamp - ulStartMs;

log("sync", `Flowics timer shows: ${resolved.currentCalculated} (${displayedMs}ms)`);
log("sync", `Actual elapsed:      ${(actualElapsedMs / 1000).toFixed(1)}s`);

// 3. Compute drift: how far ahead the timer is
const driftMs = displayedMs - actualElapsedMs;
const driftSec = (driftMs / 1000).toFixed(1);

log("sync", "");
if (driftMs <= 0) {
  log("sync", `Drift: ${driftSec}s (timer is behind or exact — nothing to adjust)`);
  log("sync", "No sync needed. Timer is correct or behind (can only slow down, not speed up).");
  process.exit(0);
}

log("sync", `Drift: +${driftSec}s (timer is ${driftSec}s ahead)`);
log("sync", `Will pause for ${driftMs}ms then resume.`);
log("sync", "");

const answer = ask("[sync] Sync? (y/n): ");
if (answer.toLowerCase() !== "y") {
  log("sync", "Cancelled.");
  process.exit(0);
}

// 4. Pause → sleep → play
log("sync", "Pausing timer...");
await pauseTimer();

log("sync", `Waiting ${driftMs}ms...`);
await Bun.sleep(driftMs);

log("sync", "Resuming timer...");
await playTimer();

// 5. Verify
log("sync", "");
const after = await resolveTimer();
log("sync", `Done! Timer now shows: ${after.currentCalculated}`);
