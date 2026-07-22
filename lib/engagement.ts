/**
 * Engagement cockpit (M13): finds a handful of fresh niche posts/articles
 * worth a manual comment and drafts a substantive comment for each, plus a
 * reply-drafting helper for comments the owner receives.
 *
 * HARD BOUNDARY: this module only PREPARES text. It never touches the
 * LinkedIn API and there is deliberately no code path that submits a comment,
 * connection request, or DM — automating member actions violates LinkedIn's
 * ToS and gets accounts restricted. The owner reads, edits, and pastes.
 */

import { z } from "zod";
import { chat } from "@/lib/llm";
import { searchCandidates } from "@/lib/tavily";
import { AUTHOR } from "@/lib/identity";
import { BLOCKED_DOMAINS, BLOCKLIST_TERMS } from "@/lib/topic-picker";

export type EngagementTarget = {
  url: string;
  title: string;
  snippet: string | null;
  source: "linkedin" | "article";
  draft_comment: string;
};

const MAX_ITEMS = 8;
const MAX_LINKEDIN_ITEMS = 5;
const COMMENT_MAX_CHARS = 900;
const LLM_TIMEOUT_MS = 60_000;

type RawCandidate = { url: string; title: string; snippet: string | null; source: "linkedin" | "article" };

function normalized(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ");
}

function passesReputationFilter(c: RawCandidate): boolean {
  const text = normalized(`${c.title} ${c.snippet ?? ""}`);
  if (BLOCKLIST_TERMS.some((t) => text.includes(t))) return false;
  try {
    const host = new URL(c.url).hostname.replace(/^www\./, "");
    // linkedin.com is in no blocklist, but article results must not come from
    // the drama domains the topic-picker already refuses to touch.
    if (BLOCKED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return false;
  } catch {
    return false;
  }
  return true;
}

/** Only actual member content is worth commenting on — profiles, company
 * pages, and login walls are noise the search sometimes returns. */
function isLinkedinContentUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("linkedin.com")) return false;
    return u.pathname.startsWith("/posts/") || u.pathname.startsWith("/pulse/");
  } catch {
    return false;
  }
}

/** Comments must read as prose from a person: no links (spam tell), no
 * hashtags, and hard-capped length. Applied to every LLM draft. */
function cleanComment(raw: string): string {
  return raw
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/#\w+/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, COMMENT_MAX_CHARS);
}

const DraftsSchema = z.object({
  items: z.array(z.object({ url: z.string(), comment: z.string().min(40) })).min(1),
});

function extractJson(text: string): string {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first >= 0 && last > first ? text.slice(first, last + 1) : text;
}

const COMMENT_SYSTEM_PROMPT = `You draft LinkedIn comments for ${AUTHOR.name} — ${AUTHOR.role}. ${AUTHOR.name} will read, edit, and post each comment BY HAND, so write text worth their name.

Rules for every comment:
- 2-4 sentences, plain prose. No hashtags, no links, no emojis, no bullet lists.
- Reference ONE specific detail from the item's title/snippet, then ADD something: a concrete implication for people automating business workflows with AI, a sharp question, or a relevant trade-off. The comment must contain a thought the original author didn't state.
- Never open with generic praise ("Great post!", "Love this", "So true"). Never flatter. Disagreeing politely with a specific reason is welcome when the snippet supports it.
- Never invent facts, numbers, or personal anecdotes. If the snippet is too thin to say something specific, ask the most useful specific question instead.
- Voice: clear, direct, technically grounded, zero hype words (no "game-changer", "revolutionary", "unlock").

Output ONLY a JSON object (no markdown fences): {"items":[{"url": string (copied verbatim), "comment": string}, ...]} — one entry per input item, same urls.`;

/**
 * Two-angle Tavily sweep (LinkedIn member content + niche articles), the same
 * reputation filter the topic-picker uses, recent-URL dedupe, then ONE LLM
 * call drafting all comments. Throws on total failure — the route surfaces a
 * retryable error; there is no silent empty-success.
 */
