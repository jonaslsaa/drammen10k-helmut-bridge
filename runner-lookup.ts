import { serve } from "bun";
import { FLOWICS_RUNNER_PUSH_URL, FLOWICS_RUNNER_TOKEN, FLOWICS_TOKEN, STATUS_PORT } from "./env";
import { ulFetch, iocToFlagUrl, UL_ENABLED } from "./ul";
import { log } from "./time";

const PORT = STATUS_PORT + 1; // runner lookup runs on the next port

if (!UL_ENABLED) {
  console.error("Ultimate Live is not configured. Set UL_EVENT_ID, UL_USER, UL_SECRET in .env");
  process.exit(1);
}

// --- Format runner data for Flowics ---

function formatTime(time: string): string {
  // Strip leading "00:" or "0:" hours
  return time.replace(/^0?0:/, "");
}

function formatFinishTime(time: string): string {
  // For finish times like "02:56:36" -> "2:56:36", or "00:27:05" -> "27:05"
  return time.replace(/^00:/, "").replace(/^0/, "");
}

interface RunnerData {
  bib: string;
  name: string;
  first_name: string;
  last_name: string;
  country: string;
  country_flag_url: string | null;
  gender: string;
  category: string;
  club: string;
  city: string;
  birth_year: string;
  finish_time: string;
  finish_time_net: string;
  rank_overall: string;
  rank_gender: string;
  rank_category: string;
  status: string;
  splits: { title: string; time: string; rank: string }[];
}

function buildRunnerData(r: UlRecord, times?: UlRecord[]): RunnerData {
  const country = r.NationCode || r.Nation || "";
  return {
    bib: r.Bib || "",
    name: [r.FirstName, r.LastName].filter(Boolean).join(" "),
    first_name: r.FirstName || "",
    last_name: r.LastName || "",
    country,
    country_flag_url: country ? iocToFlagUrl(country) : null,
    gender: r.Gender || "",
    category: r.CategoryTitle || r.Category || "",
    club: r.Club || "",
    city: r.City || "",
    birth_year: r.BirthYear || "",
    finish_time: r.TimeFinish ? formatFinishTime(r.TimeFinish) : "",
    finish_time_net: r.TimeFinishNet ? formatFinishTime(r.TimeFinishNet) : "",
    rank_overall: r.RankAll || r.TimeRaceRankDistance || "",
    rank_gender: r.RankSex || r.TimeRaceRankDistanceSex || "",
    rank_category: r.RankCat || r.TimeRaceRankDistanceCategory || "",
    status: r.Status || "",
    splits: (times || []).map((t) => ({
      title: t.DistanceTitle || "",
      time: t.TimeRace ? formatTime(t.TimeRace) : "",
      rank: t.TimeRaceRankDistance || "",
    })),
  };
}

// --- Push to Flowics ---

