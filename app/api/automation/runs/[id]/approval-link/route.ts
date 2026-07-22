import { NextResponse } from "next/server";
import { appBaseUrl, mintApprovalToken } from "@/lib/approval";
import { getRun, storageEnabled, updateRun } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 30;

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
 * Re-issue the approval link for a run that is still awaiting approval (lost
 * email, or opening the page straight from the dashboard). Password-gated by
 * proxy.ts like every other /api/automation route. Minting rotates the stored
 * hash, so every previously emailed link for this run stops working — there
 * is only ever ONE live approve link per run.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (badOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  if (!storageEnabled()) return NextResponse.json({ error: "Storage not configured" }, { status: 400 });
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (run.status !== "awaiting_approval") {
    return NextResponse.json({ error: `Only awaiting-approval runs have an approve link (this is '${run.status}')` }, { status: 400 });
  }
  const minted = await mintApprovalToken(run.id);
  await updateRun(run.id, { approval_token_hash: minted.tokenHash, approval_expires_at: minted.expiresAt });
  return NextResponse.json({ url: `${appBaseUrl()}/approve?token=${encodeURIComponent(minted.token)}`, expiresAt: minted.expiresAt });
}
