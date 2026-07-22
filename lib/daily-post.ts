/**
 * The single shared orchestrator for the daily auto-post. Called by BOTH the
 * Vercel-cron route (/api/cron/daily-post) and the manual run-now route
 * (/api/automation/run-now), so generate-and-post logic exists in exactly one
 * place.
 *
 * Safety order (every step from the adversarial review is enforced here):
 *   0. env kill switch (fail-closed, before any DB read)
 *   1. storage gate + automation enabled (cron only)
 *   2. reap stale runs (a stale 'posting' becomes needs_review, never reposted)
 *   3. claim the day (cron is idempotent; manual/dry-runs never take the slot)
 *   4. pick a fresh, reputable, non-duplicate topic
 *   5. generate the field guide
 *   6. upload artifacts (so even blocked runs are reviewable)
 *   7. ARTIFACT GATE — block a broken guide (draft errors / missing diagrams / tiny PDF)
 *   8. caption: deterministic guard, then LLM self-check (block on doubt)
 *   9. dry-run stops here (status 'dry_run')
 *   9.5 approval mode stops here too (status 'awaiting_approval') — the owner
 *       approves/skips via a single-use emailed link; the decide route then
 *       runs steps 10-12 through publishRunToLinkedIn
 *  10. ensure a valid LinkedIn token (refresh or needs-reconnect)
 *  11. persist 'posting' BEFORE the post; createDocumentPost is NEVER retried;
 *      any failure there → 'needs_review' (may have posted — never auto-repost)
 *  12. persist 'posted' + URN immediately; email on every terminal state
 * The function never throws to the cron handler.
 */

import {
  LinkedInAuthError,
  createDocumentPost,
  getApiVersion,
  refreshAccessToken,
  uploadDocument,
} from "@/lib/linkedin-api";
import { chat } from "@/lib/llm";
import { generateFieldGuide, type FieldGuideResult } from "@/lib/pipeline";
import { pickTrendingTopic } from "@/lib/topic-picker";
import { guardCaption, escapeLittleText, sanitizePostTitle } from "@/lib/caption-guard";
import { buildFallbackCaption } from "@/lib/caption-fallback";
import { isDraftable } from "@/lib/prompts/draft";
import { SELFCHECK_SYSTEM_PROMPT, buildSelfCheckPrompt } from "@/lib/prompts/selfcheck";
import { sendAlert } from "@/lib/notify";
import { appBaseUrl, mintApprovalToken } from "@/lib/approval";
import type { PlanT } from "@/lib/plan-schema";
import {
  claimRun,
  getAutomationSettings,
  getLinkedinAccount,
  reapStaleRuns,
  recentTopics,
  reclaimRetryableCronRun,
  recordGeneration,
  slugify,
  storageEnabled,
  updateLinkedinTokens,
  updateRun,
  uploadBlob,
  type LinkedinAccountRow,
} from "@/lib/storage";

export type Trigger = "cron" | "manual";
export type RunSummary = {
  status: string;
  runId?: string;
  reason?: string;
  postUrl?: string;
  pdfUrl?: string | null;
  error?: string;
};

const PDF_MIN_BYTES = 20_000;

export function killSwitchOn(): boolean {
  const v = (process.env.AUTOMATION_DISABLED || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** YYYY-MM-DD in America/New_York (en-CA formats as ISO date). */
export function nyDateString(tz = "America/New_York"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Current hour (0-23) in the given timezone, for the cron NY-hour gate. */
export function hourInTimezone(tz = "America/New_York"): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date());
  const n = parseInt(h, 10);
  return n === 24 ? 0 : n; // some ICU builds render midnight as "24"
}

function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").trim().slice(0, 400);
}

function artifactGate(fg: FieldGuideResult): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  // Check against the EXPECTED draftable sections, not just the produced map —
  // so a fully-failed draft stage (empty map) can't slip through.
  const draftable = fg.plan.sections.filter((s) => isDraftable(s.kind));
  const badDrafts = draftable.filter((s) => {
    const d = fg.drafts[s.id];
    return !d || d.error || !d.html;
  }).length;
  if (badDrafts > 0) reasons.push(`${badDrafts}/${draftable.length} section(s) failed to draft`);
  const missing = fg.plan.infographics.filter((i) => !fg.svgs[i.id]).length;
  if (missing > 0) reasons.push(`${missing} diagram(s) missing — would show a placeholder`);
  if (fg.pdf.length < PDF_MIN_BYTES) reasons.push(`PDF suspiciously small (${fg.pdf.length} bytes)`);
  return { ok: reasons.length === 0, reasons };
}

