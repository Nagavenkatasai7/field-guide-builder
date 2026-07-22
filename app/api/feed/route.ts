import { NextResponse } from "next/server";
import { withUtm } from "@/lib/repurpose";
import { listPostedRuns, storageEnabled } from "@/lib/storage";
import { AUTHOR } from "@/lib/identity";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * PUBLIC JSON feed of posted guides (allow-listed in proxy.ts) so the owner's
 * portfolio site / newsletter job can ingest each day's guide automatically.
 * Exposes ONLY already-public facts: everything here is live on LinkedIn.
 * PDF links carry UTM tags so feed-driven traffic shows up in the portfolio's
 * analytics — the "owned metrics" half of M14.
 */
export async function GET() {
  if (!storageEnabled()) return NextResponse.json({ items: [] });
  const runs = await listPostedRuns(50);
  const items = runs.map((r) => ({
    id: r.id,
    date: r.posted_at ?? r.created_at,
    title: r.plan_title ?? r.topic ?? "Field guide",
    topic: r.topic,
    excerpt: r.caption ? r.caption.slice(0, 500) : null,
    caption: r.caption,
    pdfUrl: r.pdf_url ? withUtm(r.pdf_url, "feed") : null,
    linkedinPostUrl: r.linkedin_post_url,
    pageCount: r.page_count,
    repurpose: r.repurpose_json,
  }));
  return NextResponse.json(
    { author: AUTHOR.name, brand: AUTHOR.brand, items },
    { headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600" } },
  );
}
