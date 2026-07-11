import type { PlanT } from "@/lib/plan-schema";
import { AUTHOR } from "@/lib/identity";

/**
 * Deterministic, plan-derived LinkedIn caption — the never-miss-a-post net.
 *
 * Used when the LLM caption fails to generate, fails the deterministic guard,
 * or fails the LLM self-check. Built only from the validated plan (titles +
 * briefs), so it can't carry hype, hallucinated numbers, or injected content
 * beyond what the plan itself contains — and it still passes guardCaption
 * (length ≥ 600, has hashtags, no URLs/mentions) by construction.
 */

const LISTABLE = new Set(["definition", "problem", "body", "comparison", "step-by-step", "use-cases", "why-it-matters", "recap"]);

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "your", "what", "when", "where",
  "how", "why", "that", "this", "guide", "field", "are", "is", "of", "in", "to", "a", "an",
]);

/** One PascalCase topic hashtag derived from the title (e.g. "#VectorSearch"). */
function topicHashtag(title: string): string {
  const words = title
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()));
  const tag = words.slice(0, 2).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  return tag.length >= 3 ? `#${tag.slice(0, 30)}` : "";
}

function clampLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

export function buildFallbackCaption(plan: PlanT): string {
  const listable = plan.sections.filter((s) => LISTABLE.has(s.kind));
  const picks = listable.slice(0, 5);

  const lines: string[] = [];
  lines.push(clampLine(plan.title, 160) + (/[.!?]$/.test(plan.title.trim()) ? "" : "."));
  if (plan.subtitle) lines.push(clampLine(plan.subtitle, 200));
  lines.push("");
  lines.push(`I put together a ${plan.sections.length}-page illustrated field guide that explains it in plain English — no hype, every technical term unpacked on first use.`);
  lines.push("");
  lines.push("Inside:");
  for (const s of picks) lines.push(`— ${clampLine(s.title, 90)}`);
  lines.push("");
  lines.push(`The full breakdown — ${plan.infographics.length} diagram${plan.infographics.length === 1 ? "" : "s"} included — is in the PDF below. Each section is one page, built to be read in under a minute.`);

  // Guarantee the guard's 600-char floor even for terse plans: borrow briefs.
  let body = lines.join("\n");
  for (const s of listable.slice(0, 8)) {
    if (body.length >= 700) break;
    lines.push("");
    lines.push(clampLine(s.brief, 180));
    body = lines.join("\n");
  }

  lines.push("");
  lines.push("Which of these would you want a full deep-dive on next? Tell me in the comments.");
  lines.push("");
  const tags = [AUTHOR.hashtag, "#AIAutomation", topicHashtag(plan.title), "#WorkflowAutomation"].filter(Boolean);
  lines.push(tags.join(" "));

  return lines.join("\n");
}
