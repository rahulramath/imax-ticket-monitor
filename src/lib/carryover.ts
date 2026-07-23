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
