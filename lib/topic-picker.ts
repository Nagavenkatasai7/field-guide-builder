/**
 * Daily auto-topic selection for the unattended LinkedIn poster.
 *
 * Scans Tavily for recent AI/ML developments, applies a deterministic
 * reputational/brand filter (so a trending scan never surfaces lawsuits,
 * layoffs, breaches, or politics under the user's name), lets Gemma pick ONE
 * fresh candidate, then backstops the LLM with a deterministic Jaccard dedupe
 * vs the recently-posted topics. Returns a shape that feeds straight into the
 * existing pipeline ({topic, summary:angle, urls}).
 */

import { z } from "zod";
import { chat } from "@/lib/llm";
import { searchCandidates } from "@/lib/tavily";
import { AUTHOR } from "@/lib/identity";

export type PickedTopic = { topic: string; angle: string; urls?: string[] };

type Candidate = { title: string; url: string; score: number; publishedDate?: string; snippet: string };

const TOPIC_TIMEOUT_MS = 35_000;

// Reputational guard: drop anything whose title/snippet trips these. We post
// "how-it-works" explainers, never drama. (Substring match on a normalized
// lowercase string.) Exported for the engagement cockpit (M13) — suggested
// comment targets go through the same filter as post topics.
export const BLOCKLIST_TERMS = [
  "lawsuit", "sued", "sue ", "settlement", "layoff", "laid off", "fired", "resign",
  "breach", "hacked", "hack ", "leak", "exploit", "vulnerability", "scandal",
  "controversy", "backlash", "boycott", "banned", "ban ", "lawsuit", "ftc", "doj",
  "antitrust", "election", "trump", "biden", "war", "israel", "gaza", "ukraine",
  "death", "dies", "killed", "shooting", "arrest", "fraud", "scam", "porn", "nsfw",
  "racist", "sexist", "nazi", "shutdown", "bankrupt", "crash ", "plunge", "lawsuit",
];
export const BLOCKED_DOMAINS = ["tmz.com", "dailymail.co.uk", "nypost.com", "reddit.com", "x.com", "twitter.com", "facebook.com"];

const PAPER_DOMAINS = ["arxiv.org", "huggingface.co", "blog.google", "openai.com", "ai.meta.com", "www.anthropic.com", "deepmind.google"];

// Established/evergreen concepts to reject as the WHOLE topic (a fresh development
// that merely mentions one of these is fine — the near-duplicate check matches on
// token overlap, so only an evergreen-concept-as-the-topic is rejected).
const EVERGREEN_TOPICS = [
  "model context protocol",
  "mcp",
  "retrieval augmented generation",
  "rag",
  "transformers explained",
  "what are ai agents",
  "ai agents",
  "prompt engineering",
  "fine tuning",
  "vector databases",
  "large language models explained",
  "what is an llm",
];

const PickedTopicSchema = z.object({
  topic: z.string().min(2).max(200),
  angle: z.string().min(1).max(1000),
  urls: z.array(z.string().url()).max(3).optional(),
});

