import { promises as fs } from "node:fs";
import path from "node:path";
import type { PlanT, SectionT } from "@/lib/plan-schema";
import type { ResearchSource } from "@/lib/tavily";
import type { InfographicT } from "@/lib/plan-schema";
import { fallbackDiagram } from "@/lib/diagram-renderer";
import { AUTHOR } from "@/lib/identity";

export type DraftMap = Record<string, { html: string; error?: string }>;
export type SvgMap = Record<string, string>;

type TemplateInput = {
  plan: PlanT;
  drafts: DraftMap;
  sources: ResearchSource[];
  /** Issue number / id, defaults to FG-001 */
  issue?: string;
  /** Optional SVGs for each infographic id; placeholder rendered when missing. */
  svgs?: SvgMap;
  /** Optional validated theme CSS (token overrides), layered over the base CSS. */
  themeCss?: string;
};

let _cssCache: string | null = null;
async function loadCss(): Promise<string> {
  if (_cssCache) return _cssCache;
  const cssPath = path.join(process.cwd(), "templates", "field-guide.css");
  _cssCache = await fs.readFile(cssPath, "utf8");
  return _cssCache;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clamp(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}

function chrome(opts: { kicker: string; pageNo: number; total: number }): string {
  return `<div class="chrome-top">
    <span class="kicker">${esc(opts.kicker)}</span>
    <span class="page-no">${opts.pageNo} / ${opts.total}</span>
  </div>`;
}

function chromeBot(opts: { left: string; right: string }): string {
  return `<div class="chrome-bot">
    <span>${esc(opts.left)}</span>
    <span>${esc(opts.right)}</span>
  </div>`;
}

function pageHostList(sources: ResearchSource[]): string {
  return sources
    .map((s) => {
      let host = s.url;
      try { host = new URL(s.url).host.replace(/^www\./, ""); } catch { /* keep raw */ }
      return `<li><strong>${esc(s.title)}</strong><br/>${esc(host)} — ${esc(s.url)}</li>`;
    })
    .join("\n");
}

function infographicSlot(info: InfographicT | undefined, svg: string | undefined, figNo: number): string {
  if (!info) return "";
  // Never ship a dashed placeholder — if the diagram is missing (failed or
  // skipped upstream), typeset the deterministic "field note" card instead.
  const content = svg && svg.trim() ? svg : fallbackDiagram(info);
  return `<div class="infographic-slot has-svg" data-id="${esc(info.id)}"><figure class="fig">
    <div class="fig-tag">Fig. ${String(figNo).padStart(2, "0")}</div>
    ${content}
    <figcaption>${esc(info.title)}</figcaption>
  </figure></div>`;
}

function findInfographic(plan: PlanT, id: string | null | undefined): InfographicT | undefined {
  if (!id) return undefined;
  return plan.infographics.find((i) => i.id === id);
}

type SectionCtx = {
  section: SectionT;
  pageNo: number;
  totalPages: number;
  plan: PlanT;
  drafts: DraftMap;
  sources: ResearchSource[];
  issue: string;
  svgs: SvgMap;
};

function sectionFooter(ctx: SectionCtx): string {
  const pct = Math.round((ctx.pageNo / Math.max(1, ctx.totalPages)) * 100);
  return `<div class="progress"><span style="width:${pct}%"></span></div>
  ${chromeBot({ left: `Field Guide ${ctx.issue}`, right: ctx.section.title })}`;
}

/** Tiny deterministic hash so the cover motif varies per issue but never at random. */
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Deterministic cover motif — generated geometry, no LLM involved. */
function coverMotif(seedText: string): string {
  const seed = hashStr(seedText);
  const kind = seed % 3;
  const parts: string[] = [];
  if (kind === 0) {
    // Concentric rings radiating from the corner.
    for (let i = 0; i < 5; i++) {
      parts.push(`<circle cx="170" cy="10" r="${26 + i * 24}" fill="none" stroke="#E8A317" stroke-opacity="${(0.38 - i * 0.06).toFixed(2)}" stroke-width="1.4"/>`);
    }
    parts.push(`<circle cx="170" cy="10" r="7" fill="#E8A317" fill-opacity="0.9"/>`);
  } else if (kind === 1) {
    // Dot matrix fading out.
    for (let r = 0; r < 5; r++) for (let c = 0; c < 7; c++) {
      const o = Math.max(0.08, 0.5 - (r + (6 - c)) * 0.045);
      parts.push(`<circle cx="${30 + c * 22}" cy="${16 + r * 22}" r="2.6" fill="#E8A317" fill-opacity="${o.toFixed(2)}"/>`);
    }
  } else {
    // Ascending bars.
    for (let i = 0; i < 6; i++) {
      const h = 16 + ((seed >> (i * 3)) % 5) * 18 + i * 10;
      parts.push(`<rect x="${24 + i * 26}" y="${120 - h}" width="12" height="${h}" fill="#E8A317" fill-opacity="${(0.18 + i * 0.1).toFixed(2)}"/>`);
    }
  }
  return `<svg class="cover-motif" viewBox="0 0 200 130" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${parts.join("")}</svg>`;
}

function issueDateLabel(): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "America/New_York" }).format(new Date());
}

