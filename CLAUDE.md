@AGENTS.md

# Field Guide Builder — project memory

Single-user web app that takes a concept + sources and generates a magazine-quality
A4 PDF (illustrated, infographic-first, Wired/Jay-Alammar editorial polish) plus a
LinkedIn caption. Built to generate a daily LinkedIn field-guide post in a configurable
author's voice — the author identity (name, brand, role, bio, hashtag, YouTube, audience)
is set via `AUTHOR_*` env vars read in `lib/identity.ts` (see `.env.local.example`). The
daily posts are NICHED to *AI workflow automation for business operations*: topic-picker
biases to automation/agent/enterprise developments, captions tie each mechanism to a
business-process implication, PDF bylines carry the configured author identity. Honesty
rule: never put unverified metrics in captions beyond what the day's outline/sources
support.

This file is loaded into every Claude Code session in this repo. Update it after each
milestone with the durable facts. Keep it tight — link out, don't paste long content.

---

## Milestone status

| # | Stage | Status | Key file(s) | Notes |
|---|---|---|---|---|
| M1 | Skeleton: auth + input form + stub research | ✅ done | `proxy.ts`, `lib/auth.ts`, `app/login/page.tsx` | Next.js 16 calls middleware "proxy.ts" |
| M2 | Tavily real research + source cards | ✅ done | `lib/tavily.ts`, `app/api/research/route.ts` | advanced depth + markdown rawContent, parallel `extract()` for user URLs |
| LLM | Provider swap: Anthropic → Ollama Cloud Gemma 4 31B | ✅ done | `lib/llm.ts`, `scripts/ping-llm.mjs` | kimi-k2.6:cloud is paid-tier; no fallback set |
| M3 | Plan SSE + editable approval UI | ✅ done | `app/api/plan/route.ts`, `app/_components/PlanEditor.tsx`, `lib/plan-schema.ts`, `lib/prompts/plan.ts` | `think:"low"` to stay under 60s |
| M4 | Per-section HTML draft, parallel SSE | ✅ done | `app/api/draft/route.ts`, `app/_components/DraftPanel.tsx`, `lib/prompts/draft.ts` | `think:false` (thinking ate the maxTokens budget) |
| M5 | Puppeteer A4 PDF render | ✅ done | `app/api/render/route.ts`, `lib/pdf-renderer.ts`, `lib/templater.ts`, `templates/field-guide.css` | Local: system Chrome. Prod: @sparticuz/chromium-min v148 |
| M6 | SVG infographics, parallel with drafting | ✅ done | `app/api/svg/route.ts`, `app/_components/SvgPanel.tsx`, `lib/prompts/svg.ts`, `lib/svg-validator.ts` | M8 dropped think:false → 32s for 2 SVGs |
| M7 | LinkedIn post + copy-box UI (parallel with everything else) | ✅ done | `app/api/linkedin/route.ts`, `app/_components/LinkedinPanel.tsx`, `lib/prompts/linkedin.ts` | think:false, 18s, 2033 chars in target range |
| M8 | Polish | ✅ done | `app/icon.svg`, page.tsx start-over button, side-by-side layout | favicon, partial-failure recovery, SVG speed-up |
| Post-M8 | ZIP output (PDF + per-page PNGs + linkedin.txt) + history DB | ✅ done | `lib/zip.ts`, `lib/storage.ts`, `app/api/history/route.ts`, `app/_components/HistoryPanel.tsx`, `app/_components/RenderPanel.tsx` rewritten | Vercel Postgres + Blob optional; inline base64 fallback for local dev |
| M9 | Daily LinkedIn auto-post (cron → generate → post PDF document) + AutomationPanel + AI design variant | ✅ done | `lib/daily-post.ts`, `lib/linkedin-api.ts`, `lib/pipeline.ts`, `lib/topic-picker.ts`, `lib/caption-guard.ts`, `lib/notify.ts`, `lib/design-variant.ts`, `app/api/cron/daily-post/route.ts`, `app/auth/linkedin/callback/route.ts`, `vercel.json` | self-serve `w_member_social`; default OFF + dry-run-first; two-cron NY-hour gate; safety state machine; Resend email alerts. See `AUTOMATION-RUNBOOK.md`. |
| M10 | Unified tabbed dashboard (Overview/Posts/History/Alerts/Generate/Settings) + email-alert log | ✅ done | `app/_components/Dashboard.tsx`, `app/_components/GenerateWorkspace.tsx`, `app/api/automation/alerts/route.ts`, `alerts` table in `lib/storage.ts`, `lib/notify.ts` records each alert | dashboard is the home page (`app/page.tsx` → `<Dashboard/>`); AutomationPanel.tsx removed (absorbed); schedule moved to **noon ET** (crons `0 16`/`0 17` UTC); topic-picker tuned to prefer fresh/trending + reject evergreen; `run-now` accepts a topic override |
| M16 | Connection pipeline + weekly recap | ✅ done | `lib/connections.ts`, `app/api/connections/*`, `app/_components/NetworkPanel.tsx`, recap in cron route + `getWeeklyStats`/`claimWeeklyRecap` in storage | Prepare-only notes (≤280 chars) anchored on the latest guide; Sunday post-hour fire emails owned metrics behind an atomic once-per-date claim. |
| M15 | Format rotation + weekly schedule | ✅ done | `uploadImage`/`createImagePost`/`createTextPost` in `lib/linkedin-api.ts`, `day_formats` setting, `post_format`/`image_url` run columns, WeeklyPlanCard in Dashboard | 7-token Sunday-first plan (off/document/text/image), default document-daily = pre-M15 behavior. Text/image days still generate the full guide; only the LinkedIn post shape changes. Image days upload the cover PNG to blob for approval-time re-fetch. |
| M14 | Repurposing engine + public feeds | ✅ done | `lib/repurpose.ts`, `app/api/automation/runs/[id]/repurpose`, `/api/feed` + `/api/feed/rss` (public), Repurpose panel in Dashboard | Blog/X-thread/newsletter derivatives from stored run fields; LLM sees only PDF_URL/POST_URL placeholder tokens (no hallucinated links); UTM tagging (utm_source=field-guide) for owned analytics. |
| M13 | Engagement cockpit | ✅ done | `lib/engagement.ts`, `app/api/engagement/*`, `app/_components/EngagePanel.tsx`, `engagement_items` table | Daily comment targets (Tavily 2-angle sweep through the topic-picker's reputation filter) + drafted comments + reply drafter. PREPARE-ONLY: no code path submits LinkedIn member actions (ToS). |
| M12 | Approval mode + voice injection: daily run parks as `awaiting_approval`, owner approves/edits/skips via single-use emailed link (`/approve`), personal take prepended to the caption before posting | ✅ done | `lib/approval.ts`, `app/api/approval/preview,decide/route.ts`, `app/approve/page.tsx`, `app/_components/ApprovalClient.tsx`, `app/api/automation/runs/[id]/approval-link/route.ts`, changes in `lib/daily-post.ts` (publishRunToLinkedIn extracted), `lib/storage.ts`, `lib/notify.ts`, `proxy.ts` | Toggle in Settings (`automation_settings.approval_mode`, default OFF). Token: HMAC-signed capability, DB stores only its hash, 24h TTL, atomic single-use claim. Reaper now measures `updated_at` (not `created_at`) and sweeps lapsed approvals to `skipped`. Human approval replaces the LLM self-check for page edits. |
| M11 | Full-stack redesign: deterministic diagram renderer, document/caption power-up, never-miss-a-day hardening, security pass | ✅ done | `lib/diagram-schema.ts`, `lib/diagram-renderer.ts`, `lib/prompts/diagram.ts`, `lib/caption-fallback.ts`, rewrites across `lib/pipeline.ts`, `lib/daily-post.ts`, `lib/llm.ts`, `lib/templater.ts`, `templates/field-guide.css`, prompts, cron route, settings route | LLM no longer draws SVG — it emits a constrained-decoded JSON spec; geometry is 100% deterministic TypeScript. Same-day cron retry window + dead-man's switch. Fallback caption + fallback diagram = a missing post requires multiple independent failures. Verified end-to-end on a live MoE run (both diagrams perfect first try, 9/9 drafts, 1288-char caption). |

Latest pipeline numbers on the Bumblebee test query (parallelized):
- research 7s · plan 43s · build stage (draft || svg || linkedin) ≈ 32s critical path · render 3.5s
- **Total: ~86s** — under the 90s spec target ✓
- M6 (SVG) was the long pole; dropping think to false in M8 cut it from 57s to 32s

---

## Architecture & layout

```
/app
  page.tsx                  Single-page orchestrator: form → research → plan → drafts || svgs → render
  layout.tsx, globals.css   Fonts (Fraunces/Geist/Geist Mono) + Tailwind v4 with design tokens
  /login/page.tsx           Password gate (Suspense-wrapped because of useSearchParams)
  /_components/             Client components (underscore = not a route)
    PlanEditor.tsx          SSE consumer + editable plan UI (drag/reorder/add/remove)
    DraftPanel.tsx          Auto-starts on mount; per-section state pills + HTML preview
    SvgPanel.tsx            Mirrors DraftPanel shape; renders inline SVG previews
    RenderPanel.tsx         Ref-based blob-URL binding to iframe + anchor (Snyk false-positive workaround)
  /api
    /auth/login,logout/     HMAC-signed cookie endpoints
    /research/route.ts      Tavily search+extract merge
    /plan/route.ts          Gemma 4 outline → SSE stream
    /draft/route.ts         Per-section HTML, concurrency=3 → SSE stream
    /svg/route.ts           Per-infographic SVG, concurrency=2 → SSE stream
    /render/route.ts        PDF + per-page PNGs + zip; uploads to Vercel Blob + writes history row if storage env vars set, else returns base64 inline
    /history/route.ts       Lists last 20 runs; returns {enabled:false} if storage not configured
/lib
  auth.ts                   Edge-compatible HMAC (Web Crypto subtle)
  tavily.ts                 @tavily/core wrapper
  llm.ts                    Ollama Cloud wrapper (Gemma 4 31B primary, fallback off by default)
  plan-schema.ts            Zod schemas for Plan/Section/Infographic
  prompts/plan.ts           "Editor-in-chief" system prompt
  prompts/draft.ts          "Staff writer" prompt + per-kind HTML rules
  prompts/svg.ts            "Senior info designer" prompt with Jay Alammar visual rules
  svg-validator.ts          jsdom-based: viewBox required, forbidden tags stripped
  templater.ts              Pure-function HTML builder, per-kind page layouts
  pdf-renderer.ts           Local Chrome / chromium-min dual path; exports renderPdf AND renderPdfAndPageImages (per-section element screenshots at 1240x1754)
  zip.ts                    archiver v8 ESM wrapper (ZipArchive class — old @types/archiver lies about callable default)
  storage.ts                Vercel Postgres + Blob helpers; storageEnabled() guard, ensureSchema() lazy CREATE TABLE on first use
/templates/field-guide.css  Hand-written print CSS (NOT Tailwind) — A4, page rhythm, editorial chrome
/scripts/ping-llm.mjs       Sanity check: node --env-file=.env.local scripts/ping-llm.mjs
proxy.ts                    Auth middleware (Next.js 16 renamed middleware.ts → proxy.ts)
```

## Conventions

- **TypeScript strict everywhere.** No `any`. Zod at every API boundary.
- **No Tailwind in the PDF template.** Hand-written CSS for print precision.
- **Commit format:** conventional commits (`feat:`, `fix:`, `chore:`, `docs:`). Always include the
  Co-Authored-By trailer. Never amend; create new commits.
- **Push to Vercel only when the user asks.** Same for any remote/shared-state action.
- **Run `snyk_code_scan` after writing first-party code.** Required by the user's global CLAUDE.md.
- **Test in a real browser, not just curl, for any UI change.** Lesson from M1 advisor.
- **Call advisor before declaring a milestone done.** Catches stale closures, prod-vs-dev timeouts.

## Quirks already discovered (don't relearn these)

1. **Next.js 16 renamed middleware.ts → proxy.ts.** Same shape (`NextResponse`, `NextRequest`), file lives at project root.
2. **`cookies()` is async in Next 15+.** `await cookies()`.
3. **`useSearchParams()` in client components needs a Suspense boundary** for static prerendering.
4. **`setContent` doesn't accept `networkidle0`** — only `load`/`domcontentloaded`. Use `await page.evaluate(() => document.fonts.ready)` for fonts.
5. **Gemma 4 thinking tokens count against `eval_count` AND `num_predict`.** `think: "medium"` on a 4000-token cap returns ~50 chars of actual output. Drop to `"low"` or `false` for size-sensitive calls.
6. **Vercel Hobby tier hard-caps functions at 60s** regardless of `maxDuration`. Watch plan/draft/svg total times.
7. **kimi-k2.6:cloud requires the paid Ollama Cloud tier** even if you've pulled the manifest locally. Fallback is off until the user picks a model their plan includes.
8. **Snyk flags `useState → href/src` as DOM-XSS structurally**, even for `URL.createObjectURL` results. Workaround: ref-based imperative assignment in `useEffect` (see `RenderPanel.PdfPreview`). The real defense is the `startsWith("blob:")` guard.
9. **React stale-closure trap in SSE consumers**: don't put `phase`/`data` state in `useCallback` deps if you read them after the stream loop. Use local booleans (`gotPlan`, `gotSection`, etc.) inside the function scope. Burned on this in M3.
10. **Dev server picks up `.env.local` changes** automatically (logs "Reload env: .env.local").
11. **archiver v8 is pure ESM with named class exports.** Use `import { ZipArchive } from "archiver"; new ZipArchive(opts)`. The `archiver("zip", opts)` callable from older docs and `@types/archiver` is gone; runtime says "archiver is not a function" if you try the old pattern. Types are stale → @ts-expect-error the named import.
12. **`storage.ts` lazy-initializes the schema** on first call via `ensureSchema()` — no migration step needed; first /api/render or /api/history run after `vercel env pull` creates the table.
13. **jsdom does not work on Vercel's serverless runtime.** Its transitive dep `html-encoding-sniffer` does `require()` of ESM-only `@exodus/bytes`, which the serverless bundler rejects (`ERR_REQUIRE_ESM`). Module-level imports crash the entire route on first invocation. Works locally because Node's loader is lenient. The replacement `lib/svg-validator.ts` uses regex only — same checks, smaller bundle, no DOM library.
14. **Tavily search query is capped at 400 chars.** Don't concatenate the summary into the query. lib/tavily.ts sends just `topic` (≤200 chars by schema) to Tavily; the summary flows to plan + draft prompts where it shapes the angle. Short keyword-style search queries also rank better than long natural-language sentences.
15. **Don't dump raw response text into UI error state.** When an SSE endpoint crashes server-side, Vercel returns a 500 HTML error page in the body. Catching that with `setError(text)` displays a giant escaped HTML blob to the user. All three SSE panels now check `content-type: text/html` (or text starting with `<`) and surface a clean status code message instead.
16. **Ollama Cloud calls from Vercel iad1 add ~50% latency vs local.** Local /api/draft @ 24s ≈ production 36-50s; with bad-network jitter the 60s function cap is too tight. All four LLM/render routes (plan, draft, svg, render) are bumped to `maxDuration = 300` (Hobby+Fluid Compute ceiling). Requires Fluid Compute enabled at the project level — default for projects created after late-2024 (this one is). If a future fresh project times out at exactly 60s even with maxDuration=300, check Vercel Settings → Functions → Fluid Compute.
17. **LinkedIn document post to a PERSONAL profile is self-serve (M9).** `w_member_social` (the "Share on LinkedIn" product) is enough — for person-owned documents the only check is "caller must match the document owner", no partner/Marketing-Developer-Platform approval. Only *reading* others' posts (`r_member_social`) is gated, and we never need it (we store the returned post URN ourselves). Flow: `initializeUpload` → PUT bytes → poll GET until `AVAILABLE` → POST `/rest/posts`. See `lib/linkedin-api.ts`.
18. **The created post URN comes back in the `x-restli-id` RESPONSE HEADER** (not the body) — fail loud if absent (else you get an undeletable orphan post). GET a document uses the URN **unencoded** in the path; DELETE a post uses the URN **encoded** + header `X-RestLi-Method: DELETE`. All `/rest/*` calls need `X-Restli-Protocol-Version: 2.0.0` + `LinkedIn-Version: YYYYMM` (env `LINKEDIN_API_VERSION`, default 202509; old versions sunset ~yearly).
19. **Vercel Hobby cron = max 2 jobs, ~once/day, within-the-hour, UTC only.** For **noon (12pm) ET** year-round we use TWO entries (`0 16 * * *` + `0 17 * * *` — noon EDT=16:00 UTC, noon EST=17:00 UTC) and the handler proceeds only when the `America/New_York` hour (via `Intl.DateTimeFormat`) equals `post_hour` (default 12); the off-season fire self-skips. Idempotency is a **partial unique index** `ON scheduled_runs (run_date) WHERE trigger='cron'` so a manual/dry-run never claims the cron slot. To change the time: edit `vercel.json` crons (UTC) AND `post_hour` in `automation_settings`.
20. **The pipeline generators were extracted from the SSE routes into `lib/pipeline.ts`** (M9). plan/draft/svg/linkedin routes now delegate via `onRetry/onSection/onSvg` callbacks — single source of truth so the cron and the interactive UI can't drift. `chat()` gained an opt-in `timeoutMs` (the cron collapses 5 stages into one 300s function, so a stalled call must fail fast).
21. **The LinkedIn post is the one non-idempotent stage** — `r_member_social` is gated so we CAN'T read posts back to recover from a mid-flight crash. So: persist `status='posting'` BEFORE `createDocumentPost`, NEVER retry the post call, a post-call failure → `needs_review` (never auto-reposted), and `reapStaleRuns` turns a stale `posting` row into `needs_review`. Pre-post stages (topic/generate/upload) are the only safely-retryable ones.
22. **Automation defaults to OFF + dry-run ON** (`automation_settings`), and the global kill switch `AUTOMATION_DISABLED` is checked before any DB read (fail-closed). The proxy bypass for the cron route is **exact-match** (`PUBLIC_API_EXACT` Set, `===`) on only `/api/cron/daily-post` — never a `/api/cron/` prefix (that would un-gate `run-now` + typo'd paths). `CRON_SECRET` verify is fail-closed + timing-safe.
23. **The LLM never draws SVG (M11).** Diagrams are JSON specs (`lib/diagram-schema.ts`, constrained-decoded via Ollama's `format` param — pass `DIAGRAM_JSON_SCHEMA` as `json`) rendered deterministically by `lib/diagram-renderer.ts` (grid layout, measured text wrap, scale-to-fit, paper background card). On double failure `fallbackDiagram()` ships a typeset "field note" card — the templater placeholder path also uses it, so a dashed placeholder can never reach a PDF. A viewBox-only SVG has **no intrinsic size** — any wrapper needs explicit width or it collapses to the 300×150 replaced-element default (that's why `.fig { width: 100% }`).
24. **The off-hour cron fire is the recovery window (M11).** Post-hour fire runs the day; the other fire retries today's `failed`/`blocked` cron run (`reclaimRetryableCronRun`, attempt-capped, never touches posting/posted/needs_review) or runs a late first attempt if NO row exists after the post hour (dead-man's switch). `automation_settings.post_hour` is validated against the fixed UTC crons across BOTH DST seasons — for America/New_York with `0 16`/`0 17` crons the only valid value is 12.
25. **Caption can't block the day (M11).** Order: LLM caption → guard → self-check; any failure swaps in `buildFallbackCaption()` (plan-derived, deterministic) which re-runs the SAME gates. Guard also strips markdown (LinkedIn renders raw text) and counts hashtags. The caption prompt receives top-3 source excerpts as quotable raw facts — numbers must trace to outline or sources.
26. **Templater module-caches `templates/field-guide.css`** (`_cssCache`) — editing the CSS file does NOT hot-reload in dev; restart the dev server to see CSS changes in renders.
27. **Puppeteer runs with `setJavaScriptEnabled(false)` (M11)** — LLM/client HTML can't execute script in the render context (Puppeteer's own `evaluate` still works over CDP). `sanitizeFragment` + `validateSvg` also strip `on*=` attributes and `javascript:` URLs, and `/api/render` re-sanitizes client-supplied drafts/SVGs server-side.

