import { verifyCronSecret } from "@/lib/auth";
import { runNewsScan } from "@/lib/news-trigger";
import { sendAlert } from "@/lib/notify";
import { killSwitchOn } from "@/lib/daily-post";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Vercel Cron entry for NEWS-TRIGGERED posting (M17). The daily-post cron
 * fires on a fixed schedule; this one is the opposite: it fires frequently
 * (every ~2h in the waking window) and almost always decides "nothing worth
 * posting". When a fresh story clears the novelty threshold it drafts a take
 * and emails the owner a 4-hour single-use approval link; the publish itself
 * happens on the decide route after a randomized human-jitter delay. A quiet
 * day is a correct day — that irregularity is exactly what reads as human.
 *
 * Cron carries no auth cookie, so CRON_SECRET is the entire security
 * boundary (verified fail-closed, timing-safe in verifyCronSecret). Always
 * returns 200 — a scan failure must never retry-storm.
 */
export async function GET(request: Request): Promise<Response> {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  if (killSwitchOn()) {
    return Response.json({ ok: true, skipped: "kill-switch" });
  }
  try {
    const summary = await runNewsScan();
    return Response.json({ ok: true, ...summary });
  } catch (err) {
    // runNewsScan never throws, but the first reads can — make even THAT
    // failure an email, not just a log line.
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[news-scan] unexpected: ${message}`);
    try {
      await sendAlert({ kind: "failed", stage: "news-scan-route", error: message.slice(0, 400) });
    } catch { /* alerts must never break the cron */ }
    return Response.json({ ok: false, error: "internal error" });
  }
}
