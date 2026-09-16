/**
 * News-triggered posting (M17): the account posts when something genuinely
 * fresh breaks in the niche — not on a fixed daily clock. The pattern reads
 * as a human who reacts to interesting news, because the trigger IS the news.
 *
 * Flow (called from /api/cron/news-scan roughly every 2h, waking hours):
 *   0. Kill switch / storage / settings gates (fail-closed)
 *   1. Waking-window check (news posts only land 07:00–23:00 local)
 *   2. Cadence caps: max 1 news post/day, max NEWS_MAX_PER_WEEK/week (quiet
 *      news weeks = quiet account; enforced via run rows, not memory)
 *   3. Scan Tavily (fresh news + papers) → reputation filter → dedupe URLs
 *      → LLM picks ONE candidate + scores newsworthiness
 *   4. Below NEWS_MIN_SCORE, near-duplicate, or LLM declines → do nothing
 *   5. Claim a run row (kind='news'), draft a short take + ONE deterministic
 *      diagram (the model emits a spec; the renderer draws — never raw SVG)
 *   6. Deterministic caption guard + LLM self-check (never skipped)
 *   7. Random post-not-before jitter (15–180 min, clamped inside waking
 *      hours); approval email carries the window; the decide route refuses to
 *      publish before it and the token dies after NEWS_APPROVAL_TTL_HOURS —
 *      a stale take never posts.
 *
 * Format: text + one diagram when the renderer produces one, text-only when
 * it refuses (a take never blocks on artwork). The weekly long-form field
 * guide stays a separate, deliberate artifact (kind='guide').
 */

import { z } from "zod";
import { chat } from "@/lib/llm";
import { research, searchCandidates } from "@/lib/tavily";
import { BLOCKED_DOMAINS, BLOCKLIST_TERMS, isNearDuplicate } from "@/lib/topic-picker";
import { DIAGRAM_SYSTEM_PROMPT, DIAGRAM_STRICTER_SUFFIX } from "@/lib/prompts/diagram";
import { DiagramSpec, DIAGRAM_JSON_SCHEMA } from "@/lib/diagram-schema";
import { renderDiagram, fallbackDiagram } from "@/lib/diagram-renderer";
import { validateSvg } from "@/lib/svg-validator";
import { launchBrowser } from "@/lib/pdf-renderer";
import { guardCaption } from "@/lib/caption-guard";
import { SELFCHECK_SYSTEM_PROMPT } from "@/lib/prompts/selfcheck";
import { AUTHOR } from "@/lib/identity";
import { appBaseUrl, mintApprovalToken, NEWS_APPROVAL_TTL_HOURS } from "@/lib/approval";
import { sendAlert } from "@/lib/notify";
import { killSwitchOn, hourInTimezone, weekdayInTimezone, nyDateString, publishRunToLinkedIn } from "@/lib/daily-post";
import {
  claimNewsRun,
  dueApprovedNewsRuns,
  getAutomationSettings,
  isNewsUrlSeen,
  markNewsUrlSeen,
  newsPostsInLastDays,
  newsRunTodayExists,
  parseDayFormats,
  recentTopics,
  slugify,
  storageEnabled,
  updateRun,
  uploadBlob,
} from "@/lib/storage";

export const NEWS_MAX_PER_WEEK = 3;
export const NEWS_MIN_SCORE = 8;
export const NEWS_WINDOW_START = 7; // local hour, inclusive
export const NEWS_WINDOW_END = 23; // local hour, exclusive

/** Publishes news runs the owner approved that were parked for their jitter
 * slot (M17). Called at the top of every scan tick; each run publishes
 * exactly once via publishRunToLinkedIn's state machine. */
export async function publishDueApprovedNewsRuns(): Promise<number> {
  const due = await dueApprovedNewsRuns().catch(() => [] as Awaited<ReturnType<typeof dueApprovedNewsRuns>>);
  let n = 0;
  for (const run of due) {
    let image: Buffer | undefined;
    if (run.image_url) {
      try {
        const res = await fetch(run.image_url);
        if (res.ok) image = Buffer.from(await res.arrayBuffer());
      } catch { /* a missing diagram never blocks the take */ }
    }
    await publishRunToLinkedIn({
      runId: run.id,
      topic: run.topic ?? run.plan_title ?? "your take",
      caption: run.caption ?? "",
      planTitle: run.plan_title ?? "Field Note",
      format: image ? "image" : "text",
      image,
      pdfUrl: run.pdf_url,
    }).catch((e: unknown) => console.warn(`[news] due publish failed: ${e instanceof Error ? e.message : e}`));
    n++;
  }
  return n;
}

