import { NextRequest, NextResponse } from "next/server";
import { getSnapshot } from "@/lib/monitor";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";
  try {
    const snapshot = await getSnapshot(force);
    return NextResponse.json(snapshot);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scan failed" },
      { status: 502 },
    );
  }
}
