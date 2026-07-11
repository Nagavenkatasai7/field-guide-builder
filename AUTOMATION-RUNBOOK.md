# LinkedIn daily auto-post — runbook

Your Field Guide Builder now generates an illustrated PDF + caption every morning and posts the **PDF
as a swipeable LinkedIn document** to your profile — fully behind the scenes — with a UI to review,
delete, or pause it. Built overnight; here's everything you need.

---

## ☀️ Do this in the morning (≈3 minutes)

The app is built, configured, deployed, and verified. The only thing I can't do for you is click
"Allow" on LinkedIn's consent screen. So:

1. **Start the app locally:** `npm run dev` → open **http://localhost:3838**, log in with your password.
   (Local runs on 3838 to match the redirect URL you registered.)
2. In the **"Daily LinkedIn automation"** panel, click **Connect LinkedIn** → approve on LinkedIn.
   You'll land back with "✅ LinkedIn connected." Your token is stored in the shared Neon DB, so the
   **production cron will use it** even though you connected locally.
3. Click **Run now (dry-run)** → wait ~1–2 min. It generates a real guide + caption **without posting**.
   Review the PDF + caption in the run log. (I already did one dry-run for you — topic "MLGym Framework
   for AI Research Agents", 12 pages — it's in the log.)
4. When you're happy: turn **Dry-run mode OFF**, then turn **Automation ON**. The banner turns green:
   *"🟢 LIVE — auto-posts to LinkedIn at ~12:00 PM (noon) America/New_York."*
5. (Optional but recommended) Do ONE **Run now (live)** to confirm a real post lands correctly on your
   profile, the "View on LinkedIn" link works, and "Delete from LinkedIn" removes it. **This is the only
   real test of the live posting path** — the dry-run validates everything up to (but not including) the
   actual LinkedIn POST.

That's it. From then on it posts itself around 12 PM (noon) ET daily.

---

## What's already done

- ✅ Full feature built: cron → pick trending AI/ML topic → generate guide → safety-gate caption →
  post PDF document + caption → log it. Typecheck + lint + Snyk (0 issues) clean.
- ✅ Your LinkedIn credentials wired into `.env.local` (Client ID/Secret, redirect, API version).
- ✅ A `CRON_SECRET` generated and set locally + in Vercel.
- ✅ **Deployed to Vercel production** with the two daily cron jobs registered (16:00 + 17:00 UTC →
  noon ET year-round across DST).
- ✅ One successful end-to-end dry-run (valid 940 KB PDF, on-brand 1,575-char caption).

## What only YOU can / may want to do

- **Connect LinkedIn** (the OAuth approve — step 2 above). Required; I can't click it for you.
- **Add a Resend API key** to turn on email alerts. Until then, alerts are a logged no-op and you rely
  on the in-app log + banner. Add `RESEND_API_KEY` to `.env.local` (local) and Vercel env (prod), plus a
  verified sender, and you'll get emails on every post / block / failure / token-expiry to your configured ALERT_EMAIL_TO address.
- **Connect on prod instead of local?** Then register
  `https://<your-prod-domain>/auth/linkedin/callback` as an Authorized redirect URL in your LinkedIn app
  and set `LINKEDIN_REDIRECT_URI` in Vercel to match. (Not needed if you connect locally — the token is
  shared via the DB.)

---

## The controls (in the automation panel)

| Control | What it does |
|---|---|
| **Connect / Reconnect / Disconnect** | Manage the LinkedIn OAuth connection. Token lasts ~60 days; reconnect when it warns you. |
| **Automation toggle** | Master on/off for the daily cron. |
| **Dry-run mode** | When ON, the daily job generates + logs but does NOT post. Your safety preview. |
| **Run now (dry-run)** | Generate + review without posting, any time. |
| **Run now (live)** | Generate + actually post now (needs LinkedIn connected). |
| **Per run: View caption / PDF / View on LinkedIn** | Inspect exactly what went out. |
| **Per run: Delete from LinkedIn** | One-click removal of a posted item from your profile. |
| **Per run: Retry** | Re-run a failed/blocked day (reuses its topic). |

## How it behaves (and when it deliberately skips)

It posts **at most one** guide per day. A day is **skipped** (logged, nothing posted) when: automation is
off, no fresh/reputable topic is found, the guide fails the **artifact gate** (a section or diagram
failed — would look broken), the caption fails the **deterministic guard or the LLM self-check**, or
LinkedIn needs reconnecting. *A skipped day is the safe outcome — better than posting something broken or
off-brand under your name.* Because there's no human pre-review, these automated gates + the post-hoc
**Delete** button + the **Pause**/`AUTOMATION_DISABLED` kill switch are your safety net.

## Bonus: per-topic design variant

In the manual flow (the "PDF + Zip" step), there's a checkbox **"✨ Generate a fresh design for this
topic."** Off = the consistent standard look (used for all daily auto-posts, so you don't hassle with
designs). On = a one-off palette + typeface tuned to that topic, so you can A/B which performs better.

## Troubleshooting

- **"Token expired / reconnect"** → click Reconnect. (LinkedIn member tokens last ~60 days; the app warns
  you at 14/7/3 days. If LinkedIn didn't grant a refresh token, you'll reconnect manually every ~60 days.)
- **A run is stuck "Posting" / "Needs review"** → it was interrupted mid-post and *may* have published.
  Check your LinkedIn profile; if it posted, use Delete. The system never auto-reposts these (no
  double-post).
- **Emergency stop everything** → set `AUTOMATION_DISABLED=1` in Vercel env (halts before any DB read),
  or just toggle Automation off.
- **Cron timing** isn't to-the-minute on Vercel Hobby (fires sometime in the noon ET hour). That's a plan
  limit, not a bug; Vercel Pro gives minute precision.
