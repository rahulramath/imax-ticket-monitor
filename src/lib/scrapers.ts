import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { matchMovie, MOVIES } from "./movies";
import type { Engagement, Showtime, ShowtimeStatus, TheaterResult } from "./types";

const execFileAsync = promisify(execFile);

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const CINEMARK_BASE = "https://www.cinemark.com";
const CINEMARK_THEATER_PATH = "/theatres/tx-dallas/cinemark-dallas-xd-and-imax";

const AMC_BASE = "https://www.amctheatres.com";
const AMC_THEATER_PATH = "/movie-theatres/new-york-city/amc-lincoln-square-13/showtimes";

const BULLOCK_STORE = "https://tickets.thestoryoftexas.com";

/** Hard cap on how far ahead we probe for showtimes */
const MAX_HORIZON_DAYS = 45;
/** Stop probing after this many consecutive empty days (once past the first week) */
const EMPTY_STREAK_STOP = 5;

export const THEATERS = {
  cinemark: {
    theaterId: "cinemark-dallas-17-imax",
    theaterName: "Cinemark Dallas XD and IMAX",
    location: "Dallas, TX",
    chain: "cinemark" as const,
    formatLabel: "IMAX 70mm film · 1.43:1",
    theaterUrl: `${CINEMARK_BASE}${CINEMARK_THEATER_PATH}`,
    timeZone: "America/Chicago",
  },
  amc: {
    theaterId: "amc-lincoln-square-13",
    theaterName: "AMC Lincoln Square 13",
    location: "New York, NY",
    chain: "amc" as const,
    formatLabel: "IMAX 70mm film · 1.43:1",
    theaterUrl: `${AMC_BASE}${AMC_THEATER_PATH}`,
    timeZone: "America/New_York",
  },
  bullock: {
    theaterId: "bullock-museum-imax",
    theaterName: "Bullock Museum IMAX",
    location: "Austin, TX",
    chain: "bullock" as const,
    formatLabel: "IMAX DL2 dual laser · 1.43:1",
    theaterUrl: `${BULLOCK_STORE}/mainstore?vid=0&categoryId=1237`,
    timeZone: "America/Chicago",
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Format a Date as YYYY-MM-DD in a given IANA timezone */
export function localDateStr(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function upcomingDates(days: number, timeZone: string): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    out.push(localDateStr(new Date(now + i * 86_400_000), timeZone));
  }
  return out;
}

/**
 * Opening-week dates for tracked movies that release beyond the rolling scan
 * horizon (e.g. Dune: Part Three in December). Sales for premium formats
 * open months early, so we probe these windows on top of the near-term scan.
 */
function releaseWindowDates(afterDate: string, days = 8): string[] {
  const out = new Set<string>();
  for (const movie of MOVIES) {
    if (movie.releaseDate <= afterDate) continue;
    const [y, m, d] = movie.releaseDate.split("-").map(Number);
    const start = Date.UTC(y, m - 1, d);
    for (let i = 0; i < days; i++) {
      out.add(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
    }
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// Shared cookie jar for AMC's Queue-it acceptance cookie.
const cookieJars = new Map<string, Map<string, string>>();

function jarFor(url: string): Map<string, string> {
  const host = new URL(url).hostname.split(".").slice(-2).join(".");
  let jar = cookieJars.get(host);
  if (!jar) cookieJars.set(host, (jar = new Map()));
  return jar;
}

class RateLimitError extends Error {}

/**
 * Cinemark's CDN fingerprints TLS/HTTP clients and starts returning 404s to
 * Node's fetch (undici) on protected routes like TicketSeatMap, while curl
 * keeps working. Shell out to curl for all Cinemark requests.
 */
async function fetchViaCurl(url: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "curl",
    [
      "-sL",
      "--compressed",
      "-m",
      "45",
      "-w",
      "\n%{http_code}",
      "-A",
      UA,
      "-H",
      "Accept-Language: en-US,en;q=0.9",
      url,
    ],
    { maxBuffer: 20 * 1024 * 1024, timeout: 50_000 },
  );
  const cut = stdout.lastIndexOf("\n");
  const status = Number(stdout.slice(cut + 1));
  const body = stdout.slice(0, cut);
  if (status === 429 || body.includes("Just a moment")) {
    throw new RateLimitError(`Rate limited (${status}) for ${url}`);
  }
  if (status >= 400 || body.length < 1000) {
    throw new Error(`HTTP ${status} (len ${body.length}) for ${url}`);
  }
  return body;
}

async function fetchPage(url: string): Promise<string> {
  const host = new URL(url).hostname;
  if (host.endsWith("cinemark.com")) {
    return fetchViaCurl(url);
  }
  // AMC needs a cookie jar for its Queue-it acceptance cookie.
  const jar = jarFor(url);
  let current = url;
  for (let hop = 0; hop < 10; hop++) {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(current, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: "manual",
      // AMC's server-rendered pages routinely take 20-40s to respond
      signal: AbortSignal.timeout(75_000),
      cache: "no-store",
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [kv] = sc.split(";");
      const eq = kv.indexOf("=");
      if (eq > 0) jar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1));
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Redirect without location from ${current}`);
      current = new URL(loc, current).href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${current}`);
    return res.text();
  }
  throw new Error(`Too many redirects for ${url}`);
}

// ---------------------------------------------------------------------------
// Cinemark
//
// Cinemark's site is Cloudflare-challenged for datacenter IPs (HTML pages and
// the /TicketSeatMap/ page alike), but its JSON layer under /papi/ is not, and
// /papi/theaters/{id}/showtimes?date=YYYY-MM-DD returns every showtime with
// exact `seatsAvailable` / `totalSeats`. One request per date gives showtimes
// and seat counts together; no seat-map crawling.
// ---------------------------------------------------------------------------

/** Cinemark's numeric theater id (from the /TicketSeatMap/ URLs) */
const CINEMARK_THEATER_ID = 207;

interface PapiShowtime {
  id: number;
  /** Theater-local time with a misleading "Z" suffix, e.g. "2026-09-25T08:00:00.000Z" */
  startTime: string;
  seatsAvailable: number;
  totalSeats: number;
  status: number;
}

interface PapiMovie {
  movieTitle?: string;
  cinemarkMovieId?: number;
  showtimesByPrintType?: { printTypeName?: string; showtimes?: PapiShowtime[] }[];
}

/** curl, like fetchViaCurl, but for JSON: no minimum body length */
async function fetchCinemarkJson<T>(url: string): Promise<T> {
  const { stdout } = await execFileAsync(
    "curl",
    ["-s", "--compressed", "-m", "45", "-w", "\n%{http_code}", "-A", UA, "-H", "Accept: application/json", url],
    { maxBuffer: 40 * 1024 * 1024, timeout: 50_000 },
  );
  const cut = stdout.lastIndexOf("\n");
  const status = Number(stdout.slice(cut + 1));
  const body = stdout.slice(0, cut);
  if (status === 429 || (status === 403 && body.includes("Just a moment"))) {
    throw new RateLimitError(`Rate limited (${status}) for ${url}`);
  }
  if (status !== 200) throw new Error(`HTTP ${status} for ${url}`);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Non-JSON response (len ${body.length}) for ${url}`);
  }
}

function formatTime12(hh: number, mm: number): string {
  const suffix = hh >= 12 ? "PM" : "AM";
  const h = hh % 12 === 0 ? 12 : hh % 12;
  return `${h}:${String(mm).padStart(2, "0")} ${suffix}`;
}

function parseCinemarkPapi(movies: PapiMovie[]): Showtime[] {
  const out: Showtime[] = [];
  const now = Date.now();
  for (const movie of movies) {
    const title = movie.movieTitle ?? "";
    const tracked = matchMovie(title);
    if (!tracked) continue;
    for (const pt of movie.showtimesByPrintType ?? []) {
      const print = pt.printTypeName ?? "";
      const isImax70 =
        /imax/i.test(`${print} ${title}`) && /70\s*mm/i.test(`${print} ${title}`);
      if (!isImax70) continue;
      for (const st of pt.showtimes ?? []) {
        const localDateTime = st.startTime.replace(/(\.\d+)?Z$/, "");
        const [hh, mm] = localDateTime.slice(11, 16).split(":").map(Number);
        const left = Math.max(0, st.seatsAvailable ?? 0);
        const total = st.totalSeats ?? 0;
        const status: ShowtimeStatus =
          left === 0 ? "sold_out" : total > 0 && left / total < 0.15 ? "almost_full" : "available";
        out.push({
          id: `cinemark-${st.id}`,
          movieId: tracked.id,
          localDate: localDateTime.slice(0, 10),
          localDateTime,
          displayTime: formatTime12(hh, mm),
          status,
          ticketUrl:
            `${CINEMARK_BASE}/TicketSeatMap/?TheaterId=${CINEMARK_THEATER_ID}` +
            `&ShowtimeId=${st.id}&CinemarkMovieId=${movie.cinemarkMovieId ?? ""}&Showtime=${localDateTime}`,
          format: "IMAX 70mm",
          seatsLeft: left,
          seatsTotal: total,
          seatsCheckedAt: now,
        });
      }
    }
  }
  return out;
}

async function scanCinemark(): Promise<TheaterResult> {
  const meta = THEATERS.cinemark;
  const all = new Map<string, Showtime>();
  const errors: string[] = [];
  const failedDates: string[] = [];
  const today = localDateStr(new Date(), meta.timeZone);

  // Fandango supplies the date list cheaply and backfills showtimes (without
  // counts) if Cinemark's API ever fails.
  const fd = await discoverFandangoDates("cinemark").catch(() => ({
    dates: [] as string[],
    entries: new Map<string, FandangoEntry>(),
  }));
  const dateSet = new Set<string>([today, ...fd.dates.filter((d) => d >= today)]);
  if (dateSet.size <= 1) for (const d of upcomingDates(14, meta.timeZone)) dateSet.add(d);
  // Opening weeks of future tracked releases (premium-format sales open
  // months ahead)
  const lastCovered = [...dateSet].sort().pop() ?? today;
  for (const d of releaseWindowDates(lastCovered)) dateSet.add(d);
  const dates = [...dateSet].sort();

  // Blocked detector: if the first few requests all fail with nothing fetched,
  // stop rather than grinding through every date.
  let straightFailures = 0;
  for (const date of dates) {
    try {
      const movies = await fetchCinemarkJson<PapiMovie[]>(
        `${CINEMARK_BASE}/papi/theaters/${CINEMARK_THEATER_ID}/showtimes?date=${date}`,
      );
      for (const s of parseCinemarkPapi(Array.isArray(movies) ? movies : [])) all.set(s.id, s);
      straightFailures = 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${date}: ${msg}`);
      failedDates.push(date);
      if (all.size === 0 && ++straightFailures >= 4) {
        for (const rest of dates.slice(dates.indexOf(date) + 1)) {
          errors.push(`${rest}: skipped`);
          failedDates.push(rest);
        }
        errors[0] = `Cinemark unreachable from here (${errors[0]})`;
        break;
      }
    }
    await sleep(300);
  }

  // Sold-out status for anything without a count, plus backfill of anything
  // Cinemark's API didn't return. A date Fandango covered isn't a data gap.
  mergeFandango(all, fd.entries, "cinemark");
  const fdCovered = new Set(fd.dates);
  const uncoveredFailed = failedDates.filter((d) => !fdCovered.has(d));
  failedDates.length = 0;
  failedDates.push(...uncoveredFailed);

  const showtimes = [...all.values()].sort((a, b) =>
    a.localDateTime.localeCompare(b.localDateTime),
  );

  return {
    ...metaToResult(meta),
    showtimes,
    ok: errors.length === 0 || showtimes.length > 0 || errors.length < dates.length,
    error:
      errors.length > 0 ? `${errors.length} request(s) failed, e.g. ${errors[0]}` : undefined,
    failedDates,
  };
}

