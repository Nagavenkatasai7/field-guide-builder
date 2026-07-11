import { z } from "zod";
import { Plan } from "@/lib/plan-schema";
import { sanitizeFragment } from "@/lib/pipeline";
import { validateSvg } from "@/lib/svg-validator";
import { renderGuideHtml, type DraftMap, type SvgMap } from "@/lib/templater";
import { DesignTheme, buildThemeCss } from "@/lib/design-variant";
import { renderPdfAndPageImages } from "@/lib/pdf-renderer";
import { buildZip } from "@/lib/zip";
import { newRunId, recordGeneration, slugify, storageEnabled, uploadBlob } from "@/lib/storage";

export const runtime = "nodejs";
// chromium-min cold start + 12-page screenshot loop can push past 60s on
// the first invocation. 300s gives generous headroom (Hobby+Fluid max).
export const maxDuration = 300;

const SourceShape = z.object({
  title: z.string(),
  url: z.string(),
  excerpt: z.string(),
  rawContent: z.string(),
  score: z.number(),
  publishedDate: z.string().optional(),
  origin: z.enum(["search", "user"]),
});

const DraftShape = z.object({
  html: z.string().max(60_000),
  error: z.string().optional(),
});

const Body = z.object({
  plan: Plan,
  drafts: z.record(z.string(), DraftShape),
  sources: z.array(SourceShape).min(1).max(20),
  svgs: z.record(z.string().max(64), z.string().max(200_000)).optional(),
  issue: z.string().max(32).optional(),
  /** Optional LinkedIn caption text — included as linkedin-post.txt in the zip. */
  linkedinPost: z.string().max(5000).optional(),
  /** Optional per-topic design variant (validated tokens, not raw CSS). */
  theme: DesignTheme.optional(),
});

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Bad request", details: parsed.error.flatten() }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { plan, drafts, sources, svgs, issue, linkedinPost, theme } = parsed.data;
  const started = Date.now();
  try {
    // Re-sanitize CLIENT-supplied fragments symmetrically with the pipeline
    // path — this route trusts the password cookie, not the payload.
    const cleanDrafts: DraftMap = {};
    for (const [id, d] of Object.entries(drafts)) {
      cleanDrafts[id] = { html: sanitizeFragment(d.html), error: d.error };
    }
    const cleanSvgs: SvgMap = {};
    for (const [id, s] of Object.entries(svgs || {})) {
      const v = validateSvg(s);
      if (v.ok) cleanSvgs[id] = v.svg; // invalid entries drop → templater falls back to the field-note card
    }
    const html = await renderGuideHtml({
      plan,
      drafts: cleanDrafts,
      sources,
      svgs: cleanSvgs,
      issue,
      themeCss: theme ? buildThemeCss(theme) : undefined,
    });
    const { pdf, images } = await renderPdfAndPageImages(html);

    const slug = slugify(plan.title);
    const zipFiles = [
      { name: `${slug}.pdf`, data: pdf },
      ...images.map((img, i) => ({ name: `images/page-${pad2(i + 1)}.png`, data: img })),
    ];
    if (linkedinPost && linkedinPost.trim()) {
      zipFiles.push({ name: "linkedin-post.txt", data: Buffer.from(linkedinPost, "utf8") });
    }
    const zip = await buildZip(zipFiles);

    const renderMs = Date.now() - started;
    console.log(
      `[render] ${plan.sections.length} pages, ${images.length} images, ` +
        `pdf ${pdf.length} bytes, zip ${zip.length} bytes, ${renderMs}ms`,
    );

    if (!storageEnabled()) {
      // Local-dev / no-storage path: return JSON with base64 payloads so
      // the client can build blob URLs and offer both downloads. Skipped
      // history persistence; surface this in the response.
      return new Response(
        JSON.stringify({
          mode: "inline",
          plan: { title: plan.title, pageCount: plan.sections.length },
          pdf: { bytes: pdf.length, base64: pdf.toString("base64") },
          zip: { bytes: zip.length, base64: zip.toString("base64") },
          renderMs,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Production path: upload both to Vercel Blob and record a history row.
    const id = newRunId();
    const pdfKey = `runs/${id}/${slug}.pdf`;
    const zipKey = `runs/${id}/${slug}.zip`;
    const [pdfBlob, zipBlob] = await Promise.all([
      uploadBlob(pdfKey, pdf, "application/pdf"),
      uploadBlob(zipKey, zip, "application/zip"),
    ]);
    try {
      await recordGeneration({
        id,
        title: plan.title,
        topic: plan.subtitle || plan.title,
        source_count: sources.length,
        page_count: plan.sections.length,
        pdf_url: pdfBlob.url,
        zip_url: zipBlob.url,
        pdf_bytes: pdf.length,
        zip_bytes: zip.length,
        linkedin_chars: linkedinPost ? linkedinPost.length : null,
      });
    } catch (dbErr) {
      // Don't fail the response if the DB insert breaks — the blobs are
      // already uploaded and the user has working URLs.
      console.error(`[render] db insert failed (blobs still uploaded): ${dbErr instanceof Error ? dbErr.message : dbErr}`);
    }

    return new Response(
      JSON.stringify({
        mode: "stored",
        id,
        plan: { title: plan.title, pageCount: plan.sections.length },
        pdf: { url: pdfBlob.url, bytes: pdf.length },
        zip: { url: zipBlob.url, bytes: zip.length },
        renderMs,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[render] failed: ${message}`);
    return new Response(JSON.stringify({ error: `PDF render failed: ${message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export type RenderResponse =
  | {
      mode: "inline";
      plan: { title: string; pageCount: number };
      pdf: { bytes: number; base64: string };
      zip: { bytes: number; base64: string };
      renderMs: number;
    }
  | {
      mode: "stored";
      id: string;
      plan: { title: string; pageCount: number };
      pdf: { url: string; bytes: number };
      zip: { url: string; bytes: number };
      renderMs: number;
    };