28. **Approval-mode rows outlive their invocation (M12)** — a run can sit in `awaiting_approval` for hours, then flip to `approved`/`posting` in a DIFFERENT invocation. Two consequences baked into the code: `reapStaleRuns` measures staleness on `updated_at` (a noon-created row approved at 6pm must not be reaped mid-publish by a concurrent cron fire), and the decide route re-downloads the PDF from the blob URL (the original Buffer is gone). Approval therefore REQUIRES the blob upload to have succeeded — `runDailyPost` fails the run (same-day retryable) if `pdfUrl` is null in approval mode.
29. **Approval capability tokens** (`lib/approval.ts`): `v1.<runId>.<exp>.<nonce>.<sig>`, HMAC-keyed by AUTH_COOKIE_SECRET with domain-separated messages. The DB stores only the token's HMAC hash; `claimApprovalDecision` does status flip + hash match + expiry in ONE atomic UPDATE (double-click/two-device race → exactly one winner). Re-issuing from the dashboard rotates the hash, killing older emailed links. `/approve` + the two `/api/approval/*` routes are public in proxy.ts (exact-match) — the token is the entire auth; every check fails closed to a generic 404.

## Env vars

```
AUTH_PASSWORD            # 32+ char access password (gate to the whole app)
AUTH_COOKIE_SECRET       # 32+ char HMAC secret for signing the auth cookie
TAVILY_API_KEY           # https://tavily.com — used in M2 research
OLLAMA_API_KEY           # https://ollama.com — used M3+; case-insensitive read in lib/llm.ts
LLM_PRIMARY_MODEL        # optional; default gemma4:31b-cloud
LLM_FALLBACK_MODEL       # optional; default off (was kimi-k2.6:cloud but it's paid-tier)
CHROMIUM_REMOTE_URL      # optional; default sparticuz v148 pack URL
PUPPETEER_EXECUTABLE_PATH # optional override of local Chrome detection
POSTGRES_URL             # optional; from `vercel env pull` after provisioning Vercel Postgres. Without it, /api/history returns enabled:false and /api/render uses inline mode
BLOB_READ_WRITE_TOKEN    # optional; from Vercel Blob store. Required together with POSTGRES_URL for the storage path to light up
# --- M9 LinkedIn automation ---
LINKEDIN_CLIENT_ID       # from the LinkedIn dev app
LINKEDIN_CLIENT_SECRET   # from the LinkedIn dev app (secret)
LINKEDIN_REDIRECT_URI    # must EXACTLY match a registered redirect; local = http://localhost:3838/auth/linkedin/callback
LINKEDIN_API_VERSION     # optional; default 202509 (YYYYMM; old versions sunset yearly)
CRON_SECRET              # openssl rand -hex 32; Vercel Cron sends it as `Authorization: Bearer`. Set in Vercel env too.
RESEND_API_KEY           # optional; email alerts are dormant without it
ALERT_EMAIL_TO           # optional; default: unset (email alerts skipped when unset)
ALERT_EMAIL_FROM         # optional; default Resend onboarding sender
AUTOMATION_DISABLED      # optional kill switch; set to 1 to halt all auto-posting before any DB read
APP_BASE_URL             # optional (M12); origin for email approve-links. Falls back to LINKEDIN_REDIRECT_URI origin, then VERCEL_PROJECT_PRODUCTION_URL
```

## Testing & dev

- **Local password (committed once in conversation):** read from `.env.local` — don't paste again here.
- **Dev server:** `npm run dev` (Turbopack) — now on **port 3838** (matches the registered LinkedIn redirect). Kill with `lsof -ti:3838 | xargs kill`.
- **Captured test fixtures** in `/tmp/fgb-*` (research JSON, plan SSE, draft SSE, render body) — handy for replaying API calls without re-running the full pipeline. Not committed.
- **Visual UI verification** via Playwright MCP tools. Drive login → form → wait → screenshot.

## Skipped / deferred

- Vercel KV (per-generation history) — skipped for v1
- Multi-user accounts, payments, mobile app, PDF editing — explicitly out of scope per the original spec
- LLM fallback model — left off until user picks one their Ollama Cloud plan covers
- Streaming the model output back to the user as token chunks — current UX uses heartbeat statuses
