# Helmut Bridge

Bridges live split data from Helmut Winter's WordPress timing system into Flowics broadcast graphics via HTTP Push.

Used for the **Drammen 10K** (April 11, 2026) TV broadcast.

## How it works

```
Helmut's WordPress page  ──poll every 5s──>  This script  ──POST JSON──>  Flowics HTTP Push
(splits.hwrun.de)                                                          (broadcast graphics)
```

1. Polls Helmut's WordPress page for new split times (one line per km, updated as the leader passes each marker)
2. Parses the HTML and computes: race clock, estimated leader position, pace, speed, projected finish time
3. Pushes a JSON payload to Flowics every 5 seconds

Between km markers, the leader's position is interpolated from the last known pace, so the "Lead" graphic updates smoothly.

## Prerequisites

Install [Bun](https://bun.sh):

```sh
curl -fsSL https://bun.sh/install | bash
```

Then install dependencies:

```sh
bun install
```

## Configuration

All config lives in the `.env` file. Copy the example and fill in your values:

```sh
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FLOWICS_PUSH_URL` | Yes | — | Flowics HTTP Push endpoint URL |
| `FLOWICS_TOKEN` | No | — | Bearer token for Flowics (if needed) |
| `HELMUT_URL` | Yes | — | Helmut's WordPress splits page URL |
| `RACE_START` | Yes | — | Race start in Oslo local time (e.g. `2026-04-11T14:45`) |
| `RECORD_LABEL` | Yes | — | Label for the record comparison (e.g. `European Record`) |
| `RECORD_TIME` | Yes | — | Record time to compare against (e.g. `26:33`) |
| `UL_EVENT_ID` | No | — | Ultimate Live event ID (enables UL sync) |
| `UL_USER` | No | — | Ultimate Live API username |
| `UL_SECRET` | No | — | Ultimate Live API secret |
| `UL_SYNC_INTERVAL_MS` | No | `10000` | UL poll interval in ms |
| `UL_LEADERBOARD_SIZE` | No | `9` | Max entries per leaderboard |
| `TOTAL_KM` | No | `10` | Race distance in km |
| `EVENT_NAME` | No | `Drammen 10K` | Event name in output JSON |
| `CATEGORY` | No | `Male Leaders` | Category name in output JSON |
| `POLL_INTERVAL_MS` | No | `5000` | Helmut poll / Flowics push interval in ms |
| `STATUS_PORT` | No | `3000` | Local status server port |

## CLI options

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | `false` | Run without pushing to Flowics |
| `--simulate <file>` | — | Simulate a race from a test data file |
| `--simulate-interval <s>` | `10` | Seconds between each simulated split |
| `-h, --help` | — | Show help |

## Usage

### Dry run (test without pushing to Flowics)

```sh
bun run index.ts --dry-run
```

### Simulate mode (test with fake data)

```sh
bun run index.ts --simulate testdata.txt --dry-run
```

## Race day — Saturday April 11, 2026

Step-by-step checklist for running this in production.

### Before the race

1. **Open a terminal** on the laptop that will run during the broadcast.

2. **Navigate to the project folder:**
   ```sh
   cd /path/to/Helmut
   ```

3. **Check your `.env` file has the correct values:**
   ```sh
   cat .env
   ```
   Verify:
   - `FLOWICS_PUSH_URL` — the URL from Flowics Data Connector input
   - `HELMUT_URL` — Helmut's WordPress page (should be `http://splits.hwrun.de/?p=17793`)
   - `RACE_START` — confirmed start time in Oslo time (e.g. `2026-04-11T14:45`)
   - `RECORD_LABEL` / `RECORD_TIME` — the record you want to compare against
   - `UL_EVENT_ID`, `UL_USER`, `UL_SECRET` — Ultimate Live credentials (for leaderboards + start time sync)

4. **Do a dry run to make sure everything connects:**
   ```sh
   bun run index.ts --dry-run
   ```
   - Check the console output — you should see `[tick]` lines every 5 seconds
   - Open http://localhost:3000/status — you should see the JSON payload
   - If UL is configured, you should see `[ul]` log lines with leaderboard counts

5. **Check your internet connection.** All traffic is outbound — no public IP needed. But you do need a stable connection to reach both `splits.hwrun.de` and Flowics.

### Start the bridge (go live)

```sh
bun run index.ts
```

That's it. The script will:
- Poll Helmut's page every 5 seconds
- Compute race state (clock, position, pace, projected finish, record comparison)
- Sync start time + leaderboards from Ultimate Live every 10 seconds
- Push everything to Flowics every 5 seconds

### During the race

- **Watch the console.** You'll see log lines for every tick and every new split.
- **Monitor via browser:** Open http://localhost:3000/status to see the full JSON payload and error counts at any time.
- **If the start is delayed:** If UL is configured, the script auto-syncs the actual start time from Ultimate Live. No action needed.
- **If something looks wrong:** Check the `stats` in `/status` — `fetch_errors` or `push_errors` will tell you where the problem is.

### If you need to restart

Press `Ctrl+C` to stop, then run `bun run index.ts` again. The script has no persistent state — it fetches current data from Helmut's page on startup and picks up immediately. You can also edit `.env` between restarts (e.g. to change `RACE_START`).

## Monitoring during the race

The script runs a local HTTP server you can check anytime:

```sh
curl http://localhost:3000/status
```

Returns JSON with:
- **config** — current settings
- **stats** — fetch/push success and error counts
- **state** — the exact JSON being pushed to Flowics right now

The console also logs every tick with a one-line summary:

```
[2026-04-11 14:50:02] [tick] live | clock: 5:02 | lead: 1.9 km | pace: 2:44/km | proj: 0:27:19
[2026-04-11 14:52:46] [split] New split! 2/10 km recorded
[2026-04-11 14:52:46] [split]   2 km: 5:25 | lap: 2:41 | proj: 0:27:07
```

## JSON output format

This is what Flowics receives (and what `/status` returns in `.state`). Use `_schema_example.json` in this repo when setting up the Flowics Data Connector input.

```json
{
  "event": "Drammen 10K",
  "category": "Male Leaders",
  "status": "live",
  "race_clock": "13:27",
  "latest_km": 5,
  "total_km": 10,
  "estimated_position_km": 5.7,
  "pace_min_per_km": "2:38",
  "speed_kmh": 22.8,
  "projected_finish": "0:27:05",
  "splits": [
    { "km": 1, "split": "2:44", "last_km": "2:44", "projected_finish": "0:27:19" },
    { "km": 2, "split": "5:25", "last_km": "2:41", "projected_finish": "0:27:07" },
    ...
  ]
}
```

| Field | Description |
|-------|-------------|
| `status` | `"waiting"` (before start), `"live"`, or `"finished"` |
| `race_clock` | Elapsed time since race start (frozen at finish time when done) |
| `estimated_position_km` | Leader's estimated position, interpolated between km markers |
| `pace_min_per_km` | Last recorded km lap time (e.g. `"2:38"` = 2 min 38 sec per km) |
| `speed_kmh` | Same as pace but in km/h (e.g. `22.8`) |
| `projected_finish` | Projected finish time if current pace is maintained |
| `splits` | Array of all recorded km splits so far |

## Flowics setup

You need **admin access** in Flowics to create a Data Connector Input. If you don't have it, ask your Customer Success Manager.

1. In Flowics, go to **Settings > Data Connectors - Inputs**
2. Click **Add** and select **JSON HTTP Push - Content**
3. Paste the contents of `_schema_example.json` and click **Generate Schema from Example**
4. Copy the **Push URL** (includes the auth token — this is the only authentication, no headers needed)
5. Use that URL as the `--flowics-url` argument

### Important: IP restrictions

Flowics can restrict which IPs are allowed to push data. If **Allowed IP Networks** is configured on your input, make sure the IP of the machine running this script is whitelisted. If you're running from a laptop, your public IP may change — either leave IP restrictions off or check your IP before the race (`curl ifconfig.me`).

### Schema changes

The JSON you push must match the schema configured in Flowics. If you ever change the output format of this script, you need to update the schema in Flowics too (re-paste `_schema_example.json` and regenerate).

## Resilience

- If Helmut's site is unreachable, the script keeps pushing the last known data (estimated position continues to interpolate)
- Both fetch and push have a 5-second timeout so a hung connection won't block the loop
- If Flowics push fails, the script logs the error and retries on the next tick
- If the WordPress page contains data from a previous run followed by a new run, the parser detects the km number going backwards and resets to the latest run

## Race start time

`RACE_START` in `.env` takes **Oslo local time** — no timezone conversion needed. The script handles CET/CEST automatically.

Example: `RACE_START=2026-04-11T14:45` for a 14:45 start in Drammen.

If Ultimate Live is configured (`UL_EVENT_ID`, `UL_USER`, `UL_SECRET`), the script automatically syncs the actual start time from the timing system. This handles race delays — no need to restart or edit `.env`.

## Troubleshooting

### The script won't start

**"Environment validation errors"** — You're missing a required variable in `.env`. Read the error messages, they tell you exactly what's missing. Example:

```
Environment validation errors:
  - FLOWICS_PUSH_URL is required
  - HELMUT_URL is required
```

Fix: check your `.env` file and add the missing values. Use `--dry-run` if you just want to test without Flowics.

**"command not found: bun"** — Bun is not installed. Run:
```sh
curl -fsSL https://bun.sh/install | bash
```
Then close and reopen your terminal.

### The script is running but the graphics aren't updating

1. Open http://localhost:3000/status in your browser (or `curl http://localhost:3000/status` in a new terminal)
2. Check the `stats` section:
   - `fetch_errors` is high? Helmut's site might be down. Check if you can open the `--helmut-url` in your browser.
   - `push_errors` is high? The Flowics URL might be wrong. Double-check `FLOWICS_PUSH_URL` in `.env`.
   - `last_fetch_error` tells you exactly what went wrong on the last failed fetch.
3. Check the `state` section:
   - `status` is `"waiting"`? The race hasn't started yet (or `RACE_START` in `.env` is wrong).
   - `splits` is empty `[]`? Helmut hasn't entered any data yet, or the page format changed.
   - `splits` has data but `estimated_position_km` is `0`? The race start time is in the future.

### The estimated position seems wrong

The position is calculated from the race start time. If `RACE_START` is even 1 minute off, the position will drift by ~0.4 km. If UL is configured, the script auto-syncs the actual start time — check the `/status` endpoint to see `race_start_source` (should be `"ultimate-live"` once synced).

### The split data looks like it's from a test/old race

Helmut sometimes leaves test data on the page before the real race. The script handles this — if it sees km numbers going backwards (e.g. 10 km followed by 1 km), it resets and only uses the latest data. If the page still shows old data when the race starts, contact Helmut.

### I need to restart the script

Just press `Ctrl+C` in the terminal to stop it, then run the same command again. Nothing is saved between runs — it picks up the current state from Helmut's page immediately.

### The console is full of errors

- **`[fetch] ERROR: ...`** — Can't reach Helmut's site. This is usually temporary. The script keeps retrying every 5 seconds and uses the last known data in the meantime. Graphics will keep working.
- **`[push] ERROR: Flowics responded 4xx/5xx`** — Flowics is rejecting the data. Check that the `--flowics-url` is correct and that the Flowics input is set up with the right schema (use `_schema_example.json`).
- **`[push] ERROR: ...timeout...`** — Flowics is slow to respond. Usually temporary. The script keeps retrying.

### Nothing seems to work and I'm stuck

1. Try a dry run first to isolate the problem: `bun run index.ts --dry-run`
2. If the dry run works (you see splits in the logs), the problem is on the Flowics side.
3. If the dry run also shows errors, the problem is with Helmut's page or your internet.

## Contacts

- **Helmut Winter** (split timing): hewi@hwinter.de
- **Kristoffer Dahl Vollan** (producer, Flerkameratene): kristoffer@flerkameratene.no, +47 48219403
