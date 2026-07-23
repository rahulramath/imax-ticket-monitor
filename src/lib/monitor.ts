import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyCarryOver } from "./carryover";
import { scanAllTheaters } from "./scrapers";
import type { MonitorSnapshot } from "./types";

/** Minimum time between scans; requests within this window reuse cached data.
 *  Kept moderate: each scan hits many Cinemark seat map pages and Cloudflare
 *  rate-limits aggressive access. */
const MIN_SCAN_INTERVAL_MS = 300_000;

/** Floor for user-triggered "Check now" scans. Protects the scrapers (and
 *  the theaters' rate limits) if the app is hosted publicly and several
 *  people mash the button — a force scan runs at most once a minute,
 *  everyone else gets the still-fresh snapshot. */
const FORCE_SCAN_FLOOR_MS = 60_000;

const PERSIST_PATH = join(process.cwd(), ".data", "snapshot.json");

interface MonitorState {
  snapshot: MonitorSnapshot | null;
  /** showtime ids and engagement keys we've already alerted on */
  seenIds: Set<string>;
  inflight: Promise<MonitorSnapshot> | null;
}

// Survive Next.js dev-server module reloads
const globalStore = globalThis as unknown as { __odysseyMonitor?: MonitorState };
const state: MonitorState =
  globalStore.__odysseyMonitor ??
  (globalStore.__odysseyMonitor = { snapshot: null, seenIds: new Set(), inflight: null });

function loadPersisted(): void {
  if (state.snapshot) return;
  try {
    const raw = JSON.parse(readFileSync(PERSIST_PATH, "utf8")) as {
      snapshot: MonitorSnapshot;
      seenIds: string[];
    };
    state.snapshot = { ...raw.snapshot, newShowtimeIds: [], checking: false };
    state.seenIds = new Set(raw.seenIds);
  } catch {
    // no persisted data yet
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(PERSIST_PATH), { recursive: true });
    writeFileSync(
      PERSIST_PATH,
      JSON.stringify({ snapshot: state.snapshot, seenIds: [...state.seenIds] }),
    );
  } catch {
    // persistence is best-effort
  }
}

async function runScan(): Promise<MonitorSnapshot> {
  const theaters = await scanAllTheaters();

  // Carry over previous data where this scan had gaps (failed dates,
  // missing seat counts).
  if (state.snapshot) {
    applyCarryOver(state.snapshot.theaters, theaters);
  }

  // Alert keys: new showtimes, sale-opened showtimes, and Bullock
  // engagements flipping from sold out to on sale.
  const currentIds = new Set<string>();
  for (const t of theaters) {
    if (!t.ok) continue;
    for (const s of t.showtimes) currentIds.add(s.id);
    for (const e of t.engagements ?? []) {
      if (e.status === "on_sale") currentIds.add(`eng-${t.theaterId}-${e.movieId}`);
    }
  }

  const isFirstScan = state.seenIds.size === 0;
  const newShowtimeIds = isFirstScan
    ? []
    : [...currentIds].filter((id) => !state.seenIds.has(id));
  for (const id of currentIds) state.seenIds.add(id);

  // Also flag shows whose ticket sale just opened (listed before, but the
  // purchase page only now went live).
  if (state.snapshot) {
    const prevStatus = new Map(
      state.snapshot.theaters.flatMap((t) =>
        t.showtimes.map((s) => [s.id, s.status] as const),
      ),
    );
    for (const t of theaters) {
      for (const s of t.showtimes) {
        const was = prevStatus.get(s.id);
        const nowBuyable = s.status === "available" || s.status === "almost_full";
        if (was === "unknown" && nowBuyable && !newShowtimeIds.includes(s.id)) {
          newShowtimeIds.push(s.id);
        }
      }
    }
  }

  const snapshot: MonitorSnapshot = {
    theaters,
    lastChecked: Date.now(),
    newShowtimeIds,
    checking: false,
  };
  state.snapshot = snapshot;
  persist();
  return snapshot;
}

function startScan(): Promise<MonitorSnapshot> {
  if (!state.inflight) {
    state.inflight = runScan().finally(() => {
      state.inflight = null;
    });
  }
  return state.inflight;
}

/**
 * Stale-while-revalidate: always return the latest snapshot immediately.
 * If data is stale (or force-refreshed), kick off a background scan and
 * report `checking: true` so the client knows a fresh scan is running.
 * Only blocks when there is no data at all (very first scan).
 */
export async function getSnapshot(force = false): Promise<MonitorSnapshot> {
  loadPersisted();

  if (!state.snapshot) {
    return startScan();
  }

  const age = Date.now() - state.snapshot.lastChecked;
  const stale = age > MIN_SCAN_INTERVAL_MS;
  if (stale || (force && age > FORCE_SCAN_FLOOR_MS)) startScan();

  return { ...state.snapshot, checking: state.inflight !== null };
}
