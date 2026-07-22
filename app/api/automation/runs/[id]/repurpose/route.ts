import { NextResponse } from "next/server";
import { buildRepurposeBundle } from "@/lib/repurpose";
import { getRun, storageEnabled, updateRun } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 300;

function badOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

/**
 * Generate (or return the cached) repurpose bundle for a POSTED run.
 * Posted-only on purpose: derivatives syndicate content, so the source must
 * already be public. Pass {"force":true} to regenerate.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (badOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  if (!storageEnabled()) return NextResponse.json({ error: "Storage not configured" }, { status: 400 });
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (run.status !== "posted") {
    return NextResponse.json({ error: `Only posted runs can be repurposed (this is '${run.status}')` }, { status: 400 });
  }
  let force = false;
  try {
    const body = (await request.json()) as { force?: boolean };
    force = body?.force === true;
  } catch {
    /* empty body */
  }
  if (run.repurpose_json && !force) {
    return NextResponse.json({ repurpose: run.repurpose_json, cached: true });
  }
  try {
    const bundle = await buildRepurposeBundle(run);
    await updateRun(run.id, { repurpose_json: bundle });
    return NextResponse.json({ repurpose: bundle, cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "repurpose failed";
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 });
  }
}
