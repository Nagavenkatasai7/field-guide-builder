/**
 * Repurposing engine (M14): turns a POSTED guide into derivatives for the
 * channels the owner actually controls — a blog post (markdown), an X/Twitter
 * thread, and a newsletter section. LinkedIn reach is rented; these compound.
 *
 * Generation is one LLM call from stored run fields (title/topic/angle/
 * caption + artifact URLs) — the run's drafts are not persisted, so the
 * caption is the source of truth for what the guide claims. The prompt
 * forbids adding facts beyond it.
 */

import { z } from "zod";
import { chat } from "@/lib/llm";
import { AUTHOR } from "@/lib/identity";
import type { RepurposeBundle, ScheduledRunRow } from "@/lib/storage";

const TWEET_MAX = 275;
const LLM_TIMEOUT_MS = 90_000;

const BundleSchema = z.object({
  blog_markdown: z.string().min(400),
  x_thread: z.array(z.string().min(10).max(TWEET_MAX + 25)).min(4).max(8),
  newsletter_markdown: z.string().min(80),
});

function extractJson(text: string): string {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first >= 0 && last > first ? text.slice(first, last + 1) : text;
}

/** UTM-tag a URL for owned-channel attribution. Blob/LinkedIn URLs ignore
 * unknown query params, so this is safe on both. */
export function withUtm(url: string, medium: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", "field-guide");
    u.searchParams.set("utm_medium", medium);
    return u.toString();
  } catch {
    return url;
  }
}

const REPURPOSE_SYSTEM_PROMPT = `You repurpose a published LinkedIn "field guide" (an illustrated PDF explainer) into three formats for ${AUTHOR.name} — ${AUTHOR.role}. Audience: ${AUTHOR.audience}.

HARD RULE — no new facts: everything you write must be derivable from the provided title/topic/angle/caption. You restructure and rephrase; you never add numbers, claims, or examples that aren't in the input. Where depth is missing, point the reader at the full guide instead of inventing detail.

1. blog_markdown — a 500-800 word blog post in clean markdown. Structure: a plain H1 title, a 2-3 sentence hook (no "In today's fast-paced world"), 2-4 H2 sections developing the caption's substance, a short takeaway section, then a final line linking to the full PDF guide as [Read the full field guide (PDF)](PDF_URL) and the LinkedIn discussion as [Join the discussion on LinkedIn](POST_URL). Keep those two placeholder tokens EXACTLY as PDF_URL and POST_URL.
2. x_thread — 4-8 tweets. Tweet 1 is a hook stating the concrete payoff of understanding this topic (no "🧵", no "A thread"). Each tweet ≤ ${TWEET_MAX} chars, self-contained, plain text, at most ONE hashtag across the whole thread. Final tweet points to the full guide with the literal token PDF_URL.
3. newsletter_markdown — an 80-150 word section for a weekly email: bold one-line lead, 2-3 sentences of substance, then "→ Full guide: PDF_URL".

Voice everywhere: clear, specific, zero hype ("game-changer", "unlock", "dive in" are banned).

Output ONLY a JSON object (no markdown fences): {"blog_markdown": string, "x_thread": string[], "newsletter_markdown": string}`;

/**
 * Builds the bundle for a posted run. URLs are substituted deterministically
 * AFTER generation (the LLM only ever sees placeholder tokens, so a
 * hallucinated link can't survive), with UTM tags per channel.
 */
export async function buildRepurposeBundle(run: ScheduledRunRow): Promise<RepurposeBundle> {
  if (!run.caption) throw new Error("run has no caption to repurpose");
  const user = [
    `Title: ${run.plan_title ?? run.topic ?? "Field guide"}`,
    `Topic: ${run.topic ?? "(none)"}`,
    run.angle ? `Angle: ${run.angle}` : null,
    `LinkedIn caption (the guide's substance):\n"""${run.caption}"""`,
  ].filter(Boolean).join("\n\n");

  const r = await chat({
    stage: "repurpose",
    system: REPURPOSE_SYSTEM_PROMPT,
    user,
    json: "json",
    think: false,
    temperature: 0.6,
    maxTokens: 3500,
    timeoutMs: LLM_TIMEOUT_MS,
  });
  const parsed = BundleSchema.safeParse(JSON.parse(extractJson(r.text)));
  if (!parsed.success) throw new Error("repurpose generation returned an unusable shape — try again");

  const pdfBlog = run.pdf_url ? withUtm(run.pdf_url, "blog") : "";
  const pdfThread = run.pdf_url ? withUtm(run.pdf_url, "x-thread") : "";
  const pdfNews = run.pdf_url ? withUtm(run.pdf_url, "newsletter") : "";
  const postUrl = run.linkedin_post_url ?? "";
  const sub = (s: string, pdf: string) => s.replaceAll("PDF_URL", pdf).replaceAll("POST_URL", postUrl);

  return {
    blog_markdown: sub(parsed.data.blog_markdown, pdfBlog),
    x_thread: parsed.data.x_thread.map((t) => sub(t, pdfThread).slice(0, TWEET_MAX + 100)),
    newsletter_markdown: sub(parsed.data.newsletter_markdown, pdfNews),
    generated_at: new Date().toISOString(),
  };
}
