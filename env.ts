// Bun auto-loads .env — this file validates and exports typed config.

const errors: string[] = [];

function required(key: string): string {
  const val = process.env[key];
  if (!val) errors.push(`${key} is required`);
  return val || "";
}

function optional(key: string, fallback: string = ""): string {
  return process.env[key] || fallback;
}

function requiredUrl(key: string): string {
  const val = required(key);
  if (val && !/^https?:\/\//.test(val)) errors.push(`${key} must be a valid HTTP(S) URL`);
  return val;
}

function optionalUrl(key: string): string {
  const val = optional(key);
  if (val && !/^https?:\/\//.test(val)) errors.push(`${key} must be a valid HTTP(S) URL`);
  return val;
}

function requiredInt(key: string, min?: number): number {
  const val = Number(required(key));
  if (isNaN(val)) errors.push(`${key} must be a number`);
  if (min !== undefined && val < min) errors.push(`${key} must be >= ${min}`);
  return val;
}

function optionalInt(key: string, fallback: number, min?: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const val = Number(raw);
  if (isNaN(val)) errors.push(`${key} must be a number`);
  if (min !== undefined && val < min) errors.push(`${key} must be >= ${min}`);
  return val;
}

// --- Flowics ---
export const FLOWICS_PUSH_URL = requiredUrl("FLOWICS_PUSH_URL");
export const FLOWICS_TOKEN = optional("FLOWICS_TOKEN");
export const FLOWICS_RUNNER_PUSH_URL = optionalUrl("FLOWICS_RUNNER_PUSH_URL");
export const FLOWICS_RUNNER_TOKEN = optional("FLOWICS_RUNNER_TOKEN");

// --- Ultimate Live ---
export const UL_EVENT_ID = optional("UL_EVENT_ID");
export const UL_USER = optional("UL_USER");
export const UL_SECRET = optional("UL_SECRET");
export const UL_SYNC_INTERVAL_MS = optionalInt("UL_SYNC_INTERVAL_MS", 5000, 1000);
export const UL_LEADERBOARD_SIZE = optionalInt("UL_LEADERBOARD_SIZE", 9, 1);

// --- Helmut ---
export const HELMUT_URL = requiredUrl("HELMUT_URL");

// --- Race ---
export const RACE_START_OSLO = required("RACE_START");
export const TOTAL_KM = optionalInt("TOTAL_KM", 10, 1);
export const EVENT_NAME = optional("EVENT_NAME", "Drammen 10K");
export const CATEGORY = optional("CATEGORY", "Male Leaders");

// --- Record pace comparison ---
export const RECORD_LABEL = required("RECORD_LABEL");
export const RECORD_TIME = required("RECORD_TIME");

// --- Server ---
export const POLL_INTERVAL_MS = optionalInt("POLL_INTERVAL_MS", 3000, 1000);
export const STATUS_PORT = optionalInt("STATUS_PORT", 3000, 1);

// --- Validate UL: if any UL var is set, all three must be ---
const ulVars = [UL_EVENT_ID, UL_USER, UL_SECRET];
const ulSet = ulVars.filter(Boolean).length;
if (ulSet > 0 && ulSet < 3) {
  errors.push("If using Ultimate Live, all of UL_EVENT_ID, UL_USER, and UL_SECRET are required");
}

// --- Report ---
if (errors.length > 0) {
  console.error("Environment validation errors:");
  errors.forEach((e) => console.error(`  - ${e}`));
  console.error("\nCheck your .env file.");
  process.exit(1);
}