function renderCover(ctx: SectionCtx): string {
  const { plan, issue } = ctx;
  return `<section class="page dark page-cover">
    ${coverMotif(plan.title)}
    <div>
      <p class="cover-kicker">Field Guide ${esc(issue)}</p>
      <p class="cover-issue">By ${esc(AUTHOR.name)} · ${esc(AUTHOR.brand)} · ${esc(issueDateLabel())}</p>
    </div>
    <h1 class="display title-l cover-title${plan.title.length > 48 ? " long" : ""}">${esc(plan.title)}</h1>
    ${plan.subtitle ? `<p class="cover-sub">${esc(plan.subtitle)}</p>` : ""}
    <div class="cover-byline">
      <span><strong>${esc(AUTHOR.name)}</strong> — ${esc(AUTHOR.role)}</span>
      <span>${plan.sections.length} pages · ${plan.infographics.length} diagrams</span>
      <span>Issue ${esc(issue)}</span>
    </div>
  </section>`;
}

function renderToc(ctx: SectionCtx): string {
  const { plan } = ctx;
  // Skip the cover and the TOC itself — a contents list that lists itself
  // reads as generated, not edited. Keep real page numbers from the full array.
  const entries = plan.sections
    .map((s, i) => ({ s, page: i + 1 }))
    .filter(({ s }) => s.kind !== "cover" && s.kind !== "toc");
  return `<section class="page cream page-toc">
    ${chrome({ kicker: "Contents", pageNo: ctx.pageNo, total: ctx.totalPages })}
    <p class="kicker-label toc-kicker">Inside this issue</p>
    <h2 class="display title-m toc-title">${plan.sections.length} pages, ${plan.infographics.length} diagrams.</h2>
    <ul class="toc-list">
      ${entries.map(({ s, page }, i) => `<li>
        <span class="toc-num">${String(i + 1).padStart(2, "0")}</span>
        <span class="toc-title-cell">${esc(s.title)}${s.kind !== "colophon" ? `<small>${esc(clamp(s.brief, 110))}</small>` : ""}</span>
        <span class="toc-kind">${esc(s.kind.replace(/-/g, " "))}</span>
        <span class="toc-leader"></span>
        <span class="toc-page">${page}</span>
      </li>`).join("\n")}
    </ul>
    ${sectionFooter(ctx)}
  </section>`;
}

function renderDefinition(ctx: SectionCtx): string {
  const draft = ctx.drafts[ctx.section.id];
  // For definition, drop the wrapping <p> if present — we use our own .def-text styling
  const inner = draft?.html?.replace(/^<p[^>]*>/i, "").replace(/<\/p>\s*$/i, "") || ctx.section.brief;
  return `<section class="page cream page-definition">
    ${chrome({ kicker: "Definition", pageNo: ctx.pageNo, total: ctx.totalPages })}
    <div>
      <p class="kicker-label def-kicker">What it is</p>
      <p class="def-text">${inner}</p>
    </div>
    ${sectionFooter(ctx)}
  </section>`;
}

function renderProblem(ctx: SectionCtx): string {
  const draft = ctx.drafts[ctx.section.id];
  return `<section class="page dark page-problem">
    ${chrome({ kicker: "The Problem", pageNo: ctx.pageNo, total: ctx.totalPages })}
    <p class="kicker-label problem-kicker">The problem</p>
    <h2 class="display title-m problem-title">${esc(ctx.section.title)}</h2>
    <div class="prose">${draft?.html || `<p>${esc(ctx.section.brief)}</p>`}</div>
    ${sectionFooter(ctx)}
  </section>`;
}

function renderBody(ctx: SectionCtx): string {
  const draft = ctx.drafts[ctx.section.id];
  const bg = ctx.section.background === "dark" ? "dark" : "cream";
  const info = findInfographic(ctx.plan, ctx.section.infographicId);
  const svg = info ? ctx.svgs[info.id] : undefined;
  const figNo = info ? ctx.plan.infographics.findIndex((i) => i.id === info.id) + 1 : 0;
  // Portrait diagrams go BESIDE the prose (grid), landscape ABOVE it — so a
  // tall diagram can never push the text off the fixed-height page.
  const layout = info ? `layout-${info.layout}` : "layout-none";
  return `<section class="page ${bg} page-body">
    ${chrome({ kicker: info ? "Mechanism + Diagram" : "Mechanism", pageNo: ctx.pageNo, total: ctx.totalPages })}
    <p class="kicker-label body-kicker">${info ? "How it works" : "Detail"}</p>
    <h2 class="display title-m body-title">${esc(ctx.section.title)}</h2>
    <div class="body-grid ${layout}">
      ${info ? infographicSlot(info, svg, figNo) : ""}
      <div class="prose">${draft?.html || `<p>${esc(ctx.section.brief)}</p>`}</div>
    </div>
    ${sectionFooter(ctx)}
  </section>`;
}

