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
    formatLabel: "IMAX 70mm",
    theaterUrl: `${CINEMARK_BASE}${CINEMARK_THEATER_PATH}`,
    timeZone: "America/Chicago",
  },
  amc: {
    theaterId: "amc-lincoln-square-13",
    theaterName: "AMC Lincoln Square 13",
    location: "New York, NY",
    chain: "amc" as const,
    formatLabel: "IMAX 70mm",
    theaterUrl: `${AMC_BASE}${AMC_THEATER_PATH}`,
    timeZone: "America/New_York",
  },
  bullock: {
    theaterId: "bullock-museum-imax",
    theaterName: "Bullock Museum IMAX",
    location: "Austin, TX",
    chain: "bullock" as const,
    formatLabel: "IMAX 1.43 Dual Laser",
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
// ---------------------------------------------------------------------------

interface CinemarkShowtimeJson {
  showtimeId: number;
  showTime: string; // theater-local ISO, e.g. "2026-07-28T07:45:00"
  showTimeUrl: string; // query string for /TicketSeatMap/
  displayShowTime: string;
}

interface CinemarkModelJson {
  cinemarkMovieId: number;
  movieTitle: string;
  showTimes?: CinemarkShowtimeJson[];
}

/**
 * Cinemark lists IMAX 70mm engagements as separate "movies" with titles like
 * "The Odyssey IMAX 70MM". Match tracked movies whose title also mentions 70mm.
 */
function parseCinemarkDay(html: string): Showtime[] {
  const shows = new Map<string, Showtime>();
  const modelRe = /data-json-model="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(html)) !== null) {
    let model: CinemarkModelJson;
    try {
      model = JSON.parse(decodeEntities(m[1]));
    } catch {
      continue;
    }
    const title = model.movieTitle ?? "";
    if (!/70\s*mm/i.test(title)) continue;
    const movie = matchMovie(title);
    if (!movie) continue;
    for (const st of model.showTimes ?? []) {
      const id = `cinemark-${st.showtimeId}`;
      if (shows.has(id)) continue;
      shows.set(id, {
        id,
        movieId: movie.id,
        localDate: st.showTime.slice(0, 10),
        localDateTime: st.showTime,
        displayTime: st.displayShowTime,
        status: "available",
        ticketUrl: `${CINEMARK_BASE}/TicketSeatMap/${decodeEntities(st.showTimeUrl)}`,
        format: "IMAX 70mm",
      });
    }
  }
  return [...shows.values()];
}

/** Available dates from the theater page's date carousel */
function parseCinemarkDates(html: string): string[] {
  const dates = new Set<string>(
    [...html.matchAll(/data-datevalue="(20\d\d-\d\d-\d\d)"/g)].map((m) => m[1]),
  );
  return [...dates].sort();
}

/** Circuit breaker: after a 429, skip seat maps until this timestamp. */
let seatMapCooldownUntil = 0;
/** Rotation cursor for far-out seat map refreshes */
let farRotation = 0;
/** Dates confirmed to have no tracked shows → recheck at most every 6h */
const cinemarkEmptyDates = new Map<string, number>();
const EMPTY_DATE_RECHECK_MS = 6 * 60 * 60_000;

/**
 * Cinemark's seat map page renders every seat server-side as a button with
 * available="True|False" and a seatType. Counting them gives exact
 * remaining-seat numbers per showtime.
 */
