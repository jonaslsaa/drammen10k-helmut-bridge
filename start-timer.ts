import { FLOWICS_GRAPHICS_TOKEN, FLOWICS_TIMER_PROVIDER_ID } from "./env";
import { log } from "./time";

if (!FLOWICS_GRAPHICS_TOKEN) {
  console.error("FLOWICS_GRAPHICS_TOKEN is required in .env");
  process.exit(1);
}

const PROVIDER_ID = FLOWICS_TIMER_PROVIDER_ID || "master-clock";
const BASE = `https://api.flowics.com/graphics/${FLOWICS_GRAPHICS_TOKEN}/control/global-data-providers/iid%3A${PROVIDER_ID}/actions`;

log("timer", "Resetting and starting timer...");
await fetch(`${BASE}/reset`, { method: "PUT" });
await fetch(`${BASE}/play`, { method: "PUT" });
log("timer", "Timer started!");
