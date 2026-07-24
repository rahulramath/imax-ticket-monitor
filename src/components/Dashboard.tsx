"use client";

/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MOVIES } from "@/lib/movies";
import type { MonitorSnapshot, TheaterResult } from "@/lib/types";
import { TheaterCard } from "./TheaterCard";

const POLL_MS = 45_000;
const NOTIFY_PREF_KEY = "odyssey70mm.notify";
const MOVIE_PREF_KEY = "odyssey70mm.movie";
const THEME_PREF_KEY = "odyssey70mm.theme";

// Kept out of the rendered markup; the mailto is only assembled on click so
// the address never appears on the page.
const REQUEST_EMAIL = process.env.NEXT_PUBLIC_REQUEST_EMAIL ?? "";

// Static export (GitHub Pages): no server, data comes from a snapshot JSON
// that a scheduled GitHub Action refreshes.
const IS_STATIC = process.env.NEXT_PUBLIC_STATIC_EXPORT === "1";
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function openRequestEmail() {
  if (!REQUEST_EMAIL) return;
  const subject = encodeURIComponent("IMAX Ticket Monitor — theater/movie request");
  const body = encodeURIComponent(
    "Hi! Please add tracking for:\n\nTheater: \nMovie: \n\n(Anything else worth knowing?)",
  );
  window.location.href = `mailto:${REQUEST_EMAIL}?subject=${subject}&body=${body}`;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function timeAgo(ts: number, now: number): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

function localDateInTz(tz: string, offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

const THEATER_TZ: Record<TheaterResult["chain"], string> = {
  cinemark: "America/Chicago",
  amc: "America/New_York",
  bullock: "America/Chicago",
};

interface MovieSummary {
  buyable: number;
  seatsLeft: number;
  hasSeatData: boolean;
  theaterCount: number;
  engagementOnSale: boolean;
  engagementSoldOut: boolean;
  anything: boolean;
}

function summarizeMovie(theaters: TheaterResult[], movieId: string): MovieSummary {
  let buyable = 0;
  let seatsLeft = 0;
  let hasSeatData = false;
  let theaterCount = 0;
  let engagementOnSale = false;
  let engagementSoldOut = false;
  for (const t of theaters) {
    const shows = t.showtimes.filter((s) => s.movieId === movieId);
    const engs = (t.engagements ?? []).filter((e) => e.movieId === movieId);
    if (shows.length > 0 || engs.length > 0) theaterCount++;
    for (const s of shows) {
      if (s.status === "available" || s.status === "almost_full") buyable++;
      if (s.seatsLeft !== undefined) {
        hasSeatData = true;
        seatsLeft += s.seatsLeft;
      }
    }
    for (const e of engs) {
      if (e.status === "on_sale") engagementOnSale = true;
      else engagementSoldOut = true;
    }
  }
  return {
    buyable,
    seatsLeft,
    hasSeatData,
    theaterCount,
    engagementOnSale,
    engagementSoldOut,
    anything: theaterCount > 0,
  };
}

function movieStatus(summary: MovieSummary | null): {
  text: string;
  tone: "positive" | "muted" | "negative";
} {
  if (!summary) return { text: "Checking…", tone: "muted" };
  if (summary.buyable > 0 || summary.engagementOnSale) {
    return {
      text: `Tickets available · ${
        summary.buyable > 0
          ? `${summary.buyable} show${summary.buyable === 1 ? "" : "s"}`
          : "see theater"
      }`,
      tone: "positive",
    };
  }
  if (summary.anything) {
    return {
      text: summary.engagementSoldOut ? "Sold out" : "Nothing buyable right now",
      tone: "negative",
    };
  }
  return { text: "Not scheduled yet", tone: "muted" };
}

function MovieCard({
  title,
  meta,
  poster,
  summary,
  selected,
  onSelect,
}: {
  title: string;
  meta: string;
  poster: string;
  summary: MovieSummary | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const status = movieStatus(summary);

  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex min-w-[16rem] flex-1 shrink-0 snap-start items-center gap-3 rounded-xl border p-3 text-left transition-all sm:min-w-0 ${
        selected
          ? "border-accent bg-surface shadow-[0_2px_8px_rgba(0,0,0,0.08)] ring-1 ring-accent"
          : "border-line bg-surface hover:border-line-strong"
      }`}
    >
      <img
        src={poster}
        alt={`${title} poster`}
        className="h-20 w-[3.33rem] shrink-0 rounded-md object-cover shadow-sm"
        loading="lazy"
      />
      <div className="min-w-0">
        <p className="truncate text-[15px] font-bold tracking-tight">{title}</p>
        <p className="mt-0.5 truncate text-xs text-muted">{meta}</p>
        <p
          className={`mt-1.5 flex items-center gap-1.5 text-xs font-semibold ${
            status.tone === "positive"
              ? "text-positive"
              : status.tone === "negative"
                ? "text-negative"
                : "text-muted"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              status.tone === "positive"
                ? "bg-positive"
                : status.tone === "negative"
                  ? "bg-negative"
                  : "bg-line-strong"
            }`}
          />
          <span className="truncate">{status.text}</span>
        </p>
      </div>
    </button>
  );
}

export function Dashboard() {
  const [data, setData] = useState<MonitorSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [selectedMovie, setSelectedMovie] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(false);
  const newIdsRef = useRef<Set<string>>(new Set());
  const now = useNow(5_000);

  const notify = useCallback((snapshot: MonitorSnapshot) => {
    if (snapshot.newShowtimeIds.length === 0) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (localStorage.getItem(NOTIFY_PREF_KEY) !== "1") return;
    const count = snapshot.newShowtimeIds.length;
    new Notification("IMAX tickets available", {
      body: `${count} showtime${count > 1 ? "s" : ""} just opened. Grab seats now!`,
    });
  }, []);

  const load = useCallback(
    async (force = false) => {
      try {
        const url = IS_STATIC
          ? `${BASE_PATH}/data/snapshot.json`
          : `/api/status${force ? "?force=1" : ""}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`Server error (${res.status})`);
        const snapshot: MonitorSnapshot = await res.json();
        for (const id of snapshot.newShowtimeIds) newIdsRef.current.add(id);
        notify(snapshot);
        setData(snapshot);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      }
    },
    [notify],
  );

  useEffect(() => {
    load();
    const t = setInterval(() => load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Poll faster while a background scan is running
  useEffect(() => {
    if (!data?.checking) return;
    const t = setTimeout(() => load(), 8_000);
    return () => clearTimeout(t);
  }, [data, load]);

  useEffect(() => {
    setNotifyEnabled(
      typeof Notification !== "undefined" &&
        Notification.permission === "granted" &&
        localStorage.getItem(NOTIFY_PREF_KEY) === "1",
    );
    const savedMovie = localStorage.getItem(MOVIE_PREF_KEY);
    if (savedMovie && MOVIES.some((m) => m.id === savedMovie)) setSelectedMovie(savedMovie);
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggleTheme = useCallback(() => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem(THEME_PREF_KEY, next ? "dark" : "light");
    setIsDark(next);
  }, []);

  const summaries = useMemo(() => {
    if (!data) return new Map<string, MovieSummary>();
    return new Map(MOVIES.map((m) => [m.id, summarizeMovie(data.theaters, m.id)]));
  }, [data]);

  // Default: first movie that has anything scheduled, else the first movie
  const activeMovie =
    selectedMovie ??
    MOVIES.find((m) => summaries.get(m.id)?.anything)?.id ??
    MOVIES[0].id;

  const selectMovie = useCallback((id: string) => {
    setSelectedMovie(id);
    localStorage.setItem(MOVIE_PREF_KEY, id);
  }, []);

  const toggleNotifications = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    if (notifyEnabled) {
      localStorage.setItem(NOTIFY_PREF_KEY, "0");
      setNotifyEnabled(false);
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      localStorage.setItem(NOTIFY_PREF_KEY, "1");
      setNotifyEnabled(true);
      new Notification("Notifications on", {
        body: "You'll be alerted when new IMAX showtimes go on sale.",
      });
    }
  }, [notifyEnabled]);

  const forceRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  const checking = refreshing || data?.checking === true;
  const activeMeta = MOVIES.find((m) => m.id === activeMovie)!;
  const activeSummary = summaries.get(activeMovie) ?? null;
  const activeStatus = movieStatus(data ? activeSummary : null);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-16 sm:px-6">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 py-5">
        <div className="flex items-center gap-3">
          {/* Film-frame logo mark: perforations like real 70mm stock */}
          <div
            aria-hidden
            className="logo-mark relative flex h-10 w-10 select-none items-center justify-center rounded-lg bg-chip-on text-chip-on-text"
          >
            <span className="absolute inset-y-[5px] left-[4px] flex flex-col justify-between">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="h-[5px] w-[3.5px] rounded-[1.5px] bg-background" />
              ))}
            </span>
            <span className="absolute inset-y-[5px] right-[4px] flex flex-col justify-between">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="h-[5px] w-[3.5px] rounded-[1.5px] bg-background" />
              ))}
            </span>
            <span className="font-imax text-[12px] leading-none">70</span>
          </div>
          <div className="fade-up" style={{ animationDelay: "150ms" }}>
            <p className="font-imax text-[15px] leading-none tracking-tight">70MM IMAX</p>
            <p className="mt-[3px] text-[10px] font-bold uppercase tracking-[0.26em] text-muted">
              Ticket Monitor
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1.5 text-xs text-muted sm:inline-flex">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                checking ? "pulse-dot bg-accent" : error ? "bg-negative" : "bg-positive"
              }`}
            />
            {checking
              ? "Checking…"
              : data
                ? `Updated ${timeAgo(data.lastChecked, now)}`
                : "Connecting…"}
          </span>
          {!IS_STATIC && (
            <button
              onClick={forceRefresh}
              disabled={checking}
              className="h-9 rounded-md border border-line-strong bg-surface px-3 text-sm font-semibold transition-colors hover:border-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checking ? "Checking…" : "Check now"}
            </button>
          )}
          {!IS_STATIC && (
            <button
              onClick={toggleNotifications}
              className={`h-9 rounded-md px-3 text-sm font-semibold transition-colors ${
                notifyEnabled
                  ? "bg-chip-on text-chip-on-text"
                  : "border border-line-strong bg-surface hover:border-foreground"
              }`}
              title={
                notifyEnabled
                  ? "Notifications on — click to turn off"
                  : "Get a browser notification when new showtimes appear"
              }
            >
              {notifyEnabled ? "🔔 On" : "Notify me"}
            </button>
          )}
          <a
            href="https://github.com/rahulramath/imax-ticket-monitor"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View source on GitHub"
            title="Built by Rahul. View the source on GitHub."
            className="flex h-9 w-9 items-center justify-center rounded-md border border-line-strong bg-surface transition-colors hover:border-foreground"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
          <button
            onClick={toggleTheme}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-line-strong bg-surface text-base transition-colors hover:border-foreground"
          >
            {isDark ? "☀︎" : "☾"}
          </button>
        </div>
      </header>

      {/* Intro */}
      <div className="fade-up mt-1" style={{ animationDelay: "80ms" }}>
        <p className="text-sm leading-relaxed text-muted">
          Tickets for big IMAX runs vanish in minutes, and keeping up means refreshing
          three theater sites that each show availability differently. So this board does
          the refreshing instead, across the screens I care about most, and rechecks{" "}
          {IS_STATIC ? "every 15 to 30 minutes" : "every few minutes"}. Tap any time to buy.
        </p>
        <ul className="mt-3 space-y-1.5 text-sm leading-relaxed text-muted">
          <li className="flex gap-2.5">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#3558b8]" />
            <span>
              <span className="font-semibold text-foreground">Cinemark Dallas XD and IMAX</span>
              {" "}· IMAX 70mm film, 1.43:1. Exact seats left, read from each
              showtime&apos;s seat map.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#d81f26]" />
            <span>
              <span className="font-semibold text-foreground">AMC Lincoln Square 13</span>
              {" "}· IMAX 70mm film, 1.43:1. AMC hides seat numbers; their on sale and
              almost full labels can run optimistic.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#b07b3e]" />
            <span>
              <span className="font-semibold text-foreground">Bullock Museum IMAX, Austin</span>
              {" "}· IMAX DL2 dual laser, 1.43:1. On sale or sold out for the whole run.
            </span>
          </li>
        </ul>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Built by{" "}
          <a
            href="https://github.com/rahulramath"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-accent hover:underline"
          >
            Rahul
          </a>
          .{" "}
          {REQUEST_EMAIL ? (
            <>
              Want a theater or movie added?{" "}
              <button
                onClick={openRequestEmail}
                className="font-semibold text-accent hover:underline"
              >
                Send a request
              </button>
              .
            </>
          ) : (
            <span>Requests for more theaters and movies are welcome.</span>
          )}
        </p>
      </div>

      {/* Level 1: pick a film */}
      <div className="mt-8">
        <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-accent">
          Tracking
        </p>
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0">
          {MOVIES.map((m) => (
            <MovieCard
              key={m.id}
              title={m.title}
              meta={m.meta}
              poster={`${BASE_PATH}${m.poster}`}
              summary={data ? (summaries.get(m.id) ?? null) : null}
              selected={activeMovie === m.id}
              onSelect={() => selectMovie(m.id)}
            />
          ))}
        </div>
        {/* Divider with a tail under the selected card, tying it to the detail below */}
        <div className="relative mt-6 hidden border-t border-line sm:block">
          <span
            className="absolute -top-[6.5px] h-3 w-3 -translate-x-1/2 rotate-45 border-b border-r border-accent bg-background transition-[left] duration-300 ease-out"
            style={{
              left: `${((MOVIES.findIndex((m) => m.id === activeMovie) * 2 + 1) / (MOVIES.length * 2)) * 100}%`,
            }}
          />
        </div>
      </div>

      {/* Level 2: selected movie */}
      <div className="mb-6 mt-9 flex items-center gap-4 sm:mt-7">
        <img
          src={`${BASE_PATH}${activeMeta.poster}`}
          alt=""
          className="hidden h-28 w-[4.66rem] rounded-lg object-cover shadow-md sm:block"
        />
        <div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{activeMeta.title}</h1>
          <p className="mt-1 text-sm text-muted">{activeMeta.meta}</p>
          <p
            className={`mt-1.5 flex items-center gap-1.5 text-sm font-semibold ${
              activeStatus.tone === "positive"
                ? "text-positive"
                : activeStatus.tone === "negative"
                  ? "text-negative"
                  : "text-muted"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                activeStatus.tone === "positive"
                  ? "bg-positive"
                  : activeStatus.tone === "negative"
                    ? "bg-negative"
                    : "bg-line-strong"
              }`}
            />
            {activeStatus.text}
          </p>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-6 rounded-lg border border-negative/30 bg-negative-soft px-4 py-3 text-sm font-medium text-negative">
          {error} — retrying automatically.
        </div>
      )}

      {/* Theater cards */}
      {data ? (
        <div className="grid gap-5 lg:grid-cols-2">
          {data.theaters.map((t) => (
            <TheaterCard
              key={t.theaterId}
              theater={t}
              movieId={activeMovie}
              newIds={newIdsRef.current}
              todayLocal={localDateInTz(THEATER_TZ[t.chain])}
              tomorrowLocal={localDateInTz(THEATER_TZ[t.chain], 1)}
            />
          ))}
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-72 animate-pulse rounded-xl border border-line bg-surface p-6"
            >
              <div className="h-4 w-16 rounded bg-background" />
              <div className="mt-3 h-6 w-2/3 rounded bg-background" />
              <div className="mt-2 h-4 w-1/3 rounded bg-background" />
              <div className="mt-8 flex flex-wrap gap-2">
                {[...Array(6)].map((_, j) => (
                  <div key={j} className="h-12 w-20 rounded-md bg-background" />
                ))}
              </div>
              {!error && i === 0 && (
                <p className="mt-6 text-sm text-muted">
                  First scan in progress — this can take a couple of minutes (AMC is slow).
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Legend */}
      <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-6 rounded border border-line-strong bg-surface" />
          On sale, click a time to buy
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-6 rounded border border-positive/40 bg-positive-soft" />
          More than 10 seats left
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-6 rounded border border-warning-border bg-warning-soft" />
          10 or fewer, or AMC&apos;s &ldquo;almost full*&rdquo;
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-6 rounded border border-negative/40 bg-negative-soft" />
          Accessible seats only
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted line-through">7:00 PM</span>
          Sold out
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-6 rounded border border-dashed border-line-strong bg-background" />
          Listed, sale not open yet
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded bg-accent px-1 py-px text-[9px] font-bold uppercase text-white">
            New
          </span>
          Just appeared or went on sale
        </span>
      </div>
    </div>
  );
}
