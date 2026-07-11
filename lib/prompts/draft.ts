import type { InfographicT, SectionT } from "@/lib/plan-schema";
import type { ResearchSource } from "@/lib/tavily";
import { AUTHOR } from "@/lib/identity";

const DRAFT_VOICE_RULES = `Voice (non-negotiable):
- Clear, direct, friendly-technical. NO hype: never "revolutionary", "game-changer", "unlock", "leverage", "dive in", "rocket".
- Plain English first: every jargon term gets a one-line plain-English unpack in parentheses on first use.
- Concrete examples beat abstractions. Numbers beat adjectives.
- EVERY section must carry at least one specific fact from the sources — a number, a named system, a date, a benchmark. If the reader can't point at one thing they learned, the section failed.
- Find "the part most people miss": one non-obvious mechanism, tradeoff, or consequence per section. That's the editorial value.
- Lead with the most interesting sentence. No throat-clearing ("In this section we will explore…").
- Write like Wired magazine, not like a textbook.`;

const HTML_RULES = `HTML rules (strict):
- Output ONLY HTML body fragments. No <html>, <head>, <body>, <doctype>, no markdown fences, no commentary before or after.
- Use only these tags: <p>, <ol>, <ul>, <li>, <blockquote>, <strong>, <em>, <code>, <pre>, <span class="amber">, <span class="kicker">, plus the two blocks below.
- Your FIRST element must be <p class="lede"> — one sentence, 18-28 words, carrying the single most interesting claim of the section. (Exception: definition and recap kinds.)
- Use <span class="amber"> sparingly: highlight 2-3 key terms across the whole section in warm amber.
- Use <span class="kicker"> for tiny inline labels (e.g., "Why this matters:", "Example:").
- For pull quotes use <blockquote>.
- CALLOUT (optional, at most ONE per section) — a boxed aside for the single most useful non-obvious insight:
  <aside class="callout"><span class="kicker">The part most people miss</span> One or two sentences.</aside>
  Vary the kicker text ("Worth knowing", "The catch", "Rule of thumb", …).
- STAT ROW (optional, only when the sources give you REAL numbers — never invent or round beyond the source):
  <div class="stats"><div class="stat"><strong>3.2×</strong><span>what this number measures</span></div></div>
  2 or 3 <div class="stat"> blocks; <strong> holds the number (keep it under 8 characters, e.g. "97%", "15 ms", "$4B"); <span> is a 4-10 word label.
- Do NOT include the section title — the template renders that separately.
- No inline styles. No <script>. No <img>. No <svg> (diagrams are inserted separately).
- No backticks for code; use <code>.`;

const KIND_INSTRUCTIONS: Record<SectionT["kind"], string> = {
  cover: "(handled by template; you should not be called for this kind)",
  toc: "(handled by template; you should not be called for this kind)",
  colophon: "(handled by template; you should not be called for this kind)",
  definition:
    "Produce exactly ONE <p> containing a single declarative sentence, under 60 words, that defines the concept in plain English. No qualifiers like 'in essence' or 'simply put'.",
  problem:
    "Write 2-3 short paragraphs framing what's broken or unsolved. Include exactly ONE <blockquote> pull quote (one line, punchy, set off from the body).",
  body:
    "Write 3-4 short paragraphs explaining the mechanism (≤ 220 words total — the page is fixed-height A4 and shares space with a diagram). If a related infographic is given, refer to it by position: a landscape diagram sits ABOVE your text ('The diagram above…'), a portrait diagram sits BESIDE it ('The diagram alongside…'). Never describe the diagram's contents in words.",
  comparison:
    "Write 2-3 paragraphs building an analogy or concrete comparison. Open with the analogy, then explain why it holds and where it breaks. You MAY end with a comparison panel: <table class=\"vs\"><tr><th>A</th><th>B</th></tr>…</table>, 3-5 rows, every cell under 12 words.",
  "step-by-step":
    "Write a brief intro <p>, then an <ol> with 3-7 <li> items. Each <li> should open with a <strong>step label</strong> followed by the explanation. No code blocks unless the topic truly requires one.",
  "use-cases":
    "Write a one-sentence intro <p>, then 2-3 scenarios. Each scenario is its own <p> starting with '<strong>1. Scenario name —</strong>' (use numbers 1/2/3). Where the topic allows, ground at least one scenario in a BUSINESS workflow (document review, request intake, reporting, data quality, operations) — what manual step it automates and what the human still checks.",
  "why-it-matters":
    "Write 1-2 paragraphs zooming out to macro context. Why does this matter beyond the immediate use case? Avoid sweeping claims; ground each statement in something concrete.",
  recap:
    "Write an <ul> with 4-6 <li> takeaways. Each <li> is a short, declarative statement. No preamble before the list.",
};

export const DRAFT_SYSTEM_PROMPT = `You are a staff writer for Field Guide magazine, writing under ${AUTHOR.name}'s byline. You write ONE section of an illustrated PDF guide at a time.

${DRAFT_VOICE_RULES}

${HTML_RULES}

The user message will tell you which section-kind you're writing and give you the brief, related infographic (if any), and source material. Follow the kind-specific instructions below for THIS section's kind. Use the sources to inform what's true — never invent facts. If the sources don't cover something, leave it out rather than guess.

Output ONLY the HTML fragment. Nothing before. Nothing after.`;

export type DraftableSection = Exclude<SectionT["kind"], "cover" | "toc" | "colophon">;
export const DRAFTABLE_KINDS: ReadonlySet<SectionT["kind"]> = new Set([
  "definition",
  "problem",
  "body",
  "comparison",
  "step-by-step",
  "use-cases",
  "why-it-matters",
  "recap",
]);

export function isDraftable(kind: SectionT["kind"]): kind is DraftableSection {
  return DRAFTABLE_KINDS.has(kind);
}

export function buildDraftUserPrompt(input: {
  topic: string;
  audience: string;
  section: SectionT;
  infographic?: InfographicT;
  sources: ResearchSource[];
}): string {
  const { topic, audience, section, infographic, sources } = input;
  const lines: string[] = [];
  lines.push(`TOPIC: ${topic}`);
  lines.push(`AUDIENCE: ${audience}`);
  lines.push("");
  lines.push(`SECTION: ${section.title}`);
  lines.push(`KIND: ${section.kind}`);
  lines.push(`BRIEF: ${section.brief}`);
  if (infographic) {
    lines.push("");
    lines.push(`RELATED INFOGRAPHIC: ${infographic.title}`);
    lines.push(`  Concept: ${infographic.concept}`);
    lines.push(`  Layout: ${infographic.layout}`);
  }
  lines.push("");
  lines.push("KIND-SPECIFIC INSTRUCTIONS:");
  lines.push(KIND_INSTRUCTIONS[section.kind]);
  lines.push("");
  lines.push(`SOURCES (use facts from these — never invent):`);
  sources.forEach((s, i) => {
    lines.push("");
    lines.push(`[${i + 1}] ${s.title}`);
    lines.push(`    ${s.url}`);
    lines.push(`    ${s.excerpt}`);
  });
  lines.push("");
  lines.push("Write the HTML body for this section now. Output ONLY the HTML fragment.");
  return lines.join("\n");
}
