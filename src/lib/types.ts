export type ShowtimeStatus = "available" | "almost_full" | "sold_out" | "unknown";

export interface Showtime {
  /** Stable unique id across refreshes (chain-prefixed showtime id) */
  id: string;
  /** Which tracked movie this showtime belongs to */
  movieId: string;
  /** ISO date of the show in the theater's local timezone, e.g. "2026-07-28" */
  localDate: string;
  /** Display time in the theater's local timezone, e.g. "7:45 PM" */
  displayTime: string;
  /** Sortable ISO datetime (theater-local, no offset) */
  localDateTime: string;
  status: ShowtimeStatus;
  /** Direct link to buy tickets for this exact showtime */
  ticketUrl: string;
  /** Format label, e.g. "IMAX 70mm" */
  format: string;
  /** Exact regular seats remaining (Cinemark only; AMC doesn't expose counts) */
  seatsLeft?: number;
  /** Total regular seats in the auditorium (Cinemark only) */
  seatsTotal?: number;
  /** Accessible (wheelchair/companion) seats remaining (Cinemark only) */
  accessibleSeatsLeft?: number;
}

/**
 * A film engagement at a venue that doesn't expose individual showtimes
 * publicly (the Bullock's ticket store hides its calendar behind a cart
 * session, but shows overall status and the screening window).
 */
export interface Engagement {
  movieId: string;
  /** e.g. "IMAX | The Odyssey" as listed by the venue */
  label: string;
  /** e.g. "July 17–August 20, 2026" */
  window?: string;
  status: "on_sale" | "sold_out";
  /** Link to buy / view on the venue's site */
  url: string;
}

export interface TheaterResult {
  theaterId: string;
  theaterName: string;
  location: string;
  chain: "cinemark" | "amc" | "bullock";
  /** Format this theater screens, e.g. "IMAX 70mm" or "IMAX 1.43 Dual Laser" */
  formatLabel: string;
  /** Landing page for the theater's showtimes */
  theaterUrl: string;
  showtimes: Showtime[];
  /** Engagement-level info for venues without public showtimes (Bullock) */
  engagements?: Engagement[];
  /** Whether the last scrape for this theater succeeded */
  ok: boolean;
  error?: string;
  /** Dates (YYYY-MM-DD) whose fetch failed this scan; previous data for
   *  these dates is carried over by the monitor */
  failedDates?: string[];
}

export interface MonitorSnapshot {
  theaters: TheaterResult[];
  /** Epoch ms of the last completed scan */
  lastChecked: number;
  /** Showtime ids (or alert keys) that appeared for the first time in the latest scan */
  newShowtimeIds: string[];
  /** True while a scan is in flight */
  checking: boolean;
}
