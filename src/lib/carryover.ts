import type { TheaterResult } from "./types";

/**
 * Fill gaps in a fresh scan with data from the previous one:
 * 1. dates whose page fetch failed keep their previous showtimes
 * 2. shows whose seat-count fetch failed/was skipped keep previous counts
 *
 * Used by the live server (previous in-memory snapshot) and by the CI scrape
 * (previously deployed snapshot.json), so a rate-limited request never blanks
 * out a whole day and seat-count coverage accumulates across runs.
 */
export function applyCarryOver(
  prevTheaters: TheaterResult[],
  theaters: TheaterResult[],
): void {
  const prevById = new Map(prevTheaters.map((t) => [t.theaterId, t]));
  for (const t of theaters) {
    const prevT = prevById.get(t.theaterId);
    if (!prevT) continue;

    // A completely failed scan (e.g. AMC 403-blocks GitHub's datacenter IPs
    // from time to time) keeps the previous scan's data instead of blanking
    // the theater. dataAsOf stays at the old timestamp so the UI can say how
    // stale the data is, and dates already in the past are dropped so they
    // don't pile up across a longer outage.
    if (!t.ok && (prevT.showtimes.length > 0 || (prevT.engagements?.length ?? 0) > 0)) {
      const cutoff = new Date(Date.now() - 36 * 3_600_000).toISOString().slice(0, 10);
      t.showtimes = prevT.showtimes.filter((s) => s.localDate >= cutoff);
      if (prevT.engagements) t.engagements = prevT.engagements;
      t.dataAsOf = prevT.dataAsOf;
      t.ok = true;
      t.error = undefined;
      continue;
    }

    const failed = new Set(t.failedDates ?? []);
    if (failed.size > 0) {
      const have = new Set(t.showtimes.map((s) => s.id));
      // Same physical showtime can appear under a different id after a
      // Fandango backfill, so also dedup by movie + local time.
      const haveSlots = new Set(t.showtimes.map((s) => `${s.movieId}|${s.localDateTime}`));
      const restored = prevT.showtimes.filter(
        (s) =>
          failed.has(s.localDate) &&
          !have.has(s.id) &&
          !haveSlots.has(`${s.movieId}|${s.localDateTime}`),
      );
      if (restored.length > 0) {
        t.showtimes = [...t.showtimes, ...restored].sort((a, b) =>
          a.localDateTime.localeCompare(b.localDateTime),
        );
      }
    }

    const prevShows = new Map(prevT.showtimes.map((s) => [s.id, s]));
    for (const s of t.showtimes) {
      const old = prevShows.get(s.id);
      if (s.seatsLeft === undefined && old?.seatsLeft !== undefined) {
        s.seatsLeft = old.seatsLeft;
        s.seatsTotal = old.seatsTotal;
        s.accessibleSeatsLeft = old.accessibleSeatsLeft;
        s.status = old.status;
      }
    }
  }
}
