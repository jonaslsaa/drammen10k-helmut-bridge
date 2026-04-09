---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# Project: Drammen 10K Helmut Bridge

This is a data bridge for the **Drammen 10K** road race (April 11, 2026) TV broadcast. It connects two external data sources to **Flowics** (cloud broadcast graphics platform) via HTTP Push.

## Data sources

### Helmut Winter (splits.hwrun.de)
- Dr. Helmut Winter manually enters split times into a WordPress page as the race leader passes each km marker
- The page (`splits.hwrun.de/?p=17793`) contains `<br>`-separated lines like: `1 km: 2:44 ; last km: 2:44 ; proj: 0:27:19`
- We poll this page every 5 seconds, parse the HTML, and compute: race clock, estimated leader position (interpolated between km markers), pace, speed, projected finish

### Ultimate Live (live.ultimate.dk)
- Mylaps/UltimateLIVE provides the official timing system with data at 5km and 10km (finish)
- We sync the actual race start time from the `startgroups` API (handles delays)
- We fetch leaderboard standings (mixed/men/women) from `timingpointstandings`
- API auth: `apikey = md5(SECRET + md5("API@UltimateLIVE"))`, uses IOC country codes (not ISO)

## Architecture

Single Bun/TypeScript process that runs during the race:
- **Helmut poll loop** (every 5s): fetch HTML → parse splits → compute state → POST to Flowics
- **UL sync loop** (every 10s): sync start time + fetch leaderboards
- **Status server** (localhost:3000/status): monitoring endpoint with config, stats, and current state
- **Simulate mode** (`--simulate testdata.txt`): releases splits one by one for testing without live data

## Key files
- `index.ts` — main loop, Flowics push, status server
- `env.ts` — loads and validates .env config
- `helmut.ts` — WordPress HTML parser and fetcher
- `ul.ts` — Ultimate Live API (start time sync + leaderboards)
- `race-state.ts` — computes race state from splits (pure function)
- `time.ts` — time helpers, Oslo timezone conversion, logger

## Output JSON structure
The push to Flowics includes:
- Split tracker data (from Helmut): race_clock, estimated_position_km, pace, speed, projected_finish, record_pace
- Leaderboards (from UL): `mixed`, `men`, `women` — each with `5km_leaderboard`, `10km_leaderboard`, `auto_leaderboard`
- `auto_leaderboard` shows 5km standings until 10km results arrive, then switches automatically

## People
- **Kristoffer Dahl Vollan** (kristoffer@flerkameratene.no) — producer at Flerkameratene, our contact
- **Helmut Winter** (hewi@hwinter.de) — provides split timing data from the race course
- **Andreas Atkins** (andreas.atkins@mylaps.com) — UltimateLIVE contact, provided API credentials

## Important notes
- Race start time is given in Oslo local time (CEST = UTC+2 in April), converted automatically
- Helmut's data can reset mid-page (km goes backwards) — parser handles this
- `.env` contains secrets (Flowics token, UL credentials) — never commit it
- The Flowics push uses Bearer token auth in the Authorization header
- IOC country codes (GER, NED, SUI) differ from ISO alpha-3 — we use `convert-country-codes` lib

---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
