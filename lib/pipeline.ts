/**
 * Server-side generation pipeline.
 *
 * The generation logic used to live INLINE inside the SSE route handlers
 * (app/api/{plan,draft,svg,linkedin}/route.ts). It now lives here as pure,
 * reusable functions so BOTH the interactive SSE routes AND the unattended
 * daily-post cron can run it — with a single source of truth, no HTTP
 * self-calls, and no logic drift.
 *
 * The SSE routes keep their transport shell (Zod, heartbeat, controller, event
 * names) and pass onRetry/onSection/onSvg callbacks so per-item UI events stay
 * identical. The cron calls generateFieldGuide() which runs everything and
 * returns raw Buffers — it performs NO persistence or posting (the caller owns
 * Blob upload, the scheduled_runs log, the artifact gate, and LinkedIn).
 */

import { chat } from "@/lib/llm";
import { Plan, type PlanT, type SectionT, type InfographicT } from "@/lib/plan-schema";
import { research, type ResearchResult, type ResearchSource } from "@/lib/tavily";
import { renderGuideHtml, type DraftMap, type SvgMap } from "@/lib/templater";
import { renderPdfAndPageImages } from "@/lib/pdf-renderer";
import { buildZip, type ZipFile } from "@/lib/zip";
import { validateSvg } from "@/lib/svg-validator";
import { slugify } from "@/lib/storage";
import { PLAN_SYSTEM_PROMPT, buildPlanUserPrompt } from "@/lib/prompts/plan";
import { DRAFT_SYSTEM_PROMPT, buildDraftUserPrompt, isDraftable } from "@/lib/prompts/draft";
import { DIAGRAM_SYSTEM_PROMPT, DIAGRAM_STRICTER_SUFFIX, buildDiagramUserPrompt } from "@/lib/prompts/diagram";
import { DiagramSpec, DIAGRAM_JSON_SCHEMA } from "@/lib/diagram-schema";
import { renderDiagram, fallbackDiagram } from "@/lib/diagram-renderer";
import { LINKEDIN_SYSTEM_PROMPT, buildLinkedinUserPrompt, type CaptionFact } from "@/lib/prompts/linkedin";

// --- per-stage wall-clock caps (ms) ---
// Bound a single degraded Ollama Cloud round-trip so it can't consume the whole
// 300s serverless budget when the cron collapses every stage into one call.
// Generous enough that a healthy call never trips them.
const PLAN_TIMEOUT_MS = 120_000;
const DRAFT_TIMEOUT_MS = 70_000;
const SVG_TIMEOUT_MS = 90_000;
const LINKEDIN_TIMEOUT_MS = 60_000;

// --- text helpers (moved verbatim from the route files) ---

