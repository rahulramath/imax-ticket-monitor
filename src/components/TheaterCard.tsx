"use client";

import { useState } from "react";
import type { Engagement, Showtime, TheaterResult } from "@/lib/types";

/** Date groups shown before the "show more" fold */
const VISIBLE_DAYS = 7;

const CHAIN_STYLES: Record<TheaterResult["chain"], { label: string; className: string }> = {
  cinemark: { label: "CINEMARK", className: "bg-[#c8102e] text-white" },
  amc: { label: "AMC", className: "bg-[#d81f26] text-white" },
  bullock: { label: "BULLOCK IMAX", className: "bg-[#00517d] text-white" },
};

function formatDateHeading(localDate: string, todayLocal: string, tomorrowLocal: string): string {
  if (localDate === todayLocal) return "Today";
  if (localDate === tomorrowLocal) return "Tomorrow";
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function seatsLabel(show: Showtime): string | null {
  if (show.seatsLeft === undefined) return null;
  if (show.seatsLeft === 0 && (show.accessibleSeatsLeft ?? 0) > 0) {
    return `${show.accessibleSeatsLeft} accessible`;
  }
  return `${show.seatsLeft} left`;
}

function seatsTone(show: Showtime): "plenty" | "low" | "critical" {
  if (show.seatsLeft === undefined || show.seatsTotal === undefined) return "plenty";
  const ratio = show.seatsLeft / show.seatsTotal;
  if (show.seatsLeft <= 10 || ratio < 0.05) return "critical";
  if (ratio < 0.25) return "low";
  return "plenty";
}

function ShowtimeChip({ show, isNew }: { show: Showtime; isNew: boolean }) {
  const soldOut = show.status === "sold_out";
  const seats = seatsLabel(show);
  const tone = seatsTone(show);

  if (soldOut) {
    return (
      <span
        className="inline-flex h-12 flex-col items-center justify-center rounded-md border border-line bg-background px-3"
        title="Sold out"
      >
        <span className="text-sm font-medium text-muted line-through">{show.displayTime}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          Sold out
        </span>
      </span>
    );
  }

  if (show.status === "unknown") {
    return (
      <span
        className="inline-flex h-12 flex-col items-center justify-center rounded-md border border-dashed border-line-strong bg-background px-3"
        title="Listed, but ticket sales haven't opened yet"
      >
        <span className="text-sm font-medium text-muted">{show.displayTime}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          Sale not open
        </span>
      </span>
    );
  }

  // AMC exposes only a coarse "almost full" flag, not seat counts
  const almostFull = show.status === "almost_full" && seats === null;

  const toneClasses =
    tone === "critical" || almostFull
      ? "border-warning-border bg-warning-soft hover:border-warning"
      : "border-line-strong bg-surface hover:border-accent";
  const subTextColor =
    tone === "critical" || tone === "low" || almostFull ? "text-warning" : "text-positive";

  return (
    <a
      href={show.ticketUrl}
      target="_blank"
      rel="noopener noreferrer"
      title="Buy tickets"
      className={`relative inline-flex h-12 flex-col items-center justify-center rounded-md border px-3 transition-colors ${toneClasses}`}
    >
      <span className="text-sm font-semibold leading-tight">{show.displayTime}</span>
      <span
        className={`text-[10px] font-semibold uppercase tracking-wide leading-tight ${subTextColor}`}
      >
        {seats ?? (almostFull ? "Almost full" : "On sale")}
      </span>
      {isNew && (
        <span className="absolute -right-1.5 -top-1.5 rounded bg-accent px-1 py-px text-[9px] font-bold uppercase tracking-wide text-white">
          New
        </span>
      )}
    </a>
  );
}

function EngagementBlock({ engagement }: { engagement: Engagement }) {
  const soldOut = engagement.status === "sold_out";
  return (
    <div className="rounded-lg border border-line bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{engagement.label}</p>
        {soldOut ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-negative-soft px-3 py-1 text-xs font-semibold text-negative">
            <span className="h-1.5 w-1.5 rounded-full bg-negative" />
            All showtimes sold out
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-positive-soft px-3 py-1 text-xs font-semibold text-positive">
            <span className="h-1.5 w-1.5 rounded-full bg-positive" />
            Tickets available
          </span>
        )}
      </div>
      {engagement.window && (
        <p className="mt-1 text-sm text-muted">Screening {engagement.window}</p>
      )}
      <p className="mt-2 text-xs text-muted">
        The Bullock only reveals its showtime calendar during checkout, so we track
        sold-out status for the whole run.{" "}
        {soldOut ? "We'll alert you if tickets reopen." : ""}
      </p>
      <a
        href={engagement.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-block text-sm font-semibold text-accent hover:underline"
      >
        {soldOut ? "Check for returned tickets ↗" : "Buy tickets ↗"}
      </a>
    </div>
  );
}

export function TheaterCard({
  theater,
  movieId,
  newIds,
  todayLocal,
  tomorrowLocal,
}: {
  theater: TheaterResult;
  movieId: string;
  newIds: Set<string>;
  todayLocal: string;
  tomorrowLocal: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const chain = CHAIN_STYLES[theater.chain];
  const showtimes = theater.showtimes.filter((s) => s.movieId === movieId);
  const engagements = (theater.engagements ?? []).filter((e) => e.movieId === movieId);
  const onSale = showtimes.filter(
    (s) => s.status === "available" || s.status === "almost_full",
  );
  const hasSeatCounts = showtimes.some((s) => s.seatsLeft !== undefined);
  const totalSeatsLeft = showtimes.reduce((n, s) => n + (s.seatsLeft ?? 0), 0);
  const totalAccessibleLeft = showtimes.reduce((n, s) => n + (s.accessibleSeatsLeft ?? 0), 0);

  const byDate = new Map<string, Showtime[]>();
  for (const s of showtimes) {
    const list = byDate.get(s.localDate) ?? [];
    list.push(s);
    byDate.set(s.localDate, list);
  }

  const statusPill = !theater.ok ? (
    <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-negative-soft px-3 py-1 text-xs font-semibold text-negative">
      <span className="h-1.5 w-1.5 rounded-full bg-negative" />
      Check failed
    </span>
  ) : engagements.length > 0 ? (
    engagements.some((e) => e.status === "on_sale") ? (
      <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-positive-soft px-3 py-1 text-xs font-semibold text-positive">
        <span className="h-1.5 w-1.5 rounded-full bg-positive" />
        On sale
      </span>
    ) : (
      <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-negative-soft px-3 py-1 text-xs font-semibold text-negative">
        <span className="h-1.5 w-1.5 rounded-full bg-negative" />
        Sold out
      </span>
    )
  ) : onSale.length > 0 ? (
    <span
      className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-positive-soft px-3 py-1 text-xs font-semibold text-positive"
      title={
        hasSeatCounts
          ? `${totalSeatsLeft} seats remaining across ${onSale.length} upcoming showtimes`
          : `${onSale.length} upcoming showtimes you can still buy tickets for`
      }
    >
      <span className="h-1.5 w-1.5 rounded-full bg-positive" />
      {hasSeatCounts
        ? totalSeatsLeft > 0
          ? `${totalSeatsLeft.toLocaleString()} seat${totalSeatsLeft === 1 ? "" : "s"} left`
          : totalAccessibleLeft > 0
            ? "Accessible seats only"
            : "Sold out"
        : `${onSale.length} shows on sale`}
    </span>
  ) : (
    <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-background px-3 py-1 text-xs font-semibold text-muted">
      <span className="h-1.5 w-1.5 rounded-full bg-line-strong" />
      {showtimes.length > 0 ? "None on sale" : "Not scheduled"}
    </span>
  );

  return (
    <section className="fade-up flex flex-col rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <header className="flex items-start justify-between gap-4 border-b border-line p-5 sm:p-6">
        <div className="min-w-0">
          <span
            className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold tracking-[0.08em] ${chain.className}`}
          >
            {chain.label}
          </span>
          <h2 className="mt-2 truncate text-lg font-semibold tracking-tight">
            {theater.theaterName}
          </h2>
          <p className="text-sm text-muted">
            {theater.location} · {theater.formatLabel}
          </p>
        </div>
        {statusPill}
      </header>

      <div className="flex-1 p-5 sm:p-6">
        {!theater.ok ? (
          <div className="rounded-lg border border-dashed border-line-strong p-6 text-center">
            <p className="text-sm font-medium">Couldn&apos;t reach {theater.theaterName}</p>
            <p className="mt-1 text-sm text-muted">
              {theater.error ?? "The last check failed."} We&apos;ll retry automatically.
            </p>
          </div>
        ) : engagements.length > 0 ? (
          <div className="space-y-3">
            {engagements.map((e) => (
              <EngagementBlock key={e.movieId + e.label} engagement={e} />
            ))}
          </div>
        ) : showtimes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line-strong p-6 text-center">
            <p className="text-sm font-medium">No {theater.formatLabel} showtimes listed</p>
            <p className="mt-1 text-sm text-muted">
              We&apos;re checking every few minutes across all dates this theater sells, and
              will flag showtimes the moment they appear.
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {[...byDate.entries()]
              .slice(0, expanded ? undefined : VISIBLE_DAYS)
              .map(([date, shows]) => {
                const dayTotal = shows.reduce((n, s) => n + (s.seatsLeft ?? 0), 0);
                return (
                  <div key={date}>
                    <div className="mb-2 flex items-baseline gap-2">
                      <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-muted">
                        {formatDateHeading(date, todayLocal, tomorrowLocal)}
                      </h3>
                      {dayTotal > 0 && (
                        <span className="text-xs text-muted">
                          {dayTotal} seat{dayTotal === 1 ? "" : "s"} left
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {shows.map((s) => (
                        <ShowtimeChip key={s.id} show={s} isNew={newIds.has(s.id)} />
                      ))}
                    </div>
                  </div>
                );
              })}
            {byDate.size > VISIBLE_DAYS && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="w-full rounded-md border border-line-strong bg-surface py-2 text-sm font-semibold transition-colors hover:border-foreground"
              >
                {expanded
                  ? "Show fewer days"
                  : `Show ${byDate.size - VISIBLE_DAYS} more day${
                      byDate.size - VISIBLE_DAYS === 1 ? "" : "s"
                    } (through ${formatDateHeading([...byDate.keys()].pop()!, todayLocal, tomorrowLocal)})`}
              </button>
            )}
            {!hasSeatCounts && theater.chain === "amc" && (
              <p className="text-xs text-muted">
                AMC doesn&apos;t publish seat counts — &ldquo;almost full&rdquo; is their own
                low-availability flag. Open a showtime to see the live seat map.
              </p>
            )}
          </div>
        )}
      </div>

      <footer className="border-t border-line px-5 py-4 sm:px-6">
        <a
          href={theater.theaterUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-semibold text-accent hover:underline"
        >
          {theater.chain === "cinemark"
            ? "All showtimes on cinemark.com ↗"
            : theater.chain === "amc"
              ? "All showtimes on amctheatres.com ↗"
              : "Ticket store on thestoryoftexas.com ↗"}
        </a>
      </footer>
    </section>
  );
}
