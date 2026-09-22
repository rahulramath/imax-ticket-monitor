/**
 * Publish the locally scraped snapshot to the repo's `data` branch.
 *
 * Why: Cinemark and AMC sit behind Cloudflare bot protection, which blocks
 * GitHub's datacenter runners but lets a home connection through. A launchd
 * job on a Mac runs `npm run scrape && npm run publish-snapshot` on a
 * schedule; the CI deploy then merges in this feed wherever it's fresher
 * than what the runner could fetch itself (see scripts/scrape.ts).
 *
 * Auth: GH_TOKEN, or the `gh` CLI's token for the account in GH_USER
 * (default rahulramath). Using the explicit account sidesteps `gh auth
 * switch` flipping the active account to a work login.
 *
 * Usage: npm run publish-snapshot
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MonitorSnapshot } from "../src/lib/types";

const REPO = process.env.GITHUB_REPO ?? "rahulramath/imax-ticket-monitor";
const BRANCH = "data";
const FILE_PATH = "snapshot.json";
const SNAPSHOT = join(process.cwd(), "public", "data", "snapshot.json");
const API = "https://api.github.com";

function token(): string {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const user = process.env.GH_USER ?? "rahulramath";
  return execFileSync("gh", ["auth", "token", "-u", user], { encoding: "utf8" }).trim();
}

async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
}

async function ensureBranch(): Promise<void> {
  const ref = await gh(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
  if (ref.ok) return;
  if (ref.status !== 404) throw new Error(`Branch lookup failed: HTTP ${ref.status}`);
  const main = await gh(`/repos/${REPO}/git/ref/heads/main`);
  if (!main.ok) throw new Error(`main lookup failed: HTTP ${main.status}`);
  const { object } = (await main.json()) as { object: { sha: string } };
  const created = await gh(`/repos/${REPO}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: object.sha }),
  });
  if (!created.ok) throw new Error(`Creating ${BRANCH} failed: HTTP ${created.status}`);
  console.log(`Created branch ${BRANCH}`);
}

async function main() {
  const raw = readFileSync(SNAPSHOT, "utf8");
  const snapshot = JSON.parse(raw) as MonitorSnapshot;
  const fresh = snapshot.theaters.filter((t) => t.ok && t.dataAsOf);
  if (fresh.length === 0) {
    console.error("No theater scanned successfully; not publishing.");
    process.exit(1);
  }

  await ensureBranch();

  const existing = await gh(`/repos/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`);
  const sha = existing.ok ? ((await existing.json()) as { sha: string }).sha : undefined;

  const stamp = new Date(snapshot.lastChecked).toISOString();
  const res = await gh(`/repos/${REPO}/contents/${FILE_PATH}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `Local snapshot ${stamp} (${fresh.map((t) => t.theaterName).join(", ")})`,
      content: Buffer.from(raw).toString("base64"),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status} ${await res.text()}`);
  console.log(
    `Published snapshot to ${REPO}@${BRANCH}/${FILE_PATH}: ` +
      fresh.map((t) => `${t.theaterName} (${t.showtimes.length} shows)`).join(", "),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
