/**
 * Out-of-band email alerts via the Resend REST API (hand-rolled fetch, no new
 * dependency). DORMANT until RESEND_API_KEY is set — sendAlert() then becomes a
 * logged no-op so local dev and pre-setup never break. Never includes tokens;
 * error strings are already sanitized by callers.
 *
 * Env:
 *   RESEND_API_KEY    — required to actually send (paste in the morning)
 *   ALERT_EMAIL_TO    — recipient (default: unset — alerts are skipped when unset)
 *   ALERT_EMAIL_FROM  — sender (default Resend's onboarding sender, which can
 *                       email the account owner in test mode)
 */

import { recordAlert, storageEnabled } from "@/lib/storage";

export type AlertEvent =
  | { kind: "posted"; topic: string; postUrl: string }
  | { kind: "dry_run"; topic: string; pdfUrl?: string | null }
  | { kind: "blocked"; topic: string; reason: string }
  | { kind: "failed"; topic?: string; stage: string; error: string }
  | { kind: "needs_reconnect"; reason: string }
  | { kind: "needs_review"; detail: string }
  | { kind: "token_expiring"; daysLeft: number };

function render(event: AlertEvent): { subject: string; text: string } {
  switch (event.kind) {
    case "posted":
      return { subject: `✅ Posted to LinkedIn: ${event.topic}`, text: `Your daily Field Guide was posted.\n\nTopic: ${event.topic}\nLink: ${event.postUrl}\n\nIf it's off, open the app and click "Delete from LinkedIn" on this run.` };
    case "dry_run":
      return { subject: `🧪 Dry-run ready: ${event.topic}`, text: `A dry-run generated a Field Guide WITHOUT posting.\n\nTopic: ${event.topic}\n${event.pdfUrl ? `PDF: ${event.pdfUrl}\n` : ""}\nReview it in the app, then enable automation to go live.` };
    case "blocked":
      return { subject: `⚠️ Auto-post blocked (nothing posted): ${event.topic}`, text: `The safety check blocked today's post — nothing was published.\n\nTopic: ${event.topic}\nReason: ${event.reason}\n\nThis is the safe outcome. Review in the app.` };
    case "failed":
      return { subject: `❌ Daily run failed (nothing posted)`, text: `Today's run failed at: ${event.stage}\n${event.topic ? `Topic: ${event.topic}\n` : ""}Error: ${event.error}\n\nNothing was posted. Review/retry in the app.` };
    case "needs_reconnect":
      return { subject: `🔌 Reconnect LinkedIn — posting paused`, text: `Automatic posting can't run: ${event.reason}\n\nOpen the app and click "Reconnect LinkedIn".` };
    case "needs_review":
      return { subject: `🔎 A run needs manual review`, text: `A run was interrupted while posting and may or may not have published to LinkedIn.\n\n${event.detail}\n\nCheck your LinkedIn profile and the run log in the app.` };
    case "token_expiring":
      return { subject: `⏳ LinkedIn token expires in ${event.daysLeft} day(s)`, text: `Your LinkedIn connection expires in ${event.daysLeft} day(s). Open the app and click "Reconnect LinkedIn" to keep daily posting alive.` };
  }
}

export async function sendAlert(event: AlertEvent): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL_TO;
  const from = process.env.ALERT_EMAIL_FROM || "Field Guide Bot <onboarding@resend.dev>";
  const { subject, text } = render(event);

  // No recipient configured → skip gracefully. Never fall back to a hardcoded
  // personal address; without ALERT_EMAIL_TO there is simply nowhere to send.
  if (!to) {
    console.log(`[notify] (dormant — no ALERT_EMAIL_TO) would email "${subject}"`);
    return;
  }

  let status: "sent" | "failed" | "dormant" = "dormant";
  let detail: string | null = null;

  if (!apiKey) {
    console.log(`[notify] (dormant — no RESEND_API_KEY) would email "${subject}"`);
  } else {
    // The "every failure emails me" guarantee hangs on this one call — give it
    // a hard timeout (a hung fetch must not eat the cron's budget) and one
    // retry. Alerts must never break a run.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to, subject, text }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          status = "failed";
          detail = `Resend HTTP ${res.status}`;
          console.error(`[notify] Resend ${res.status} — "${subject}" not delivered`);
          if (res.status >= 500 && attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
        } else {
          status = "sent";
          console.log(`[notify] emailed "${subject}" to ${to}`);
        }
        break;
      } catch (err) {
        status = "failed";
        detail = err instanceof Error ? err.message : String(err);
        console.error(`[notify] send failed (attempt ${attempt + 1}): ${detail}`);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  // Record every alert so it's visible in the dashboard's Alerts log (best-effort).
  try {
    if (storageEnabled()) {
      await recordAlert({ kind: event.kind, subject, recipient: to, status, detail });
    }
  } catch (e) {
    console.error(`[notify] recordAlert failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
