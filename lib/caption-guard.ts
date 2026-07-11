/**
 * Deterministic, LLM-INDEPENDENT caption safety gate.
 *
 * Because daily posts publish with no human pre-review, this runs BEFORE (and
 * independent of) the LLM self-check. It defends against prompt-injection from
 * scraped source content by stripping any URLs and @mentions the model may
 * have absorbed, enforces hard length bounds in code (not just in the prompt),
 * and bans the rocket-emoji hype tell. The LLM self-check then judges tone,
 * truth, and brand fit on the cleaned text.
 */

export type CaptionGuardResult = { ok: boolean; clean: string; reasons: string[] };

// Hard bounds enforced in code. The brand-preferred 1600–2200 range is shaped
// by the prompt + the LLM self-check; these wider bounds catch only outright
// failures (truncated output / overflow past LinkedIn's ~3000-char limit).
const MIN_CHARS = 600;
// 2700 (not the ~3000 LinkedIn ceiling) leaves headroom for the backslashes
// escapeLittleText adds before posting, so an escaped caption can't overflow.
const MAX_CHARS = 2700;

/**
 * Strips injected links/mentions, normalizes whitespace, and reports hard
 * failures. Hashtags (#word) are preserved. Returns the cleaned caption that
 * should be stored/displayed and (after escapeLittleText) posted.
 */
export function guardCaption(raw: string): CaptionGuardResult {
  const reasons: string[] = [];

  // Remove any URLs — LinkedIn document posts shouldn't carry external links,
  // and a stripped link can't be an injected redirect.
  let clean = raw.replace(/\bhttps?:\/\/\S+/gi, "").replace(/\bwww\.\S+/gi, "");
  // Remove @mentions (we never want the model auto-tagging accounts). The @
  // must be at a word boundary so emails like a@b.com are untouched.
  clean = clean.replace(/(^|\s)@[A-Za-z0-9_.\-/]+/g, "$1");
  // LinkedIn renders raw text — markdown reaches the live post as literal
  // characters. Strip paired emphasis/backticks and normalize markdown bullets.
  clean = clean
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[ \t]*[-*][ \t]+/gm, "— ");
  // Tidy whitespace left by the removals.
  clean = clean
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const len = clean.length;
  if (len < MIN_CHARS) reasons.push(`caption too short (${len} chars) — likely a generation failure`);
  if (len > MAX_CHARS) reasons.push(`caption too long (${len} chars) — exceeds LinkedIn's commentary limit`);
  if (/🚀/.test(clean)) reasons.push("caption contains the rocket emoji (banned hype tell)");
  const tagCount = (clean.match(/#\w+/g) || []).length;
  if (tagCount === 0) reasons.push("caption has no hashtags");
  else if (tagCount > 8) reasons.push(`caption has ${tagCount} hashtags — reads as spam`);
  if (/\b(ignore (?:all )?previous instructions|as an ai language model|this (?:post|caption) is approved)\b/i.test(clean)) {
    reasons.push("caption contains injected-instruction text");
  }

  return { ok: reasons.length === 0, clean, reasons };
}

// LinkedIn /rest/posts commentary uses "little text": the parser treats a set
// of characters as reserved and a transient request can 422 if they're not
// backslash-escaped. We escape the structural set most likely to break the
// parser and appear in prose — parentheses/brackets/braces/angle, @, |, and
// backslash — and deliberately LEAVE '#' '*' '_' '~' unescaped so hashtags
// stay clickable. (Over-escaping renders the literal char; under-escaping can
// fail — this is the reliability/clickability balance. Tune after the first
// real post if a char slips through.)
const LITTLE_TEXT_RESERVED = /[\\|{}@()<>[\]]/g;

export function escapeLittleText(s: string): string {
  return s.replace(LITTLE_TEXT_RESERVED, (c) => `\\${c}`);
}

/**
 * Sanitize the document-card title before posting. The title is raw model
 * output (plan.title) and renders on the live post, so it bypasses the caption
 * guard otherwise — strip injected URLs/@mentions, flatten whitespace, and
 * clamp. NOT little-text-escaped (the media.title field is plain text).
 */
export function sanitizePostTitle(raw: string): string {
  const clean = raw
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/(^|\s)@[A-Za-z0-9_.\-/]+/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .trim();
  return clean || "Field Guide";
}