function renderComparison(ctx: SectionCtx): string {
  const draft = ctx.drafts[ctx.section.id];
  return `<section class="page cream page-comparison">
    ${chrome({ kicker: "Analogy", pageNo: ctx.pageNo, total: ctx.totalPages })}
    <p class="kicker-label comp-kicker">Make it concrete</p>
    <h2 class="display title-m comp-title">${esc(ctx.section.title)}</h2>
    <div class="prose">${draft?.html || `<p>${esc(ctx.section.brief)}</p>`}</div>
    ${sectionFooter(ctx)}
  </section>`;
}

function renderStep(ctx: SectionCtx): string {
  const draft = ctx.drafts[ctx.section.id];
  return `<section class="page cream page-step">
    ${chrome({ kicker: "Step-by-step", pageNo: ctx.pageNo, total: ctx.totalPages })}
    <p class="kicker-label step-kicker">How to do it</p>
    <h2 class="display title-m step-title">${esc(ctx.section.title)}</h2>
    <div class="prose">${draft?.html || `<p>${esc(ctx.section.brief)}</p>`}</div>
    ${sectionFooter(ctx)}
  </section>`;
}

function renderUseCases(ctx: SectionCtx): string {
  const draft = ctx.drafts[ctx.section.id];
  return `<section class="page cream page-usecases">
    ${chrome({ kicker: "In practice", pageNo: ctx.pageNo, total: ctx.totalPages })}
    <p class="kicker-label uc-kicker">Where it shows up</p>
    <h2 class="display title-m uc-title">${esc(ctx.section.title)}</h2>
    <div class="prose">${draft?.html || `<p>${esc(ctx.section.brief)}</p>`}</div>
    ${sectionFooter(ctx)}
  </section>`;
}

function renderWhy(ctx: SectionCtx): string {
  const draft = ctx.drafts[ctx.section.id];
  return `<section class="page dark page-why">
    ${chrome({ kicker: "Macro view", pageNo: ctx.pageNo, total: ctx.totalPages })}
    <p class="kicker-label why-kicker">Why it matters</p>
    <h2 class="display title-m why-title">${esc(ctx.section.title)}</h2>
    <div class="prose">${draft?.html || `<p>${esc(ctx.section.brief)}</p>`}</div>
    ${sectionFooter(ctx)}
  </section>`;
}

function renderRecap(ctx: SectionCtx): string {
  const draft = ctx.drafts[ctx.section.id];
  return `<section class="page cream page-recap">
    ${chrome({ kicker: "Recap", pageNo: ctx.pageNo, total: ctx.totalPages })}
    <p class="kicker-label recap-kicker">Take-aways</p>
    <h2 class="display title-m recap-title">${esc(ctx.section.title)}</h2>
    <div class="prose">${draft?.html || `<ul><li>${esc(ctx.section.brief)}</li></ul>`}</div>
    ${sectionFooter(ctx)}
  </section>`;
}

function renderColophon(ctx: SectionCtx): string {
  return `<section class="page dark page-colophon">
    ${chrome({ kicker: "Colophon", pageNo: ctx.pageNo, total: ctx.totalPages })}
    <p class="kicker-label col-kicker">About this guide</p>
    <h2 class="display title-m col-title">Built with sources, not vibes.</h2>
    <p class="author-bio">${esc(AUTHOR.bio)} Runs the channel <strong>${esc(AUTHOR.brand)}</strong>. This issue was generated with Field Guide Builder — research via Tavily, writing and diagrams via Gemma 4.</p>
    <p class="col-sources-title">Sources cited</p>
    <ol class="col-sources">${pageHostList(ctx.sources.slice(0, 10))}</ol>
    <div class="col-byline">
      <span>${esc(AUTHOR.name)} — Field Guide ${esc(ctx.issue)}</span>
      ${AUTHOR.youtube ? `<span>${esc(AUTHOR.youtube)}</span>` : ""}
    </div>
  </section>`;
}

const RENDERERS: Record<SectionT["kind"], (ctx: SectionCtx) => string> = {
  cover: renderCover,
  toc: renderToc,
  definition: renderDefinition,
  problem: renderProblem,
  body: renderBody,
  comparison: renderComparison,
  "step-by-step": renderStep,
  "use-cases": renderUseCases,
  "why-it-matters": renderWhy,
  recap: renderRecap,
  colophon: renderColophon,
};

export async function renderGuideHtml(input: TemplateInput): Promise<string> {
  const css = await loadCss();
  const issue = input.issue || "FG-001";
  const svgs = input.svgs || {};
  const totalPages = input.plan.sections.length;

  const pages = input.plan.sections.map((section, i) => {
    const ctx: SectionCtx = {
      section,
      pageNo: i + 1,
      totalPages,
      plan: input.plan,
      drafts: input.drafts,
      sources: input.sources,
      issue,
      svgs,
    };
    const renderer = RENDERERS[section.kind];
    return renderer(ctx);
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(input.plan.title)} — Field Guide</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<style>${css}</style>
${input.themeCss ? `<style>${input.themeCss}</style>` : ""}
</head>
<body>
${pages.join("\n")}
</body>
</html>`;
}