// ---------------------------------------------------------------------------
// AMC
// ---------------------------------------------------------------------------

function mapAmcStatus(status: string): ShowtimeStatus {
  switch (status) {
    case "Sellable":
      return "available";
    case "AlmostFull":
      return "almost_full";
    case "SoldOut":
    case "NotSellable":
    case "NoLongerAvailable":
      return "sold_out";
    default:
      return "unknown";
  }
}

function amcDisplayTime(utcIso: string): {
  localDate: string;
  localDateTime: string;
  displayTime: string;
} {
  const d = new Date(utcIso);
  const tz = THEATERS.amc.timeZone;
  const localDate = localDateStr(d, tz);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  const hms = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
  return { localDate, localDateTime: `${localDate}T${hms}`, displayTime: time };
}

/**
 * AMC's showtimes page ships a React Server Components payload with escaped
 * JSON. Each showtime object is followed by an aria-describedby chain that
 * encodes movie slug + format group (e.g. "...the-odyssey-...-imax70mm-0").
 */
function parseAmcDay(html: string): Showtime[] {
  const shows = new Map<string, Showtime>();
  const re =
    /\\+"showtimeId\\+":(\d+),.{0,300}?\\+"status\\+":\\+"(\w+)\\+",\\+"showDateTimeUtc\\+":\\+"([^"\\]+)\\+".{0,600}?\\+"aria-describedby\\+":\\+"([^"\\]+)\\+"/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const [, showtimeId, status, utc, describedBy] = m;
    // Only true IMAX 70mm engagements (skip the standard 70mm screen)
    if (!describedBy.includes("imax70mm")) continue;
    const movie = matchMovie(describedBy);
    if (!movie) continue;
    const id = `amc-${showtimeId}`;
    if (shows.has(id)) continue;
    const { localDate, localDateTime, displayTime } = amcDisplayTime(utc);
    shows.set(id, {
      id,
      movieId: movie.id,
      localDate,
      localDateTime,
      displayTime,
      status: mapAmcStatus(status),
      ticketUrl: `${AMC_BASE}/showtimes/${showtimeId}`,
      format: "IMAX 70mm",
    });
  }
  return [...shows.values()];
}