export type NewsScanSummary = {
  status: "skipped" | "no-news" | "awaiting_approval" | "failed" | "dry_run" | "blocked";
  reason?: string;
  runId?: string;
};

type Candidate = {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  score: number;
};

const NewsPickSchema = z.object({
  post: z.boolean().catch(false),
  reason: z.string().max(300).optional().default(""),
  topic: z.string().max(200).optional().default(""),
  newsworthiness: z.number().min(0).max(10).optional().default(0),
  angle: z.string().max(600).optional().default(""),
  url: z.string().optional().default(""),
});

const NEWS_SCOUT_PROMPT = `You are the news editor for ${AUTHOR.name}, ${AUTHOR.role} — posting on LinkedIn about AI engineering for builders: deep technical, code, breakdowns.

From the candidate list, decide: is there ONE item genuinely worth a practitioner take TODAY?

Post ONLY if the item is:
- CONCRETE: a released model/tool/paper/benchmark with a mechanism to explain — not an opinion piece, funding news, or rumor.
- FRESH: published or surfaced in roughly the last 48 hours (use the Published dates; when unknown, judge from title/snippet).
- TEACHABLE: a builder could learn how it works or apply it this month. No drama, lawsuits, layoffs, politics — those never post.
- NOT a near-duplicate of the recent topics listed.

Most scans should answer post:false. A quiet day is a correct day. Only 8+/10 newsworthiness earns a post.

Output ONLY JSON:
{"post": boolean, "reason": string, "topic": string, "newsworthiness": number, "angle": string, "url": string}
- reason: one short sentence, always set
- topic: <=200 chars, concrete (not a headline sentence); empty if post:false
- angle: 1-2 sentences: the technical hook worth explaining; empty if post:false
- url: the candidate's URL copied verbatim; empty if post:false`;

const NEWS_TAKE_PROMPT = `You write ONE LinkedIn post for ${AUTHOR.name} — ${AUTHOR.role}. Audience: AI engineers and builders.

The post reacts to a specific fresh development (given below with source material). Write like a practitioner who just dug into it, not a news bot.

Rules (hard):
- 1300–2200 characters total. Long enough to dwell on (61s+), short enough to read on a phone.
- First two lines MUST carry a concrete technical claim or number ("see more" cutoff lands there). No "Exciting news!", no hype, no "revolutionary", "game-changer", "unlock", "leverage".
- Middle: how it actually works — the mechanism, a tradeoff, or the part most people miss. Cite ONE specific fact from the sources (a number, a name, a benchmark).
- Optional: a 3–8 line fenced code block ONLY if a short snippet genuinely teaches the mechanism. Real, minimal, correct.
- Last line: a specific question that invites technical replies (not "Thoughts?").
- NO URLs, NO hashtags (the guard strips them anyway).
- Plain text only — no markdown headers. 0–1 emoji max.

Return ONLY the post text.`;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ");
}