function extractJson(text: string): string {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first >= 0 && last > first ? text.slice(first, last + 1) : text;
}

async function selfCheckCaption(caption: string, plan: PlanT): Promise<{ ok: boolean; reason: string }> {
  // Two attempts before blocking: a transient checker failure shouldn't kill
  // the day's post. A REAL "not ok" verdict still blocks immediately.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await chat({
        stage: "selfcheck",
        system: SELFCHECK_SYSTEM_PROMPT,
        user: buildSelfCheckPrompt(caption, plan),
        json: "json",
        think: false,
        temperature: 0.2,
        maxTokens: 300,
        timeoutMs: 30_000,
      });
      const j = JSON.parse(extractJson(r.text)) as { ok?: boolean; reason?: string };
      return { ok: Boolean(j.ok), reason: typeof j.reason === "string" ? j.reason : "" };
    } catch {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  // If the checker itself fails twice, block out of caution (no human review exists).
  return { ok: false, reason: "self-check could not run — blocking out of caution" };
}

/** Refresh-if-needed; throw a clear reconnect error when impossible. Exported for the delete-post safety net. */
export async function ensureValidToken(account: LinkedinAccountRow): Promise<{ token: string; daysLeft: number | null }> {
  const exp = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  const now = Date.now();
  const daysLeft = exp ? Math.floor((exp - now) / 86_400_000) : null;
  const within7d = exp > 0 && exp - now < 7 * 86_400_000;
  const expired = exp > 0 && exp <= now;

  if (!within7d) return { token: account.access_token, daysLeft };

  if (account.refresh_token) {
    try {
      const t = await refreshAccessToken(account.refresh_token);
      const newExp = new Date(now + t.expiresInSec * 1000).toISOString();
      await updateLinkedinTokens({ access_token: t.accessToken, refresh_token: t.refreshToken, token_expires_at: newExp });
      return { token: t.accessToken, daysLeft: Math.floor(t.expiresInSec / 86_400) };
    } catch {
      if (expired) throw new LinkedInAuthError("LinkedIn token expired and refresh failed — reconnect required", 401);
      return { token: account.access_token, daysLeft }; // refresh failed but still valid briefly
    }
  }
  if (expired) throw new LinkedInAuthError("LinkedIn token expired and no refresh token — reconnect required", 401);
  return { token: account.access_token, daysLeft };
}

/**
 * The publish tail shared by runDailyPost and the approval decide route:
 * account → token (refresh-if-needed) → document upload → 'posting' → post.
 * Never throws; every outcome lands in the run row + an email, with the same
 * semantics the inline code had: pre-post failures are 'failed' (retryable),
 * the post call is NEVER retried, and a post-call failure is 'needs_review'
 * (it may have published — we can't read back, r_member_social is gated).
 * `caption` must already be guard-cleaned; escaping happens here.
 */
