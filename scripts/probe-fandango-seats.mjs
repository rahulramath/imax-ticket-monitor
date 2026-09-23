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
// PROBE_HEADED=1 runs a visible Chrome (under xvfb on CI), which hides the
// remaining headless tells from bot-defense telemetry.
const headless = process.env.PROBE_HEADED !== "1";
const browser = await chromium.launch({
  channel: "chrome",
  headless,
  args: ["--disable-blink-features=AutomationControlled", "--window-size=1366,900"],
});
console.log("mode:", headless ? "headless" : "headed");
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
let browserHeaders = null;
const first = new Promise((resolve) => {
  page.on("request", (req) => {
    if (req.url().includes("/seat-map")) {
      auth = req.headers()["authorization"] ?? null;
      sid = req.headers()["x-fd-sessionid"] ?? null;
      browserHeaders = req.headers();
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
if (browserHeaders) {
  const shown = Object.fromEntries(
    Object.entries(browserHeaders).map(([k, v]) => [k, k === "cookie" || k === "authorization" ? `<${v.length} chars>` : v]),
  );
  console.log("browser request headers:", JSON.stringify(shown));
}

// Further showtimes: call the API from inside the page via XMLHttpRequest.
// Fandango's bot-defense script hooks XHR (not fetch) to attach fresh signed
// telemetry headers to every request; without them a datacenter IP is bounced.
for (const id of otherIds) {
  const t1 = Date.now();
  const r = await page.evaluate(
    ({ id, auth, sid }) =>
      new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", `/checkoutapi/showtimes/v2/${id}/seat-map`, true);
        xhr.setRequestHeader("Accept", "application/json, text/javascript, */*; q=0.01");
        xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
        if (auth) xhr.setRequestHeader("Authorization", auth);
        if (sid) xhr.setRequestHeader("X-FD-SessionId", sid);
        xhr.onerror = () => resolve({ status: xhr.status, error: "network" });
        xhr.onload = () => {
          if (xhr.status !== 200) return resolve({ status: xhr.status, finalUrl: xhr.responseURL });
          try {
            const seats = JSON.parse(xhr.responseText).data?.seats ?? [];
            const c = {};
            for (const s of seats) c[`${s.type}:${s.status}`] = (c[`${s.type}:${s.status}`] ?? 0) + 1;
            resolve({ status: 200, seats: seats.length, breakdown: c });
          } catch (e) {
            resolve({ status: xhr.status, error: String(e) });
          }
        };
        xhr.send();
      }),
    { id, auth, sid },
  );
  console.log(`showtime ${id}:`, JSON.stringify(r), `(${Date.now() - t1}ms)`);
}
await browser.close();
