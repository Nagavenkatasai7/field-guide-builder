import { tavily, type TavilyClient } from "@tavily/core";

let _client: TavilyClient | null = null;

function getClient(): TavilyClient {
  if (_client) return _client;
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not set");
  _client = tavily({ apiKey, clientName: "field-guide-builder" });
  return _client;
}

export type ResearchSource = {
  title: string;
  url: string;
  excerpt: string;
  rawContent: string;
  score: number;
  publishedDate?: string;
  origin: "search" | "user";
};

export type ResearchInput = {
  topic: string;
  urls: string[];
  summary?: string;
};

export type ResearchResult = {
  query: string;
  sources: ResearchSource[];
  responseTimeMs: number;
  credits?: number;
};

function toExcerpt(raw: string, fallback: string, maxChars = 320): string {
  const compact = (raw || fallback || "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  const cut = compact.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + "…";
}

export async function research(input: ResearchInput): Promise<ResearchResult> {
  const client = getClient();
  const start = Date.now();

  // Tavily caps the search query at 400 chars. The summary's job is to shape
  // the *generation* stages (plan/draft prompts) — not to bias search ranking
  // (and natural-language sentences hurt search recall anyway). Use only the
  // topic, defensively truncated.
  const query = input.topic.length > 380 ? input.topic.slice(0, 380) : input.topic;

  const searchPromise = client.search(query, {
    searchDepth: "advanced",
    includeRawContent: "markdown",
    maxResults: 10,
    topic: "general",
    includeAnswer: false,
    includeUsage: true,
  });

  const extractPromise =
    input.urls.length > 0
      ? client.extract(input.urls, {
          extractDepth: "advanced",
          format: "markdown",
          includeUsage: true,
        })
      : null;

  const [searchRes, extractRes] = await Promise.all([searchPromise, extractPromise]);

  const byUrl = new Map<string, ResearchSource>();

  if (extractRes) {
    for (const r of extractRes.results) {
      byUrl.set(r.url, {
        title: r.title || r.url,
        url: r.url,
        excerpt: toExcerpt(r.rawContent, r.url),
        rawContent: r.rawContent,
        score: 1,
        origin: "user",
      });
    }
  }

  for (const r of searchRes.results) {
    if (byUrl.has(r.url)) continue;
    byUrl.set(r.url, {
      title: r.title,
      url: r.url,
      excerpt: toExcerpt(r.content, r.title),
      rawContent: r.rawContent || r.content,
      score: r.score,
      publishedDate: r.publishedDate || undefined,
      origin: "search",
    });
  }

  const sources = Array.from(byUrl.values()).sort((a, b) => {
    if (a.origin === "user" && b.origin !== "user") return -1;
    if (a.origin !== "user" && b.origin === "user") return 1;
    return b.score - a.score;
  });

  const credits = (searchRes.usage?.credits ?? 0) + (extractRes?.usage?.credits ?? 0);

  return {
    query,
    sources,
    responseTimeMs: Date.now() - start,
    credits: credits > 0 ? credits : undefined,
  };
}

// Reuse the client's own option/result types so we never drift from @tavily/core.
type SearchOptions = NonNullable<Parameters<TavilyClient["search"]>[1]>;
type SearchResults = Awaited<ReturnType<TavilyClient["search"]>>["results"];

/**
 * Lightweight, recency-capable search that returns the raw result rows.
 * Used by the daily topic-picker to scan for trending AI/ML developments
 * without the heavyweight markdown extraction `research()` does. Reuses the
 * same singleton TavilyClient so we don't re-read the API key.
 */
export async function searchCandidates(query: string, options: SearchOptions): Promise<SearchResults> {
  const res = await getClient().search(query, options);
  return res.results;
}