export async function publishRunToLinkedIn(input: {
  runId: string;
  topic: string;
  caption: string;
  planTitle: string;
  pdf: Buffer;
  pdfUrl?: string | null;
}): Promise<RunSummary> {
  const { runId, topic, caption, planTitle, pdf, pdfUrl } = input;
  let stage = "linkedin-auth";
  try {
    const account = await getLinkedinAccount();
    if (!account) {
      const reason = "LinkedIn is not connected";
      await updateRun(runId, { status: "failed", error: reason });
      await sendAlert({ kind: "needs_reconnect", reason });
      return { status: "failed", runId, error: reason };
    }
    const { token, daysLeft } = await ensureValidToken(account);
    // Throttle: alert only at the 14/7/3-day marks (and anything <=3), not every day for a week.
    if (daysLeft != null && (daysLeft <= 3 || daysLeft === 7 || daysLeft === 14)) {
      await sendAlert({ kind: "token_expiring", daysLeft });
    }

    // Upload the document, then PERSIST 'posting' before the post call.
    stage = "doc-upload";
    const docUrn = await uploadDocument(token, account.member_urn, pdf);

    await updateRun(runId, { status: "posting" });
    // The post is the ONE non-idempotent step: no retry, and any failure here
    // becomes 'needs_review' (the post MAY have gone through; we can't read it
    // back because r_member_social is gated) — never auto-reposted.
    try {
      const commentary = escapeLittleText(caption);
      // The media title renders on the live post and is raw model output — sanitize it too.
      const post = await createDocumentPost(token, account.member_urn, commentary, docUrn, sanitizePostTitle(planTitle));
      await updateRun(runId, {
        status: "posted",
        linkedin_post_urn: post.postUrn,
        linkedin_post_url: post.postUrl,
        posted_at: new Date().toISOString(),
      });
      await sendAlert({ kind: "posted", topic, postUrl: post.postUrl });
      console.log(`[daily-post] posted ${runId} → ${post.postUrl}`);
      return { status: "posted", runId, postUrl: post.postUrl, pdfUrl };
    } catch (postErr) {
      const detail = sanitizeError(postErr);
      await updateRun(runId, { status: "needs_review", error: `post call failed (may have posted): ${detail}` });
      await sendAlert({ kind: "needs_review", detail: `Topic: ${topic}. Error: ${detail}` });
      return { status: "needs_review", runId, error: detail, pdfUrl };
    }
  } catch (err) {
    // Pre-post failure (auth/doc-upload) — safely retryable.
    const error = sanitizeError(err);
    console.error(`[daily-post] failed at ${stage}: ${error}`);
    if (err instanceof LinkedInAuthError) {
      await sendAlert({ kind: "needs_reconnect", reason: error });
    } else {
      await sendAlert({ kind: "failed", topic: topic || undefined, stage, error });
    }
    try {
      await updateRun(runId, { status: "failed", error: `${stage}: ${error}` });
    } catch (dbErr) {
      console.error(`[daily-post] could not persist failure (alert already sent): ${sanitizeError(dbErr)}`);
    }
    return { status: "failed", runId, error };
  }
}

