import { verifyCronSecret } from "@/lib/auth";
import { claimWeeklyRecap, getAutomationSettings, getCronRunForDate, getLinkedinStatus, getWeeklyStats } from "@/lib/storage";
import { hourInTimezone, killSwitchOn, nyDateString, runDailyPost, weekdayInTimezone } from "@/lib/daily-post";
import { sendAlert } from "@/lib/notify";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Vercel Cron entry point. Vercel sends `Authorization: Bearer <CRON_SECRET>`
 * when CRON_SECRET is set in project env. This route is allow-listed in
 * proxy.ts (cron carries no auth cookie) so CRON_SECRET is the ENTIRE security
 * boundary — verified fail-closed + timing-safe in verifyCronSecret.
 *
 * Two cron entries fire (16:00 & 17:00 UTC = noon EDT / noon EST). The fire
 * landing in the configured America/New_York hour runs the day's post. The
 * OTHER fire is no longer a pure no-op — it doubles as the recovery window:
 *   - if today's cron run ended failed/blocked (pre-post states only), it
 *     re-claims and retries it (same-day second chance);
 *   - if NO cron row exists after the posting hour passed (first fire died
 *     before claiming, or timing drift skipped it), it runs as a late first
 *     attempt — a dead-man's switch.
 * Always returns 200 (failures are recorded in scheduled_runs) so Vercel never
 * retry-storms.
 */
export async function GET(request: Request): Promise<Response> {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  // Kill switch BEFORE any DB read — fail-closed even if Postgres is reachable.
  if (killSwitchOn()) {
    return Response.json({ ok: true, skipped: "kill-switch" });
  }
  try {
    const settings = await getAutomationSettings();
    const nyHour = hourInTimezone(settings.timezone);

    // Token-expiry early warning, independent of today's run outcome — fires
    // even on paused/dry-run/blocked days so a 60-day LinkedIn token can't
    // expire silently while automation looks healthy. Once per day (post-hour
    // fire only), at the 14/7/3-and-under marks.
    if (nyHour === settings.post_hour) {
      try {
        const status = await getLinkedinStatus();
        if (status.connected && status.daysLeft != null && (status.daysLeft <= 3 || status.daysLeft === 7 || status.daysLeft === 14)) {
          await sendAlert({ kind: "token_expiring", daysLeft: status.daysLeft });
        }
      } catch (e) {
        console.error(`[cron] token check failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    }

    // Weekly recap (M16): Sunday's post-hour fire also emails the week's
    // owned metrics. claimWeeklyRecap is an atomic once-per-date guard, and
    // the whole block is non-fatal — a recap hiccup must never cost a post.
    if (nyHour === settings.post_hour && weekdayInTimezone(settings.timezone) === 0) {
      try {
        if (await claimWeeklyRecap(nyDateString(settings.timezone))) {
          await sendAlert({ kind: "weekly_recap", ...(await getWeeklyStats()) });
        }
      } catch (e) {
        console.error(`[cron] weekly recap failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    }

    if (nyHour === settings.post_hour) {
      const summary = await runDailyPost("cron");
      return Response.json({ ok: true, ...summary });
    }

    // Off-hour fire → recovery window.
    const today = nyDateString(settings.timezone);
    const existing = await getCronRunForDate(today);
    if (existing) {
      // Retry-only: reclaims ONLY failed/blocked (never posting/posted/needs_review).
      const summary = await runDailyPost("cron", { retryOnly: true });
      return Response.json({ ok: true, window: "retry", ...summary });
    }
    if (nyHour > settings.post_hour) {
      // Dead-man's switch: the posting hour passed and nothing ever claimed
      // the day — the first fire died before writing a row. Run late rather
      // than miss the day entirely.
      console.warn(`[cron] no run row for ${today} after the posting hour — late first attempt (dead-man's switch)`);
      const summary = await runDailyPost("cron");
      return Response.json({ ok: true, window: "dead-man", ...summary });
    }
    return Response.json({ ok: true, skipped: "wrong-hour", nyHour, postHour: settings.post_hour });
  } catch (err) {
    // runDailyPost never throws, but the settings/row reads above can — make
    // sure even THAT failure produces an email, not just a log line.
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[cron] unexpected: ${message}`);
    try {
      await sendAlert({ kind: "failed", stage: "cron-route", error: message.slice(0, 400) });
    } catch { /* alerts must never break the cron */ }
    return Response.json({ ok: false, error: "internal error" });
  }
}