async function fetchCinemarkSeatCounts(show: Showtime, attempt = 0): Promise<void> {
  let html: string;
  try {
    html = await fetchPage(show.ticketUrl);
  } catch (e) {
    // Cinemark lists showtimes before their seat map / purchase page goes
    // live; those return a hard 404. Flag them as "not on sale yet".
    if (e instanceof Error && e.message.startsWith("HTTP 404")) {
      show.status = "unknown";
      return;
    }
    // Cloudflare rate limit: give up immediately and cool down; previous
    // scan's seat counts are carried over by the monitor.
    if (e instanceof RateLimitError) {
      seatMapCooldownUntil = Date.now() + 10 * 60_000;
      console.error(`[cinemark seats] rate limited — cooling down 10 min`);
      throw e;
    }
    if (attempt < 2) {
      await sleep(2_000 * (attempt + 1));
      return fetchCinemarkSeatCounts(show, attempt + 1);
    }
    console.error(`[cinemark seats] ${show.id} failed:`, e instanceof Error ? e.message : e);
    throw e;
  }
  const buttons = [...html.matchAll(/<button available="(True|False)"[^>]*seatType="(\w+)"/g)];
  if (buttons.length === 0) {
    if (attempt < 2) {
      await sleep(2_000 * (attempt + 1));
      return fetchCinemarkSeatCounts(show, attempt + 1);
    }
    console.error(`[cinemark seats] ${show.id}: no seat buttons in response (len ${html.length})`);
    return;
  }
  let seatsLeft = 0;
  let seatsTotal = 0;
  let accessibleLeft = 0;
  for (const [, avail, type] of buttons) {
    if (type === "seat") {
      seatsTotal++;
      if (avail === "True") seatsLeft++;
    } else if (avail === "True") {
      accessibleLeft++;
    }
  }
  show.seatsLeft = seatsLeft;
  show.seatsTotal = seatsTotal;
  show.accessibleSeatsLeft = accessibleLeft;
  if (seatsLeft === 0 && accessibleLeft === 0) show.status = "sold_out";
  else if (seatsLeft / seatsTotal < 0.15) show.status = "almost_full";
}