// ---------------------------------------------------------------------------
// Fandango (AMC date discovery + sold-out enrichment)
// ---------------------------------------------------------------------------

/**
 * Fandango listings for the tracked theaters. Fandango's JSON API is not
 * behind a Cloudflare challenge, so it works from GitHub's datacenter IPs
 * where the chains' own sites don't. It gives showtimes, sold-out status and
 * a per-show purchase link, but no seat counts.
 */
const FANDANGO_THEATERS = {
  amc: {
    id: "AABQI",
    url: "https://www.fandango.com/amc-lincoln-square-13-aabqi/theater-page",
  },
  cinemark: {
    id: "AACBT",
    url: "https://www.fandango.com/cinemark-dallas-xd-and-imax-aacbt/theater-page",
  },
} as const;
type FandangoVenue = keyof typeof FANDANGO_THEATERS;

interface FandangoShowtime {
  type: string; // "available" | "soldout" | "pastshowtime"
  ticketingDate: string; // "2026-07-24+10:00" (theater-local)
  date: string; // "10:00a"
  ticketingJumpPageURL?: string;
}

interface FandangoEntry {
  key: string; // "movieId|YYYY-MM-DDTHH:MM"
  movieId: string;
  localDateTime: string;
  type: string;
  displayTime: string;
  ticketUrl: string;
}