export async function findEngagementTargets(recentUrls: string[]): Promise<EngagementTarget[]> {
  const [liResults, articleResults] = await Promise.all([
    searchCandidates("AI agents workflow automation enterprise LLM", {
      searchDepth: "basic",
      topic: "general",
      timeRange: "week",
      maxResults: 15,
      includeDomains: ["linkedin.com"],
    }).catch(() => []),
    searchCandidates("AI agent workflow automation enterprise launch analysis", {
      searchDepth: "basic",
      topic: "news",
      days: 5,
      maxResults: 10,
    }).catch(() => []),
  ]);

  const seen = new Set(recentUrls);
  const picked: RawCandidate[] = [];
  const push = (c: RawCandidate, cap: number, sourceCap?: number) => {
    if (picked.length >= cap) return;
    if (sourceCap != null && picked.filter((p) => p.source === c.source).length >= sourceCap) return;
    if (seen.has(c.url)) return;
    if (!c.title || !passesReputationFilter(c)) return;
    seen.add(c.url);
    picked.push(c);
  };

  for (const r of liResults) {
    if (isLinkedinContentUrl(r.url)) {
      push({ url: r.url, title: r.title, snippet: r.content?.slice(0, 500) ?? null, source: "linkedin" }, MAX_ITEMS, MAX_LINKEDIN_ITEMS);
    }
  }
  for (const r of articleResults) {
    push({ url: r.url, title: r.title, snippet: r.content?.slice(0, 500) ?? null, source: "article" }, MAX_ITEMS);
  }
  if (picked.length === 0) {
    throw new Error("no engagement candidates survived the filters — try again later (search results were thin)");
  }

  const userPrompt = picked
    .map((c, i) => `Item ${i + 1}\nURL: ${c.url}\nTitle: ${c.title}\nSnippet: ${c.snippet ?? "(none)"}`)
    .join("\n\n");
  const r = await chat({
    stage: "engagement",
    system: COMMENT_SYSTEM_PROMPT,
    user: userPrompt,
    json: "json",
    think: false,
    temperature: 0.7,
    maxTokens: 2200,
    timeoutMs: LLM_TIMEOUT_MS,
  });
  const parsed = DraftsSchema.safeParse(JSON.parse(extractJson(r.text)));
  if (!parsed.success) throw new Error("comment drafting returned an unusable shape — try again");

  const byUrl = new Map(parsed.data.items.map((i) => [i.url, i.comment]));
  const out: EngagementTarget[] = [];
  for (const c of picked) {
    const comment = cleanComment(byUrl.get(c.url) ?? "");
    if (comment.length < 40) continue; // a draft the LLM skipped/mangled — drop the row rather than ship filler
    out.push({ ...c, draft_comment: comment });
  }
  if (out.length === 0) throw new Error("comment drafting produced no usable drafts — try again");
  return out;
}

const REPLY_SYSTEM_PROMPT = `You draft replies to comments on ${AUTHOR.name}'s LinkedIn posts (${AUTHOR.name} is ${AUTHOR.role}). ${AUTHOR.name} edits and posts the reply BY HAND.

Rules:
- 1-3 sentences. Address the commenter's actual point first — agree, sharpen, or respectfully push back with a reason.
- If they asked a question, answer it as directly as the context allows; if the context is insufficient, say what you'd check rather than inventing an answer.
- No hashtags, links, or emojis. No "Thanks for reading!" filler — substance only.
- Voice: warm but direct, technically grounded, zero hype.

Output the reply text only — no JSON, no quotes, no preamble.`;

export async function draftReply(input: { theirComment: string; postTopic?: string }): Promise<string> {
  const r = await chat({
    stage: "engagement-reply",
    system: REPLY_SYSTEM_PROMPT,
    user: `${input.postTopic ? `The post was about: ${input.postTopic}\n\n` : ""}Comment received:\n"""${input.theirComment.slice(0, 1500)}"""`,
    think: false,
    temperature: 0.7,
    maxTokens: 400,
    timeoutMs: 45_000,
  });
  const reply = cleanComment(r.text);
  if (reply.length < 10) throw new Error("reply drafting produced no usable text — try again");
  return reply;
}