async function scanCinemark(): Promise<TheaterResult> {
  const meta = THEATERS.cinemark;
  const all = new Map<string, Showtime>();
  const errors: string[] = [];
  const failedDates: string[] = [];

  // First fetch discovers the full engagement window from the date carousel
  let dates: string[] = [];
  const today = localDateStr(new Date(), meta.timeZone);
  try {
    const html = await fetchPage(meta.theaterUrl);
    for (const s of parseCinemarkDay(html)) all.set(s.id, s);
    dates = parseCinemarkDates(html).filter((d) => d > today);
  } catch (e) {
    errors.push(`base: ${e instanceof Error ? e.message : e}`);
    failedDates.push(today);
    dates = upcomingDates(14, meta.timeZone).slice(1);
  }

  // Opening weeks of future tracked releases (premium-format sales open
  // months ahead; the carousel won't include those dates until closer in)
  const lastCovered = dates[dates.length - 1] ?? today;
  for (const d of releaseWindowDates(lastCovered)) {
    if (!dates.includes(d)) dates.push(d);
  }

  // Sequential with pacing — Cinemark's Cloudflare rate-limits bursts, and
  // the carousel can span months (special events), so keep requests gentle.
  // Dates that had no tracked shows are re-checked at most every 6h.
  const now = Date.now();
  for (const date of dates) {
    const lastEmpty = cinemarkEmptyDates.get(date);
    if (lastEmpty && now - lastEmpty < EMPTY_DATE_RECHECK_MS) continue;
    let found: Showtime[] | null = null;
    for (let attempt = 0; attempt < 2 && found === null; attempt++) {
      try {
        const html = await fetchPage(`${meta.theaterUrl}?showDate=${date}`);
        found = parseCinemarkDay(html);
      } catch (e) {
        if (e instanceof RateLimitError && attempt === 0) {
          await sleep(8_000);
          continue;
        }
        errors.push(`${date}: ${e instanceof Error ? e.message : e}`);
        failedDates.push(date);
        break;
      }
    }
    if (found !== null) {
      if (found.length === 0) cinemarkEmptyDates.set(date, now);
      else cinemarkEmptyDates.delete(date);
      for (const s of found) all.set(s.id, s);
    }
    await sleep(700);
  }

  const showtimes = [...all.values()].sort((a, b) =>
    a.localDateTime.localeCompare(b.localDateTime),
  );

  // Seat maps: one at a time with a generous gap — Cloudflare 429s
  // /TicketSeatMap after roughly a dozen rapid hits. With the full
  // engagement window (~120 shows) we can't cover every seat map every
  // scan: prioritize the next 5 days, then rotate through the rest a few
  // per scan (the monitor carries older counts over between scans).
  const seatCutoff = localDateStr(new Date(Date.now() + 5 * 86_400_000), meta.timeZone);
  const nearShows = showtimes.filter((s) => s.localDate <= seatCutoff);
  const farShows = showtimes.filter((s) => s.localDate > seatCutoff);
  const farBatch =
    farShows.length > 0
      ? Array.from(
          { length: Math.min(6, farShows.length) },
          (_, i) => farShows[(farRotation + i) % farShows.length],
        )
      : [];
  farRotation += farBatch.length;
  for (const s of [...nearShows, ...farBatch]) {
    if (Date.now() < seatMapCooldownUntil) break;
    await Promise.allSettled([fetchCinemarkSeatCounts(s)]);
    await sleep(6_000);
  }

  return {
    ...metaToResult(meta),
    showtimes,
    ok: errors.length === 0 || showtimes.length > 0 || errors.length < dates.length + 1,
    error: errors.length > 0 ? `${errors.length} request(s) failed` : undefined,
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

/** Fandango's theater id for AMC Lincoln Square 13 */
const FANDANGO_THEATER_ID = "AABQI";
const FANDANGO_THEATER_URL =
  "https://www.fandango.com/amc-lincoln-square-13-aabqi/theater-page";

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

async function fetchFandangoDay(date: string): Promise<FandangoEntry[]> {
  const res = await fetch(
    `https://www.fandango.com/napi/theaterMovieShowtimes/${FANDANGO_THEATER_ID}?startDate=${date}`,
    {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Referer: FANDANGO_THEATER_URL,
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
            ticketUrl: st.ticketingJumpPageURL ?? FANDANGO_THEATER_URL,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Probe Fandango (fast, JSON) day by day to find which dates actually have
 * tracked IMAX 70mm shows at AMC, so we only fetch AMC's slow pages for
 * those dates. Stops after a run of empty days.
 */
async function discoverAmcDates(): Promise<{ dates: string[]; entries: Map<string, FandangoEntry> }> {
  const tz = THEATERS.amc.timeZone;
  const allDates = upcomingDates(MAX_HORIZON_DAYS, tz);
  const dates: string[] = [];
  const entries = new Map<string, FandangoEntry>();

  let emptyStreak = 0;
  const PROBE_CONCURRENCY = 5;
  outer: for (let i = 0; i < allDates.length; i += PROBE_CONCURRENCY) {
    const batch = allDates.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((d) => fetchFandangoDay(d)));
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
    const results = await Promise.allSettled(batch.map((d) => fetchFandangoDay(d)));
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

async function scanAmc(): Promise<TheaterResult> {
  const meta = THEATERS.amc;
  const all = new Map<string, Showtime>();
  const errors: string[] = [];

  let dates: string[];
  let fdEntries = new Map<string, FandangoEntry>();
  try {
    ({ dates, entries: fdEntries } = await discoverAmcDates());
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

  // Merge Fandango data: mark sold-out shows, and backfill any show AMC's
  // own pages didn't return (sold-out shows AMC hides, plus far-future
  // release-window shows where we skip AMC's slow pages entirely).
  const byKey = new Map<string, Showtime>();
  for (const s of all.values()) byKey.set(`${s.movieId}|${s.localDateTime.slice(0, 16)}`, s);
  for (const [key, entry] of fdEntries) {
    const existing = byKey.get(key);
    if (existing) {
      if (entry.type === "soldout") existing.status = "sold_out";
      continue;
    }
    if (entry.type !== "soldout" && entry.type !== "available") continue;
    const id = `amc-fd-${key.replace(/[|:]/g, "-")}`;
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

  const showtimes = [...all.values()].sort((a, b) =>
    a.localDateTime.localeCompare(b.localDateTime),
  );

  return {
    ...metaToResult(meta),
    showtimes,
    ok: errors.length < dates.length,
    error: errors.length >= dates.length ? errors[0] : undefined,
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
  return [cinemark, amc, bullock];
}
