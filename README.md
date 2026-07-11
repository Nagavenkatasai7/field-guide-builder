# Field Guide Builder

An automated pipeline that researches a trending topic, writes an illustrated multi-page **PDF "field guide,"** and publishes it to **LinkedIn as a document post** — on a daily schedule, in *your* configured voice, with safety rails so nothing goes out without your say-so.

> ⚠️ **Read this first — LinkedIn automation.** This tool posts to LinkedIn **automatically, under your own account**, using LinkedIn's official API (`w_member_social`). Automated posting can run against parts of LinkedIn's User Agreement — you are responsible for how you use it. It ships **OFF by default** and in **dry-run mode**, with a global kill switch. Start in dry-run, read [`AUTOMATION-RUNBOOK.md`](./AUTOMATION-RUNBOOK.md), and enable live posting only when you understand what it will publish.

## What it does

Each run walks a five-stage pipeline:

1. **Research** — pulls fresh material on a topic (web search via [Tavily](https://tavily.com)).
2. **Plan** — an LLM outlines a single field-guide issue (sections, angles, why-it-matters).
3. **Draft** — writes each section as illustrated HTML, streamed section-by-section.
4. **Render** — turns the HTML into a polished **PDF + per-page PNGs**, bundled as a downloadable ZIP (headless Chromium).
5. **Post** — uploads the PDF to LinkedIn as a document post and writes a caption; stores the returned post URN.

A **daily cron** can run the whole thing end-to-end and auto-pick a fresh trending topic, gated by a safety state machine (default OFF, dry-run first, kill switch, per-day idempotency).

## Tech stack

- **Next.js** (App Router, TypeScript) on **Vercel**
- **Ollama Cloud** (or a local Ollama) for planning, drafting, diagrams, and captions — model is configurable
- **Tavily** for research
- **Puppeteer + `@sparticuz/chromium-min`** for serverless PDF/PNG rendering
- **Vercel Postgres + Blob** (optional) for post history/storage — falls back to inline mode without them
- **Resend** (optional) for email alerts on every post / block / failure / token expiry
- Password-gated UI; LinkedIn OAuth (self-serve `w_member_social`)

## Prerequisites

You'll need your own accounts/keys (all have free tiers that are plenty for personal use):

- **Node.js 20+** and npm
- A **LinkedIn Developer app** (https://developer.linkedin.com) with the **"Share on LinkedIn"** and **"Sign In with LinkedIn using OpenID Connect"** products enabled
- An **Ollama Cloud** API key (https://ollama.com/settings/keys) — or a local Ollama install
- A **Tavily** API key (https://tavily.com)
- *(optional)* **Vercel Postgres + Blob** for durable post history
- *(optional)* **Resend** API key for email alerts

## Setup

```bash
git clone <your-fork-url> field-guide-builder
cd field-guide-builder
npm install
cp .env.local.example .env.local   # then fill it in (see below)
npm run dev                        # http://localhost:3838
```

### Configure your identity (important)

This started life as one person's tool; the author identity is now **fully configurable** so the guides and posts come out in **your** voice, not someone else's. Set these in `.env.local` (all have safe placeholder defaults):

| Variable | What it is |
| --- | --- |
| `AUTHOR_NAME` | Your name — used in the byline and prompts |
| `AUTHOR_BRAND` | Your series/channel name (e.g. "Field Notes by Jane") |
| `AUTHOR_HASHTAG` | Your signature hashtag (must start with `#`) |
| `AUTHOR_YOUTUBE` | Optional channel link (leave blank to omit) |
| `AUTHOR_ROLE` | One-line description of who you are |
| `AUTHOR_BIO` | Short author bio for the PDF back page |
| `AUTHOR_AUDIENCE` | Who you're writing for — steers topic selection and tone |

The prompt-engineering and voice logic stay intact; only the identity is swapped for yours.

### Other environment variables

See [`.env.local.example`](./.env.local.example) for the full annotated list. Key ones:

- **Auth:** `AUTH_PASSWORD`, `AUTH_COOKIE_SECRET` (gate the whole app) — generate with `openssl rand -hex 32`.
- **LLM:** `OLLAMA_API_KEY` (+ optional `LLM_PRIMARY_MODEL` / `LLM_FALLBACK_MODEL`).
- **Research:** `TAVILY_API_KEY`.
- **LinkedIn:** `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`, `LINKEDIN_API_VERSION`. The redirect URI must exactly match one registered in your LinkedIn app.
- **Cron auth:** `CRON_SECRET` (`openssl rand -hex 32`), set identically in Vercel.
- **Storage (optional):** `POSTGRES_URL`, `BLOB_READ_WRITE_TOKEN`.
- **Alerts (optional):** `RESEND_API_KEY`, `ALERT_EMAIL_TO`.
- **Kill switch:** `AUTOMATION_DISABLED=1` stops all auto-posting before any DB read.

**Never commit `.env.local`.** Only `.env.local.example` (placeholders) is tracked.

## Daily auto-posting & safety

Automation defaults to **OFF** and **dry-run ON**. Enable it deliberately from the dashboard, and read [`AUTOMATION-RUNBOOK.md`](./AUTOMATION-RUNBOOK.md) for the full safety model:

- Global kill switch (`AUTOMATION_DISABLED`) checked before any DB read (fail-closed).
- Dry-run mode renders and self-checks but does **not** post.
- A strict LLM "self-check" step can BLOCK a post before it publishes.
- Per-day idempotency so a manual run never collides with the cron slot.
- Email alerts (if Resend is configured) on every post, block, failure, or token expiry.

## Deploy to Vercel

1. Import the repo into Vercel.
2. Add every variable from `.env.local` to the project's Environment Variables (Production).
3. The two cron entries in [`vercel.json`](./vercel.json) fire the daily post (they target noon US-Eastern year-round via a two-entry UTC gate). Vercel Hobby allows 2 cron jobs, ~once/day.
4. If long LLM/render routes time out at 60s, enable **Fluid Compute** (Settings → Functions).

## License

[MIT](./LICENSE) — free to use, modify, and share. No warranty. You are responsible for complying with LinkedIn's and every third-party service's terms.