async function fetchFandangoDay(venue: FandangoVenue, date: string): Promise<FandangoEntry[]> {
  const theater = FANDANGO_THEATERS[venue];
  const res = await fetch(
    `https://www.fandango.com/napi/theaterMovieShowtimes/${theater.id}?startDate=${date}`,
    {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Referer: theater.url,
      },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    },
  );
  if (!res.ok) throw new Error(`Fandango HTTP ${res.status}`);
  const data = (await res.json()) as {
    viewModel?: {
      movies?: {
        title?: string;
        variants?: {
          amenityGroups?: {
            amenities?: { name?: string }[];
            showtimes?: FandangoShowtime[];
          }[];
        }[];
      }[];
    };
  };

  const out: FandangoEntry[] = [];
  for (const fdMovie of data.viewModel?.movies ?? []) {
    const movie = matchMovie(fdMovie.title ?? "");
    if (!movie) continue;
    for (const variant of fdMovie.variants ?? []) {
      for (const group of variant.amenityGroups ?? []) {
        const names = (group.amenities ?? []).map((a) => a.name ?? "");
        const isImax70 =
          names.some((n) => /imax/i.test(n)) && names.some((n) => /70\s*mm/i.test(n));
        if (!isImax70) continue;
        for (const st of group.showtimes ?? []) {
          if (!st.ticketingDate) continue;
          const localDateTime = st.ticketingDate.replace("+", "T");
          out.push({
            key: `${movie.id}|${localDateTime}`,
            movieId: movie.id,
            localDateTime,
            type: st.type,
            displayTime: st.date.replace(/a$/, " AM").replace(/p$/, " PM"),
            ticketUrl: st.ticketingJumpPageURL ?? theater.url,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Probe Fandango (fast, JSON) day by day to find which dates actually have
 * tracked IMAX 70mm shows at a venue, so we only fetch the chain's slow
 * pages for those dates. Stops after a run of empty days.
 */
async function discoverFandangoDates(
  venue: FandangoVenue,
): Promise<{ dates: string[]; entries: Map<string, FandangoEntry> }> {
  const tz = THEATERS[venue].timeZone;
  const allDates = upcomingDates(MAX_HORIZON_DAYS, tz);
  const dates: string[] = [];
  const entries = new Map<string, FandangoEntry>();

  let emptyStreak = 0;
  const PROBE_CONCURRENCY = 5;
  outer: for (let i = 0; i < allDates.length; i += PROBE_CONCURRENCY) {
    const batch = allDates.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((d) => fetchFandangoDay(venue, d)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const date = batch[j];
      const dayEntries =
        r.status === "fulfilled" ? r.value.filter((e) => e.localDateTime.startsWith(date)) : [];
      if (dayEntries.length > 0) {
        dates.push(date);
        for (const e of dayEntries) entries.set(e.key, e);
        emptyStreak = 0;
      } else if (i + j >= 7 && ++emptyStreak >= EMPTY_STREAK_STOP) {
        break outer;
      }
    }
  }

  // Opening weeks of future tracked releases, beyond the rolling horizon
  // (e.g. Dune: Part Three tickets go on sale months before December).
  // Dates with hits also get a real AMC page fetch: AMC's own status and
  // purchase links are the source of truth — Fandango's far-future
  // "available" flag can be stale, and its checkout links route through a
  // Queue-it waiting room on busy release days.
  const extra = releaseWindowDates(allDates[allDates.length - 1]);
  for (let i = 0; i < extra.length; i += PROBE_CONCURRENCY) {
    const batch = extra.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((d) => fetchFandangoDay(venue, d)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const date = batch[j];
      const dayEntries =
        r.status === "fulfilled" ? r.value.filter((e) => e.localDateTime.startsWith(date)) : [];
      if (dayEntries.length > 0) {
        dates.push(date);
        for (const e of dayEntries) entries.set(e.key, e);
      }
    }
  }
  return { dates, entries };
}

/**
 * Merge Fandango data into a chain's own showtimes: mark sold-out shows
 * (unless we hold an exact seat count, which is authoritative) and backfill
 * shows the chain's pages didn't return, whether because they hide sold-out
 * shows, because far-future dates were skipped, or because the chain's site
 * blocked us entirely.
 */
function mergeFandango(
  all: Map<string, Showtime>,
  fdEntries: Map<string, FandangoEntry>,
  idPrefix: string,
): void {
  const byKey = new Map<string, Showtime>();
  for (const s of all.values()) byKey.set(`${s.movieId}|${s.localDateTime.slice(0, 16)}`, s);
  for (const [key, entry] of fdEntries) {
    const existing = byKey.get(key);
    if (existing) {
      if (entry.type === "soldout" && existing.seatsLeft === undefined) {
        existing.status = "sold_out";
      }
      continue;
    }
    if (entry.type !== "soldout" && entry.type !== "available") continue;
    const id = `${idPrefix}-fd-${key.replace(/[|:]/g, "-")}`;
    all.set(id, {
      id,
      movieId: entry.movieId,
      localDate: entry.localDateTime.slice(0, 10),
      localDateTime: `${entry.localDateTime}:00`,
      displayTime: entry.displayTime,
      status: entry.type === "soldout" ? "sold_out" : "available",
      ticketUrl: entry.ticketUrl,
      format: "IMAX 70mm",
    });
  }
}

async function scanAmc(): Promise<TheaterResult> {
  const meta = THEATERS.amc;
  const all = new Map<string, Showtime>();
  const errors: string[] = [];

  let dates: string[];
  let fdEntries = new Map<string, FandangoEntry>();
  try {
    ({ dates, entries: fdEntries } = await discoverFandangoDates("amc"));
  } catch {
    dates = [];
  }
  if (dates.length === 0) {
    // Fandango unavailable — fall back to a fixed window
    dates = upcomingDates(10, meta.timeZone);
  }

  const failedDates: string[] = [];

  // First request alone to establish the Queue-it acceptance cookie
  try {
    const html = await fetchPage(`${meta.theaterUrl}?date=${dates[0]}`);
    if (!html.includes("__next_f")) throw new Error("blocked by queue page");
    for (const s of parseAmcDay(html)) all.set(s.id, s);
  } catch (e) {
    errors.push(`${dates[0]}: ${e instanceof Error ? e.message : e}`);
    failedDates.push(dates[0]);
  }

  const CONCURRENCY = 3;
  const remaining = dates.slice(1);
  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch = remaining.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (date) => {
        const html = await fetchPage(`${meta.theaterUrl}?date=${date}`);
        if (!html.includes("__next_f")) throw new Error("blocked by queue page");
        return parseAmcDay(html);
      }),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") for (const s of r.value) all.set(s.id, s);
      else {
        errors.push(`${batch[j]}: ${r.reason?.message ?? r.reason}`);
        failedDates.push(batch[j]);
      }
    }
  }

  // Sold-out status plus backfill of shows AMC's pages didn't return (sold-out
  // shows AMC hides, far-future release-window dates, or everything when AMC's
  // Cloudflare challenge blocks us).
  mergeFandango(all, fdEntries, "amc");
  const fdCoveredDates = new Set([...fdEntries.values()].map((e) => e.localDateTime.slice(0, 10)));
  const uncoveredFailed = failedDates.filter((d) => !fdCoveredDates.has(d));
  failedDates.length = 0;
  failedDates.push(...uncoveredFailed);

  const showtimes = [...all.values()].sort((a, b) =>
    a.localDateTime.localeCompare(b.localDateTime),
  );

  return {
    ...metaToResult(meta),
    showtimes,
    // Fandango backfill makes a scan useful even when AMC's own pages are
    // all blocked (AMC moved behind a Cloudflare challenge in Sep 2026).
    ok: showtimes.length > 0 || errors.length < dates.length,
    error:
      errors.length > 0
        ? `${errors.length}/${dates.length} AMC page(s) failed, e.g. ${errors[0]}`
        : undefined,
    failedDates,
  };
}

// ---------------------------------------------------------------------------
// Bullock Museum IMAX (Austin) — engagement-level tracking
// ---------------------------------------------------------------------------

/**
 * The Bullock's ticket store hides its showtime calendar behind a cart
 * session, but each film's category page shows an overall "All showtimes are
 * sold out!" banner and the screening window. Track at engagement level.
 */
async function scanBullock(): Promise<TheaterResult> {
  const meta = THEATERS.bullock;
  const engagements: Engagement[] = [];

  const rootHtml = await fetchPage(`${BULLOCK_STORE}/mainstore?vid=0`);
  // Film categories appear as links like:
  //   <a href="/mainstore?categoryId=1329&#cat1329">IMAX | The Odyssey</a>
  const links = [
    ...rootHtml.matchAll(/<a href="\/mainstore\?categoryId=(\d+)[^"]*">\s*([^<]+?)\s*<\/a>/g),
  ];
  const seen = new Set<string>();
  for (const [, categoryId, rawLabel] of links) {
    const label = decodeEntities(rawLabel.trim());
    const movie = matchMovie(label);
    if (!movie || seen.has(movie.id)) continue;
    seen.add(movie.id);

    const url = `${BULLOCK_STORE}/mainstore?categoryId=${categoryId}`;
    let status: Engagement["status"] = "on_sale";
    let window: string | undefined;
    try {
      const page = await fetchPage(url);
      if (/all showtimes are sold out/i.test(page)) status = "sold_out";
      const w = page.match(/Screening\s+([^<]{4,60}?)(?:<|$)/i);
      if (w) window = w[1].trim();
    } catch {
      // keep defaults; the engagement listing itself is still meaningful
    }

    engagements.push({ movieId: movie.id, label, window, status, url });
  }

  return {
    ...metaToResult(meta),
    showtimes: [],
    engagements,
    ok: true,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function metaToResult(meta: (typeof THEATERS)[keyof typeof THEATERS]) {
  return {
    theaterId: meta.theaterId,
    theaterName: meta.theaterName,
    location: meta.location,
    chain: meta.chain,
    formatLabel: meta.formatLabel,
    theaterUrl: meta.theaterUrl,
  };
}

function failedResult(
  meta: (typeof THEATERS)[keyof typeof THEATERS],
  err: unknown,
): TheaterResult {
  return {
    ...metaToResult(meta),
    showtimes: [],
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

export async function scanAllTheaters(): Promise<TheaterResult[]> {
  const [cinemark, amc, bullock] = await Promise.all([
    scanCinemark().catch((e) => failedResult(THEATERS.cinemark, e)),
    scanAmc().catch((e) => failedResult(THEATERS.amc, e)),
    scanBullock().catch((e) => failedResult(THEATERS.bullock, e)),
  ]);
  const results = [cinemark, amc, bullock];
  const now = Date.now();
  for (const r of results) if (r.ok) r.dataAsOf = now;
  return results;
}
