/**
 * Diagnostic: can this machine read Fandango's checkout seat map?
 *
 * Fandango's checkout API blocks obvious automation (and curl outright), but
 * a headless Chrome with a normal user agent gets through. This opens one
 * showtime's ticketing page to obtain the session token, then calls the
 * seat-map API directly for any further showtime ids.
 *
 * Usage: node scripts/probe-fandango-seats.mjs <ticketingJumpPageURL> [showtimeId...]
 * (get both from https://www.fandango.com/napi/theaterMovieShowtimes/<theaterId>?startDate=YYYY-MM-DD)
 */
import { chromium } from "playwright-core";

const jump = process.argv[2];
const otherIds = process.argv.slice(3);
if (!jump) {
  console.error("usage: node scripts/probe-fandango-seats.mjs <jumpUrl> [showtimeId...]");
  process.exit(2);
}
const t0 = Date.now();
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});
const realUa = (
  await (async () => {
    const c = await browser.newContext();
    const p = await c.newPage();
    const ua = await p.evaluate(() => navigator.userAgent);
    await c.close();
    return ua;
  })()
).replace("HeadlessChrome", "Chrome");
const ctx = await browser.newContext({ userAgent: realUa, locale: "en-US" });
const page = await ctx.newPage();

let auth = null;
let sid = null;
const first = new Promise((resolve) => {
  page.on("request", (req) => {
    if (req.url().includes("/seat-map")) {
      auth = req.headers()["authorization"] ?? null;
      sid = req.headers()["x-fd-sessionid"] ?? null;
    }
  });
  page.on("response", async (res) => {
    if (res.url().includes("/seat-map")) {
      let n = -1;
      try {
        n = (await res.json()).data?.seats?.length ?? -1;
      } catch {}
      resolve({ status: res.status(), seats: n });
    }
  });
  setTimeout(() => resolve(null), 60_000);
});
await page.goto(jump, { waitUntil: "domcontentloaded" });
console.log("first seat-map:", await first, `(${Math.round((Date.now() - t0) / 1000)}s)`, "token?", !!auth, "sid?", !!sid);

for (const id of otherIds) {
  const t1 = Date.now();
  const r = await page.evaluate(
    async ({ id, auth, sid }) => {
      const res = await fetch(`/checkoutapi/showtimes/v2/${id}/seat-map`, {
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          Authorization: auth,
          "X-FD-SessionId": sid,
          "X-Requested-With": "XMLHttpRequest",
        },
        redirect: "manual",
      });
      if (!res.ok) return { status: res.status };
      const d = (await res.json()).data;
      const seats = d?.seats ?? [];
      const c = {};
      for (const s of seats) c[`${s.type}:${s.status}`] = (c[`${s.type}:${s.status}`] ?? 0) + 1;
      return { status: res.status, seats: seats.length, breakdown: c };
    },
    { id, auth, sid },
  );
  console.log(`showtime ${id}:`, JSON.stringify(r), `(${Date.now() - t1}ms)`);
}
await browser.close();