const TOPIC_PICKER_SYSTEM_PROMPT = `You are the editorial scout for "${AUTHOR.brand}", the educational brand of ${AUTHOR.name} — ${AUTHOR.role}. The audience: ${AUTHOR.audience}. From a list of recent developments you pick exactly ONE to turn into an illustrated, educational field-guide that explains how something WORKS.

Selection criteria:
1. FRESH & CURRENTLY TRENDING — strongly prefer the most recently announced/released/discussed development (a new model, tool, framework, agent product, paper, or benchmark). Use the Published dates to favor the most recent items. Do NOT pick an established/evergreen concept that has been mainstream for many months — e.g. AVOID "Model Context Protocol (MCP)", "RAG / retrieval-augmented generation", "transformers", "what are AI agents", "prompt engineering", "fine-tuning", "vector databases". The reader wants to learn about what is NEW right now, not a 101 explainer of an old concept.
2. NICHE FIT — prefer developments that matter to people AUTOMATING BUSINESS PROCESSES with AI: agent/workflow platforms, LLM API capabilities (structured output, computer use, batch/cost features), document-intelligence and data-extraction tooling, analytics/BI + AI integrations, enterprise copilots, process-automation releases. A pure research paper qualifies only if its mechanism has an obvious workflow-automation implication. When two candidates are equally fresh, take the one a business systems analyst could apply at work this quarter.
3. NOT a near-duplicate of the recently-covered topics provided.
4. A strong fit for a "how it works" explainer — a concrete mechanism worth teaching. Avoid company drama, funding/lawsuit/politics news, and pure hot-takes.

Voice: clear and substantive, never hype. Never use words like "revolutionary", "game-changer", "unlock", "leverage", "dive in".

Output ONLY a JSON object (no markdown fences, no prose):
{
  "topic": string,   // <=200 chars, concrete and specific, NOT a full headline/sentence
  "angle": string,   // 1-3 sentences on the teaching hook: what the guide should make the reader understand
  "urls": string[]   // 1-3 reference URLs copied VERBATIM from the candidate list only (never invent)
}`;

function buildUserPrompt(candidates: Candidate[], recentTopics: string[], stricter: boolean): string {
  const lines: string[] = [];
  lines.push("CANDIDATE DEVELOPMENTS:");
  candidates.forEach((c, i) => {
    lines.push("");
    lines.push(`[${i + 1}] ${c.title}`);
    lines.push(`    ${c.url}`);
    if (c.publishedDate) lines.push(`    Published: ${c.publishedDate.slice(0, 10)}`);
    lines.push(`    ${c.snippet}`);
  });
  lines.push("");
  lines.push("RECENTLY COVERED TOPICS (avoid near-duplicates of these):");
  if (recentTopics.length === 0) lines.push("(none yet)");
  else recentTopics.forEach((t) => lines.push(`- ${t}`));
  lines.push("");
  if (stricter) {
    lines.push("Your previous pick was a near-duplicate or too long. Choose a DIFFERENT candidate and keep topic under 200 chars.");
  }
  lines.push("Pick exactly one candidate that meets all three criteria and return the JSON object.");
  return lines.join("\n");
}

function stripFences(s: string): string {
  return s.replace(/^[\s​]*```(?:json)?\s*\n?/i, "").replace(/\n?```[\s​]*$/i, "").trim();
}
function extractJson(text: string): string {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first >= 0 && last > first ? text.slice(first, last + 1) : text;
}

