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
import { scanAllTheaters } from "../src/lib/scrapers";
import type { MonitorSnapshot } from "../src/lib/types";

const OUT_PATH = join(process.cwd(), "public", "data", "snapshot.json");

async function main() {
  console.log("Scanning all theaters…");
  const started = Date.now();
  const theaters = await scanAllTheaters();

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
