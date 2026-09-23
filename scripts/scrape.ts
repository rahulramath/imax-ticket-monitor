/**
 * One-shot scrape for static deployments (GitHub Pages).
 *
 * Runs the same scanners the live server uses and writes the result to
 * public/data/snapshot.json, which the static build serves in place of the
 * /api/status route. A scheduled GitHub Action runs this before each deploy.
 *
 * Usage: npm run scrape
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyCarryOver } from "../src/lib/carryover";
import { scanAllTheaters } from "../src/lib/scrapers";
import type { MonitorSnapshot, TheaterResult } from "../src/lib/types";

const OUT_PATH = join(process.cwd(), "public", "data", "snapshot.json");

async function fetchSnapshot(url: string | undefined, label: string): Promise<MonitorSnapshot | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
    if (!res.ok) return null;
    const snap = (await res.json()) as MonitorSnapshot;
    console.log(
      `Loaded ${label} snapshot (${Math.round((Date.now() - snap.lastChecked) / 60000)}m old)`,
    );
    return snap;
  } catch {
    return null;
  }
}

/**
 * Sources that fill gaps in this run's scan (failed dates, blocked theaters,
 * seat counts not covered by the rotation), set by the CI workflow:
 *  - PREV_SNAPSHOT_URL: the currently deployed snapshot
 *  - LOCAL_SNAPSHOT_URL: the `data` branch feed published by a home machine
 *    (see scripts/publish-snapshot.ts), which Cloudflare doesn't block the
 *    way it blocks GitHub's datacenter IPs
 * Per theater, whichever source has the newer successful fetch wins.
 */
async function fetchCarryOverSources(): Promise<TheaterResult[]> {
  const [deployed, local] = await Promise.all([
    fetchSnapshot(process.env.PREV_SNAPSHOT_URL, "deployed"),
    fetchSnapshot(process.env.LOCAL_SNAPSHOT_URL, "local feed"),
  ]);
  const best = new Map<string, TheaterResult>();
  for (const snap of [deployed, local]) {
    for (const t of snap?.theaters ?? []) {
      const cur = best.get(t.theaterId);
      if (!cur || (t.dataAsOf ?? 0) > (cur.dataAsOf ?? 0)) best.set(t.theaterId, t);
    }
  }
  return [...best.values()];
}

async function main() {
  console.log("Scanning all theaters…");
  const started = Date.now();
  const [theaters, prevTheaters] = await Promise.all([scanAllTheaters(), fetchCarryOverSources()]);

  // Raw results before carry-over, which masks failures by restoring old data
  for (const t of theaters) {
    console.log(
      `  [raw] ${t.theaterName}: ok=${t.ok} showtimes=${t.showtimes.length}` +
        ` failedDates=${t.failedDates?.length ?? 0}` +
        (t.error ? `\n        error: ${t.error}` : ""),
    );
  }

  if (prevTheaters.length > 0) applyCarryOver(prevTheaters, theaters);

  const snapshot: MonitorSnapshot = {
    theaters,
    lastChecked: Date.now(),
    // "NEW" detection needs scan-to-scan memory, which a fresh CI runner
    // doesn't have — static deploys simply don't flag new showtimes.
    newShowtimeIds: [],
    checking: false,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(snapshot));

  for (const t of theaters) {
    const age = t.dataAsOf ? `${Math.round((Date.now() - t.dataAsOf) / 60000)}m old` : "no data";
    console.log(
      `  [published] ${t.theaterName}: ok=${t.ok} showtimes=${t.showtimes.length} data ${age}` +
        (t.engagements?.length ? ` engagements=${t.engagements.length}` : "") +
        (t.error ? ` error="${t.error}"` : ""),
    );
  }
  console.log(`Wrote ${OUT_PATH} in ${Math.round((Date.now() - started) / 1000)}s`);

  // Fail the CI job only if *every* theater failed — partial data is still
  // worth deploying.
  if (theaters.every((t) => !t.ok)) {
    console.error("All theaters failed to scan.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