function isReputable(c: Candidate): boolean {
  const hay = normalize(`${c.title} ${c.snippet}`);
  if (BLOCKLIST_TERMS.some((t) => hay.includes(t))) return false;
  try {
    const host = new URL(c.url).hostname.replace(/^www\./, "");
    if (BLOCKED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return false;
  } catch {
    return false;
  }
  return true;
}

function recencyHours(publishedDate?: string): number | null {
  if (!publishedDate) return null;
  const t = new Date(publishedDate).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

async function collectCandidates(): Promise<Candidate[]> {
  const [newsRows, paperRows] = await Promise.all([
    withTimeout(
      searchCandidates("new AI LLM model release agent framework tool launch benchmark", {
        searchDepth: "basic",
        topic: "news",
        days: 2,
        maxResults: 10,
      } as Parameters<typeof searchCandidates>[1]),
      25_000,
    ).catch(() => []),
    withTimeout(
      searchCandidates("new machine learning research paper method results preprint", {
        searchDepth: "basic",
        topic: "general",
        timeRange: "week",
        maxResults: 6,
        includeDomains: ["arxiv.org", "huggingface.co", "blog.google", "openai.com", "ai.meta.com", "www.anthropic.com", "deepmind.google"],
      } as Parameters<typeof searchCandidates>[1]),
      25_000,
    ).catch(() => []),
  ]);

  const byUrl = new Map<string, Candidate>();
  for (const r of [...newsRows, ...paperRows]) {
    if (!r.url || byUrl.has(r.url)) continue;
    byUrl.set(r.url, {
      title: r.title || r.url,
      url: r.url,
      snippet: (r.content || "").replace(/\s+/g, " ").trim().slice(0, 220),
      publishedDate: (r as { publishedDate?: string }).publishedDate,
      score: typeof r.score === "number" ? r.score : 0,
    });
  }
  return Array.from(byUrl.values())
    .filter(isReputable)
    .filter((c) => {
      const h = recencyHours(c.publishedDate);
      return h === null || h <= 72;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

/** 15–180 minute human-jitter delay, clamped so the post lands inside the
 * waking window; news detected after-hours targets 07:00–09:30 tomorrow. */
export function randomPostDelayMin(tz = "America/New_York"): number {
  const jitter = 15 + Math.floor(Math.random() * 166);
  const hour = hourInTimezone(tz);
  if (hour >= NEWS_WINDOW_START && hour + jitter / 60 < NEWS_WINDOW_END) return jitter;
  const hoursToMorning = hour >= NEWS_WINDOW_START ? 24 - hour + NEWS_WINDOW_START : NEWS_WINDOW_START - hour;
  return Math.round(hoursToMorning * 60) + Math.floor(Math.random() * 150);
}

/** Renders a validated diagram SVG onto the paper card as a 1200×1200 PNG. */
async function renderDiagramPng(svg: string): Promise<Buffer> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setViewport({ width: 1200, height: 1200, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;height:100%;background:#F4EEDE}
        body{display:flex;align-items:center;justify-content:center}
        svg{width:1120px;height:auto}
      </style></head><body>${svg}</body></html>`,
      { waitUntil: "load", timeout: 30_000 },
    );
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 200));
    const shot = await page.screenshot({ type: "png", omitBackground: false });
    return Buffer.from(shot);
  } finally {
    await browser.close();
  }
}

function extractJson(text: string): string {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first >= 0 && last > first ? text.slice(first, last + 1) : text;
}

async function generateDiagram(topic: string, angle: string): Promise<string | null> {
  const info = { id: "news-diagram", title: topic.slice(0, 120), concept: (angle || topic).slice(0, 400), layout: "landscape" as const };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await chat({
        stage: "news-diagram",
        system: DIAGRAM_SYSTEM_PROMPT + (attempt === 1 ? DIAGRAM_STRICTER_SUFFIX : ""),
        user: `TOPIC OF THE POST: ${topic}\nWHAT THE DIAGRAM MUST EXPLAIN: ${angle || topic}\nAUDIENCE: AI engineers\n\nDesign the diagram spec now. 3-7 nodes, left-to-right flow, direction "right", cols 0-3. Return ONLY the JSON object.`,
        json: DIAGRAM_JSON_SCHEMA as unknown as object,
        think: false,
        temperature: 0.4,
        maxTokens: 1200,
        timeoutMs: 45_000,
      });
      const spec = DiagramSpec.parse(JSON.parse(extractJson(r.text)));
      const svg = renderDiagram(spec, info);
      const v = validateSvg(svg);
      if (v.ok) return svg;
    } catch (e: unknown) {
      console.warn(`[news] diagram attempt ${attempt + 1} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  try {
    const svg = fallbackDiagram(info);
    return validateSvg(svg).ok ? svg : null;
  } catch {
    return null;
  }
}

async function selfCheckNewsPost(post: string, topic: string, sources: { title: string; excerpt: string }[]): Promise<{ ok: boolean; reason: string }> {
  const facts = sources.map((s, i) => `[${i + 1}] ${s.title}: ${s.excerpt.slice(0, 300)}`).join("\n");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await chat({
        stage: "news-selfcheck",
        system: SELFCHECK_SYSTEM_PROMPT,
        user: `POST TOPIC: ${topic}\n\nSUPPORTED FACTS (the post must not assert specifics beyond these):\n${facts}\n\n(This post may include an attached diagram image; a reference to "the diagram" is valid, not a missing link.)\n\nPOST TO CHECK:\n---\n${post}\n---\n\nReturn the JSON verdict now.`,
        json: "json",
        think: false,
        temperature: 0.2,
        maxTokens: 200,
        timeoutMs: 30_000,
      });
      const j = JSON.parse(extractJson(r.text)) as { ok?: boolean; reason?: string };
      return { ok: Boolean(j.ok), reason: typeof j.reason === "string" ? j.reason : "" };
    } catch {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return { ok: false, reason: "self-check could not run — blocking out of caution" };
}

export async function runNewsScan(opts?: { dryRun?: boolean; force?: boolean }): Promise<NewsScanSummary> {
  if (killSwitchOn()) return { status: "skipped", reason: "kill-switch" };
  if (!storageEnabled()) return { status: "skipped", reason: "storage-not-configured" };

  // M17: flush an approved news take whose randomized slot has arrived. The
  // decide route only sleeps ≤3 min inline; longer waits park here.
  await publishDueApprovedNewsRuns();

  const settings = await getAutomationSettings();
  if (!settings.enabled) return { status: "skipped", reason: "paused" };
  const dryRun = opts?.dryRun ?? settings.dry_run;

  const tz = settings.timezone;
  const localHour = hourInTimezone(tz);
  if (!opts?.force && (localHour < NEWS_WINDOW_START || localHour >= NEWS_WINDOW_END)) {
    return { status: "skipped", reason: `outside waking window (local hour ${localHour})` };
  }

  // Cadence caps — enforced from run rows, so restarts can't double-fire.
  const today = nyDateString(tz);
  if (await newsRunTodayExists(today)) return { status: "skipped", reason: "news slot already used today" };
  const weekly = await newsPostsInLastDays(7);
  if (weekly >= NEWS_MAX_PER_WEEK) return { status: "skipped", reason: `weekly cap reached (${weekly}/${NEWS_MAX_PER_WEEK})` };
  const fmt = parseDayFormats(settings.day_formats)[weekdayInTimezone(tz)];
  if (fmt === "off") return { status: "skipped", reason: "day-off in weekly plan" };

  let candidates: Candidate[];
  try {
    candidates = await collectCandidates();
  } catch (e: unknown) {
    return { status: "failed", reason: `tavily scan failed: ${e instanceof Error ? e.message : e}` };
  }
  if (candidates.length === 0) return { status: "no-news", reason: "no reputable fresh candidates" };

  const recent = await recentTopics(30);
  const fresh: Candidate[] = [];
  for (const c of candidates) {
    if (isNearDuplicate(c.title, recent)) continue;
    if (await isNewsUrlSeen(c.url)) continue;
    fresh.push(c);
  }
  if (fresh.length === 0) {
    await Promise.all(candidates.slice(0, 5).map((c) => markNewsUrlSeen(c.url, c.title).catch(() => {})));
    return { status: "no-news", reason: "all candidates stale or duplicate" };
  }

  const list = fresh
    .map((c, i) => `[${i + 1}] ${c.title}\n    ${c.url}\n    ${c.publishedDate ? `Published: ${c.publishedDate.slice(0, 10)}\n` : ""}    ${c.snippet}`)
    .join("\n\n");
  const pickRes = await chat({
    stage: "news-pick",
    system: NEWS_SCOUT_PROMPT,
    user: `CANDIDATES:\n${list}\n\nRECENT TOPICS (avoid near-duplicates):\n${recent.length ? recent.map((t: string) => `- ${t}`).join("\n") : "(none)"}\n\nDecide now. JSON only.`,
    json: "json",
    think: false,
    temperature: 0.5,
    maxTokens: 500,
    timeoutMs: 35_000,
  });
  let pick: z.infer<typeof NewsPickSchema>;
  try {
    pick = NewsPickSchema.parse(JSON.parse(extractJson(pickRes.text)));
  } catch {
    return { status: "failed", reason: "news picker returned unparseable JSON" };
  }
  if (!pick.post || pick.newsworthiness < NEWS_MIN_SCORE || !pick.topic) {
    await Promise.all(fresh.slice(0, 5).map((c) => markNewsUrlSeen(c.url, c.title).catch(() => {})));
    return { status: "no-news", reason: pick.reason || `below threshold (score ${pick.newsworthiness})` };
  }
  const chosen = fresh.find((c) => c.url === pick.url) ?? fresh[0];
  if (isNearDuplicate(pick.topic, recent)) {
    return { status: "no-news", reason: "llm pick was a near-duplicate" };
  }

  // Claim the run slot BEFORE generating — a concurrent scan must not double-post.
  const runId = await claimNewsRun(today);
  if (!runId) return { status: "skipped", reason: "news slot claimed concurrently" };
  await updateRun(runId, { status: "generating", topic: pick.topic, angle: pick.angle, post_format: "image" });

  try {
    const researchRes = await research({ topic: pick.topic, urls: [chosen.url] }).catch(() => null);
    const sources = researchRes?.sources.slice(0, 5) ?? [
      { title: chosen.title, url: chosen.url, excerpt: chosen.snippet, rawContent: chosen.snippet, score: 1, origin: "search" as const },
    ];

    const [takeRes, svg] = await Promise.all([
      chat({
        stage: "news-take",
        system: NEWS_TAKE_PROMPT,
        user: `TOPIC: ${pick.topic}\nANGLE: ${pick.angle}\n\nSOURCES:\n${sources.map((s, i: number) => `[${i + 1}] ${s.title}\n${s.url}\n${s.excerpt}`).join("\n\n")}\n\nWrite the post now.`,
        think: false,
        temperature: 0.7,
        maxTokens: 900,
        timeoutMs: 60_000,
      }),
      generateDiagram(pick.topic, pick.angle),
    ]);

    const guard = guardCaption(takeRes.text);
    if (!guard.ok) {
      const reason = `caption guard: ${guard.reasons.join("; ")}`;
      await updateRun(runId, { status: "blocked", error: reason });
      await sendAlert({ kind: "blocked", topic: pick.topic, reason });
      return { status: "blocked", runId, reason };
    }
    const verdict = await selfCheckNewsPost(guard.clean, pick.topic, sources);
    if (!verdict.ok) {
      const reason = `self-check blocked: ${verdict.reason}`;
      await updateRun(runId, { status: "blocked", error: reason });
      await sendAlert({ kind: "blocked", topic: pick.topic, reason });
      return { status: "blocked", runId, reason };
    }

    let imageUrl: string | null = null;
    if (svg) {
      const png = await renderDiagramPng(svg).catch((e: unknown) => {
        console.warn(`[news] png render failed: ${e instanceof Error ? e.message : e}`);
        return null;
      });
      if (png) {
        const blob = await uploadBlob(`news/${runId}/${slugify(pick.topic)}.png`, png, "image/png", { addRandomSuffix: true }).catch(() => null);
        imageUrl = blob?.url ?? null;
      }
    }
    const postFormat = imageUrl ? "image" : "text";

    const delayMin = randomPostDelayMin(tz);
    const notBefore = new Date(Date.now() + delayMin * 60_000).toISOString();

    if (dryRun) {
      await updateRun(runId, { status: "dry_run", caption: guard.clean, image_url: imageUrl, post_format: postFormat, scheduled_not_before: notBefore });
      await sendAlert({ kind: "dry_run", topic: pick.topic, pdfUrl: imageUrl });
      return { status: "dry_run", runId };
    }

    const minted = await mintApprovalToken(runId, NEWS_APPROVAL_TTL_HOURS);
    await updateRun(runId, {
      status: "awaiting_approval",
      caption: guard.clean,
      image_url: imageUrl,
      post_format: postFormat,
      scheduled_not_before: notBefore,
      approval_token_hash: minted.tokenHash,
      approval_expires_at: minted.expiresAt,
    });
    await markNewsUrlSeen(chosen.url, chosen.title);

    const landsAt = new Date(Date.parse(notBefore)).toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
    await sendAlert({
      kind: "awaiting_approval",
      topic: pick.topic,
      approveUrl: `${appBaseUrl()}/approve?token=${encodeURIComponent(minted.token)}`,
      pdfUrl: imageUrl,
      expiresAt: minted.expiresAt,
      note: `Fresh story (score ${pick.newsworthiness}/10): ${chosen.title}\nSource: ${chosen.url}\nHuman jitter: ${delayMin} min — posts no earlier than ${landsAt} local. Approve before then and it queues for that slot; approve after and it posts shortly after.`,
    });
    return { status: "awaiting_approval", runId };
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    await updateRun(runId, { status: "failed", error: `news: ${reason.slice(0, 350)}` }).catch(() => {});
    await sendAlert({ kind: "failed", topic: pick.topic, stage: "news-run", error: reason.slice(0, 350) });
    return { status: "failed", runId, reason };
  }
}