const STOPWORDS = new Set(["the", "a", "an", "of", "for", "to", "and", "with", "in", "on", "how", "what", "why", "is", "are", "your", "you", "it", "its", "by", "from", "using", "use"]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export function isNearDuplicate(topic: string, recentTopics: string[]): boolean {
  const t = tokenize(topic);
  if (t.size === 0) return false;
  for (const r of recentTopics) {
    const rt = tokenize(r);
    if (rt.size < 3) continue;
    if (jaccard(t, rt) >= 0.6) return true;
    const tn = [...t].join(" ");
    const rn = [...rt].join(" ");
    if ((tn.includes(rn) || rn.includes(tn)) && Math.min(t.size, rt.size) >= 3) return true;
  }
  return false;
}

function isReputable(c: Candidate): boolean {
  const hay = `${c.title} ${c.snippet}`.toLowerCase();
  if (BLOCKLIST_TERMS.some((term) => hay.includes(term))) return false;
  try {
    const host = new URL(c.url).host.replace(/^www\./, "");
    if (BLOCKED_DOMAINS.some((d) => host.endsWith(d))) return false;
  } catch {
    /* keep if URL unparseable */
  }
  return true;
}

function truncateTopic(s: string): string {
  if (s.length <= 200) return s;
  const cut = s.slice(0, 200);
  const sp = cut.lastIndexOf(" ");
  return sp > 120 ? cut.slice(0, sp) : cut;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tavily scan timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Max similarity of a topic vs everything we want to avoid (0 = totally fresh). */
function maxSimilarity(topic: string, avoid: string[]): number {
  const t = tokenize(topic);
  if (t.size === 0) return 1;
  let worst = 0;
  for (const r of avoid) {
    const rt = tokenize(r);
    if (rt.size < 3) continue;
    worst = Math.max(worst, jaccard(t, rt));
  }
  return worst;
}

export async function pickTrendingTopic(input: { recentTopics: string[] }): Promise<PickedTopic> {
  const recentTopics = input.recentTopics ?? [];

  // Two short, recency-biased scans (well under Tavily's 400-char query cap),
  // each with a hard timeout so a hung Tavily call can't eat the cron budget.
  const [newsRows, paperRows] = await Promise.all([
    withTimeout(searchCandidates("new AI agent workflow automation tool LLM API enterprise launch release", {
      searchDepth: "basic",
      topic: "news",
      days: 7,
      maxResults: 12,
    }), 30_000).catch(() => []),
    withTimeout(searchCandidates("new AI ML research paper method benchmark technique results", {
      searchDepth: "basic",
      topic: "general",
      timeRange: "month",
      maxResults: 8,
      includeDomains: PAPER_DOMAINS,
    }), 30_000).catch(() => []),
  ]);

  const byUrl = new Map<string, Candidate>();
  for (const r of [...newsRows, ...paperRows]) {
    if (!r.url || byUrl.has(r.url)) continue;
    const snippet = (r.content || "").replace(/\s+/g, " ").trim().slice(0, 200);
    byUrl.set(r.url, {
      title: r.title || r.url,
      url: r.url,
      score: typeof r.score === "number" ? r.score : 0,
      publishedDate: (r as { publishedDate?: string }).publishedDate,
      snippet,
    });
  }

  const candidates = Array.from(byUrl.values())
    .filter(isReputable)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  if (candidates.length === 0) {
    throw new Error("topic-picker: no reputable trending candidates found today");
  }
  const candidateUrls = new Set(candidates.map((c) => c.url));
  // Reject both recently-posted topics AND evergreen/established concepts.
  const avoid = [...recentTopics, ...EVERGREEN_TOPICS];

  const select = async (stricter: boolean): Promise<PickedTopic> => {
    const result = await chat({
      stage: "topic",
      system: TOPIC_PICKER_SYSTEM_PROMPT,
      user: buildUserPrompt(candidates, recentTopics, stricter),
      json: "json",
      think: false,
      temperature: 0.6,
      maxTokens: 600,
      timeoutMs: TOPIC_TIMEOUT_MS,
    });
    const parsed = PickedTopicSchema.parse(JSON.parse(extractJson(stripFences(result.text))));
    return {
      topic: truncateTopic(parsed.topic),
      angle: parsed.angle,
      urls: (parsed.urls ?? []).filter((u) => candidateUrls.has(u)).slice(0, 3),
    };
  };

  // Deterministic fallback: prefer a genuinely fresh candidate; if EVERY
  // candidate trips the dedupe (saturation), take the LEAST similar one
  // instead of throwing — a slightly-overlapping post beats a missed day.
  const deterministicPick = (): PickedTopic => {
    const fallback =
      candidates.find((c) => !isNearDuplicate(c.title, avoid)) ??
      [...candidates].sort((a, b) => maxSimilarity(a.title, avoid) - maxSimilarity(b.title, avoid))[0];
    console.warn(`[topic-picker] deterministic fallback picked "${fallback.title}"`);
    return {
      topic: truncateTopic(fallback.title),
      angle: fallback.snippet || `An educational explainer on ${fallback.title}.`,
      urls: [fallback.url],
    };
  };

  let picked: PickedTopic;
  try {
    picked = await select(false);
    if (isNearDuplicate(picked.topic, avoid)) picked = await select(true);
  } catch {
    // LLM failed/invalid JSON twice → deterministic pick.
    return deterministicPick();
  }

  if (isNearDuplicate(picked.topic, avoid)) {
    return deterministicPick();
  }

  console.log(`[topic-picker] picked "${picked.topic}" from ${candidates.length} candidates`);
  return picked;
}
