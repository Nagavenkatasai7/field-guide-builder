import { NextResponse } from "next/server";
import { z } from "zod";
import { timingSafeEqual } from "@/lib/auth";
import { composeFinalCaption, hashApprovalToken, verifyApprovalToken, PERSONAL_TAKE_MAX_CHARS } from "@/lib/approval";
import { guardCaption } from "@/lib/caption-guard";
import { publishRunToLinkedIn } from "@/lib/daily-post";
import { claimApprovalDecision, getRun, storageEnabled, type ScheduledRunRow } from "@/lib/storage";

export const runtime = "nodejs";
// Publishing polls the LinkedIn document upload (~40s worst case) on top of
// the PDF fetch — same ceiling as the other posting routes.
export const maxDuration = 300;

const Body = z.object({
  token: z.string().min(20).max(512),
  action: z.enum(["approve", "skip"]),
  personalTake: z.string().max(PERSONAL_TAKE_MAX_CHARS).optional(),
  // Optional caption edit from the page. Bounds mirror the guard's own limits
  // (2700 clean max) with slack for whitespace the guard normalizes away.
  caption: z.string().min(100).max(3000).optional(),
});

/** Same-origin guard (cheap CSRF hardening for a state-changing POST). */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser / same-origin fetch without Origin
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/** The blob store is the only place we ever fetch a posting artifact from. */
function isBlobUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

const ARTIFACT_MAX_BYTES = 105 * 1024 * 1024; // LinkedIn's cap is 100MB; headroom for the check downstream

async function fetchArtifact(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > ARTIFACT_MAX_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Decision side of the approval page. PUBLIC in proxy.ts — the single-use
 * capability token is the entire auth (verified fail-closed: signature,
 * expiry, stored-hash match, and the atomic status flip in the claim).
 * Approve = compose final caption (owner's take + generated caption) → guard
 * → atomic claim → publish through the same tail as the cron path. The LLM
 * self-check is deliberately NOT re-run: the human reading the caption IS the
 * review. Skip = terminal 'skipped', nothing posted.
 */
export async function POST(request: Request): Promise<Response> {
  const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!storageEnabled()) return notFound();
  if (!sameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { token, action, personalTake } = parsed.data;

  const verdict = await verifyApprovalToken(token);
  if (!verdict.ok) return notFound();
  const run: ScheduledRunRow | null = await getRun(verdict.runId);
  if (!run || run.status !== "awaiting_approval" || !run.approval_token_hash) return notFound();
  const hash = await hashApprovalToken(token);
  if (!timingSafeEqual(hash, run.approval_token_hash)) return notFound();

  if (action === "skip") {
    const claimed = await claimApprovalDecision({ id: run.id, tokenHash: hash, decision: "skipped" });
    if (!claimed) return NextResponse.json({ error: "This run was already decided or the window expired." }, { status: 409 });
    return NextResponse.json({ status: "skipped", runId: run.id });
  }

  // --- approve ---
  const baseCaption = parsed.data.caption ?? run.caption ?? "";
  const guard = guardCaption(composeFinalCaption(personalTake, baseCaption));
  if (!guard.ok) {
    // No state change — the owner fixes the text on the page and retries.
    return NextResponse.json({ error: "Caption check failed", reasons: guard.reasons }, { status: 400 });
  }

  // Fetch the posting artifact for this run's format (M15) BEFORE claiming,
  // so a transient blob problem doesn't burn the single-use token. Text posts
  // need no media at all.
  let pdf: Buffer | undefined;
  let image: Buffer | undefined;
  if (run.post_format === "document") {
    if (!run.pdf_url || !isBlobUrl(run.pdf_url)) return NextResponse.json({ error: "This run has no PDF artifact to post." }, { status: 409 });
    const buf = await fetchArtifact(run.pdf_url);
    if (!buf) return NextResponse.json({ error: "Could not fetch the PDF artifact — try again in a minute." }, { status: 502 });
    pdf = buf;
  } else if (run.post_format === "image") {
    if (!run.image_url || !isBlobUrl(run.image_url)) return NextResponse.json({ error: "This run has no image artifact to post." }, { status: 409 });
    const buf = await fetchArtifact(run.image_url);
    if (!buf) return NextResponse.json({ error: "Could not fetch the image artifact — try again in a minute." }, { status: 502 });
    image = buf;
  }

  const claimed = await claimApprovalDecision({
    id: run.id,
    tokenHash: hash,
    decision: "approved",
    finalCaption: guard.clean,
    personalTake: personalTake?.trim() || null,
  });
  if (!claimed) return NextResponse.json({ error: "This run was already decided or the window expired." }, { status: 409 });

  const summary = await publishRunToLinkedIn({
    runId: run.id,
    topic: run.topic ?? run.plan_title ?? "today's field guide",
    caption: guard.clean,
    planTitle: run.plan_title ?? "Field Guide",
    format: run.post_format,
    pdf,
    image,
    pdfUrl: run.pdf_url,
  });
  return NextResponse.json(summary);
}
