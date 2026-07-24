# IMAX Ticket Monitor

Live availability tracker for premium-format IMAX screenings of **The Odyssey**, **Dune: Part Three**, and **Godzilla Minus Zero** at:

- **Cinemark Dallas XD and IMAX** (Dallas, TX) — IMAX 70mm film
- **AMC Lincoln Square 13** (New York, NY) — IMAX 70mm film
- **Bullock Museum IMAX** (Austin, TX) — IMAX 1.43 dual-laser digital

Pick a film at the top (poster cards show live status per movie); each theater card shows every date the theater is selling, and every showtime chip links straight to the ticket purchase page. Light and dark mode are both supported — the toggle in the header persists your choice, defaulting to your system preference.

## Run it

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## How it works

- A server-side monitor scrapes each venue's public pages across **every date they're selling** (not a fixed window):
  - **Cinemark** embeds showtime JSON in `data-json-model` attributes; IMAX 70mm engagements are listed as separate "movies" (e.g. *The Odyssey IMAX 70MM*). The full engagement window is discovered from the date carousel on the theater page. Each showtime's seat map page is scraped for **exact remaining-seat counts** (regular + accessible) — the next 7 days every scan, farther-out dates on a rotating batch (Cloudflare rate-limits bursts, so seat maps are fetched one at a time with a cooldown circuit breaker).
  - **AMC** ships a React Server Components payload; showtimes are matched by movie slug + the `imax70mm` format group. Dates worth fetching are discovered by probing **Fandango's** fast JSON API day-by-day (up to 45 days out, stopping after 5 consecutive empty days), since AMC's own pages take 20–40s each. Fandango also supplies per-showtime `soldout` status that AMC's site hides. AMC sits behind Queue-it, so the scraper keeps a cookie jar and follows the queue redirect chain manually.
  - **Far-future releases** (Dune: Part Three in December, Godzilla Minus Zero in November) are found by probing each film's opening week — anchored to its release date in `src/lib/movies.ts` — on top of the rolling near-term window. For AMC, these far-out shows come from Fandango directly (with working purchase links) so we never hit AMC's slow pages for dates months away; for Cinemark, the opening-week dates are added to the normal page scan.
  - **Bullock Museum** hides its showtime calendar behind a cart session, but each film's ticket-store category page exposes an overall **"All showtimes are sold out!"** banner and the screening window — so the Bullock is tracked at engagement level (on sale / sold out for the whole run), with an alert if a sold-out run reopens.
- Results are cached server-side (stale-while-revalidate, ~5 min scan interval) and persisted to `.data/snapshot.json`. If a date's fetch fails on one scan (rate limit, timeout), the previous scan's data for that date is carried over so the UI never flickers.
- The dashboard polls every 45 seconds. Movie cards summarize availability across all three theaters; theater cards show per-showtime state: exact seats left (Cinemark), almost full, sold out, or "sale not open" (Cinemark lists showtimes days before the purchase page goes live). The **NEW** badge and browser notifications ("Notify me") fire when a showtime is first listed, when its sale opens, or when the Bullock's run flips from sold out to on sale.
- "Check now" forces a fresh scan; the UI serves the last snapshot instantly while rescanning in the background.

## Deploying

### GitHub Pages (easiest — no server, free)

This repo ships with a GitHub Actions workflow (`.github/workflows/deploy.yml`) that
scrapes all theaters on GitHub's runners, builds a fully static version of the
site, and publishes it to GitHub Pages. Your computer stays off; there is no
server to maintain. Rather than relying on GitHub's cron scheduler (which is
best-effort and in practice skips most slots), each run re-dispatches the next
one after deploying, forming a continuous refresh loop of roughly every 15–30
minutes. An hourly cron acts as a backstop that restarts the chain if a run
fails.

One-time setup after pushing to GitHub:

1. Repo **Settings → Pages** → set *Source* to **GitHub Actions**.
2. (Optional) Repo **Settings → Secrets and variables → Actions → Variables** →
   add `REQUEST_EMAIL` with the address the "request a theater or movie" link
   should open. Leave unset to render the sentence without a link.
3. Run the workflow once from the **Actions** tab (or just push to `main`).

The static build differs from the live server in a few honest ways:

- Availability is as fresh as the last scheduled run (the "Updated X ago" stamp
  is accurate). There's no "Check now" button and no browser notifications,
  since both need a live server.
- "NEW" showtime flagging needs scan-to-scan memory, which fresh CI runners
  don't have, so static deploys don't badge new showtimes.
- GitHub's datacenter IPs get less friendly treatment from Cloudflare than a
  home connection; if a scrape run fails entirely, the deploy is skipped and
  the previous data stays live.

### Live server (full features)

Run `npm run build && npm start` on any long-lived Node host (Railway, Fly.io,
Render, a VPS, a spare machine). This enables background rescans every ~5
minutes, "Check now" (rate-limited to once a minute server-side), browser
notifications, and NEW-showtime detection. Serverless platforms (Vercel,
Netlify) won't work: scans outlive function timeouts, state lives in
memory/on disk, and the Cinemark scraper shells out to `curl`.

## Notes

- Scraping is best-effort against unofficial page structures; if a site changes its markup, the parsers in `src/lib/scrapers.ts` are the place to fix.
- Tracked movies are defined in `src/lib/movies.ts` — matching is by title/slug pattern, so new engagements (e.g. when Dune: Part Three goes on sale) are picked up automatically.
- Keep the tab open to receive notifications (this is a client-polling app, no push service).