async function pushToFlowics(data: RunnerData): Promise<{ ok: boolean; error?: string }> {
  if (!FLOWICS_RUNNER_PUSH_URL) {
    return { ok: false, error: "FLOWICS_RUNNER_PUSH_URL not configured" };
  }
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = FLOWICS_RUNNER_TOKEN || FLOWICS_TOKEN;
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(FLOWICS_RUNNER_PUSH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { ok: false, error: `Flowics responded ${res.status}` };
    }
    log("runner", `Pushed: ${data.name} (#${data.bib})`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// --- HTML UI ---

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Runner Lookup</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #eee; padding: 20px; }
  h1 { font-size: 1.4rem; margin-bottom: 16px; color: #aaa; }
  .search-box { position: relative; max-width: 500px; }
  input[type="text"] {
    width: 100%; padding: 12px 16px; font-size: 16px;
    border: 2px solid #333; border-radius: 8px;
    background: #16213e; color: #fff; outline: none;
  }
  input[type="text"]:focus { border-color: #0f3460; }
  .results {
    position: absolute; top: 100%; left: 0; right: 0;
    background: #16213e; border: 1px solid #333; border-radius: 0 0 8px 8px;
    max-height: 400px; overflow-y: auto; z-index: 10;
    display: none;
  }
  .results.open { display: block; }
  .result-item {
    padding: 10px 16px; cursor: pointer; border-bottom: 1px solid #222;
    display: flex; align-items: center; gap: 10px;
  }
  .result-item:hover { background: #0f3460; }
  .result-item .flag { width: 24px; height: 18px; }
  .result-item .name { font-weight: 600; }
  .result-item .meta { color: #888; font-size: 0.85rem; }
  .result-item .bib { background: #333; color: #ddd; border-radius: 4px; padding: 2px 6px; font-size: 0.8rem; font-weight: 700; }

  .runner-card {
    max-width: 500px; margin-top: 24px; padding: 20px;
    background: #16213e; border-radius: 12px; border: 1px solid #333;
    display: none;
  }
  .runner-card.visible { display: block; }
  .runner-card h2 { font-size: 1.5rem; margin-bottom: 4px; display: flex; align-items: center; gap: 10px; }
  .runner-card h2 img { width: 32px; height: 24px; }
  .runner-card .subtitle { color: #888; margin-bottom: 16px; }
  .runner-card .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; }
  .runner-card .field label { color: #666; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; }
  .runner-card .field .value { font-size: 1.1rem; font-weight: 600; }
  .runner-card .field .value.big { font-size: 1.6rem; color: #4ecca3; }

  .splits-table { width: 100%; margin-top: 12px; border-collapse: collapse; }
  .splits-table th { color: #666; font-size: 0.75rem; text-transform: uppercase; text-align: left; padding: 4px 8px; }
  .splits-table td { padding: 4px 8px; border-top: 1px solid #222; }

  .actions { margin-top: 16px; display: flex; gap: 10px; }
  button {
    padding: 10px 20px; font-size: 14px; font-weight: 600;
    border: none; border-radius: 8px; cursor: pointer;
  }
  .btn-push { background: #4ecca3; color: #1a1a2e; }
  .btn-push:hover { background: #3ab88a; }
  .btn-push:disabled { background: #555; color: #888; cursor: default; }
  .btn-copy { background: #333; color: #ddd; }
  .btn-copy:hover { background: #444; }
  .status-msg { margin-top: 8px; font-size: 0.85rem; }
  .status-msg.ok { color: #4ecca3; }
  .status-msg.err { color: #f47d7d; }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #888; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<h1>Runner Lookup</h1>

<div class="search-box">
  <input type="text" id="search" placeholder="Search by name or bib..." autocomplete="off">
  <div class="results" id="results"></div>
</div>

<div class="runner-card" id="card"></div>

<script>
const searchEl = document.getElementById('search');
const resultsEl = document.getElementById('results');
const cardEl = document.getElementById('card');
let debounceTimer = null;
let currentRunner = null;

searchEl.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = searchEl.value.trim();
  if (q.length < 2) { resultsEl.classList.remove('open'); return; }
  debounceTimer = setTimeout(() => doSearch(q), 250);
});

searchEl.addEventListener('focus', () => {
  if (resultsEl.children.length > 0) resultsEl.classList.add('open');
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-box')) resultsEl.classList.remove('open');
});

async function doSearch(q) {
  const res = await fetch('/api/search?q=' + encodeURIComponent(q));
  const data = await res.json();
  resultsEl.innerHTML = '';
  if (data.length === 0) {
    resultsEl.innerHTML = '<div class="result-item"><span class="meta">No results</span></div>';
    resultsEl.classList.add('open');
    return;
  }
  for (const r of data) {
    const div = document.createElement('div');
    div.className = 'result-item';
    div.innerHTML = \`
      \${r.country_flag_url ? '<img class="flag" src="' + r.country_flag_url + '">' : ''}
      <span class="bib">\${r.bib}</span>
      <span class="name">\${r.name}</span>
      <span class="meta">\${r.country} \${r.finish_time ? '| ' + r.finish_time : ''}</span>
    \`;
    div.addEventListener('click', () => selectRunner(r.entry_id));
    resultsEl.appendChild(div);
  }
  resultsEl.classList.add('open');
}

async function selectRunner(entryId) {
  resultsEl.classList.remove('open');
  cardEl.className = 'runner-card visible';
  cardEl.innerHTML = '<div class="spinner"></div> Loading...';

  const res = await fetch('/api/runner/' + entryId);
  currentRunner = await res.json();
  renderCard(currentRunner);
}

function renderCard(r) {
  const splitsHtml = r.splits.length > 0 ? \`
    <table class="splits-table">
      <thead><tr><th>Split</th><th>Time</th><th>Rank</th></tr></thead>
      <tbody>\${r.splits.map(s => '<tr><td>' + s.title + '</td><td>' + s.time + '</td><td>' + s.rank + '</td></tr>').join('')}</tbody>
    </table>
  \` : '';

  cardEl.innerHTML = \`
    <h2>
      \${r.country_flag_url ? '<img src="' + r.country_flag_url + '">' : ''}
      \${r.name}
    </h2>
    <div class="subtitle">#\${r.bib} | \${r.country} | \${r.category} | \${r.club || 'No club'}</div>
    <div class="grid">
      <div class="field"><label>Finish Time</label><div class="value big">\${r.finish_time || '-'}</div></div>
      <div class="field"><label>Status</label><div class="value">\${r.status || 'Active'}</div></div>
      <div class="field"><label>Rank Overall</label><div class="value">\${r.rank_overall || '-'}</div></div>
      <div class="field"><label>Rank Gender</label><div class="value">\${r.rank_gender || '-'}</div></div>
      <div class="field"><label>Rank Category</label><div class="value">\${r.rank_category || '-'}</div></div>
      <div class="field"><label>Gender</label><div class="value">\${r.gender}</div></div>
    </div>
    \${splitsHtml}
    <div class="actions">
      <button class="btn-push" onclick="pushRunner()">Push to Flowics</button>
      <button class="btn-copy" onclick="copyJson()">Copy JSON</button>
    </div>
    <div class="status-msg" id="statusMsg"></div>
  \`;
}

async function pushRunner() {
  if (!currentRunner) return;
  const btn = document.querySelector('.btn-push');
  const msg = document.getElementById('statusMsg');
  btn.disabled = true;
  btn.textContent = 'Pushing...';
  try {
    const res = await fetch('/api/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentRunner) });
    const data = await res.json();
    if (data.ok) {
      msg.className = 'status-msg ok';
      msg.textContent = 'Pushed to Flowics!';
    } else {
      msg.className = 'status-msg err';
      msg.textContent = 'Error: ' + data.error;
    }
  } catch (e) {
    msg.className = 'status-msg err';
    msg.textContent = 'Error: ' + e.message;
  }
  btn.disabled = false;
  btn.textContent = 'Push to Flowics';
}

function copyJson() {
  if (!currentRunner) return;
  navigator.clipboard.writeText(JSON.stringify(currentRunner, null, 2));
  const msg = document.getElementById('statusMsg');
  msg.className = 'status-msg ok';
  msg.textContent = 'Copied to clipboard!';
  setTimeout(() => { msg.textContent = ''; }, 2000);
}
</script>
</body>
</html>`;

// --- Server ---

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Serve HTML
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML, { headers: { "Content-Type": "text/html" } });
    }

    // Search runners
    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q") || "";
      if (q.length < 2) return Response.json([]);

      try {
        const records = await ulFetch("search", {
          search_name: `%${q}%`,
          records: "20",
        });

        const results = records.map((r) => {
          const country = r.NationCode || r.Nation || "";
          return {
            entry_id: r.EntryID,
            bib: r.Bib || "",
            name: [r.FirstName, r.LastName].filter(Boolean).join(" "),
            country,
            country_flag_url: country ? iocToFlagUrl(country) : null,
            finish_time: r.Time ? formatTime(r.Time) : "",
            gender: r.Gender || "",
          };
        });

        return Response.json(results);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("runner", `Search error: ${msg}`);
        return Response.json({ error: msg }, { status: 500 });
      }
    }

    // Get runner details
    if (url.pathname.startsWith("/api/runner/")) {
      const entryId = url.pathname.split("/").pop() || "";
      if (!entryId) return Response.json({ error: "Missing entry ID" }, { status: 400 });

      try {
        const records = await ulFetch("resultsinfo", { search_entryid: entryId });
        const r = records[0] as any;
        if (!r) return Response.json({ error: "Runner not found" }, { status: 404 });

        // Times is nested in the JSON but ulFetch types it as Record<string, string>
        let times: Record<string, string>[] = [];
        if (r.Times?.Time) {
          const t = r.Times.Time;
          times = Array.isArray(t) ? t : [t];
        }

        return Response.json(buildRunnerData(r, times));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("runner", `Runner fetch error: ${msg}`);
        return Response.json({ error: msg }, { status: 500 });
      }
    }

    // Push runner to Flowics
    if (url.pathname === "/api/push" && req.method === "POST") {
      try {
        const data = (await req.json()) as RunnerData;
        const result = await pushToFlowics(data);
        return Response.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ ok: false, error: msg }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

log("runner", `Runner Lookup running at http://localhost:${PORT}`);
log("runner", `Flowics push: ${FLOWICS_RUNNER_PUSH_URL || "(not configured)"}`);
