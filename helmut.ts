export interface Split {
  km: number;
  split: string;
  last_km: string;
  projected_finish: string;
}

// --- Parse Helmut's WordPress HTML ---
export function parseHelmutHtml(html: string): Split[] {
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
      projected_finish: (projMatch?.[1]?.trim() || "").replace(/^0:(\d{2}:)/, "$1"),
    });
  }

  return splits;
}

// --- Parse plain text splits (for simulate mode) ---
export function parsePlainTextSplits(text: string): Split[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

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
      projected_finish: (projMatch?.[1]?.trim() || "").replace(/^0:(\d{2}:)/, "$1"),
    });
  }

  return splits;
}

// --- Fetch from Helmut ---
let lastFetchError: string | null = null;
let fetchSuccessCount = 0;
let fetchErrorCount = 0;

export function getHelmutStats() {
  return { fetchSuccessCount, fetchErrorCount, lastFetchError };
}

export async function fetchHelmutData(
  helmutUrl: string,
  log: (tag: string, msg: string) => void
): Promise<Split[] | null> {
  try {
    const res = await fetch(helmutUrl, { signal: AbortSignal.timeout(5000) });
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
