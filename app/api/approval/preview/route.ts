import { NextResponse } from "next/server";
import { timingSafeEqual } from "@/lib/auth";
import { hashApprovalToken, verifyApprovalToken, PERSONAL_TAKE_MAX_CHARS } from "@/lib/approval";
import { getRun, storageEnabled, type PostFormat } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 30;

export type ApprovalPreviewResponse = {
  runId: string;
  runDate: string;
  topic: string | null;
  planTitle: string | null;
  caption: string | null;
  pdfUrl: string | null;
  pageCount: number | null;
  expiresAt: string | null;
  personalTakeMaxChars: number;
  format: PostFormat;
};

/**
 * Read side of the approval page. PUBLIC in proxy.ts — the emailed capability
 * token is the entire auth, so every check fails closed to the SAME generic
 * 404 (an attacker probing tokens learns nothing about which guard tripped,
 * or whether a run id exists at all).
 */
export async function GET(request: Request): Promise<Response> {
  const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!storageEnabled()) return notFound();

  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!token || token.length > 512) return notFound();

  const verdict = await verifyApprovalToken(token);
  if (!verdict.ok) return notFound();

  const run = await getRun(verdict.runId);
  if (!run || run.status !== "awaiting_approval" || !run.approval_token_hash) return notFound();
  const hash = await hashApprovalToken(token);
  if (!timingSafeEqual(hash, run.approval_token_hash)) return notFound();
  if (run.approval_expires_at && new Date(run.approval_expires_at).getTime() <= Date.now()) return notFound();

  return NextResponse.json({
    runId: run.id,
    runDate: run.run_date,
    topic: run.topic,
    planTitle: run.plan_title,
    caption: run.caption,
    pdfUrl: run.pdf_url,
    pageCount: run.page_count,
    expiresAt: run.approval_expires_at,
    personalTakeMaxChars: PERSONAL_TAKE_MAX_CHARS,
    format: run.post_format,
  } satisfies ApprovalPreviewResponse);
}
