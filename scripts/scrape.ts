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
import type { MonitorSnapshot } from "../src/lib/types";

const OUT_PATH = join(process.cwd(), "public", "data", "snapshot.json");

/** The currently deployed snapshot, used to fill gaps (failed dates, seat
 *  counts not covered by this run's rotation). Set by the CI workflow. */
async function fetchPreviousSnapshot(): Promise<MonitorSnapshot | null> {
  const url = process.env.PREV_SNAPSHOT_URL;
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
    if (!res.ok) return null;
    const prev = (await res.json()) as MonitorSnapshot;
    // Ignore snapshots that are too old to be trustworthy (>24h)
    if (Date.now() - prev.lastChecked > 24 * 60 * 60_000) return null;
    console.log(`Loaded previous snapshot (${Math.round((Date.now() - prev.lastChecked) / 60000)}m old) for carry-over`);
    return prev;
  } catch {
    return null;
  }
}

async function main() {
  console.log("Scanning all theaters…");
  const started = Date.now();
  const [theaters, prev] = await Promise.all([scanAllTheaters(), fetchPreviousSnapshot()]);
  if (prev) applyCarryOver(prev.theaters, theaters);

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
    console.log(
      `  ${t.theaterName}: ok=${t.ok} showtimes=${t.showtimes.length}` +
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