function stripFences(s: string, langs = ""): string {
  const open = new RegExp(`^[\\s\\u200b]*\`\`\`(?:${langs})?\\s*\\n?`, "i");
  const close = /\n?```[\s​]*$/i;
  return s.replace(open, "").replace(close, "").trim();
}

function extractJson(text: string): string {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return text;
}

const FORBIDDEN_TAGS = /<\/?(?:html|head|body|doctype|script|style|iframe|img|svg|link|meta|object|embed|form|input|button)\b[^>]*>/gi;
// Inline event handlers (onclick/ontoggle/onerror/…) and javascript: URLs can
// smuggle script past a tag-only filter — strip them attribute-level too.
const EVENT_ATTRS = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URLS = /\s(?:href|src|xlink:href)\s*=\s*(['"])\s*javascript:[^'"]*\1/gi;
/** Exported so /api/render can re-sanitize client-supplied fragments symmetrically. */
export function sanitizeFragment(html: string): string {
  return html.replace(FORBIDDEN_TAGS, "").replace(EVENT_ATTRS, "").replace(JS_URLS, "").trim();
}

function stripLabels(s: string): string {
  return s
    .replace(/^(?:caption|post|here(?:'s| is)\s+(?:the|your)?\s*(?:caption|post|linkedin\s+post))[:\-]\s*/i, "")
    .trim();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

async function withRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ===========================================================================
// Plan
// ===========================================================================

const PLAN_STRICTER_SUFFIX =
  "\n\nIMPORTANT: Your previous output failed validation. Return ONLY the raw JSON object. No markdown fences. No prose before or after. Every section must have id, kind, title, background, brief. Every infographic must have id, title, concept, layout. Total sections between 8 and 15. Exactly 2-4 infographics.";

export type StageMeta = { model: string; tokensIn: number; tokensOut: number; durationMs: number };

export async function generatePlan(
  input: { topic: string; summary: string; sources: ResearchSource[] },
  opts?: { onRetry?: () => void },
): Promise<{ plan: PlanT; meta: StageMeta }> {
  const run = async (stricter: boolean) => {
    const system = stricter ? `${PLAN_SYSTEM_PROMPT}${PLAN_STRICTER_SUFFIX}` : PLAN_SYSTEM_PROMPT;
    const result = await chat({
      stage: "plan",
      system,
      user: buildPlanUserPrompt(input),
      json: "json",
      think: "low",
      temperature: 0.7,
      maxTokens: 4000,
      timeoutMs: PLAN_TIMEOUT_MS,
    });
    const raw = extractJson(stripFences(result.text, "json"));
    const plan = Plan.parse(JSON.parse(raw));
    return {
      plan,
      meta: { model: result.model, tokensIn: result.promptTokens, tokensOut: result.completionTokens, durationMs: result.durationMs },
    };
  };
  try {
    return await run(false);
  } catch {
    opts?.onRetry?.();
    return await run(true);
  }
}

// ===========================================================================
// Drafts (per-section HTML, worker pool)
// ===========================================================================

async function draftOne(plan: PlanT, section: SectionT, sources: ResearchSource[]) {
  const infographic = section.infographicId ? plan.infographics.find((i) => i.id === section.infographicId) : undefined;
  const result = await chat({
    stage: `draft:${section.kind}`,
    system: DRAFT_SYSTEM_PROMPT,
    user: buildDraftUserPrompt({ topic: plan.title, audience: plan.audience, section, infographic, sources }),
    think: false,
    temperature: 0.65,
    maxTokens: 2000,
    timeoutMs: DRAFT_TIMEOUT_MS,
  });
  const html = sanitizeFragment(stripFences(result.text, "html"));
  if (!html) throw new Error("model returned empty content");
  return { html, tokensIn: result.promptTokens, tokensOut: result.completionTokens, durationMs: result.durationMs, model: result.model };
}

export type DraftEvent = {
  id: string;
  kind: SectionT["kind"];
  title: string;
  html: string;
  error?: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
};

export type DraftMeta = {
  completed: number;
  failed: number;
  totalTokensIn: number;
  totalTokensOut: number;
  durationMs: number;
  model: string;
  skipped: { id: string; kind: SectionT["kind"] }[];
};

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) break;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

export async function draftSections(
  plan: PlanT,
  sources: ResearchSource[],
  opts?: { concurrency?: number; onSection?: (ev: DraftEvent) => void },
): Promise<{ drafts: DraftMap; meta: DraftMeta }> {
  const draftable = plan.sections.filter((s) => isDraftable(s.kind));
  const skipped = plan.sections.filter((s) => !isDraftable(s.kind)).map((s) => ({ id: s.id, kind: s.kind }));
  const drafts: DraftMap = {};
  const started = Date.now();
  let completed = 0;
  let failed = 0;
  let totalIn = 0;
  let totalOut = 0;
  let model = "";

  await runPool(draftable, opts?.concurrency ?? 4, async (section) => {
    const start = Date.now();
    try {
      const d = await withRetry(() => draftOne(plan, section, sources), 1);
      drafts[section.id] = { html: d.html };
      completed++;
      totalIn += d.tokensIn;
      totalOut += d.tokensOut;
      model = d.model;
      opts?.onSection?.({ id: section.id, kind: section.kind, title: section.title, html: d.html, tokensIn: d.tokensIn, tokensOut: d.tokensOut, durationMs: d.durationMs });
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      drafts[section.id] = { html: "", error: message };
      opts?.onSection?.({ id: section.id, kind: section.kind, title: section.title, html: "", error: message, durationMs: Date.now() - start, tokensIn: 0, tokensOut: 0 });
    }
  });

  return { drafts, meta: { completed, failed, totalTokensIn: totalIn, totalTokensOut: totalOut, durationMs: Date.now() - started, model, skipped } };
}

// ===========================================================================
// SVGs (per-infographic, worker pool, successful-only map)
// ===========================================================================

async function generateSvg(plan: PlanT, info: InfographicT, stricter: boolean) {
  // The model designs a structured diagram SPEC (constrained-decoded JSON);
  // lib/diagram-renderer.ts does ALL geometry deterministically. The model
  // never emits SVG, so overlap/clipping/invalid-markup bugs can't occur.
  const system = stricter ? `${DIAGRAM_SYSTEM_PROMPT}${DIAGRAM_STRICTER_SUFFIX}` : DIAGRAM_SYSTEM_PROMPT;
  const result = await chat({
    stage: `diagram:${info.layout}`,
    system,
    user: buildDiagramUserPrompt({ plan, infographic: info }),
    json: DIAGRAM_JSON_SCHEMA,
    think: false,
    temperature: stricter ? 0.4 : 0.6,
    maxTokens: 2400, // truncation insurance — a cut-off spec fails JSON.parse and burns the attempt
    timeoutMs: SVG_TIMEOUT_MS,
  });
  const spec = DiagramSpec.parse(JSON.parse(extractJson(stripFences(result.text, "json"))));
  const svg = renderDiagram(spec, info);
  const validation = validateSvg(svg); // belt-and-braces on our own renderer output
  if (!validation.ok) throw new Error(`rendered diagram failed validation: ${validation.reason}`);
  return { svg: validation.svg, viewBox: validation.viewBox, tagCount: validation.tagCount, tokensIn: result.promptTokens, tokensOut: result.completionTokens, durationMs: result.durationMs, model: result.model };
}

async function withRetrySvg<T>(fn: (stricter: boolean) => Promise<T>): Promise<T> {
  try {
    return await fn(false);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return await fn(true);
  }
}

export type SvgEvent = {
  id: string;
  title: string;
  layout: InfographicT["layout"];
  svg: string;
  viewBox: string;
  tagCount: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  error?: string;
  /** True when spec generation failed and the deterministic fallback card shipped instead. */
  fallback?: boolean;
};

export type SvgMeta = {
  completed: number;
  failed: number;
  totalTokensIn: number;
  totalTokensOut: number;
  durationMs: number;
  model: string;
};

export async function generateSvgs(
  plan: PlanT,
  opts?: { concurrency?: number; onSvg?: (ev: SvgEvent) => void },
): Promise<{ svgs: SvgMap; meta: SvgMeta }> {
  const svgs: SvgMap = {};
  const started = Date.now();
  let completed = 0;
  let failed = 0;
  let totalIn = 0;
  let totalOut = 0;
  let model = "";

  await runPool(plan.infographics, opts?.concurrency ?? 2, async (info) => {
    const start = Date.now();
    try {
      const r = await withRetrySvg((stricter) => generateSvg(plan, info, stricter));
      svgs[info.id] = r.svg; // successful-only, so the templater placeholder still fires for failures
      completed++;
      totalIn += r.tokensIn;
      totalOut += r.tokensOut;
      model = r.model;
      opts?.onSvg?.({ id: info.id, title: info.title, layout: info.layout, svg: r.svg, viewBox: r.viewBox, tagCount: r.tagCount, tokensIn: r.tokensIn, tokensOut: r.tokensOut, durationMs: r.durationMs });
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      // Never ship a placeholder: degrade to the deterministic "field note"
      // card so the PDF page still looks designed when the model fails twice.
      const fb = fallbackDiagram(info);
      svgs[info.id] = fb;
      opts?.onSvg?.({ id: info.id, title: info.title, layout: info.layout, svg: fb, viewBox: info.layout === "landscape" ? "0 0 1000 600" : "0 0 700 900", tagCount: 0, tokensIn: 0, tokensOut: 0, durationMs: Date.now() - start, error: message, fallback: true });
    }
  });

  return { svgs, meta: { completed, failed, totalTokensIn: totalIn, totalTokensOut: totalOut, durationMs: Date.now() - started, model } };
}

// ===========================================================================
// LinkedIn caption
// ===========================================================================

export type CaptionMeta = { model: string; tokensIn: number; tokensOut: number; durationMs: number; chars: number };

export async function generateLinkedinCaption(plan: PlanT, angle?: string, sources?: CaptionFact[]): Promise<{ post: string; meta: CaptionMeta }> {
  // The caption is on the posting critical path — give it the same stage-level
  // retry the drafts/diagrams already get.
  const result = await withRetry(() => chat({
    stage: "linkedin",
    system: LINKEDIN_SYSTEM_PROMPT,
    user: buildLinkedinUserPrompt({ plan, angle, sources }),
    think: false,
    temperature: 0.75,
    maxTokens: 1200,
    timeoutMs: LINKEDIN_TIMEOUT_MS,
  }), 1);
  const post = stripLabels(stripFences(result.text, "text|markdown|md"));
  return { post, meta: { model: result.model, tokensIn: result.promptTokens, tokensOut: result.completionTokens, durationMs: result.durationMs, chars: post.length } };
}

// ===========================================================================
// Full orchestrator (used by the daily-post cron)
// ===========================================================================

export type FieldGuideResult = {
  research: ResearchResult;
  plan: PlanT;
  drafts: DraftMap;
  svgs: SvgMap;
  caption: string | null;
  pdf: Buffer;
  images: Buffer[];
  zip: Buffer;
  slug: string;
  draftMeta: DraftMeta;
  svgMeta: SvgMeta;
  timings: { researchMs: number; planMs: number; buildMs: number; renderMs: number; totalMs: number };
};

/**
 * Runs the whole pipeline once and returns raw artifacts. Performs NO Blob
 * upload, DB write, or LinkedIn post — the caller owns persistence, the
 * artifact gate, and posting. The draft||svg||caption block runs concurrently
 * via Promise.allSettled so a caption failure degrades to caption=null without
 * discarding a fully-rendered PDF (correct for the no-pre-review gate).
 */
export async function generateFieldGuide(input: {
  topic: string;
  summary?: string;
  urls?: string[];
  issue?: string;
  angle?: string;
  /**
   * Absolute epoch-ms deadline. The unattended cron passes start+~250s so a
   * degraded run fails FAST with a clean error (→ normal 'failed' + alert
   * path) instead of being killed silently at the 300s serverless cap, which
   * would leave a stuck row and send no email.
   */
  deadlineAt?: number;
}): Promise<FieldGuideResult> {
  const t0 = Date.now();
  const checkDeadline = (stage: string) => {
    if (input.deadlineAt && Date.now() > input.deadlineAt) {
      throw new Error(`time budget exhausted before ${stage} (deadline ${new Date(input.deadlineAt).toISOString()})`);
    }
  };

  // Research gets a hard timeout + one retry — Tavily has no internal cap.
  const researchResult = await withRetry(
    () => withTimeout(
      research({ topic: input.topic, urls: input.urls ?? [], summary: input.summary ?? "" }),
      45_000,
      "[research]",
    ),
    1,
  );
  if (researchResult.sources.length === 0) throw new Error("research returned no sources");
  const tResearch = Date.now();

  checkDeadline("plan");
  const { plan } = await generatePlan({ topic: input.topic, summary: input.summary ?? "", sources: researchResult.sources });
  const tPlan = Date.now();

  checkDeadline("build");
  const [draftSettled, svgSettled, captionSettled] = await Promise.allSettled([
    draftSections(plan, researchResult.sources),
    generateSvgs(plan),
    generateLinkedinCaption(plan, input.angle ?? input.summary, researchResult.sources),
  ]);

  const drafts = draftSettled.status === "fulfilled" ? draftSettled.value.drafts : {};
  const draftMeta: DraftMeta =
    draftSettled.status === "fulfilled"
      ? draftSettled.value.meta
      : { completed: 0, failed: plan.sections.length, totalTokensIn: 0, totalTokensOut: 0, durationMs: 0, model: "", skipped: [] };

  // Targeted repair pass: re-draft ONLY the failed sections (one extra shot
  // each, serially, budget permitting). One flaky section out of 12 was the
  // most common cause of a blocked day — this converts it into a posted day.
  const failedSections = plan.sections.filter((s) => isDraftable(s.kind) && (!drafts[s.id] || drafts[s.id].error || !drafts[s.id].html));
  for (const section of failedSections) {
    if (input.deadlineAt && Date.now() > input.deadlineAt - 30_000) break; // leave room for render
    try {
      const d = await draftOne(plan, section, researchResult.sources);
      drafts[section.id] = { html: d.html };
      draftMeta.completed++;
      draftMeta.failed = Math.max(0, draftMeta.failed - 1);
      console.log(`[pipeline] repair pass recovered section ${section.id}`);
    } catch (err) {
      console.warn(`[pipeline] repair pass could not recover ${section.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  const tBuild = Date.now();
  const svgs = svgSettled.status === "fulfilled" ? svgSettled.value.svgs : {};
  const svgMeta: SvgMeta =
    svgSettled.status === "fulfilled"
      ? svgSettled.value.meta
      : { completed: 0, failed: plan.infographics.length, totalTokensIn: 0, totalTokensOut: 0, durationMs: 0, model: "" };
  const caption = captionSettled.status === "fulfilled" ? captionSettled.value.post : null;

  const slug = slugify(plan.title);
  const html = await renderGuideHtml({ plan, drafts, sources: researchResult.sources, svgs, issue: input.issue });
  const { pdf, images } = await renderPdfAndPageImages(html);
  const tRender = Date.now();

  const zipFiles: ZipFile[] = [
    { name: `${slug}.pdf`, data: pdf },
    ...images.map((img, i) => ({ name: `images/page-${pad2(i + 1)}.png`, data: img })),
  ];
  if (caption && caption.trim()) zipFiles.push({ name: "linkedin-post.txt", data: Buffer.from(caption, "utf8") });
  const zip = await buildZip(zipFiles);

  return {
    research: researchResult,
    plan,
    drafts,
    svgs,
    caption,
    pdf,
    images,
    zip,
    slug,
    draftMeta,
    svgMeta,
    timings: {
      researchMs: tResearch - t0,
      planMs: tPlan - tResearch,
      buildMs: tBuild - tPlan,
      renderMs: tRender - tBuild,
      totalMs: Date.now() - t0,
    },
  };
}