export async function runDailyPost(
  trigger: Trigger,
  opts?: {
    dryRun?: boolean;
    topicOverride?: { topic: string; angle: string; urls?: string[] };
    /**
     * The off-hour cron fire passes true: it may ONLY re-claim today's cron
     * run if it ended failed/blocked (same-day retry window) — it never starts
     * a first attempt, so the "posts at noon" promise holds.
     */
    retryOnly?: boolean;
  },
): Promise<RunSummary> {
  const invokedAt = Date.now();
  // 0. Env kill switch — fail-closed, before any DB read.
  if (killSwitchOn()) {
    console.log("[daily-post] AUTOMATION_DISABLED env set — skipping");
    return { status: "skipped", reason: "kill-switch" };
  }
  if (!storageEnabled()) {
    // A prod misconfiguration (rotated/removed POSTGRES_URL or blob token)
    // would otherwise halt automation FOREVER with no signal. Resend doesn't
    // need the DB, so alert on the cron path (recordAlert no-ops safely).
    if (trigger === "cron") {
      await sendAlert({ kind: "failed", stage: "config", error: "storage env vars missing (POSTGRES_URL / BLOB_READ_WRITE_TOKEN) — automation cannot run" });
    }
    return { status: "skipped", reason: "storage-not-configured" };
  }

  // 1. Settings / pause gate. A DB outage here previously returned before any
  // alert — wrap it so the failure emails (Resend is DB-independent).
  let settings: Awaited<ReturnType<typeof getAutomationSettings>>;
  try {
    settings = await getAutomationSettings();
  } catch (e) {
    const error = sanitizeError(e);
    console.error(`[daily-post] settings read failed: ${error}`);
    await sendAlert({ kind: "failed", stage: "settings", error: `database unreachable: ${error}` });
    return { status: "failed", error };
  }
  if (trigger === "cron" && !settings.enabled) {
    console.log("[daily-post] automation paused — skipping cron run");
    return { status: "skipped", reason: "paused" };
  }
  const dryRun = opts?.dryRun ?? settings.dry_run;

  // 2. Reap anything a prior killed invocation left non-terminal. A silently
  // killed pre-post run now ALSO produces an email (previously it never did).
  try {
    const reaped = await reapStaleRuns();
    for (const id of reaped.needsReview) {
      await sendAlert({ kind: "needs_review", detail: `Run ${id} was interrupted while posting.` });
    }
    for (const id of reaped.failed) {
      await sendAlert({ kind: "failed", stage: "reaped", error: `Run ${id} died mid-generation (function killed). It is now marked failed and eligible for the same-day retry window.` });
    }
  } catch (e) {
    console.error(`[daily-post] reap failed (non-fatal): ${sanitizeError(e)}`);
  }

  // 3. Claim the day (or re-claim it for a same-day retry).
  const today = nyDateString(settings.timezone);
  let runId: string;
  if (trigger === "cron" && opts?.retryOnly) {
    const reclaimed = await reclaimRetryableCronRun(today);
    if (!reclaimed) {
      return { status: "skipped", reason: "no-retryable-run" };
    }
    runId = reclaimed.id;
    console.log(`[daily-post] retrying today's failed/blocked run ${runId} (attempt ${reclaimed.attempt})`);
  } else {
    const claim = await claimRun(today, trigger, dryRun);
    if (!claim.claimed) {
      console.log(`[daily-post] ${today} already claimed by cron — skipping`);
      return { status: "skipped", reason: "already-claimed" };
    }
    runId = claim.id;
  }

  let topic = "";
  let stage = "topic";
  try {
    // 4. Topic (a retry can re-run the same topic via topicOverride).
    await updateRun(runId, { status: "generating" });
    const picked = opts?.topicOverride ?? (await pickTrendingTopic({ recentTopics: await recentTopics(30) }));
    topic = picked.topic;
    await updateRun(runId, { topic: picked.topic, angle: picked.angle });

    // 5. Generate — with an absolute deadline so a degraded run fails fast and
    // alerts instead of being killed silently at the 300s serverless cap.
    stage = "generate";
    const fg = await generateFieldGuide({
      topic: picked.topic,
      summary: picked.angle,
      urls: picked.urls,
      angle: picked.angle,
      deadlineAt: invokedAt + 245_000,
    });

    // 6. Upload artifacts (always, so even blocked runs are reviewable). Best-effort.
    stage = "upload";
    let pdfUrl: string | null = null;
    let zipUrl: string | null = null;
    try {
      const slug = slugify(fg.plan.title);
      const [pdfBlob, zipBlob] = await Promise.all([
        uploadBlob(`auto/${runId}/${slug}.pdf`, fg.pdf, "application/pdf", { addRandomSuffix: true }),
        uploadBlob(`auto/${runId}/${slug}.zip`, fg.zip, "application/zip", { addRandomSuffix: true }),
      ]);
      pdfUrl = pdfBlob.url;
      zipUrl = zipBlob.url;
      try {
        await recordGeneration({
          id: runId,
          title: fg.plan.title,
          topic: fg.plan.subtitle || fg.plan.title,
          source_count: fg.research.sources.length,
          page_count: fg.plan.sections.length,
          pdf_url: pdfBlob.url,
          zip_url: zipBlob.url,
          pdf_bytes: fg.pdf.length,
          zip_bytes: fg.zip.length,
          linkedin_chars: fg.caption ? fg.caption.length : null,
        });
      } catch (dbErr) {
        console.error(`[daily-post] recordGeneration failed (non-fatal): ${sanitizeError(dbErr)}`);
      }
    } catch (blobErr) {
      console.error(`[daily-post] blob upload failed (non-fatal, posting still uses the buffer): ${sanitizeError(blobErr)}`);
    }
    await updateRun(runId, {
      status: "generated",
      plan_title: fg.plan.title,
      page_count: fg.plan.sections.length,
      source_count: fg.research.sources.length,
      pdf_url: pdfUrl,
      zip_url: zipUrl,
      api_version: getApiVersion(),
      timings_json: fg.timings,
    });

    // 7. Artifact gate — never auto-post a broken guide.
    const gate = artifactGate(fg);
    if (!gate.ok) {
      const reason = `artifact gate: ${gate.reasons.join("; ")}`;
      await updateRun(runId, { status: "blocked", error: reason });
      await sendAlert({ kind: "blocked", topic, reason });
      return { status: "blocked", runId, reason, pdfUrl };
    }

    // 8. Caption: deterministic guard, then LLM self-check. A bad/missing LLM
    // caption degrades to the deterministic plan-derived fallback instead of
    // blocking the day — the fallback still passes BOTH the guard and the
    // self-check before posting (safety gates are never skipped, only re-fed).
    stage = "caption";
    let captionFallbackUsed = false;
    let guard = fg.caption ? guardCaption(fg.caption) : null;
    if (!guard || !guard.ok) {
      const why = guard ? guard.reasons.join("; ") : "no LinkedIn caption was generated";
      console.warn(`[daily-post] LLM caption unusable (${why}) — switching to deterministic fallback caption`);
      guard = guardCaption(buildFallbackCaption(fg.plan));
      captionFallbackUsed = true;
      if (!guard.ok) {
        const reason = `caption guard (incl. fallback): ${guard.reasons.join("; ")}`;
        await updateRun(runId, { status: "blocked", error: reason });
        await sendAlert({ kind: "blocked", topic, reason });
        return { status: "blocked", runId, reason, pdfUrl };
      }
    }
    await updateRun(runId, { caption: guard.clean });
    let verdict = await selfCheckCaption(guard.clean, fg.plan);
    if (!verdict.ok && !captionFallbackUsed) {
      // The LLM caption failed the self-check — try the deterministic fallback
      // through the SAME gates before giving up on the day.
      console.warn(`[daily-post] self-check rejected LLM caption (${verdict.reason}) — trying fallback caption`);
      const fbGuard = guardCaption(buildFallbackCaption(fg.plan));
      if (fbGuard.ok) {
        const fbVerdict = await selfCheckCaption(fbGuard.clean, fg.plan);
        if (fbVerdict.ok) {
          guard = fbGuard;
          verdict = fbVerdict;
          captionFallbackUsed = true;
          await updateRun(runId, { caption: guard.clean });
        }
      }
    }
    if (!verdict.ok) {
      const reason = `self-check blocked: ${verdict.reason}`;
      await updateRun(runId, { status: "blocked", error: reason });
      await sendAlert({ kind: "blocked", topic, reason });
      return { status: "blocked", runId, reason, pdfUrl };
    }
    if (captionFallbackUsed) {
      console.log(`[daily-post] posting with deterministic fallback caption for run ${runId}`);
    }

    // 9. Dry-run stops before posting.
    if (dryRun) {
      await updateRun(runId, { status: "dry_run" });
      await sendAlert({ kind: "dry_run", topic, pdfUrl });
      return { status: "dry_run", runId, pdfUrl };
    }

    // 9.5 Approval mode (M12): park the fully-gated run and hand the decision
    // to the owner via a single-use emailed link — the decide route performs
    // the actual post (through publishRunToLinkedIn). Human approval also
    // supersedes the LLM self-check for any caption edits made on the page.
    // Requires the blob artifact: a later invocation has no PDF Buffer, so a
    // failed upload falls through the normal fail path (same-day retryable).
    if (settings.approval_mode) {
      stage = "approval";
      if (!pdfUrl) {
        throw new Error("approval mode needs the uploaded PDF artifact, but the blob upload failed");
      }
      const minted = await mintApprovalToken(runId);
      await updateRun(runId, {
        status: "awaiting_approval",
        approval_token_hash: minted.tokenHash,
        approval_expires_at: minted.expiresAt,
      });
      await sendAlert({
        kind: "awaiting_approval",
        topic,
        approveUrl: `${appBaseUrl()}/approve?token=${encodeURIComponent(minted.token)}`,
        pdfUrl,
        expiresAt: minted.expiresAt,
      });
      return { status: "awaiting_approval", runId, pdfUrl };
    }

    // 10-12. Publish (token → document upload → post) via the shared tail.
    return await publishRunToLinkedIn({
      runId,
      topic,
      caption: guard.clean,
      planTitle: fg.plan.title,
      pdf: fg.pdf,
      pdfUrl,
    });
  } catch (err) {
    // Pre-post failure (topic/generate/upload/auth/doc-upload) — safely retryable.
    const error = sanitizeError(err);
    console.error(`[daily-post] failed at ${stage}: ${error}`);
    // Alert FIRST (Resend is DB-independent), then best-effort persist — a DB
    // outage in updateRun must never suppress the email.
    if (err instanceof LinkedInAuthError) {
      await sendAlert({ kind: "needs_reconnect", reason: error });
    } else {
      await sendAlert({ kind: "failed", topic: topic || undefined, stage, error });
    }
    try {
      await updateRun(runId, { status: "failed", error: `${stage}: ${error}` });
    } catch (dbErr) {
      console.error(`[daily-post] could not persist failure (alert already sent): ${sanitizeError(dbErr)}`);
    }
    return { status: "failed", runId, error };
  }
}
